/**
 * MergeQueueManager — FIFO merge ordering with conflict detection and auto-rebase.
 *
 * Before PR creation: checks branch freshness via `git merge-base`.
 * If stale: auto-rebases onto latest main.
 * If rebase fails: marks task as blocked and alerts.
 *
 * Persists queue to JSON file (atomic write via temp+rename).
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import crypto from "node:crypto";
import type {
  ConflictDetectionResult,
  MergeQueueEntry,
} from "./types.js";
import type { WorkspaceManager } from "./workspaceManager.js";

export class MergeQueueManager {
  private readonly queuePath: string;
  private readonly workspaceManager: WorkspaceManager;
  private queue: MergeQueueEntry[] = [];
  private loaded = false;

  public constructor(queuePath: string, workspaceManager: WorkspaceManager) {
    this.queuePath = queuePath;
    this.workspaceManager = workspaceManager;
  }

  /**
   * Add a PR to the merge queue.
   */
  public async enqueue(taskId: string, prNumber: number, priority = 0): Promise<MergeQueueEntry> {
    await this.ensureLoaded();

    // Check if already in queue
    const existing = this.queue.find((e) => e.taskId === taskId);
    if (existing) {
      existing.prNumber = prNumber;
      existing.priority = priority;
      existing.status = "waiting";
      existing.conflictDetected = false;
      await this.persist();
      return existing;
    }

    // Get branch name from workspace
    let branchName = `codex/${taskId}`;
    try {
      const result = await this.workspaceManager.runInWorkspace(taskId, ["git", "rev-parse", "--abbrev-ref", "HEAD"]);
      branchName = result.stdout.trim() || branchName;
    } catch {
      // Use default branch name if workspace doesn't exist yet
    }

    const entry: MergeQueueEntry = {
      taskId,
      prNumber,
      priority,
      branchName,
      enqueuedAt: new Date().toISOString(),
      status: "waiting",
      conflictDetected: false,
      lastCheckedAt: null,
    };

    this.queue.push(entry);
    // Sort by priority (higher first), then by enqueue time (FIFO within same priority)
    this.queue.sort((a, b) => {
      if (a.priority !== b.priority) return b.priority - a.priority;
      return new Date(a.enqueuedAt).getTime() - new Date(b.enqueuedAt).getTime();
    });

    await this.persist();
    return entry;
  }

  /**
   * Get the next PR to merge from the queue (FIFO with priority ordering).
   */
  public async dequeue(): Promise<MergeQueueEntry | null> {
    await this.ensureLoaded();
    const next = this.queue.find((e) => e.status === "ready" || e.status === "waiting");
    if (!next) return null;

    next.status = "merging";
    await this.persist();
    return next;
  }

  /**
   * Check if a task's branch is up-to-date with main.
   */
  public async checkFreshness(taskId: string): Promise<{ fresh: boolean; behindBy: number }> {
    await this.ensureLoaded();

    try {
      // Fetch latest from remote
      await this.workspaceManager.runInWorkspaceAllowNonZero(taskId, ["git", "fetch", "origin", "main"]);

      // Get merge-base
      const mergeBaseResult = await this.workspaceManager.runInWorkspace(taskId, [
        "git", "merge-base", "HEAD", "origin/main",
      ]);
      const mergeBase = mergeBaseResult.stdout.trim();

      // Get the tip of origin/main
      const mainTipResult = await this.workspaceManager.runInWorkspace(taskId, [
        "git", "rev-parse", "origin/main",
      ]);
      const mainTip = mainTipResult.stdout.trim();

      if (mergeBase === mainTip) {
        return { fresh: true, behindBy: 0 };
      }

      // Count commits behind
      const behindResult = await this.workspaceManager.runInWorkspace(taskId, [
        "git", "rev-list", "--count", `${mergeBase}..origin/main`,
      ]);
      const behindBy = parseInt(behindResult.stdout.trim(), 10) || 0;

      // Update queue entry
      const entry = this.queue.find((e) => e.taskId === taskId);
      if (entry) {
        entry.lastCheckedAt = new Date().toISOString();
        await this.persist();
      }

      return { fresh: false, behindBy };
    } catch {
      return { fresh: false, behindBy: -1 };
    }
  }

  /**
   * Rebase branch onto latest main. Returns success status.
   */
  public async rebaseOntoMain(taskId: string): Promise<{ success: boolean; error: string | null }> {
    await this.ensureLoaded();

    const entry = this.queue.find((e) => e.taskId === taskId);
    if (entry) {
      entry.status = "rebasing";
      await this.persist();
    }

    try {
      // Fetch latest main
      await this.workspaceManager.runInWorkspace(taskId, ["git", "fetch", "origin", "main"]);

      // Attempt rebase
      const rebaseResult = await this.workspaceManager.runInWorkspaceAllowNonZero(taskId, [
        "git", "rebase", "origin/main",
      ]);

      if (rebaseResult.exitCode !== 0) {
        // Abort the failed rebase
        await this.workspaceManager.runInWorkspaceAllowNonZero(taskId, ["git", "rebase", "--abort"]);

        if (entry) {
          entry.status = "blocked";
          entry.conflictDetected = true;
          entry.lastCheckedAt = new Date().toISOString();
          await this.persist();
        }

        return {
          success: false,
          error: `Rebase failed with conflicts: ${rebaseResult.stderr.slice(0, 500)}`,
        };
      }

      if (entry) {
        entry.status = "ready";
        entry.conflictDetected = false;
        entry.lastCheckedAt = new Date().toISOString();
        await this.persist();
      }

      return { success: true, error: null };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      if (entry) {
        entry.status = "blocked";
        entry.conflictDetected = true;
        entry.lastCheckedAt = new Date().toISOString();
        await this.persist();
      }

      return { success: false, error: message };
    }
  }

  /**
   * Detect merge conflicts for a task's branch against main.
   */
  public async detectConflicts(taskId: string): Promise<ConflictDetectionResult> {
    await this.ensureLoaded();

    const now = new Date().toISOString();
    try {
      await this.workspaceManager.runInWorkspace(taskId, ["git", "fetch", "origin", "main"]);

      const headResult = await this.workspaceManager.runInWorkspace(taskId, ["git", "rev-parse", "HEAD"]);
      const headSha = headResult.stdout.trim();

      const baseResult = await this.workspaceManager.runInWorkspace(taskId, ["git", "rev-parse", "origin/main"]);
      const baseSha = baseResult.stdout.trim();

      // Use merge-tree to detect conflicts without modifying working tree
      const mergeTreeResult = await this.workspaceManager.runInWorkspaceAllowNonZero(taskId, [
        "git", "merge-tree", "--write-tree", "origin/main", "HEAD",
      ]);

      const hasConflicts = mergeTreeResult.exitCode !== 0;
      const conflictFiles: string[] = [];

      if (hasConflicts) {
        // Parse conflict file paths from output
        const lines = mergeTreeResult.stdout.split("\n");
        for (const line of lines) {
          const trimmed = line.trim();
          if (trimmed.length > 0 && !trimmed.startsWith("CONFLICT") && !trimmed.includes(" ")) {
            conflictFiles.push(trimmed);
          }
          if (trimmed.startsWith("CONFLICT")) {
            // Extract file name from CONFLICT messages
            const match = trimmed.match(/CONFLICT.*?:\s+(.+)/);
            if (match?.[1]) {
              conflictFiles.push(match[1].trim());
            }
          }
        }
      }

      // Update queue entry
      const entry = this.queue.find((e) => e.taskId === taskId);
      if (entry) {
        entry.conflictDetected = hasConflicts;
        entry.lastCheckedAt = now;
        if (hasConflicts) {
          entry.status = "blocked";
        }
        await this.persist();
      }

      return {
        taskId,
        hasConflicts,
        conflictFiles,
        baseSha,
        headSha,
        checkedAt: now,
      };
    } catch {
      return {
        taskId,
        hasConflicts: false,
        conflictFiles: [],
        baseSha: "unknown",
        headSha: "unknown",
        checkedAt: now,
      };
    }
  }

  /**
   * Get current queue status.
   */
  public async getQueueStatus(): Promise<{
    entries: MergeQueueEntry[];
    depth: number;
    blockedCount: number;
    readyCount: number;
  }> {
    await this.ensureLoaded();
    return {
      entries: [...this.queue],
      depth: this.queue.length,
      blockedCount: this.queue.filter((e) => e.status === "blocked").length,
      readyCount: this.queue.filter((e) => e.status === "ready").length,
    };
  }

  /**
   * Mark an entry as merged and remove from queue.
   */
  public async markMerged(taskId: string): Promise<void> {
    await this.ensureLoaded();
    const entry = this.queue.find((e) => e.taskId === taskId);
    if (entry) {
      entry.status = "merged";
    }
    // Remove merged entries
    this.queue = this.queue.filter((e) => e.status !== "merged");
    await this.persist();
  }

  /**
   * Remove a task from the queue.
   */
  public async remove(taskId: string): Promise<boolean> {
    await this.ensureLoaded();
    const before = this.queue.length;
    this.queue = this.queue.filter((e) => e.taskId !== taskId);
    if (this.queue.length < before) {
      await this.persist();
      return true;
    }
    return false;
  }

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    try {
      const raw = await readFile(this.queuePath, "utf8");
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        this.queue = parsed;
      }
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        (error as { code?: unknown }).code === "ENOENT"
      ) {
        this.queue = [];
      } else {
        throw error;
      }
    }
    this.loaded = true;
  }

  private async persist(): Promise<void> {
    await mkdir(dirname(this.queuePath), { recursive: true });
    const tmpPath = `${this.queuePath}.tmp`;
    await writeFile(tmpPath, JSON.stringify(this.queue, null, 2), "utf8");
    await rename(tmpPath, this.queuePath);
  }
}
