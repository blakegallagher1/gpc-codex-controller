---
route-when:
  - "build this feature end to end"
  - "implement X autonomously"
  - "run the full pipeline"
  - "autonomous"
  - "end-to-end"
  - "auto-build"
  - "build and ship"
  - "implement and PR"
dont-route-when:
  - "just run tests"
  - "fix this one file"
  - "review my PR"
  - "run verify"
---

# Autonomous End-to-End Agent

Drives a fully autonomous coding workflow: decompose objective into phases, create isolated workspace, execute multi-phase implementation via Codex, verify after each phase, fix failures automatically, score quality, commit, open PR, and run automated review loop — all without human intervention.

## When to use

- Complex features requiring analysis, implementation, testing, and verification
- End-to-end feature delivery without human intervention
- Multi-phase coding tasks where each phase builds on the last
- Any time you want "give it an objective and come back when it's done"

## When NOT to use

- Simple one-line fixes (use `mutation/run` or `fix/untilGreen`)
- Just running tests (use `verify/run`)
- Manual PR review (use `review/run`)
- Parallel independent tasks (use `task/parallel`)

## Workflow

1. **Planning** — Creates task (workspace + branch + thread), generates execution plan
2. **Execution** — For each phase:
   - Builds enriched prompt (skill routing + memory + secrets + reference docs + phase context)
   - Sends to Codex via appServerClient
   - Runs verification (pnpm verify)
   - If fails: enters fix-until-green loop (up to `maxPhaseFixes` iterations)
   - Checkpoints on success
3. **Validation** — Runs composite quality scoring (eval + CI + lint + architecture + docs)
4. **Commit** — Commits all accumulated changes
5. **PR** — Opens GitHub pull request with phase results summary
6. **Review** — Runs automated review loop (review + fix + re-review)

## Parameters

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `objective` | string | *required* | High-level description of what to build |
| `maxPhaseFixes` | number | 3 | Max fix iterations per phase |
| `qualityThreshold` | number | 0 | Minimum quality score (0-1) to pass |
| `autoCommit` | boolean | true | Auto-commit on success |
| `autoPR` | boolean | true | Auto-create PR |
| `autoReview` | boolean | true | Auto-run review loop |

## Output Template

```json
{
  "runId": "run_abc123def456",
  "taskId": "auto-run_abc123def456",
  "objective": "Add JWT authentication to the API",
  "status": "completed",
  "phases": [
    { "phaseName": "Analysis", "status": "completed", "fixIterations": 0 },
    { "phaseName": "Implementation", "status": "completed", "fixIterations": 2 },
    { "phaseName": "Testing", "status": "completed", "fixIterations": 1 },
    { "phaseName": "Verification", "status": "completed", "fixIterations": 0 }
  ],
  "qualityScore": 0.85,
  "commitHash": "a1b2c3d",
  "prUrl": "https://github.com/org/repo/pull/42",
  "reviewPassed": true
}
```

## Edge Cases

- If ALL phases fail, the run fails with no commit
- If SOME phases fail, the run still commits and PRs the successful changes
- Cancellation is cooperative — checked between phases
- Quality threshold of 0 means "skip quality gate"
- Each phase gets its own enriched prompt with accumulated context from previous phases
- The orchestrator reuses the same thread across all phases for context continuity

## Invocation

**MCP:** `start_autonomous_run` (returns jobId) → poll with `get_job`
**RPC:** `autonomous/start` (async, returns jobId) → poll with `job/get`
**Poll status:** `get_autonomous_run` / `autonomous/get`
**Cancel:** `cancel_autonomous_run` / `autonomous/cancel`
**List runs:** `list_autonomous_runs` / `autonomous/list`
