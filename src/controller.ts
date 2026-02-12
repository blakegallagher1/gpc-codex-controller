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
  RunMutationResult,
  SandboxPolicy,
  StartOrContinueTaskResult,
  TaskRecord,
  TaskStatus,
  ThreadStartResult,
  TurnCompletedParams,
  TurnDiffUpdatedParams,
  VerifyResult,
  WorkspaceWriteTurnSandboxPolicy,
} from "./types.js";
import { GitManager } from "./gitManager.js";
import { TaskRegistry } from "./taskRegistry.js";
import { WorkspaceManager } from "./workspaceManager.js";

interface ControllerOptions {
  workspacePath: string;
  stateFilePath: string;
  model?: "gpt-5.2-codex";
  sandboxPolicy?: SandboxPolicy;
  approvalPolicy?: ApprovalPolicy;
  loginTimeoutMs?: number;
  workspaceManager?: WorkspaceManager;
  gitManager?: GitManager;
  taskRegistry?: TaskRegistry;
  streamToStdout?: boolean;
}

const VERIFY_JSON_FILENAME = ".agent-verify.json";
const VERIFY_OUTPUT_TAIL_LINES = 120;
const TURN_TIMEOUT_MS = 20 * 60_000;
const TURN_WORKSPACE_SANDBOX: WorkspaceWriteTurnSandboxPolicy = { type: "workspaceWrite" };
const MAX_TURNS_PER_TASK = 5;
const MAX_IDENTICAL_FIX_DIFFS = 3;
const BLOCKED_ROOT_FILES = new Set(["package.json", "tsconfig.json", "eslint.config.mjs", "coordinator.ts"]);

export class Controller extends EventEmitter {
  private readonly workspacePath: string;
  private readonly stateFilePath: string;
  private readonly model: "gpt-5.2-codex";
  private readonly sandboxPolicy: SandboxPolicy;
  private readonly approvalPolicy: ApprovalPolicy;
  private readonly loginTimeoutMs: number;
  private readonly workspaceManager: WorkspaceManager;
  private readonly gitManager: GitManager;
  private readonly taskRegistry: TaskRegistry;
  private readonly streamToStdout: boolean;

  private state: ControllerState = {};
  private bootstrapped = false;
  private bootstrapPromise: Promise<void> | null = null;
  private turnEventsBound = false;
  private itemEventsBound = false;
  private approvalEventsBound = false;
  private readonly turnStartCountByTask = new Map<string, number>();

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
    this.gitManager = options.gitManager ?? new GitManager(this.workspaceManager);
    this.taskRegistry = options.taskRegistry ?? new TaskRegistry(`${dirname(this.stateFilePath)}/tasks.json`);
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
      prompt: this.buildMutationPrompt(prompt),
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

    let activeThreadId: string | undefined;
    const task = await this.taskRegistry.getTask(taskId);
    if (task?.threadId) {
      activeThreadId = task.threadId;
    }

    if (!activeThreadId) {
      const { threadId } = await this.bootstrap();
      activeThreadId = threadId;
    }

    let iteration = 0;
    let lastVerify = await this.runVerify(taskId);
    let previousDiffStat: string | null = null;
    let identicalDiffStreak = 0;
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
      const normalizedDiffStat = diffStat.stdout.trim();
      if (previousDiffStat !== null && previousDiffStat === normalizedDiffStat) {
        identicalDiffStreak += 1;
      } else {
        identicalDiffStreak = 1;
      }
      previousDiffStat = normalizedDiffStat;

      if (identicalDiffStreak >= MAX_IDENTICAL_FIX_DIFFS) {
        await this.updateTaskStatusIfExists(taskId, "failed");
        throw new Error(
          `Aborting fix loop for taskId=${taskId}: identical diff observed ${identicalDiffStreak} consecutive times.`,
        );
      }

      const prompt = this.buildFixPrompt({
        taskId,
        iteration,
        maxIterations,
        verify: lastVerify,
        diffStat: diffStat.stdout,
      });

      await this.executeTurn({
        taskId,
        threadId: activeThreadId,
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

  public async createPullRequest(taskId: string, title: string, body: string): Promise<string> {
    const trimmedTitle = title.trim();
    if (trimmedTitle.length === 0) {
      throw new Error("createPullRequest requires a non-empty title");
    }

    await this.workspaceManager.createWorkspace(taskId);
    const branchName = await this.gitManager.pushBranch(taskId);
    if (branchName === "main") {
      throw new Error("Refusing to open pull request from main to main. Create and switch to a feature branch first.");
    }

    const remoteResult = await this.workspaceManager.runInWorkspace(taskId, ["git", "remote", "get-url", "origin"]);
    const repo = this.parseGitHubRepo(remoteResult.stdout);
    const token = process.env.GITHUB_TOKEN?.trim();
    if (!token) {
      throw new Error("GITHUB_TOKEN is required to create pull requests");
    }

    const response = await fetch(`https://api.github.com/repos/${repo.owner}/${repo.name}/pulls`, {
      method: "POST",
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "User-Agent": "gpc-codex-controller",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      body: JSON.stringify({
        title: trimmedTitle,
        body,
        head: branchName,
        base: "main",
      }),
    });

    const payload = await response.json() as unknown;
    if (!response.ok) {
      const message = this.extractGitHubApiErrorMessage(payload) ?? `GitHub API error (status ${response.status})`;
      throw new Error(`Failed to create pull request: ${message}`);
    }

    if (typeof payload !== "object" || payload === null) {
      throw new Error("GitHub API returned an invalid pull request payload");
    }

    const htmlUrl = (payload as Record<string, unknown>).html_url;
    if (typeof htmlUrl !== "string" || htmlUrl.length === 0) {
      throw new Error("GitHub API response missing pull request html_url");
    }

    return htmlUrl;
  }

  public async createTask(taskId: string): Promise<TaskRecord> {
    await this.ensureSessionReady();

    const existing = await this.taskRegistry.getTask(taskId);
    if (existing) {
      throw new Error(`Task already exists: ${taskId}`);
    }

    const workspacePath = await this.workspaceManager.createWorkspace(taskId);
    const branchName = await this.gitManager.createBranch(taskId);
    const threadId = await this.createThreadForWorkspace(workspacePath);

    const record: TaskRecord = {
      taskId,
      workspacePath,
      branchName,
      threadId,
      createdAt: new Date().toISOString(),
      status: "created",
    };

    return this.taskRegistry.createTask(record);
  }

  public async getTask(taskId: string): Promise<TaskRecord | null> {
    return this.taskRegistry.getTask(taskId);
  }

  public async updateTaskStatus(taskId: string, status: TaskStatus): Promise<TaskRecord> {
    return this.taskRegistry.updateTaskStatus(taskId, status);
  }

  public async runMutation(taskId: string, featureDescription: string): Promise<RunMutationResult> {
    const normalizedFeatureDescription = featureDescription.trim();
    if (normalizedFeatureDescription.length === 0) {
      throw new Error("runMutation requires a non-empty featureDescription");
    }

    let task: TaskRecord | null = null;
    try {
      task = await this.createTask(taskId);
      await this.updateTaskStatus(taskId, "mutating");

      await this.executeTurn({
        taskId,
        threadId: task.threadId,
        prompt: this.buildMutationPrompt(normalizedFeatureDescription),
        cwd: task.workspacePath,
      });

      await this.updateTaskStatus(taskId, "verifying");
      const fixResult = await this.fixUntilGreen(taskId, 5);
      if (!fixResult.success) {
        throw new Error(`Verification did not pass within iteration limit for taskId=${taskId}`);
      }

      await this.updateTaskStatus(taskId, "ready");
      const commitMessage = this.generateCommitMessage(normalizedFeatureDescription);
      const committed = await this.gitManager.commitAll(taskId, commitMessage);
      if (!committed) {
        throw new Error("Mutation finished with no file changes to commit");
      }

      const title = this.generatePullRequestTitle(normalizedFeatureDescription);
      const body = this.generatePullRequestBody(taskId, normalizedFeatureDescription, fixResult.iterations);
      const prUrl = await this.createPullRequest(taskId, title, body);
      await this.updateTaskStatus(taskId, "pr_opened");

      return {
        taskId,
        branch: task.branchName,
        prUrl,
        iterations: fixResult.iterations,
        success: true,
      };
    } catch (error) {
      if (task) {
        try {
          await this.updateTaskStatus(task.taskId, "failed");
        } catch {
          // Preserve original error when task status update fails.
        }
      }

      throw error;
    }
  }

  private async ensureSessionReady(): Promise<void> {
    if (this.bootstrapped) {
      return;
    }

    if (this.bootstrapPromise) {
      await this.bootstrapPromise;
      return;
    }

    this.bootstrapPromise = (async () => {
      await this.loadState();
      await this.appServerClient.start();

      await this.initialize();
      await this.ensureChatGptLogin();

      this.handleTurnEvents();
      this.handleItemEvents();
      this.handleApprovalEvents();

      this.bootstrapped = true;
    })();

    try {
      await this.bootstrapPromise;
    } finally {
      this.bootstrapPromise = null;
    }
  }

  private async initialize(): Promise<void> {
    const initializeParams: InitializeParams = {
      clientInfo: {
        name: "gpc-codex-controller",
        version: "0.1.0",
      },
    };

    try {
      await this.appServerClient.initialize(initializeParams);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes("Already initialized")) {
        // codex app-server may treat initialize as a one-time operation per process; treat as idempotent.
        return;
      }
      throw error;
    }
  }

  private async ensureChatGptLogin(): Promise<void> {
    const loginStart = await this.appServerClient.startChatGptLogin();
    if (loginStart.type !== "chatgpt") {
      throw new Error("account/login/start returned API key auth; this controller requires ChatGPT auth mode");
    }

    console.log(`Open this URL to complete ChatGPT authentication: ${loginStart.authUrl}`);

    let completion: LoginCompletedParams | undefined;
    try {
      completion = await this.appServerClient.waitForNotification<LoginCompletedParams>(
        "account/login/completed",
        this.loginTimeoutMs,
        (params) => params?.loginId === loginStart.loginId,
      );
    } catch (error) {
      // If the CLI is already authenticated (device auth), the app-server may not emit a completion event.
      // Proceed and let subsequent turn/start calls surface auth failures if any.
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes("Timed out waiting for notification")) {
        return;
      }
      throw error;
    }

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
    const result = await this.createThread(cwd);
    const threadId = this.extractThreadId(result);
    this.state.threadId = threadId;
    await this.saveState();

    return threadId;
  }

  private async createThreadForWorkspace(cwd: string): Promise<string> {
    const result = await this.createThread(cwd);
    return this.extractThreadId(result);
  }

  private async createThread(cwd: string): Promise<ThreadStartResult> {
    return this.appServerClient.startThread({
      model: this.model,
      modelProvider: null,
      cwd,
      approvalPolicy: this.approvalPolicy,
      sandbox: this.sandboxPolicy,
      config: null,
      baseInstructions: null,
      developerInstructions: null,
    });
  }

  private async executeTurn(args: {
    taskId?: string;
    threadId: string;
    prompt: string;
    cwd: string;
    allowCoordinatorEdit?: boolean;
  }): Promise<StartOrContinueTaskResult> {
    const prompt = args.prompt.trim();
    if (prompt.length === 0) {
      throw new Error("Prompt must be a non-empty string");
    }

    if (args.taskId) {
      this.incrementAndAssertTurnBudget(args.taskId);
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

    let completion: TurnCompletedParams | undefined;
    try {
      completion = await this.waitForTurnOutcome(waitForCompletion, args.threadId, startedTurnId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes("Timed out waiting for notification: turn/completed")) {
        await this.appServerClient.stop();
        this.bootstrapped = false;
        if (args.taskId) {
          await this.updateTaskStatusIfExists(args.taskId, "failed");
        }

        throw new Error(
          `Turn exceeded ${Math.floor(TURN_TIMEOUT_MS / 60_000)} minutes and was terminated (thread=${args.threadId}, turn=${startedTurnId})`,
        );
      }

      throw error;
    }

    if (!completion) {
      throw new Error(`Missing turn/completed payload for thread=${args.threadId} turn=${startedTurnId}`);
    }

    const status = completion.turn.status;
    if (status === "failed" || status === "interrupted") {
      const failureMessage = completion.turn.error?.message ?? "No error message from server";
      if (args.taskId) {
        await this.updateTaskStatusIfExists(args.taskId, "failed");
      }
      throw new Error(`Turn ${status} (thread=${args.threadId}, turn=${completion.turn.id}): ${failureMessage}`);
    }

    if (args.taskId) {
      await this.enforceBlockedEditGuardrail(args.taskId, args.allowCoordinatorEdit ?? false);
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

  private parseGitHubRepo(originUrlOutput: string): { owner: string; name: string } {
    const originUrl = originUrlOutput.trim();
    if (originUrl.length === 0) {
      throw new Error("git remote get-url origin returned an empty URL");
    }

    if (originUrl.startsWith("git@github.com:")) {
      const path = originUrl.slice("git@github.com:".length).replace(/\.git$/, "");
      const parts = path.split("/");
      const owner = parts[0];
      const name = parts[1];

      if (!owner || !name) {
        throw new Error(`Unable to parse GitHub remote URL: ${originUrl}`);
      }

      return { owner, name };
    }

    let parsedUrl: URL;
    try {
      parsedUrl = new URL(originUrl);
    } catch {
      throw new Error(`Unsupported git remote URL format: ${originUrl}`);
    }

    if (parsedUrl.hostname !== "github.com") {
      throw new Error(`Origin remote must be github.com, got: ${parsedUrl.hostname}`);
    }

    const path = parsedUrl.pathname.replace(/^\/+/, "").replace(/\.git$/, "");
    const parts = path.split("/");
    const owner = parts[0];
    const name = parts[1];

    if (!owner || !name) {
      throw new Error(`Unable to parse GitHub remote URL: ${originUrl}`);
    }

    return { owner, name };
  }

  private extractGitHubApiErrorMessage(payload: unknown): string | null {
    if (typeof payload !== "object" || payload === null) {
      return null;
    }

    const record = payload as Record<string, unknown>;
    if (typeof record.message === "string" && record.message.trim().length > 0) {
      return record.message;
    }

    return null;
  }

  public buildMutationPrompt(featureDescription: string): string {
    const normalized = featureDescription.trim();
    if (normalized.length === 0) {
      throw new Error("buildMutationPrompt requires a non-empty featureDescription");
    }

    return [
      "Task: implement the requested feature in the gpc-cres monorepo with minimal, correct changes.",
      "",
      "Repository rules (must follow):",
      "1. Follow pnpm workspace rules and workspace boundaries.",
      "2. Enforce strict TypeScript correctness; do not introduce type holes.",
      "3. Respect orgId scoping requirements for all tenant-sensitive paths and logic.",
      "4. Never parallelize Prisma migrations; migration-related operations must be serial and explicit.",
      "5. Follow existing package structure; avoid cross-package reshaping unless strictly required.",
      "6. Run pnpm verify after changes and use fix-until-green behavior before finishing.",
      "7. Keep edits minimal and deterministic.",
      "",
      "Feature request:",
      normalized,
    ].join("\n");
  }

  private generateCommitMessage(featureDescription: string): string {
    const summary = this.toSlugSummary(featureDescription, 60);
    return `feat: ${summary}`;
  }

  private generatePullRequestTitle(featureDescription: string): string {
    const summary = this.toSlugSummary(featureDescription, 72);
    return `feat: ${summary}`;
  }

  private generatePullRequestBody(taskId: string, featureDescription: string, iterations: number): string {
    return [
      `Task ID: ${taskId}`,
      "",
      "Requested feature:",
      featureDescription,
      "",
      `Verification fix iterations: ${iterations}`,
    ].join("\n");
  }

  private toSlugSummary(input: string, maxLength: number): string {
    const oneLine = input.replace(/\s+/g, " ").trim();
    if (oneLine.length <= maxLength) {
      return oneLine;
    }

    return `${oneLine.slice(0, Math.max(1, maxLength - 3)).trim()}...`;
  }

  private incrementAndAssertTurnBudget(taskId: string): void {
    const used = this.turnStartCountByTask.get(taskId) ?? 0;
    const next = used + 1;
    this.turnStartCountByTask.set(taskId, next);
    if (next > MAX_TURNS_PER_TASK) {
      throw new Error(`Turn budget exceeded for taskId=${taskId}: max ${MAX_TURNS_PER_TASK} turn/start calls.`);
    }
  }

  private async enforceBlockedEditGuardrail(taskId: string, allowCoordinatorEdit: boolean): Promise<void> {
    const diffNames = await this.workspaceManager.runInWorkspace(taskId, ["git", "diff", "--name-only"]);
    const changedFiles = diffNames.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0);

    const blocked = changedFiles.filter((file) => {
      const normalized = file.replace(/\\/g, "/");
      if (normalized.includes("/")) {
        return false;
      }

      if (!BLOCKED_ROOT_FILES.has(normalized)) {
        return false;
      }

      if (normalized === "coordinator.ts" && allowCoordinatorEdit) {
        return false;
      }

      return true;
    });

    if (blocked.length === 0) {
      return;
    }

    await this.updateTaskStatusIfExists(taskId, "failed");
    throw new Error(`Blocked root file edits detected for taskId=${taskId}: ${blocked.join(", ")}`);
  }

  private async updateTaskStatusIfExists(taskId: string, status: TaskStatus): Promise<void> {
    const task = await this.taskRegistry.getTask(taskId);
    if (!task) {
      return;
    }

    try {
      await this.taskRegistry.updateTaskStatus(taskId, status);
    } catch {
      // Preserve caller errors when status update is not possible.
    }
  }
}
