import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { CIRunRecord, CIStatusSummary } from "./types.js";

interface CIStore {
  version: number;
  runs: CIRunRecord[];
}

const EMPTY_STORE: CIStore = { version: 1, runs: [] };
const MAX_RUNS = 500;

export class CIStatusManager {
  public constructor(private readonly filePath: string) {}

  public async recordRun(record: Omit<CIRunRecord, "runId" | "timestamp">): Promise<CIRunRecord> {
    const store = await this.load();

    const run: CIRunRecord = {
      ...record,
      runId: `ci_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      timestamp: new Date().toISOString(),
    };

    store.runs.push(run);

    if (store.runs.length > MAX_RUNS) {
      store.runs = store.runs.slice(-MAX_RUNS);
    }

    await this.save(store);
    return run;
  }

  public async getStatus(taskId: string): Promise<CIStatusSummary> {
    const store = await this.load();
    const taskRuns = store.runs.filter((r) => r.taskId === taskId);

    const lastRun = taskRuns.length > 0 ? taskRuns[taskRuns.length - 1] as CIRunRecord : null;
    const totalRuns = taskRuns.length;
    const passedRuns = taskRuns.filter((r) => r.passed).length;
    const passRate = totalRuns > 0 ? passedRuns / totalRuns : 0;

    const regressions = this.detectRegressions(taskRuns);

    return {
      taskId,
      lastRun,
      totalRuns,
      passRate,
      recentRegressions: regressions,
    };
  }

  public async getHistory(taskId: string, limit = 20): Promise<CIRunRecord[]> {
    const store = await this.load();
    return store.runs.filter((r) => r.taskId === taskId).slice(-limit);
  }

  public async getAllHistory(limit = 50): Promise<CIRunRecord[]> {
    const store = await this.load();
    return store.runs.slice(-limit);
  }

  public async detectRegressionsForTask(taskId: string): Promise<string[]> {
    const store = await this.load();
    const taskRuns = store.runs.filter((r) => r.taskId === taskId);
    return this.detectRegressions(taskRuns);
  }

  private detectRegressions(runs: CIRunRecord[]): string[] {
    if (runs.length < 2) {
      return [];
    }

    const regressions: string[] = [];
    const recent = runs.slice(-10);

    for (let i = 1; i < recent.length; i++) {
      const prev = recent[i - 1] as CIRunRecord;
      const curr = recent[i] as CIRunRecord;

      if (prev.passed && !curr.passed) {
        regressions.push(
          `Regression at run ${curr.runId}: was passing, now failing (exit ${curr.exitCode}, ${curr.failureCount} failures)`,
        );
      }

      if (!prev.passed && !curr.passed && curr.failureCount > prev.failureCount) {
        regressions.push(
          `Degradation at run ${curr.runId}: failure count increased from ${prev.failureCount} to ${curr.failureCount}`,
        );
      }
    }

    return regressions;
  }

  private async load(): Promise<CIStore> {
    try {
      const raw = await readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as Partial<CIStore>;
      if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.runs)) {
        return { ...EMPTY_STORE };
      }
      return { version: parsed.version ?? 1, runs: parsed.runs };
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        (error as { code?: unknown }).code === "ENOENT"
      ) {
        return { ...EMPTY_STORE };
      }
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to load CI status from ${this.filePath}: ${message}`);
    }
  }

  private async save(store: CIStore): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const tempPath = `${this.filePath}.tmp`;
    await writeFile(tempPath, `${JSON.stringify(store, null, 2)}\n`, "utf8");
    await rename(tempPath, this.filePath);
  }
}
