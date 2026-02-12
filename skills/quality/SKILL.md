---
name: quality
description: |
  Use when: Checking overall task quality before merge, running quality gates, or monitoring quality trends.
  Do NOT use when: Running individual checks (use run_linter, validate_architecture, etc. directly), implementing features, or fixing code.
  Outputs: QualityScore with overall 0–100 score and per-dimension breakdown.
  Success criteria: Overall score ≥ 75 for merge-ready code.
---

# Quality Score Skill

## Purpose
Composite quality scoring that aggregates all quality signals into a single 0–100 score per task. This is the quality gate — the single number that answers "is this ready to ship?"

## Tools
- `get_quality_score` — Returns overall score + breakdown for a task.
- `run_eval` — Run evaluation checks (feeds into quality score).
- `get_ci_status` — CI pass rate (feeds into quality score).
- `run_linter` — Lint results (feeds into quality score).
- `validate_architecture` — Architecture validation (feeds into quality score).
- `validate_docs` — Documentation validation (feeds into quality score).

## Score Components & Weights

| Component      | Weight | Source                | Scoring |
|---------------|--------|-----------------------|---------|
| Eval          | 30%    | `evalManager`         | % of checks passed × 100 |
| CI            | 25%    | `ciStatusManager`     | Pass rate × 100 |
| Lint          | 20%    | `linterFramework`     | 100 - (errors×10 + warnings×3), min 0 |
| Architecture  | 15%    | `architectureValidator`| 100 if passed, 0 if violations |
| Documentation | 10%    | `docValidator`        | 100 if passed, 0 if issues |

## Score Interpretation

| Range  | Label     | Action |
|--------|-----------|--------|
| 90–100 | Excellent | Ship immediately. All signals green. |
| 75–89  | Good      | Safe to merge with standard review. Minor issues only. |
| 50–74  | Fair      | Needs attention. Run `run_review_loop` before merge. |
| 25–49  | Poor      | Significant issues. Run `fix_until_green` + targeted fixes. |
| 0–24   | Critical  | Major failures across multiple dimensions. Investigate root cause. |

## Output Template
```json
{
  "taskId": "task-123",
  "overall": 82,
  "breakdown": {
    "eval": 90,
    "ci": 80,
    "lint": 85,
    "architecture": 100,
    "docs": 50
  },
  "timestamp": "2025-01-15T10:30:00Z"
}
```

## Defaults
When a component has no data (e.g., no CI runs yet), it scores 50 (neutral) to avoid penalizing new tasks.

## Recommended Workflow
```
1. start_task("implement feature X")
2. fix_until_green(taskId)
3. get_quality_score(taskId)          ← check composite
4. If score < 75 → run_review_loop   ← iterate on issues
5. get_quality_score(taskId)          ← re-check
6. If score ≥ 75 → create_pr         ← ship it
```

## Negative Examples (Do NOT do these)
- ❌ Shipping code with quality score < 50 without explicit override
- ❌ Ignoring the breakdown — a 75 overall with 0 architecture means there are violations
- ❌ Running quality score on a task that hasn't been verified yet (run verify first)
- ❌ Using quality score as the ONLY gate — human review is still needed for complex changes

## Edge Cases
- New tasks with no history get neutral (50) scores for missing components
- If eval checks don't exist for the task type, eval component scores 50
- Architecture score is binary: 100 (pass) or 0 (any violations)
- Doc score is binary: 100 (pass) or 0 (any issues)
