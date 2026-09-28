import type { BacklogClient } from "./client.js";
import type { BacklogComment } from "./types.js";

/**
 * Build the form body for POST /api/v2/issues/:issueIdOrKey/comments.
 * Array parameters use the `name[]` convention required by the Backlog API.
 */
export function buildCommentForm(content: string, notifiedUserIds?: number[]): URLSearchParams {
  const form = new URLSearchParams();
  form.set("content", content);
  for (const id of notifiedUserIds ?? []) form.append("notifiedUserId[]", String(id));
  return form;
}

export async function addComment(
  client: BacklogClient,
  issueIdOrKey: string,
  content: string,
  notifiedUserIds?: number[]
): Promise<BacklogComment> {
  return client.postForm<BacklogComment>(
    `/issues/${encodeURIComponent(issueIdOrKey)}/comments`,
    buildCommentForm(content, notifiedUserIds)
  );
}

/** Quote a comment's text the way the Backlog UI does, for use in a reply. */
export function quoteComment(comment: BacklogComment): string {
  const body = comment.content ?? "";
  const author = comment.createdUser?.name;
  const quoted = body
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");
  return author ? `${author} wrote:\n${quoted}` : quoted;
}

/** Web URL of a comment in the Backlog UI. */
export function commentUrl(baseUrl: string, issueKey: string, commentId: number): string {
  return `${baseUrl}/view/${issueKey}#comment-${commentId}`;
}
