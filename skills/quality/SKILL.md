# Quality Score Skill

## Purpose
Composite quality scoring that aggregates all quality signals into a single 0–100 score per task.

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

| Range  | Label     | Meaning |
|--------|-----------|---------|
| 90–100 | Excellent | Ship-ready, all signals green |
| 75–89  | Good      | Minor issues, safe to merge with review |
| 50–74  | Fair      | Needs attention before merge |
| 25–49  | Poor      | Significant issues, fix before proceeding |
| 0–24   | Critical  | Major failures across multiple dimensions |

## Defaults
When a component has no data (e.g., no CI runs yet), it scores 50 (neutral) to avoid penalizing new tasks.

## Usage Pattern
```
1. start_task("implement feature X")
2. fix_until_green(taskId)
3. get_quality_score(taskId)    ← check composite
4. If score < 75 → run_review_loop → fix → re-score
5. If score ≥ 75 → create_pr
```
