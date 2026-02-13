/**
 * MCP Streamable HTTP adapter for the gpc-codex-controller.
 *
 * Wraps existing Controller methods as MCP tools so the controller
 * can be registered as a ChatGPT App (New App → MCP Server URL).
 *
 * Long-running operations return a jobId immediately; callers poll
 * with the `get_job` tool — same pattern as the JSON-RPC /rpc endpoint.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type http from "node:http";
import crypto from "node:crypto";
import { z } from "zod";
import type { Controller } from "./controller.js";

/* ------------------------------------------------------------------ */
/*  Shared job store types (same shape as rpcServer.ts)                */
/* ------------------------------------------------------------------ */

type JobStatus = "queued" | "running" | "succeeded" | "failed";

export interface JobRecord {
  jobId: string;
  status: JobStatus;
  method: string;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  result?: unknown;
  error?: string;
}

function newJobId(): string {
  return `job_${crypto.randomBytes(12).toString("hex")}`;
}

/* ------------------------------------------------------------------ */
/*  Factory                                                            */
/* ------------------------------------------------------------------ */

export function createMcpHandler(
  controller: Controller,
  jobs: Map<string, JobRecord>,
): (req: http.IncomingMessage, res: http.ServerResponse) => Promise<void> {
  const mcp = new McpServer({
    name: "gpc-codex-controller",
    version: "0.1.0",
  });

  /* ---- helper: enqueue an async job and return the id ------------ */
  function enqueue(method: string, fn: () => Promise<unknown>): { accepted: true; jobId: string } {
    const job: JobRecord = {
      jobId: newJobId(),
      status: "queued",
      method,
      createdAt: new Date().toISOString(),
      startedAt: null,
      finishedAt: null,
    };
    jobs.set(job.jobId, job);

    void (async () => {
      job.status = "running";
      job.startedAt = new Date().toISOString();
      try {
        job.result = await fn();
        job.status = "succeeded";
      } catch (error) {
        job.error = error instanceof Error ? error.message : String(error);
        job.status = "failed";
      } finally {
        job.finishedAt = new Date().toISOString();
      }
    })();

    return { accepted: true, jobId: job.jobId };
  }

  function textResult(data: unknown) {
    return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
  }

  /* ================================================================ */
  /*  Tool registrations                                               */
  /* ================================================================ */

  /* -- Async tools (return jobId) ---------------------------------- */

  mcp.tool(
    "start_task",
    "Start a new Codex coding task. Returns a jobId — poll with get_job.",
    { prompt: z.string().describe("Natural-language task description") },
    async ({ prompt }) => textResult(enqueue("task/start", () => controller.startTask(prompt))),
  );

  mcp.tool(
    "continue_task",
    "Send follow-up instructions to an existing task thread. Returns a jobId.",
    {
      threadId: z.string().describe("Thread ID from a previous start_task result"),
      prompt: z.string().describe("Follow-up instruction"),
    },
    async ({ threadId, prompt }) =>
      textResult(enqueue("task/continue", () => controller.continueTask(threadId, prompt))),
  );

  mcp.tool(
    "run_verify",
    "Run the project test suite / verification step. Returns a jobId.",
    { taskId: z.string().describe("Task ID to verify") },
    async ({ taskId }) => textResult(enqueue("verify/run", () => controller.runVerify(taskId))),
  );

  mcp.tool(
    "fix_until_green",
    "Iteratively fix code until tests pass (up to maxIterations). Returns a jobId.",
    {
      taskId: z.string().describe("Task ID to fix"),
      maxIterations: z.number().int().min(1).max(20).default(5).describe("Max fix iterations"),
    },
    async ({ taskId, maxIterations }) =>
      textResult(enqueue("fix/untilGreen", () => controller.fixUntilGreen(taskId, maxIterations))),
  );

  mcp.tool(
    "create_pr",
    "Create a GitHub pull request for the task's branch. Returns a jobId.",
    {
      taskId: z.string().describe("Task ID"),
      title: z.string().describe("PR title"),
      body: z.string().default("").describe("PR body (markdown)"),
    },
    async ({ taskId, title, body }) =>
      textResult(enqueue("pr/create", async () => {
        const prUrl = await controller.createPullRequest(taskId, title, body);
        return { prUrl };
      })),
  );

  mcp.tool(
    "run_mutation",
    "Apply a feature mutation to an existing task. Returns a jobId.",
    {
      taskId: z.string().describe("Task ID to mutate"),
      featureDescription: z.string().describe("Description of the feature to add"),
    },
    async ({ taskId, featureDescription }) =>
      textResult(enqueue("mutation/run", () => controller.runMutation(taskId, featureDescription))),
  );

  mcp.tool(
    "run_doc_gardening",
    "Auto-update project documentation (README, AGENTS.md, etc.). Returns a jobId.",
    { taskId: z.string().describe("Task ID") },
    async ({ taskId }) =>
      textResult(enqueue("garden/run", () => controller.runDocGardening(taskId))),
  );

  mcp.tool(
    "run_parallel",
    "Execute multiple mutation tasks in parallel. Returns a jobId.",
    {
      tasks: z.array(z.object({
        taskId: z.string().describe("Task ID"),
        featureDescription: z.string().describe("Feature to implement"),
      })).min(1).describe("Array of tasks to run concurrently"),
    },
    async ({ tasks }) =>
      textResult(enqueue("task/parallel", () => controller.runParallel(tasks))),
  );

  /* -- New async tools (Harness Engineering capabilities) ----------- */

  mcp.tool(
    "review_pr",
    "Run automated PR review on a task's diff. Returns a jobId.",
    { taskId: z.string().describe("Task ID to review") },
    async ({ taskId }) => textResult(enqueue("review/run", () => controller.reviewPR(taskId))),
  );

  mcp.tool(
    "run_review_loop",
    "Iterative review→fix loop until review passes (Ralph Wiggum Loop). Returns a jobId.",
    {
      taskId: z.string().describe("Task ID"),
      maxRounds: z.number().int().min(1).max(10).default(3).describe("Max review/fix rounds"),
    },
    async ({ taskId, maxRounds }) =>
      textResult(enqueue("review/loop", () => controller.runReviewLoop(taskId, maxRounds))),
  );

  mcp.tool(
    "boot_app",
    "Start the app in a task workspace and wait for health check. Returns a jobId.",
    { taskId: z.string().describe("Task ID") },
    async ({ taskId }) => textResult(enqueue("app/boot", () => controller.bootApp(taskId))),
  );

  mcp.tool(
    "reproduce_bug",
    "Create a minimal reproduction test for a bug. Returns a jobId.",
    {
      taskId: z.string().describe("Task ID for the reproduction workspace"),
      bugDescription: z.string().describe("Description of the bug to reproduce"),
    },
    async ({ taskId, bugDescription }) =>
      textResult(enqueue("bug/reproduce", () => controller.reproduceBug(taskId, bugDescription))),
  );

  /* -- Sync tools (return immediately) ----------------------------- */

  mcp.tool(
    "get_job",
    "Poll the status of an async job by its jobId. Returns status, result, or error.",
    { jobId: z.string().describe("Job ID returned by an async tool") },
    async ({ jobId }) => {
      const job = jobs.get(jobId.trim());
      if (!job) {
        return { content: [{ type: "text", text: JSON.stringify({ error: `Unknown jobId: ${jobId}` }) }], isError: true };
      }
      return textResult(job);
    },
  );

  mcp.tool(
    "run_eval",
    "Run quality evaluation checks on a task. Returns results directly.",
    { taskId: z.string().describe("Task ID to evaluate") },
    async ({ taskId }) => textResult(await controller.runEval(taskId)),
  );

  mcp.tool(
    "get_eval_history",
    "Retrieve past evaluation results.",
    { limit: z.number().int().min(1).max(100).default(20).describe("Max entries to return") },
    async ({ limit }) => textResult(await controller.getEvalHistory(limit)),
  );

  mcp.tool(
    "get_eval_summary",
    "Get an evaluation summary for a specific task.",
    { taskId: z.string().describe("Task ID") },
    async ({ taskId }) => textResult(await controller.getEvalSummary(taskId)),
  );

  mcp.tool(
    "list_memory",
    "List stored memory entries, optionally filtered by category.",
    {
      category: z.string().optional().describe("Filter by category"),
      limit: z.number().int().min(1).max(100).default(20).describe("Max entries"),
    },
    async ({ category, limit }) => textResult(await controller.getMemoryEntries(category, limit)),
  );

  mcp.tool(
    "health_ping",
    "Quick health check — confirms the controller is alive.",
    {},
    async () => textResult({ ok: true, ts: new Date().toISOString() }),
  );

  /* -- Execution Plan tools --------------------------------------- */

  mcp.tool(
    "create_execution_plan",
    "Create a structured execution plan for a task.",
    {
      taskId: z.string().describe("Task ID"),
      description: z.string().describe("Description of what the plan should accomplish"),
    },
    async ({ taskId, description }) => textResult(await controller.createExecutionPlan(taskId, description)),
  );

  mcp.tool(
    "get_execution_plan",
    "Get the execution plan for a task.",
    { taskId: z.string().describe("Task ID") },
    async ({ taskId }) => textResult(await controller.getExecutionPlan(taskId)),
  );

  mcp.tool(
    "update_plan_phase",
    "Update the status of a plan phase.",
    {
      taskId: z.string().describe("Task ID"),
      phaseIndex: z.number().int().min(0).describe("Phase index (0-based)"),
      status: z.enum(["pending", "in_progress", "completed", "failed", "skipped"]).describe("New phase status"),
    },
    async ({ taskId, phaseIndex, status }) => textResult(await controller.updatePlanPhase(taskId, phaseIndex, status)),
  );

  /* -- CI Status tools -------------------------------------------- */

  mcp.tool(
    "record_ci_run",
    "Record a CI/verification run result.",
    {
      taskId: z.string().describe("Task ID"),
      passed: z.boolean().describe("Whether the run passed"),
      exitCode: z.number().int().default(0).describe("Process exit code"),
      duration_ms: z.number().int().default(0).describe("Duration in milliseconds"),
      failureCount: z.number().int().default(0).describe("Number of failures"),
      failureSummary: z.array(z.string()).default([]).describe("Summary of failures"),
    },
    async ({ taskId, passed, exitCode, duration_ms, failureCount, failureSummary }) =>
      textResult(await controller.recordCIRun({ taskId, passed, exitCode, duration_ms, failureCount, failureSummary })),
  );

  mcp.tool(
    "get_ci_status",
    "Get CI status summary for a task (last run, pass rate, regressions).",
    { taskId: z.string().describe("Task ID") },
    async ({ taskId }) => textResult(await controller.getCIStatus(taskId)),
  );

  mcp.tool(
    "get_ci_history",
    "Get CI run history for a task.",
    {
      taskId: z.string().describe("Task ID"),
      limit: z.number().int().min(1).max(100).default(20).describe("Max entries"),
    },
    async ({ taskId, limit }) => textResult(await controller.getCIHistory(taskId, limit)),
  );

  /* -- Log Query tools -------------------------------------------- */

  mcp.tool(
    "query_logs",
    "Search workspace logs/git history for a pattern.",
    {
      taskId: z.string().describe("Task ID"),
      pattern: z.string().describe("Search pattern"),
      limit: z.number().int().min(1).max(500).default(100).describe("Max results"),
    },
    async ({ taskId, pattern, limit }) => textResult(await controller.queryLogs(taskId, pattern, limit)),
  );

  /* -- Linter tools ----------------------------------------------- */

  mcp.tool(
    "run_linter",
    "Run linting checks (ESLint + custom rules) on a task workspace.",
    {
      taskId: z.string().describe("Task ID"),
      rules: z.array(z.string()).optional().describe("Specific rules to run (default: all)"),
    },
    async ({ taskId, rules }) => textResult(await controller.runLinter(taskId, rules)),
  );

  /* -- Architecture validation tools ------------------------------ */

  mcp.tool(
    "validate_architecture",
    "Validate architectural rules (dependency direction, layer boundaries, import cycles).",
    { taskId: z.string().describe("Task ID") },
    async ({ taskId }) => textResult(await controller.validateArchitecture(taskId)),
  );

  /* -- Doc validation tools --------------------------------------- */

  mcp.tool(
    "validate_docs",
    "Validate documentation accuracy (stale references, broken links, outdated examples).",
    { taskId: z.string().describe("Task ID") },
    async ({ taskId }) => textResult(await controller.validateDocs(taskId)),
  );

  /* -- Quality Score tools ---------------------------------------- */

  mcp.tool(
    "get_quality_score",
    "Get composite quality score (eval + CI + lint + architecture + docs).",
    { taskId: z.string().describe("Task ID") },
    async ({ taskId }) => textResult(await controller.getQualityScore(taskId)),
  );

  /* -- GC Sweep tools --------------------------------------------- */

  mcp.tool(
    "run_gc_sweep",
    "Clean up stale workspaces and old job data.",
    {},
    async () => textResult(await controller.runGCSweep()),
  );

  /* -- Checkpoint tools ------------------------------------------- */

  mcp.tool(
    "create_checkpoint",
    "Create a checkpoint for a long-running task.",
    {
      taskId: z.string().describe("Task ID"),
      description: z.string().default("Manual checkpoint").describe("Checkpoint description"),
    },
    async ({ taskId, description }) => textResult(await controller.checkpointTask(taskId, description)),
  );

  mcp.tool(
    "list_checkpoints",
    "List all checkpoints for a task.",
    { taskId: z.string().describe("Task ID") },
    async ({ taskId }) => textResult(await controller.getTaskCheckpoints(taskId)),
  );

  /* -- Reference Doc tools ---------------------------------------- */

  mcp.tool(
    "list_reference_docs",
    "List stored reference documents, optionally filtered by category.",
    { category: z.string().optional().describe("Filter by category") },
    async ({ category }) => textResult(await controller.getReferenceDocs(category)),
  );

  mcp.tool(
    "add_reference_doc",
    "Add a reference document for context enrichment.",
    {
      category: z.string().default("general").describe("Document category"),
      title: z.string().describe("Document title"),
      content: z.string().describe("Document content"),
    },
    async ({ category, title, content }) =>
      textResult(await controller.addReferenceDoc({ category, title, content })),
  );

  /* ================================================================ */
  /*  Article-inspired tools: routing, artifacts, network, secrets     */
  /* ================================================================ */

  mcp.tool(
    "route_skills",
    "Dynamically select the best skills for a task based on description analysis.",
    { description: z.string().describe("Task description to route skills for") },
    async ({ description }) => textResult(await controller.routeSkills(description)),
  );

  mcp.tool(
    "force_select_skills",
    "Deterministically select specific skills by name (bypasses scoring).",
    { skillNames: z.array(z.string()).describe("Skill names to force-select") },
    async ({ skillNames }) => textResult(await controller.forceSelectSkills(skillNames)),
  );

  mcp.tool(
    "collect_artifacts",
    "Collect all artifacts from a task workspace into the handoff directory.",
    { taskId: z.string().describe("Task ID") },
    async ({ taskId }) => textResult(await controller.collectArtifacts(taskId)),
  );

  mcp.tool(
    "list_artifacts",
    "List all registered artifacts for a task.",
    { taskId: z.string().describe("Task ID") },
    async ({ taskId }) => textResult(await controller.getArtifacts(taskId)),
  );

  mcp.tool(
    "register_artifact",
    "Register a specific file as a task artifact.",
    {
      taskId: z.string().describe("Task ID"),
      name: z.string().describe("Artifact name"),
      path: z.string().describe("File path"),
      type: z.enum(["file", "report", "dataset", "screenshot", "log"]).optional().describe("Artifact type"),
    },
    async ({ taskId, name, path, type }) =>
      textResult(await controller.registerArtifact(taskId, name, path, type)),
  );

  mcp.tool(
    "get_network_policy",
    "Get the current org-level network allowlist.",
    {},
    async () => textResult(await controller.getNetworkPolicy()),
  );

  mcp.tool(
    "add_network_domain",
    "Add a domain to the org-level network allowlist.",
    {
      domain: z.string().describe("Domain to allow (e.g., api.example.com)"),
      reason: z.string().default("").describe("Why this domain is needed"),
    },
    async ({ domain, reason }) =>
      textResult(await controller.addNetworkDomain({ domain, reason })),
  );

  mcp.tool(
    "remove_network_domain",
    "Remove a domain from the org-level network allowlist.",
    { domain: z.string().describe("Domain to remove") },
    async ({ domain }) => textResult(await controller.removeNetworkDomain(domain)),
  );

  mcp.tool(
    "register_domain_secret",
    "Register a domain secret mapping (model sees placeholder, runtime injects real value).",
    {
      domain: z.string().describe("Domain this secret applies to"),
      headerName: z.string().describe("HTTP header name (e.g., Authorization)"),
      placeholder: z.string().describe("Placeholder the model sees (e.g., $API_KEY)"),
      envVar: z.string().describe("Env var holding the real value"),
    },
    async (params) => {
      await controller.registerDomainSecret(params);
      return textResult({ ok: true });
    },
  );

  mcp.tool(
    "list_domain_secrets",
    "List registered domain secrets (placeholders only, never real values).",
    {},
    async () => textResult(await controller.getDomainSecrets()),
  );

  mcp.tool(
    "validate_domain_secrets",
    "Check which domain secrets have env vars configured vs missing.",
    {},
    async () => textResult(await controller.validateDomainSecrets()),
  );

  mcp.tool(
    "get_compaction_config",
    "Get current compaction strategy configuration.",
    {},
    async () => textResult(controller.getCompactionConfig()),
  );

  mcp.tool(
    "set_compaction_config",
    "Update compaction strategy (auto, token-threshold, or turn-interval).",
    {
      strategy: z.enum(["auto", "token-threshold", "turn-interval"]).optional().describe("Compaction strategy"),
      tokenThreshold: z.number().optional().describe("Token threshold for token-threshold strategy"),
      autoThresholdPercent: z.number().optional().describe("Context % threshold for auto strategy"),
      turnInterval: z.number().optional().describe("Turn interval for turn-interval strategy"),
    },
    async (params) => {
      const cfg: Record<string, unknown> = {};
      if (params.strategy !== undefined) cfg.strategy = params.strategy;
      if (params.tokenThreshold !== undefined) cfg.tokenThreshold = params.tokenThreshold;
      if (params.autoThresholdPercent !== undefined) cfg.autoThresholdPercent = params.autoThresholdPercent;
      if (params.turnInterval !== undefined) cfg.turnInterval = params.turnInterval;
      return textResult(controller.setCompactionConfig(cfg as Partial<import("./types.js").CompactionConfig>));
    },
  );

  mcp.tool(
    "get_context_usage",
    "Get estimated context window usage for a thread.",
    { threadId: z.string().describe("Thread ID") },
    async ({ threadId }) => textResult(controller.getContextUsage(threadId)),
  );

  mcp.tool(
    "get_compaction_history",
    "Get compaction event history.",
    { limit: z.number().optional().default(20).describe("Max events to return") },
    async ({ limit }) => textResult(await controller.getCompactionHistory(limit)),
  );

  /* ================================================================ */
  /*  Shell Tool Integration                                           */
  /* ================================================================ */

  mcp.tool(
    "execute_shell_command",
    "Execute a shell command in a task workspace with full safety controls (allowlist, denylist, audit). Returns a jobId.",
    {
      taskId: z.string().describe("Task ID (workspace to execute in)"),
      command: z.array(z.string()).min(1).describe("Command tokens (e.g., ['pnpm', 'verify'])"),
      timeoutMs: z.number().int().min(1000).max(600000).optional().describe("Command timeout in ms (default: 120000)"),
      allowNonZeroExit: z.boolean().optional().default(true).describe("If true, non-zero exit doesn't throw"),
    },
    async ({ taskId, command, timeoutMs, allowNonZeroExit }) => {
      const opts: { timeoutMs?: number; allowNonZeroExit?: boolean } = {};
      if (timeoutMs !== undefined) opts.timeoutMs = timeoutMs;
      if (allowNonZeroExit !== undefined) opts.allowNonZeroExit = allowNonZeroExit;
      return textResult(enqueue("shell/execute", () =>
        controller.executeShellCommand(taskId, command, opts),
      ));
    },
  );

  mcp.tool(
    "set_shell_policy",
    "Set a per-task command execution policy (allowlist extensions, denylist, concurrency, timeout).",
    {
      taskId: z.string().describe("Task ID"),
      allowedBinaries: z.array(z.string()).default([]).describe("Additional allowed binaries beyond global"),
      deniedBinaries: z.array(z.string()).default([]).describe("Explicitly denied binaries for this task"),
      deniedPatterns: z.array(z.string()).default([]).describe("Regex patterns to block"),
      maxConcurrent: z.number().int().min(1).max(20).default(5).describe("Max concurrent commands"),
      timeoutMs: z.number().int().min(1000).max(600000).default(120000).describe("Default timeout per command"),
    },
    async ({ taskId, allowedBinaries, deniedBinaries, deniedPatterns, maxConcurrent, timeoutMs }) =>
      textResult(await controller.setShellPolicy({
        taskId,
        allowedBinaries,
        deniedBinaries,
        deniedPatterns,
        maxConcurrent,
        timeoutMs,
        maxOutputBytes: 2 * 1024 * 1024,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      })),
  );

  mcp.tool(
    "get_shell_policy",
    "Get the execution policy for a task.",
    { taskId: z.string().describe("Task ID") },
    async ({ taskId }) => textResult(await controller.getShellPolicy(taskId)),
  );

  mcp.tool(
    "remove_shell_policy",
    "Remove a task's execution policy (revert to global defaults).",
    { taskId: z.string().describe("Task ID") },
    async ({ taskId }) => textResult({ removed: await controller.removeShellPolicy(taskId) }),
  );

  mcp.tool(
    "list_shell_policies",
    "List all per-task execution policies.",
    {},
    async () => textResult(await controller.listShellPolicies()),
  );

  mcp.tool(
    "get_shell_audit_log",
    "Get recent command execution audit entries.",
    {
      taskId: z.string().optional().describe("Filter by task ID"),
      limit: z.number().int().min(1).max(500).default(50).describe("Max entries"),
    },
    async ({ taskId, limit }) => textResult(await controller.getShellAuditLog(taskId, limit)),
  );

  mcp.tool(
    "get_shell_metrics",
    "Get command execution metrics (success/fail rates, durations, frequency).",
    { taskId: z.string().optional().describe("Filter by task ID") },
    async ({ taskId }) => textResult(await controller.getShellMetrics(taskId)),
  );

  mcp.tool(
    "get_shell_config",
    "Get the current shell tool configuration (feature flag, deny patterns, limits).",
    {},
    async () => textResult(controller.getShellConfig()),
  );

  mcp.tool(
    "is_shell_enabled",
    "Check if the shell tool feature is enabled.",
    {},
    async () => textResult({ enabled: controller.isShellEnabled() }),
  );

  mcp.tool(
    "clear_shell_audit",
    "Clear all command audit log entries.",
    {},
    async () => {
      await controller.clearShellAuditLog();
      return textResult({ ok: true });
    },
  );

  /* ================================================================ */
  /*  Autonomous Orchestration                                         */
  /* ================================================================ */

  mcp.tool(
    "start_autonomous_run",
    "Start a fully autonomous end-to-end coding task: plan -> implement -> test -> fix -> commit -> PR -> review. Returns a jobId — poll with get_job.",
    {
      objective: z.string().describe("High-level objective (e.g., 'Add user authentication with JWT tokens')"),
      maxPhaseFixes: z.number().int().min(1).max(10).default(3).describe("Max fix iterations per phase"),
      qualityThreshold: z.number().min(0).max(1).default(0).describe("Minimum quality score (0-1) to pass"),
      autoCommit: z.boolean().default(true).describe("Auto-commit on success"),
      autoPR: z.boolean().default(true).describe("Auto-create PR on success"),
      autoReview: z.boolean().default(true).describe("Auto-run review loop on PR"),
    },
    async (params) =>
      textResult(enqueue("autonomous/start", () =>
        controller.startAutonomousRun(params),
      )),
  );

  mcp.tool(
    "get_autonomous_run",
    "Get the status and results of an autonomous run.",
    { runId: z.string().describe("Run ID from start_autonomous_run") },
    async ({ runId }) => textResult(await controller.getAutonomousRun(runId)),
  );

  mcp.tool(
    "list_autonomous_runs",
    "List recent autonomous runs with status and results.",
    { limit: z.number().int().min(1).max(50).default(20).describe("Max runs to return") },
    async ({ limit }) => textResult(await controller.listAutonomousRuns(limit)),
  );

  mcp.tool(
    "cancel_autonomous_run",
    "Cancel an in-progress autonomous run.",
    { runId: z.string().describe("Run ID to cancel") },
    async ({ runId }) => textResult({ cancelled: await controller.cancelAutonomousRun(runId) }),
  );

  /* ================================================================ */
  /*  CI Integration (GitHub Actions)                                   */
  /* ================================================================ */

  mcp.tool(
    "trigger_ci",
    "Trigger a GitHub Actions CI workflow for a task. Returns trigger details immediately.",
    {
      taskId: z.string().describe("Task ID"),
      sha: z.string().describe("Git commit SHA to trigger CI for"),
      workflowFile: z.string().default("ci.yml").describe("Workflow file name (default: ci.yml)"),
    },
    async ({ taskId, sha, workflowFile }) =>
      textResult(await controller.triggerCI(taskId, sha, workflowFile)),
  );

  mcp.tool(
    "poll_ci_status",
    "Poll a GitHub Actions run until it completes or times out. Returns a jobId (long-running).",
    {
      taskId: z.string().describe("Task ID"),
      ghRunId: z.number().int().describe("GitHub Actions run ID"),
      timeoutMs: z.number().int().min(10000).max(1800000).default(600000).describe("Poll timeout in ms"),
    },
    async ({ taskId, ghRunId, timeoutMs }) =>
      textResult(enqueue("ci/poll", () => controller.pollCIStatus(taskId, ghRunId, timeoutMs))),
  );

  mcp.tool(
    "get_ci_failure_logs",
    "Get failure logs from a completed GitHub Actions run.",
    {
      taskId: z.string().describe("Task ID"),
      ghRunId: z.number().int().describe("GitHub Actions run ID"),
    },
    async ({ taskId, ghRunId }) =>
      textResult(await controller.getCIFailureLogs(taskId, ghRunId)),
  );

  mcp.tool(
    "trigger_and_wait_ci",
    "Trigger CI and poll until completion. Returns a jobId (long-running).",
    {
      taskId: z.string().describe("Task ID"),
      sha: z.string().describe("Git commit SHA"),
      workflowFile: z.string().default("ci.yml").describe("Workflow file name"),
      timeoutMs: z.number().int().min(10000).max(1800000).default(600000).describe("Poll timeout in ms"),
    },
    async ({ taskId, sha, workflowFile, timeoutMs }) =>
      textResult(enqueue("ci/triggerAndWait", () =>
        controller.triggerAndWaitCI(taskId, sha, workflowFile, timeoutMs),
      )),
  );

  /* ================================================================ */
  /*  PR Automerge                                                      */
  /* ================================================================ */

  mcp.tool(
    "evaluate_automerge",
    "Evaluate whether a PR is eligible for automatic merging based on policy.",
    {
      taskId: z.string().describe("Task ID"),
      prNumber: z.number().int().describe("Pull request number"),
    },
    async ({ taskId, prNumber }) =>
      textResult(await controller.evaluateAutomerge(taskId, prNumber)),
  );

  mcp.tool(
    "execute_merge",
    "Execute a merge for a PR (squash/merge/rebase). Only call after evaluate_automerge returns eligible.",
    {
      taskId: z.string().describe("Task ID"),
      prNumber: z.number().int().describe("Pull request number"),
      strategy: z.enum(["squash", "merge", "rebase"]).default("squash").describe("Merge strategy"),
    },
    async ({ taskId, prNumber, strategy }) =>
      textResult(await controller.executeMerge(taskId, prNumber, strategy)),
  );

  mcp.tool(
    "get_automerge_policy",
    "Get the current PR automerge policy (prefix whitelist, max diff size, requirements).",
    {},
    async () => textResult(await controller.getAutomergePolicy()),
  );

  mcp.tool(
    "set_automerge_policy",
    "Update the PR automerge policy.",
    {
      prefixWhitelist: z.array(z.string()).optional().describe("Commit prefixes eligible for automerge"),
      maxLinesChanged: z.number().int().optional().describe("Max diff lines for automerge (default: 500)"),
      requireCIGreen: z.boolean().optional().describe("Require CI to pass (default: true)"),
      requireReviewApproval: z.boolean().optional().describe("Require review approval (default: true)"),
      neverAutomergePatterns: z.array(z.string()).optional().describe("Patterns that block automerge"),
    },
    async (params) => {
      const updates: Record<string, unknown> = {};
      if (params.prefixWhitelist !== undefined) updates.prefixWhitelist = params.prefixWhitelist;
      if (params.maxLinesChanged !== undefined) updates.maxLinesChanged = params.maxLinesChanged;
      if (params.requireCIGreen !== undefined) updates.requireCIGreen = params.requireCIGreen;
      if (params.requireReviewApproval !== undefined) updates.requireReviewApproval = params.requireReviewApproval;
      if (params.neverAutomergePatterns !== undefined) updates.neverAutomergePatterns = params.neverAutomergePatterns;
      return textResult(await controller.setAutomergePolicy(updates as Partial<import("./types.js").AutomergePolicy>));
    },
  );

  /* ================================================================ */
  /*  Issue Triage                                                      */
  /* ================================================================ */

  mcp.tool(
    "triage_issue",
    "Auto-classify a GitHub issue as bug/feature/refactor, estimate complexity, apply labels, and post a triage summary comment.",
    {
      issueNumber: z.number().int().describe("GitHub issue number"),
      title: z.string().describe("Issue title"),
      body: z.string().default("").describe("Issue body text"),
      repo: z.string().default("").describe("Repository full name (owner/repo)"),
      author: z.string().default("unknown").describe("Issue author login"),
      url: z.string().default("").describe("Issue HTML URL"),
    },
    async ({ issueNumber, title, body, repo, author, url }) =>
      textResult(await controller.triageIssue({
        issueNumber, title, body, repo, author, url, existingLabels: [],
      })),
  );

  mcp.tool(
    "get_triage_history",
    "Get recent issue triage history.",
    { limit: z.number().int().min(1).max(100).default(50).describe("Max entries to return") },
    async ({ limit }) => textResult(await controller.getTriageHistory(limit)),
  );

  mcp.tool(
    "convert_issue_to_task",
    "Convert a triaged GitHub issue into an internal task and start autonomous processing. Returns a jobId (long-running).",
    {
      issueNumber: z.number().int().describe("GitHub issue number"),
      title: z.string().describe("Issue title"),
      body: z.string().default("").describe("Issue body text"),
      repo: z.string().default("").describe("Repository full name (owner/repo)"),
      author: z.string().default("unknown").describe("Issue author login"),
      url: z.string().default("").describe("Issue HTML URL"),
    },
    async ({ issueNumber, title, body, repo, author, url }) =>
      textResult(enqueue("triage/convertToTask", () =>
        controller.convertIssueToTask({
          issueNumber, title, body, repo, author, url, existingLabels: [],
        }),
      )),
  );

  /* ================================================================ */
  /*  Alerting                                                         */
  /* ================================================================ */

  mcp.tool(
    "send_alert",
    "Send an alert to configured channels (Slack, webhook, console).",
    {
      severity: z.enum(["info", "warning", "error", "critical"]).default("info").describe("Alert severity"),
      source: z.string().default("manual").describe("Source of the alert"),
      title: z.string().describe("Alert title"),
      message: z.string().describe("Alert message"),
    },
    async ({ severity, source, title, message }) =>
      textResult(await controller.sendAlert({ severity, source, title, message })),
  );

  mcp.tool(
    "get_alert_config",
    "Get the current alerting configuration (channels, settings).",
    {},
    async () => textResult(await controller.getAlertConfig()),
  );

  mcp.tool(
    "set_alert_config",
    "Update alert channel configuration.",
    {
      channels: z.array(z.object({
        type: z.enum(["slack", "webhook", "console"]).describe("Channel type"),
        enabled: z.boolean().describe("Whether channel is enabled"),
        url: z.string().optional().describe("Webhook URL (for slack/webhook types)"),
      })).describe("Alert channel configurations"),
    },
    async ({ channels }) => textResult(await controller.setAlertConfig({ channels })),
  );

  mcp.tool(
    "get_alert_history",
    "Get recent alert history.",
    { limit: z.number().int().min(1).max(500).default(50).describe("Max entries") },
    async ({ limit }) => textResult(await controller.getAlertHistory(limit)),
  );

  mcp.tool(
    "mute_alert",
    "Temporarily suppress alerts matching a pattern.",
    {
      pattern: z.string().describe("Pattern to match alert titles against"),
      durationMs: z.number().int().min(60000).default(3600000).describe("Mute duration in ms (default: 1 hour)"),
    },
    async ({ pattern, durationMs }) => textResult(await controller.muteAlert(pattern, durationMs)),
  );

  /* ================================================================ */
  /*  Merge Queue                                                      */
  /* ================================================================ */

  mcp.tool(
    "enqueue_merge",
    "Add a PR to the merge queue.",
    {
      taskId: z.string().describe("Task ID"),
      prNumber: z.number().int().describe("Pull request number"),
      priority: z.number().int().min(0).max(100).default(50).describe("Queue priority (0=lowest, 100=highest)"),
    },
    async ({ taskId, prNumber, priority }) =>
      textResult(await controller.enqueueMerge(taskId, prNumber, priority)),
  );

  mcp.tool(
    "dequeue_merge",
    "Get the next PR to merge from the queue.",
    {},
    async () => textResult(await controller.dequeueMerge()),
  );

  mcp.tool(
    "check_freshness",
    "Check if a task's branch is up-to-date with main.",
    { taskId: z.string().describe("Task ID") },
    async ({ taskId }) => textResult(await controller.checkMergeFreshness(taskId)),
  );

  mcp.tool(
    "rebase_onto_main",
    "Rebase a task's branch onto the latest main.",
    { taskId: z.string().describe("Task ID") },
    async ({ taskId }) => textResult(await controller.rebaseOntoMain(taskId)),
  );

  mcp.tool(
    "detect_conflicts",
    "Check for merge conflicts in a task's branch.",
    { taskId: z.string().describe("Task ID") },
    async ({ taskId }) => textResult(await controller.detectMergeConflicts(taskId)),
  );

  mcp.tool(
    "get_merge_queue_status",
    "Get current merge queue status (entries, depth, blocked/ready counts).",
    {},
    async () => textResult(await controller.getMergeQueueStatus()),
  );

  /* ================================================================ */
  /*  Scheduler                                                        */
  /* ================================================================ */

  mcp.tool(
    "start_scheduler",
    "Start the background job scheduler (quality-scan, architecture-sweep, doc-gardening, gc-sweep).",
    {},
    async () => textResult(await controller.startScheduler()),
  );

  mcp.tool(
    "stop_scheduler",
    "Stop the background job scheduler.",
    {},
    async () => textResult(await controller.stopScheduler()),
  );

  mcp.tool(
    "get_schedule_status",
    "Get current scheduler status and job configurations.",
    {},
    async () => textResult(await controller.getScheduleStatus()),
  );

  mcp.tool(
    "trigger_scheduled_job",
    "Manually trigger a scheduled job immediately.",
    {
      jobName: z.enum(["quality-scan", "architecture-sweep", "doc-gardening", "gc-sweep"]).describe("Job to trigger"),
    },
    async ({ jobName }) => textResult(await controller.triggerScheduledJob(jobName)),
  );

  mcp.tool(
    "set_job_interval",
    "Change the interval for a scheduled job.",
    {
      jobName: z.enum(["quality-scan", "architecture-sweep", "doc-gardening", "gc-sweep"]).describe("Job name"),
      intervalMs: z.number().int().min(60000).describe("New interval in ms (minimum 1 minute)"),
    },
    async ({ jobName, intervalMs }) => textResult(await controller.setJobInterval(jobName, intervalMs)),
  );

  mcp.tool(
    "get_job_history",
    "Get run history for a scheduled job.",
    {
      jobName: z.enum(["quality-scan", "architecture-sweep", "doc-gardening", "gc-sweep"]).describe("Job name"),
    },
    async ({ jobName }) => textResult(await controller.getJobHistory(jobName)),
  );

  /* ================================================================ */
  /*  Refactoring (Golden Principles)                                  */
  /* ================================================================ */

  mcp.tool(
    "scan_violations",
    "Scan the workspace for golden principle violations (duplicate helpers, untyped boundaries, import hygiene, dead code, duplicate logic).",
    {},
    async () => textResult(await controller.scanForViolations()),
  );

  mcp.tool(
    "get_violation_report",
    "Get the most recent violation scan report.",
    {},
    async () => textResult(await controller.getViolationReport()),
  );

  mcp.tool(
    "generate_refactoring_pr",
    "Generate a refactoring prompt for a specific violation type. Returns a jobId.",
    {
      violationType: z.enum(["duplicate-helper", "untyped-boundary", "import-hygiene", "dead-code", "duplicate-logic"]).describe("Type of violation to address"),
    },
    async ({ violationType }) =>
      textResult(enqueue("refactoring/generate", () => controller.generateRefactoringPR(violationType))),
  );

  mcp.tool(
    "get_refactoring_history",
    "Get history of refactoring runs.",
    {},
    async () => textResult(await controller.getRefactoringHistory()),
  );

  /* ================================================================ */
  /*  GitHub Review Poster                                             */
  /* ================================================================ */

  mcp.tool(
    "post_pr_review",
    "Post a PR review with inline comments to GitHub.",
    {
      prNumber: z.number().int().describe("Pull request number"),
      findings: z.array(z.object({
        file: z.string().describe("File path"),
        line: z.number().int().nullable().describe("Line number (null for file-level)"),
        severity: z.enum(["error", "warning", "suggestion"]).describe("Finding severity"),
        message: z.string().describe("Finding message"),
        rule: z.string().describe("Rule that triggered this finding"),
      })).describe("Review findings"),
      verdict: z.enum(["APPROVE", "REQUEST_CHANGES", "COMMENT"]).describe("Review verdict"),
    },
    async ({ prNumber, findings, verdict }) =>
      textResult(await controller.postPRReview(prNumber, findings, verdict)),
  );

  mcp.tool(
    "post_pr_summary",
    "Post a quality score summary comment on a PR.",
    {
      prNumber: z.number().int().describe("Pull request number"),
      qualityScore: z.object({
        overall: z.number().describe("Overall quality score (0-1)"),
        breakdown: z.object({
          eval: z.number().describe("Eval score"),
          ci: z.number().describe("CI score"),
          lint: z.number().describe("Lint score"),
          architecture: z.number().describe("Architecture score"),
          docs: z.number().describe("Docs score"),
        }),
      }).describe("Quality score data"),
      evalResult: z.object({
        passed: z.boolean().describe("Whether eval passed"),
        overallScore: z.number().describe("Overall eval score"),
        checkCount: z.number().int().describe("Total checks"),
        passedCount: z.number().int().describe("Passed checks"),
      }).describe("Eval result data"),
    },
    async ({ prNumber, qualityScore, evalResult }) =>
      textResult(await controller.postPRSummary(prNumber, qualityScore, evalResult)),
  );

  mcp.tool(
    "get_pr_review_status",
    "Get the current review status of a PR.",
    { prNumber: z.number().int().describe("Pull request number") },
    async ({ prNumber }) => textResult(await controller.getPRReviewStatus(prNumber)),
  );

  /* ================================================================ */
  /*  Webhook Audit                                                    */
  /* ================================================================ */

  mcp.tool(
    "get_webhook_audit_log",
    "Get recent webhook event audit log.",
    { limit: z.number().int().min(1).max(500).default(50).describe("Max entries") },
    async ({ limit }) => textResult(controller.getWebhookAuditLog(limit)),
  );

  /* ================================================================ */
  /*  Dashboard                                                        */
  /* ================================================================ */

  mcp.tool(
    "get_dashboard",
    "Get aggregate system dashboard (tasks, autonomous runs, CI rates, alerts, merge queue, scheduler).",
    {},
    async () => textResult(await controller.getDashboard()),
  );

  /* ================================================================ */
  /*  Request handler                                                  */
  /* ================================================================ */

  return async (req: http.IncomingMessage, res: http.ServerResponse): Promise<void> => {
    // Omit sessionIdGenerator → stateless mode (no session tracking).
    const transport = new StreamableHTTPServerTransport({});
    res.on("close", () => { void transport.close(); });
    // Type assertion needed: MCP SDK's Transport.onclose is non-optional but
    // StreamableHTTPServerTransport declares it as `(() => void) | undefined`,
    // which clashes under exactOptionalPropertyTypes.
    await mcp.connect(transport as Parameters<typeof mcp.connect>[0]);
    await transport.handleRequest(req, res);
  };
}
