import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { BacklogApiError, type BacklogClient } from "../backlog/client.js";
import type { BacklogAttachment, BacklogIssue } from "../backlog/types.js";
import { errorResult, jsonResult, safeHandler } from "./helpers.js";

const issueIdOrKeySchema = z
  .string()
  .min(1)
  .describe("Issue ID or issue key, e.g. LMSDEV-80");

/** Backlog rejects uploads over 10MB; base64 inflates by ~4/3. */
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

/** Downloads larger than this are not inlined into the MCP response. */
const MAX_DOWNLOAD_BYTES = 2 * 1024 * 1024;

const TEXTUAL_TYPES = /^(text\/|application\/(json|xml|javascript|x-yaml|csv))/;

export function registerAttachmentTools(server: McpServer, client: BacklogClient): void {
  server.registerTool(
    "backlog_upload_attachment",
    {
      title: "Upload an attachment file",
      description:
        "Write: upload a file (as base64) to the Backlog space and get back an attachment id. " +
        "The id alone attaches nothing: pass it in attachmentIds of backlog_update_issue or " +
        "backlog_add_comment within one hour to actually attach the file. Maximum size 10MB.",
      inputSchema: {
        fileName: z.string().min(1).max(255).describe("File name including extension, e.g. report.pdf"),
        contentBase64: z.string().min(1).describe("The file's content, base64-encoded."),
      },
    },
    safeHandler(async ({ fileName, contentBase64 }: { fileName: string; contentBase64: string }) => {
      let data: Buffer;
      try {
        data = Buffer.from(contentBase64, "base64");
      } catch {
        return errorResult(new BacklogApiError("contentBase64 is not valid base64."));
      }
      if (data.length === 0) {
        return errorResult(new BacklogApiError("contentBase64 decoded to an empty file."));
      }
      if (data.length > MAX_UPLOAD_BYTES) {
        return errorResult(
          new BacklogApiError(
            `File is ${(data.length / 1024 / 1024).toFixed(1)}MB; Backlog's upload limit is 10MB.`
          )
        );
      }

      const multipart = new FormData();
      multipart.set("file", new Blob([new Uint8Array(data)]), fileName);
      const uploaded = await client.postMultipart<BacklogAttachment>("/space/attachments", multipart);

      return jsonResult({
        uploaded: true,
        attachmentId: uploaded.id,
        name: uploaded.name,
        size: uploaded.size,
        note:
          "Attach it within one hour by passing this id in attachmentIds of backlog_update_issue or backlog_add_comment.",
      });
    })
  );

  server.registerTool(
    "backlog_list_attachments",
    {
      title: "List attachments of a Backlog issue",
      description:
        "Read-only: list the files attached to an issue, by issue ID or issue key (e.g. LMSDEV-80). " +
        "Use the returned attachment ids with backlog_download_attachment or backlog_delete_attachment.",
      inputSchema: { issueIdOrKey: issueIdOrKeySchema },
    },
    safeHandler(async ({ issueIdOrKey }: { issueIdOrKey: string }) => {
      const [issue, attachments] = await Promise.all([
        client.getIssue<BacklogIssue>(issueIdOrKey),
        client.getIssueAttachments(issueIdOrKey),
      ]);
      return jsonResult({
        issueKey: issue.issueKey,
        summary: issue.summary,
        attachments: attachments.map((a) => ({
          attachmentId: a.id,
          name: a.name,
          size: a.size,
          createdUser: a.createdUser?.name ?? null,
          created: a.created ?? null,
        })),
      });
    })
  );

  server.registerTool(
    "backlog_download_attachment",
    {
      title: "Download an attachment of a Backlog issue",
      description:
        "Read-only: download one attachment, by issue ID or key and attachment id " +
        "(from backlog_list_attachments). Text files are returned as text; other files as base64. " +
        "Files over 2MB are not inlined — only their metadata is returned.",
      inputSchema: {
        issueIdOrKey: issueIdOrKeySchema,
        attachmentId: z.number().int().positive(),
      },
    },
    safeHandler(
      async ({ issueIdOrKey, attachmentId }: { issueIdOrKey: string; attachmentId: number }) => {
        const { data, contentType, filename } = await client.downloadRaw(
          `/issues/${encodeURIComponent(issueIdOrKey)}/attachments/${attachmentId}`
        );

        const base = {
          attachmentId,
          name: filename,
          contentType,
          size: data.length,
        };
        if (data.length > MAX_DOWNLOAD_BYTES) {
          return jsonResult({
            ...base,
            content: null,
            note: `File is ${(data.length / 1024 / 1024).toFixed(1)}MB (limit for inline content is 2MB); open it in the Backlog UI instead.`,
          });
        }
        if (contentType && TEXTUAL_TYPES.test(contentType)) {
          return jsonResult({ ...base, encoding: "utf-8", content: data.toString("utf-8") });
        }
        return jsonResult({ ...base, encoding: "base64", content: data.toString("base64") });
      }
    )
  );

  server.registerTool(
    "backlog_delete_attachment",
    {
      title: "Delete an attachment from a Backlog issue (irreversible)",
      description:
        "Write: permanently remove one attachment from an issue, by issue ID or key and attachment id " +
        "(from backlog_list_attachments). This cannot be undone. Only call this after the user " +
        "explicitly approved deleting this file.",
      inputSchema: {
        issueIdOrKey: issueIdOrKeySchema,
        attachmentId: z.number().int().positive(),
      },
    },
    safeHandler(
      async ({ issueIdOrKey, attachmentId }: { issueIdOrKey: string; attachmentId: number }) => {
        const deleted = await client.deleteForm<BacklogAttachment>(
          `/issues/${encodeURIComponent(issueIdOrKey)}/attachments/${attachmentId}`
        );
        return jsonResult({
          deleted: true,
          attachmentId: deleted.id,
          name: deleted.name,
          size: deleted.size,
        });
      }
    )
  );
}
