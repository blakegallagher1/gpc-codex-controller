---
name: shell
description: |
  Use when: Executing shell commands in task workspaces, managing execution policies, reviewing audit logs, or checking command metrics.
  Do NOT use when: Running mutations or turns (those go through app-server), managing app-server lifecycle (use appServerClient), or deploying infrastructure.
  Outputs: ShellExecutionResult with stdout/stderr, exit code, duration, audit ID.
  Success criteria: Command completes within timeout, exit code matches expectations, no policy violations.
---

# Shell Tool Skill

## Purpose
Unified command execution gateway with safety controls: allowlist + denylist enforcement, per-task policies, concurrency limits, timeout enforcement, and structured audit logging.

## Tools
- `execute_shell_command` — Run a command in a task workspace with full safety controls. Returns a jobId.
- `set_shell_policy` — Set per-task execution policy (extend allowlist, add denylist, set limits).
- `get_shell_policy` — Get a task's execution policy.
- `remove_shell_policy` — Remove a task's policy (revert to global defaults).
- `list_shell_policies` — List all per-task policies.
- `get_shell_audit_log` — Get recent command execution audit entries.
- `get_shell_metrics` — Get execution metrics (success/fail rates, durations).
- `get_shell_config` — Get gateway configuration.
- `is_shell_enabled` — Check feature flag.
- `clear_shell_audit` — Clear audit log (for GC).

## Safety Controls

### 1. Binary Allowlist (Global)
Only these binaries can be executed: `pnpm`, `node`, `git`, `npx`, `bash`.
Per-task policies can EXTEND this list (additive), never subtract.

### 2. Binary Denylist (Per-Task)
Task policies can explicitly deny specific binaries that would otherwise be allowed.

### 3. Pattern Denylist (Global + Per-Task)
Regex patterns that block dangerous commands:
- `rm -rf /` (destructive root delete)
- `mkfs` (disk formatting)
- `dd if=` (raw disk write)
- Fork bomb patterns

### 4. Concurrency Limits
- Global: max 10 concurrent commands
- Per-task: max 5 (configurable via policy)

### 5. Timeouts
- Default: 120 seconds per command
- Configurable per-task via policy (1s–600s range)

### 6. Audit Trail
Every command is logged with: taskId, command, cwd, exit code, duration, output sizes.
FIFO eviction at 5000 entries to prevent disk fill.

## Output Template
```json
{
  "command": ["pnpm", "verify"],
  "cwd": "/workspaces/task-123",
  "exitCode": 0,
  "stdout": "...",
  "stderr": "",
  "durationMs": 4523,
  "killed": false,
  "auditId": "audit_a1b2c3d4e5f6g7h8"
}
```

## Feature Flag
Set `SHELL_TOOL_ENABLED=false` to disable all shell MCP tools.
Default: enabled (true).

## Negative Examples (Do NOT do these)
- ❌ Bypassing the gateway to call workspaceManager directly for new features
- ❌ Adding binaries to the global allowlist without security review
- ❌ Setting per-task timeout > 600s (hard cap)
- ❌ Ignoring audit entries for failed commands (investigate root cause)
- ❌ Running destructive commands (rm -rf, mkfs) even if they pass allowlist

## Edge Cases
- If workspace doesn't exist, workspaceManager throws (gateway propagates)
- If command times out, result has `killed: true` and exitCode 137
- If concurrency limit hit, immediate error (no queuing)
- If SHELL_TOOL_ENABLED=false, all execute calls throw immediately
