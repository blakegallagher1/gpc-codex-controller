export type JsonRpcId = number | string | null;

export interface JsonRpcErrorObject {
  code: number;
  message: string;
  data?: unknown;
}

export interface JsonRpcRequest<TParams = unknown> {
  jsonrpc?: "2.0";
  id: JsonRpcId;
  method: string;
  params?: TParams;
}

export interface JsonRpcNotification<TParams = unknown> {
  jsonrpc?: "2.0";
  method: string;
  params?: TParams;
}

export interface JsonRpcSuccess<TResult = unknown> {
  jsonrpc?: "2.0";
  id: JsonRpcId;
  result: TResult;
}

export interface JsonRpcFailure {
  jsonrpc?: "2.0";
  id: JsonRpcId;
  error: JsonRpcErrorObject;
}

export type JsonRpcResponse<TResult = unknown> = JsonRpcSuccess<TResult> | JsonRpcFailure;
export type JsonRpcMessage = JsonRpcRequest | JsonRpcNotification | JsonRpcResponse;

export function isJsonRpcResponse(message: JsonRpcMessage): message is JsonRpcResponse {
  return "id" in message && ("result" in message || "error" in message);
}

export function isJsonRpcFailure(message: JsonRpcResponse): message is JsonRpcFailure {
  return "error" in message;
}

export function isJsonRpcRequest(message: JsonRpcMessage): message is JsonRpcRequest {
  // Some servers include `"id": null` in notifications. In that case, treat it as a notification,
  // otherwise we'll incorrectly respond with method-not-found and never emit the notification.
  return "method" in message && "id" in message && (message as { id?: unknown }).id !== null;
}

export interface InitializeParams {
  clientInfo: {
    name: string;
    version: string;
  };
}

export interface InitializeResult {
  userAgent?: string;
}

export interface LoginStartParams {
  type: "chatgpt";
}

export type LoginStartResult = { type: "chatgpt"; loginId: string; authUrl: string } | { type: "apiKey" };

export interface LoginCompletedParams {
  loginId: string | null;
  success: boolean;
  error: string | null;
}

// Must match codex app-server enum variants (kebab-case).
export type SandboxPolicy = "workspace-write" | "read-only" | "danger-full-access" | "workspaceWrite" | "readOnly" | "dangerFullAccess";
export type ApprovalPolicy = "never";

export interface ThreadStartParams {
  model: "gpt-5.2-codex" | null;
  modelProvider: string | null;
  cwd: string | null;
  approvalPolicy: ApprovalPolicy | null;
  sandbox: SandboxPolicy | null;
  config: Record<string, unknown> | null;
  baseInstructions: string | null;
  developerInstructions: string | null;
}

export interface ThreadStartResult {
  thread: {
    id: string;
  };
}

export interface ControllerState {
  threadId?: string;
}

export interface UserInputText {
  type: "text";
  text: string;
}

export interface TurnStartParams {
  threadId: string;
  input: UserInputText[];
  cwd: string | null;
  approvalPolicy: ApprovalPolicy | null;
  sandboxPolicy: WorkspaceWriteTurnSandboxPolicy | null;
  model: string | null;
  effort: null;
  summary: null;
}

export interface WorkspaceWriteTurnSandboxPolicy {
  // turn/start uses camelCase (thread/start uses kebab-case — Codex API inconsistency).
  type: "workspaceWrite";
  writableRoots?: string[];
  networkAccess?: boolean;
  excludeTmpdirEnvVar?: boolean;
  excludeSlashTmp?: boolean;
}

export interface TurnStartResult {
  turn: {
    id: string;
    status: string;
    error: {
      message?: string;
    } | null;
  };
}

export interface TurnCompletedParams {
  threadId: string;
  turn: {
    id: string;
    status: string;
    error: {
      message?: string;
    } | null;
  };
}

export interface TurnDiffUpdatedParams {
  threadId: string;
  turnId: string;
  diff: string;
}

export interface ItemDeltaParams {
  threadId: string;
  turnId: string;
  itemId: string;
  delta: string;
}

export interface StartOrContinueTaskResult {
  threadId: string;
  turnId: string;
  status: string;
}

export interface VerifyResult {
  taskId: string;
  workspacePath: string;
  success: boolean;
  exitCode: number;
  verificationJson: unknown | null;
  parsedFailures: string[];
  stdoutTail: string;
  stderrTail: string;
  combinedTail: string;
}

export interface FixUntilGreenResult {
  taskId: string;
  success: boolean;
  iterations: number;
  lastVerify: VerifyResult;
}

export type TaskStatus = "created" | "mutating" | "verifying" | "fixing" | "ready" | "pr_opened" | "failed";

export interface TaskRecord {
  taskId: string;
  workspacePath: string;
  branchName: string;
  threadId: string;
  createdAt: string;
  status: TaskStatus;
}

export interface RunMutationResult {
  taskId: string;
  branch: string;
  prUrl: string;
  iterations: number;
  success: boolean;
  evalScore?: number;
}

// --- Compaction ---

export interface CompactStartParams {
  threadId: string;
}

export interface CompactStartResult {
  status: string;
}

// --- Parallel Task Execution ---

export interface ParallelTaskRequest {
  taskId: string;
  featureDescription: string;
}

export interface ParallelTaskResult {
  taskId: string;
  success: boolean;
  result?: RunMutationResult;
  error?: string;
}

export interface ParallelRunResult {
  totalTasks: number;
  succeeded: number;
  failed: number;
  results: ParallelTaskResult[];
}

// --- Doc Gardening ---

export interface DocGardenResult {
  taskId: string;
  threadId: string;
  turnId: string;
  status: string;
}

// --- Eval ---

export interface EvalSummary {
  taskId: string;
  overallScore: number;
  passed: boolean;
  checkCount: number;
  passedCount: number;
}

// --- Execution Plans ---

export type PlanPhaseStatus = "pending" | "in_progress" | "completed" | "failed" | "skipped";

export interface PlanPhase {
  name: string;
  description: string;
  status: PlanPhaseStatus;
  estimatedLOC: number;
  dependencies: number[]; // indices of prerequisite phases
  startedAt: string | null;
  completedAt: string | null;
}

export interface ExecutionPlan {
  taskId: string;
  description: string;
  phases: PlanPhase[];
  createdAt: string;
  updatedAt: string;
}

// --- CI Status ---

export interface CIRunRecord {
  taskId: string;
  runId: string;
  timestamp: string;
  passed: boolean;
  exitCode: number;
  duration_ms: number;
  failureCount: number;
  failureSummary: string[];
  /** GitHub Actions run ID, if triggered via CI integration. */
  ghRunId?: number | undefined;
  /** Source of the record: "manual" for local pnpm verify, "webhook" for GH check suite, "ci" for triggered workflow. */
  source?: "manual" | "webhook" | "ci" | undefined;
}

export interface CIStatusSummary {
  taskId: string;
  lastRun: CIRunRecord | null;
  totalRuns: number;
  passRate: number;
  recentRegressions: string[];
}

// --- CI Integration (GitHub Actions) ---

export type CITriggerStatus = "pending" | "in_progress" | "completed" | "timed_out" | "failed";

export interface CITriggerResult {
  taskId: string;
  ghRunId: number;
  status: CITriggerStatus;
  url: string;
  triggeredAt: string;
}

export interface CIPollResult {
  ghRunId: number;
  status: CITriggerStatus;
  conclusion: string | null;
  passed: boolean;
  url: string;
  durationMs: number;
}

export interface CIFailureLogs {
  ghRunId: number;
  failedJobs: CIFailedJob[];
  summary: string[];
}

export interface CIFailedJob {
  jobName: string;
  conclusion: string;
  steps: CIFailedStep[];
}

export interface CIFailedStep {
  stepName: string;
  conclusion: string;
  logExcerpt: string;
}

// --- PR Automerge ---

export interface AutomergePolicy {
  prefixWhitelist: string[];
  maxLinesChanged: number;
  requireCIGreen: boolean;
  requireReviewApproval: boolean;
  neverAutomergePatterns: string[];
  updatedAt: string;
}

export interface AutomergeEvaluation {
  eligible: boolean;
  reason: string;
  prNumber: number;
  taskId: string;
  checks: AutomergeCheck[];
}

export interface AutomergeCheck {
  name: string;
  passed: boolean;
  detail: string;
}

export interface AutomergeResult {
  prNumber: number;
  merged: boolean;
  strategy: "squash" | "merge" | "rebase";
  error: string | null;
}

// --- PR Review ---

export type ReviewSeverity = "error" | "warning" | "suggestion";

export interface ReviewFinding {
  file: string;
  line: number | null;
  severity: ReviewSeverity;
  message: string;
  rule: string;
}

export interface ReviewResult {
  taskId: string;
  timestamp: string;
  findings: ReviewFinding[];
  errorCount: number;
  warningCount: number;
  suggestionCount: number;
  approved: boolean;
}

// --- App Boot ---

export interface AppBootResult {
  taskId: string;
  started: boolean;
  healthCheck: boolean;
  url: string | null;
  pid: number | null;
  error: string | null;
}

// --- Log Query ---

export interface LogQueryResult {
  taskId: string;
  pattern: string;
  matchCount: number;
  lines: string[];
  truncated: boolean;
}

// --- Linter ---

export interface LintFinding {
  file: string;
  line: number;
  column: number;
  severity: "error" | "warning";
  message: string;
  rule: string;
}

export interface LintResult {
  taskId: string;
  passed: boolean;
  errorCount: number;
  warningCount: number;
  findings: LintFinding[];
}

// --- Architecture Validation ---

export interface ArchViolation {
  type: "dependency-direction" | "layer-boundary" | "import-cycle";
  source: string;
  target: string;
  message: string;
}

export interface ArchValidationResult {
  taskId: string;
  passed: boolean;
  violations: ArchViolation[];
}

// --- Doc Validation ---

export interface DocIssue {
  file: string;
  type: "stale-reference" | "missing-doc" | "broken-link" | "outdated-example";
  message: string;
}

export interface DocValidationResult {
  taskId: string;
  passed: boolean;
  issues: DocIssue[];
}

// --- Quality Score ---

export interface QualityScoreBreakdown {
  eval: number;
  ci: number;
  lint: number;
  architecture: number;
  docs: number;
}

export interface QualityScore {
  taskId: string;
  overall: number;
  breakdown: QualityScoreBreakdown;
  timestamp: string;
}

// --- GC Sweep ---

export interface GCSweepResult {
  staleWorkspacesRemoved: number;
  staleJobsPruned: number;
  evalEntriesPruned: number;
  freedPaths: string[];
}

// --- Bug Reproduction ---

export interface BugReproResult {
  taskId: string;
  reproduced: boolean;
  testFile: string | null;
  error: string | null;
  steps: string[];
}

// --- Reference Docs ---

export interface ReferenceDoc {
  id: string;
  category: string;
  title: string;
  content: string;
  addedAt: string;
}

// --- Task Continuation ---

export interface TaskCheckpoint {
  taskId: string;
  checkpointId: string;
  threadId: string;
  timestamp: string;
  description: string;
}

// --- Skill Routing ---

export interface SkillRouteDecision {
  skillName: string;
  score: number; // 0–1 relevance score
  reason: string;
}

export interface SkillRoutingResult {
  selectedSkills: SkillRouteDecision[];
  rejectedSkills: SkillRouteDecision[];
  totalCandidates: number;
}

// --- Artifact Management ---

export interface Artifact {
  id: string;
  taskId: string;
  name: string;
  type: "file" | "report" | "dataset" | "screenshot" | "log";
  path: string; // absolute path in workspace
  sizeBytes: number;
  createdAt: string;
  metadata: Record<string, string>;
}

export interface ArtifactCollectionResult {
  taskId: string;
  artifacts: Artifact[];
  totalSizeBytes: number;
  handoffPath: string; // the standardized collection directory
}

// --- Network Policy ---

export interface NetworkAllowlistEntry {
  domain: string;
  ports?: number[] | undefined;
  reason: string;
}

export interface OrgNetworkPolicy {
  allowlist: NetworkAllowlistEntry[];
  defaultDeny: boolean;
  updatedAt: string;
}

export interface RequestNetworkPolicy {
  taskId: string;
  allowlist: NetworkAllowlistEntry[];
  inheritOrg: boolean;
}

export interface NetworkPolicyValidation {
  valid: boolean;
  violations: string[];
  effectiveAllowlist: NetworkAllowlistEntry[];
}

// --- Domain Secrets ---

export interface DomainSecret {
  domain: string;
  headerName: string;
  placeholder: string; // e.g. "$API_KEY" — what the model sees
  // Real value is NEVER exposed to model or stored in state JSON.
  envVar: string; // env var name that holds the real value at runtime
}

export interface DomainSecretsConfig {
  secrets: DomainSecret[];
  updatedAt: string;
}

export interface SecretInjectionResult {
  domain: string;
  injected: boolean;
  headerName: string;
  placeholder: string;
}

// --- Compaction (enhanced) ---

export interface CompactionConfig {
  strategy: "turn-interval" | "token-threshold" | "auto";
  turnInterval: number; // for turn-interval strategy
  tokenThreshold: number; // for token-threshold strategy
  autoThresholdPercent: number; // for auto: compact when context is N% full
  maxContextTokens: number; // model's context window size
}

export interface CompactionEvent {
  threadId: string;
  timestamp: string;
  strategy: string;
  estimatedTokensBefore: number;
  estimatedTokensAfter: number;
  turnNumber: number;
}

// --- Shell Tool Integration ---

export type CommandExecutionState = "pending" | "running" | "succeeded" | "failed" | "killed";

export interface CommandAuditEntry {
  id: string;
  taskId: string;
  command: readonly string[];
  cwd: string;
  state: CommandExecutionState;
  exitCode: number | null;
  startedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
  stdoutBytes: number;
  stderrBytes: number;
  error: string | null;
}

export interface CommandExecutionPolicy {
  taskId: string;
  allowedBinaries: string[];  // extends global allowlist for this task
  deniedBinaries: string[];   // explicit denylist for this task
  deniedPatterns: string[];   // regex patterns to block (e.g., "rm -rf")
  maxConcurrent: number;      // max concurrent commands per task
  timeoutMs: number;          // per-command timeout
  maxOutputBytes: number;     // per-stream output limit
  createdAt: string;
  updatedAt: string;
}

export interface ShellExecutionResult {
  command: readonly string[];
  cwd: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  killed: boolean;
  auditId: string;
}

export interface ShellExecutionMetrics {
  totalCommands: number;
  succeededCommands: number;
  failedCommands: number;
  killedCommands: number;
  avgDurationMs: number;
  totalDurationMs: number;
  commandFrequency: Record<string, number>; // binary → count
}

export interface ShellToolConfig {
  enabled: boolean;           // SHELL_TOOL_ENABLED feature flag
  globalDenyPatterns: string[]; // patterns denied across all tasks
  defaultTimeoutMs: number;   // default per-command timeout
  maxAuditEntries: number;    // FIFO eviction threshold
  maxConcurrentGlobal: number; // global concurrent command limit
}

// --- Autonomous Orchestration ---

export type AutonomousRunStatus =
  | "planning"
  | "executing"
  | "validating"
  | "committing"
  | "reviewing"
  | "completed"
  | "failed"
  | "cancelled";

export interface AutonomousRunParams {
  objective: string;
  maxPhaseFixes: number;
  qualityThreshold: number;
  autoCommit: boolean;
  autoPR: boolean;
  autoReview: boolean;
}

export interface AutonomousPhaseResult {
  phaseIndex: number;
  phaseName: string;
  status: "completed" | "failed" | "skipped";
  turnId: string | null;
  verifyPassed: boolean;
  fixIterations: number;
  durationMs: number;
  error: string | null;
}

export interface AutonomousRunRecord {
  runId: string;
  taskId: string;
  objective: string;
  status: AutonomousRunStatus;
  params: AutonomousRunParams;
  phases: AutonomousPhaseResult[];
  startedAt: string;
  updatedAt: string;
  finishedAt: string | null;
  qualityScore: number | null;
  commitHash: string | null;
  prUrl: string | null;
  reviewPassed: boolean | null;
  error: string | null;
}

// --- Turn Steering ---

export interface TurnSteerParams {
  threadId: string;
  input: Array<{ type: string; text: string }>;
  expectedTurnId?: string;
}

// --- Review Start ---

export interface ReviewTarget {
  type: string;
  sha?: string;
  baseBranch?: string;
}

export interface ReviewStartParams {
  threadId: string;
  delivery?: "inline" | "detached";
  target: ReviewTarget;
}

// --- Token Usage ---

export interface TokenUsageUpdate {
  threadId: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

// --- Webhooks ---

export type WebhookEventType =
  | "issue.opened"
  | "issue.labeled"
  | "pull_request.opened"
  | "pull_request.synchronize"
  | "pull_request.closed"
  | "check_run.completed"
  | "push";

export interface WebhookEvent {
  type: WebhookEventType;
  action: string;
  payload: WebhookPayload;
  receivedAt: string;
}

export interface WebhookPayload {
  repository: { full_name: string; clone_url: string };
  sender: { login: string };
  issue?: { number: number; title: string; body: string; labels: Array<{ name: string }> };
  pull_request?: { number: number; title: string; head: { ref: string; sha: string }; base: { ref: string }; merged: boolean };
  check_run?: { id: number; name: string; conclusion: string | null; head_sha: string };
  ref?: string;
  after?: string;
}

// --- Issue Triage ---

export interface IssueClassification {
  category: "bug" | "feature" | "docs" | "refactor" | "question" | "unknown";
  priority: "critical" | "high" | "medium" | "low";
  confidence: number;
  suggestedLabels: string[];
  reasoning: string;
}

export interface IssueTriageResult {
  issueNumber: number;
  classification: IssueClassification;
  autoAssigned: boolean;
  taskCreated: boolean;
  taskId: string | null;
  triagedAt: string;
}

// --- CI Integration ---

export type CIRunStatus = "pending" | "running" | "passed" | "failed" | "cancelled";

export interface CIIntegrationResult {
  taskId: string;
  runId: string;
  status: CIRunStatus;
  checkName: string;
  sha: string;
  startedAt: string;
  completedAt: string | null;
  duration_ms: number | null;
  passed: boolean;
}

// --- Scheduler ---

export interface ScheduleConfig {
  jobs: ScheduleJob[];
  timezone: string;
  updatedAt: string;
}

export interface ScheduleJob {
  id: string;
  name: string;
  cron: string;
  method: string;
  params: Record<string, unknown>;
  enabled: boolean;
  lastRun: string | null;
  nextRun: string | null;
  createdAt: string;
}

export interface JobHistory {
  jobId: string;
  jobName: string;
  startedAt: string;
  finishedAt: string | null;
  status: "running" | "succeeded" | "failed";
  result: unknown | null;
  error: string | null;
}

// --- Refactoring / Golden Principles ---

export interface GoldenPrinciple {
  id: string;
  name: string;
  description: string;
  pattern: string;
  severity: "error" | "warning";
}

export interface RefactoringViolation {
  principle: GoldenPrinciple;
  file: string;
  line: number | null;
  message: string;
}

// --- GitHub PR Comments ---

export type ReviewVerdict = "approve" | "request_changes" | "comment";

export interface GithubReviewPost {
  prNumber: number;
  repo: string;
  verdict: ReviewVerdict;
  body: string;
  postedAt: string;
}

// --- Alerting ---

export type AlertSeverity = "info" | "warning" | "error" | "critical";

export type AlertChannelType = "slack" | "webhook" | "console";

export interface AlertChannelConfig {
  type: AlertChannelType;
  enabled: boolean;
  url?: string | undefined;
}

export interface AlertConfig {
  channels: AlertChannelConfig[];
  updatedAt: string;
}

export interface AlertEvent {
  id: string;
  severity: AlertSeverity;
  source: string;
  title: string;
  message: string;
  metadata: Record<string, unknown>;
  timestamp: string;
  dispatched: boolean;
  channels: AlertChannelType[];
}

export interface AlertMuteRule {
  pattern: string;
  expiresAt: string;
  createdAt: string;
}

// --- Merge Queue ---

export interface MergeQueueEntry {
  taskId: string;
  prNumber: number;
  priority: number;
  branchName: string;
  enqueuedAt: string;
  status: "waiting" | "rebasing" | "ready" | "merging" | "merged" | "blocked";
  conflictDetected: boolean;
  lastCheckedAt: string | null;
}

export interface ConflictDetectionResult {
  taskId: string;
  hasConflicts: boolean;
  conflictFiles: string[];
  baseSha: string;
  headSha: string;
  checkedAt: string;
}

// --- Dashboard ---

export interface DashboardData {
  tasks: TaskRecord[];
  recentAutonomousRuns: AutonomousRunRecord[];
  qualityScores: QualityScore[];
  ciPassRate: number;
  alertSummary: { total: number; critical: number; error: number; warning: number; info: number };
  mergeQueueDepth: number;
  schedulerRunning: boolean;
  timestamp: string;
}
