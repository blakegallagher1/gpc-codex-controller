# Shell Tool Integration — Interference Analysis Matrix

**Date:** 2026-02-12
**Author:** gpc-codex-controller automation
**Scope:** Add unified CommandExecutionGateway, ShellToolManager, and CommandAuditLogger

---

## 1. Workflow Impact Matrix

| Workflow | Files Touched | Shell Execution Path | Impact | Risk |
|----------|--------------|---------------------|--------|------|
| `runVerify` | controller.ts → workspaceManager.ts | `pnpm verify` via `runInWorkspaceAllowNonZero` | **LOW** — Gateway wraps existing path transparently | Regression if allowlist changes |
| `fixUntilGreen` | controller.ts → workspaceManager.ts | `pnpm verify`, `git diff --stat`, `git diff` | **LOW** — Multiple sequential commands, all allowed | Loop termination unaffected |
| `createPullRequest` | controller.ts → workspaceManager.ts, gitManager | `git remote get-url origin` | **LOW** — Single read-only command | None |
| `runMutation` | controller.ts → appServerClient.ts | Turns via app-server (not direct shell) | **NONE** — App-server manages its own sandbox | N/A |
| `runEval` | evalManager.ts → workspaceManager.ts | `pnpm verify`, `git diff`, `git diff --name-only` (×5 checks) | **LOW** — Read-only git commands + verify | None |
| `reviewPR` | prReviewManager.ts → workspaceManager.ts | `git diff`, `git diff --stat` | **LOW** — Read-only | None |
| `reproduceBug` | bugReproductionManager.ts → workspaceManager.ts | `git diff --name-only`, `pnpm verify` | **LOW** — Existing pattern | None |
| `bootApp` | appBootManager.ts → workspaceManager.ts | `pnpm dev` or equivalent | **MEDIUM** — Long-running process | Gateway timeout must accommodate |
| `runLinter` | linterFramework.ts → workspaceManager.ts | `npx eslint` | **LOW** — Standard lint execution | None |
| `archValidate` | architectureValidator.ts → workspaceManager.ts | `git diff --name-only` + file reads | **LOW** — Read-only | None |
| `docValidate` | docValidator.ts → workspaceManager.ts | File reads only (no shell) | **NONE** | N/A |
| `appServerClient.start()` | appServerClient.ts | `spawn("codex", ["app-server"])` | **NONE** — Separate process lifecycle, NOT workspace commands | N/A |

## 2. Command Execution Entry Points (Current)

| Entry Point | File:Line | Method | Callers |
|-------------|-----------|--------|---------|
| `runInWorkspace` | workspaceManager.ts:58 | Strict (throws on non-zero) | controller.fixUntilGreen, enforceBlockedEditGuardrail, createPullRequest |
| `runInWorkspaceAllowNonZero` | workspaceManager.ts:83 | Permissive (returns result) | controller.runVerify, evalManager.*, prReviewManager.*, bugReproductionManager.* |
| `runCommand` (private) | workspaceManager.ts:231 | Core spawn wrapper | Both public methods above + cloneInto |
| `appServerClient.start` | appServerClient.ts:66 | Codex process spawn | controller.ensureSessionReady (not workspace cmd) |

## 3. Non-Interference Checklist

| Concern | Assessment | Mitigation |
|---------|-----------|------------|
| Existing `runInWorkspace` callers break | **SAFE** — Gateway is a new layer BELOW workspaceManager; WM API unchanged | Gateway is opt-in via feature flag |
| Command allowlist changes silently | **SAFE** — Gateway inherits existing allowlist from workspaceManager.assertAllowedCommand | Denylist is additive, never subtractive |
| Output buffering changes | **SAFE** — Gateway delegates to same spawn logic with same 2MB limit | OUTPUT_LIMIT_BYTES constant unchanged |
| Path validation bypassed | **SAFE** — resolveWorkspacePath + assertAllowedCommand unchanged | Gateway adds audit layer ON TOP |
| appServerClient process spawn affected | **SAFE** — Completely separate codepath, not routed through workspaceManager | No change to appServerClient.ts |
| Turn execution (executeTurn) affected | **SAFE** — Turns go through appServerClient RPC, not workspace shell | No change |
| Job queue / async methods affected | **SAFE** — Job queue wraps controller methods, not shell directly | No change to rpcServer job mechanics |
| MCP tool registration affected | **SAFE** — New tools are additive only | Existing tool schemas unchanged |

## 4. Compatibility Gaps

| Gap | Description | Resolution |
|-----|-------------|------------|
| No audit trail today | workspaceManager fires commands silently | CommandAuditLogger adds structured logs |
| No per-task command policy | All tasks share same global allowlist | ShellToolManager adds per-task policy |
| No command metrics | No visibility into execution times/frequencies | CommandAuditLogger tracks metrics |
| No denylist | Only allowlist exists | Gateway adds explicit denylist |
| Feature flag missing | No way to disable shell changes without code rollback | SHELL_TOOL_ENABLED env var with default=true |

## 5. Regression Risk Register

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Gateway adds latency to every command | LOW | LOW | Gateway is synchronous wrapper, no async overhead beyond audit write |
| Denylist accidentally blocks needed command | LOW | HIGH | Denylist starts empty; only explicit additions |
| Feature flag off breaks new functionality | LOW | LOW | Flag only gates NEW shell tools, not existing workspaceManager paths |
| Audit log fills disk | MEDIUM | LOW | Log rotation / max entries with FIFO eviction |
| Per-task policy blocks eval commands | LOW | MEDIUM | Default policy allows all currently-allowed commands |

## 6. Rollback Plan

1. Set `SHELL_TOOL_ENABLED=false` → disables new shell MCP tools and RPC methods
2. Existing workspaceManager paths continue unmodified (gateway is additive)
3. If critical issue: revert git commit, rebuild, redeploy (< 5 min)
4. Audit logs can be deleted without impact: `rm -f {stateDir}/command-audit.json`
