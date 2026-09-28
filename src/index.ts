// Standalone entrypoint (Docker / npm start). On Vercel, api/index.ts exports
// the same app as a serverless function instead of listening on a port.
import { app, config } from "./app.js";

app.listen(config.port, () => {
  console.log(`Backlog MCP server listening on port ${config.port}`);
  console.log(`  MCP endpoint: POST /mcp`);
  console.log(`  Health check: GET /health`);
  console.log(`  Configured project: ${config.projectKey}`);
});
