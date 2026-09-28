# Backlog MCP Server

A minimal MCP (Model Context Protocol) server that lets an MCP client such as ChatGPT read metadata from a Backlog project and create issues in it — with a validation/dry-run step so nothing is created without explicit approval.

Built with Node.js, TypeScript, the official [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk), and the [Backlog API v2](https://developer.nulab.com/docs/backlog/). Transport is **Streamable HTTP** (the transport remote MCP clients like ChatGPT use), served at `POST /mcp`.

## Intended workflow

```text
Excel task list
   ↓
ChatGPT analyzes tasks
   ↓
backlog_validate_issues   (dry run — nothing is created)
   ↓
You review the preview
   ↓
You explicitly approve
   ↓
backlog_create_issues_batch
   ↓
Issues appear in Backlog
```

The server never creates issues just because task data was received: `backlog_validate_issues` is read-only, and `backlog_create_issues_batch` refuses to run unless `confirmedByUser: true` is passed, which the tool description instructs clients to set only after the user has approved the validation preview.

## 1. Configure .env

```bash
cp .env.example .env   # or: cp env.example .env
```

Then fill in:

| Variable | Description |
|---|---|
| `BACKLOG_BASE_URL` | Your Backlog space URL, e.g. `https://yourspace.backlog.jp` (no trailing slash needed) |
| `BACKLOG_API_KEY` | API key from Backlog: **Personal Settings → API → Register new API key** |
| `BACKLOG_PROJECT_KEY` | The project key, e.g. `MYPROJ` (visible in the project URL and issue keys) |
| `PORT` | Optional, defaults to `3000` |
| `MCP_AUTH_TOKEN` | Optional but **strongly recommended on public URLs**: shared secret (≥16 chars, e.g. `openssl rand -hex 32`) required to call `/mcp` — via `Authorization: Bearer <token>` or the URL `/mcp/<token>` |

`.env` is git-ignored. The API key is never printed in logs, error messages, or MCP responses.

## 2. Run with Docker

```bash
docker compose up --build
```

The container exposes:

- `POST /mcp` — the MCP endpoint (Streamable HTTP)
- `GET /health` — health check (also used by Docker's `HEALTHCHECK`)

Check health:

```bash
curl http://localhost:3000/health
# {"status":"ok"}

docker compose ps   # STATUS should show "healthy" after ~10s
```

To run without Docker: `npm install && npm run build && npm start`.

## 2b. Deploy to Vercel (alternative to Docker)

Vercel's zero-config [Express preset](https://vercel.com/docs/frameworks/backend/express) detects [src/app.ts](src/app.ts) (which default-exports the Express app) and runs the whole app as a single Vercel Function on Fluid compute — `/mcp` and `/health` work unchanged, no rewrites needed. The MCP endpoint runs in stateless mode with buffered JSON responses, which fits serverless.

```bash
npm i -g vercel
vercel link                      # create/link the Vercel project
vercel env add BACKLOG_BASE_URL
vercel env add BACKLOG_API_KEY   # stored as a Vercel env var, never uploaded from .env
vercel env add BACKLOG_PROJECT_KEY
vercel env add MCP_AUTH_TOKEN     # strongly recommended: openssl rand -hex 32
vercel deploy --prod
```

Then check `https://<your-deployment>.vercel.app/health` and point your MCP client at `https://<your-deployment>.vercel.app/mcp`.

Notes:

- `.vercelignore` excludes `.env`, so the API key only reaches Vercel through `vercel env add`.
- Fluid compute's default max duration is 300s. Large batches wait 1s between writes, so keep batch sizes such that they finish within your plan's limit (~200 issues at 300s).
- A Vercel URL is public, so set `MCP_AUTH_TOKEN` (see **Authentication** below) before real use.

## 2c. Authentication

The server protects `/mcp` with a shared secret token. Without it, **anyone who can reach the URL can read and write your Backlog project** with your API key's permissions — fine on `localhost`, not fine on a public URL.

**Enable it** by setting `MCP_AUTH_TOKEN` (≥16 characters):

```bash
openssl rand -hex 32                # generate a token

# Docker: add MCP_AUTH_TOKEN=<token> to .env, then
docker compose up -d

# Vercel:
vercel env add MCP_AUTH_TOKEN
vercel deploy --prod
```

When the token is set, every request to `/mcp` must carry it in one of two ways; anything else gets `401 Unauthorized` (the comparison is timing-safe, and the token never appears in logs or error messages):

| Client | How to authenticate |
|---|---|
| Clients with custom-header support, e.g. Claude Code (**preferred** — keeps the token out of URLs and logs) | `Authorization: Bearer <token>` header:<br>`claude mcp add --transport http backlog https://<host>/mcp --header "Authorization: Bearer <token>"` |
| Clients without custom-header support, e.g. ChatGPT connectors | Token in the URL path: use `https://<host>/mcp/<token>` as the connector URL |

Notes:

- **ChatGPT's connector form asks for an "Authentication" method — choose "No authentication".** That setting only controls OAuth, which this server does not use; the token in the connector URL is what authenticates the requests. The full URL is then the secret: don't share or screenshot it.
- `GET /health` stays unauthenticated on purpose — it reveals nothing and is used by health checks.
- **Rotate** the token by changing `MCP_AUTH_TOKEN` and redeploying/restarting; old tokens and URLs stop working immediately. Rotate right away if a token-in-path URL may have leaked.
- If `MCP_AUTH_TOKEN` is unset, the server runs **open** and logs a startup warning. There is no way to require auth per-client: it is all (token set) or nothing.
- Scope of this scheme: it is a single shared secret, not per-user auth or OAuth. For a single-user or small-team internal tool this is the standard trade-off; if you need per-user identity or consent screens, put a real OAuth layer in front.

## 3. Test Backlog connectivity

The quickest end-to-end check is calling a read-only tool through the MCP endpoint (see next section), but you can also test your credentials directly against Backlog:

```bash
source .env
curl "${BACKLOG_BASE_URL}/api/v2/projects/${BACKLOG_PROJECT_KEY}?apiKey=${BACKLOG_API_KEY}"
```

A JSON object with your project's `id` and `name` means the URL, key, and project key are all correct. A `401` means the API key is wrong; a `404` means the project key is wrong.

## 4. Test MCP tools with curl

MCP over Streamable HTTP is JSON-RPC. List the tools (if `MCP_AUTH_TOKEN` is set, add `-H "Authorization: Bearer <token>"` to each request):

```bash
curl -s http://localhost:3000/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
```

Call a read-only tool (verifies Backlog connectivity through the server):

```bash
curl -s http://localhost:3000/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"backlog_get_project","arguments":{}}}'
```

You can also use the MCP Inspector for an interactive UI:

```bash
npx @modelcontextprotocol/inspector
# Transport: "Streamable HTTP", URL: http://localhost:3000/mcp
```

## 5. Connect an MCP client

The server must be reachable by the client. For ChatGPT (a cloud service), `localhost` is not reachable — you need a public HTTPS URL. Options:

- Deploy the container to a host with HTTPS (recommended for real use), or
- Tunnel your local server for testing, e.g. `ngrok http 3000` or `cloudflared tunnel --url http://localhost:3000`.

Then in ChatGPT: **Settings → Connectors → Add custom connector (MCP)** and enter `https://<your-host>/mcp/<token>`, choosing **"No authentication"** in the form (see [Authentication](#2c-authentication)).

> ⚠️ On any public URL, set `MCP_AUTH_TOKEN` first — see [Authentication](#2c-authentication). Without it, anyone who can reach the URL can use your Backlog API key's permissions.

For MCP clients that support local servers (Claude Code, Claude Desktop, etc.) you can point them at `http://localhost:3000/mcp` directly. Example for Claude Code:

```bash
claude mcp add --transport http backlog http://localhost:3000/mcp
```

## 6. Create ONE test issue

First fetch valid IDs, then validate, then create:

1. Call `backlog_get_issue_types` and `backlog_get_priorities` to get a valid `issueTypeId` and `priorityId`.
2. Call `backlog_validate_issues` with your issue and review the preview.
3. Call `backlog_create_issue`:

```bash
curl -s http://localhost:3000/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"backlog_create_issue","arguments":{"summary":"MCP connectivity test","description":"Created via backlog-mcp. Safe to delete.","issueTypeId":<ID>,"priorityId":<ID>}}}'
```

The response contains the created `issueKey` and a direct `url` to the issue.

## 7. How batch creation works

`backlog_create_issues_batch` takes `{ issues: [...], confirmedByUser: true }` and:

1. **Refuses** to do anything unless `confirmedByUser` is `true` (set only after you approved the validation preview).
2. Creates issues **sequentially**, waiting 1 second between requests, per Backlog's rate-limit guidance.
3. On HTTP 429 it waits until the `X-RateLimit-Reset` time and retries (up to 3 times per request).
4. **One failure does not stop the batch** — every issue gets its own result entry.
5. Returns, per issue: `success`, and either `issueId` + `issueKey` + `url`, or a safe `error` message.

## MCP tools

| Tool | Effect |
|---|---|
| `backlog_get_project` | Read — configured project info |
| `backlog_get_users` | Read — project members (id, name, email) |
| `backlog_get_issue_types` | Read — issue types + IDs |
| `backlog_get_priorities` | Read — priorities + IDs |
| `backlog_get_categories` | Read — project categories |
| `backlog_get_statuses` | Read — project issue statuses (Open, In Progress, Resolved, …) + IDs |
| `backlog_get_milestones` | Read — project milestones/versions |
| `backlog_list_issues` | Read — list/search issues, filterable by status name or id, assignee, keyword; paged |
| `backlog_get_issue` | Read — full details of one issue by ID or key, including description |
| `backlog_validate_issues` | Read — dry-run validation + preview, creates nothing |
| `backlog_create_issue` | **Write** — creates one issue |
| `backlog_create_issues_batch` | **Write** — creates many issues sequentially, requires `confirmedByUser: true` |
| `backlog_update_issue` | **Write** — updates one existing issue by ID or key (e.g. `LMSDEV-80`) |
| `backlog_update_issues_batch` | **Write** — updates many issues sequentially, requires `confirmedByUser: true` |
| `backlog_add_milestone` | **Write** — creates a milestone/version (name, description, start/release dates) |
| `backlog_update_milestone` | **Write** — renames/updates/archives an existing milestone by id |
| `backlog_add_category` | **Write** — creates a category |
| `backlog_update_category` | **Write** — renames an existing category by id |
| `backlog_add_issue_type` | **Write** — creates an issue type (name + one of Backlog's fixed colors) |
| `backlog_update_issue_type` | **Write** — renames/recolors an existing issue type by id |

## Project structure

```text
src/
├── index.ts          # Standalone entrypoint (Docker / npm start)
├── app.ts            # Express app, MCP transport, auth middleware, health check; default export = Vercel entrypoint
├── config.ts         # Environment validation (Zod)
├── backlog/
│   ├── client.ts     # Backlog API v2 client: auth, errors, rate limits, key redaction
│   ├── types.ts      # Backlog response types
│   └── issues.ts     # Issue creation payload building
└── tools/
    ├── project.ts    # backlog_get_project
    ├── users.ts      # backlog_get_users
    ├── metadata.ts   # get + add: issue types / priorities / categories / milestones / statuses
    ├── issues.ts     # list / validate / create / update, single + batch
    └── helpers.ts    # safe result + error formatting
```
