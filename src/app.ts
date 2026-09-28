import { timingSafeEqual } from "node:crypto";
import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { loadConfig } from "./config.js";
import { BacklogClient } from "./backlog/client.js";
import { registerProjectTools } from "./tools/project.js";
import { registerUserTools } from "./tools/users.js";
import { registerMetadataTools } from "./tools/metadata.js";
import { registerIssueTools } from "./tools/issues.js";

export const config = loadConfig();
const client = new BacklogClient(config.baseUrl, config.apiKey, config.projectKey);

function createMcpServer(): McpServer {
  const server = new McpServer({
    name: "backlog-mcp",
    version: "1.0.0",
  });
  registerProjectTools(server, client);
  registerUserTools(server, client);
  registerMetadataTools(server, client);
  registerIssueTools(server, client, config.baseUrl);
  return server;
}

export const app = express();

// Parse JSON only when nobody already has: Vercel's Node helpers consume the
// request stream and expose the parsed body as req.body before Express runs.
const jsonParser = express.json({ limit: "4mb" });
app.use((req, res, next) => {
  if (req.body !== undefined) return next();
  jsonParser(req, res, next);
});

app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

function tokensMatch(candidate: string, expected: string): boolean {
  const a = Buffer.from(candidate);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

// When MCP_AUTH_TOKEN is set, every /mcp request must carry it, either as
// "Authorization: Bearer <token>" or in the path ("/mcp/<token>") for clients
// that cannot send custom headers (e.g. ChatGPT custom connectors).
const requireAuth: express.RequestHandler = (req, res, next) => {
  const expected = config.mcpAuthToken;
  if (!expected) return next();

  const header = req.headers.authorization;
  const bearer = header?.startsWith("Bearer ") ? header.slice("Bearer ".length) : undefined;
  const pathToken = typeof req.params.token === "string" ? req.params.token : undefined;
  if (
    (bearer !== undefined && tokensMatch(bearer, expected)) ||
    (pathToken !== undefined && tokensMatch(pathToken, expected))
  ) {
    return next();
  }

  res.status(401).json({
    jsonrpc: "2.0",
    error: { code: -32001, message: "Unauthorized: missing or invalid MCP auth token" },
    id: null,
  });
};

if (!config.mcpAuthToken) {
  console.warn(
    "MCP_AUTH_TOKEN is not set: /mcp accepts unauthenticated requests. " +
      "Set it before exposing this server on a public URL."
  );
}

const MCP_PATHS = ["/mcp", "/mcp/:token"];

// Stateless Streamable HTTP: a fresh server + transport per request, so no
// session state is kept and requests are fully independent. JSON responses
// (instead of SSE streams) keep this compatible with serverless platforms.
app.post(MCP_PATHS, requireAuth, async (req, res) => {
  const server = createMcpServer();
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  res.on("close", () => {
    void transport.close();
    void server.close();
  });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error("Error handling MCP request:", err instanceof Error ? err.message : err);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: { code: -32603, message: "Internal server error" },
        id: null,
      });
    }
  }
});

// Stateless mode has no server-initiated streams or sessions to manage.
const methodNotAllowed = (_req: express.Request, res: express.Response) => {
  res.status(405).json({
    jsonrpc: "2.0",
    error: { code: -32000, message: "Method not allowed in stateless mode" },
    id: null,
  });
};
app.get(MCP_PATHS, requireAuth, methodNotAllowed);
app.delete(MCP_PATHS, requireAuth, methodNotAllowed);

// Vercel's Express preset uses src/app.ts as the entrypoint and requires the
// app to be the module's default export. Docker/npm start use src/index.ts.
export default app;
