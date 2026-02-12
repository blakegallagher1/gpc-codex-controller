/**
 * CommandAuditLogger — Structured audit trail for all shell command executions.
 *
 * Provides:
 *  - Per-command audit entries with timing, exit codes, output sizes
 *  - FIFO eviction to prevent unbounded growth
 *  - Metrics aggregation (total, success/fail rates, duration, frequency)
 *  - Persistence to JSON file (atomic write via temp+rename)
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import crypto from "node:crypto";
import type {
  CommandAuditEntry,
  CommandExecutionState,
  ShellExecutionMetrics,
} from "./types.js";

const DEFAULT_MAX_ENTRIES = 5000;

export class CommandAuditLogger {
  private readonly filePath: string;
  private readonly maxEntries: number;
  private entries: CommandAuditEntry[] = [];
  private loaded = false;

  public constructor(filePath: string, maxEntries = DEFAULT_MAX_ENTRIES) {
    this.filePath = filePath;
    this.maxEntries = maxEntries;
  }

  /**
   * Record the start of a command execution. Returns the audit entry ID.
   */
  public async recordStart(
    taskId: string,
    command: readonly string[],
    cwd: string,
  ): Promise<string> {
    await this.ensureLoaded();
    const id = `audit_${crypto.randomBytes(8).toString("hex")}`;
    const entry: CommandAuditEntry = {
      id,
      taskId,
      command,
      cwd,
      state: "running",
      exitCode: null,
      startedAt: new Date().toISOString(),
      finishedAt: null,
      durationMs: null,
      stdoutBytes: 0,
      stderrBytes: 0,
      error: null,
    };
    this.entries.push(entry);
    this.evictIfNeeded();
    await this.persist();
    return id;
  }

  /**
   * Record the completion of a command execution.
   */
  public async recordEnd(
    auditId: string,
    state: CommandExecutionState,
    exitCode: number | null,
    stdoutBytes: number,
    stderrBytes: number,
    error?: string,
  ): Promise<void> {
    await this.ensureLoaded();
    const entry = this.entries.find((e) => e.id === auditId);
    if (!entry) return;

    entry.state = state;
    entry.exitCode = exitCode;
    entry.finishedAt = new Date().toISOString();
    entry.stdoutBytes = stdoutBytes;
    entry.stderrBytes = stderrBytes;
    entry.error = error ?? null;

    if (entry.startedAt) {
      entry.durationMs = new Date(entry.finishedAt).getTime() - new Date(entry.startedAt).getTime();
    }

    await this.persist();
  }

  /**
   * Get recent audit entries, optionally filtered by taskId.
   */
  public async getEntries(taskId?: string, limit = 50): Promise<CommandAuditEntry[]> {
    await this.ensureLoaded();
    let filtered = taskId
      ? this.entries.filter((e) => e.taskId === taskId)
      : [...this.entries];
    // Most recent first
    filtered = filtered.reverse();
    return filtered.slice(0, limit);
  }

  /**
   * Get aggregated execution metrics, optionally filtered by taskId.
   */
  public async getMetrics(taskId?: string): Promise<ShellExecutionMetrics> {
    await this.ensureLoaded();
    const filtered = taskId
      ? this.entries.filter((e) => e.taskId === taskId)
      : this.entries;

    const totalCommands = filtered.length;
    const succeededCommands = filtered.filter((e) => e.state === "succeeded").length;
    const failedCommands = filtered.filter((e) => e.state === "failed").length;
    const killedCommands = filtered.filter((e) => e.state === "killed").length;

    const durations = filtered
      .filter((e) => e.durationMs !== null)
      .map((e) => e.durationMs as number);
    const totalDurationMs = durations.reduce((sum, d) => sum + d, 0);
    const avgDurationMs = durations.length > 0 ? Math.round(totalDurationMs / durations.length) : 0;

    const commandFrequency: Record<string, number> = {};
    for (const entry of filtered) {
      const binary = entry.command[0] ?? "unknown";
      commandFrequency[binary] = (commandFrequency[binary] ?? 0) + 1;
    }

    return {
      totalCommands,
      succeededCommands,
      failedCommands,
      killedCommands,
      avgDurationMs,
      totalDurationMs,
      commandFrequency,
    };
  }

  /**
   * Clear all audit entries (for testing or GC).
   */
  public async clear(): Promise<void> {
    this.entries = [];
    await this.persist();
  }

  private evictIfNeeded(): void {
    if (this.entries.length > this.maxEntries) {
      // FIFO: remove oldest entries
      const excess = this.entries.length - this.maxEntries;
      this.entries.splice(0, excess);
    }
  }

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    try {
      const raw = await readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        this.entries = parsed;
      }
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        (error as { code?: unknown }).code === "ENOENT"
      ) {
        this.entries = [];
      } else {
        throw error;
      }
    }
    this.loaded = true;
  }

  private async persist(): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const tempPath = `${this.filePath}.tmp`;
    await writeFile(tempPath, JSON.stringify(this.entries, null, 2), "utf8");
    await rename(tempPath, this.filePath);
  }
}
