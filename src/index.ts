import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPTransport } from "@hono/mcp";
import { Hono } from "hono";

const app = new Hono();

// Your MCP server implementation
const mcpServer = new McpServer({
  name: "tokubai-mcp",
  version: "1.0.0",
});

// Initialize the transport
const transport = new StreamableHTTPTransport();

app.all("/mcp", async (c) => {
  if (!mcpServer.isConnected()) {
    // Connect the mcp with the transport
    await mcpServer.connect(transport);
  }

  return transport.handleRequest(c);
});

export default app;
