/**
 * CommandExecutionGateway — Unified command execution with safety controls.
 *
 * This is the centralized gateway for ALL shell command execution in the controller.
 * It wraps workspaceManager.runCommand() with:
 *  - Allowlist + denylist enforcement (binary-level and pattern-level)
 *  - Per-task execution policies
 *  - Concurrency limits (per-task and global)
 *  - Timeout enforcement
 *  - Audit logging via CommandAuditLogger
 *  - Feature flag gating (SHELL_TOOL_ENABLED)
 *
 * Architecture:
 *   Caller → Gateway.execute() → allowlist/denylist check → concurrency check →
 *   workspaceManager.runInWorkspaceAllowNonZero() → audit log → result
 *
 * The gateway does NOT replace workspaceManager — existing callers continue
 * using workspaceManager directly. The gateway is used by the new shell MCP
 * tools and can optionally be wired into existing flows via feature flag.
 */
import { CommandAuditLogger } from "./commandAuditLogger.js";
import type { WorkspaceManager, CommandResult } from "./workspaceManager.js";
import type {
  CommandExecutionPolicy,
  ShellExecutionResult,
  ShellToolConfig,
} from "./types.js";

const DEFAULT_TIMEOUT_MS = 120_000; // 2 minutes
const DEFAULT_MAX_OUTPUT_BYTES = 2 * 1024 * 1024; // 2MB, matching workspaceManager
const DEFAULT_MAX_CONCURRENT_GLOBAL = 10;

// Global allowlist — matches workspaceManager.assertAllowedCommand
const GLOBAL_ALLOWED_BINARIES = new Set(["pnpm", "node", "git", "npx", "bash"]);

// Global denylist patterns — blocked regardless of task policy
const GLOBAL_DENY_PATTERNS_DEFAULT: RegExp[] = [
  /rm\s+-rf\s+\//, // rm -rf /
  /mkfs/, // disk formatting
  /dd\s+if=/, // raw disk writes
  /:\(\)\{.*\}/, // fork bombs
];

export class CommandExecutionGateway {
  private readonly workspaceManager: WorkspaceManager;
  private readonly auditLogger: CommandAuditLogger;
  private readonly config: ShellToolConfig;
  private readonly taskPolicies = new Map<string, CommandExecutionPolicy>();
  private activeCommands = 0;
  private readonly activePerTask = new Map<string, number>();

  public constructor(
    workspaceManager: WorkspaceManager,
    auditLogger: CommandAuditLogger,
    config?: Partial<ShellToolConfig>,
  ) {
    this.workspaceManager = workspaceManager;
    this.auditLogger = auditLogger;
    this.config = {
      enabled: config?.enabled ?? (process.env.SHELL_TOOL_ENABLED !== "false"),
      globalDenyPatterns: config?.globalDenyPatterns ?? [],
      defaultTimeoutMs: config?.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS,
      maxAuditEntries: config?.maxAuditEntries ?? 5000,
      maxConcurrentGlobal: config?.maxConcurrentGlobal ?? DEFAULT_MAX_CONCURRENT_GLOBAL,
    };
  }

  /**
   * Execute a command through the gateway with full safety controls.
   * This is the primary entry point for new shell tool integrations.
   */
  public async execute(
    taskId: string,
    command: readonly string[],
    options?: {
      timeoutMs?: number;
      allowNonZeroExit?: boolean;
    },
  ): Promise<ShellExecutionResult> {
    if (!this.config.enabled) {
      throw new Error("Shell tool is disabled (SHELL_TOOL_ENABLED=false)");
    }

    if (command.length === 0) {
      throw new Error("Command must include at least one token");
    }

    const binary = command[0]!;
    const commandStr = command.join(" ");
    const policy = this.taskPolicies.get(taskId);
    const timeoutMs = options?.timeoutMs ?? policy?.timeoutMs ?? this.config.defaultTimeoutMs;

    // --- Safety checks ---

    // 1. Binary allowlist check
    this.assertBinaryAllowed(binary, policy);

    // 2. Binary denylist check
    this.assertBinaryNotDenied(binary, policy);

    // 3. Pattern denylist check (global + task-level)
    this.assertPatternNotDenied(commandStr, policy);

    // 4. Concurrency limits
    this.assertConcurrencyAllowed(taskId, policy);

    // --- Execute ---
    const auditId = await this.auditLogger.recordStart(taskId, command, this.getWorkspacePath(taskId));
    this.incrementConcurrency(taskId);

    const startTime = Date.now();
    let result: CommandResult;
    let killed = false;

    try {
      // Use workspaceManager for path validation and execution
      result = await Promise.race([
        this.workspaceManager.runInWorkspaceAllowNonZero(taskId, command),
        this.createTimeout(timeoutMs, taskId, command),
      ]) as CommandResult;
    } catch (error) {
      const durationMs = Date.now() - startTime;
      const errorMsg = error instanceof Error ? error.message : String(error);
      killed = errorMsg.includes("timed out") || errorMsg.includes("SIGTERM");

      await this.auditLogger.recordEnd(
        auditId,
        killed ? "killed" : "failed",
        null,
        0,
        0,
        errorMsg,
      );
      this.decrementConcurrency(taskId);

      // If not allowing non-zero exit, rethrow
      if (!options?.allowNonZeroExit) {
        throw error;
      }

      return {
        command,
        cwd: this.getWorkspacePath(taskId),
        exitCode: killed ? 137 : 1,
        stdout: "",
        stderr: errorMsg,
        durationMs,
        killed,
        auditId,
      };
    }

    const durationMs = Date.now() - startTime;
    const state = result.exitCode === 0 ? "succeeded" : "failed";

    await this.auditLogger.recordEnd(
      auditId,
      state,
      result.exitCode,
      Buffer.byteLength(result.stdout, "utf8"),
      Buffer.byteLength(result.stderr, "utf8"),
    );
    this.decrementConcurrency(taskId);

    // If strict mode and non-zero exit, throw
    if (result.exitCode !== 0 && !options?.allowNonZeroExit) {
      throw new Error(
        `Command failed (exit ${result.exitCode}): ${command.join(" ")}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
      );
    }

    return {
      command,
      cwd: result.cwd,
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
      durationMs,
      killed: false,
      auditId,
    };
  }

  /**
   * Set a per-task execution policy. Extends (not replaces) global controls.
   */
  public setTaskPolicy(policy: CommandExecutionPolicy): void {
    this.taskPolicies.set(policy.taskId, policy);
  }

  /**
   * Get the execution policy for a task (or null if using defaults).
   */
  public getTaskPolicy(taskId: string): CommandExecutionPolicy | null {
    return this.taskPolicies.get(taskId) ?? null;
  }

  /**
   * Remove a task's execution policy (reverts to global defaults).
   */
  public removeTaskPolicy(taskId: string): boolean {
    return this.taskPolicies.delete(taskId);
  }

  /**
   * Get the current gateway configuration.
   */
  public getConfig(): ShellToolConfig {
    return { ...this.config };
  }

  /**
   * Check if the gateway is enabled.
   */
  public isEnabled(): boolean {
    return this.config.enabled;
  }

  // --- Safety assertion methods ---

  private assertBinaryAllowed(binary: string, policy?: CommandExecutionPolicy): void {
    // Global allowlist always applies
    const allowed = new Set(GLOBAL_ALLOWED_BINARIES);
    // Task policy can extend the allowlist
    if (policy?.allowedBinaries) {
      for (const b of policy.allowedBinaries) {
        allowed.add(b);
      }
    }
    if (!allowed.has(binary)) {
      throw new Error(`Command binary not allowlisted: ${binary}. Allowed: ${[...allowed].join(", ")}`);
    }
  }

  private assertBinaryNotDenied(binary: string, policy?: CommandExecutionPolicy): void {
    if (policy?.deniedBinaries?.includes(binary)) {
      throw new Error(`Command binary explicitly denied for task: ${binary}`);
    }
  }

  private assertPatternNotDenied(commandStr: string, policy?: CommandExecutionPolicy): void {
    // Check global deny patterns
    for (const pattern of GLOBAL_DENY_PATTERNS_DEFAULT) {
      if (pattern.test(commandStr)) {
        throw new Error(`Command matches global deny pattern: ${pattern.toString()}`);
      }
    }

    // Check config-level deny patterns
    for (const patternStr of this.config.globalDenyPatterns) {
      try {
        const regex = new RegExp(patternStr);
        if (regex.test(commandStr)) {
          throw new Error(`Command matches configured deny pattern: ${patternStr}`);
        }
      } catch {
        // Invalid regex in config — skip silently
      }
    }

    // Check task-level deny patterns
    if (policy?.deniedPatterns) {
      for (const patternStr of policy.deniedPatterns) {
        try {
          const regex = new RegExp(patternStr);
          if (regex.test(commandStr)) {
            throw new Error(`Command matches task deny pattern: ${patternStr}`);
          }
        } catch {
          // Invalid regex — skip
        }
      }
    }
  }

  private assertConcurrencyAllowed(taskId: string, policy?: CommandExecutionPolicy): void {
    // Global limit
    if (this.activeCommands >= this.config.maxConcurrentGlobal) {
      throw new Error(
        `Global concurrent command limit reached (${this.config.maxConcurrentGlobal}). Wait for commands to finish.`,
      );
    }

    // Per-task limit
    const maxPerTask = policy?.maxConcurrent ?? 5;
    const currentPerTask = this.activePerTask.get(taskId) ?? 0;
    if (currentPerTask >= maxPerTask) {
      throw new Error(
        `Per-task concurrent command limit reached for ${taskId} (${maxPerTask}). Wait for commands to finish.`,
      );
    }
  }

  private incrementConcurrency(taskId: string): void {
    this.activeCommands += 1;
    this.activePerTask.set(taskId, (this.activePerTask.get(taskId) ?? 0) + 1);
  }

  private decrementConcurrency(taskId: string): void {
    this.activeCommands = Math.max(0, this.activeCommands - 1);
    const current = this.activePerTask.get(taskId) ?? 1;
    if (current <= 1) {
      this.activePerTask.delete(taskId);
    } else {
      this.activePerTask.set(taskId, current - 1);
    }
  }

  private getWorkspacePath(taskId: string): string {
    return this.workspaceManager.getWorkspacePath(taskId);
  }

  private createTimeout(
    timeoutMs: number,
    taskId: string,
    command: readonly string[],
  ): Promise<never> {
    return new Promise((_, reject) => {
      setTimeout(() => {
        reject(
          new Error(
            `Command timed out after ${timeoutMs}ms for taskId=${taskId}: ${command.join(" ")}`,
          ),
        );
      }, timeoutMs);
    });
  }
}
