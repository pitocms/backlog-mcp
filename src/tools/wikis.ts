import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { BacklogApiError, type BacklogClient } from "../backlog/client.js";
import { createWiki, deleteWiki, updateWiki, wikiUrl } from "../backlog/wikis.js";
import type { BacklogWiki } from "../backlog/types.js";
import { errorResult, jsonResult, safeHandler } from "./helpers.js";

const projectIdOrKeySchema = z
  .string()
  .min(1)
  .optional()
  .describe(
    "Project key or id whose wiki to use, e.g. XIBO (from a wiki URL /wiki/XIBO/<page>). " +
      "Defaults to the configured project."
  );

const wikiIdSchema = z
  .number()
  .int()
  .positive()
  .describe("Wiki page id (from backlog_list_wikis or backlog_get_wiki).");

const contentSchema = z.string().max(200_000);

function wikiSummary(baseUrl: string, wiki: BacklogWiki) {
  return {
    wikiId: wiki.id,
    name: wiki.name,
    tags: (wiki.tags ?? []).map((t) => t.name),
    createdBy: wiki.createdUser?.name ?? null,
    createdAt: wiki.created,
    updatedBy: wiki.updatedUser?.name ?? null,
    updatedAt: wiki.updated,
    url: wikiUrl(baseUrl, wiki.id),
  };
}

function wikiDetail(baseUrl: string, wiki: BacklogWiki) {
  return {
    ...wikiSummary(baseUrl, wiki),
    projectId: wiki.projectId,
    content: wiki.content ?? null,
    attachments: (wiki.attachments ?? []).map((a) => ({ id: a.id, name: a.name, size: a.size })),
  };
}

export function registerWikiTools(
  server: McpServer,
  client: BacklogClient,
  baseUrl: string
): void {
  /** Resolve a page by exact name; Backlog has no get-by-name endpoint. */
  async function findWikiByName(projectIdOrKey: string, name: string): Promise<BacklogWiki> {
    const pages = await client.getWikis(projectIdOrKey, name);
    const match = pages.find((p) => p.name === name);
    if (!match) {
      throw new BacklogApiError(
        `No wiki page named "${name}" in project ${projectIdOrKey} (use backlog_list_wikis).`,
        404
      );
    }
    return match;
  }

  server.registerTool(
    "backlog_list_wikis",
    {
      title: "List Backlog wiki pages",
      description:
        "Read-only: list the wiki pages of a project (names, ids, tags, last update; no content). " +
        "keyword filters by page name and content. Use backlog_get_wiki to read a page.",
      inputSchema: {
        projectIdOrKey: projectIdOrKeySchema,
        keyword: z.string().min(1).optional(),
      },
    },
    safeHandler(async (args: { projectIdOrKey?: string; keyword?: string }) => {
      const project = args.projectIdOrKey ?? client.projectKey;
      const pages = await client.getWikis(project, args.keyword);
      return jsonResult({
        project,
        returned: pages.length,
        wikis: pages.map((p) => wikiSummary(baseUrl, p)),
      });
    })
  );

  server.registerTool(
    "backlog_get_wiki",
    {
      title: "Read a Backlog wiki page",
      description:
        "Read-only: return one wiki page including its full content, by wikiId or by exact page name " +
        "(e.g. https://<space>.backlog.jp/wiki/XIBO/Home → projectIdOrKey XIBO, name Home).",
      inputSchema: {
        wikiId: wikiIdSchema.optional(),
        name: z.string().min(1).optional().describe("Exact page name; used when wikiId is not given."),
        projectIdOrKey: projectIdOrKeySchema,
      },
    },
    safeHandler(async (args: { wikiId?: number; name?: string; projectIdOrKey?: string }) => {
      if (args.wikiId === undefined && args.name === undefined) {
        return errorResult(new BacklogApiError("Pass either wikiId or name."));
      }
      const wikiId =
        args.wikiId ??
        (await findWikiByName(args.projectIdOrKey ?? client.projectKey, args.name!)).id;
      const wiki = await client.getWiki(wikiId);
      return jsonResult(wikiDetail(baseUrl, wiki));
    })
  );

  server.registerTool(
    "backlog_create_wiki",
    {
      title: "Create a Backlog wiki page",
      description:
        "Write: add a new wiki page to a project. The name may contain '/' to nest it under a parent " +
        "page (e.g. 'Setup/Xibo Docker'). Content uses the project's text formatting rule " +
        "(markdown or backlog; see backlog_get_project). Only call this after the user approved the page.",
      inputSchema: {
        projectIdOrKey: projectIdOrKeySchema,
        name: z.string().min(1, "name is required").max(255),
        content: contentSchema.min(1, "content is required"),
        mailNotify: z
          .boolean()
          .optional()
          .describe("Email project members about the new page (default false)."),
      },
    },
    safeHandler(
      async (args: {
        projectIdOrKey?: string;
        name: string;
        content: string;
        mailNotify?: boolean;
      }) => {
        const project = await client.getProjectByIdOrKey(args.projectIdOrKey ?? client.projectKey);
        const created = await createWiki(client, project.id, args.name, args.content, args.mailNotify);
        return jsonResult({
          created: true,
          projectKey: project.projectKey,
          ...wikiSummary(baseUrl, created),
        });
      }
    )
  );

  server.registerTool(
    "backlog_update_wiki",
    {
      title: "Edit a Backlog wiki page",
      description:
        "Write: rename a wiki page and/or replace its content, by wikiId (from backlog_list_wikis / " +
        "backlog_get_wiki). content replaces the whole page, so read the page first and send the full " +
        "edited text. Only call this after the user approved the change.",
      inputSchema: {
        wikiId: wikiIdSchema,
        name: z.string().min(1).max(255).optional().describe("New page name."),
        content: contentSchema.optional().describe("The full replacement content."),
        mailNotify: z
          .boolean()
          .optional()
          .describe("Email project members about the change (default false)."),
      },
    },
    safeHandler(
      async (args: { wikiId: number; name?: string; content?: string; mailNotify?: boolean }) => {
        if (args.name === undefined && args.content === undefined) {
          return errorResult(new BacklogApiError("Nothing to update: pass name and/or content."));
        }
        const updated = await updateWiki(client, args.wikiId, args);
        return jsonResult({ updated: true, ...wikiSummary(baseUrl, updated) });
      }
    )
  );

  server.registerTool(
    "backlog_delete_wiki",
    {
      title: "Delete a Backlog wiki page (irreversible)",
      description:
        "Write: permanently delete a wiki page by wikiId. This cannot be undone. Show the user the page " +
        "(backlog_get_wiki) and set confirmedByUser to true only after they explicitly approved deleting it.",
      inputSchema: {
        wikiId: wikiIdSchema,
        confirmedByUser: z
          .boolean()
          .describe("Must be true, and only after the user explicitly approved deleting this page."),
        mailNotify: z.boolean().optional(),
      },
    },
    safeHandler(
      async (args: { wikiId: number; confirmedByUser: boolean; mailNotify?: boolean }) => {
        if (!args.confirmedByUser) {
          return errorResult(
            new BacklogApiError(
              "Refused: confirmedByUser is not true. Show the user the page and only retry after they explicitly approve deleting it."
            )
          );
        }
        const deleted = await deleteWiki(client, args.wikiId, args.mailNotify);
        return jsonResult({ deleted: true, wikiId: deleted.id, name: deleted.name });
      }
    )
  );
}
