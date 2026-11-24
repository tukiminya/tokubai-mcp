import { Effect } from "effect";
import { TokubaiError, tryTokubai } from "./errors.ts";

export { TokubaiError } from "./errors.ts";

export const TOKUBAI_ORIGIN = "https://tokubai.co.jp";

export function tokubaiUrl(value: string, base = TOKUBAI_ORIGIN): URL {
  let url: URL;
  try {
    url = new URL(value, base);
  } catch (cause) {
    throw new TokubaiError("INVALID_INPUT", "URL が不正です。", { cause });
  }
  if (url.origin !== TOKUBAI_ORIGIN || url.username || url.password || url.hash) {
    throw new TokubaiError("INVALID_INPUT", "https://tokubai.co.jp/ の URL を指定してください。");
  }
  return url;
}

const networkError = (cause: unknown) =>
  new TokubaiError("NETWORK_ERROR", "トクバイに接続できませんでした。", { cause });

const responseTooLarge = () =>
  new TokubaiError("RESPONSE_TOO_LARGE", "トクバイの HTML が取得サイズの上限を超えました。");

function discardBody(body: { cancel(): Promise<void> } | null) {
  // Discarding a response is subject to the same timeout as reading it.
  return body
    ? Effect.interruptible(Effect.tryPromise({ try: () => body.cancel(), catch: networkError }))
    : Effect.void;
}

// Limit both advertised and streamed size; some upstream responses omit Content-Length.
function readBody(response: Response, maxBytes: number) {
  const body = response.body;
  if (Number(response.headers.get("content-length")) > maxBytes) {
    return Effect.fail(responseTooLarge()).pipe(Effect.onExit(() => discardBody(body)));
  }
  if (!body) {
    return Effect.fail(
      new TokubaiError("INVALID_RESPONSE", "トクバイから空の応答が返されました。"),
    );
  }
  return Effect.acquireUseRelease(
    Effect.try({ try: () => body.getReader(), catch: networkError }),
    (reader) =>
      Effect.gen(function* () {
        const decoder = new TextDecoder();
        let size = 0;
        let html = "";
        while (true) {
          const { done, value } = yield* Effect.tryPromise({
            try: () => reader.read(),
            catch: networkError,
          });
          if (done) return html + decoder.decode();
          size += value.byteLength;
          if (size > maxBytes) {
            return yield* Effect.fail(responseTooLarge()).pipe(
              Effect.onExit(() => discardBody(reader)),
            );
          }
          html += decoder.decode(value, { stream: true });
        }
      }),
    (reader) => Effect.sync(() => reader.releaseLock()),
  );
}

const timeoutError = (cause: unknown) =>
  new TokubaiError("TIMEOUT", "トクバイの取得がタイムアウトまたはキャンセルされました。", {
    cause,
  });

export class HtmlClient {
  private readonly options: {
    fetcher?: typeof fetch;
    timeoutMs?: number;
    maxBytes?: number;
  };

  constructor(
    options: {
      fetcher?: typeof fetch;
      timeoutMs?: number;
      maxBytes?: number;
    } = {},
  ) {
    this.options = options;
  }

  get(value: string | URL, signal?: AbortSignal): Promise<{ html: string; url: string }> {
    return Effect.runPromise(this.getEffect(value, signal));
  }

  getJson(value: string | URL, signal?: AbortSignal): Promise<{ data: unknown; url: string }> {
    return Effect.runPromise(this.getJsonEffect(value, signal));
  }

  getEffect(value: string | URL, signal?: AbortSignal) {
    return this.request(value, "text/html", signal);
  }

  getJsonEffect(value: string | URL, signal?: AbortSignal) {
    return this.request(value, "application/json", signal).pipe(
      Effect.flatMap(({ html, url }) =>
        Effect.try({
          try: (): { data: unknown; url: string } => ({ data: JSON.parse(html), url }),
          catch: (cause) =>
            new TokubaiError("INVALID_RESPONSE", "地域候補の JSON を読み取れませんでした。", {
              cause,
            }),
        }),
      ),
    );
  }

  private request(value: string | URL, accept: string, signal?: AbortSignal) {
    const timeoutMs = this.options.timeoutMs ?? 15_000;
    return Effect.gen({ self: this }, function* () {
      const url = yield* tryTokubai(() => tokubaiUrl(String(value)));
      if (signal?.aborted) return yield* Effect.fail(timeoutError(signal.reason));

      // One signal covers fetch, redirects and the response body.
      const controller = new AbortController();
      const request = this.followRedirects(url, accept, controller.signal).pipe(
        Effect.onInterrupt(() => Effect.sync(() => controller.abort())),
        Effect.timeoutOrElse({
          duration: timeoutMs,
          orElse: () =>
            Effect.fail(timeoutError(new Error(`Upstream request exceeded ${timeoutMs} ms`))),
        }),
      );
      if (!signal) return yield* request;

      const cancelled = Effect.callback<never, TokubaiError>((resume) => {
        const onAbort = () => resume(Effect.fail(timeoutError(signal.reason)));
        signal.addEventListener("abort", onAbort, { once: true });
        if (signal.aborted) onAbort();
        return Effect.sync(() => signal.removeEventListener("abort", onAbort));
      });
      return yield* Effect.raceFirst(cancelled, request);
    });
  }

  private followRedirects(initialUrl: URL, accept: string, signal: AbortSignal) {
    return Effect.gen({ self: this }, function* () {
      let url = initialUrl;
      for (let redirects = 0; redirects <= 5; redirects++) {
        const response = yield* Effect.tryPromise({
          try: () =>
            (this.options.fetcher ?? fetch)(url.href, {
              headers: {
                Accept: accept,
                "Accept-Language": "ja",
                "User-Agent": "tokubai-mcp/1.0.0",
              },
              redirect: "manual",
              signal,
            }),
          catch: networkError,
        });
        if ([301, 302, 303, 307, 308].includes(response.status)) {
          // Check every hop before fetching, including protocol-relative redirects.
          url = yield* tryTokubai(() => {
            const location = response.headers.get("location");
            if (!location) throw new TokubaiError("INVALID_RESPONSE", "転送先 URL がありません。");
            return tokubaiUrl(location, url.href);
          }).pipe(Effect.onExit(() => discardBody(response.body)));
          continue;
        }

        if (!response.ok) {
          const error = new TokubaiError(
            response.status === 404 ? "NOT_FOUND" : "UPSTREAM_ERROR",
            `トクバイの取得に失敗しました (HTTP ${response.status})。`,
          );
          return yield* Effect.fail(error).pipe(Effect.onExit(() => discardBody(response.body)));
        }
        if (!response.headers.get("content-type")?.toLowerCase().includes(accept)) {
          const error = new TokubaiError(
            "INVALID_RESPONSE",
            `トクバイから ${accept} 以外の応答が返されました。`,
          );
          return yield* Effect.fail(error).pipe(Effect.onExit(() => discardBody(response.body)));
        }

        const html = yield* readBody(response, this.options.maxBytes ?? 5 * 1024 * 1024);
        return { html, url: url.href };
      }
      return yield* Effect.fail(
        new TokubaiError("TOO_MANY_REDIRECTS", "トクバイのリダイレクト回数が上限を超えました。"),
      );
    });
  }
}
