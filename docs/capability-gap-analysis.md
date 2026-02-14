# Capability Gap Analysis: gpc-codex-controller vs. OpenAI Harness Engineering

Based on analysis of:
- [Harness engineering: leveraging Codex in an agent-first world](https://openai.com/index/harness-engineering/)
- [Unlocking the Codex harness: how we built the App Server](https://openai.com/index/unlocking-the-codex-harness/)

---

## Executive Summary

The OpenAI Harness team shipped ~1M lines of code across 1,500 PRs in five months with **zero manually-written code**. Their core insight: the engineering job shifts from writing code to **designing environments, feedback loops, and scaffolding** that make agents effective. Comparing their approach to our `gpc-codex-controller`, seven major capability gaps emerge.

---

## Gap 1: Chrome DevTools Protocol (CDP) Integration — STUB, NOT FUNCTIONAL

**What Harness does:** They wired the Chrome DevTools Protocol directly into the agent runtime and built skills for DOM snapshots, screenshots, and navigation. Codex can boot the app, take a screenshot, inspect console errors, validate CSS/layout, reproduce visual bugs, and confirm UI fixes — all autonomously.

**What we have:** `src/cdpBridge.ts` is an empty stub. Every method returns `"not yet implemented"`. The `connect()` method doesn't actually open a WebSocket. `captureScreenshot()` and `getConsoleErrors()` return hardcoded placeholder objects.

**Impact:** Our agent is **blind to the UI**. It can only validate code through linting, type-checking, and unit tests. It cannot:
- Reproduce visual/layout bugs
- Confirm that a UI change actually renders correctly
- Detect runtime console errors in the browser
- Validate that user flows (click X, see Y) work end-to-end
- Reason about accessibility or responsive behavior

**Remediation:** Implement a real CDP connection using `chrome-remote-interface` or Puppeteer's `CDPSession`. Boot a headless Chrome instance per workspace, connect via WebSocket, and expose screenshot/DOM/console tools to the agent as first-class skills.

---

## Gap 2: Git Worktree-Based Isolation — MISSING ENTIRELY

**What Harness does:** Every Codex task runs in its own `git worktree`. The application is **bootable per worktree**, meaning each agent instance gets a fully isolated checkout with its own running app, its own logs, its own metrics — all ephemeral and torn down on completion. This enables true parallel agent execution on the same repository without clone overhead.

**What we have:** We clone the entire repository for each task into `/workspaces/<taskId>/`. This is a full `git clone`, not a worktree.

**Impact:**
- **Disk usage:** Each task duplicates the entire repo history. For a large monorepo, this is significant.
- **Clone time:** A full clone is far slower than `git worktree add`, which is nearly instant.
- **No shared object store:** Worktrees share the same `.git` directory, so fetches and GC happen once. Our clones are independent.
- **Ephemeral boot:** Harness boots the app per worktree with isolated observability. We have `appBootManager.ts` but it's a single shared boot — no per-task isolation of the running application.

**Remediation:** Maintain a single bare clone of `gpc-cres` and use `git worktree add` for each task. Wire up per-worktree app boot so each agent gets its own running instance.

---

## Gap 3: Application Observability Stack — MISSING

**What Harness does:** Logs, metrics, and traces are exposed to Codex via a **local observability stack that's ephemeral per worktree**. The agent can query structured logs, inspect traces, and read metrics to diagnose issues. When the task completes, the observability data is torn down.

**What we have:** We capture `stdout`/`stderr` from shell commands (limited to 2MB) and parse verification output. There is no structured logging, no metrics collection, no distributed tracing available to the agent. The single reference to "observability" in the codebase is in `issueTriageManager.ts` and it's just a keyword for triage classification.

**Impact:** Our agent cannot:
- Diagnose runtime performance issues
- Trace a request through the application to find where it fails
- Inspect structured application logs to understand behavior
- Correlate errors across services in the monorepo
- Distinguish between a test failure and a runtime regression

**Remediation:** Stand up a lightweight, per-workspace observability stack (e.g., OpenTelemetry Collector + Loki for logs + a simple metrics endpoint). Expose query tools as agent skills so Codex can ask "show me logs from the last 30s where level=error" or "what's the p99 latency of the /api/tenants endpoint."

---

## Gap 4: Hierarchical, Map-Style AGENTS.md — PARTIALLY IMPLEMENTED

**What Harness does:** They explicitly discovered that a monolithic AGENTS.md fails because:
1. It crowds out the actual task context
2. When everything is "important," nothing is
3. It rots instantly — agents can't tell what's still true
4. It's hard to mechanically verify

Their solution: AGENTS.md is a **table of contents**, not an encyclopedia. The real knowledge lives in a structured `docs/` directory that is the system of record. The AGENTS.md points into it.

**What we have:** We deploy a single `templates/AGENTS.md` into each workspace. We have a `docValidator.ts` that checks for stale path references in AGENTS.md, and a `referenceDocManager.ts` for injecting knowledge-base docs into prompts. But the AGENTS.md itself is still a monolithic template, not a navigable map with mechanical freshness checks.

**Impact:** As the target repo grows, the AGENTS.md will bloat, context will be wasted on irrelevant instructions, and drift between the docs and reality will accumulate silently.

**Remediation:** Restructure the deployed AGENTS.md to be a lightweight index that points to scoped, per-domain instruction files. Add mechanical verification: coverage checks (does every package have docs?), freshness checks (has the doc been updated since the code it describes?), and ownership metadata.

---

## Gap 5: Custom Linters with Agent-Targeted Error Messages — PARTIAL

**What Harness does:** They write custom linters and structural tests that enforce architectural rules, naming conventions, file size limits, structured logging patterns, and platform-specific requirements. Critically, **the error messages are written as remediation instructions** — they're designed to be injected directly into agent context so the agent knows exactly how to fix the violation.

**What we have:** We have `linterFramework.ts` (import boundary validation, cross-package rules, relative import depth) and `architectureValidator.ts` (dependency direction, layer boundaries, circular imports). The `evalManager.ts` checks for `any`/`@ts-ignore`. But our lint error messages are generic descriptions, not agent-targeted remediation prompts.

**Impact:** When our agent hits a lint failure, it gets a message like `"Cross-package import violation"` and has to figure out what to do. Harness agents get something like `"Move this import to use the @gpc-cres/shared package boundary. Import from '@gpc-cres/shared/tenancy' instead of '../../../packages/shared/src/tenancy'."` — the fix is in the error.

**Remediation:** Rewrite all custom lint rule error messages to include specific remediation steps. When the linter detects a violation, the message should tell the agent exactly what to change, including the correct import path, naming convention, or architectural pattern.

---

## Gap 6: True Multi-Agent Parallelism — SHALLOW

**What Harness does:** The Codex app is a "command center for agentic coding" — it orchestrates **many Codex agents in parallel**, each in its own worktree with its own running app instance. Agents work on independent tasks side-by-side. The Harness team regularly runs single Codex tasks for **6+ hours** while humans sleep. They sustain 3.5 PRs per engineer per day.

**What we have:** We have `runParallel()` with `DEFAULT_MAX_PARALLEL = 3` and a simple Promise.allSettled fan-out. But each parallel task still does a full repo clone. There's no shared Codex App Server instance management, no resource-aware scheduling, and no ability to monitor/steer multiple long-running agents from a unified interface. The turn budget is capped at 5 — far too low for complex, multi-hour tasks.

**Impact:** Our parallelism is mechanical (run N mutations concurrently) rather than architectural (N independent agents with isolated environments, shared resources, and unified monitoring). The 5-turn budget prevents the kind of sustained, multi-hour autonomous work that Harness relies on.

**Remediation:** Increase/make configurable the turn budget for autonomous runs. Implement worktree-based isolation (Gap 2) to make parallelism cheap. Add a dashboard/monitoring layer that shows all running agents, their progress, resource usage, and allows human steering without interrupting execution.

---

## Gap 7: Agent-to-Agent Code Review — MISSING

**What Harness does:** Over time, they pushed **almost all review effort to being handled agent-to-agent**. Humans may review PRs but aren't required to. This is what enabled their throughput of 1,500 PRs in five months.

**What we have:** We have `prReviewManager.ts` which runs automated checks (type safety, orgId compliance, import boundaries, etc.) and a `runReviewLoop` that iterates review-then-fix up to 3 rounds. But this is a single-agent reviewing its own work — it's self-review, not cross-agent review. There's no concept of a separate "reviewer agent" with different instructions, a different perspective, or adversarial incentives.

**Impact:** Self-review has diminishing returns. The same agent that wrote the code has the same blind spots when reviewing it. A dedicated reviewer agent with different system prompts (focused on security, architecture, or correctness) would catch issues the author agent misses.

**Remediation:** Implement a dedicated reviewer agent persona — a separate Codex session with review-focused system prompts that is invoked after the author agent finishes. The reviewer should be adversarial: its job is to find problems, not to rubber-stamp. Route review findings back to the author agent for fixes, then re-review.

---

## Priority Matrix

| Gap | Severity | Implementation Effort | Impact on Agent Effectiveness |
|-----|----------|----------------------|-------------------------------|
| 1. CDP Integration | High | Medium | Unlocks UI-aware agent work |
| 2. Git Worktrees | High | Low | Faster, cheaper parallelism |
| 3. Observability Stack | High | Medium | Runtime diagnosis capability |
| 4. Hierarchical AGENTS.md | Medium | Low | Better context utilization |
| 5. Agent-Targeted Lint Messages | Medium | Low | Faster fix loops |
| 6. True Multi-Agent Parallelism | High | High | Throughput multiplier |
| 7. Agent-to-Agent Review | Medium | Medium | Quality without human bottleneck |

---

## Recommended Implementation Order

1. **Git Worktrees** (Gap 2) — Low effort, foundational for Gaps 1, 3, and 6
2. **Agent-Targeted Lint Messages** (Gap 5) — Low effort, immediate fix-loop speedup
3. **Hierarchical AGENTS.md** (Gap 4) — Low effort, prevents context rot
4. **CDP Integration** (Gap 1) — Medium effort, high unlock
5. **Observability Stack** (Gap 3) — Medium effort, requires per-worktree infra from Gap 2
6. **Agent-to-Agent Review** (Gap 7) — Medium effort, removes human review bottleneck
7. **True Multi-Agent Parallelism** (Gap 6) — High effort, builds on all previous gaps

---

*Analysis date: 2026-02-14*
*Sources: [Harness engineering](https://openai.com/index/harness-engineering/), [Unlocking the Codex harness](https://openai.com/index/unlocking-the-codex-harness/)*
