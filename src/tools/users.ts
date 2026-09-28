import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { BacklogClient } from "../backlog/client.js";
import { jsonResult, safeHandler } from "./helpers.js";

export function registerUserTools(server: McpServer, client: BacklogClient): void {
  server.registerTool(
    "backlog_get_users",
    {
      title: "Get project users",
      description:
        "Return users who belong to the configured Backlog project. Use these ids as assigneeId when creating issues.",
      inputSchema: {},
    },
    safeHandler(async () => {
      const users = await client.getProjectUsers();
      return jsonResult(
        users.map((u) => ({
          id: u.id,
          name: u.name,
          email: u.mailAddress ?? null,
        }))
      );
    })
  );
}
