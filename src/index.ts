import { StreamableHTTPTransport } from "@hono/mcp";
import { Cause, Effect } from "effect";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { errorLogger } from "./errors.ts";
import { createMcpServer } from "./mcp.ts";
import { TokubaiClient } from "./tokubai.ts";

export function createApp(client = new TokubaiClient()) {
  const app = new Hono();
  app.get("/", (c) => c.json({ name: "tokubai-mcp", version: "1.0.0", endpoint: "/mcp" }));

  // Stateless HTTP: each request can run on a different Worker isolate.
  app.post("/mcp", (c) => {
    const request = Effect.acquireUseRelease(
      Effect.sync(() => {
        const server = createMcpServer(client);
        server.server.onerror = (error) => {
          Effect.runSync(
            Effect.logError("MCP protocol error", Cause.die(error)).pipe(
              Effect.annotateLogs({ route: "/mcp" }),
              Effect.provide(errorLogger),
            ),
          );
        };
        return server;
      }),
      (server) =>
        Effect.gen(function* () {
          const transport = new StreamableHTTPTransport({ enableJsonResponse: true });
          yield* Effect.promise(() => server.connect(transport));
          const response = yield* Effect.promise(() => transport.handleRequest(c));
          return response ?? c.body(null, 202);
        }),
      (server) =>
        Effect.promise(() => server.close()).pipe(
          Effect.catchCause((cause) => Effect.logError("MCP server close failed", cause)),
        ),
    );
    return Effect.runPromise(
      request.pipe(
        Effect.catchCause((cause) => {
          const error = Cause.squash(cause);
          if (error instanceof HTTPException) return Effect.succeed(error.getResponse());
          return Effect.logError("MCP request failed", cause).pipe(
            Effect.map(() =>
              c.json(
                {
                  jsonrpc: "2.0",
                  id: null,
                  error: { code: -32603, message: "Internal error" },
                },
                500,
              ),
            ),
          );
        }),
        Effect.annotateLogs({ route: "/mcp" }),
        Effect.provide(errorLogger),
      ),
    );
  });
  app.all("/mcp", (c) => {
    c.header("Allow", "POST");
    return c.json(
      {
        jsonrpc: "2.0",
        id: null,
        error: { code: -32000, message: "Method not allowed. Use stateless MCP POST requests." },
      },
      405,
    );
  });

  return app;
}

export default createApp();
