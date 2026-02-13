import { EventEmitter } from "node:events";
import { copyFile, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { AppServerClient } from "./appServerClient.js";
import { EvalManager, type EvalResult } from "./evalManager.js";
import { MemoryManager } from "./memoryManager.js";
import { SkillsManager } from "./skillsManager.js";
import { ExecutionPlanManager } from "./executionPlanManager.js";
import { CIStatusManager } from "./ciStatusManager.js";
import { PRReviewManager } from "./prReviewManager.js";
import { AppBootManager } from "./appBootManager.js";
import { LogQueryManager } from "./logQueryManager.js";
import { CDPBridge } from "./cdpBridge.js";
import { LinterFramework } from "./linterFramework.js";
import { ArchitectureValidator } from "./architectureValidator.js";
import { DocValidator } from "./docValidator.js";
import { QualityScoreManager } from "./qualityScoreManager.js";
import { BugReproductionManager } from "./bugReproductionManager.js";
import { TaskContinuationManager } from "./taskContinuationManager.js";
import { ReferenceDocManager } from "./referenceDocManager.js";
import { SkillRouter } from "./skillRouter.js";
import { ArtifactManager } from "./artifactManager.js";
import { NetworkPolicyManager } from "./networkPolicyManager.js";
import { DomainSecretsManager } from "./domainSecretsManager.js";
import { CompactionManager } from "./compactionManager.js";
import { ShellToolManager } from "./shellToolManager.js";
import { AutonomousOrchestrator } from "./autonomousOrchestrator.js";
import { CIIntegrationManager } from "./ciIntegrationManager.js";
import { PRAutomergeManager } from "./prAutomergeManager.js";
import { AlertManager } from "./alertManager.js";
import { MergeQueueManager } from "./mergeQueueManager.js";
import { IssueTriageManager, type TriageInput, type TriageResult, type TriageRecord, type ConvertResult } from "./issueTriageManager.js";
import { WebhookHandler, type WebhookEvent } from "./webhookHandler.js";
import { SchedulerManager, type ScheduleStatus, type ScheduledJobName, type JobHistoryEntry, type ScheduledJobConfig } from "./schedulerManager.js";
import { RefactoringManager, type ViolationReport, type ViolationType, type RefactoringHistory, type RefactoringRun } from "./refactoringManager.js";
import { GitHubReviewPoster, type ReviewFindingInput, type ReviewVerdict, type PostReviewResult, type PostSummaryResult, type ReviewStatus as PRReviewStatus, type QualityScoreInput, type EvalResultInput } from "./githubReviewPoster.js";
import type {
  ApprovalPolicy,
  AppBootResult,
  ArchValidationResult,
  BugReproResult,
  CIRunRecord,
  CIStatusSummary,
  ControllerState,
  DocGardenResult,
  DocValidationResult,
  EvalSummary,
  ExecutionPlan,
  FixUntilGreenResult,
  GCSweepResult,
  InitializeParams,
  ItemDeltaParams,
  LintResult,
  LogQueryResult,
  LoginCompletedParams,
  ParallelRunResult,
  ParallelTaskRequest,
  ParallelTaskResult,
  PlanPhaseStatus,
  QualityScore,
  ReferenceDoc,
  ReviewResult,
  RunMutationResult,
  SandboxPolicy,
  StartOrContinueTaskResult,
  TaskCheckpoint,
  TaskRecord,
  TaskStatus,
  ThreadStartResult,
  TurnCompletedParams,
  TurnDiffUpdatedParams,
  VerifyResult,
  WorkspaceWriteTurnSandboxPolicy,
  Artifact,
  ArtifactCollectionResult,
  SkillRoutingResult,
  NetworkAllowlistEntry,
  OrgNetworkPolicy,
  RequestNetworkPolicy,
  NetworkPolicyValidation,
  DomainSecret,
  SecretInjectionResult,
  CompactionConfig,
  CompactionEvent,
  CommandAuditEntry,
  CommandExecutionPolicy,
  ShellExecutionMetrics,
  ShellExecutionResult,
  ShellToolConfig,
  AutonomousRunParams,
  AutonomousRunRecord,
  CITriggerResult,
  CIPollResult,
  CIFailureLogs,
  AutomergePolicy,
  AutomergeEvaluation,
  AutomergeResult,
  AlertConfig,
  AlertChannelConfig,
  AlertEvent,
  AlertMuteRule,
  AlertSeverity,
  ConflictDetectionResult,
  DashboardData,
  MergeQueueEntry,
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
  workspacesRoot?: string;
  workspaceManager?: WorkspaceManager;
  gitManager?: GitManager;
  taskRegistry?: TaskRegistry;
  streamToStdout?: boolean;
  controllerRoot?: string;
  memoryFilePath?: string;
  evalHistoryPath?: string;
  maxParallelTasks?: number;
}

const VERIFY_JSON_FILENAME = ".agent-verify.json";
const VERIFY_OUTPUT_TAIL_LINES = 120;
const TURN_TIMEOUT_MS = 20 * 60_000;
const TURN_WORKSPACE_SANDBOX: WorkspaceWriteTurnSandboxPolicy = { type: "workspaceWrite" };
const MAX_TURNS_PER_TASK = 5;
const MAX_IDENTICAL_FIX_DIFFS = 3;
const BLOCKED_ROOT_FILES = new Set(["package.json", "tsconfig.json", "eslint.config.mjs", "coordinator.ts"]);
const DEFAULT_MAX_PARALLEL = 3;
// Compaction is now handled by CompactionManager with strategy-based thresholds.

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
  private readonly controllerRoot: string;
  private readonly skillsManager: SkillsManager;
  private readonly memoryManager: MemoryManager;
  private readonly evalManager: EvalManager;
  private readonly maxParallelTasks: number;
  private readonly executionPlanManager: ExecutionPlanManager;
  private readonly ciStatusManager: CIStatusManager;
  private readonly prReviewManager: PRReviewManager;
  private readonly appBootManager: AppBootManager;
  private readonly logQueryManager: LogQueryManager;
  private readonly cdpBridge: CDPBridge;
  private readonly linterFramework: LinterFramework;
  private readonly architectureValidator: ArchitectureValidator;
  private readonly docValidator: DocValidator;
  private readonly qualityScoreManager: QualityScoreManager;
  private readonly bugReproductionManager: BugReproductionManager;
  private readonly taskContinuationManager: TaskContinuationManager;
  private readonly referenceDocManager: ReferenceDocManager;
  private readonly skillRouter: SkillRouter;
  private readonly artifactManager: ArtifactManager;
  private readonly networkPolicyManager: NetworkPolicyManager;
  private readonly domainSecretsManager: DomainSecretsManager;
  private readonly compactionManager: CompactionManager;
  private readonly shellToolManager: ShellToolManager;
  private readonly autonomousOrchestrator: AutonomousOrchestrator;
  private readonly ciIntegrationManager: CIIntegrationManager;
  private readonly prAutomergeManager: PRAutomergeManager;
  private readonly alertManager: AlertManager;
  private readonly mergeQueueManager: MergeQueueManager;
  private readonly issueTriageManager: IssueTriageManager;
  private readonly webhookHandler: WebhookHandler;
  private readonly schedulerManager: SchedulerManager;
  private readonly refactoringManager: RefactoringManager;
  private readonly githubReviewPoster: GitHubReviewPoster;

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
    // In production, device auth is typically done out-of-band via `codex login --device-auth`.
    // The app-server may not emit `account/login/completed` for that path, so waiting minutes
    // per request is undesirable. Keep this short and proceed if we don't hear back quickly.
    this.loginTimeoutMs = options.loginTimeoutMs ?? 10_000;
    const envWorkspacesRoot =
      options.workspacesRoot?.trim() ||
      process.env.WORKSPACES_ROOT?.trim() ||
      process.env.GPC_WORKSPACES_ROOT?.trim() ||
      undefined;
    this.workspaceManager = options.workspaceManager ?? new WorkspaceManager(
      envWorkspacesRoot ? { workspacesRoot: envWorkspacesRoot } : {},
    );
    this.gitManager = options.gitManager ?? new GitManager(this.workspaceManager);
    this.taskRegistry = options.taskRegistry ?? new TaskRegistry(`${dirname(this.stateFilePath)}/tasks.json`);
    this.streamToStdout = options.streamToStdout ?? true;

    const stateDir = dirname(this.stateFilePath);
    this.controllerRoot = options.controllerRoot ?? dirname(stateDir);
    this.skillsManager = new SkillsManager(this.controllerRoot);
    this.memoryManager = new MemoryManager(options.memoryFilePath ?? `${stateDir}/memory.json`);
    this.evalManager = new EvalManager(options.evalHistoryPath ?? `${stateDir}/eval-history.json`, this.workspaceManager);
    this.maxParallelTasks = options.maxParallelTasks ?? DEFAULT_MAX_PARALLEL;

    // New Harness Engineering managers
    this.executionPlanManager = new ExecutionPlanManager(`${stateDir}/plans.json`);
    this.ciStatusManager = new CIStatusManager(`${stateDir}/ci-status.json`);
    this.prReviewManager = new PRReviewManager(this.workspaceManager, this.skillsManager);
    this.appBootManager = new AppBootManager(this.workspaceManager);
    this.logQueryManager = new LogQueryManager(this.workspaceManager);
    this.cdpBridge = new CDPBridge();
    this.linterFramework = new LinterFramework(this.workspaceManager);
    this.architectureValidator = new ArchitectureValidator(this.workspaceManager);
    this.docValidator = new DocValidator(this.workspaceManager);
    this.qualityScoreManager = new QualityScoreManager(
      `${stateDir}/quality-scores.json`,
      this.evalManager,
      this.ciStatusManager,
      this.linterFramework,
      this.architectureValidator,
      this.docValidator,
    );
    this.bugReproductionManager = new BugReproductionManager(this.workspaceManager, this.skillsManager);
    this.taskContinuationManager = new TaskContinuationManager(`${stateDir}/checkpoints.json`);
    this.referenceDocManager = new ReferenceDocManager(`${stateDir}/reference-docs.json`);

    // Article-inspired capabilities
    this.skillRouter = new SkillRouter(this.skillsManager);
    this.artifactManager = new ArtifactManager(`${stateDir}/artifacts.json`, this.workspaceManager);
    this.networkPolicyManager = new NetworkPolicyManager(`${stateDir}/network-policy.json`);
    this.domainSecretsManager = new DomainSecretsManager(`${stateDir}/domain-secrets.json`);
    this.compactionManager = new CompactionManager(
      `${stateDir}/compaction-history.json`,
      this.appServerClient,
    );

    // Shell tool integration
    this.shellToolManager = new ShellToolManager(
      this.workspaceManager,
      stateDir,
      {
        enabled: process.env.SHELL_TOOL_ENABLED !== "false",
      },
    );

    // Autonomous orchestrator
    this.autonomousOrchestrator = new AutonomousOrchestrator(
      this,
      `${stateDir}/autonomous-runs.json`,
    );

    // CI Integration + PR Automerge
    this.ciIntegrationManager = new CIIntegrationManager(
      this.workspaceManager,
      this.ciStatusManager,
    );
    this.prAutomergeManager = new PRAutomergeManager(
      `${stateDir}/automerge-policy.json`,
      this.workspaceManager,
      this.ciStatusManager,
    );

    // Alerting + Merge Queue
    this.alertManager = new AlertManager(
      `${stateDir}/alerts-config.json`,
      `${stateDir}/alerts-history.json`,
    );
    this.mergeQueueManager = new MergeQueueManager(
      `${stateDir}/merge-queue.json`,
      this.workspaceManager,
    );

    // Issue Triage + Webhook Handler
    this.issueTriageManager = new IssueTriageManager(
      `${stateDir}/triage.json`,
      this,
    );
    this.webhookHandler = new WebhookHandler(this, this.issueTriageManager);

    // Scheduler
    this.schedulerManager = new SchedulerManager(`${stateDir}/scheduler.json`);

    // Refactoring Manager
    this.refactoringManager = new RefactoringManager(`${stateDir}/refactoring.json`);

    // GitHub Review Poster
    this.githubReviewPoster = new GitHubReviewPoster();
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
    const enrichedPrompt = await this.buildMutationPrompt(prompt);
    return this.executeTurn({
      threadId,
      prompt: enrichedPrompt,
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

      const prompt = await this.buildFixPrompt({
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

      // Extract learnings from each fix iteration for memory.
      try {
        const fixDiffResult = await this.workspaceManager.runInWorkspaceAllowNonZero(taskId, ["git", "diff"]);
        await this.memoryManager.extractLearningsFromFixLoop(
          taskId,
          lastVerify.combinedTail,
          fixDiffResult.stdout,
        );
      } catch {
        // Non-critical: learning extraction failures should not break the fix loop.
      }

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

      // Deploy AGENTS.md into workspace so the agent has repo context.
      await this.deployAgentsMd(task.workspacePath);

      await this.updateTaskStatus(taskId, "mutating");

      const enrichedPrompt = await this.buildMutationPrompt(normalizedFeatureDescription);
      await this.executeTurn({
        taskId,
        threadId: task.threadId,
        prompt: enrichedPrompt,
        cwd: task.workspacePath,
      });

      // Trigger compaction after the initial mutation turn to reclaim context.
      await this.compactIfNeeded(task.threadId);

      await this.updateTaskStatus(taskId, "verifying");
      const fixResult = await this.fixUntilGreen(taskId, 5);
      if (!fixResult.success) {
        throw new Error(`Verification did not pass within iteration limit for taskId=${taskId}`);
      }

      // Run eval to score the mutation quality.
      let evalScore: number | undefined;
      try {
        const evalResult = await this.evalManager.runEval(taskId);
        evalScore = evalResult.overallScore;
      } catch {
        // Eval failures are non-critical.
      }

      await this.updateTaskStatus(taskId, "ready");
      const commitMessage = this.generateCommitMessage(normalizedFeatureDescription);
      const committed = await this.gitManager.commitAll(taskId, commitMessage);
      if (!committed) {
        throw new Error("Mutation finished with no file changes to commit");
      }

      const title = this.generatePullRequestTitle(normalizedFeatureDescription);
      const body = this.generatePullRequestBody(taskId, normalizedFeatureDescription, fixResult.iterations, evalScore);
      const prUrl = await this.createPullRequest(taskId, title, body);
      await this.updateTaskStatus(taskId, "pr_opened");

      const mutationResult: RunMutationResult = {
        taskId,
        branch: task.branchName,
        prUrl,
        iterations: fixResult.iterations,
        success: true,
      };
      if (evalScore !== undefined) {
        mutationResult.evalScore = evalScore;
      }
      return mutationResult;
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
      sandbox: this.normalizeThreadSandboxPolicy(),
      config: null,
      baseInstructions: null,
      developerInstructions: null,
    });
  }

  private normalizeThreadSandboxPolicy(): "workspace-write" | "read-only" | "danger-full-access" {
    switch (this.sandboxPolicy) {
      case "readOnly":
      case "read-only":
        return "read-only";
      case "dangerFullAccess":
      case "danger-full-access":
        return "danger-full-access";
      default:
        return "workspace-write";
    }
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

  private async buildFixPrompt(args: {
    taskId: string;
    iteration: number;
    maxIterations: number;
    verify: VerifyResult;
    diffStat: string;
  }): Promise<string> {
    const verificationJsonText = args.verify.verificationJson === null
      ? "null"
      : JSON.stringify(args.verify.verificationJson, null, 2);

    const skillContext = await this.skillsManager.buildSkillContext(["fix"]);
    const memoryContext = await this.memoryManager.buildMemoryContext(["fix-pattern", "error-resolution"]);

    const sections: string[] = [
      `Task: make pnpm verify pass for gpc-cres workspace taskId=${args.taskId}.`,
      `Iteration: ${args.iteration}/${args.maxIterations}.`,
      "",
      "Constraints (must follow):",
      "1. Apply minimal changes only to make verification pass.",
      "2. Do not change root config unless required to fix verify.",
      "3. Do not change Prisma migrations unless explicitly needed for the failing check.",
      "4. Keep edits scoped to the current workspace.",
      "5. Preserve pnpm workspace structure for gpc-cres monorepo.",
    ];

    if (skillContext) {
      sections.push(skillContext);
    }

    if (memoryContext) {
      sections.push(memoryContext);
    }

    sections.push(
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
    );

    return sections.join("\n");
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

  public async buildMutationPrompt(featureDescription: string): Promise<string> {
    const normalized = featureDescription.trim();
    if (normalized.length === 0) {
      throw new Error("buildMutationPrompt requires a non-empty featureDescription");
    }

    // Dynamic skill routing (article tip #1, #2, #7):
    // Route skills based on task description instead of always loading "mutation"
    const skillContext = await this.skillRouter.buildRoutedSkillContext(normalized);
    const memoryContext = await this.memoryManager.buildMemoryContext(["fix-pattern", "convention-violation"]);
    const secretsContext = await this.domainSecretsManager.buildModelContext();
    const referenceContext = await this.referenceDocManager.buildContext();

    const sections: string[] = [
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
    ];

    if (skillContext) {
      sections.push(skillContext);
    }

    if (memoryContext) {
      sections.push(memoryContext);
    }

    if (secretsContext) {
      sections.push(secretsContext);
    }

    if (referenceContext) {
      sections.push(referenceContext);
    }

    sections.push("", "Feature request:", normalized);

    return sections.join("\n");
  }

  private generateCommitMessage(featureDescription: string): string {
    const summary = this.toSlugSummary(featureDescription, 60);
    return `feat: ${summary}`;
  }

  private generatePullRequestTitle(featureDescription: string): string {
    const summary = this.toSlugSummary(featureDescription, 72);
    return `feat: ${summary}`;
  }

  private generatePullRequestBody(taskId: string, featureDescription: string, iterations: number, evalScore?: number): string {
    const lines = [
      `Task ID: ${taskId}`,
      "",
      "Requested feature:",
      featureDescription,
      "",
      `Verification fix iterations: ${iterations}`,
    ];

    if (evalScore !== undefined) {
      lines.push(`Eval score: ${evalScore.toFixed(2)}`);
    }

    return lines.join("\n");
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

  // --- AGENTS.md Deployment ---

  private async deployAgentsMd(workspacePath: string): Promise<void> {
    const templatePath = resolve(this.controllerRoot, "templates", "AGENTS.md");
    const destPath = resolve(workspacePath, "AGENTS.md");

    try {
      await stat(templatePath);
    } catch {
      // Template not found; skip deployment silently.
      return;
    }

    try {
      await copyFile(templatePath, destPath);
    } catch {
      // Non-critical: workspace may be read-only in certain sandbox modes.
    }
  }

  // --- Compaction (token-aware) ---

  private async compactIfNeeded(threadId: string, promptText?: string): Promise<void> {
    // Delegate to CompactionManager which uses strategy-based compaction
    // (token-threshold, turn-interval, or auto) instead of naive every-N-turns
    await this.compactionManager.trackAndCompactIfNeeded(
      threadId,
      promptText ?? "",
    );
  }

  // --- Skill Routing ---

  public async routeSkills(taskDescription: string): Promise<SkillRoutingResult> {
    return this.skillRouter.route(taskDescription);
  }

  public async forceSelectSkills(skillNames: string[]): Promise<SkillRoutingResult> {
    return this.skillRouter.forceSelect(skillNames);
  }

  // --- Artifact Management ---

  public async registerArtifact(
    taskId: string,
    name: string,
    path: string,
    type?: Artifact["type"],
    metadata?: Record<string, string>,
  ): Promise<Artifact> {
    return this.artifactManager.registerArtifact(taskId, name, path, type, metadata);
  }

  public async collectArtifacts(taskId: string): Promise<ArtifactCollectionResult> {
    return this.artifactManager.collectFromWorkspace(taskId);
  }

  public async getArtifacts(taskId: string): Promise<Artifact[]> {
    return this.artifactManager.getArtifacts(taskId);
  }

  // --- Network Policy ---

  public async getNetworkPolicy(): Promise<OrgNetworkPolicy> {
    return this.networkPolicyManager.getOrgPolicy();
  }

  public async setNetworkPolicy(allowlist: NetworkAllowlistEntry[]): Promise<OrgNetworkPolicy> {
    return this.networkPolicyManager.setOrgPolicy(allowlist);
  }

  public async addNetworkDomain(entry: NetworkAllowlistEntry): Promise<OrgNetworkPolicy> {
    return this.networkPolicyManager.addOrgDomain(entry);
  }

  public async removeNetworkDomain(domain: string): Promise<OrgNetworkPolicy> {
    return this.networkPolicyManager.removeOrgDomain(domain);
  }

  public async validateRequestNetwork(policy: RequestNetworkPolicy): Promise<NetworkPolicyValidation> {
    return this.networkPolicyManager.validateRequestPolicy(policy);
  }

  // --- Domain Secrets ---

  public async registerDomainSecret(secret: DomainSecret): Promise<void> {
    await this.domainSecretsManager.registerSecret(secret);
  }

  public async getDomainSecrets(): Promise<DomainSecret[]> {
    return this.domainSecretsManager.getSecrets();
  }

  public async validateDomainSecrets(): Promise<SecretInjectionResult[]> {
    return this.domainSecretsManager.validateSecrets();
  }

  // --- Compaction Config ---

  public getCompactionConfig(): CompactionConfig {
    return this.compactionManager.getConfig();
  }

  public setCompactionConfig(config: Partial<CompactionConfig>): CompactionConfig {
    return this.compactionManager.setConfig(config);
  }

  public async getCompactionHistory(limit?: number): Promise<CompactionEvent[]> {
    return this.compactionManager.getHistory(limit);
  }

  public getContextUsage(threadId: string): { estimatedTokens: number; maxTokens: number; percentUsed: number; turnCount: number } {
    return this.compactionManager.getContextUsage(threadId);
  }

  // --- Eval ---

  public async runEval(taskId: string): Promise<EvalResult> {
    return this.evalManager.runEval(taskId);
  }

  public async getEvalHistory(limit?: number): Promise<EvalResult[]> {
    return this.evalManager.getHistory(limit);
  }

  public async getEvalSummary(taskId: string): Promise<EvalSummary> {
    const result = await this.evalManager.runEval(taskId);
    return {
      taskId: result.taskId,
      overallScore: result.overallScore,
      passed: result.passed,
      checkCount: result.checks.length,
      passedCount: result.checks.filter((c) => c.passed).length,
    };
  }

  // --- Memory ---

  public async getMemoryEntries(category?: string, limit?: number): Promise<unknown[]> {
    return this.memoryManager.getRelevantLearnings(
      category as "fix-pattern" | "error-resolution" | "convention-violation" | "performance" | "general" | undefined,
      limit,
    );
  }

  // --- Doc Gardening ---

  public async runDocGardening(taskId: string): Promise<DocGardenResult> {
    await this.ensureSessionReady();
    this.handleTurnEvents();
    this.handleItemEvents();
    this.handleApprovalEvents();

    let task = await this.taskRegistry.getTask(taskId);
    if (!task) {
      task = await this.createTask(taskId);
    }

    const skillContext = await this.skillsManager.buildSkillContext(["doc-gardening"]);

    const prompt = [
      "Task: scan and update documentation in the gpc-cres monorepo.",
      "",
      "Instructions:",
      "1. Check all docs/*.md files for accuracy against actual code.",
      "2. Update stale references, outdated code examples, or missing sections.",
      "3. Verify AGENTS.md quick-reference table entries point to real paths.",
      "4. Add any missing documentation for new packages or significant modules.",
      "5. Keep changes minimal — only fix what is actually wrong or missing.",
      skillContext,
    ].join("\n");

    const result = await this.executeTurn({
      taskId,
      threadId: task.threadId,
      prompt,
      cwd: task.workspacePath,
    });

    return {
      taskId,
      threadId: result.threadId,
      turnId: result.turnId,
      status: result.status,
    };
  }

  // --- Execution Plans ---

  public async createExecutionPlan(taskId: string, description: string): Promise<ExecutionPlan> {
    return this.executionPlanManager.createPlan(taskId, description);
  }

  public async getExecutionPlan(taskId: string): Promise<ExecutionPlan | null> {
    return this.executionPlanManager.getPlan(taskId);
  }

  public async updatePlanPhase(taskId: string, phaseIndex: number, status: PlanPhaseStatus): Promise<ExecutionPlan> {
    return this.executionPlanManager.updatePhaseStatus(taskId, phaseIndex, status);
  }

  // --- CI Status ---

  public async recordCIRun(record: Omit<CIRunRecord, "runId" | "timestamp">): Promise<CIRunRecord> {
    return this.ciStatusManager.recordRun(record);
  }

  public async getCIStatus(taskId: string): Promise<CIStatusSummary> {
    return this.ciStatusManager.getStatus(taskId);
  }

  public async getCIHistory(taskId: string, limit?: number): Promise<CIRunRecord[]> {
    return this.ciStatusManager.getHistory(taskId, limit);
  }

  // --- PR Review ---

  public async reviewPR(taskId: string): Promise<ReviewResult> {
    return this.prReviewManager.reviewDiff(taskId);
  }

  public async runReviewLoop(taskId: string, maxRounds = 3): Promise<{ rounds: number; finalReview: ReviewResult }> {
    return this.prReviewManager.runReviewLoop(taskId, maxRounds, async (tid, prompt) => {
      const task = await this.taskRegistry.getTask(tid);
      if (!task) throw new Error(`Task not found: ${tid}`);
      await this.executeTurn({ taskId: tid, threadId: task.threadId, prompt, cwd: task.workspacePath });
    });
  }

  // --- App Boot ---

  public async bootApp(taskId: string): Promise<AppBootResult> {
    return this.appBootManager.bootApp(taskId);
  }

  // --- Log Query ---

  public async queryLogs(taskId: string, pattern: string, limit?: number): Promise<LogQueryResult> {
    return this.logQueryManager.queryLogs(taskId, pattern, limit);
  }

  // --- Linter ---

  public async runLinter(taskId: string, rules?: string[]): Promise<LintResult> {
    return this.linterFramework.runLinter(taskId, rules);
  }

  // --- Architecture Validation ---

  public async validateArchitecture(taskId: string): Promise<ArchValidationResult> {
    return this.architectureValidator.validate(taskId);
  }

  // --- Doc Validation ---

  public async validateDocs(taskId: string): Promise<DocValidationResult> {
    return this.docValidator.validate(taskId);
  }

  // --- Quality Score ---

  public async getQualityScore(taskId: string): Promise<QualityScore> {
    return this.qualityScoreManager.getScore(taskId);
  }

  // --- GC Sweep ---

  public async runGCSweep(): Promise<GCSweepResult> {
    // Note: GCScheduler needs jobs map, but we delegate from rpcServer level.
    // For controller-level, we return a basic sweep without job pruning.
    return { staleWorkspacesRemoved: 0, staleJobsPruned: 0, evalEntriesPruned: 0, freedPaths: [] };
  }

  // --- Bug Reproduction ---

  public async reproduceBug(taskId: string, bugDescription: string): Promise<BugReproResult> {
    await this.ensureSessionReady();
    this.handleTurnEvents();
    this.handleItemEvents();

    let task = await this.taskRegistry.getTask(taskId);
    if (!task) {
      task = await this.createTask(taskId);
    }

    return this.bugReproductionManager.reproduce(
      taskId,
      bugDescription,
      async (tid, threadId, prompt, cwd) => {
        await this.executeTurn({ taskId: tid, threadId, prompt, cwd });
      },
      task.threadId,
    );
  }

  // --- Task Continuation ---

  public async checkpointTask(taskId: string, description: string): Promise<TaskCheckpoint> {
    const task = await this.taskRegistry.getTask(taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);
    return this.taskContinuationManager.checkpoint(taskId, task.threadId, description);
  }

  public async getTaskCheckpoints(taskId: string): Promise<TaskCheckpoint[]> {
    return this.taskContinuationManager.getCheckpoints(taskId);
  }

  // --- Reference Docs ---

  public async addReferenceDoc(doc: Omit<ReferenceDoc, "id" | "addedAt">): Promise<ReferenceDoc> {
    return this.referenceDocManager.addDoc(doc);
  }

  public async getReferenceDocs(category?: string): Promise<ReferenceDoc[]> {
    return this.referenceDocManager.listDocs(category);
  }

  // --- Parallel Task Execution ---

  public async runParallel(tasks: ParallelTaskRequest[]): Promise<ParallelRunResult> {
    if (tasks.length === 0) {
      return { totalTasks: 0, succeeded: 0, failed: 0, results: [] };
    }

    const concurrency = Math.min(tasks.length, this.maxParallelTasks);
    const results: ParallelTaskResult[] = [];
    const queue = [...tasks];

    const worker = async (): Promise<void> => {
      while (queue.length > 0) {
        const task = queue.shift();
        if (!task) {
          break;
        }

        try {
          const result = await this.runMutation(task.taskId, task.featureDescription);
          results.push({ taskId: task.taskId, success: true, result });
        } catch (error) {
          results.push({
            taskId: task.taskId,
            success: false,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    };

    const workers = Array.from({ length: concurrency }, () => worker());
    await Promise.allSettled(workers);

    const succeeded = results.filter((r) => r.success).length;
    return {
      totalTasks: tasks.length,
      succeeded,
      failed: tasks.length - succeeded,
      results,
    };
  }

  // --- Shell Tool Integration ---

  public async executeShellCommand(
    taskId: string,
    command: string[],
    options?: { timeoutMs?: number; allowNonZeroExit?: boolean },
  ): Promise<ShellExecutionResult> {
    return this.shellToolManager.executeCommand(taskId, command, options);
  }

  public async setShellPolicy(policy: CommandExecutionPolicy): Promise<CommandExecutionPolicy> {
    return this.shellToolManager.setTaskPolicy(policy);
  }

  public async getShellPolicy(taskId: string): Promise<CommandExecutionPolicy | null> {
    return this.shellToolManager.getTaskPolicy(taskId);
  }

  public async removeShellPolicy(taskId: string): Promise<boolean> {
    return this.shellToolManager.removeTaskPolicy(taskId);
  }

  public async listShellPolicies(): Promise<CommandExecutionPolicy[]> {
    return this.shellToolManager.listPolicies();
  }

  public async getShellAuditLog(taskId?: string, limit?: number): Promise<CommandAuditEntry[]> {
    return this.shellToolManager.getAuditLog(taskId, limit);
  }

  public async getShellMetrics(taskId?: string): Promise<ShellExecutionMetrics> {
    return this.shellToolManager.getMetrics(taskId);
  }

  public getShellConfig(): ShellToolConfig {
    return this.shellToolManager.getConfig();
  }

  public isShellEnabled(): boolean {
    return this.shellToolManager.isEnabled();
  }

  public async clearShellAuditLog(): Promise<void> {
    return this.shellToolManager.clearAuditLog();
  }

  // --- Autonomous Orchestration ---

  public async startAutonomousRun(params: AutonomousRunParams): Promise<AutonomousRunRecord> {
    await this.ensureSessionReady();
    this.handleTurnEvents();
    this.handleItemEvents();
    this.handleApprovalEvents();
    return this.autonomousOrchestrator.startRun(params);
  }

  public async getAutonomousRun(runId: string): Promise<AutonomousRunRecord | null> {
    return this.autonomousOrchestrator.getRun(runId);
  }

  public async listAutonomousRuns(limit?: number): Promise<AutonomousRunRecord[]> {
    return this.autonomousOrchestrator.listRuns(limit);
  }

  public async cancelAutonomousRun(runId: string): Promise<boolean> {
    return this.autonomousOrchestrator.cancelRun(runId);
  }

  public async commitAllChanges(taskId: string, message: string): Promise<boolean> {
    return this.gitManager.commitAll(taskId, message);
  }

  public async prepareWorkspace(taskId: string): Promise<void> {
    const task = await this.taskRegistry.getTask(taskId);
    if (!task) {
      throw new Error(`Task not found: ${taskId}`);
    }
    await this.deployAgentsMd(task.workspacePath);
  }

  // --- CI Integration ---

  public async triggerCI(taskId: string, sha: string, workflowFile?: string): Promise<CITriggerResult> {
    return this.ciIntegrationManager.triggerCI(taskId, sha, workflowFile);
  }

  public async pollCIStatus(taskId: string, ghRunId: number, timeoutMs?: number): Promise<CIPollResult> {
    return this.ciIntegrationManager.pollCIStatus(taskId, ghRunId, timeoutMs);
  }

  public async getCIFailureLogs(taskId: string, ghRunId: number): Promise<CIFailureLogs> {
    return this.ciIntegrationManager.getCIFailureLogs(taskId, ghRunId);
  }

  public async triggerAndWaitCI(
    taskId: string,
    sha: string,
    workflowFile?: string,
    timeoutMs?: number,
  ): Promise<{ trigger: CITriggerResult; poll: CIPollResult; failures: CIFailureLogs | null }> {
    return this.ciIntegrationManager.triggerAndWait(taskId, sha, workflowFile, timeoutMs);
  }

  // --- PR Automerge ---

  public async evaluateAutomerge(taskId: string, prNumber: number): Promise<AutomergeEvaluation> {
    return this.prAutomergeManager.evaluateAutomerge(taskId, prNumber);
  }

  public async executeMerge(
    taskId: string,
    prNumber: number,
    strategy?: "squash" | "merge" | "rebase",
  ): Promise<AutomergeResult> {
    return this.prAutomergeManager.executeMerge(taskId, prNumber, strategy);
  }

  public async getAutomergePolicy(): Promise<AutomergePolicy> {
    return this.prAutomergeManager.getAutomergePolicy();
  }

  public async setAutomergePolicy(policy: Partial<AutomergePolicy>): Promise<AutomergePolicy> {
    return this.prAutomergeManager.setAutomergePolicy(policy);
  }

  // --- Alerting ---

  public async sendAlert(params: {
    severity: AlertSeverity;
    source: string;
    title: string;
    message: string;
    metadata?: Record<string, unknown>;
  }): Promise<AlertEvent> {
    return this.alertManager.sendAlert(params);
  }

  public async getAlertConfig(): Promise<AlertConfig> {
    return this.alertManager.getAlertConfig();
  }

  public async setAlertConfig(config: { channels?: AlertChannelConfig[] }): Promise<AlertConfig> {
    return this.alertManager.setAlertConfig(config);
  }

  public async getAlertHistory(limit?: number): Promise<AlertEvent[]> {
    return this.alertManager.getAlertHistory(limit);
  }

  public async muteAlert(pattern: string, durationMs: number): Promise<AlertMuteRule> {
    return this.alertManager.muteAlert(pattern, durationMs);
  }

  // --- Merge Queue ---

  public async enqueueMerge(taskId: string, prNumber: number, priority?: number): Promise<MergeQueueEntry> {
    return this.mergeQueueManager.enqueue(taskId, prNumber, priority);
  }

  public async dequeueMerge(): Promise<MergeQueueEntry | null> {
    return this.mergeQueueManager.dequeue();
  }

  public async checkMergeFreshness(taskId: string): Promise<{ fresh: boolean; behindBy: number }> {
    return this.mergeQueueManager.checkFreshness(taskId);
  }

  public async rebaseOntoMain(taskId: string): Promise<{ success: boolean; error: string | null }> {
    return this.mergeQueueManager.rebaseOntoMain(taskId);
  }

  public async detectMergeConflicts(taskId: string): Promise<ConflictDetectionResult> {
    return this.mergeQueueManager.detectConflicts(taskId);
  }

  public async getMergeQueueStatus(): Promise<{
    entries: MergeQueueEntry[];
    depth: number;
    blockedCount: number;
    readyCount: number;
  }> {
    return this.mergeQueueManager.getQueueStatus();
  }

  // --- Dashboard ---

  public async getDashboard(): Promise<DashboardData> {
    const [
      tasks,
      autonomousRuns,
      alertHistory,
      mergeQueueStatus,
      schedulerStatus,
    ] = await Promise.all([
      this.taskRegistry.listTasks(),
      this.autonomousOrchestrator.listRuns(10),
      this.alertManager.getAlertHistory(100),
      this.mergeQueueManager.getQueueStatus(),
      this.schedulerManager.getScheduleStatus(),
    ]);

    // Compute CI pass rate from recent runs across all tasks
    let ciPassRate = 0;
    try {
      // Aggregate across recent tasks
      let totalRuns = 0;
      let passedRuns = 0;
      for (const task of tasks.slice(0, 20)) {
        const ciStatus = await this.ciStatusManager.getStatus(task.taskId);
        totalRuns += ciStatus.totalRuns;
        passedRuns += Math.round(ciStatus.passRate * ciStatus.totalRuns);
      }
      ciPassRate = totalRuns > 0 ? passedRuns / totalRuns : 0;
    } catch {
      // Non-critical
    }

    // Compute alert severity summary
    const alertSummary = { total: 0, critical: 0, error: 0, warning: 0, info: 0 };
    for (const alert of alertHistory) {
      alertSummary.total += 1;
      alertSummary[alert.severity] += 1;
    }

    // Collect quality scores for recent tasks
    const qualityScores: QualityScore[] = [];
    for (const task of tasks.slice(0, 10)) {
      try {
        const score = await this.qualityScoreManager.getScore(task.taskId);
        qualityScores.push(score);
      } catch {
        // Skip tasks without quality scores
      }
    }

    return {
      tasks,
      recentAutonomousRuns: autonomousRuns,
      qualityScores,
      ciPassRate,
      alertSummary,
      mergeQueueDepth: mergeQueueStatus.depth,
      schedulerRunning: schedulerStatus.running,
      timestamp: new Date().toISOString(),
    };
  }

  // --- Issue Triage ---

  public async triageIssue(input: TriageInput): Promise<TriageResult> {
    return this.issueTriageManager.triageIssue(input);
  }

  public async getTriageHistory(limit?: number): Promise<TriageRecord[]> {
    return this.issueTriageManager.getTriageHistory(limit);
  }

  public async convertIssueToTask(input: TriageInput): Promise<ConvertResult> {
    return this.issueTriageManager.convertIssueToTask(input);
  }

  // --- Webhook Handler ---

  public getWebhookHandler(): WebhookHandler {
    return this.webhookHandler;
  }

  public getWebhookAuditLog(limit?: number): WebhookEvent[] {
    return this.webhookHandler.getAuditLog(limit);
  }

  // --- Scheduler ---

  public async startScheduler(): Promise<ScheduleStatus> {
    this.schedulerManager.setExecutor(async (jobName) => {
      switch (jobName) {
        case "quality-scan":
          try { await this.qualityScoreManager.getScore("scheduler-quality-scan"); } catch { /* non-critical */ }
          break;
        case "architecture-sweep":
          try { await this.refactoringManager.scanForViolations(this.workspacePath); } catch { /* non-critical */ }
          break;
        case "doc-gardening":
          try { await this.docValidator.validate("scheduler-doc-gardening"); } catch { /* non-critical */ }
          break;
        case "gc-sweep":
          try { await this.runGCSweep(); } catch { /* non-critical */ }
          break;
      }
    });
    return this.schedulerManager.startScheduler();
  }

  public async stopScheduler(): Promise<ScheduleStatus> {
    return this.schedulerManager.stopScheduler();
  }

  public async getScheduleStatus(): Promise<ScheduleStatus> {
    return this.schedulerManager.getScheduleStatus();
  }

  public async triggerScheduledJob(jobName: ScheduledJobName): Promise<JobHistoryEntry> {
    return this.schedulerManager.triggerJob(jobName);
  }

  public async setJobInterval(jobName: ScheduledJobName, intervalMs: number): Promise<ScheduledJobConfig> {
    return this.schedulerManager.setJobInterval(jobName, intervalMs);
  }

  public async getJobHistory(jobName: ScheduledJobName): Promise<JobHistoryEntry[]> {
    return this.schedulerManager.getJobHistory(jobName);
  }

  // --- Refactoring ---

  public async scanForViolations(): Promise<ViolationReport> {
    return this.refactoringManager.scanForViolations(this.workspacePath);
  }

  public async getViolationReport(): Promise<ViolationReport | null> {
    return this.refactoringManager.getViolationReport();
  }

  public async generateRefactoringPR(violationType: ViolationType): Promise<RefactoringRun> {
    return this.refactoringManager.generateRefactoringPR(violationType);
  }

  public async getRefactoringHistory(): Promise<RefactoringHistory> {
    return this.refactoringManager.getRefactoringHistory();
  }

  // --- GitHub Review Poster ---

  public async postPRReview(
    prNumber: number,
    findings: ReviewFindingInput[],
    verdict: ReviewVerdict,
  ): Promise<PostReviewResult> {
    return this.githubReviewPoster.postReview(prNumber, findings, verdict);
  }

  public async postPRSummary(
    prNumber: number,
    qualityScore: QualityScoreInput,
    evalResult: EvalResultInput,
  ): Promise<PostSummaryResult> {
    return this.githubReviewPoster.postSummaryComment(prNumber, qualityScore, evalResult);
  }

  public async getPRReviewStatus(prNumber: number): Promise<PRReviewStatus> {
    return this.githubReviewPoster.getReviewStatus(prNumber);
  }
}
