# Agents in gpc-codex-controller

This document describes the **agents** supported by this repository, their purpose, how they behave,
and how to extend or invoke them. An *agent* in this context is a Codex/App-Server thread that performs
a specific workflow on infrastructure or controller tasks.

---

## 📌 Overview

gpc-codex-controller uses a programmatic agent architecture to:

- provision infrastructure
- manage task workspaces
- run verification and corrective fix loops
- produce branches and pull requests
- interact with CI/CD and remote systems (e.g., cloud provider APIs, GitHub)

Agents typically run within a persistent Codex App Server thread with a defined set of instructions
and constraints.

---

## 🧠 Agent Types

### 1) **Infrastructure Provisioner Agent**

**Purpose:**
Automates provisioning of cloud infrastructure for the `gpc-codex-controller` service.

**Typical actions:**
- Generate Terraform configurations
- Apply infrastructure plans
- Create VPS instances (e.g., Hetzner Cloud)
- Configure networking and firewalls
- Persist auth state directories

**Invoked via:**
A controller API like `startTask()` with a prompt describing the target infrastructure environment.

**Input expectations:**
- Desired cloud provider
- VM sizing
- Target domain/subdomain for MCP endpoint
- API tokens (provider)

**Output expectations:**
- Terraform code and templates
- Deployment instructions
- Smoke-test results

---

### 2) **Cloudflare Tunnel Agent**

**Purpose:**
Automates the setup of Cloudflare Tunnel resources and DNS routing so that the
controller MCP endpoint is reachable securely from ChatGPT.

**Typical actions:**
- Write Cloudflare Terraform code
- Generate DNS entries
- Optionally configure Zero Trust Access policies

**Invoked via:**
A specialized infrastructure workflow prompt targeting Cloudflare.

---

### 3) **Controller Deployment Agent**

**Purpose:**
Deploys and configures the controller application on a provisioned machine
(e.g., Hetzner Cloud VM), including:

- Installing prerequisites (Node 22, pnpm)
- Installing `codex`
- Configuring systemd services
- Creating workspace directories

**Success criteria:**
- Controller service starts
- `codex app-server` is reachable
- ChatGPT auth tokens are persisted

---

### 4) **Mutation Loop Agent**

**Purpose:**
Performs end-to-end mutation workflows on the `gpc-cres` codebase, including:

- Cloning the target repo into a workspace
- Running `pnpm verify`
- Fixing failed verifications
- Committing staged changes
- Opening pull requests

**Constraints:**
- Only writing inside workspace paths
- Must follow defined project conventions and guardrails
- Must preserve repo structure

**Invoked via:**
Controller API like `fixUntilGreen()` or `startTask()` with a detailed mutation prompt.

---

### 5) **PR Automation Agent**

**Purpose:**
Given a workspace and branch context, this agent:

- Pushes the branch to origin
- Creates a pull request against `main`
- Provides PR URL as output

**Invoked via:**
Controller wrapper `createPullRequest()` or explicit task invocation.

---

## 🎯 Agent Conventions

### Naming

- Agents should be named clearly with a prefix matching their domain:
- `infra/*`
- `cloudflare/*`
- `controller/*`
- `mutation/*`
- `pr/*`

### Prompt Structure

All agent prompts must include:
- Task context
- Constraints/guardrails
- Expected labels for outputs
- Failure handling instructions

Example mutation intro (highly recommended):

```text
You are operating in mutation mode on a pnpm workspaces monorepo.
Follow strict guardrails:

1. Apply minimal changes.
2. Do not modify root configs unless necessary.
3. Always run `pnpm verify` after edits.
4. Preserve workspace boundaries.
Now perform: <feature request>
```

### Error Handling

Agents should:
- Detect and report failures in verification
- Not make destructive changes outside expected files
- Fail fast on missing dependencies or credentials

---

## 🔐 Security & Auth

Some agents require credentials:

| Agent | Required Credentials |
|------|----------------------|
| Infrastructure Provisioner | Cloud API keys |
| Cloudflare Tunnel | Cloudflare API token + Zone ID |
| PR Automation | GitHub token |
| Mutation Loop | GitHub token for PRs |
| Controller Deployment | SSH keys for server |

Credentials should **never be hard-coded** and should always be supplied via:
- environment variables
- secret management systems

Examples:

```bash
export HCLOUD_TOKEN="..."
export CLOUDFLARE_API_TOKEN="..."
export GITHUB_TOKEN="..."
export CLOUDFLARE_ZONE_ID="..."
```

---

### 6) **Shell Command Execution Agent**

**Purpose:**
Provides a unified, safety-first shell command execution gateway for all workspace operations.

**Safety controls:**
- Binary allowlist: `pnpm`, `node`, `git`, `npx`, `bash` (extensible per-task)
- Pattern denylist: blocks destructive commands (`rm -rf /`, `mkfs`, `dd`, fork bombs)
- Concurrency limits: 10 global, 5 per-task (configurable)
- Per-command timeout: 120s default, configurable up to 600s
- Structured audit trail with FIFO eviction

**Invoked via:**
MCP tools (`execute_shell_command`, `set_shell_policy`, etc.) or RPC methods (`shell/execute`, `shell/setPolicy`, etc.).

**Feature flag:**
Set `SHELL_TOOL_ENABLED=false` to disable all shell-related MCP tools and RPC methods.

---

### 7) **Autonomous Orchestrator Agent**

**Purpose:**
Drives fully autonomous end-to-end coding workflows — from objective to merged PR — without human intervention. Composes all existing controller primitives (task management, workspace isolation, shell execution, CI tracking, PR review loops, execution plans, skill routing, quality scoring) into a self-directed multi-phase pipeline.

**Workflow:**
1. **Planning** — Creates task (workspace + branch + thread), generates execution plan
2. **Execution** — For each phase: enriched prompt → Codex turn → verify → fix-until-green → checkpoint
3. **Validation** — Composite quality scoring (eval + CI + lint + architecture + docs)
4. **Commit** — Commits all accumulated changes
5. **PR** — Opens GitHub pull request with phase results summary
6. **Review** — Automated review loop (review + fix + re-review)

**Key features:**
- Multi-phase execution with accumulated context across phases
- Cooperative cancellation (checked between phases)
- Partial success handling (some phases can fail without aborting the run)
- Quality threshold gating (configurable minimum score)
- Full observability via run records with per-phase timing and error tracking

**Invoked via:**
MCP tool `start_autonomous_run` (returns jobId) or RPC method `autonomous/start`.
Poll with `get_autonomous_run` / `autonomous/get`. Cancel with `cancel_autonomous_run` / `autonomous/cancel`.

---

## 🧪 Testing Agents

You can test each agent independently using controller CLI or programmatic APIs:

Example:

```bash
controller runVerify --taskId test123
controller fixUntilGreen --taskId test123
```

---

## 📦 Extending Agents

To add an agent:

1. Define intent and scope
2. Draft the high-level prompt
3. Add a service wrapper method in the controller
4. Add tests for expected behavior
5. Document in this file

## Learning Notes (added by Codex)

- The repository is organized around **specialized agents** that run as Codex/App-Server workflows (provisioning, networking, deployment, mutation, PR automation, shell execution, and autonomous orchestration).
- Most high-impact work is expected to be delivered through typed agent prompts with explicit context, constraints, expected outputs, and failure handling instructions.
- Controller orchestration is iterative and verification-first: mutation work should run verification (`pnpm verify` is the canonical loop signal in the doc) and then apply corrective fixes.
- A strict boundary model exists:
  - preserve workspace/repo boundaries
  - avoid root-wide edits unless absolutely required
  - prefer minimal changes
  - avoid destructive file operations outside expected locations
- Naming conventions are expected to be domain-prefixed (`infra/*`, `cloudflare/*`, `controller/*`, `mutation/*`, `pr/*`) for discoverability and routing.
- Security posture requires credentials to come from environment/secret systems only; no hard-coded tokens.
- Shell execution is intentionally constrained by allowlists, denylists, command timeouts, and concurrency limits.
- Autonomous orchestration is a first-class workflow: plan → execute phase turns → fix-until-green → quality gates → commit → PR → review loop.
- Current explicit dependency from this playbook: **no hard-coded credentials**, and controller/CI actions are expected to be traceable via run records and smoke tests.
- Current autonomous failure learnings:
  - Phase transitions previously failed on `verifying -> mutating` and `failed -> mutating`; transitions were widened so multi-phase execution can recover.
  - Early-phase planning turns should not be forced through verification/fix loops, which can trigger root-guardrail false failures before implementation.
  - Root file scope constraints must be explicitly injected into phase prompts to prevent accidental edits of blocked files (e.g., `package.json`).
