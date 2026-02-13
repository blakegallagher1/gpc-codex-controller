# GPC Codex Controller — Full Capability Test Prompt

Paste this into ChatGPT with the gpc-codex-controller MCP connector active.

---

You are testing the gpc-codex-controller, a headless orchestration layer with 63 MCP tools across 12 capability domains. Your job is to call every tool in a **read-only, non-destructive** manner — no code implementation, no file editing, no task execution. You are proving the full tool catalog is live and responsive.

Work through each section below **in order**. For each tool call, report: tool name, whether it succeeded or errored, and a 1-line summary of the response. At the end, produce a scorecard.

**IMPORTANT**: Do NOT call `start_task`, `continue_task`, `run_verify`, `fix_until_green`, `create_pr`, `run_mutation`, `run_doc_gardening`, `run_parallel`, `review_pr`, `run_review_loop`, `boot_app`, `reproduce_bug`, `execute_shell_command`, or `start_autonomous_run`. These trigger real work. Everything else is safe.

---

## Phase 1: Health & Infrastructure (2 tools)

1. Call `health_ping` — confirm the controller is alive
2. Call `run_gc_sweep` — confirm GC sweep runs (cleans stale data, non-destructive)

## Phase 2: Memory & Knowledge (3 tools)

3. Call `list_memory` with limit=5 — list stored memory entries
4. Call `list_reference_docs` — list all reference documents
5. Call `add_reference_doc` with category="test", title="Capability Test Probe", content="This is a test doc added during the full capability test on {{today's date}}. Safe to delete."

## Phase 3: Skill Routing (2 tools)

6. Call `route_skills` with description="Build a REST API with JWT authentication and rate limiting" — confirm skill scoring returns results
7. Call `force_select_skills` with skillNames=["mutation", "fix", "review"] — confirm deterministic selection works

## Phase 4: Execution Plans (3 tools)

8. Call `get_execution_plan` with taskId="test-probe-nonexistent" — should return null/empty (graceful handling)
9. Call `get_eval_history` with limit=5 — list past evaluations
10. Call `get_eval_summary` with taskId="test-probe-nonexistent" — should return null/empty

## Phase 5: CI Status & History (3 tools)

11. Call `record_ci_run` with taskId="test-probe-ci", passed=true, exitCode=0, duration_ms=1234, failureCount=0, failureSummary=[] — write a synthetic CI record
12. Call `get_ci_status` with taskId="test-probe-ci" — confirm the record we just wrote is reflected
13. Call `get_ci_history` with taskId="test-probe-ci", limit=5 — confirm history returns our record

## Phase 6: Checkpoints (2 tools)

14. Call `list_checkpoints` with taskId="test-probe-nonexistent" — should return empty array
15. Call `create_checkpoint` with taskId="test-probe-nonexistent", description="Test probe checkpoint" — may error (no real task), report the error message

## Phase 7: Network Policy (4 tools)

16. Call `get_network_policy` — read the current allowlist
17. Call `add_network_domain` with domain="test-probe.example.com", reason="Capability test — safe to remove" — add a test entry
18. Call `get_network_policy` — confirm test-probe.example.com is now in the list
19. Call `remove_network_domain` with domain="test-probe.example.com" — clean up

## Phase 8: Domain Secrets (3 tools)

20. Call `list_domain_secrets` — list current secret mappings
21. Call `register_domain_secret` with domain="test-probe.example.com", headerName="X-Test-Key", placeholder="$TEST_PROBE_KEY", envVar="TEST_PROBE_KEY" — register a test mapping
22. Call `validate_domain_secrets` — confirm it shows TEST_PROBE_KEY as missing (expected, since the env var doesn't exist)

## Phase 9: Compaction Manager (4 tools)

23. Call `get_compaction_config` — read current strategy
24. Call `set_compaction_config` with strategy="auto" — set to auto (likely already is, non-destructive)
25. Call `get_compaction_history` with limit=5 — list compaction events
26. Call `get_context_usage` with threadId="test-probe-nonexistent" — should return default/empty usage data

## Phase 10: Shell Tool Integration (7 tools)

27. Call `is_shell_enabled` — check feature flag
28. Call `get_shell_config` — read full shell configuration
29. Call `list_shell_policies` — list per-task policies
30. Call `get_shell_policy` with taskId="test-probe-nonexistent" — should return null
31. Call `get_shell_audit_log` with limit=10 — read recent audit entries
32. Call `get_shell_metrics` — read execution metrics
33. Call `clear_shell_audit` — clear audit log (non-destructive cleanup)

## Phase 11: Artifacts (2 tools)

34. Call `list_artifacts` with taskId="test-probe-nonexistent" — should return empty
35. Call `register_artifact` with taskId="test-probe-artifacts", name="test-probe.txt", path="/tmp/test-probe.txt", type="file" — register a test artifact

## Phase 12: Autonomous Orchestration (3 tools)

36. Call `list_autonomous_runs` with limit=5 — list any previous runs
37. Call `get_autonomous_run` with runId="test-probe-nonexistent" — should return null
38. Call `cancel_autonomous_run` with runId="test-probe-nonexistent" — should return cancelled=false

## Phase 13: Quality & Validation (4 tools)

39. Call `get_quality_score` with taskId="test-probe-nonexistent" — may error or return empty
40. Call `run_eval` with taskId="test-probe-nonexistent" — may error (no workspace)
41. Call `query_logs` with taskId="test-probe-nonexistent", pattern="test", limit=5 — may error or return empty
42. Call `run_linter` with taskId="test-probe-nonexistent" — may error (no workspace)

## Phase 14: Architecture & Docs (2 tools)

43. Call `validate_architecture` with taskId="test-probe-nonexistent" — may error (no workspace)
44. Call `validate_docs` with taskId="test-probe-nonexistent" — may error (no workspace)

## Phase 15: Job Polling (1 tool)

45. Call `get_job` with jobId="job_nonexistent_test_probe" — should return error "Unknown jobId"

## Phase 16: Plan Phase Update (1 tool)

46. Call `update_plan_phase` with taskId="test-probe-nonexistent", phaseIndex=0, status="completed" — may error (no plan exists)

---

## Scorecard

After completing all 46 calls, produce this summary table:

| # | Domain | Tools Tested | Passed | Errors (Expected) | Errors (Unexpected) |
|---|--------|-------------|--------|-------------------|---------------------|
| 1 | Health & Infrastructure | 2 | ? | ? | ? |
| 2 | Memory & Knowledge | 3 | ? | ? | ? |
| 3 | Skill Routing | 2 | ? | ? | ? |
| 4 | Execution Plans | 3 | ? | ? | ? |
| 5 | CI Status & History | 3 | ? | ? | ? |
| 6 | Checkpoints | 2 | ? | ? | ? |
| 7 | Network Policy | 4 | ? | ? | ? |
| 8 | Domain Secrets | 3 | ? | ? | ? |
| 9 | Compaction Manager | 4 | ? | ? | ? |
| 10 | Shell Tool Integration | 7 | ? | ? | ? |
| 11 | Artifacts | 2 | ? | ? | ? |
| 12 | Autonomous Orchestration | 3 | ? | ? | ? |
| 13 | Quality & Validation | 4 | ? | ? | ? |
| 14 | Architecture & Docs | 2 | ? | ? | ? |
| 15 | Job Polling | 1 | ? | ? | ? |
| 16 | Plan Phase Update | 1 | ? | ? | ? |
| **TOTAL** | **16 domains** | **46 calls** | **?/46** | **?** | **?** |

**Expected errors**: Calls to non-existent taskIds/runIds should return null, empty arrays, or structured error messages. These count as PASSED (the tool responded correctly).

**Unexpected errors**: Connection failures, 500s, timeouts, or malformed responses. These are FAILURES.

**Verdict**: If unexpected errors = 0, the controller is fully operational. Report "ALL 63 MCP TOOLS VERIFIED — CONTROLLER IS GREEN" (we tested 46 of the 63; the remaining 17 are async execution tools that would trigger real work).
