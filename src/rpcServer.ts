import http from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import type { Controller } from "./controller.js";

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

    default:
      throw new Error(`Method not found: ${request.method}`);
  }
}

export async function startRpcServer(options: RpcServerOptions): Promise<{ close: () => Promise<void> }> {
  const shutdownGraceMs = options.shutdownGraceMs ?? 5_000;
  const server = http.createServer(async (req, res) => {
    try {
      if (req.method === "GET" && (req.url === "/" || req.url === "/healthz")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
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
        result = await handle(options.controller, request as JsonRpcRequest);
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
