import { Effect, Logger } from "effect";

type TokubaiErrorCode =
  | "INVALID_INPUT"
  | "INVALID_RESPONSE"
  | "NETWORK_ERROR"
  | "NOT_FOUND"
  | "PARSE_ERROR"
  | "RESPONSE_TOO_LARGE"
  | "TIMEOUT"
  | "TOO_MANY_REDIRECTS"
  | "UPSTREAM_ERROR";

export class TokubaiError extends Error {
  readonly code: TokubaiErrorCode;

  constructor(code: TokubaiErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "TokubaiError";
    this.code = code;
  }
}

export function tryTokubai<A>(operation: () => A): Effect.Effect<A, TokubaiError> {
  return Effect.sync(operation).pipe(
    Effect.catchDefect((error) =>
      error instanceof TokubaiError ? Effect.fail(error) : Effect.die(error),
    ),
  );
}

export const errorLogger = Logger.layer([Logger.withConsoleError(Logger.formatStructured)]);
