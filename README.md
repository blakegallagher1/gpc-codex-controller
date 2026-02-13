# gpc-codex-controller

Production-grade controller for [Codex](https://github.com/openai/codex) app-server sessions. It provisions infrastructure, manages task workspaces, runs verification and corrective fix loops, and opens pull requests — all driven through a JSON-RPC endpoint that ChatGPT can call as an MCP tool.

## Prerequisites

- **Node.js** ≥ 22
- **npm** (bundled with Node.js)
- [Codex CLI](https://github.com/openai/codex) installed globally (`npm install -g @openai/codex`)
- A **ChatGPT** account (Plus, Team, or Enterprise) with MCP / tool-use access
- (For production) Terraform ≥ 1.6, a Hetzner Cloud account, and a Cloudflare account

## Quick Start (Local)

```bash
# Clone and build
git clone https://github.com/blakegallagher1/gpc-codex-controller.git
cd gpc-codex-controller
npm ci
npm run build

# Start the MCP server locally
npm start -- serve
```

The server listens on `127.0.0.1:8787` by default. You can override the bind address and port with `MCP_BIND` and `MCP_PORT` environment variables.

For local testing on machines without `/workspaces`, you can override workspace location with either:

```bash
# Env override
WORKSPACES_ROOT=/tmp/gpc-workspaces npm start -- serve
```

or:

```bash
# CLI override
npm start -- serve --workspacesRoot /tmp/gpc-workspaces
```

## Connecting Your ChatGPT Account to the Server

### Step 1 — Authenticate the Codex CLI with ChatGPT

Before the controller can interact with ChatGPT on your behalf, the Codex CLI must be logged in. Run:

```bash
codex login --chatgpt
```

This opens a browser window where you sign in with your ChatGPT credentials. After successful authentication, tokens are persisted in `~/.codex` (or wherever `CODEX_HOME` points).

> **Tip:** To use a custom auth directory, set the `CODEX_HOME` environment variable before running the login command:
> ```bash
> export CODEX_HOME=/path/to/custom/.codex
> codex login --chatgpt
> ```

### Step 2 — Verify Authentication

Confirm that auth files were created:

```bash
ls -la "${CODEX_HOME:-$HOME/.codex}"
```

You should see credential files in this directory.

### Step 3 — Start the Controller Server

```bash
# Local development (binds to localhost only)
npm start -- serve

# Or with custom port and bearer-token auth
MCP_PORT=9090 MCP_BEARER_TOKEN="my-secret-token" npm start -- serve

# Production: set MCP_BASE_URL to your public URL (e.g. via Cloudflare Tunnel)
MCP_BASE_URL="https://mcp.example.com" MCP_BEARER_TOKEN="my-secret-token" npm start -- serve
```

The server exposes two routes:

| Route | Method | Purpose |
|-------|--------|---------|
| `/healthz` | GET | Health check — returns `{"ok": true}` |
| `/rpc` | POST | JSON-RPC 2.0 endpoint for MCP calls |

### Step 4 — Configure ChatGPT to Use Your MCP Endpoint

1. In ChatGPT, navigate to **Settings → MCP / Tools** (the exact path may vary by client).
2. Add a new MCP server with the URL of your controller endpoint:
   - **Local:** `http://localhost:8787/rpc`
   - **Production (via Cloudflare Tunnel):** `https://<subdomain>.<domain>/rpc`
3. If you set `MCP_BEARER_TOKEN`, configure the same token in ChatGPT as the bearer authentication credential.
4. Test the connection by sending a basic prompt through ChatGPT that triggers an MCP tool call.

### Available RPC Methods

| Method | Description |
|--------|-------------|
| `health/ping` | Returns `{"ok": true, "ts": "..."}` |
| `task/start` | Start a new Codex task (`params.prompt`) |
| `task/continue` | Continue an existing thread (`params.threadId`, `params.prompt`) |
| `verify/run` | Run verification on a task workspace (`params.taskId`) |
| `fix/untilGreen` | Iteratively fix until verification passes (`params.taskId`, `params.maxIterations`) |
| `pr/create` | Create a pull request from task output (`params.taskId`, `params.title`, `params.body`) |
| `job/get` | Poll status of a long-running job (`params.jobId`) |

## Production Deployment

For a production setup with Cloudflare Tunnel providing secure public access, see the [infrastructure README](infrastructure/README.md).

The high-level flow is:

1. **Provision infrastructure** using Terraform (`make init && make plan && make apply` in the `infrastructure/` directory).
2. **SSH into the VM** and complete the ChatGPT login:
   ```bash
   ssh controller@<vm-ip>
   sudo -u controller CODEX_HOME=/home/controller/.codex codex login --chatgpt
   ```
3. **Verify** the controller service is running:
   ```bash
   sudo systemctl status gpc-codex-controller
   ```
4. **Point ChatGPT** at your public endpoint: `https://<subdomain>.<domain>/rpc`

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `MCP_BIND` | `127.0.0.1` | Bind address for the HTTP server |
| `MCP_PORT` | `8787` | Port for the HTTP server (also reads `CONTROLLER_PORT`) |
| `MCP_BASE_URL` | *(none)* | Public base URL for the MCP endpoint (e.g. `https://mcp.example.com`). Use when running behind a reverse proxy or tunnel. |
| `MCP_BEARER_TOKEN` | *(none)* | Optional bearer token for authenticating inbound requests |
| `CODEX_HOME` | `~/.codex` | Directory where Codex persists auth state |
| `WORKSPACES_ROOT` | `/workspaces` | Root directory for per-task workspaces (cloned `gpc-cres` repos) |
| `GPC_WORKSPACES_ROOT` | *(none)* | Alternate env var for workspace root (same behavior as `WORKSPACES_ROOT`) |
| `GITHUB_TOKEN` | *(none)* | GitHub token used for PR automation |

## CLI Commands

```text
npm start -- <command> [options]
```

| Command | Description |
|---------|-------------|
| `serve` | Start the MCP JSON-RPC server |
| `start --prompt "..."` | Start a new task |
| `continue --threadId <id> --prompt "..."` | Continue a task thread |
| `verify --taskId <id>` | Run verification |
| `fix --taskId <id> [--maxIterations N]` | Fix until green (default 5 iterations) |
| `pr --taskId <id> --title "..." [--body "..."]` | Create a pull request |

## Troubleshooting

- **`codex login --chatgpt` fails or times out:** Ensure your browser can reach `https://auth.openai.com` and that you have a valid ChatGPT subscription.
- **Controller won't start:** Check that Node.js ≥ 22 is installed (`node -v`) and that you have run `npm ci && npm run build`.
- **ChatGPT can't reach the endpoint:** Verify the URL in ChatGPT settings matches your server address. For production, confirm the Cloudflare Tunnel is active (`sudo systemctl status cloudflared`).
- **401 Unauthorized from `/rpc`:** Ensure the `MCP_BEARER_TOKEN` in your server environment matches the token configured in ChatGPT.
- **Auth tokens expire:** Re-run `codex login --chatgpt` on the server to refresh credentials.

## License

See repository for license details.
