import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { BacklogClient } from "../backlog/client.js";
import { jsonResult, safeHandler } from "./helpers.js";

export function registerProjectTools(server: McpServer, client: BacklogClient): void {
  server.registerTool(
    "backlog_get_project",
    {
      title: "Get Backlog project",
      description:
        "Return information about the configured Backlog project (id, key, name, settings).",
      inputSchema: {},
    },
    safeHandler(async () => {
      const project = await client.getProject();
      return jsonResult({
        id: project.id,
        projectKey: project.projectKey,
        name: project.name,
        subtaskingEnabled: project.subtaskingEnabled,
        textFormattingRule: project.textFormattingRule,
        archived: project.archived,
      });
    })
  );
}
