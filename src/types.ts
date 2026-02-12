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
  return "method" in message && "id" in message;
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

export type SandboxPolicy = "workspaceWrite";
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
}
