import { EventEmitter } from "node:events";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { AppServerClient } from "./appServerClient.js";
import type {
  ApprovalPolicy,
  ControllerState,
  FixUntilGreenResult,
  InitializeParams,
  ItemDeltaParams,
  LoginCompletedParams,
  SandboxPolicy,
  StartOrContinueTaskResult,
  ThreadStartResult,
  TurnCompletedParams,
  TurnDiffUpdatedParams,
  VerifyResult,
  WorkspaceWriteTurnSandboxPolicy,
} from "./types.js";
import { WorkspaceManager } from "./workspaceManager.js";

interface ControllerOptions {
  workspacePath: string;
  stateFilePath: string;
  model?: "gpt-5.2-codex";
  sandboxPolicy?: SandboxPolicy;
  approvalPolicy?: ApprovalPolicy;
  loginTimeoutMs?: number;
  workspaceManager?: WorkspaceManager;
  streamToStdout?: boolean;
}

const VERIFY_JSON_FILENAME = ".agent-verify.json";
const VERIFY_OUTPUT_TAIL_LINES = 120;
const TURN_TIMEOUT_MS = 20 * 60_000;
const TURN_WORKSPACE_SANDBOX: WorkspaceWriteTurnSandboxPolicy = { type: "workspaceWrite" };

export class Controller extends EventEmitter {
  private readonly workspacePath: string;
  private readonly stateFilePath: string;
  private readonly model: "gpt-5.2-codex";
  private readonly sandboxPolicy: SandboxPolicy;
  private readonly approvalPolicy: ApprovalPolicy;
  private readonly loginTimeoutMs: number;
  private readonly workspaceManager: WorkspaceManager;
  private readonly streamToStdout: boolean;

  private state: ControllerState = {};
  private bootstrapped = false;
  private turnEventsBound = false;
  private itemEventsBound = false;
  private approvalEventsBound = false;

  public constructor(
    private readonly appServerClient: AppServerClient,
    options: ControllerOptions,
  ) {
    super();
    this.workspacePath = options.workspacePath;
    this.stateFilePath = options.stateFilePath;
    this.model = options.model ?? "gpt-5.2-codex";
    this.sandboxPolicy = options.sandboxPolicy ?? "workspaceWrite";
    this.approvalPolicy = options.approvalPolicy ?? "never";
    this.loginTimeoutMs = options.loginTimeoutMs ?? 5 * 60_000;
    this.workspaceManager = options.workspaceManager ?? new WorkspaceManager();
    this.streamToStdout = options.streamToStdout ?? true;
  }

  public async bootstrap(): Promise<{ threadId: string }> {
    await this.ensureSessionReady();

    const threadId = await this.ensureThread();
    return { threadId };
  }

  public handleTurnEvents(): void {
    if (this.turnEventsBound) {
      return;
    }

    this.turnEventsBound = true;
    this.appServerClient.on("notification", (method: string, params: unknown) => {
      if (method === "turn/diff/updated") {
        const payload = params as TurnDiffUpdatedParams;
        this.emit("turn/diff/updated", payload);

        if (this.streamToStdout && typeof payload.diff === "string" && payload.diff.trim().length > 0) {
          process.stdout.write(`\n[turn/diff/updated]\n${payload.diff}\n`);
        }

        return;
      }

      if (method === "turn/completed") {
        const payload = params as TurnCompletedParams;
        this.emit("turn/completed", payload);
      }
    });
  }

  public handleItemEvents(): void {
    if (this.itemEventsBound) {
      return;
    }

    this.itemEventsBound = true;
    this.appServerClient.on("notification", (method: string, params: unknown) => {
      if (method !== "item/agentMessage/delta" && method !== "item/commandExecution/outputDelta") {
        return;
      }

      const payload = params as ItemDeltaParams;
      this.emit(method, payload);

      if (this.streamToStdout && typeof payload.delta === "string") {
        process.stdout.write(payload.delta);
      }
    });
  }

  public handleApprovalEvents(): void {
    if (this.approvalEventsBound) {
      return;
    }

    this.approvalEventsBound = true;
    this.appServerClient.on("approvalAutoAccepted", (method: string, params: unknown) => {
      this.emit("approval/autoAccepted", { method, params });
    });
  }

  public async startTask(prompt: string): Promise<StartOrContinueTaskResult> {
    await this.ensureSessionReady();
    this.handleTurnEvents();
    this.handleItemEvents();
    this.handleApprovalEvents();

    const threadId = await this.createAndPersistNewThread(this.workspacePath);
    return this.executeTurn({
      threadId,
      prompt,
      cwd: this.workspacePath,
    });
  }

  public async continueTask(threadId: string, prompt: string): Promise<StartOrContinueTaskResult> {
    await this.ensureSessionReady();
    this.handleTurnEvents();
    this.handleItemEvents();
    this.handleApprovalEvents();

    const normalizedThreadId = threadId.trim();
    if (normalizedThreadId.length === 0) {
      throw new Error("continueTask requires a non-empty threadId");
    }

    if (this.state.threadId !== normalizedThreadId) {
      this.state.threadId = normalizedThreadId;
      await this.saveState();
    }

    return this.executeTurn({
      threadId: normalizedThreadId,
      prompt,
      cwd: this.workspacePath,
    });
  }

  public async runVerify(taskId: string): Promise<VerifyResult> {
    const workspacePath = await this.workspaceManager.createWorkspace(taskId);

    const verifyResult = await this.workspaceManager.runInWorkspaceAllowNonZero(taskId, ["pnpm", "verify"]);
    const verificationJson = await this.readVerificationJson(workspacePath);

    const combinedOutput = `${verifyResult.stdout}\n${verifyResult.stderr}`;
    const parsedFailures = verificationJson === null
      ? this.parseFailuresFromStdout(combinedOutput)
      : this.parseFailuresFromJson(verificationJson);

    const normalizedSuccess = this.resolveVerifySuccess(verifyResult.exitCode, verificationJson, parsedFailures);

    return {
      taskId,
      workspacePath,
      success: normalizedSuccess,
      exitCode: verifyResult.exitCode,
      verificationJson,
      parsedFailures,
      stdoutTail: this.tailLines(verifyResult.stdout, VERIFY_OUTPUT_TAIL_LINES),
      stderrTail: this.tailLines(verifyResult.stderr, VERIFY_OUTPUT_TAIL_LINES),
      combinedTail: this.tailLines(combinedOutput, VERIFY_OUTPUT_TAIL_LINES),
    };
  }

  public async fixUntilGreen(taskId: string, maxIterations = 5): Promise<FixUntilGreenResult> {
    if (!Number.isSafeInteger(maxIterations) || maxIterations <= 0) {
      throw new Error(`maxIterations must be a positive integer, got: ${maxIterations}`);
    }

    const { threadId } = await this.bootstrap();

    let iteration = 0;
    let lastVerify = await this.runVerify(taskId);
    while (iteration < maxIterations) {
      iteration += 1;

      if (lastVerify.success) {
        return {
          taskId,
          success: true,
          iterations: iteration,
          lastVerify,
        };
      }

      if (iteration >= maxIterations) {
        break;
      }

      const diffStat = await this.workspaceManager.runInWorkspace(taskId, ["git", "diff", "--stat"]);
      const prompt = this.buildFixPrompt({
        taskId,
        iteration,
        maxIterations,
        verify: lastVerify,
        diffStat: diffStat.stdout,
      });

      await this.executeTurn({
        threadId,
        prompt,
        cwd: lastVerify.workspacePath,
      });

      lastVerify = await this.runVerify(taskId);
    }

    return {
      taskId,
      success: false,
      iterations: maxIterations,
      lastVerify,
    };
  }

  private async ensureSessionReady(): Promise<void> {
    if (this.bootstrapped) {
      return;
    }

    await this.loadState();
    await this.appServerClient.start();

    await this.initialize();
    await this.ensureChatGptLogin();

    this.handleTurnEvents();
    this.handleItemEvents();
    this.handleApprovalEvents();

    this.bootstrapped = true;
  }

  private async initialize(): Promise<void> {
    const initializeParams: InitializeParams = {
      clientInfo: {
        name: "gpc-codex-controller",
        version: "0.1.0",
      },
    };

    await this.appServerClient.initialize(initializeParams);
  }

  private async ensureChatGptLogin(): Promise<void> {
    const loginStart = await this.appServerClient.startChatGptLogin();
    if (loginStart.type !== "chatgpt") {
      throw new Error("account/login/start returned API key auth; this controller requires ChatGPT auth mode");
    }

    console.log(`Open this URL to complete ChatGPT authentication: ${loginStart.authUrl}`);

    const completion = await this.appServerClient.waitForNotification<LoginCompletedParams>(
      "account/login/completed",
      this.loginTimeoutMs,
      (params) => params?.loginId === loginStart.loginId,
    );

    if (!completion?.success) {
      const detail = completion?.error ?? "unknown login error";
      throw new Error(`ChatGPT login did not complete successfully: ${detail}`);
    }
  }

  private async ensureThread(): Promise<string> {
    if (this.state.threadId) {
      return this.state.threadId;
    }

    return this.createAndPersistNewThread(this.workspacePath);
  }

  private async createAndPersistNewThread(cwd: string): Promise<string> {
    const result = await this.appServerClient.startThread({
      model: this.model,
      modelProvider: null,
      cwd,
      approvalPolicy: this.approvalPolicy,
      sandbox: this.sandboxPolicy,
      config: null,
      baseInstructions: null,
      developerInstructions: null,
    });

    const threadId = this.extractThreadId(result);
    this.state.threadId = threadId;
    await this.saveState();

    return threadId;
  }

  private async executeTurn(args: {
    threadId: string;
    prompt: string;
    cwd: string;
  }): Promise<StartOrContinueTaskResult> {
    const prompt = args.prompt.trim();
    if (prompt.length === 0) {
      throw new Error("Prompt must be a non-empty string");
    }

    const startResult = await this.appServerClient.startTurn({
      threadId: args.threadId,
      input: [{ type: "text", text: prompt }],
      cwd: args.cwd,
      approvalPolicy: "never",
      sandboxPolicy: TURN_WORKSPACE_SANDBOX,
      model: this.model,
      effort: null,
      summary: null,
    });

    const startedTurnId = startResult.turn.id;
    const waitForCompletion = this.appServerClient.waitForNotification<TurnCompletedParams>(
      "turn/completed",
      TURN_TIMEOUT_MS,
      (params) => params?.threadId === args.threadId && params.turn.id === startedTurnId,
    );

    const completion = await this.waitForTurnOutcome(waitForCompletion, args.threadId, startedTurnId);

    if (!completion) {
      throw new Error(`Missing turn/completed payload for thread=${args.threadId} turn=${startedTurnId}`);
    }

    const status = completion.turn.status;
    if (status === "failed" || status === "interrupted") {
      const failureMessage = completion.turn.error?.message ?? "No error message from server";
      throw new Error(`Turn ${status} (thread=${args.threadId}, turn=${completion.turn.id}): ${failureMessage}`);
    }

    return {
      threadId: args.threadId,
      turnId: completion.turn.id,
      status,
    };
  }

  private async waitForTurnOutcome(
    waitForCompletion: Promise<TurnCompletedParams | undefined>,
    threadId: string,
    turnId: string,
  ): Promise<TurnCompletedParams | undefined> {
    return new Promise<TurnCompletedParams | undefined>((resolve, reject) => {
      let settled = false;

      const cleanup = (): void => {
        this.appServerClient.off("exit", onExit);
        this.appServerClient.off("error", onError);
      };

      const resolveOnce = (value: TurnCompletedParams | undefined): void => {
        if (settled) {
          return;
        }

        settled = true;
        cleanup();
        resolve(value);
      };

      const rejectOnce = (error: Error): void => {
        if (settled) {
          return;
        }

        settled = true;
        cleanup();
        reject(error);
      };

      const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
        rejectOnce(
          new Error(
            `app-server exited while waiting for turn completion (thread=${threadId}, turn=${turnId}, code=${code ?? "null"}, signal=${signal ?? "null"})`,
          ),
        );
      };

      const onError = (error: Error): void => {
        rejectOnce(
          new Error(
            `app-server error while waiting for turn completion (thread=${threadId}, turn=${turnId}): ${error.message}`,
          ),
        );
      };

      this.appServerClient.on("exit", onExit);
      this.appServerClient.on("error", onError);

      void waitForCompletion.then(resolveOnce).catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        rejectOnce(
          new Error(
            `Failed waiting for turn/completed (thread=${threadId}, turn=${turnId}): ${message}`,
          ),
        );
      });
    });
  }

  private extractThreadId(result: ThreadStartResult): string {
    if (!result.thread || typeof result.thread.id !== "string" || result.thread.id.length === 0) {
      throw new Error("thread/start response did not include a valid threadId");
    }

    return result.thread.id;
  }

  private async loadState(): Promise<void> {
    try {
      const raw = await readFile(this.stateFilePath, "utf8");
      const parsed = JSON.parse(raw) as ControllerState;
      this.state = parsed;
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        (error as { code?: unknown }).code === "ENOENT"
      ) {
        this.state = {};
        return;
      }

      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to load controller state from ${this.stateFilePath}: ${message}`);
    }
  }

  private async saveState(): Promise<void> {
    await mkdir(dirname(this.stateFilePath), { recursive: true });

    const tempPath = `${this.stateFilePath}.tmp`;
    await writeFile(tempPath, `${JSON.stringify(this.state, null, 2)}\n`, "utf8");
    await rename(tempPath, this.stateFilePath);
  }

  private async readVerificationJson(workspacePath: string): Promise<unknown | null> {
    const verifyPath = `${workspacePath}/${VERIFY_JSON_FILENAME}`;

    try {
      await stat(verifyPath);
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        (error as { code?: unknown }).code === "ENOENT"
      ) {
        return null;
      }

      throw error;
    }

    const raw = await readFile(verifyPath, "utf8");
    return JSON.parse(raw) as unknown;
  }

  private parseFailuresFromJson(input: unknown): string[] {
    if (typeof input !== "object" || input === null) {
      return [];
    }

    const asRecord = input as Record<string, unknown>;
    const failures: string[] = [];

    const keysToScan = ["failures", "errors", "issues"];
    for (const key of keysToScan) {
      const value = asRecord[key];
      if (!Array.isArray(value)) {
        continue;
      }

      for (const item of value) {
        if (typeof item === "string") {
          failures.push(item);
          continue;
        }

        if (
          typeof item === "object" &&
          item !== null &&
          "message" in item &&
          typeof (item as { message: unknown }).message === "string"
        ) {
          failures.push((item as { message: string }).message);
        }
      }
    }

    return failures;
  }

  private parseFailuresFromStdout(output: string): string[] {
    const lines = output
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0);

    return lines.filter((line) => /(error|fail|failing|failed|✖|×)/i.test(line)).slice(-20);
  }

  private resolveVerifySuccess(exitCode: number, verificationJson: unknown | null, parsedFailures: string[]): boolean {
    if (verificationJson && typeof verificationJson === "object") {
      const asRecord = verificationJson as Record<string, unknown>;
      if (typeof asRecord.success === "boolean") {
        return asRecord.success;
      }

      if (typeof asRecord.ok === "boolean") {
        return asRecord.ok;
      }

      if (typeof asRecord.passed === "boolean") {
        return asRecord.passed;
      }
    }

    if (exitCode !== 0) {
      return false;
    }

    return parsedFailures.length === 0;
  }

  private tailLines(input: string, count: number): string {
    return input
      .split(/\r?\n/)
      .slice(-count)
      .join("\n")
      .trim();
  }

  private buildFixPrompt(args: {
    taskId: string;
    iteration: number;
    maxIterations: number;
    verify: VerifyResult;
    diffStat: string;
  }): string {
    const verificationJsonText = args.verify.verificationJson === null
      ? "null"
      : JSON.stringify(args.verify.verificationJson, null, 2);

    return [
      `Task: make pnpm verify pass for gpc-cres workspace taskId=${args.taskId}.`,
      `Iteration: ${args.iteration}/${args.maxIterations}.`,
      "",
      "Constraints (must follow):",
      "1. Apply minimal changes only to make verification pass.",
      "2. Do not change root config unless required to fix verify.",
      "3. Do not change Prisma migrations unless explicitly needed for the failing check.",
      "4. Keep edits scoped to the current workspace.",
      "5. Preserve pnpm workspace structure for gpc-cres monorepo.",
      "",
      "Verification JSON (.agent-verify.json if present):",
      verificationJsonText,
      "",
      "git diff --stat:",
      args.diffStat.trim() || "(no diff)",
      "",
      "Failing output tail:",
      args.verify.combinedTail || "(empty)",
      "",
      "Now produce and apply the smallest valid fix.",
    ].join("\n");
  }
}
