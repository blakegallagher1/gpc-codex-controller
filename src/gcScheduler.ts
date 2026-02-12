import { readdir, rm, stat } from "node:fs/promises";
import { resolve } from "node:path";
import type { GCSweepResult } from "./types.js";
import type { JobRecord } from "./mcpServer.js";

const DEFAULT_STALE_WORKSPACE_DAYS = 7;
const DEFAULT_STALE_JOB_HOURS = 24;
const DEFAULT_EVAL_KEEP_LAST = 100;

export class GCScheduler {
  public constructor(
    private readonly workspacesRoot: string,
    private readonly jobs: Map<string, JobRecord>,
  ) {}

  public async sweep(options?: {
    staleWorkspaceDays?: number;
    staleJobHours?: number;
    evalKeepLast?: number;
  }): Promise<GCSweepResult> {
    const staleWorkspaceDays = options?.staleWorkspaceDays ?? DEFAULT_STALE_WORKSPACE_DAYS;
    const staleJobHours = options?.staleJobHours ?? DEFAULT_STALE_JOB_HOURS;

    const freedPaths: string[] = [];

    // 1. Prune stale workspaces
    const staleWorkspaces = await this.listStaleWorkspaces(staleWorkspaceDays);
    let removedWorkspaces = 0;
    for (const path of staleWorkspaces) {
      try {
        await rm(path, { recursive: true, force: true });
        removedWorkspaces += 1;
        freedPaths.push(path);
      } catch {
        // Skip workspaces that can't be removed
      }
    }

    // 2. Prune stale jobs from in-memory map
    const prunedJobs = this.pruneOldJobs(staleJobHours);

    return {
      staleWorkspacesRemoved: removedWorkspaces,
      staleJobsPruned: prunedJobs,
      evalEntriesPruned: 0, // Eval pruning handled separately by evalManager
      freedPaths,
    };
  }

  public async listStaleWorkspaces(olderThanDays: number): Promise<string[]> {
    const stale: string[] = [];
    const cutoff = Date.now() - olderThanDays * 24 * 60 * 60 * 1000;

    try {
      const entries = await readdir(this.workspacesRoot, { withFileTypes: true });

      for (const entry of entries) {
        if (!entry.isDirectory()) {
          continue;
        }

        const dirPath = resolve(this.workspacesRoot, entry.name);

        try {
          const dirStat = await stat(dirPath);
          if (dirStat.mtimeMs < cutoff) {
            stale.push(dirPath);
          }
        } catch {
          // Skip inaccessible directories
        }
      }
    } catch {
      // Workspaces root doesn't exist or is inaccessible
    }

    return stale;
  }

  public pruneOldJobs(olderThanHours: number): number {
    const cutoff = Date.now() - olderThanHours * 60 * 60 * 1000;
    let pruned = 0;

    for (const [jobId, job] of this.jobs) {
      if (job.status === "succeeded" || job.status === "failed") {
        const finishedAt = job.finishedAt ? new Date(job.finishedAt).getTime() : 0;
        if (finishedAt > 0 && finishedAt < cutoff) {
          this.jobs.delete(jobId);
          pruned += 1;
        }
      }
    }

    return pruned;
  }

  public getJobStats(): { total: number; queued: number; running: number; succeeded: number; failed: number } {
    let queued = 0;
    let running = 0;
    let succeeded = 0;
    let failed = 0;

    for (const job of this.jobs.values()) {
      switch (job.status) {
        case "queued": queued += 1; break;
        case "running": running += 1; break;
        case "succeeded": succeeded += 1; break;
        case "failed": failed += 1; break;
      }
    }

    return { total: this.jobs.size, queued, running, succeeded, failed };
  }
}
