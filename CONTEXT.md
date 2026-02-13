# GPC Codex Controller — Complete System Context

> **Last updated:** 2026-02-12
> **Repo:** `blakegallagher1/gpc-codex-controller`
> **Production:** `https://codex-controller.gallagherpropco.com`
> **VM:** `root@5.161.99.123` — `/home/controller/gpc-codex-controller`

---

## 1. What This Is

GPC Codex Controller is a **headless orchestration layer** that wraps OpenAI's Codex App Server to autonomously develop, verify, fix, review, and ship code for a target repository. It is purpose-built for **gpc-cres** — Gallagher Property Company's internal Entitlement OS for commercial real estate.

The controller exposes **63 MCP tools** and **50+ JSON-RPC methods** over HTTP so that any MCP-compatible client (ChatGPT Apps, Claude, custom tooling) can drive the full software development lifecycle without human intervention: create tasks, write code via Codex, run verification, auto-fix failures, score quality, open pull requests, and run automated code review — all through a single API surface.

In plain terms: you describe what you want built, and the controller handles cloning the repo, branching, writing code (via Codex), running `pnpm verify`, fixing any failures in a loop, scoring the result, committing, pushing, opening a PR, and reviewing it — end to end.

---

## 2. Why It Exists

Gallagher Property Company is building **gpc-cres**, a multi-tenant SaaS platform for managing commercial real estate entitlement workflows across Louisiana parishes. The codebase is a complex pnpm monorepo with 30+ Prisma models, multiple workspace packages, Temporal workflows, and strict architectural rules.

Rather than manually coding every feature, the controller acts as an **AI software engineer** that:

- Understands the gpc-cres monorepo conventions (org-scoped queries, workspace boundaries, strict TypeScript)
- Can implement features, fix bugs, write tests, update docs, and ship PRs autonomously
- Enforces quality gates (linting, architecture validation, eval scoring) before any code reaches `main`
- Learns from past fix patterns via a persistent memory system
- Supports both interactive (tool-by-tool) and fully autonomous (fire-and-forget) operation modes

---

## 3. Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────┐
│                        External Clients                             │
│   (ChatGPT Apps via MCP connector, curl, custom tooling)           │
└──────────────────────────┬──────────────────────────────────────────┘
                           │ HTTPS (Cloudflare Tunnel)
                           ▼
┌─────────────────────────────────────────────────────────────────────┐
│                     HTTP Server (index.ts)                          │
│                                                                     │
│   GET /healthz ─── health check                                    │
│   POST /rpc    ─── JSON-RPC 2.0 (rpcServer.ts, 50+ methods)       │
│   POST /mcp    ─── MCP Streamable HTTP (mcpServer.ts, 63 tools)   │
│                                                                     │
│   Bearer token authentication (optional)                            │
└──────────────────────────┬──────────────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────────────┐
│                      Controller (controller.ts)                     │
│                                                                     │
│   Central orchestration hub. Wires together 28 manager modules.    │
│   Manages: sessions, threads, turns, task lifecycle, prompts.      │
│                                                                     │
│   Key flows:                                                        │
│   ┌─ startTask() ──► executeTurn() ──► enforceGuardrails()        │
│   ├─ runMutation() ──► mutate → verify → fixLoop → commit → PR    │
│   ├─ fixUntilGreen() ──► verify → send fix prompt → re-verify     │
│   ├─ runReviewLoop() ──► review → fix → re-review (max 3 rounds)  │
│   └─ startAutonomousRun() ──► plan → execute → validate → ship    │
└──────────────┬─────────────────┬────────────────────────────────────┘
               │                 │
    ┌──────────┘                 └──────────┐
    ▼                                       ▼
┌──────────────────────┐    ┌──────────────────────────────────────┐
│  AppServerClient     │    │  28 Manager Modules                  │
│  (appServerClient.ts)│    │                                      │
│                      │    │  WorkspaceManager   GitManager        │
│  Spawns Codex CLI as │    │  TaskRegistry       ShellToolManager  │
│  child process.      │    │  SkillRouter        SkillsManager     │
│  Communicates via    │    │  MemoryManager      EvalManager       │
│  JSON-RPC over stdio.│    │  ExecutionPlanMgr   CompactionManager │
│                      │    │  NetworkPolicyMgr   DomainSecretsMgr  │
│  Methods:            │    │  ArtifactManager    ArchValidator     │
│  - initialize()      │    │  LinterFramework    DocValidator      │
│  - startThread()     │    │  QualityScoreMgr    PRReviewManager   │
│  - startTurn()       │    │  AppBootManager     LogQueryManager   │
│  - waitForNotif()    │    │  CDPBridge          BugReproManager   │
│  - autoApproval      │    │  TaskContinuationMgr                  │
│                      │    │  ReferenceDocMgr    GCScheduler       │
│  Codex model:        │    │  CommandExecGateway  CommandAuditLog  │
│  gpt-5.2-codex       │    │  AutonomousOrchestrator               │
└──────────────────────┘    └──────────────────────────────────────┘
```

---

## 4. Technology Stack

| Component | Technology |
|-----------|-----------|
| Runtime | Node.js ≥ 22, TypeScript 5.7 (strict mode, ES2023 target) |
| Module system | ESM (`"type": "module"`) with NodeNext resolution |
| Dependencies | `@modelcontextprotocol/sdk` ^1.12.1, `zod` ^3.24.0 |
| AI engine | OpenAI Codex App Server (gpt-5.2-codex model) |
| Protocol | JSON-RPC 2.0 over HTTP + MCP Streamable HTTP |
| Auth | Optional bearer token, ChatGPT device auth |
| Infrastructure | Hetzner VPS, Cloudflare Tunnel + Access, Terraform |
| Target repo | gpc-cres (pnpm monorepo, Next.js + Prisma + Temporal) |
| Service mgmt | systemd (`gpc-codex-controller.service`) |

---

## 5. Source File Inventory (30 TypeScript files)

### 5.1 Entry Point & Server Layer

**`src/index.ts`** (461 lines) — CLI entry point. Parses args, initializes Controller and AppServerClient, dispatches to one of 18 CLI commands (`serve`, `start`, `continue`, `verify`, `fix`, `pr`, `mutate`, `eval`, `garden`, `parallel`, `review`, `review-loop`, `quality`, `lint`, `arch-validate`, `doc-validate`, `reproduce-bug`, `gc-sweep`). The `serve` command starts the HTTP server; all others are one-shot operations.

**`src/rpcServer.ts`** (641 lines) — HTTP server with three routes. `GET /healthz` returns health status. `POST /rpc` handles JSON-RPC 2.0 requests with 50+ methods. `POST /mcp` delegates to the MCP handler. Long-running operations (task/start, fix/untilGreen, mutation/run, autonomous/start, etc.) run asynchronously and return a `jobId` for polling via `job/get`. Supports bearer token auth.

**`src/mcpServer.ts`** (734 lines) — MCP adapter using `@modelcontextprotocol/sdk`. Registers 63 tools with Zod-validated schemas. Each tool maps to a Controller method. Uses `StreamableHTTPServerTransport` for stateless HTTP-based MCP. Shares the same async job pattern as the RPC server.

### 5.2 Codex Integration

**`src/appServerClient.ts`** (388 lines) — Manages the Codex App Server as a child process. Spawns `codex app-server` with isolated env (strips OPENAI_API_KEY). Communicates via JSON-RPC over stdio with line-buffered parsing. Key methods: `initialize()`, `startThread()`, `startTurn()`, `waitForNotification()`. Auto-approves file write and command execution requests from Codex. Handles graceful shutdown (SIGTERM → wait → SIGKILL).

### 5.3 Core Orchestration

**`src/controller.ts`** (1689 lines) — The central hub. Instantiates and wires together all 28 manager modules. Owns the core workflows:

- **`startTask(prompt)`** — Creates a thread, enriches the prompt with skill/memory/secrets context, executes a Codex turn.
- **`continueTask(threadId, prompt)`** — Sends follow-up prompts to an existing thread.
- **`runVerify(taskId)`** — Runs `pnpm verify` in the task workspace, parses failures from stdout or `.agent-verify.json`.
- **`fixUntilGreen(taskId, maxIterations)`** — Verify → build fix prompt → Codex turn → re-verify loop. Detects identical diffs (stuck loop) and aborts after 3 consecutive identical diffs. Extracts learnings from each fix iteration into the memory system.
- **`runMutation(taskId, description)`** — Full mutation workflow: create task → deploy AGENTS.md → enrich prompt → Codex turn → compaction → fix-until-green → eval → commit → create PR.
- **`createPullRequest(taskId, title, body)`** — Pushes branch, calls GitHub API to create PR.
- **`buildMutationPrompt(description)`** — Assembles enriched prompt with skill routing, memory context, domain secrets, and reference docs.
- **`enforceBlockedEditGuardrail(taskId)`** — After every Codex turn, checks `git diff --name-only` for root-level blocked files (`package.json`, `tsconfig.json`, `eslint.config.mjs`, `coordinator.ts`). Sets task to failed and throws if detected.

**`src/autonomousOrchestrator.ts`** (448 lines) — Drives end-to-end autonomous coding workflows. Given an objective, it: (1) creates task + workspace + branch, (2) generates a multi-phase execution plan, (3) for each phase: sends enriched prompt to Codex, verifies, runs fix loop, checkpoints, (4) scores quality, (5) commits, (6) opens PR, (7) runs review loop. Features cooperative cancellation, consecutive failure circuit breaker (aborts after 2 consecutive phase failures), and recovery from `failed` task state between phases. Runs are fire-and-forget; callers poll via `getRun()`.

### 5.4 Workspace & Git

**`src/workspaceManager.ts`** (313 lines) — Creates isolated git workspaces for each task under `/workspaces/<taskId>/`. Clones from the default repo (`https://github.com/blakegallagher1/gpc-cres`). Provides `runInWorkspace(taskId, command)` for executing commands within the workspace directory. Output limited to 2MB per command.

**`src/gitManager.ts`** (85 lines) — Thin git wrapper. Creates branches named `ai/YYYYMMDD-HHMM-<slug>`. Commits all changes with `git add -A`. Pushes to origin.

### 5.5 Task & State Management

**`src/taskRegistry.ts`** (115 lines) — Task state machine. Persists task records (taskId, workspacePath, branchName, threadId, status) to JSON. Enforces valid status transitions:

```
created ──► mutating ──► verifying ──► fixing ──► ready ──► pr_opened
   │            │            │           │          │
   │            ▼            ▼           ▼          ▼
   └────────► failed ◄──────┴───────────┴──────────┘
                │
                ▼
          ready / mutating / created  (recovery for autonomous runs)
```

Prevents branch name reuse across tasks.

**`src/taskContinuationManager.ts`** (100 lines) — Checkpoint system for long-running tasks. Saves taskId + threadId + description at defined points. Max 20 checkpoints per task (FIFO eviction). Enables resumption after interruption.

**`src/executionPlanManager.ts`** (188 lines) — Creates structured 4-phase execution plans (Analysis → Implementation → Testing → Verification) with estimated LOC, dependencies, and status tracking. Used by the autonomous orchestrator.

### 5.6 Shell Execution (3 files)

**`src/shellToolManager.ts`** (187 lines) — High-level shell interface. Feature-flag gated (`SHELL_TOOL_ENABLED`). Manages per-task execution policies (allowed/denied binaries, patterns, concurrency, timeouts). Aggregates metrics (success/fail rates, durations, command frequency).

**`src/commandExecutionGateway.ts`** (328 lines) — Centralized safety layer for all shell commands. Two-level enforcement: global defaults + per-task overrides.

- **Global allowlist:** `pnpm`, `node`, `git`, `npx`, `bash`
- **Global denylist patterns:** `rm -rf /`, `mkfs`, `dd if=`, fork bombs
- **Concurrency limits:** 10 global, 5 per-task (configurable)
- **Timeouts:** 120s default, 1-600s range
- **Output limits:** 2MB per stream

**`src/commandAuditLogger.ts`** (186 lines) — Structured audit trail for all shell commands. Records command, cwd, exit code, timing, output sizes. Max 5000 entries with FIFO eviction. Provides aggregated metrics.

### 5.7 Quality & Validation (6 files)

**`src/evalManager.ts`** (302 lines) — Runs 7 quality checks on code changes:

1. **Verification** — `pnpm verify` passes
2. **Diff size** — Change magnitude ≤500 lines (ideal)
3. **No blocked file edits** — Root configs untouched
4. **No new dependencies** — `package.json` unchanged
5. **Test coverage** — Tests present for source changes
6. **Type strictness** — No `any`, `@ts-ignore` in diff
7. **OrgId compliance** — Prisma queries include `orgId` filter

Weighted scoring; overall pass requires all checks passed + score ≥ 0.7. Maintains history (max 200 entries).

**`src/qualityScoreManager.ts`** (165 lines) — Composite quality score aggregating 5 dimensions with weights:

| Dimension | Weight | Source |
|-----------|--------|--------|
| Eval | 30% | EvalManager |
| CI | 25% | CIStatusManager |
| Lint | 20% | LinterFramework |
| Architecture | 15% | ArchitectureValidator |
| Documentation | 10% | DocValidator |

Score range 0–100. Maintains historical trend (max 200 entries).

**`src/linterFramework.ts`** (191 lines) — Runs ESLint on changed files plus custom checks: import boundary validation, cross-package import rules, relative import depth limits. Severity: error/warning. Pass = 0 errors.

**`src/architectureValidator.ts`** (180 lines) — Validates 3 architectural rules against git diff:

1. **Dependency direction** — Infrastructure cannot import from domain/core
2. **Layer boundaries** — Layer isolation within monorepo packages
3. **Circular imports** — Graph traversal to detect import cycles

**`src/docValidator.ts`** (190 lines) — Checks documentation accuracy: stale file references, AGENTS.md accuracy, README accuracy. Scans markdown files for broken links. Issue types: stale-reference, missing-doc, broken-link, outdated-example.

**`src/prReviewManager.ts`** (179 lines) — Automated PR review. Analyzes git diff against review criteria: type safety, orgId compliance, import boundaries, error handling, naming, test coverage, minimal diff. Severity levels: error/warning/suggestion. Approved = zero errors. Supports iterative review→fix→review loop (max 3 rounds).

### 5.8 Knowledge & Context (5 files)

**`src/skillsManager.ts`** (137 lines) — Loads skill manifests from `skills/*/SKILL.md`. Parses YAML front-matter for name, description, use-when/don't-use-when clauses. Lazy-loads and caches in memory. Builds prompt context strings from selected skills.

**`src/skillRouter.ts`** (224 lines) — Dynamic skill selection based on task description. Keyword-based scoring with configurable threshold (0.3). Available skills: mutation, fix, doc-gardening, review, architecture, quality, bug-repro. Prevents loading mutually exclusive pairs. Returns ranked decisions with scores and rationale.

**`src/memoryManager.ts`** (184 lines) — Persistent learning store. Records fix patterns, error resolutions, convention violations with confidence scores (0–1). Confidence increases with successful application. Max 500 entries with automatic pruning. Only includes entries with confidence ≥ 0.6 in prompts. Extracts learnings from fix loops automatically.

**`src/referenceDocManager.ts`** (117 lines) — Knowledge base for context enrichment. Stores categorized reference documents (architecture guides, convention docs, etc.) that get injected into prompts. Max 200 docs with FIFO eviction.

**`src/compactionManager.ts`** (221 lines) — Token-aware context window management. Three strategies:

- **turn-interval** — Compact every N turns
- **token-threshold** — Compact when estimated tokens exceed limit
- **auto** — Compact when context reaches N% of max window

Estimates ~4 chars per token. Records compaction events with before/after token counts.

### 5.9 Security & Policy (2 files)

**`src/networkPolicyManager.ts`** (180 lines) — Two-layer network policy. Org-level allowlist (stable, admin-set) + request-level subset (task-specific, narrow). Port constraints per domain. Default deny. Validates request policies against org policy.

**`src/domainSecretsManager.ts`** (169 lines) — Credential injection without model exposure. The model sees placeholders (e.g., `$API_KEY`); runtime resolves them to real values from environment variables. Per-domain configuration. Validates env vars exist at registration time.

### 5.10 Supporting Modules (6 files)

**`src/artifactManager.ts`** (208 lines) — Catalogs task outputs (files, reports, datasets, screenshots, logs) in standardized `_artifacts/` directory. Auto-detects artifact types from file extensions. Tracks file sizes and metadata.

**`src/ciStatusManager.ts`** (varies) — Records CI run results (pass/fail, exit codes, durations, failure summaries). Computes pass rates and detects regressions. Per-task history.

**`src/appBootManager.ts`** (132 lines) — Starts app processes (`pnpm dev`) and polls health endpoint (`localhost:3000`) with backoff. Boot timeout 30s. Returns started/healthy status and PID.

**`src/logQueryManager.ts`** (100 lines) — Searches git log history for patterns. Uses `git log --grep`. Default limit 100, max 500. Error-specific filtering.

**`src/bugReproductionManager.ts`** (129 lines) — Generates minimal reproduction tests from bug descriptions. Creates reproduction prompt → Codex generates test → verifies test fails (confirming bug exists).

**`src/cdpBridge.ts`** (91 lines) — Chrome DevTools Protocol bridge (placeholder). Prepared for future screenshot/console integration. All methods currently return placeholder responses.

**`src/gcScheduler.ts`** (114 lines) — Garbage collection. Removes stale workspaces (>7 days) and old job records (>24 hours). Returns freed paths and counts.

---

## 6. The 63 MCP Tools (by Category)

### Core Task Management (8 tools)
| Tool | Description |
|------|-------------|
| `start_task` | Create task + thread, execute initial Codex turn (async) |
| `continue_task` | Send follow-up prompt to existing thread (async) |
| `create_task` | Create task record without executing a turn |
| `get_task` | Retrieve task record by ID |
| `run_verify` | Run `pnpm verify` and parse results |
| `fix_until_green` | Verify→fix loop until green or max iterations (async) |
| `create_pr` | Push branch + create GitHub PR |
| `get_job` | Poll async job status/result |

### Mutation & Parallel (3 tools)
| Tool | Description |
|------|-------------|
| `run_mutation` | Full mutation workflow: mutate→verify→fix→commit→PR (async) |
| `run_parallel` | Execute multiple mutations concurrently (async) |
| `run_doc_gardening` | Scan and update stale documentation (async) |

### Evaluation & Quality (5 tools)
| Tool | Description |
|------|-------------|
| `run_eval` | Run 7-check quality evaluation |
| `get_eval_history` | Retrieve past eval results |
| `get_eval_summary` | Get condensed eval summary for a task |
| `get_quality_score` | Composite quality score (eval+CI+lint+arch+docs) |
| `get_memory_entries` | Retrieve learned patterns from memory |

### Execution Plans (3 tools)
| Tool | Description |
|------|-------------|
| `create_execution_plan` | Generate phased plan for a task |
| `get_execution_plan` | Retrieve plan by task ID |
| `update_plan_phase` | Update phase status (pending/in_progress/completed/failed) |

### CI Status (3 tools)
| Tool | Description |
|------|-------------|
| `record_ci_run` | Record a CI run result |
| `get_ci_status` | Get CI summary (pass rate, regressions) |
| `get_ci_history` | Retrieve CI run history for a task |

### Logging & Debugging (3 tools)
| Tool | Description |
|------|-------------|
| `query_logs` | Search git history for patterns |
| `boot_app` | Start app and health-check (async) |
| `reproduce_bug` | Generate reproduction test from bug description (async) |

### Linting & Validation (3 tools)
| Tool | Description |
|------|-------------|
| `run_linter` | Run ESLint + custom checks |
| `validate_architecture` | Check dependency direction, layer boundaries, cycles |
| `validate_docs` | Check documentation accuracy |

### PR Review (2 tools)
| Tool | Description |
|------|-------------|
| `review_pr` | Automated code review with structured findings |
| `run_review_loop` | Iterative review→fix→review (async) |

### Task Continuation (2 tools)
| Tool | Description |
|------|-------------|
| `checkpoint_task` | Save checkpoint for resumption |
| `get_task_checkpoints` | List checkpoints for a task |

### Reference Docs (2 tools)
| Tool | Description |
|------|-------------|
| `add_reference_doc` | Add document to knowledge base |
| `get_reference_docs` | List reference documents |

### Skill Routing (2 tools)
| Tool | Description |
|------|-------------|
| `route_skills` | Auto-select relevant skills for a task |
| `force_select_skills` | Manually override skill selection |

### Artifacts (3 tools)
| Tool | Description |
|------|-------------|
| `register_artifact` | Register an output artifact |
| `collect_artifacts` | Scan workspace for artifacts |
| `get_artifacts` | List registered artifacts |

### Network Policy (5 tools)
| Tool | Description |
|------|-------------|
| `get_network_policy` | Get org-level allowlist |
| `set_network_policy` | Set complete allowlist |
| `add_network_domain` | Add domain to allowlist |
| `remove_network_domain` | Remove domain from allowlist |
| `validate_request_network` | Validate request policy against org policy |

### Domain Secrets (3 tools)
| Tool | Description |
|------|-------------|
| `register_domain_secret` | Register credential placeholder mapping |
| `get_domain_secrets` | List secret configurations |
| `validate_domain_secrets` | Check which secrets can be injected |

### Compaction (4 tools)
| Tool | Description |
|------|-------------|
| `get_compaction_config` | Get current compaction strategy |
| `set_compaction_config` | Update compaction strategy/thresholds |
| `get_compaction_history` | List compaction events |
| `get_context_usage` | Estimate token usage for a thread |

### Shell Execution (8 tools)
| Tool | Description |
|------|-------------|
| `execute_shell_command` | Run command with safety controls |
| `set_shell_policy` | Set per-task execution policy |
| `get_shell_policy` | Get task execution policy |
| `remove_shell_policy` | Remove task policy |
| `list_shell_policies` | List all per-task policies |
| `get_shell_audit_log` | Retrieve command audit trail |
| `get_shell_metrics` | Aggregated execution metrics |
| `get_shell_config` | Get global shell configuration |

### Autonomous Orchestration (4 tools)
| Tool | Description |
|------|-------------|
| `start_autonomous_run` | Fire-and-forget end-to-end workflow (async) |
| `get_autonomous_run` | Poll autonomous run status |
| `list_autonomous_runs` | List all autonomous runs |
| `cancel_autonomous_run` | Cancel a running autonomous workflow |

### Utility (1 tool)
| Tool | Description |
|------|-------------|
| `gc_sweep` | Clean up stale workspaces and jobs |

---

## 7. Key Workflows

### 7.1 Interactive Mutation (tool-by-tool)

```
create_task("my-feature")
  → Task record created, workspace cloned, branch created, thread started

execute_shell_command("my-feature", ["pnpm", "verify"])
  → Baseline verification

start_task("Add GET /api/health endpoint...")
  → Codex writes code in workspace

run_verify("my-feature")
  → Runs pnpm verify, returns pass/fail + failures

fix_until_green("my-feature", 5)
  → Loops: verify → build fix prompt → Codex turn → re-verify
  → Extracts learnings from each iteration

get_quality_score("my-feature")
  → Composite score: eval(30%) + CI(25%) + lint(20%) + arch(15%) + docs(10%)

create_pr("my-feature", "feat: add health endpoint", "...")
  → Pushes branch, creates GitHub PR

review_pr("my-feature")
  → Automated code review with findings

run_review_loop("my-feature", 3)
  → Review → fix → re-review until approved or max rounds
```

### 7.2 Autonomous End-to-End

```
start_autonomous_run({
  objective: "Add CRUD for DealOutcome model...",
  maxPhaseFixes: 3,
  qualityThreshold: 0,
  autoCommit: true,
  autoPR: true,
  autoReview: true
})
  → Returns runId for polling

# Internally executes:
#   1. Planning: create task, workspace, branch, execution plan
#   2. Executing: for each phase (Analysis → Implementation → Testing → Verification):
#      a. Build enriched prompt with skill routing + memory + secrets + phase context
#      b. Execute Codex turn
#      c. Verify
#      d. Fix loop if failures (up to maxPhaseFixes iterations)
#      e. Checkpoint on success
#      f. Circuit breaker: abort after 2 consecutive phase failures
#   3. Validating: compute quality score, re-fix if below threshold
#   4. Committing: git add + commit
#   5. Reviewing: create PR, run review loop

get_autonomous_run(runId)
  → Poll: status, phases, commitHash, prUrl, qualityScore, reviewPassed
```

### 7.3 One-Shot Mutation (single command)

```
run_mutation("my-feature", "Add health endpoint that returns { ok: true }")
  → Internally: createTask → deployAgentsMd → buildMutationPrompt → executeTurn
     → compactIfNeeded → fixUntilGreen → eval → commit → createPR
  → Returns: { taskId, branch, prUrl, iterations, success, evalScore }
```

---

## 8. Task State Machine

Every task has a status tracked in `tasks.json`:

```
                    ┌──────────────────────────────────────┐
                    │                                      │
                    ▼                                      │
  ┌─────────┐   ┌──────────┐   ┌───────────┐   ┌───────┐ │ ┌──────────┐
  │ created │──►│ mutating │──►│ verifying │──►│ ready │─┘►│pr_opened │
  └─────────┘   └──────────┘   └───────────┘   └───────┘   └──────────┘
       │            │ ▲            │ ▲   │          │            │
       │            │ │            │ │   │          │            │
       │            ▼ │            ▼ │   │          │            │
       │         ┌────────┐        │ │   │          │            │
       │         │ fixing │────────┘ │   │          │            │
       │         └────────┘          │   │          │            │
       │            │                │   │          │            │
       ▼            ▼                ▼   │          ▼            ▼
  ┌────────────────────────────────────┐ │  ┌──────────────────────┐
  │              failed                │─┘  │    (terminal)        │
  └────────────────────────────────────┘    └──────────────────────┘
       │
       ▼ (recovery for autonomous runs)
    ready / mutating / created
```

Valid transitions are enforced by `VALID_TRANSITIONS` in `taskRegistry.ts`. The `failed` state allows recovery to `ready`, `mutating`, or `created` so that the autonomous orchestrator can reset a task between phases after a non-terminal failure.

---

## 9. Safety & Guardrails

### 9.1 Blocked Root Files

After every Codex turn, the controller checks `git diff --name-only` for modifications to:
- `package.json`
- `tsconfig.json`
- `eslint.config.mjs`
- `coordinator.ts`

If any are modified, the task is immediately set to `failed` and an error is thrown. This prevents Codex from restructuring the monorepo root.

### 9.2 Shell Execution Safety

All shell commands go through the `CommandExecutionGateway`:

- **Binary allowlist:** Only `pnpm`, `node`, `git`, `npx`, `bash` by default
- **Pattern denylist:** `rm -rf /`, `mkfs`, `dd if=`, fork bombs
- **Per-task policies:** Additional allowed/denied binaries and patterns
- **Concurrency limits:** 10 global, 5 per-task
- **Timeouts:** 120s default (configurable 1-600s)
- **Output limits:** 2MB per stream
- **Audit trail:** Every command logged with timing and exit codes

Feature flag: `SHELL_TOOL_ENABLED=false` disables the shell subsystem entirely.

### 9.3 Turn Budget

Each task is limited to `MAX_TURNS_PER_TASK = 5` Codex turns. Exceeding this throws an error. Prevents runaway loops.

### 9.4 Stuck Fix Loop Detection

`fixUntilGreen()` tracks `git diff --stat` between iterations. If the same diff appears 3 consecutive times (`MAX_IDENTICAL_FIX_DIFFS`), the task is failed and the loop aborts.

### 9.5 Network Policy

Default-deny network policy. Org-level allowlist defines which domains Codex can access. Per-task policies must be a subset of the org policy.

### 9.6 Domain Secrets

Credentials are never exposed to the model. The model sees placeholders (`$API_KEY`); real values are resolved from environment variables at runtime.

---

## 10. Skill System

Skills are domain-specific instruction sets loaded from `skills/*/SKILL.md`. Each SKILL.md has YAML front-matter with name, description, and when-to-use/when-not-to-use rules.

### Available Skills (9)

| Skill | Purpose |
|-------|---------|
| `mutation` | Feature implementation in gpc-cres. Workspace rules, templates, negative examples. |
| `fix` | Fixing verification failures. Diagnosis priority: TypeScript → lint → tests. |
| `architecture` | Enforcing dependency direction, layer boundaries, no import cycles. |
| `autonomous` | End-to-end autonomous workflow parameters and phase management. |
| `bug-repro` | Creating minimal reproduction tests before fixing. |
| `doc-gardening` | Scanning and updating stale documentation. |
| `quality` | Composite quality scoring interpretation and workflows. |
| `review` | Automated PR review checklist and the review→fix loop. |
| `shell` | Shell execution gateway tools and safety controls. |

The **SkillRouter** dynamically selects relevant skills based on task description keywords, scoring each candidate and returning the top matches above a 0.3 threshold.

---

## 11. Memory System

The `MemoryManager` maintains a persistent learning store that accumulates knowledge across tasks:

- **Categories:** fix-pattern, error-resolution, convention-violation, performance, general
- **Confidence scores:** 0–1, increase with successful application
- **Max entries:** 500 (auto-pruned by lowest confidence)
- **Prompt injection threshold:** Only entries with confidence ≥ 0.6 are included in prompts
- **Auto-extraction:** After each fix loop iteration, the manager extracts learnings from the error output and the fix diff

This means the controller gets smarter over time — common error patterns and their fixes are remembered and injected into future fix prompts.

---

## 12. Target Repository: gpc-cres

### What It Is

**gpc-cres** (Gallagher Commercial Real Estate System) is a multi-tenant SaaS platform for managing commercial real estate entitlement workflows. It helps track deals, parcels, jurisdictions, buyers, outreach, evidence, artifacts, and entitlement predictions across Louisiana parishes.

### Architecture

- **Monorepo:** pnpm workspaces
- **Stack:** Next.js + PostgreSQL + Prisma + Temporal + OpenAI Responses API + Supabase Storage
- **Packages:**
  - `apps/web` — Next.js frontend (20+ pages, 25+ API route groups)
  - `apps/worker` — Temporal workflow worker
  - `packages/db` — Prisma schema + migrations (30+ models, 940 lines)
  - `packages/shared` — Shared types, Zod schemas, utilities
  - `packages/openai` — OpenAI integration
  - `packages/evidence` — Evidence collection/management
  - `packages/artifacts` — Artifact generation

### Key Models (30+)

Org, User, Deal, Parcel, Task, Buyer, Outreach, Run, EvidenceSource, EvidenceSnapshot, ParishPackVersion, Artifact, Upload, DocumentExtraction, Conversation, Message, Entity, EntityDeal, TaxEvent, Notification, NotificationPreference, SavedSearch, ApprovalRequest, MarketDataPoint, AutomationEvent, OpportunityMatch, KnowledgeEmbedding, EntitlementGraphNode, EntitlementGraphEdge, EntitlementOutcomePrecedent, EntitlementPredictionSnapshot, DealOutcome, AssumptionActual

### Critical Rules

1. **orgId scoping** — Every tenant-scoped Prisma query MUST include `where: { orgId }`. No exceptions.
2. **Workspace boundaries** — Use `@gpc-cres/<package>` imports. No relative imports across packages.
3. **Strict TypeScript** — No `any`, no `@ts-ignore`, explicit return types.
4. **Prisma migrations** — ONE migration per task, serial only, never parallel.
5. **Verification** — `pnpm verify` must pass (build → lint → test → typecheck).

---

## 13. Infrastructure & Deployment

### Production Environment

| Component | Detail |
|-----------|--------|
| VPS | Hetzner Cloud (CPX11), Ubuntu, 5.161.99.123 |
| Domain | `codex-controller.gallagherpropco.com` |
| Tunnel | Cloudflare Tunnel (no direct public ingress) |
| Auth | Cloudflare Access + optional bearer token |
| Service | `gpc-codex-controller.service` (systemd) |
| App path | `/home/controller/gpc-codex-controller` |
| IaC | Terraform (Hetzner + Cloudflare providers) |

### Deploy Process

```bash
ssh root@5.161.99.123 "cd /home/controller/gpc-codex-controller && \
  git pull origin main && \
  npm ci && \
  npx tsc -p tsconfig.json && \
  systemctl restart gpc-codex-controller && \
  systemctl status gpc-codex-controller --no-pager"
```

### Terraform Modules

- `hetzner-vm` — VPS provisioning with cloud-init
- `cloudflare-tunnel` — Tunnel + DNS routing
- `render-service` — (optional) Render deployment

### Environment Variables

| Variable | Purpose |
|----------|---------|
| `MCP_BIND` | Bind address (default: 127.0.0.1) |
| `MCP_PORT` | Server port (default: 8787) |
| `MCP_BEARER_TOKEN` | Optional auth token |
| `MCP_BASE_URL` | Public URL when behind reverse proxy |
| `CODEX_HOME` | Codex CLI auth state directory |
| `GITHUB_TOKEN` | GitHub PAT for PR automation |
| `SHELL_TOOL_ENABLED` | Feature flag for shell subsystem |

---

## 14. Data Persistence

All state is persisted to JSON files in the state directory (`<workspace>/.gpc-codex-controller/`):

| File | Manager | Contents |
|------|---------|----------|
| `state.json` | Controller | Current threadId |
| `tasks.json` | TaskRegistry | All task records + statuses |
| `memory.json` | MemoryManager | Learned patterns (max 500) |
| `eval-history.json` | EvalManager | Eval results (max 200) |
| `plans.json` | ExecutionPlanManager | Execution plans per task |
| `ci-status.json` | CIStatusManager | CI run history |
| `quality-scores.json` | QualityScoreManager | Quality score history (max 200) |
| `checkpoints.json` | TaskContinuationManager | Task checkpoints (max 20/task) |
| `reference-docs.json` | ReferenceDocManager | Knowledge base docs (max 200) |
| `network-policy.json` | NetworkPolicyManager | Org network allowlist |
| `domain-secrets.json` | DomainSecretsManager | Secret placeholder mappings |
| `compaction-history.json` | CompactionManager | Compaction events |
| `artifacts.json` | ArtifactManager | Artifact catalog |
| `autonomous-runs.json` | AutonomousOrchestrator | Autonomous run records |
| `shell-policies.json` | ShellToolManager | Per-task shell policies |
| `shell-audit.json` | CommandAuditLogger | Command audit trail (max 5000) |

---

## 15. Commit History

| Hash | Description |
|------|-------------|
| `1f81af8` | 17 Harness Engineering capabilities (execution plans, CI tracking, PR review loops, app boot, linting, arch validation, doc validation, quality scoring, GC sweep, bug reproduction, checkpointing, reference docs, log querying, CDP bridge) |
| `9b3e110` | Article-inspired capabilities (skill routing, artifacts, network policy, domain secrets, token-aware compaction) |
| `8248945` | Shell tool integration with unified command execution gateway |
| `cd8bb4a` | Autonomous orchestrator for end-to-end coding workflows |
| `aa5c105` | Fix: allow verifying/fixing → mutating transitions for multi-phase autonomous runs |
| `db74f0a` | PR #3 merged: MCP_BASE_URL support for reverse proxy deployments |
| `905e206` | Fix: orchestrator recovers from failed task state between phases (circuit breaker, state recovery) |

---

## 16. Known Limitations & Future Work

### Current Limitations

1. **CDPBridge is a placeholder** — Screenshot and console integration not yet implemented.
2. **Turn budget is global** — `MAX_TURNS_PER_TASK = 5` applies to all task types equally; autonomous runs with many phases may hit this limit.
3. **No streaming MCP** — Uses stateless HTTP transport; no server-sent events for real-time progress.
4. **Single-repo assumption** — Hardcoded default repo URL (`gpc-cres`). Multi-repo support would require WorkspaceManager changes.
5. **Token estimation is rough** — CompactionManager uses ~4 chars/token heuristic. Could be improved with tiktoken.
6. **Autonomous planning is aggressive** — May attempt root file modifications that trigger guardrails. Objectives need explicit scope constraints.

### Future Opportunities

- CDP integration for visual regression testing
- Webhook-based CI integration (replace polling)
- Multi-repo workspace support
- Streaming progress for autonomous runs
- Improved token counting (tiktoken integration)
- Dashboard UI for monitoring runs and quality trends
