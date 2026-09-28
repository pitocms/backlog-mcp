import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { BacklogApiError, type BacklogClient, type QueryParams } from "../backlog/client.js";
import { addComment, commentUrl, quoteComment } from "../backlog/comments.js";
import type { BacklogComment, BacklogIssue } from "../backlog/types.js";
import { jsonResult, safeHandler } from "./helpers.js";

const issueIdOrKeySchema = z
  .string()
  .min(1)
  .describe("Issue ID or issue key, e.g. LMSDEV-80");

function commentView(baseUrl: string, issueKey: string, comment: BacklogComment) {
  return {
    commentId: comment.id,
    content: comment.content,
    author: comment.createdUser?.name ?? null,
    created: comment.created,
    updated: comment.updated,
    url: commentUrl(baseUrl, issueKey, comment.id),
  };
}

export function registerCommentTools(
  server: McpServer,
  client: BacklogClient,
  baseUrl: string
): void {
  server.registerTool(
    "backlog_list_comments",
    {
      title: "List comments on a Backlog issue",
      description:
        "Read-only: list the comments of an issue by issue ID or issue key (e.g. LMSDEV-80), " +
        "newest first by default. Comments whose content is null are change-log-only entries " +
        "(e.g. a status change without text). Use minId with order asc to page forward.",
      inputSchema: {
        issueIdOrKey: issueIdOrKeySchema,
        count: z.number().int().min(1).max(100).optional().describe("Page size, 1-100 (default 20)."),
        order: z.enum(["asc", "desc"]).optional().describe("By comment id; default desc (newest first)."),
        minId: z.number().int().positive().optional().describe("Only comments with id greater than this."),
        maxId: z.number().int().positive().optional().describe("Only comments with id less than this."),
      },
    },
    safeHandler(
      async (args: {
        issueIdOrKey: string;
        count?: number;
        order?: "asc" | "desc";
        minId?: number;
        maxId?: number;
      }) => {
        const query: QueryParams = {
          count: String(args.count ?? 20),
          order: args.order ?? "desc",
        };
        if (args.minId !== undefined) query.minId = String(args.minId);
        if (args.maxId !== undefined) query.maxId = String(args.maxId);

        const [issue, comments] = await Promise.all([
          client.getIssue<BacklogIssue>(args.issueIdOrKey),
          client.getIssueComments(args.issueIdOrKey, query),
        ]);

        return jsonResult({
          issueKey: issue.issueKey,
          summary: issue.summary,
          returned: comments.length,
          comments: comments.map((c) => commentView(baseUrl, issue.issueKey, c)),
        });
      }
    )
  );

  server.registerTool(
    "backlog_add_comment",
    {
      title: "Add a comment to a Backlog issue",
      description:
        "Write a comment on an issue by issue ID or issue key (e.g. LMSDEV-80). " +
        "To reply to an existing comment, pass replyToCommentId: the original comment is quoted " +
        "above your content and its author is notified (Backlog comments are flat, so a reply " +
        "is a new comment). Only call this after the user approved the comment text.",
      inputSchema: {
        issueIdOrKey: issueIdOrKeySchema,
        content: z.string().min(1, "content is required").max(8000),
        replyToCommentId: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Comment id (from backlog_list_comments) to quote and reply to."),
        notifiedUserIds: z
          .array(z.number().int().positive())
          .optional()
          .describe("Project member ids (from backlog_get_users) to notify about this comment."),
      },
    },
    safeHandler(
      async (args: {
        issueIdOrKey: string;
        content: string;
        replyToCommentId?: number;
        notifiedUserIds?: number[];
      }) => {
        let content = args.content;
        const notifiedUserIds = new Set(args.notifiedUserIds ?? []);
        let repliedTo: { commentId: number; author: string | null } | undefined;

        if (args.replyToCommentId !== undefined) {
          let original: BacklogComment;
          try {
            original = await client.getIssueComment(args.issueIdOrKey, args.replyToCommentId);
          } catch (err) {
            if (err instanceof BacklogApiError && err.status === 404) {
              throw new BacklogApiError(
                `replyToCommentId ${args.replyToCommentId} does not exist on issue ${args.issueIdOrKey} (use backlog_list_comments).`
              );
            }
            throw err;
          }
          content = `${quoteComment(original)}\n\n${args.content}`;

          // Notify the original author, but only if they are still a project
          // member: notifiedUserId rejects non-members and would fail the post.
          const authorId = original.createdUser?.id;
          if (authorId !== undefined) {
            const members = await client.getProjectUsers();
            if (members.some((u) => u.id === authorId)) notifiedUserIds.add(authorId);
          }
          repliedTo = {
            commentId: original.id,
            author: original.createdUser?.name ?? null,
          };
        }

        const issue = await client.getIssue<BacklogIssue>(args.issueIdOrKey);
        const created = await addComment(client, args.issueIdOrKey, content, [...notifiedUserIds]);

        return jsonResult({
          commented: true,
          issueKey: issue.issueKey,
          commentId: created.id,
          content: created.content,
          notifiedUserIds: [...notifiedUserIds],
          ...(repliedTo ? { repliedTo } : {}),
          url: commentUrl(baseUrl, issue.issueKey, created.id),
        });
      }
    )
  );
}
