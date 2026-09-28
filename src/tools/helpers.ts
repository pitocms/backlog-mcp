import { BacklogApiError } from "../backlog/client.js";

export interface ToolResult {
  [key: string]: unknown;
  content: { type: "text"; text: string }[];
  isError?: boolean;
}

export function jsonResult(data: unknown): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

export function errorResult(err: unknown): ToolResult {
  // BacklogApiError messages are already redacted; anything else gets a
  // generic message so no internals (or secrets) can leak into responses.
  const message =
    err instanceof BacklogApiError
      ? err.message
      : "Unexpected server error. Check the server logs for details.";
  if (!(err instanceof BacklogApiError)) {
    console.error("Unexpected error:", err instanceof Error ? err.stack : err);
  }
  return { content: [{ type: "text", text: `Error: ${message}` }], isError: true };
}

/** Wrap a tool handler so every thrown error becomes a safe MCP error result. */
export function safeHandler<A>(fn: (args: A) => Promise<ToolResult>) {
  return async (args: A): Promise<ToolResult> => {
    try {
      return await fn(args);
    } catch (err) {
      return errorResult(err);
    }
  };
}
