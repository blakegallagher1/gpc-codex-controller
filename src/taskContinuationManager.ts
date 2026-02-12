import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { TaskCheckpoint } from "./types.js";

interface CheckpointStore {
  version: number;
  checkpoints: Record<string, TaskCheckpoint[]>;
}

const EMPTY_STORE: CheckpointStore = { version: 1, checkpoints: {} };
const MAX_CHECKPOINTS_PER_TASK = 20;

export class TaskContinuationManager {
  public constructor(private readonly filePath: string) {}

  public async checkpoint(
    taskId: string,
    threadId: string,
    description: string,
  ): Promise<TaskCheckpoint> {
    const store = await this.load();

    if (!store.checkpoints[taskId]) {
      store.checkpoints[taskId] = [];
    }

    const checkpoint: TaskCheckpoint = {
      taskId,
      checkpointId: `ckpt_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      threadId,
      timestamp: new Date().toISOString(),
      description: description.trim(),
    };

    const taskCheckpoints = store.checkpoints[taskId] as TaskCheckpoint[];
    taskCheckpoints.push(checkpoint);

    // Trim old checkpoints
    if (taskCheckpoints.length > MAX_CHECKPOINTS_PER_TASK) {
      store.checkpoints[taskId] = taskCheckpoints.slice(-MAX_CHECKPOINTS_PER_TASK);
    }

    await this.save(store);
    return checkpoint;
  }

  public async getLatestCheckpoint(taskId: string): Promise<TaskCheckpoint | null> {
    const store = await this.load();
    const taskCheckpoints = store.checkpoints[taskId];
    if (!taskCheckpoints || taskCheckpoints.length === 0) {
      return null;
    }

    return taskCheckpoints[taskCheckpoints.length - 1] as TaskCheckpoint;
  }

  public async getCheckpoints(taskId: string): Promise<TaskCheckpoint[]> {
    const store = await this.load();
    return store.checkpoints[taskId] ?? [];
  }

  public async getCheckpointById(taskId: string, checkpointId: string): Promise<TaskCheckpoint | null> {
    const checkpoints = await this.getCheckpoints(taskId);
    return checkpoints.find((c) => c.checkpointId === checkpointId) ?? null;
  }

  public async listAllTasks(): Promise<string[]> {
    const store = await this.load();
    return Object.keys(store.checkpoints);
  }

  private async load(): Promise<CheckpointStore> {
    try {
      const raw = await readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as Partial<CheckpointStore>;
      if (!parsed || typeof parsed !== "object" || !parsed.checkpoints) {
        return { ...EMPTY_STORE };
      }
      return { version: parsed.version ?? 1, checkpoints: parsed.checkpoints };
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
      throw new Error(`Failed to load checkpoints from ${this.filePath}: ${message}`);
    }
  }

  private async save(store: CheckpointStore): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const tempPath = `${this.filePath}.tmp`;
    await writeFile(tempPath, `${JSON.stringify(store, null, 2)}\n`, "utf8");
    await rename(tempPath, this.filePath);
  }
}
