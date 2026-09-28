import type {
  BacklogCategory,
  BacklogIssue,
  BacklogIssueType,
  BacklogPriority,
  BacklogProject,
  BacklogStatus,
  BacklogUser,
  BacklogVersion,
} from "./types.js";

/** Query params for GET endpoints; array values become repeated `name` params. */
export type QueryParams = Record<string, string | string[]>;

/** Error safe to surface to MCP clients: never contains the API key. */
export class BacklogApiError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
    public readonly backlogCode?: number
  ) {
    super(message);
    this.name = "BacklogApiError";
  }
}

interface BacklogErrorBody {
  errors?: { message?: string; code?: number; moreInfo?: string }[];
}

const MAX_RETRIES = 3;
const MAX_RATE_LIMIT_WAIT_MS = 65_000;

export class BacklogClient {
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
    public readonly projectKey: string
  ) {}

  /** Strip the API key from any text before it can reach logs or responses. */
  private redact(text: string): string {
    return text.split(this.apiKey).join("[REDACTED]");
  }

  private buildUrl(path: string, query?: QueryParams): URL {
    const url = new URL(`${this.baseUrl}/api/v2${path}`);
    url.searchParams.set("apiKey", this.apiKey);
    for (const [k, v] of Object.entries(query ?? {})) {
      if (Array.isArray(v)) {
        for (const item of v) url.searchParams.append(k, item);
      } else {
        url.searchParams.set(k, v);
      }
    }
    return url;
  }

  private async request<T>(
    method: "GET" | "POST" | "PATCH",
    path: string,
    options: { query?: QueryParams; form?: URLSearchParams } = {}
  ): Promise<T> {
    const url = this.buildUrl(path, options.query);

    for (let attempt = 0; ; attempt++) {
      let response: Response;
      try {
        response = await fetch(url, {
          method,
          headers: options.form
            ? { "Content-Type": "application/x-www-form-urlencoded" }
            : undefined,
          body: options.form?.toString(),
        });
      } catch (err) {
        const detail = err instanceof Error ? this.redact(err.message) : "unknown error";
        throw new BacklogApiError(
          `Network error while contacting Backlog (${detail}). Check BACKLOG_BASE_URL and your network connection.`
        );
      }

      if (response.status === 429) {
        if (attempt >= MAX_RETRIES) {
          throw new BacklogApiError(
            "Backlog API rate limit exceeded and retries exhausted. Wait a minute and try again.",
            429
          );
        }
        await this.waitForRateLimit(response);
        continue;
      }

      if (!response.ok) {
        throw await this.toApiError(response, path);
      }

      if (response.status === 204) {
        return undefined as T;
      }
      return (await response.json()) as T;
    }
  }

  private async waitForRateLimit(response: Response): Promise<void> {
    // X-RateLimit-Reset is UTC epoch seconds when the window resets.
    const reset = Number(response.headers.get("X-RateLimit-Reset"));
    let waitMs = 5_000;
    if (Number.isFinite(reset) && reset > 0) {
      waitMs = Math.max(1_000, reset * 1000 - Date.now() + 1_000);
    }
    waitMs = Math.min(waitMs, MAX_RATE_LIMIT_WAIT_MS);
    console.warn(`Backlog rate limit hit; waiting ${Math.round(waitMs / 1000)}s before retry`);
    await new Promise((resolve) => setTimeout(resolve, waitMs));
  }

  private async toApiError(response: Response, path: string): Promise<BacklogApiError> {
    let backlogMessage = "";
    let backlogCode: number | undefined;
    try {
      const body = (await response.json()) as BacklogErrorBody;
      const first = body.errors?.[0];
      if (first?.message) {
        backlogMessage = this.redact(first.message);
        backlogCode = first.code;
      }
    } catch {
      // Non-JSON error body; fall through to status-based message.
    }

    const detail = backlogMessage ? ` Backlog says: ${backlogMessage}` : "";
    switch (response.status) {
      case 401:
        return new BacklogApiError(
          `Authentication failed (401). BACKLOG_API_KEY is invalid or expired.${detail}`,
          401,
          backlogCode
        );
      case 403:
        return new BacklogApiError(
          `Access denied (403). The API key's user lacks permission for this operation.${detail}`,
          403,
          backlogCode
        );
      case 404:
        return new BacklogApiError(
          `Not found (404) for ${path}. Check BACKLOG_PROJECT_KEY and that the resource exists.${detail}`,
          404,
          backlogCode
        );
      default:
        return new BacklogApiError(
          `Backlog API error (HTTP ${response.status}) for ${path}.${detail}`,
          response.status,
          backlogCode
        );
    }
  }

  // ---- Read endpoints ----

  getProject(): Promise<BacklogProject> {
    return this.request("GET", `/projects/${encodeURIComponent(this.projectKey)}`);
  }

  getProjectUsers(): Promise<BacklogUser[]> {
    return this.request("GET", `/projects/${encodeURIComponent(this.projectKey)}/users`);
  }

  getIssueTypes(): Promise<BacklogIssueType[]> {
    return this.request("GET", `/projects/${encodeURIComponent(this.projectKey)}/issueTypes`);
  }

  getPriorities(): Promise<BacklogPriority[]> {
    return this.request("GET", "/priorities");
  }

  getCategories(): Promise<BacklogCategory[]> {
    return this.request("GET", `/projects/${encodeURIComponent(this.projectKey)}/categories`);
  }

  getMilestones(): Promise<BacklogVersion[]> {
    return this.request("GET", `/projects/${encodeURIComponent(this.projectKey)}/versions`);
  }

  getStatuses(): Promise<BacklogStatus[]> {
    return this.request("GET", `/projects/${encodeURIComponent(this.projectKey)}/statuses`);
  }

  getIssue<T>(issueIdOrKey: string | number): Promise<T> {
    return this.request("GET", `/issues/${encodeURIComponent(String(issueIdOrKey))}`);
  }

  getIssues(query: QueryParams): Promise<BacklogIssue[]> {
    return this.request("GET", "/issues", { query });
  }

  countIssues(query: QueryParams): Promise<{ count: number }> {
    return this.request("GET", "/issues/count", { query });
  }

  postForm<T>(path: string, form: URLSearchParams): Promise<T> {
    return this.request("POST", path, { form });
  }

  patchForm<T>(path: string, form: URLSearchParams): Promise<T> {
    return this.request("PATCH", path, { form });
  }
}
