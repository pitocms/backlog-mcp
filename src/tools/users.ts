import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { BacklogApiError, type BacklogClient } from "../backlog/client.js";
import type { BacklogUser } from "../backlog/types.js";
import { errorResult, jsonResult, safeHandler } from "./helpers.js";

export function registerUserTools(server: McpServer, client: BacklogClient): void {
  server.registerTool(
    "backlog_get_users",
    {
      title: "Get project users",
      description:
        "Return users who belong to the configured Backlog project. Use these ids as assigneeId when creating issues.",
      inputSchema: {},
    },
    safeHandler(async () => {
      const users = await client.getProjectUsers();
      return jsonResult(
        users.map((u) => ({
          id: u.id,
          name: u.name,
          email: u.mailAddress ?? null,
        }))
      );
    })
  );

  const projectPath = `/projects/${encodeURIComponent(client.projectKey)}`;

  server.registerTool(
    "backlog_add_project_user",
    {
      title: "Add a user to the project",
      description:
        "Write: add an existing space member to the configured project, by their numeric user id " +
        "(from GET space users; project members are listed by backlog_get_users). The API key's user " +
        "needs project admin rights. Only call this after the user explicitly approved adding them.",
      inputSchema: {
        userId: z.number().int().positive().describe("Numeric id of the space member to add."),
      },
    },
    safeHandler(async ({ userId }: { userId: number }) => {
      const form = new URLSearchParams();
      form.set("userId", String(userId));
      const added = await client.postForm<BacklogUser>(`${projectPath}/users`, form);
      return jsonResult({
        added: true,
        id: added.id,
        name: added.name,
        email: added.mailAddress ?? null,
      });
    })
  );

  server.registerTool(
    "backlog_remove_project_user",
    {
      title: "Remove a user from the project",
      description:
        "Write: remove a member from the configured project, by their numeric user id " +
        "(from backlog_get_users). Their issues and comments remain; they just lose project access. " +
        "The API key's user needs project admin rights. Only call this after the user explicitly " +
        "approved removing them.",
      inputSchema: {
        userId: z.number().int().positive().describe("Numeric id of the project member to remove."),
      },
    },
    safeHandler(async ({ userId }: { userId: number }) => {
      const members = await client.getProjectUsers();
      const current = members.find((u) => u.id === userId);
      if (!current) {
        return errorResult(
          new BacklogApiError(
            `userId ${userId} is not a member of this project (use backlog_get_users)`
          )
        );
      }
      const form = new URLSearchParams();
      form.set("userId", String(userId));
      const removed = await client.deleteForm<BacklogUser>(`${projectPath}/users`, form);
      return jsonResult({
        removed: true,
        id: removed.id,
        name: removed.name,
        email: removed.mailAddress ?? null,
      });
    })
  );
}
