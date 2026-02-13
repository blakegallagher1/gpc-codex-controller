import { EventEmitter } from "node:events";
import { once } from "node:events";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import {
  type CompactStartParams,
  type CompactStartResult,
  type InitializeParams,
  type InitializeResult,
  type JsonRpcId,
  type JsonRpcMessage,
  type JsonRpcRequest,
  type JsonRpcResponse,
  type LoginStartResult,
  type TurnStartParams,
  type TurnStartResult,
  type ThreadStartParams,
  type ThreadStartResult,
  type TurnSteerParams,
  type ReviewStartParams,
  type TokenUsageUpdate,
  isJsonRpcFailure,
  isJsonRpcRequest,
  isJsonRpcResponse,
} from "./types.js";

interface AppServerClientOptions {
  command?: string;
  args?: readonly string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  requestTimeoutMs?: number;
  stopTimeoutMs?: number;
  autoApproveRequests?: boolean;
}

interface PendingRequest {
  method: string;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
}

export class AppServerClient extends EventEmitter {
  private readonly command: string;
  private readonly args: readonly string[];
  private readonly cwd: string | undefined;
  private readonly env: NodeJS.ProcessEnv | undefined;
  private readonly requestTimeoutMs: number;
  private readonly stopTimeoutMs: number;
  private readonly autoApproveRequests: boolean;

  private child: ChildProcessWithoutNullStreams | undefined;
  private pending = new Map<number, PendingRequest>();
  private nextRequestId = 1;
  private readonly tokenUsageByThread = new Map<string, TokenUsageUpdate>();
  private tokenUsageListenerBound = false;

  private receiveTextBuffer = "";

  public constructor(options: AppServerClientOptions = {}) {
    super();
    this.command = options.command ?? "codex";
    this.args = options.args ?? ["app-server"];
    this.cwd = options.cwd;
    this.env = options.env;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
    this.stopTimeoutMs = options.stopTimeoutMs ?? 3_000;
    this.autoApproveRequests = options.autoApproveRequests ?? true;
  }

  public async start(): Promise<void> {
    if (this.child) {
      return;
    }

    const env = this.buildChildEnv();
    const child = spawn(this.command, this.args, {
      cwd: this.cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    this.child = child;
    this.bindChildProcess(child);

    await new Promise<void>((resolve, reject) => {
      const onSpawn = (): void => {
        cleanup();
        resolve();
      };

      const onError = (error: Error): void => {
        cleanup();
        reject(error);
      };

      const cleanup = (): void => {
        child.off("spawn", onSpawn);
        child.off("error", onError);
      };

      child.once("spawn", onSpawn);
      child.once("error", onError);
    });
  }

  public async stop(): Promise<void> {
    const child = this.child;
    if (!child) {
      return;
    }

    child.kill("SIGTERM");

    try {
      await Promise.race([
        once(child, "exit"),
        new Promise((_, reject) => {
          setTimeout(() => reject(new Error("Timed out waiting for app-server shutdown")), this.stopTimeoutMs);
        }),
      ]);
    } catch {
      child.kill("SIGKILL");
    }
  }

  public async initialize(params: InitializeParams): Promise<InitializeResult> {
    return this.request<InitializeResult>("initialize", params);
  }

  public async startChatGptLogin(): Promise<LoginStartResult> {
    return this.request<LoginStartResult>("account/login/start", { type: "chatgpt" });
  }

  public async startThread(params: ThreadStartParams): Promise<ThreadStartResult> {
    return this.request<ThreadStartResult>("thread/start", params);
  }

  public async startTurn(params: TurnStartParams): Promise<TurnStartResult> {
    return this.request<TurnStartResult>("turn/start", params);
  }

  public async compactThread(threadId: string): Promise<CompactStartResult> {
    return this.request<CompactStartResult>("thread/compact/start", { threadId } satisfies CompactStartParams);
  }

  public async steerTurn(params: TurnSteerParams): Promise<void> {
    return this.request("turn/steer", params);
  }

  public async interruptTurn(threadId: string, turnId: string): Promise<void> {
    return this.request("turn/interrupt", { threadId, turnId });
  }

  public async forkThread(threadId: string): Promise<ThreadStartResult> {
    return this.request<ThreadStartResult>("thread/fork", { threadId });
  }

  public async startReview(params: ReviewStartParams): Promise<void> {
    return this.request("review/start", params);
  }

  public async resumeThread(threadId: string): Promise<ThreadStartResult> {
    return this.request<ThreadStartResult>("thread/resume", { threadId });
  }

  public async rollbackThread(threadId: string, count: number): Promise<void> {
    return this.request("thread/rollback", { threadId, count });
  }

  public getTokenUsage(threadId: string): TokenUsageUpdate | undefined {
    return this.tokenUsageByThread.get(threadId);
  }

  public enableTokenUsageTracking(): void {
    if (this.tokenUsageListenerBound) {
      return;
    }
    this.tokenUsageListenerBound = true;

    this.on("notification", (method: string, params: unknown) => {
      if (method !== "thread/tokenUsage/updated") {
        return;
      }
      const usage = params as TokenUsageUpdate | undefined;
      if (!usage?.threadId) {
        return;
      }
      this.tokenUsageByThread.set(usage.threadId, usage);
      this.emit("tokenUsage", usage);
    });
  }

  public async request<TResult, TParams = unknown>(method: string, params?: TParams): Promise<TResult> {
    const id = this.nextRequestId;
    this.nextRequestId += 1;

    const message: JsonRpcRequest<TParams> = {
      jsonrpc: "2.0",
      id,
      method,
      ...(params === undefined ? {} : { params }),
    };

    const promise = new Promise<TResult>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`JSON-RPC request timed out (${method})`));
      }, this.requestTimeoutMs);

      this.pending.set(id, {
        method,
        resolve: (value) => resolve(value as TResult),
        reject,
        timeout,
      });
    });

    try {
      this.writeMessage(message);
    } catch (error) {
      const pending = this.pending.get(id);
      if (pending) {
        clearTimeout(pending.timeout);
        this.pending.delete(id);
      }

      throw error;
    }

    return promise;
  }

  public notify<TParams>(method: string, params?: TParams): void {
    const message = {
      jsonrpc: "2.0" as const,
      method,
      ...(params === undefined ? {} : { params }),
    };

    this.writeMessage(message);
  }

  public async waitForNotification<TParams>(
    method: string,
    timeoutMs: number,
    predicate?: (params: TParams | undefined) => boolean,
  ): Promise<TParams | undefined> {
    return new Promise<TParams | undefined>((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`Timed out waiting for notification: ${method}`));
      }, timeoutMs);

      const onNotification = (notificationMethod: string, params: unknown): void => {
        if (notificationMethod !== method) {
          return;
        }

        const typedParams = params as TParams | undefined;
        if (predicate && !predicate(typedParams)) {
          return;
        }

        cleanup();
        resolve(typedParams);
      };

      const cleanup = (): void => {
        clearTimeout(timer);
        this.off("notification", onNotification);
      };

      this.on("notification", onNotification);
    });
  }

  private bindChildProcess(child: ChildProcessWithoutNullStreams): void {
    child.stdout.on("data", (chunk: Buffer) => this.onStdoutChunk(chunk));
    child.stderr.on("data", (chunk: Buffer) => {
      this.emit("stderr", chunk.toString("utf8"));
    });

    child.on("error", (error: Error) => {
      this.rejectAllPending(error);
      this.child = undefined;
      this.emit("error", error);
    });

    child.on("exit", (code, signal) => {
      this.rejectAllPending(new Error(`app-server exited (code=${code ?? "null"}, signal=${signal ?? "null"})`));
      this.child = undefined;
      this.emit("exit", code, signal);
    });
  }

  private buildChildEnv(): NodeJS.ProcessEnv {
    const merged = { ...process.env, ...this.env };
    delete merged.OPENAI_API_KEY;
    return merged;
  }

  private rejectAllPending(error: Error): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timeout);
      pending.reject(error);
      this.pending.delete(id);
    }
  }

  private onStdoutChunk(chunk: Buffer): void {
    this.receiveTextBuffer += chunk.toString("utf8");

    while (true) {
      const newlineIndex = this.receiveTextBuffer.indexOf("\n");
      if (newlineIndex === -1) {
        return;
      }

      const rawLine = this.receiveTextBuffer.slice(0, newlineIndex);
      this.receiveTextBuffer = this.receiveTextBuffer.slice(newlineIndex + 1);

      const payload = rawLine.trim();
      if (payload.length === 0) {
        continue;
      }

      this.handleMessage(payload);
    }
  }

  private handleMessage(raw: string): void {
    let message: JsonRpcMessage;

    try {
      message = JSON.parse(raw) as JsonRpcMessage;
    } catch (error) {
      this.emit("protocolError", new Error(`Failed to parse JSON-RPC payload: ${String(error)}`));
      return;
    }

    if (isJsonRpcResponse(message)) {
      this.handleResponse(message);
      return;
    }

    if (isJsonRpcRequest(message)) {
      if (this.autoApproveRequests && this.tryHandleAutoApproval(message)) {
        return;
      }

      this.emit("serverRequest", message.method, message.params, message.id);
      this.sendMethodNotFound(message.id, message.method);
      return;
    }

    this.emit("notification", message.method, message.params);
  }

  private handleResponse(message: JsonRpcResponse): void {
    if (typeof message.id !== "number") {
      return;
    }

    const pending = this.pending.get(message.id);
    if (!pending) {
      return;
    }

    this.pending.delete(message.id);
    clearTimeout(pending.timeout);

    if (isJsonRpcFailure(message)) {
      pending.reject(
        new Error(`JSON-RPC request failed (${pending.method}): [${message.error.code}] ${message.error.message}`),
      );
      return;
    }

    pending.resolve(message.result);
  }

  private sendMethodNotFound(id: JsonRpcId, method: string): void {
    this.writeMessage({
      jsonrpc: "2.0",
      id,
      error: {
        code: -32601,
        message: `Unsupported server-initiated request: ${method}`,
      },
    });
  }

  private tryHandleAutoApproval(message: JsonRpcRequest): boolean {
    if (message.method === "item/fileChange/requestApproval") {
      this.writeMessage({
        jsonrpc: "2.0",
        id: message.id,
        result: { decision: "accept" },
      });
      this.emit("approvalAutoAccepted", message.method, message.params);
      return true;
    }

    if (message.method === "item/commandExecution/requestApproval") {
      this.writeMessage({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          decision: "accept",
          acceptSettings: { forSession: true },
        },
      });
      this.emit("approvalAutoAccepted", message.method, message.params);
      return true;
    }

    if (message.method === "applyPatchApproval" || message.method === "execCommandApproval") {
      this.writeMessage({
        jsonrpc: "2.0",
        id: message.id,
        result: { decision: "approved_for_session" },
      });
      this.emit("approvalAutoAccepted", message.method, message.params);
      return true;
    }

    return false;
  }

  private writeMessage(message: object): void {
    const child = this.child;
    if (!child) {
      throw new Error("app-server is not running");
    }

    const payload = JSON.stringify(message);
    child.stdin.write(`${payload}\n`, "utf8");
  }
}
