import http from "node:http";
import crypto from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type { Controller } from "./controller.js";
import { createMcpHandler, type JobRecord } from "./mcpServer.js";

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

      // MCP Streamable HTTP — no bearer auth (CF Access secures the path;
      // ChatGPT Apps connect without bearer tokens in "No Auth" mode).
      if (req.url === "/mcp" || req.url?.startsWith("/mcp?")) {
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
