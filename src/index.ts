import { StreamableHTTPTransport } from "@hono/mcp";
import { Hono } from "hono";
import { createMcpServer } from "./mcp.ts";
import { TokubaiClient } from "./tokubai.ts";

export function createApp(client = new TokubaiClient()) {
  const app = new Hono();
  app.get("/", (c) => c.json({ name: "tokubai-mcp", version: "1.0.0", endpoint: "/mcp" }));

  // Stateless HTTP: each request can run on a different Worker isolate.
  app.post("/mcp", async (c) => {
    const server = createMcpServer(client);
    const transport = new StreamableHTTPTransport({ enableJsonResponse: true });
    await server.connect(transport);
    try {
      return (await transport.handleRequest(c)) ?? c.body(null, 202);
    } finally {
      await server.close();
    }
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
