import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { BacklogClient } from "../backlog/client.js";
import type { BacklogCategory, BacklogIssueType, BacklogVersion } from "../backlog/types.js";
import { jsonResult, safeHandler } from "./helpers.js";

const dateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "must be in yyyy-MM-dd format");

/** The only colors Backlog accepts for issue types. */
const ISSUE_TYPE_COLORS = [
  "#e30000",
  "#990000",
  "#934981",
  "#814fbc",
  "#2779ca",
  "#007e9a",
  "#7ea800",
  "#ff9200",
  "#ff3265",
  "#666665",
] as const;

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

  const projectPath = `/projects/${encodeURIComponent(client.projectKey)}`;

  server.registerTool(
    "backlog_add_milestone",
    {
      title: "Add a milestone/version",
      description:
        "Write: create a milestone (version) in the configured project. " +
        "Check backlog_get_milestones first to avoid duplicates. " +
        "Only call this after the user explicitly approved creating it.",
      inputSchema: {
        name: z.string().min(1).max(255),
        description: z.string().optional(),
        startDate: dateSchema.optional(),
        releaseDueDate: dateSchema.optional(),
      },
    },
    safeHandler(
      async (args: {
        name: string;
        description?: string;
        startDate?: string;
        releaseDueDate?: string;
      }) => {
        const form = new URLSearchParams();
        form.set("name", args.name);
        if (args.description !== undefined) form.set("description", args.description);
        if (args.startDate !== undefined) form.set("startDate", args.startDate);
        if (args.releaseDueDate !== undefined) form.set("releaseDueDate", args.releaseDueDate);

        const created = await client.postForm<BacklogVersion>(`${projectPath}/versions`, form);
        return jsonResult({
          created: true,
          id: created.id,
          name: created.name,
          description: created.description,
          startDate: created.startDate,
          releaseDueDate: created.releaseDueDate,
        });
      }
    )
  );

  server.registerTool(
    "backlog_add_category",
    {
      title: "Add a category",
      description:
        "Write: create a category in the configured project. " +
        "Check backlog_get_categories first to avoid duplicates. " +
        "Only call this after the user explicitly approved creating it.",
      inputSchema: { name: z.string().min(1).max(255) },
    },
    safeHandler(async ({ name }: { name: string }) => {
      const form = new URLSearchParams();
      form.set("name", name);
      const created = await client.postForm<BacklogCategory>(`${projectPath}/categories`, form);
      return jsonResult({ created: true, id: created.id, name: created.name });
    })
  );

  server.registerTool(
    "backlog_add_issue_type",
    {
      title: "Add an issue type",
      description:
        "Write: create an issue type in the configured project. " +
        "Check backlog_get_issue_types first to avoid duplicates. " +
        "Only call this after the user explicitly approved creating it.",
      inputSchema: {
        name: z.string().min(1).max(255),
        color: z
          .enum(ISSUE_TYPE_COLORS)
          .describe(
            "One of Backlog's fixed issue-type colors: " + ISSUE_TYPE_COLORS.join(", ")
          ),
      },
    },
    safeHandler(async ({ name, color }: { name: string; color: string }) => {
      const form = new URLSearchParams();
      form.set("name", name);
      form.set("color", color);
      const created = await client.postForm<BacklogIssueType>(`${projectPath}/issueTypes`, form);
      return jsonResult({ created: true, id: created.id, name: created.name, color: created.color });
    })
  );
}
