import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { BacklogClient } from "../backlog/client.js";
import { jsonResult, safeHandler } from "./helpers.js";

export function registerMetadataTools(server: McpServer, client: BacklogClient): void {
  server.registerTool(
    "backlog_get_issue_types",
    {
      title: "Get issue types",
      description:
        "Return issue types of the configured project. Use these ids as issueTypeId when creating issues.",
      inputSchema: {},
    },
    safeHandler(async () => {
      const types = await client.getIssueTypes();
      return jsonResult(types.map((t) => ({ id: t.id, name: t.name, color: t.color })));
    })
  );

  server.registerTool(
    "backlog_get_priorities",
    {
      title: "Get priorities",
      description:
        "Return available Backlog priorities. Use these ids as priorityId when creating issues.",
      inputSchema: {},
    },
    safeHandler(async () => {
      const priorities = await client.getPriorities();
      return jsonResult(priorities);
    })
  );

  server.registerTool(
    "backlog_get_categories",
    {
      title: "Get categories",
      description:
        "Return categories of the configured project. Use these ids in categoryIds when creating issues.",
      inputSchema: {},
    },
    safeHandler(async () => {
      const categories = await client.getCategories();
      return jsonResult(categories.map((c) => ({ id: c.id, name: c.name })));
    })
  );

  server.registerTool(
    "backlog_get_statuses",
    {
      title: "Get issue statuses",
      description:
        "Return the issue statuses of the configured project (e.g. Open, In Progress, Resolved, Closed, plus any custom statuses). " +
        "Use these ids as statusIds when listing issues with backlog_list_issues.",
      inputSchema: {},
    },
    safeHandler(async () => {
      const statuses = await client.getStatuses();
      return jsonResult(statuses.map((s) => ({ id: s.id, name: s.name, color: s.color })));
    })
  );

  server.registerTool(
    "backlog_get_milestones",
    {
      title: "Get milestones",
      description:
        "Return milestones/versions of the configured project. Use these ids in milestoneIds when creating issues.",
      inputSchema: {},
    },
    safeHandler(async () => {
      const milestones = await client.getMilestones();
      return jsonResult(
        milestones.map((m) => ({
          id: m.id,
          name: m.name,
          startDate: m.startDate,
          releaseDueDate: m.releaseDueDate,
          archived: m.archived,
        }))
      );
    })
  );
}
