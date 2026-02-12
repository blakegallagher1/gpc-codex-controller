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
