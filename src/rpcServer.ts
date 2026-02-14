import http from "node:http";
import crypto from "node:crypto";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { Controller } from "./controller.js";
import { createMcpHandler, type JobRecord } from "./mcpServer.js";
import type { WebhookHandler } from "./webhookHandler.js";
import { OAuthProvider } from "./oauthProvider.js";

// We intentionally keep JSON-RPC payloads permissive and rely on JSON.stringify
// at the boundary, rather than trying to perfectly model "JSON serializable" in TS.
type JsonValue = unknown;

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: JsonValue;
  method: string;
  params?: JsonValue;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: JsonValue | null;
  result?: JsonValue;
  error?: { code: number; message: string; data?: JsonValue };
}

export interface RpcServerOptions {
  controller: Controller;
  bindHost: string;
  port: number;
  bearerToken?: string;
  shutdownGraceMs?: number;
  webhookHandler?: WebhookHandler;
  /** External base URL (e.g. https://codex-controller.gallagherpropco.com) for OAuth issuer. */
  externalBaseUrl: string | undefined;
}

function jsonRpcError(id: JsonValue | null, code: number, message: string, data?: JsonValue): JsonRpcResponse {
  const error: JsonRpcResponse["error"] = { code, message };
  if (data !== undefined) error.data = data;
  return { jsonrpc: "2.0", id, error };
}

function safeJsonParse(text: string): unknown {
  return JSON.parse(text);
}

function readBody(req: http.IncomingMessage, limitBytes: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let total = 0;
    const chunks: Buffer[] = [];

    req.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > limitBytes) {
        reject(new Error("Request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function requireBearer(req: http.IncomingMessage, bearerToken: string): boolean {
  const header = req.headers.authorization;
  if (!header) return false;
  const [scheme, token] = header.split(" ");
  return scheme === "Bearer" && token === bearerToken;
}

async function handle(controller: Controller, request: JsonRpcRequest): Promise<JsonValue> {
  switch (request.method) {
    case "health/ping":
      return { ok: true, ts: new Date().toISOString() };

    case "task/start": {
      const params = request.params as unknown as { prompt?: string };
      if (!params?.prompt || params.prompt.trim().length === 0) {
        throw new Error("task/start requires params.prompt");
      }
      return await controller.startTask(params.prompt);
    }

    case "task/continue": {
      const params = request.params as unknown as { threadId?: string; prompt?: string };
      if (!params?.threadId || params.threadId.trim().length === 0) {
        throw new Error("task/continue requires params.threadId");
      }
      if (!params?.prompt || params.prompt.trim().length === 0) {
        throw new Error("task/continue requires params.prompt");
      }
      return await controller.continueTask(params.threadId, params.prompt);
    }

    case "verify/run": {
      const params = request.params as unknown as { taskId?: string };
      if (!params?.taskId || params.taskId.trim().length === 0) {
        throw new Error("verify/run requires params.taskId");
      }
      return await controller.runVerify(params.taskId);
    }

    case "fix/untilGreen": {
      const params = request.params as unknown as { taskId?: string; maxIterations?: number };
      if (!params?.taskId || params.taskId.trim().length === 0) {
        throw new Error("fix/untilGreen requires params.taskId");
      }
      const maxIterations = typeof params.maxIterations === "number" && Number.isFinite(params.maxIterations)
        ? params.maxIterations
        : 5;
      return await controller.fixUntilGreen(params.taskId, maxIterations);
    }

    case "pr/create": {
      const params = request.params as unknown as { taskId?: string; title?: string; body?: string };
      if (!params?.taskId || params.taskId.trim().length === 0) {
        throw new Error("pr/create requires params.taskId");
      }
      if (!params?.title || params.title.trim().length === 0) {
        throw new Error("pr/create requires params.title");
      }
      const prUrl = await controller.createPullRequest(params.taskId, params.title, params.body ?? "");
      return { prUrl };
    }

    case "mutation/run": {
      const params = request.params as unknown as { taskId?: string; featureDescription?: string };
      if (!params?.taskId || params.taskId.trim().length === 0) {
        throw new Error("mutation/run requires params.taskId");
      }
      if (!params?.featureDescription || params.featureDescription.trim().length === 0) {
        throw new Error("mutation/run requires params.featureDescription");
      }
      return await controller.runMutation(params.taskId, params.featureDescription);
    }

    case "eval/run": {
      const params = request.params as unknown as { taskId?: string };
      if (!params?.taskId || params.taskId.trim().length === 0) {
        throw new Error("eval/run requires params.taskId");
      }
      return await controller.runEval(params.taskId);
    }

    case "eval/history": {
      const params = request.params as unknown as { limit?: number } | undefined;
      const limit = typeof params?.limit === "number" ? params.limit : undefined;
      return await controller.getEvalHistory(limit);
    }

    case "eval/summary": {
      const params = request.params as unknown as { taskId?: string };
      if (!params?.taskId || params.taskId.trim().length === 0) {
        throw new Error("eval/summary requires params.taskId");
      }
      return await controller.getEvalSummary(params.taskId);
    }

    case "memory/list": {
      const params = request.params as unknown as { category?: string; limit?: number } | undefined;
      return await controller.getMemoryEntries(params?.category, params?.limit);
    }

    case "garden/run": {
      const params = request.params as unknown as { taskId?: string };
      if (!params?.taskId || params.taskId.trim().length === 0) {
        throw new Error("garden/run requires params.taskId");
      }
      return await controller.runDocGardening(params.taskId);
    }

    case "plan/create": {
      const params = request.params as unknown as { taskId?: string; description?: string };
      if (!params?.taskId || params.taskId.trim().length === 0) throw new Error("plan/create requires params.taskId");
      if (!params?.description || params.description.trim().length === 0) throw new Error("plan/create requires params.description");
      return await controller.createExecutionPlan(params.taskId, params.description);
    }

    case "plan/get": {
      const params = request.params as unknown as { taskId?: string };
      if (!params?.taskId || params.taskId.trim().length === 0) throw new Error("plan/get requires params.taskId");
      return await controller.getExecutionPlan(params.taskId);
    }

    case "plan/updatePhase": {
      const params = request.params as unknown as { taskId?: string; phaseIndex?: number; status?: string };
      if (!params?.taskId || params.taskId.trim().length === 0) throw new Error("plan/updatePhase requires params.taskId");
      if (typeof params.phaseIndex !== "number") throw new Error("plan/updatePhase requires params.phaseIndex");
      if (!params.status) throw new Error("plan/updatePhase requires params.status");
      return await controller.updatePlanPhase(params.taskId, params.phaseIndex, params.status as "pending" | "in_progress" | "completed" | "failed" | "skipped");
    }

    case "ci/record": {
      const params = request.params as unknown as { taskId?: string; passed?: boolean; exitCode?: number; duration_ms?: number; failureCount?: number; failureSummary?: string[] };
      if (!params?.taskId || params.taskId.trim().length === 0) throw new Error("ci/record requires params.taskId");
      return await controller.recordCIRun({ taskId: params.taskId, passed: params.passed ?? false, exitCode: params.exitCode ?? 1, duration_ms: params.duration_ms ?? 0, failureCount: params.failureCount ?? 0, failureSummary: params.failureSummary ?? [] });
    }

    case "ci/status": {
      const params = request.params as unknown as { taskId?: string };
      if (!params?.taskId || params.taskId.trim().length === 0) throw new Error("ci/status requires params.taskId");
      return await controller.getCIStatus(params.taskId);
    }

    case "ci/history": {
      const params = request.params as unknown as { taskId?: string; limit?: number };
      if (!params?.taskId || params.taskId.trim().length === 0) throw new Error("ci/history requires params.taskId");
      return await controller.getCIHistory(params.taskId, params.limit);
    }

    case "review/run": {
      const params = request.params as unknown as { taskId?: string };
      if (!params?.taskId || params.taskId.trim().length === 0) throw new Error("review/run requires params.taskId");
      return await controller.reviewPR(params.taskId);
    }

    case "review/loop": {
      const params = request.params as unknown as { taskId?: string; maxRounds?: number };
      if (!params?.taskId || params.taskId.trim().length === 0) throw new Error("review/loop requires params.taskId");
      return await controller.runReviewLoop(params.taskId, params.maxRounds ?? 3);
    }

    case "app/boot": {
      const params = request.params as unknown as { taskId?: string };
      if (!params?.taskId || params.taskId.trim().length === 0) throw new Error("app/boot requires params.taskId");
      return await controller.bootApp(params.taskId);
    }

    case "log/query": {
      const params = request.params as unknown as { taskId?: string; pattern?: string; limit?: number };
      if (!params?.taskId || params.taskId.trim().length === 0) throw new Error("log/query requires params.taskId");
      if (!params?.pattern || params.pattern.trim().length === 0) throw new Error("log/query requires params.pattern");
      return await controller.queryLogs(params.taskId, params.pattern, params.limit);
    }

    case "lint/run": {
      const params = request.params as unknown as { taskId?: string; rules?: string[] };
      if (!params?.taskId || params.taskId.trim().length === 0) throw new Error("lint/run requires params.taskId");
      return await controller.runLinter(params.taskId, params.rules);
    }

    case "arch/validate": {
      const params = request.params as unknown as { taskId?: string };
      if (!params?.taskId || params.taskId.trim().length === 0) throw new Error("arch/validate requires params.taskId");
      return await controller.validateArchitecture(params.taskId);
    }

    case "doc/validate": {
      const params = request.params as unknown as { taskId?: string };
      if (!params?.taskId || params.taskId.trim().length === 0) throw new Error("doc/validate requires params.taskId");
      return await controller.validateDocs(params.taskId);
    }

    case "quality/score": {
      const params = request.params as unknown as { taskId?: string };
      if (!params?.taskId || params.taskId.trim().length === 0) throw new Error("quality/score requires params.taskId");
      return await controller.getQualityScore(params.taskId);
    }

    case "gc/sweep": {
      return await controller.runGCSweep();
    }

    case "bug/reproduce": {
      const params = request.params as unknown as { taskId?: string; bugDescription?: string };
      if (!params?.taskId || params.taskId.trim().length === 0) throw new Error("bug/reproduce requires params.taskId");
      if (!params?.bugDescription || params.bugDescription.trim().length === 0) throw new Error("bug/reproduce requires params.bugDescription");
      return await controller.reproduceBug(params.taskId, params.bugDescription);
    }

    case "checkpoint/create": {
      const params = request.params as unknown as { taskId?: string; description?: string };
      if (!params?.taskId || params.taskId.trim().length === 0) throw new Error("checkpoint/create requires params.taskId");
      return await controller.checkpointTask(params.taskId, params.description ?? "Manual checkpoint");
    }

    case "checkpoint/list": {
      const params = request.params as unknown as { taskId?: string };
      if (!params?.taskId || params.taskId.trim().length === 0) throw new Error("checkpoint/list requires params.taskId");
      return await controller.getTaskCheckpoints(params.taskId);
    }

    case "ref/list": {
      const params = request.params as unknown as { category?: string } | undefined;
      return await controller.getReferenceDocs(params?.category);
    }

    case "ref/add": {
      const params = request.params as unknown as { category?: string; title?: string; content?: string };
      if (!params?.title || params.title.trim().length === 0) throw new Error("ref/add requires params.title");
      if (!params?.content || params.content.trim().length === 0) throw new Error("ref/add requires params.content");
      return await controller.addReferenceDoc({ category: params.category ?? "general", title: params.title, content: params.content });
    }

    case "task/parallel": {
      const params = request.params as unknown as { tasks?: Array<{ taskId: string; featureDescription: string }> };
      if (!params?.tasks || !Array.isArray(params.tasks) || params.tasks.length === 0) {
        throw new Error("task/parallel requires params.tasks (non-empty array)");
      }
      return await controller.runParallel(params.tasks);
    }

    // --- Skill Routing ---
    case "skill/route": {
      const params = request.params as unknown as { description?: string };
      if (!params?.description) throw new Error("skill/route requires params.description");
      return await controller.routeSkills(params.description);
    }
    case "skill/force": {
      const params = request.params as unknown as { skillNames?: string[] };
      if (!params?.skillNames || !Array.isArray(params.skillNames)) throw new Error("skill/force requires params.skillNames");
      return await controller.forceSelectSkills(params.skillNames);
    }

    // --- Artifacts ---
    case "artifact/register": {
      const params = request.params as unknown as { taskId?: string; name?: string; path?: string; type?: string; metadata?: Record<string, string> };
      if (!params?.taskId) throw new Error("artifact/register requires params.taskId");
      if (!params?.name) throw new Error("artifact/register requires params.name");
      if (!params?.path) throw new Error("artifact/register requires params.path");
      return await controller.registerArtifact(params.taskId, params.name, params.path, params.type as "file" | "report" | "dataset" | "screenshot" | "log" | undefined, params.metadata);
    }
    case "artifact/collect": {
      const params = request.params as unknown as { taskId?: string };
      if (!params?.taskId) throw new Error("artifact/collect requires params.taskId");
      return await controller.collectArtifacts(params.taskId);
    }
    case "artifact/list": {
      const params = request.params as unknown as { taskId?: string };
      if (!params?.taskId) throw new Error("artifact/list requires params.taskId");
      return await controller.getArtifacts(params.taskId);
    }

    // --- Network Policy ---
    case "network/getPolicy":
      return await controller.getNetworkPolicy();
    case "network/setPolicy": {
      const params = request.params as unknown as { allowlist?: Array<{ domain: string; ports?: number[]; reason: string }> };
      if (!params?.allowlist) throw new Error("network/setPolicy requires params.allowlist");
      return await controller.setNetworkPolicy(params.allowlist);
    }
    case "network/addDomain": {
      const params = request.params as unknown as { domain?: string; ports?: number[]; reason?: string };
      if (!params?.domain) throw new Error("network/addDomain requires params.domain");
      return await controller.addNetworkDomain({ domain: params.domain, ports: params.ports, reason: params.reason ?? "" });
    }
    case "network/removeDomain": {
      const params = request.params as unknown as { domain?: string };
      if (!params?.domain) throw new Error("network/removeDomain requires params.domain");
      return await controller.removeNetworkDomain(params.domain);
    }

    // --- Domain Secrets ---
    case "secret/register": {
      const params = request.params as unknown as { domain?: string; headerName?: string; placeholder?: string; envVar?: string };
      if (!params?.domain || !params?.headerName || !params?.placeholder || !params?.envVar) {
        throw new Error("secret/register requires domain, headerName, placeholder, envVar");
      }
      await controller.registerDomainSecret({
        domain: params.domain,
        headerName: params.headerName,
        placeholder: params.placeholder,
        envVar: params.envVar,
      });
      return { ok: true };
    }
    case "secret/list":
      return await controller.getDomainSecrets();
    case "secret/validate":
      return await controller.validateDomainSecrets();

    // --- Compaction ---
    case "compaction/config":
      return controller.getCompactionConfig();
    case "compaction/setConfig": {
      const params = request.params as unknown as Record<string, unknown>;
      return controller.setCompactionConfig(params as Record<string, unknown> & Partial<{ strategy: "turn-interval" | "token-threshold" | "auto" }>);
    }
    case "compaction/history": {
      const params = request.params as unknown as { limit?: number };
      return await controller.getCompactionHistory(params?.limit);
    }
    case "compaction/contextUsage": {
      const params = request.params as unknown as { threadId?: string };
      if (!params?.threadId) throw new Error("compaction/contextUsage requires params.threadId");
      return controller.getContextUsage(params.threadId);
    }

    // --- Shell Tool Integration ---
    case "shell/execute": {
      const params = request.params as unknown as { taskId?: string; command?: string[]; timeoutMs?: number; allowNonZeroExit?: boolean };
      if (!params?.taskId || params.taskId.trim().length === 0) throw new Error("shell/execute requires params.taskId");
      if (!params?.command || !Array.isArray(params.command) || params.command.length === 0) throw new Error("shell/execute requires params.command (non-empty array)");
      const opts: { timeoutMs?: number; allowNonZeroExit?: boolean } = {};
      if (params.timeoutMs !== undefined) opts.timeoutMs = params.timeoutMs;
      if (params.allowNonZeroExit !== undefined) opts.allowNonZeroExit = params.allowNonZeroExit;
      return await controller.executeShellCommand(params.taskId, params.command, opts);
    }

    case "shell/setPolicy": {
      const params = request.params as unknown as {
        taskId?: string; allowedBinaries?: string[]; deniedBinaries?: string[];
        deniedPatterns?: string[]; maxConcurrent?: number; timeoutMs?: number; maxOutputBytes?: number;
      };
      if (!params?.taskId) throw new Error("shell/setPolicy requires params.taskId");
      return await controller.setShellPolicy({
        taskId: params.taskId,
        allowedBinaries: params.allowedBinaries ?? [],
        deniedBinaries: params.deniedBinaries ?? [],
        deniedPatterns: params.deniedPatterns ?? [],
        maxConcurrent: params.maxConcurrent ?? 5,
        timeoutMs: params.timeoutMs ?? 120000,
        maxOutputBytes: params.maxOutputBytes ?? 2 * 1024 * 1024,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
    }

    case "shell/getPolicy": {
      const params = request.params as unknown as { taskId?: string };
      if (!params?.taskId) throw new Error("shell/getPolicy requires params.taskId");
      return await controller.getShellPolicy(params.taskId);
    }

    case "shell/removePolicy": {
      const params = request.params as unknown as { taskId?: string };
      if (!params?.taskId) throw new Error("shell/removePolicy requires params.taskId");
      return { removed: await controller.removeShellPolicy(params.taskId) };
    }

    case "shell/listPolicies":
      return await controller.listShellPolicies();

    case "shell/auditLog": {
      const params = request.params as unknown as { taskId?: string; limit?: number };
      return await controller.getShellAuditLog(params?.taskId, params?.limit);
    }

    case "shell/metrics": {
      const params = request.params as unknown as { taskId?: string };
      return await controller.getShellMetrics(params?.taskId);
    }

    case "shell/config":
      return controller.getShellConfig();

    case "shell/enabled":
      return { enabled: controller.isShellEnabled() };

    case "shell/clearAudit":
      await controller.clearShellAuditLog();
      return { ok: true };

    // --- Autonomous Orchestration ---
    case "autonomous/start": {
      const params = request.params as unknown as {
        objective?: string; maxPhaseFixes?: number; qualityThreshold?: number;
        autoCommit?: boolean; autoPR?: boolean; autoReview?: boolean;
      };
      if (!params?.objective || params.objective.trim().length === 0) throw new Error("autonomous/start requires params.objective");
      return await controller.startAutonomousRun({
        objective: params.objective,
        maxPhaseFixes: params.maxPhaseFixes ?? 3,
        qualityThreshold: params.qualityThreshold ?? 0,
        autoCommit: params.autoCommit ?? true,
        autoPR: params.autoPR ?? true,
        autoReview: params.autoReview ?? true,
      });
    }

    case "autonomous/get": {
      const params = request.params as unknown as { runId?: string };
      if (!params?.runId || params.runId.trim().length === 0) throw new Error("autonomous/get requires params.runId");
      return await controller.getAutonomousRun(params.runId);
    }

    case "autonomous/list": {
      const params = request.params as unknown as { limit?: number };
      return await controller.listAutonomousRuns(params?.limit);
    }

    case "autonomous/cancel": {
      const params = request.params as unknown as { runId?: string };
      if (!params?.runId || params.runId.trim().length === 0) throw new Error("autonomous/cancel requires params.runId");
      return { cancelled: await controller.cancelAutonomousRun(params.runId) };
    }

    // --- Alerting ---
    case "alert/send": {
      const params = request.params as unknown as {
        severity?: string; source?: string; title?: string; message?: string;
        metadata?: Record<string, unknown>;
      };
      if (!params?.title || params.title.trim().length === 0) throw new Error("alert/send requires params.title");
      if (!params?.message || params.message.trim().length === 0) throw new Error("alert/send requires params.message");
      return await controller.sendAlert({
        severity: (params.severity ?? "info") as "info" | "warning" | "error" | "critical",
        source: params.source ?? "manual",
        title: params.title,
        message: params.message,
        ...(params.metadata !== undefined ? { metadata: params.metadata } : {}),
      });
    }

    case "alert/config":
      return await controller.getAlertConfig();

    case "alert/setConfig": {
      const params = request.params as unknown as { channels?: Array<{ type: string; enabled: boolean; url?: string }> } | undefined;
      const channels = params?.channels?.map((c) => ({
        type: c.type as "slack" | "webhook" | "console",
        enabled: c.enabled,
        ...(c.url !== undefined ? { url: c.url } : {}),
      }));
      return await controller.setAlertConfig(channels !== undefined ? { channels } : {});
    }

    case "alert/history": {
      const params = request.params as unknown as { limit?: number };
      return await controller.getAlertHistory(params?.limit);
    }

    case "alert/mute": {
      const params = request.params as unknown as { pattern?: string; durationMs?: number };
      if (!params?.pattern || params.pattern.trim().length === 0) throw new Error("alert/mute requires params.pattern");
      return await controller.muteAlert(params.pattern, params.durationMs ?? 3600000);
    }

    // --- Merge Queue ---
    case "merge/enqueue": {
      const params = request.params as unknown as { taskId?: string; prNumber?: number; priority?: number };
      if (!params?.taskId || params.taskId.trim().length === 0) throw new Error("merge/enqueue requires params.taskId");
      if (typeof params.prNumber !== "number") throw new Error("merge/enqueue requires params.prNumber");
      return await controller.enqueueMerge(params.taskId, params.prNumber, params.priority);
    }

    case "merge/dequeue":
      return await controller.dequeueMerge();

    case "merge/checkFreshness": {
      const params = request.params as unknown as { taskId?: string };
      if (!params?.taskId || params.taskId.trim().length === 0) throw new Error("merge/checkFreshness requires params.taskId");
      return await controller.checkMergeFreshness(params.taskId);
    }

    case "merge/rebase": {
      const params = request.params as unknown as { taskId?: string };
      if (!params?.taskId || params.taskId.trim().length === 0) throw new Error("merge/rebase requires params.taskId");
      return await controller.rebaseOntoMain(params.taskId);
    }

    case "merge/detectConflicts": {
      const params = request.params as unknown as { taskId?: string };
      if (!params?.taskId || params.taskId.trim().length === 0) throw new Error("merge/detectConflicts requires params.taskId");
      return await controller.detectMergeConflicts(params.taskId);
    }

    case "merge/queueStatus":
      return await controller.getMergeQueueStatus();

    // --- Dashboard ---
    case "dashboard/get":
      return await controller.getDashboard();

    // --- CI Integration ---
    case "ci/trigger": {
      const params = request.params as unknown as { taskId?: string; sha?: string; workflowFile?: string };
      if (!params?.taskId || params.taskId.trim().length === 0) throw new Error("ci/trigger requires params.taskId");
      if (!params?.sha || params.sha.trim().length === 0) throw new Error("ci/trigger requires params.sha");
      return await controller.triggerCI(params.taskId, params.sha, params.workflowFile);
    }

    case "ci/poll": {
      const params = request.params as unknown as { taskId?: string; ghRunId?: number; timeoutMs?: number };
      if (!params?.taskId || params.taskId.trim().length === 0) throw new Error("ci/poll requires params.taskId");
      if (typeof params.ghRunId !== "number") throw new Error("ci/poll requires params.ghRunId");
      return await controller.pollCIStatus(params.taskId, params.ghRunId, params.timeoutMs);
    }

    case "ci/failureLogs": {
      const params = request.params as unknown as { taskId?: string; ghRunId?: number };
      if (!params?.taskId || params.taskId.trim().length === 0) throw new Error("ci/failureLogs requires params.taskId");
      if (typeof params.ghRunId !== "number") throw new Error("ci/failureLogs requires params.ghRunId");
      return await controller.getCIFailureLogs(params.taskId, params.ghRunId);
    }

    case "ci/triggerAndWait": {
      const params = request.params as unknown as { taskId?: string; sha?: string; workflowFile?: string; timeoutMs?: number };
      if (!params?.taskId || params.taskId.trim().length === 0) throw new Error("ci/triggerAndWait requires params.taskId");
      if (!params?.sha || params.sha.trim().length === 0) throw new Error("ci/triggerAndWait requires params.sha");
      return await controller.triggerAndWaitCI(params.taskId, params.sha, params.workflowFile, params.timeoutMs);
    }

    // --- PR Automerge ---
    case "automerge/evaluate": {
      const params = request.params as unknown as { taskId?: string; prNumber?: number };
      if (!params?.taskId || params.taskId.trim().length === 0) throw new Error("automerge/evaluate requires params.taskId");
      if (typeof params.prNumber !== "number") throw new Error("automerge/evaluate requires params.prNumber");
      return await controller.evaluateAutomerge(params.taskId, params.prNumber);
    }

    case "automerge/merge": {
      const params = request.params as unknown as { taskId?: string; prNumber?: number; strategy?: string };
      if (!params?.taskId || params.taskId.trim().length === 0) throw new Error("automerge/merge requires params.taskId");
      if (typeof params.prNumber !== "number") throw new Error("automerge/merge requires params.prNumber");
      return await controller.executeMerge(params.taskId, params.prNumber, (params.strategy ?? "squash") as "squash" | "merge" | "rebase");
    }

    case "automerge/getPolicy":
      return await controller.getAutomergePolicy();

    case "automerge/setPolicy": {
      const params = request.params as unknown as Partial<{
        prefixWhitelist: string[];
        maxLinesChanged: number;
        requireCIGreen: boolean;
        requireReviewApproval: boolean;
        neverAutomergePatterns: string[];
      }>;
      return await controller.setAutomergePolicy(params ?? {});
    }

    // --- Issue Triage ---
    case "triage/run": {
      const params = request.params as unknown as { issueNumber?: number; title?: string; body?: string; repo?: string; author?: string; url?: string };
      if (typeof params?.issueNumber !== "number") throw new Error("triage/run requires params.issueNumber");
      if (!params?.title || params.title.trim().length === 0) throw new Error("triage/run requires params.title");
      return await controller.triageIssue({
        issueNumber: params.issueNumber,
        title: params.title,
        body: params.body ?? "",
        repo: params.repo ?? "",
        author: params.author ?? "unknown",
        url: params.url ?? "",
        existingLabels: [],
      });
    }

    case "triage/history": {
      const params = request.params as unknown as { limit?: number };
      return await controller.getTriageHistory(params?.limit);
    }

    case "triage/convertToTask": {
      const params = request.params as unknown as { issueNumber?: number; title?: string; body?: string; repo?: string; author?: string; url?: string };
      if (typeof params?.issueNumber !== "number") throw new Error("triage/convertToTask requires params.issueNumber");
      if (!params?.title || params.title.trim().length === 0) throw new Error("triage/convertToTask requires params.title");
      return await controller.convertIssueToTask({
        issueNumber: params.issueNumber,
        title: params.title,
        body: params.body ?? "",
        repo: params.repo ?? "",
        author: params.author ?? "unknown",
        url: params.url ?? "",
        existingLabels: [],
      });
    }

    case "webhook/auditLog": {
      const params = request.params as unknown as { limit?: number };
      return controller.getWebhookAuditLog(params?.limit);
    }

    // --- Scheduler ---
    case "scheduler/start":
      return await controller.startScheduler();

    case "scheduler/stop":
      return await controller.stopScheduler();

    case "scheduler/status":
      return await controller.getScheduleStatus();

    case "scheduler/trigger": {
      const params = request.params as unknown as { jobName?: string };
      if (!params?.jobName) throw new Error("scheduler/trigger requires params.jobName");
      return await controller.triggerScheduledJob(params.jobName as "quality-scan" | "architecture-sweep" | "doc-gardening" | "gc-sweep");
    }

    case "scheduler/setInterval": {
      const params = request.params as unknown as { jobName?: string; intervalMs?: number };
      if (!params?.jobName) throw new Error("scheduler/setInterval requires params.jobName");
      if (typeof params.intervalMs !== "number") throw new Error("scheduler/setInterval requires params.intervalMs");
      return await controller.setJobInterval(params.jobName as "quality-scan" | "architecture-sweep" | "doc-gardening" | "gc-sweep", params.intervalMs);
    }

    case "scheduler/jobHistory": {
      const params = request.params as unknown as { jobName?: string };
      if (!params?.jobName) throw new Error("scheduler/jobHistory requires params.jobName");
      return await controller.getJobHistory(params.jobName as "quality-scan" | "architecture-sweep" | "doc-gardening" | "gc-sweep");
    }

    // --- Refactoring ---
    case "refactoring/scan":
      return await controller.scanForViolations();

    case "refactoring/report":
      return await controller.getViolationReport();

    case "refactoring/generate": {
      const params = request.params as unknown as { violationType?: string };
      if (!params?.violationType) throw new Error("refactoring/generate requires params.violationType");
      return await controller.generateRefactoringPR(params.violationType as "duplicate-helper" | "untyped-boundary" | "import-hygiene" | "dead-code" | "duplicate-logic");
    }

    case "refactoring/history":
      return await controller.getRefactoringHistory();

    // --- GitHub Review Poster ---
    case "review/postToGitHub": {
      const params = request.params as unknown as {
        prNumber?: number;
        findings?: Array<{ file: string; line: number | null; severity: string; message: string; rule: string }>;
        verdict?: string;
      };
      if (typeof params?.prNumber !== "number") throw new Error("review/postToGitHub requires params.prNumber");
      if (!params?.findings || !Array.isArray(params.findings)) throw new Error("review/postToGitHub requires params.findings");
      if (!params?.verdict) throw new Error("review/postToGitHub requires params.verdict");
      return await controller.postPRReview(
        params.prNumber,
        params.findings as Array<{ file: string; line: number | null; severity: "error" | "warning" | "suggestion"; message: string; rule: string }>,
        params.verdict as "APPROVE" | "REQUEST_CHANGES" | "COMMENT",
      );
    }

    case "review/postSummary": {
      const params = request.params as unknown as {
        prNumber?: number;
        qualityScore?: { overall: number; breakdown: { eval: number; ci: number; lint: number; architecture: number; docs: number } };
        evalResult?: { passed: boolean; overallScore: number; checkCount: number; passedCount: number };
      };
      if (typeof params?.prNumber !== "number") throw new Error("review/postSummary requires params.prNumber");
      if (!params?.qualityScore) throw new Error("review/postSummary requires params.qualityScore");
      if (!params?.evalResult) throw new Error("review/postSummary requires params.evalResult");
      return await controller.postPRSummary(params.prNumber, params.qualityScore, params.evalResult);
    }

    case "review/status": {
      const params = request.params as unknown as { prNumber?: number };
      if (typeof params?.prNumber !== "number") throw new Error("review/status requires params.prNumber");
      return await controller.getPRReviewStatus(params.prNumber);
    }

    default:
      throw new Error(`Method not found: ${request.method}`);
  }
}

function newJobId(): string {
  return `job_${crypto.randomBytes(12).toString("hex")}`;
}

export async function startRpcServer(options: RpcServerOptions): Promise<{ close: () => Promise<void> }> {
  const shutdownGraceMs = options.shutdownGraceMs ?? 5_000;
  const jobs = new Map<string, JobRecord>();
  const mcpHandler = createMcpHandler(options.controller, jobs);

  // OAuth 2.1 provider for ChatGPT MCP connector integration.
  // Falls back to a localhost issuer if no external URL is configured.
  // State is persisted to disk so service restarts don't break ChatGPT's connection.
  const oauthIssuer = options.externalBaseUrl?.replace(/\/+$/, "")
    || `http://${options.bindHost}:${options.port}`;
  const cwd = process.env.CONTROLLER_WORKSPACE || process.cwd();
  const oauthStateFile = resolve(cwd, ".gpc-codex-controller", "oauth-state.json");
  const oauth = new OAuthProvider(oauthIssuer, oauthStateFile);

  const startJob = (method: string, fn: () => Promise<JsonValue>): JobRecord => {
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

    return job;
  };

  const server = http.createServer(async (req, res) => {
    try {
      if (req.method === "GET" && (req.url === "/" || req.url === "/healthz")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
        return;
      }

      // ---- OAuth 2.1 Discovery & Endpoints (no auth required) ----

      if (req.method === "GET" && req.url === "/.well-known/oauth-protected-resource") {
        res.writeHead(200, { "content-type": "application/json", "access-control-allow-origin": "*" });
        res.end(JSON.stringify(oauth.getProtectedResourceMetadata()));
        return;
      }

      if (req.method === "GET" && req.url === "/.well-known/oauth-authorization-server") {
        res.writeHead(200, { "content-type": "application/json", "access-control-allow-origin": "*" });
        res.end(JSON.stringify(oauth.getAuthorizationServerMetadata()));
        return;
      }

      if (req.method === "POST" && req.url === "/oauth/register") {
        const body = await readBody(req, 64 * 1024);
        const parsed = safeJsonParse(body) as Record<string, unknown>;
        const result = oauth.registerClient(parsed);
        res.writeHead(201, { "content-type": "application/json", "access-control-allow-origin": "*" });
        res.end(JSON.stringify(result));
        return;
      }

      if (req.method === "GET" && req.url?.startsWith("/oauth/authorize")) {
        const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
        const result = oauth.authorize(url.searchParams);
        if ("redirectUrl" in result) {
          res.writeHead(302, { location: result.redirectUrl });
          res.end();
        } else {
          res.writeHead(result.status, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: result.error, error_description: result.errorDescription }));
        }
        return;
      }

      if (req.method === "POST" && req.url === "/oauth/token") {
        const body = await readBody(req, 64 * 1024);
        const contentType = req.headers["content-type"] || "";
        let parsed: Record<string, string>;
        if (contentType.includes("application/x-www-form-urlencoded")) {
          parsed = Object.fromEntries(new URLSearchParams(body));
        } else {
          parsed = safeJsonParse(body) as Record<string, string>;
        }
        const result = oauth.exchangeToken(parsed);
        if ("token" in result) {
          res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store", "access-control-allow-origin": "*" });
          res.end(JSON.stringify(result.token));
        } else {
          res.writeHead(result.status, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: result.error, error_description: result.errorDescription }));
        }
        return;
      }

      // CORS preflight for OAuth endpoints
      if (req.method === "OPTIONS" && (req.url?.startsWith("/oauth/") || req.url?.startsWith("/.well-known/"))) {
        res.writeHead(204, {
          "access-control-allow-origin": "*",
          "access-control-allow-methods": "GET, POST, OPTIONS",
          "access-control-allow-headers": "Content-Type, Authorization",
          "access-control-max-age": "86400",
        });
        res.end();
        return;
      }

      // Dashboard endpoint — returns aggregate system status.
      if (req.method === "GET" && req.url === "/dashboard") {
        try {
          const dashboard = await options.controller.getDashboard();
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify(dashboard));
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          res.writeHead(500, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: message }));
        }
        return;
      }

      // GitHub Webhook endpoint — signature-verified, processed async.
      if (req.method === "POST" && req.url === "/webhooks/github") {
        if (options.webhookHandler) {
          await options.webhookHandler.handleRequest(req, res);
        } else {
          res.writeHead(501, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "webhook_handler_not_configured" }));
        }
        return;
      }

      // MCP Streamable HTTP — accepts OAuth tokens, static bearer token, or no auth.
      // ChatGPT connects via OAuth; direct callers use the static bearer token;
      // CF Access bypass allows unauthenticated health/discovery probes.
      if (req.url === "/mcp" || req.url?.startsWith("/mcp?")) {
        // If a bearer token is present, verify it's either the static bearer
        // or an OAuth-issued token. If neither matches, reject.
        const authHeader = req.headers.authorization;
        if (authHeader) {
          const [scheme, token] = authHeader.split(" ");
          if (scheme === "Bearer" && token) {
            const isStaticToken = options.bearerToken && token === options.bearerToken;
            const isOAuthToken = oauth.verifyToken(token);
            if (!isStaticToken && !isOAuthToken) {
              res.writeHead(401, {
                "content-type": "application/json",
                "www-authenticate": `Bearer resource_metadata="${oauthIssuer}/.well-known/oauth-protected-resource"`,
              });
              res.end(JSON.stringify({ error: "invalid_token", error_description: "Token is invalid or expired" }));
              return;
            }
          }
        }
        await mcpHandler(req, res);
        return;
      }

      if (req.method !== "POST" || req.url !== "/rpc") {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "not_found" }));
        return;
      }

      if (options.bearerToken && !requireBearer(req, options.bearerToken)) {
        res.writeHead(401, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "unauthorized" }));
        return;
      }

      const body = await readBody(req, 1024 * 1024);
      const parsed = safeJsonParse(body);
      if (typeof parsed !== "object" || parsed === null) {
        const response = jsonRpcError(null, -32600, "Invalid Request");
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify(response));
        return;
      }

      const request = parsed as Partial<JsonRpcRequest>;
      const id = (request.id ?? null) as JsonValue | null;
      if (request.jsonrpc !== "2.0" || typeof request.method !== "string") {
        const response = jsonRpcError(id, -32600, "Invalid Request");
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify(response));
        return;
      }

      let result: JsonValue;
      try {
        const typed = request as JsonRpcRequest;

        // For long-running controller operations, respond immediately with a jobId.
        const asyncMethods = new Set([
          "task/start",
          "task/continue",
          "fix/untilGreen",
          "mutation/run",
          "garden/run",
          "task/parallel",
          "review/loop",
          "app/boot",
          "bug/reproduce",
          "shell/execute",
          "autonomous/start",
          "ci/triggerAndWait",
          "ci/poll",
          "triage/convertToTask",
        ]);
        if (asyncMethods.has(typed.method)) {
          const job = startJob(typed.method, async () => handle(options.controller, typed));
          result = { accepted: true, jobId: job.jobId };
        } else if (typed.method === "job/get") {
          const params = typed.params as unknown as { jobId?: string };
          if (!params?.jobId || params.jobId.trim().length === 0) {
            throw new Error("job/get requires params.jobId");
          }
          const job = jobs.get(params.jobId.trim());
          if (!job) {
            throw new Error(`Unknown jobId: ${params.jobId}`);
          }
          result = job;
        } else {
          result = await handle(options.controller, typed);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const response =
          message.startsWith("Method not found:")
            ? jsonRpcError(id, -32601, message)
            : jsonRpcError(id, -32000, message);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(response));
        return;
      }

      const response: JsonRpcResponse = { jsonrpc: "2.0", id, result };
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(response));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "internal_error", message }));
    }
  });

  server.listen(options.port, options.bindHost);

  // Small delay so systemd "active" isn't a race with immediate close checks.
  await delay(50);

  return {
    close: async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
      await delay(Math.min(50, shutdownGraceMs));
    },
  };
}
