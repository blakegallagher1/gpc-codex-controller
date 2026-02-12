---
name: review
description: |
  Use when: Running automated code review on a task's diff, checking PR quality before merge, or running iterative review→fix loops.
  Do NOT use when: Implementing features (use gpc-cres-mutation), fixing verification failures (use gpc-cres-fix), or updating documentation (use gpc-cres-doc-gardening).
  Outputs: ReviewResult with findings categorized by severity, approval status.
  Success criteria: Zero errors in findings. Warnings and suggestions do not block approval.
---

# PR Review Skill

## Purpose
Automated pull request review using structured diff analysis against project conventions.

## Tools
- `review_pr` — Run a one-shot review on a task's current diff. Returns findings with severity levels.
- `run_review_loop` — Ralph Wiggum Loop: iterative review→fix cycle until the review passes or maxRounds reached.

## Review Checklist
1. **Type safety** — No `any` casts, no `@ts-ignore` without justification
2. **Import hygiene** — No circular imports, no reaching into internal modules
3. **Secret safety** — No hardcoded tokens, passwords, or API keys in diff
4. **orgId scoping** — Every tenant-sensitive query includes `orgId` filtering
5. **TODO/FIXME** — Flag any new TODO/FIXME comments for tracking
6. **Naming conventions** — Files use camelCase, exports match file names
7. **Error handling** — All async paths have try/catch or `.catch()`
8. **Test coverage** — New logic should have corresponding test assertions
9. **Workspace boundaries** — No cross-package relative imports

## Severity Levels
- **error** — Must fix before merge (type unsafety, secrets, broken imports, missing orgId)
- **warning** — Should fix (TODOs, missing error handling, weak typing)
- **suggestion** — Nice to have (naming style, comment quality)

## Approval Criteria
A review is `approved: true` when there are **zero errors**. Warnings and suggestions do not block.

## Ralph Wiggum Loop
The review loop runs up to `maxRounds` (default 3):
1. Generate diff review
2. If approved → done
3. If not → send fix instructions to Codex agent
4. Re-review the new diff
5. Repeat until approved or rounds exhausted

## Output Template
```json
{
  "taskId": "task-123",
  "timestamp": "2025-01-15T10:30:00Z",
  "findings": [
    {
      "file": "packages/api/src/routes/deals.ts",
      "line": 42,
      "severity": "error",
      "message": "Missing orgId filter in Prisma query — cross-tenant data leak risk",
      "rule": "orgid-scoping"
    }
  ],
  "errorCount": 1,
  "warningCount": 0,
  "suggestionCount": 0,
  "approved": false
}
```

## Negative Examples (Do NOT flag these)
- ❌ Flagging `as const` assertions as type unsafety (they're fine)
- ❌ Flagging `@ts-expect-error` with a comment explaining why (intentional suppression)
- ❌ Reviewing files outside the task's diff (scope creep)
- ❌ Suggesting refactors during a review (reviews are for correctness, not style)
- ❌ Blocking on warnings when there are zero errors (approved should be true)

## Edge Cases
- If the diff is empty, return `approved: true` with zero findings
- If a file was deleted, skip review for that file
- If the diff contains only test files, relax the "orgId scoping" check
- If a TODO is in test code, classify as suggestion (not warning)
