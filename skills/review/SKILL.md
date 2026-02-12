# PR Review Skill

## Purpose
Automated pull request review using structured analysis of diffs against project conventions.

## Tools
- `review_pr` — Run a one-shot review on a task's current diff. Returns findings with severity levels.
- `run_review_loop` — Ralph Wiggum Loop: iterative review→fix cycle until the review passes or maxRounds reached.

## Review Checklist
1. **Type safety** — No `any` casts, no `@ts-ignore` without justification
2. **Import hygiene** — No circular imports, no reaching into internal modules
3. **Secret safety** — No hardcoded tokens, passwords, or API keys in diff
4. **TODO/FIXME** — Flag any new TODO/FIXME comments for tracking
5. **Naming conventions** — Files use camelCase, exports match file names
6. **Error handling** — All async paths have try/catch or `.catch()`
7. **Test coverage** — New logic should have corresponding test assertions

## Severity Levels
- **error** — Must fix before merge (type unsafety, secrets, broken imports)
- **warning** — Should fix (TODOs, missing error handling)
- **suggestion** — Nice to have (naming, style)

## Approval Criteria
A review is `approved: true` when there are **zero errors**. Warnings and suggestions do not block.

## Ralph Wiggum Loop
The review loop runs up to `maxRounds` (default 3):
1. Generate diff review
2. If approved → done
3. If not → send fix instructions to Codex agent
4. Re-review the new diff
5. Repeat until approved or rounds exhausted
