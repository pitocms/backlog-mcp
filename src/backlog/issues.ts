import type { BacklogClient } from "./client.js";
import type { BacklogIssue, IssueUpdate, ProposedIssue } from "./types.js";

/**
 * Build the form body for POST /api/v2/issues.
 * Array parameters use the `name[]` convention required by the Backlog API.
 */
export function buildIssueForm(projectId: number, issue: ProposedIssue): URLSearchParams {
  const form = new URLSearchParams();
  form.set("projectId", String(projectId));
  form.set("summary", issue.summary);
  form.set("issueTypeId", String(issue.issueTypeId));
  form.set("priorityId", String(issue.priorityId));

  if (issue.description !== undefined) form.set("description", issue.description);
  if (issue.assigneeId !== undefined) form.set("assigneeId", String(issue.assigneeId));
  if (issue.startDate !== undefined) form.set("startDate", issue.startDate);
  if (issue.dueDate !== undefined) form.set("dueDate", issue.dueDate);
  if (issue.estimatedHours !== undefined) form.set("estimatedHours", String(issue.estimatedHours));
  if (issue.parentIssueId !== undefined) form.set("parentIssueId", String(issue.parentIssueId));
  for (const id of issue.categoryIds ?? []) form.append("categoryId[]", String(id));
  for (const id of issue.milestoneIds ?? []) form.append("milestoneId[]", String(id));

  return form;
}

/**
 * Build the form body for PATCH /api/v2/issues/:issueIdOrKey.
 * Only fields present in the update are sent; an empty categoryIds/milestoneIds
 * array clears that field (Backlog's empty-parameter convention).
 */
export function buildIssueUpdateForm(update: IssueUpdate): URLSearchParams {
  const form = new URLSearchParams();

  if (update.summary !== undefined) form.set("summary", update.summary);
  if (update.description !== undefined) form.set("description", update.description);
  if (update.issueTypeId !== undefined) form.set("issueTypeId", String(update.issueTypeId));
  if (update.priorityId !== undefined) form.set("priorityId", String(update.priorityId));
  if (update.assigneeId !== undefined) form.set("assigneeId", String(update.assigneeId));
  if (update.startDate !== undefined) form.set("startDate", update.startDate);
  if (update.dueDate !== undefined) form.set("dueDate", update.dueDate);
  if (update.estimatedHours !== undefined) {
    form.set("estimatedHours", String(update.estimatedHours));
  }
  if (update.categoryIds !== undefined) {
    if (update.categoryIds.length === 0) form.append("categoryId[]", "");
    for (const id of update.categoryIds) form.append("categoryId[]", String(id));
  }
  if (update.milestoneIds !== undefined) {
    if (update.milestoneIds.length === 0) form.append("milestoneId[]", "");
    for (const id of update.milestoneIds) form.append("milestoneId[]", String(id));
  }

  return form;
}

export async function createIssue(
  client: BacklogClient,
  projectId: number,
  issue: ProposedIssue
): Promise<BacklogIssue> {
  return client.postForm<BacklogIssue>("/issues", buildIssueForm(projectId, issue));
}

export async function updateIssue(
  client: BacklogClient,
  issueIdOrKey: string,
  update: IssueUpdate
): Promise<BacklogIssue> {
  return client.patchForm<BacklogIssue>(
    `/issues/${encodeURIComponent(issueIdOrKey)}`,
    buildIssueUpdateForm(update)
  );
}

/** Web URL of an issue in the Backlog UI. */
export function issueUrl(baseUrl: string, issueKey: string): string {
  return `${baseUrl}/view/${issueKey}`;
}
