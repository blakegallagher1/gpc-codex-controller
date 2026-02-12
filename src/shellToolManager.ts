/**
 * ShellToolManager — High-level shell tool interface for MCP/RPC integration.
 *
 * Provides:
 *  - Per-task execution policy management with persistence
 *  - Command execution via CommandExecutionGateway
 *  - Metrics and audit log access
 *  - Feature flag gating
 *
 * This is the manager that Controller delegates to for all shell-related
 * MCP tools and RPC methods. It coordinates between:
 *  - CommandExecutionGateway (safety + execution)
 *  - CommandAuditLogger (audit trail + metrics)
 *  - Per-task policy persistence
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { CommandExecutionGateway } from "./commandExecutionGateway.js";
import { CommandAuditLogger } from "./commandAuditLogger.js";
import type { WorkspaceManager } from "./workspaceManager.js";
import type {
  CommandAuditEntry,
  CommandExecutionPolicy,
  ShellExecutionMetrics,
  ShellExecutionResult,
  ShellToolConfig,
} from "./types.js";

export class ShellToolManager {
  private readonly gateway: CommandExecutionGateway;
  private readonly auditLogger: CommandAuditLogger;
  private readonly policyFilePath: string;
  private policies = new Map<string, CommandExecutionPolicy>();
  private policiesLoaded = false;

  public constructor(
    workspaceManager: WorkspaceManager,
    stateDir: string,
    config?: Partial<ShellToolConfig>,
  ) {
    this.policyFilePath = `${stateDir}/shell-policies.json`;
    this.auditLogger = new CommandAuditLogger(
      `${stateDir}/command-audit.json`,
      config?.maxAuditEntries ?? 5000,
    );
    this.gateway = new CommandExecutionGateway(
      workspaceManager,
      this.auditLogger,
      config,
    );
  }

  /**
   * Execute a shell command in a task workspace.
   * Full safety controls: allowlist, denylist, concurrency, timeout, audit.
   */
  public async executeCommand(
    taskId: string,
    command: string[],
    options?: {
      timeoutMs?: number;
      allowNonZeroExit?: boolean;
    },
  ): Promise<ShellExecutionResult> {
    await this.ensurePoliciesLoaded();
    return this.gateway.execute(taskId, command, options);
  }

  /**
   * Set a per-task execution policy with persistence.
   */
  public async setTaskPolicy(policy: CommandExecutionPolicy): Promise<CommandExecutionPolicy> {
    await this.ensurePoliciesLoaded();
    const now = new Date().toISOString();
    const normalized: CommandExecutionPolicy = {
      ...policy,
      updatedAt: now,
      createdAt: this.policies.get(policy.taskId)?.createdAt ?? now,
    };
    this.policies.set(policy.taskId, normalized);
    this.gateway.setTaskPolicy(normalized);
    await this.persistPolicies();
    return normalized;
  }

  /**
   * Get a task's execution policy.
   */
  public async getTaskPolicy(taskId: string): Promise<CommandExecutionPolicy | null> {
    await this.ensurePoliciesLoaded();
    return this.policies.get(taskId) ?? null;
  }

  /**
   * Remove a task's execution policy.
   */
  public async removeTaskPolicy(taskId: string): Promise<boolean> {
    await this.ensurePoliciesLoaded();
    const removed = this.policies.delete(taskId);
    if (removed) {
      this.gateway.removeTaskPolicy(taskId);
      await this.persistPolicies();
    }
    return removed;
  }

  /**
   * List all task policies.
   */
  public async listPolicies(): Promise<CommandExecutionPolicy[]> {
    await this.ensurePoliciesLoaded();
    return [...this.policies.values()];
  }

  /**
   * Get recent audit entries.
   */
  public async getAuditLog(taskId?: string, limit = 50): Promise<CommandAuditEntry[]> {
    return this.auditLogger.getEntries(taskId, limit);
  }

  /**
   * Get execution metrics.
   */
  public async getMetrics(taskId?: string): Promise<ShellExecutionMetrics> {
    return this.auditLogger.getMetrics(taskId);
  }

  /**
   * Get gateway configuration.
   */
  public getConfig(): ShellToolConfig {
    return this.gateway.getConfig();
  }

  /**
   * Check if shell tool is enabled.
   */
  public isEnabled(): boolean {
    return this.gateway.isEnabled();
  }

  /**
   * Clear audit log (for GC/testing).
   */
  public async clearAuditLog(): Promise<void> {
    await this.auditLogger.clear();
  }

  // --- Persistence ---

  private async ensurePoliciesLoaded(): Promise<void> {
    if (this.policiesLoaded) return;
    try {
      const raw = await readFile(this.policyFilePath, "utf8");
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        for (const policy of parsed) {
          if (policy && typeof policy.taskId === "string") {
            this.policies.set(policy.taskId, policy as CommandExecutionPolicy);
            this.gateway.setTaskPolicy(policy as CommandExecutionPolicy);
          }
        }
      }
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        (error as { code?: unknown }).code === "ENOENT"
      ) {
        // No file yet — start fresh
      } else {
        throw error;
      }
    }
    this.policiesLoaded = true;
  }

  private async persistPolicies(): Promise<void> {
    await mkdir(dirname(this.policyFilePath), { recursive: true });
    const data = [...this.policies.values()];
    const tempPath = `${this.policyFilePath}.tmp`;
    await writeFile(tempPath, JSON.stringify(data, null, 2), "utf8");
    await rename(tempPath, this.policyFilePath);
  }
}
