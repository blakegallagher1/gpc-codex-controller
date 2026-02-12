import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { TaskRecord, TaskStatus } from "./types.js";

interface TaskRegistryFile {
  tasks: Record<string, TaskRecord>;
}

const EMPTY_REGISTRY: TaskRegistryFile = { tasks: {} };

const VALID_TRANSITIONS: Record<TaskStatus, ReadonlySet<TaskStatus>> = {
  created: new Set(["mutating", "verifying", "fixing", "ready", "failed"]),
  mutating: new Set(["verifying", "fixing", "ready", "failed"]),
  verifying: new Set(["mutating", "fixing", "ready", "failed"]),
  fixing: new Set(["mutating", "verifying", "ready", "failed"]),
  ready: new Set(["mutating", "pr_opened", "failed"]),
  pr_opened: new Set(["failed"]),
  failed: new Set(["ready", "mutating", "created"]),
};

export class TaskRegistry {
  public constructor(private readonly filePath: string) {}

  public async createTask(task: TaskRecord): Promise<TaskRecord> {
    const registry = await this.load();

    if (registry.tasks[task.taskId]) {
      throw new Error(`Task already exists: ${task.taskId}`);
    }

    const usedBranches = new Set(Object.values(registry.tasks).map((record) => record.branchName));
    if (usedBranches.has(task.branchName)) {
      throw new Error(`Branch name already used by another task: ${task.branchName}`);
    }

    registry.tasks[task.taskId] = task;
    await this.save(registry);
    return task;
  }

  public async getTask(taskId: string): Promise<TaskRecord | null> {
    const registry = await this.load();
    return registry.tasks[taskId] ?? null;
  }

  public async updateTaskStatus(taskId: string, status: TaskStatus): Promise<TaskRecord> {
    const registry = await this.load();
    const task = registry.tasks[taskId];
    if (!task) {
      throw new Error(`Task not found: ${taskId}`);
    }

    if (task.status !== status) {
      const allowed = VALID_TRANSITIONS[task.status];
      if (!allowed.has(status)) {
        throw new Error(`Invalid task status transition: ${task.status} -> ${status}`);
      }
    }

    const updated: TaskRecord = {
      ...task,
      status,
    };
    registry.tasks[taskId] = updated;
    await this.save(registry);
    return updated;
  }

  private async load(): Promise<TaskRegistryFile> {
    try {
      const raw = await readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as Partial<TaskRegistryFile>;
      if (!parsed || typeof parsed !== "object" || !parsed.tasks || typeof parsed.tasks !== "object") {
        return { ...EMPTY_REGISTRY };
      }

      const normalizedTasks: Record<string, TaskRecord> = {};
      for (const key of Object.keys(parsed.tasks).sort()) {
        const value = parsed.tasks[key];
        if (typeof value === "object" && value !== null) {
          normalizedTasks[key] = value as TaskRecord;
        }
      }

      return { tasks: normalizedTasks };
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        (error as { code?: unknown }).code === "ENOENT"
      ) {
        return { ...EMPTY_REGISTRY };
      }

      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to load task registry from ${this.filePath}: ${message}`);
    }
  }

  private async save(registry: TaskRegistryFile): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });

    const sortedTaskIds = Object.keys(registry.tasks).sort();
    const sortedTasks: Record<string, TaskRecord> = {};
    for (const taskId of sortedTaskIds) {
      sortedTasks[taskId] = registry.tasks[taskId] as TaskRecord;
    }

    const stable: TaskRegistryFile = { tasks: sortedTasks };
    const tempPath = `${this.filePath}.tmp`;
    await writeFile(tempPath, `${JSON.stringify(stable, null, 2)}\n`, "utf8");
    await rename(tempPath, this.filePath);
  }
}
