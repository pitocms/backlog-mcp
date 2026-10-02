import type { BacklogClient } from "./client.js";
import type { BacklogWiki } from "./types.js";

export async function createWiki(
  client: BacklogClient,
  projectId: number,
  name: string,
  content: string,
  mailNotify?: boolean
): Promise<BacklogWiki> {
  const form = new URLSearchParams();
  form.set("projectId", String(projectId));
  form.set("name", name);
  form.set("content", content);
  if (mailNotify !== undefined) form.set("mailNotify", String(mailNotify));
  return client.postForm<BacklogWiki>("/wikis", form);
}

/** PATCH /api/v2/wikis/:wikiId — only the provided fields are sent. */
export async function updateWiki(
  client: BacklogClient,
  wikiId: number,
  changes: { name?: string; content?: string; mailNotify?: boolean }
): Promise<BacklogWiki> {
  const form = new URLSearchParams();
  if (changes.name !== undefined) form.set("name", changes.name);
  if (changes.content !== undefined) form.set("content", changes.content);
  if (changes.mailNotify !== undefined) form.set("mailNotify", String(changes.mailNotify));
  return client.patchForm<BacklogWiki>(`/wikis/${wikiId}`, form);
}

export async function deleteWiki(
  client: BacklogClient,
  wikiId: number,
  mailNotify?: boolean
): Promise<BacklogWiki> {
  const form = new URLSearchParams();
  if (mailNotify !== undefined) form.set("mailNotify", String(mailNotify));
  return client.deleteForm<BacklogWiki>(`/wikis/${wikiId}`, form);
}

/** Web URL of a wiki page in the Backlog UI (id-based alias, stable across renames). */
export function wikiUrl(baseUrl: string, wikiId: number): string {
  return `${baseUrl}/alias/wiki/${wikiId}`;
}
