import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ScheduledJobName =
  | "quality-scan"
  | "architecture-sweep"
  | "doc-gardening"
  | "gc-sweep";

export type JobRunStatus = "success" | "failure";

export interface JobHistoryEntry {
  runId: string;
  jobName: ScheduledJobName;
  status: JobRunStatus;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  error: string | null;
}

export interface ScheduledJobConfig {
  name: ScheduledJobName;
  intervalMs: number;
  enabled: boolean;
  lastRunAt: string | null;
  nextRunAt: string | null;
  successCount: number;
  failureCount: number;
  lastError: string | null;
}

export interface SchedulerState {
  running: boolean;
  startedAt: string | null;
  jobs: Record<ScheduledJobName, ScheduledJobConfig>;
  history: JobHistoryEntry[];
}

export interface ScheduleStatus {
  running: boolean;
  startedAt: string | null;
  jobs: ScheduledJobConfig[];
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_HISTORY = 100;

const ONE_HOUR_MS = 60 * 60 * 1000;
const SIX_AM_OFFSET_MS = 6 * ONE_HOUR_MS;
const SEVEN_AM_OFFSET_MS = 7 * ONE_HOUR_MS;
const WEEKLY_MS = 7 * 24 * ONE_HOUR_MS;

const DEFAULT_JOBS: Record<ScheduledJobName, { intervalMs: number }> = {
  "quality-scan": { intervalMs: ONE_HOUR_MS },
  "architecture-sweep": { intervalMs: 24 * ONE_HOUR_MS },
  "doc-gardening": { intervalMs: 24 * ONE_HOUR_MS },
  "gc-sweep": { intervalMs: WEEKLY_MS },
};

interface SchedulerStoreFile {
  version: number;
  state: SchedulerState;
}

const EMPTY_STORE: SchedulerStoreFile = {
  version: 1,
  state: {
    running: false,
    startedAt: null,
    jobs: {
      "quality-scan": {
        name: "quality-scan",
        intervalMs: DEFAULT_JOBS["quality-scan"].intervalMs,
        enabled: true,
        lastRunAt: null,
        nextRunAt: null,
        successCount: 0,
        failureCount: 0,
        lastError: null,
      },
      "architecture-sweep": {
        name: "architecture-sweep",
        intervalMs: DEFAULT_JOBS["architecture-sweep"].intervalMs,
        enabled: true,
        lastRunAt: null,
        nextRunAt: null,
        successCount: 0,
        failureCount: 0,
        lastError: null,
      },
      "doc-gardening": {
        name: "doc-gardening",
        intervalMs: DEFAULT_JOBS["doc-gardening"].intervalMs,
        enabled: true,
        lastRunAt: null,
        nextRunAt: null,
        successCount: 0,
        failureCount: 0,
        lastError: null,
      },
      "gc-sweep": {
        name: "gc-sweep",
        intervalMs: DEFAULT_JOBS["gc-sweep"].intervalMs,
        enabled: true,
        lastRunAt: null,
        nextRunAt: null,
        successCount: 0,
        failureCount: 0,
        lastError: null,
      },
    },
    history: [],
  },
};

// ---------------------------------------------------------------------------
// Job executor callback type
// ---------------------------------------------------------------------------

export type JobExecutor = (jobName: ScheduledJobName) => Promise<void>;

// ---------------------------------------------------------------------------
// SchedulerManager
// ---------------------------------------------------------------------------

export class SchedulerManager {
  private timers = new Map<ScheduledJobName, ReturnType<typeof setInterval>>();
  private executor: JobExecutor | null = null;

  public constructor(private readonly filePath: string) {}

  /**
   * Register the callback that actually runs each job type.
   * Must be called before startScheduler.
   */
  public setExecutor(executor: JobExecutor): void {
    this.executor = executor;
  }

  public async startScheduler(): Promise<ScheduleStatus> {
    if (this.timers.size > 0) {
      return this.getScheduleStatus();
    }

    const store = await this.load();
    store.state.running = true;
    store.state.startedAt = new Date().toISOString();

    const jobNames = Object.keys(store.state.jobs) as ScheduledJobName[];

    for (const name of jobNames) {
      const job = store.state.jobs[name];
      if (!job.enabled) {
        continue;
      }

      const nextRun = this.computeNextRunTime(name, job);
      job.nextRunAt = nextRun.toISOString();

      const timer = setInterval(() => {
        void this.executeJob(name);
      }, job.intervalMs);

      // Prevent the timer from keeping the process alive
      if (typeof timer === "object" && "unref" in timer) {
        timer.unref();
      }

      this.timers.set(name, timer);
    }

    await this.save(store);
    return this.toScheduleStatus(store.state);
  }

  public async stopScheduler(): Promise<ScheduleStatus> {
    for (const [, timer] of this.timers) {
      clearInterval(timer);
    }
    this.timers.clear();

    const store = await this.load();
    store.state.running = false;

    for (const name of Object.keys(store.state.jobs) as ScheduledJobName[]) {
      store.state.jobs[name].nextRunAt = null;
    }

    await this.save(store);
    return this.toScheduleStatus(store.state);
  }

  public async getScheduleStatus(): Promise<ScheduleStatus> {
    const store = await this.load();
    return this.toScheduleStatus(store.state);
  }

  public async triggerJob(jobName: ScheduledJobName): Promise<JobHistoryEntry> {
    return this.executeJob(jobName);
  }

  public async setJobInterval(jobName: ScheduledJobName, intervalMs: number): Promise<ScheduledJobConfig> {
    if (!Number.isSafeInteger(intervalMs) || intervalMs < 60_000) {
      throw new Error(`intervalMs must be a safe integer >= 60000, got: ${intervalMs}`);
    }

    const store = await this.load();
    const job = store.state.jobs[jobName];
    if (!job) {
      throw new Error(`Unknown job: ${jobName}`);
    }

    job.intervalMs = intervalMs;

    // Restart the timer if scheduler is running
    if (this.timers.has(jobName)) {
      const existingTimer = this.timers.get(jobName);
      if (existingTimer !== undefined) {
        clearInterval(existingTimer);
      }

      const timer = setInterval(() => {
        void this.executeJob(jobName);
      }, intervalMs);

      if (typeof timer === "object" && "unref" in timer) {
        timer.unref();
      }

      this.timers.set(jobName, timer);
    }

    await this.save(store);
    return job;
  }

  public async getJobHistory(jobName: ScheduledJobName): Promise<JobHistoryEntry[]> {
    const store = await this.load();
    return store.state.history.filter((e) => e.jobName === jobName);
  }

  // ---------------------------------------------------------------------------
  // Private
  // ---------------------------------------------------------------------------

  private async executeJob(jobName: ScheduledJobName): Promise<JobHistoryEntry> {
    const startedAt = new Date();
    let status: JobRunStatus = "success";
    let error: string | null = null;

    try {
      if (this.executor) {
        await this.executor(jobName);
      }
    } catch (err) {
      status = "failure";
      error = err instanceof Error ? err.message : String(err);
    }

    const finishedAt = new Date();
    const entry: JobHistoryEntry = {
      runId: `sched_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      jobName,
      status,
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      durationMs: finishedAt.getTime() - startedAt.getTime(),
      error,
    };

    const store = await this.load();
    const job = store.state.jobs[jobName];

    job.lastRunAt = entry.finishedAt;
    if (status === "success") {
      job.successCount += 1;
      job.lastError = null;
    } else {
      job.failureCount += 1;
      job.lastError = error;
    }

    // Compute next run
    job.nextRunAt = new Date(finishedAt.getTime() + job.intervalMs).toISOString();

    store.state.history.push(entry);
    if (store.state.history.length > MAX_HISTORY) {
      store.state.history = store.state.history.slice(-MAX_HISTORY);
    }

    await this.save(store);
    return entry;
  }

  private computeNextRunTime(name: ScheduledJobName, job: ScheduledJobConfig): Date {
    const now = new Date();

    if (job.lastRunAt) {
      const lastRun = new Date(job.lastRunAt).getTime();
      const next = lastRun + job.intervalMs;
      if (next > now.getTime()) {
        return new Date(next);
      }
    }

    // Compute preferred first-run time based on job type
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();

    switch (name) {
      case "quality-scan":
        // Run hourly, start from next full hour
        return new Date(Math.ceil(now.getTime() / ONE_HOUR_MS) * ONE_HOUR_MS);

      case "architecture-sweep":
        // Daily at 6 AM
        {
          const target6AM = todayStart + SIX_AM_OFFSET_MS;
          return new Date(target6AM > now.getTime() ? target6AM : target6AM + 24 * ONE_HOUR_MS);
        }

      case "doc-gardening":
        // Daily at 7 AM
        {
          const target7AM = todayStart + SEVEN_AM_OFFSET_MS;
          return new Date(target7AM > now.getTime() ? target7AM : target7AM + 24 * ONE_HOUR_MS);
        }

      case "gc-sweep":
        // Weekly on Sunday at 3 AM — find next Sunday
        {
          const dayOfWeek = now.getDay(); // 0=Sunday
          const daysUntilSunday = dayOfWeek === 0 ? 7 : 7 - dayOfWeek;
          const nextSunday3AM = todayStart + daysUntilSunday * 24 * ONE_HOUR_MS + 3 * ONE_HOUR_MS;
          return new Date(nextSunday3AM);
        }

      default:
        return new Date(now.getTime() + job.intervalMs);
    }
  }

  private toScheduleStatus(state: SchedulerState): ScheduleStatus {
    return {
      running: state.running,
      startedAt: state.startedAt,
      jobs: Object.values(state.jobs),
    };
  }

  // ---------------------------------------------------------------------------
  // Persistence (atomic write pattern)
  // ---------------------------------------------------------------------------

  private async load(): Promise<SchedulerStoreFile> {
    try {
      const raw = await readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as Partial<SchedulerStoreFile>;
      if (
        !parsed ||
        typeof parsed !== "object" ||
        !parsed.state ||
        typeof parsed.state !== "object"
      ) {
        return structuredClone(EMPTY_STORE);
      }

      // Ensure all job entries exist (forward-compat)
      const state = parsed.state as SchedulerState;
      for (const name of Object.keys(DEFAULT_JOBS) as ScheduledJobName[]) {
        if (!state.jobs[name]) {
          state.jobs[name] = {
            name,
            intervalMs: DEFAULT_JOBS[name].intervalMs,
            enabled: true,
            lastRunAt: null,
            nextRunAt: null,
            successCount: 0,
            failureCount: 0,
            lastError: null,
          };
        }
      }

      if (!Array.isArray(state.history)) {
        state.history = [];
      }

      return { version: parsed.version ?? 1, state };
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        (error as { code?: unknown }).code === "ENOENT"
      ) {
        return structuredClone(EMPTY_STORE);
      }
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to load scheduler state from ${this.filePath}: ${message}`);
    }
  }

  private async save(store: SchedulerStoreFile): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const tempPath = `${this.filePath}.tmp`;
    await writeFile(tempPath, `${JSON.stringify(store, null, 2)}\n`, "utf8");
    await rename(tempPath, this.filePath);
  }
}
