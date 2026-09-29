import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { BacklogApiError, type BacklogClient, type QueryParams } from "../backlog/client.js";
import { createIssue, issueUrl, updateIssue } from "../backlog/issues.js";
import type {
  BacklogIssue,
  BacklogIssueDetail,
  IssueUpdate,
  ProposedIssue,
} from "../backlog/types.js";
import { errorResult, jsonResult, safeHandler } from "./helpers.js";

const dateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "must be in yyyy-MM-dd format");

const proposedIssueShape = {
  summary: z.string().min(1, "summary is required").max(255),
  description: z.string().optional(),
  issueTypeId: z.number().int().positive(),
  priorityId: z.number().int().positive(),
  assigneeId: z.number().int().positive().optional(),
  startDate: dateSchema.optional(),
  dueDate: dateSchema.optional(),
  estimatedHours: z.number().nonnegative().optional(),
  categoryIds: z.array(z.number().int().positive()).optional(),
  milestoneIds: z.array(z.number().int().positive()).optional(),
  parentIssueId: z.number().int().positive().optional(),
};

const proposedIssueSchema = z.object(proposedIssueShape);

const customFieldValueSchema = z.object({
  id: z.number().int().positive().describe("Custom field id (from backlog_get_custom_fields)."),
  value: z
    .union([z.string(), z.number(), z.array(z.union([z.string(), z.number()]))])
    .describe(
      "The value: text/number/date string, a list item id for single-list fields, or an array of item ids for multiple-list fields."
    ),
  otherValue: z
    .string()
    .optional()
    .describe('Free-text value for list fields that allow "other".'),
});

const issueUpdateShape = {
  issueTypeId: z.number().int().positive().optional(),
  summary: z.string().min(1).max(255).optional(),
  description: z.string().optional(),
  statusId: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("New status id (from backlog_get_statuses), e.g. Open, In Progress, Resolved, Closed."),
  priorityId: z.number().int().positive().optional(),
  assigneeId: z.number().int().positive().optional(),
  startDate: dateSchema.optional(),
  dueDate: dateSchema.optional(),
  estimatedHours: z.number().nonnegative().optional(),
  actualHours: z.number().nonnegative().optional(),
  parentIssueId: z
    .number()
    .int()
    .positive()
    .nullable()
    .optional()
    .describe("New parent issue id; null detaches the issue from its current parent."),
  resolutionId: z
    .number()
    .int()
    .positive()
    .nullable()
    .optional()
    .describe("Resolution id (from backlog_get_resolutions); null clears the resolution."),
  attachmentIds: z
    .array(z.number().int().positive())
    .optional()
    .describe("Space attachment ids (from backlog_upload_attachment) to attach to the issue."),
  customFields: z
    .array(customFieldValueSchema)
    .optional()
    .describe("Custom-field values to set (see backlog_get_custom_fields for ids and types)."),
  categoryIds: z
    .array(z.number().int().positive())
    .optional()
    .describe("Replaces the issue's categories; an empty array clears them."),
  milestoneIds: z
    .array(z.number().int().positive())
    .optional()
    .describe("Replaces the issue's milestones; an empty array clears them."),
};

const issueIdOrKeySchema = z
  .string()
  .min(1)
  .describe("Issue ID or issue key, e.g. LMSDEV-80");

const issueUpdatesArraySchema = z
  .array(z.object({ issueIdOrKey: issueIdOrKeySchema, ...issueUpdateShape }))
  .min(1, "provide at least one update")
  .max(100, "at most 100 updates per call");

/** The fields actually being changed, for reporting back to the caller. */
function definedUpdateFields(update: IssueUpdate): Partial<IssueUpdate> {
  return Object.fromEntries(
    Object.entries(update).filter(([, value]) => value !== undefined)
  ) as Partial<IssueUpdate>;
}

const issuesArraySchema = z
  .array(proposedIssueSchema)
  .min(1, "provide at least one issue")
  .max(100, "at most 100 issues per call");

interface ProjectMetadata {
  projectId: number;
  issueTypes: Map<number, string>;
  priorities: Map<number, string>;
  users: Map<number, string>;
  categories: Map<number, string>;
  milestones: Map<number, string>;
}

async function loadMetadata(client: BacklogClient): Promise<ProjectMetadata> {
  const [project, issueTypes, priorities, users, categories, milestones] = await Promise.all([
    client.getProject(),
    client.getIssueTypes(),
    client.getPriorities(),
    client.getProjectUsers(),
    client.getCategories(),
    client.getMilestones(),
  ]);
  return {
    projectId: project.id,
    issueTypes: new Map(issueTypes.map((t) => [t.id, t.name])),
    priorities: new Map(priorities.map((p) => [p.id, p.name])),
    users: new Map(users.map((u) => [u.id, u.name])),
    categories: new Map(categories.map((c) => [c.id, c.name])),
    milestones: new Map(milestones.map((m) => [m.id, m.name])),
  };
}

function isValidCalendarDate(value: string): boolean {
  const [y, m, d] = value.split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  return (
    date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d
  );
}

interface ValidationOutcome {
  errors: string[];
  preview: Record<string, unknown>;
}

async function validateIssue(
  client: BacklogClient,
  meta: ProjectMetadata,
  issue: ProposedIssue,
  parentCache: Map<number, BacklogIssue | null>
): Promise<ValidationOutcome> {
  const errors: string[] = [];

  const issueTypeName = meta.issueTypes.get(issue.issueTypeId);
  if (!issueTypeName) {
    errors.push(
      `issueTypeId ${issue.issueTypeId} does not exist in this project (use backlog_get_issue_types)`
    );
  }

  const priorityName = meta.priorities.get(issue.priorityId);
  if (!priorityName) {
    errors.push(`priorityId ${issue.priorityId} is not a valid priority (use backlog_get_priorities)`);
  }

  let assigneeName: string | undefined;
  if (issue.assigneeId !== undefined) {
    assigneeName = meta.users.get(issue.assigneeId);
    if (!assigneeName) {
      errors.push(`assigneeId ${issue.assigneeId} is not a member of this project (use backlog_get_users)`);
    }
  }

  for (const field of ["startDate", "dueDate"] as const) {
    const value = issue[field];
    if (value !== undefined && !isValidCalendarDate(value)) {
      errors.push(`${field} "${value}" is not a valid calendar date`);
    }
  }
  if (issue.startDate && issue.dueDate && issue.startDate > issue.dueDate) {
    errors.push(`startDate ${issue.startDate} is after dueDate ${issue.dueDate}`);
  }

  const categoryNames: string[] = [];
  for (const id of issue.categoryIds ?? []) {
    const name = meta.categories.get(id);
    if (name) categoryNames.push(name);
    else errors.push(`categoryId ${id} does not exist in this project (use backlog_get_categories)`);
  }

  const milestoneNames: string[] = [];
  for (const id of issue.milestoneIds ?? []) {
    const name = meta.milestones.get(id);
    if (name) milestoneNames.push(name);
    else errors.push(`milestoneId ${id} does not exist in this project (use backlog_get_milestones)`);
  }

  let parentIssueKey: string | undefined;
  if (issue.parentIssueId !== undefined) {
    let parent = parentCache.get(issue.parentIssueId);
    if (parent === undefined) {
      try {
        parent = await client.getIssue<BacklogIssue>(issue.parentIssueId);
      } catch (err) {
        parent = null;
        if (!(err instanceof BacklogApiError && err.status === 404)) throw err;
      }
      parentCache.set(issue.parentIssueId, parent);
    }
    if (!parent) {
      errors.push(`parentIssueId ${issue.parentIssueId} does not exist`);
    } else if (parent.projectId !== meta.projectId) {
      errors.push(`parentIssueId ${issue.parentIssueId} (${parent.issueKey}) belongs to a different project`);
    } else if (parent.parentIssueId) {
      errors.push(
        `parentIssueId ${issue.parentIssueId} (${parent.issueKey}) is itself a child issue; Backlog does not allow nesting deeper than one level`
      );
    } else {
      parentIssueKey = parent.issueKey;
    }
  }

  const preview: Record<string, unknown> = {
    summary: issue.summary,
    issueType: issueTypeName ?? `UNKNOWN (id ${issue.issueTypeId})`,
    priority: priorityName ?? `UNKNOWN (id ${issue.priorityId})`,
  };
  if (issue.description !== undefined) {
    preview.description =
      issue.description.length > 300
        ? `${issue.description.slice(0, 300)}… (${issue.description.length} chars)`
        : issue.description;
  }
  if (issue.assigneeId !== undefined) {
    preview.assignee = assigneeName ?? `UNKNOWN (id ${issue.assigneeId})`;
  }
  if (issue.startDate) preview.startDate = issue.startDate;
  if (issue.dueDate) preview.dueDate = issue.dueDate;
  if (issue.estimatedHours !== undefined) preview.estimatedHours = issue.estimatedHours;
  if (issue.categoryIds?.length) preview.categories = categoryNames;
  if (issue.milestoneIds?.length) preview.milestones = milestoneNames;
  if (issue.parentIssueId !== undefined) {
    preview.parentIssue = parentIssueKey ?? `UNKNOWN (id ${issue.parentIssueId})`;
  }

  return { errors, preview };
}

/** Pause between write requests, per Backlog's rate limit guidance. */
const BATCH_DELAY_MS = 1_000;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const listIssuesShape = {
  statusIds: z
    .array(z.number().int().positive())
    .optional()
    .describe("Filter by status ids (from backlog_get_statuses). Omit both status filters to get all statuses."),
  statusNames: z
    .array(z.string().min(1))
    .optional()
    .describe('Filter by status names, case-insensitive, e.g. ["Open", "In Progress", "Resolved"].'),
  assigneeIds: z
    .array(z.number().int().positive())
    .optional()
    .describe("Filter by assignee user ids (from backlog_get_users)."),
  keyword: z.string().min(1).optional().describe("Full-text keyword filter."),
  sort: z.enum(["created", "updated", "dueDate", "priority", "status"]).optional(),
  order: z.enum(["asc", "desc"]).optional().describe("Default desc."),
  count: z.number().int().min(1).max(100).optional().describe("Page size, 1-100 (default 20)."),
  offset: z.number().int().min(0).optional().describe("Skip this many issues (for paging)."),
};

interface ListIssuesArgs {
  statusIds?: number[];
  statusNames?: string[];
  assigneeIds?: number[];
  keyword?: string;
  sort?: "created" | "updated" | "dueDate" | "priority" | "status";
  order?: "asc" | "desc";
  count?: number;
  offset?: number;
}

export function registerIssueTools(
  server: McpServer,
  client: BacklogClient,
  baseUrl: string
): void {
  server.registerTool(
    "backlog_list_issues",
    {
      title: "List Backlog issues",
      description:
        "Read-only: list issues of the configured project, optionally filtered by status " +
        "(e.g. Open, In Progress, Resolved, Closed), assignee, or keyword. " +
        "Returns paged results plus the total match count; use offset to fetch the next page.",
      inputSchema: listIssuesShape,
    },
    safeHandler(async (args: ListIssuesArgs) => {
      const project = await client.getProject();

      const statusIds = [...(args.statusIds ?? [])];
      if (args.statusNames?.length) {
        const statuses = await client.getStatuses();
        const byName = new Map(statuses.map((s) => [s.name.toLowerCase(), s.id]));
        const unknown = args.statusNames.filter(
          (name) => !byName.has(name.trim().toLowerCase())
        );
        if (unknown.length > 0) {
          return errorResult(
            new BacklogApiError(
              `Unknown status name(s): ${unknown.join(", ")}. ` +
                `This project's statuses are: ${statuses.map((s) => s.name).join(", ")}.`
            )
          );
        }
        for (const name of args.statusNames) {
          statusIds.push(byName.get(name.trim().toLowerCase())!);
        }
      }

      const filters: QueryParams = { "projectId[]": [String(project.id)] };
      if (statusIds.length > 0) {
        filters["statusId[]"] = [...new Set(statusIds)].map(String);
      }
      if (args.assigneeIds?.length) {
        filters["assigneeId[]"] = args.assigneeIds.map(String);
      }
      if (args.keyword) filters.keyword = args.keyword;

      const count = args.count ?? 20;
      const offset = args.offset ?? 0;
      const [issues, total] = await Promise.all([
        client.getIssues({
          ...filters,
          sort: args.sort ?? "updated",
          order: args.order ?? "desc",
          count: String(count),
          offset: String(offset),
        }),
        client.countIssues(filters),
      ]);

      return jsonResult({
        project: client.projectKey,
        total: total.count,
        returned: issues.length,
        offset,
        hasMore: offset + issues.length < total.count,
        issues: issues.map((issue) => ({
          issueKey: issue.issueKey,
          summary: issue.summary,
          status: issue.status.name,
          issueType: issue.issueType.name,
          priority: issue.priority.name,
          assignee: issue.assignee?.name ?? null,
          startDate: issue.startDate,
          dueDate: issue.dueDate,
          estimatedHours: issue.estimatedHours,
          categories: issue.category.map((c) => c.name),
          milestones: issue.milestone.map((m) => m.name),
          parentIssueId: issue.parentIssueId,
          updated: issue.updated,
          url: issueUrl(baseUrl, issue.issueKey),
        })),
      });
    })
  );

  server.registerTool(
    "backlog_get_issue",
    {
      title: "Get ONE Backlog issue",
      description:
        "Read-only: fetch the full details of a single issue by issue ID or issue key " +
        "(e.g. LMSDEV-80), including its description.",
      inputSchema: { issueIdOrKey: issueIdOrKeySchema },
    },
    safeHandler(async ({ issueIdOrKey }: { issueIdOrKey: string }) => {
      const issue = await client.getIssue<BacklogIssueDetail>(issueIdOrKey);
      return jsonResult({
        issueId: issue.id,
        issueKey: issue.issueKey,
        summary: issue.summary,
        description: issue.description,
        status: issue.status.name,
        issueType: issue.issueType.name,
        priority: issue.priority.name,
        resolution: issue.resolution?.name ?? null,
        assignee: issue.assignee?.name ?? null,
        startDate: issue.startDate,
        dueDate: issue.dueDate,
        estimatedHours: issue.estimatedHours,
        actualHours: issue.actualHours,
        categories: issue.category.map((c) => c.name),
        milestones: issue.milestone.map((m) => m.name),
        parentIssueId: issue.parentIssueId,
        createdUser: issue.createdUser?.name ?? null,
        created: issue.created,
        updatedUser: issue.updatedUser?.name ?? null,
        updated: issue.updated,
        url: issueUrl(baseUrl, issue.issueKey),
      });
    })
  );

  server.registerTool(
    "backlog_validate_issues",
    {
      title: "Validate proposed issues (dry run)",
      description:
        "Validate one or more proposed issues against the configured Backlog project WITHOUT creating anything. " +
        "Returns a human-reviewable preview of what would be created, plus per-issue errors. " +
        "Always run this first and have the user review and approve the preview before calling any create tool.",
      inputSchema: { issues: issuesArraySchema },
    },
    safeHandler(async ({ issues }: { issues: ProposedIssue[] }) => {
      const meta = await loadMetadata(client);
      const parentCache = new Map<number, BacklogIssue | null>();

      const results = [];
      for (const [index, issue] of issues.entries()) {
        const { errors, preview } = await validateIssue(client, meta, issue, parentCache);
        results.push({
          index,
          valid: errors.length === 0,
          errors,
          preview,
        });
      }

      const invalidCount = results.filter((r) => !r.valid).length;
      return jsonResult({
        dryRun: true,
        note: "No issues were created. Have the user review this preview and explicitly approve before creating.",
        project: client.projectKey,
        totalIssues: issues.length,
        validIssues: issues.length - invalidCount,
        invalidIssues: invalidCount,
        results,
      });
    })
  );

  server.registerTool(
    "backlog_create_issue",
    {
      title: "Create ONE Backlog issue",
      description:
        "Create a single issue in the configured Backlog project. " +
        "Only call this after backlog_validate_issues succeeded and the user explicitly approved creation.",
      inputSchema: proposedIssueShape,
    },
    safeHandler(async (issue: ProposedIssue) => {
      const project = await client.getProject();
      const created = await createIssue(client, project.id, issue);
      return jsonResult({
        created: true,
        issueId: created.id,
        issueKey: created.issueKey,
        url: issueUrl(baseUrl, created.issueKey),
        summary: created.summary,
      });
    })
  );

  server.registerTool(
    "backlog_create_issues_batch",
    {
      title: "Create multiple Backlog issues",
      description:
        "Create multiple issues sequentially in the configured Backlog project. " +
        "Issues are created one by one; a failure does not stop the remaining issues, and each result is reported. " +
        "Only call this after backlog_validate_issues succeeded and the user explicitly approved creation. " +
        "Set confirmedByUser to true only when the user has actually reviewed the validation preview and said to proceed.",
      inputSchema: {
        issues: issuesArraySchema,
        confirmedByUser: z
          .boolean()
          .describe(
            "Must be true, and only after the user explicitly approved creating these issues."
          ),
      },
    },
    async ({ issues, confirmedByUser }: { issues: ProposedIssue[]; confirmedByUser: boolean }) => {
      if (!confirmedByUser) {
        return errorResult(
          new BacklogApiError(
            "Refused: confirmedByUser is not true. Run backlog_validate_issues, show the preview to the user, and only retry after they explicitly approve."
          )
        );
      }

      let project;
      try {
        project = await client.getProject();
      } catch (err) {
        return errorResult(err);
      }

      const results = [];
      for (const [index, issue] of issues.entries()) {
        if (index > 0) await sleep(BATCH_DELAY_MS);
        try {
          const created = await createIssue(client, project.id, issue);
          results.push({
            index,
            summary: issue.summary,
            success: true,
            issueId: created.id,
            issueKey: created.issueKey,
            url: issueUrl(baseUrl, created.issueKey),
          });
        } catch (err) {
          results.push({
            index,
            summary: issue.summary,
            success: false,
            error:
              err instanceof BacklogApiError
                ? err.message
                : "Unexpected error while creating this issue.",
          });
        }
      }

      const failed = results.filter((r) => !r.success).length;
      return jsonResult({
        totalIssues: issues.length,
        created: issues.length - failed,
        failed,
        results,
      });
    }
  );

  server.registerTool(
    "backlog_update_issue",
    {
      title: "Update ONE Backlog issue",
      description:
        "Update an existing Backlog issue by issue ID or issue key (e.g. LMSDEV-80). " +
        "Only the fields provided are changed: status (statusId), resolution (resolutionId, null clears), " +
        "parent issue (parentIssueId, null detaches), actual hours, attachments, custom fields, and the " +
        "standard fields; categoryIds/milestoneIds replace the current lists " +
        "(empty array clears them). Only call this after the user explicitly approved the change.",
      inputSchema: { issueIdOrKey: issueIdOrKeySchema, ...issueUpdateShape },
    },
    safeHandler(async ({ issueIdOrKey, ...update }: { issueIdOrKey: string } & IssueUpdate) => {
      const fields = definedUpdateFields(update);
      if (Object.keys(fields).length === 0) {
        return errorResult(
          new BacklogApiError("No fields to update: provide at least one updatable field.")
        );
      }
      const updated = await updateIssue(client, issueIdOrKey, fields);
      return jsonResult({
        updated: true,
        issueId: updated.id,
        issueKey: updated.issueKey,
        url: issueUrl(baseUrl, updated.issueKey),
        summary: updated.summary,
        updatedFields: fields,
      });
    })
  );

  server.registerTool(
    "backlog_update_issues_batch",
    {
      title: "Update multiple Backlog issues",
      description:
        "Update multiple existing issues sequentially, each identified by issue ID or issue key. " +
        "A failure does not stop the remaining updates; each result is reported with the issue key " +
        "and the fields that were changed. Only call this after the user explicitly approved the changes. " +
        "Set confirmedByUser to true only when the user has actually reviewed the planned updates and said to proceed.",
      inputSchema: {
        updates: issueUpdatesArraySchema,
        confirmedByUser: z
          .boolean()
          .describe(
            "Must be true, and only after the user explicitly approved updating these issues."
          ),
      },
    },
    async ({
      updates,
      confirmedByUser,
    }: {
      updates: ({ issueIdOrKey: string } & IssueUpdate)[];
      confirmedByUser: boolean;
    }) => {
      if (!confirmedByUser) {
        return errorResult(
          new BacklogApiError(
            "Refused: confirmedByUser is not true. Show the user the planned updates and only retry after they explicitly approve."
          )
        );
      }

      const results = [];
      for (const [index, { issueIdOrKey, ...update }] of updates.entries()) {
        if (index > 0) await sleep(BATCH_DELAY_MS);
        const fields = definedUpdateFields(update);
        if (Object.keys(fields).length === 0) {
          results.push({
            index,
            issueIdOrKey,
            success: false,
            error: "No fields to update: provide at least one updatable field.",
          });
          continue;
        }
        try {
          const updated = await updateIssue(client, issueIdOrKey, fields);
          results.push({
            index,
            issueIdOrKey,
            success: true,
            issueId: updated.id,
            issueKey: updated.issueKey,
            url: issueUrl(baseUrl, updated.issueKey),
            updatedFields: fields,
          });
        } catch (err) {
          results.push({
            index,
            issueIdOrKey,
            success: false,
            error:
              err instanceof BacklogApiError
                ? err.message
                : "Unexpected error while updating this issue.",
          });
        }
      }

      const failed = results.filter((r) => !r.success).length;
      return jsonResult({
        totalUpdates: updates.length,
        updated: updates.length - failed,
        failed,
        results,
      });
    }
  );

  server.registerTool(
    "backlog_delete_issue",
    {
      title: "Delete a Backlog issue (irreversible)",
      description:
        "Write: permanently delete an issue by issue ID or issue key (e.g. LMSDEV-80), including all its " +
        "comments and attachments. This cannot be undone. Show the user the issue (backlog_get_issue) and " +
        "set confirmedByUser to true only after they explicitly approved deleting exactly this issue.",
      inputSchema: {
        issueIdOrKey: issueIdOrKeySchema,
        confirmedByUser: z
          .boolean()
          .describe("Must be true, and only after the user explicitly approved deleting this issue."),
      },
    },
    safeHandler(
      async ({ issueIdOrKey, confirmedByUser }: { issueIdOrKey: string; confirmedByUser: boolean }) => {
        if (!confirmedByUser) {
          return errorResult(
            new BacklogApiError(
              "Refused: confirmedByUser is not true. Show the user the issue and only retry after they explicitly approve deleting it."
            )
          );
        }
        const deleted = await client.deleteForm<BacklogIssue>(
          `/issues/${encodeURIComponent(issueIdOrKey)}`
        );
        return jsonResult({
          deleted: true,
          issueId: deleted.id,
          issueKey: deleted.issueKey,
          summary: deleted.summary,
        });
      }
    )
  );
}
