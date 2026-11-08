export const TOKUBAI_ORIGIN = "https://tokubai.co.jp";

export class TokubaiError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "TokubaiError";
    this.code = code;
  }
}

export function tokubaiUrl(value: string, base = TOKUBAI_ORIGIN): URL {
  let url: URL;
  try {
    url = new URL(value, base);
  } catch {
    throw new TokubaiError("INVALID_INPUT", "URL が不正です。");
  }
  if (url.origin !== TOKUBAI_ORIGIN || url.username || url.password || url.hash) {
    throw new TokubaiError("INVALID_INPUT", "https://tokubai.co.jp/ の URL を指定してください。");
  }
  return url;
}

// Limit both advertised and streamed size; some upstream responses omit Content-Length.
async function readHtml(response: Response, maxBytes: number): Promise<string> {
  if (Number(response.headers.get("content-length")) > maxBytes) {
    await response.body?.cancel();
    throw new TokubaiError(
      "RESPONSE_TOO_LARGE",
      "トクバイの HTML が取得サイズの上限を超えました。",
    );
  }
  if (!response.body) {
    throw new TokubaiError("INVALID_RESPONSE", "トクバイから空の応答が返されました。");
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let size = 0;
  let html = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        throw new TokubaiError(
          "RESPONSE_TOO_LARGE",
          "トクバイの HTML が取得サイズの上限を超えました。",
        );
      }
      html += decoder.decode(value, { stream: true });
    }
    return html + decoder.decode();
  } finally {
    reader.releaseLock();
  }
}

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

  async get(value: string | URL, signal?: AbortSignal): Promise<{ html: string; url: string }> {
    return this.request(value, signal, "text/html");
  }

  async getJson(
    value: string | URL,
    signal?: AbortSignal,
  ): Promise<{ data: unknown; url: string }> {
    const result = await this.request(value, signal, "application/json");
    try {
      return { data: JSON.parse(result.html), url: result.url };
    } catch {
      throw new TokubaiError("INVALID_RESPONSE", "地域候補の JSON を読み取れませんでした。");
    }
  }

  private async request(
    value: string | URL,
    signal: AbortSignal | undefined,
    accept: string,
  ): Promise<{ html: string; url: string }> {
    let url = tokubaiUrl(String(value));
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.options.timeoutMs ?? 15_000);
    const requestSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    try {
      for (let redirects = 0; redirects <= 5; redirects++) {
        const response = await (this.options.fetcher ?? fetch)(url.href, {
          headers: {
            Accept: accept,
            "Accept-Language": "ja",
            "User-Agent": "tokubai-mcp/1.0.0",
          },
          redirect: "manual",
          signal: requestSignal,
        });
        if ([301, 302, 303, 307, 308].includes(response.status)) {
          const location = response.headers.get("location");
          await response.body?.cancel();
          if (!location) throw new TokubaiError("INVALID_RESPONSE", "転送先 URL がありません。");
          // Check every hop before fetching, including protocol-relative redirects.
          url = tokubaiUrl(location, url.href);
          continue;
        }
        if (!response.ok) {
          await response.body?.cancel();
          throw new TokubaiError(
            response.status === 404 ? "NOT_FOUND" : "UPSTREAM_ERROR",
            `トクバイの取得に失敗しました (HTTP ${response.status})。`,
          );
        }
        if (!response.headers.get("content-type")?.toLowerCase().includes(accept)) {
          await response.body?.cancel();
          throw new TokubaiError(
            "INVALID_RESPONSE",
            `トクバイから ${accept} 以外の応答が返されました。`,
          );
        }
        return {
          html: await readHtml(response, this.options.maxBytes ?? 5 * 1024 * 1024),
          url: url.href,
        };
      }
      throw new TokubaiError(
        "TOO_MANY_REDIRECTS",
        "トクバイのリダイレクト回数が上限を超えました。",
      );
    } catch (error) {
      if (error instanceof TokubaiError) throw error;
      if (requestSignal.aborted) {
        throw new TokubaiError(
          "TIMEOUT",
          "トクバイの取得がタイムアウトまたはキャンセルされました。",
        );
      }
      throw new TokubaiError("NETWORK_ERROR", "トクバイに接続できませんでした。");
    } finally {
      clearTimeout(timeout);
    }
  }
}
