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
vercel deploy --prod
```

Then check `https://<your-deployment>.vercel.app/health` and point your MCP client at `https://<your-deployment>.vercel.app/mcp`.

Notes:

- `.vercelignore` excludes `.env`, so the API key only reaches Vercel through `vercel env add`.
- Fluid compute's default max duration is 300s. Large batches wait 1s between writes, so keep batch sizes such that they finish within your plan's limit (~200 issues at 300s).
- The warning below about authentication applies doubly here: a Vercel URL is public. Keep the URL secret or put the function behind auth before real use.

## 3. Test Backlog connectivity

The quickest end-to-end check is calling a read-only tool through the MCP endpoint (see next section), but you can also test your credentials directly against Backlog:

```bash
source .env
curl "${BACKLOG_BASE_URL}/api/v2/projects/${BACKLOG_PROJECT_KEY}?apiKey=${BACKLOG_API_KEY}"
```

A JSON object with your project's `id` and `name` means the URL, key, and project key are all correct. A `401` means the API key is wrong; a `404` means the project key is wrong.

## 4. Test MCP tools with curl

MCP over Streamable HTTP is JSON-RPC. List the tools:

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

Then in ChatGPT: **Settings → Connectors → Add custom connector (MCP)** and enter `https://<your-host>/mcp`.

> ⚠️ This server has no authentication layer of its own — anyone who can reach the URL can use your Backlog API key's permissions. Only expose it through a tunnel you control while testing, and shut the tunnel down afterwards. For anything long-lived, put it behind authentication.

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
| `backlog_validate_issues` | Read — dry-run validation + preview, creates nothing |
| `backlog_create_issue` | **Write** — creates one issue |
| `backlog_create_issues_batch` | **Write** — creates many issues sequentially, requires `confirmedByUser: true` |
| `backlog_update_issue` | **Write** — updates one existing issue by ID or key (e.g. `LMSDEV-80`) |
| `backlog_update_issues_batch` | **Write** — updates many issues sequentially, requires `confirmedByUser: true` |

## Project structure

```text
src/
├── index.ts          # Standalone entrypoint (Docker / npm start)
├── app.ts            # Express app, MCP transport, health check; default export = Vercel entrypoint
├── config.ts         # Environment validation (Zod)
├── backlog/
│   ├── client.ts     # Backlog API v2 client: auth, errors, rate limits, key redaction
│   ├── types.ts      # Backlog response types
│   └── issues.ts     # Issue creation payload building
└── tools/
    ├── project.ts    # backlog_get_project
    ├── users.ts      # backlog_get_users
    ├── metadata.ts   # issue types / priorities / categories / milestones
    ├── issues.ts     # validate / create / batch create
    └── helpers.ts    # safe result + error formatting
```
