import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { BacklogApiError, type BacklogClient } from "../backlog/client.js";
import type {
  BacklogCategory,
  BacklogIssueType,
  BacklogStatus,
  BacklogVersion,
} from "../backlog/types.js";
import { errorResult, jsonResult, safeHandler } from "./helpers.js";

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

/** The only colors Backlog accepts for custom statuses. */
const STATUS_COLORS = [
  "#ea2c00",
  "#e87758",
  "#e07b9a",
  "#868cb7",
  "#3b9dbd",
  "#4caf93",
  "#b0be3c",
  "#eda62a",
  "#f42858",
  "#393939",
] as const;

/** Backlog custom-field typeId → human-readable type. */
const CUSTOM_FIELD_TYPES: Record<number, string> = {
  1: "text",
  2: "sentence",
  3: "number",
  4: "date",
  5: "single-list",
  6: "multiple-list",
  7: "checkbox",
  8: "radio",
};

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
    "backlog_update_milestone",
    {
      title: "Update a milestone/version",
      description:
        "Write: rename or update an existing milestone (version) of the configured project, by its id " +
        "(from backlog_get_milestones). Only the fields provided are changed; archived true/false " +
        "archives or unarchives it. Only call this after the user explicitly approved the change.",
      inputSchema: {
        milestoneId: z.number().int().positive(),
        name: z.string().min(1).max(255).optional().describe("New name (omit to keep the current name)."),
        description: z.string().optional(),
        startDate: dateSchema.optional(),
        releaseDueDate: dateSchema.optional(),
        archived: z.boolean().optional(),
      },
    },
    safeHandler(
      async (args: {
        milestoneId: number;
        name?: string;
        description?: string;
        startDate?: string;
        releaseDueDate?: string;
        archived?: boolean;
      }) => {
        const { milestoneId, ...fields } = args;
        if (Object.values(fields).every((value) => value === undefined)) {
          return errorResult(
            new BacklogApiError("No fields to update: provide at least one updatable field.")
          );
        }

        // Backlog requires `name` on every version update, so resolve the
        // current one when the caller is not renaming.
        const milestones = await client.getMilestones();
        const current = milestones.find((m) => m.id === milestoneId);
        if (!current) {
          return errorResult(
            new BacklogApiError(
              `milestoneId ${milestoneId} does not exist in this project (use backlog_get_milestones)`
            )
          );
        }

        const form = new URLSearchParams();
        form.set("name", fields.name ?? current.name);
        if (fields.description !== undefined) form.set("description", fields.description);
        if (fields.startDate !== undefined) form.set("startDate", fields.startDate);
        if (fields.releaseDueDate !== undefined) form.set("releaseDueDate", fields.releaseDueDate);
        if (fields.archived !== undefined) form.set("archived", String(fields.archived));

        const updated = await client.patchForm<BacklogVersion>(
          `${projectPath}/versions/${milestoneId}`,
          form
        );
        return jsonResult({
          updated: true,
          id: updated.id,
          previousName: current.name,
          name: updated.name,
          description: updated.description,
          startDate: updated.startDate,
          releaseDueDate: updated.releaseDueDate,
          archived: updated.archived,
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
    "backlog_update_category",
    {
      title: "Update (rename) a category",
      description:
        "Write: rename an existing category of the configured project, by its id " +
        "(from backlog_get_categories). Only call this after the user explicitly approved the change.",
      inputSchema: {
        categoryId: z.number().int().positive(),
        name: z.string().min(1).max(255).describe("The new category name."),
      },
    },
    safeHandler(async ({ categoryId, name }: { categoryId: number; name: string }) => {
      const categories = await client.getCategories();
      const current = categories.find((c) => c.id === categoryId);
      if (!current) {
        return errorResult(
          new BacklogApiError(
            `categoryId ${categoryId} does not exist in this project (use backlog_get_categories)`
          )
        );
      }

      const form = new URLSearchParams();
      form.set("name", name);
      const updated = await client.patchForm<BacklogCategory>(
        `${projectPath}/categories/${categoryId}`,
        form
      );
      return jsonResult({
        updated: true,
        id: updated.id,
        previousName: current.name,
        name: updated.name,
      });
    })
  );

  server.registerTool(
    "backlog_update_issue_type",
    {
      title: "Update an issue type",
      description:
        "Write: rename and/or recolor an existing issue type of the configured project, by its id " +
        "(from backlog_get_issue_types). Only the fields provided are changed. " +
        "Only call this after the user explicitly approved the change.",
      inputSchema: {
        issueTypeId: z.number().int().positive(),
        name: z.string().min(1).max(255).optional(),
        color: z
          .enum(ISSUE_TYPE_COLORS)
          .optional()
          .describe(
            "One of Backlog's fixed issue-type colors: " + ISSUE_TYPE_COLORS.join(", ")
          ),
      },
    },
    safeHandler(
      async ({
        issueTypeId,
        name,
        color,
      }: {
        issueTypeId: number;
        name?: string;
        color?: string;
      }) => {
        if (name === undefined && color === undefined) {
          return errorResult(
            new BacklogApiError("No fields to update: provide name and/or color.")
          );
        }

        const types = await client.getIssueTypes();
        const current = types.find((t) => t.id === issueTypeId);
        if (!current) {
          return errorResult(
            new BacklogApiError(
              `issueTypeId ${issueTypeId} does not exist in this project (use backlog_get_issue_types)`
            )
          );
        }

        const form = new URLSearchParams();
        if (name !== undefined) form.set("name", name);
        if (color !== undefined) form.set("color", color);
        const updated = await client.patchForm<BacklogIssueType>(
          `${projectPath}/issueTypes/${issueTypeId}`,
          form
        );
        return jsonResult({
          updated: true,
          id: updated.id,
          previousName: current.name,
          name: updated.name,
          color: updated.color,
        });
      }
    )
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

  server.registerTool(
    "backlog_get_resolutions",
    {
      title: "Get resolutions",
      description:
        "Return available Backlog resolutions (e.g. Fixed, Won't Fix, Duplicate). " +
        "Use these ids as resolutionId when updating issues.",
      inputSchema: {},
    },
    safeHandler(async () => {
      const resolutions = await client.getResolutions();
      return jsonResult(resolutions);
    })
  );

  server.registerTool(
    "backlog_get_custom_fields",
    {
      title: "Get custom fields",
      description:
        "Return the custom fields of the configured project: id, name, type, whether it is required, " +
        "and for list fields the selectable items. Use these with the customFields parameter of " +
        "backlog_update_issue (for list fields, pass item ids as the value).",
      inputSchema: {},
    },
    safeHandler(async () => {
      const fields = await client.getCustomFields();
      return jsonResult(
        fields.map((f) => ({
          id: f.id,
          name: f.name,
          type: CUSTOM_FIELD_TYPES[f.typeId] ?? `unknown (typeId ${f.typeId})`,
          required: f.required,
          description: f.description || null,
          applicableIssueTypes: f.applicableIssueTypes,
          items: f.items?.map((item) => ({ id: item.id, name: item.name })),
        }))
      );
    })
  );

  server.registerTool(
    "backlog_delete_milestone",
    {
      title: "Delete a milestone/version (irreversible)",
      description:
        "Write: permanently delete a milestone (version) of the configured project, by its id " +
        "(from backlog_get_milestones). It is removed from every issue that references it. " +
        "This cannot be undone; only call this after the user explicitly approved deleting it. " +
        "To merely hide a finished milestone, prefer backlog_update_milestone with archived: true.",
      inputSchema: { milestoneId: z.number().int().positive() },
    },
    safeHandler(async ({ milestoneId }: { milestoneId: number }) => {
      const deleted = await client.deleteForm<BacklogVersion>(
        `${projectPath}/versions/${milestoneId}`
      );
      return jsonResult({ deleted: true, id: deleted.id, name: deleted.name });
    })
  );

  server.registerTool(
    "backlog_delete_category",
    {
      title: "Delete a category (irreversible)",
      description:
        "Write: permanently delete a category of the configured project, by its id " +
        "(from backlog_get_categories). It is removed from every issue that references it. " +
        "This cannot be undone; only call this after the user explicitly approved deleting it.",
      inputSchema: { categoryId: z.number().int().positive() },
    },
    safeHandler(async ({ categoryId }: { categoryId: number }) => {
      const deleted = await client.deleteForm<BacklogCategory>(
        `${projectPath}/categories/${categoryId}`
      );
      return jsonResult({ deleted: true, id: deleted.id, name: deleted.name });
    })
  );

  server.registerTool(
    "backlog_delete_issue_type",
    {
      title: "Delete an issue type (irreversible)",
      description:
        "Write: permanently delete an issue type of the configured project, by its id. Backlog requires a " +
        "substituteIssueTypeId: every issue of the deleted type is reassigned to that type " +
        "(both ids from backlog_get_issue_types). This cannot be undone; only call this after the user " +
        "explicitly approved deleting it.",
      inputSchema: {
        issueTypeId: z.number().int().positive(),
        substituteIssueTypeId: z
          .number()
          .int()
          .positive()
          .describe("Existing issue type that issues of the deleted type are moved to."),
      },
    },
    safeHandler(
      async ({
        issueTypeId,
        substituteIssueTypeId,
      }: {
        issueTypeId: number;
        substituteIssueTypeId: number;
      }) => {
        if (issueTypeId === substituteIssueTypeId) {
          return errorResult(
            new BacklogApiError("substituteIssueTypeId must differ from the issue type being deleted.")
          );
        }
        const form = new URLSearchParams();
        form.set("substituteIssueTypeId", String(substituteIssueTypeId));
        const deleted = await client.deleteForm<BacklogIssueType>(
          `${projectPath}/issueTypes/${issueTypeId}`,
          form
        );
        return jsonResult({
          deleted: true,
          id: deleted.id,
          name: deleted.name,
          substituteIssueTypeId,
        });
      }
    )
  );

  server.registerTool(
    "backlog_add_status",
    {
      title: "Add a custom issue status",
      description:
        "Write: create a custom issue status in the configured project (requires a Backlog plan that " +
        "supports custom statuses). Check backlog_get_statuses first to avoid duplicates. " +
        "Only call this after the user explicitly approved creating it.",
      inputSchema: {
        name: z.string().min(1).max(33),
        color: z
          .enum(STATUS_COLORS)
          .describe("One of Backlog's fixed status colors: " + STATUS_COLORS.join(", ")),
      },
    },
    safeHandler(async ({ name, color }: { name: string; color: string }) => {
      const form = new URLSearchParams();
      form.set("name", name);
      form.set("color", color);
      const created = await client.postForm<BacklogStatus>(`${projectPath}/statuses`, form);
      return jsonResult({ created: true, id: created.id, name: created.name, color: created.color });
    })
  );

  server.registerTool(
    "backlog_update_status",
    {
      title: "Update a custom issue status",
      description:
        "Write: rename and/or recolor a custom issue status of the configured project, by its id " +
        "(from backlog_get_statuses). Backlog's built-in statuses (Open, In Progress, Resolved, Closed) " +
        "cannot be changed. Only call this after the user explicitly approved the change.",
      inputSchema: {
        statusId: z.number().int().positive(),
        name: z.string().min(1).max(33).optional(),
        color: z
          .enum(STATUS_COLORS)
          .optional()
          .describe("One of Backlog's fixed status colors: " + STATUS_COLORS.join(", ")),
      },
    },
    safeHandler(
      async ({ statusId, name, color }: { statusId: number; name?: string; color?: string }) => {
        if (name === undefined && color === undefined) {
          return errorResult(new BacklogApiError("No fields to update: provide name and/or color."));
        }
        const form = new URLSearchParams();
        if (name !== undefined) form.set("name", name);
        if (color !== undefined) form.set("color", color);
        const updated = await client.patchForm<BacklogStatus>(
          `${projectPath}/statuses/${statusId}`,
          form
        );
        return jsonResult({ updated: true, id: updated.id, name: updated.name, color: updated.color });
      }
    )
  );

  server.registerTool(
    "backlog_delete_status",
    {
      title: "Delete a custom issue status (irreversible)",
      description:
        "Write: permanently delete a custom issue status of the configured project, by its id. Backlog " +
        "requires a substituteStatusId: every issue in the deleted status is moved to that status " +
        "(both ids from backlog_get_statuses). Built-in statuses cannot be deleted. This cannot be undone; " +
        "only call this after the user explicitly approved deleting it.",
      inputSchema: {
        statusId: z.number().int().positive(),
        substituteStatusId: z
          .number()
          .int()
          .positive()
          .describe("Existing status that issues in the deleted status are moved to."),
      },
    },
    safeHandler(
      async ({ statusId, substituteStatusId }: { statusId: number; substituteStatusId: number }) => {
        if (statusId === substituteStatusId) {
          return errorResult(
            new BacklogApiError("substituteStatusId must differ from the status being deleted.")
          );
        }
        const form = new URLSearchParams();
        form.set("substituteStatusId", String(substituteStatusId));
        const deleted = await client.deleteForm<BacklogStatus>(
          `${projectPath}/statuses/${statusId}`,
          form
        );
        return jsonResult({ deleted: true, id: deleted.id, name: deleted.name, substituteStatusId });
      }
    )
  );
}
