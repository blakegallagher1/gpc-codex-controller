import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { TaskRegistry } from "./taskRegistry.js";
import type { TaskRecord, TaskStatus } from "./types.js";
import { tmpStateFile, cleanupTmpFiles } from "./test-helpers.js";

function makeTask(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    taskId: `task-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    workspacePath: "/tmp/workspace",
    branchName: `branch-${Math.random().toString(36).slice(2, 8)}`,
    threadId: "thread-1",
    createdAt: new Date().toISOString(),
    status: "created",
    ...overrides,
  };
}

const EMPTY_REG = JSON.stringify({ tasks: {} });

describe("TaskRegistry", () => {
  let registry: TaskRegistry;

  beforeEach(async () => {
    registry = new TaskRegistry(tmpStateFile("task-reg", EMPTY_REG));
  });

  afterAll(async () => {
    await cleanupTmpFiles();
  });

  it("creates and retrieves a task", async () => {
    const task = makeTask({ taskId: "t-1" });
    const created = await registry.createTask(task);
    expect(created.taskId).toBe("t-1");

    const fetched = await registry.getTask("t-1");
    expect(fetched).toEqual(created);
  });

  it("returns null for unknown task", async () => {
    const result = await registry.getTask("nonexistent");
    expect(result).toBeNull();
  });

  it("rejects duplicate taskId", async () => {
    const task = makeTask({ taskId: "dup" });
    await registry.createTask(task);
    await expect(registry.createTask(task)).rejects.toThrow("Task already exists: dup");
  });

  it("rejects duplicate branch name", async () => {
    await registry.createTask(makeTask({ taskId: "a", branchName: "main-branch" }));
    await expect(
      registry.createTask(makeTask({ taskId: "b", branchName: "main-branch" })),
    ).rejects.toThrow("Branch name already used");
  });

  it("lists all tasks", async () => {
    await registry.createTask(makeTask({ taskId: "list-t1" }));
    await registry.createTask(makeTask({ taskId: "list-t2" }));
    const all = await registry.listTasks();
    const ids = all.map((t) => t.taskId);
    expect(ids).toContain("list-t1");
    expect(ids).toContain("list-t2");
    expect(all.length).toBeGreaterThanOrEqual(2);
  });

  describe("status transitions", () => {
    const validPaths: [TaskStatus, TaskStatus][] = [
      ["created", "mutating"],
      ["created", "failed"],
      ["mutating", "verifying"],
      ["verifying", "ready"],
      ["ready", "pr_opened"],
      ["failed", "created"],
      ["failed", "ready"],
    ];

    for (const [from, to] of validPaths) {
      it(`allows ${from} -> ${to}`, async () => {
        const task = makeTask({ taskId: `trans-${from}-${to}`, status: from });
        await registry.createTask(task);
        const updated = await registry.updateTaskStatus(task.taskId, to);
        expect(updated.status).toBe(to);
      });
    }

    it("allows no-op transition (same status)", async () => {
      const task = makeTask({ taskId: "noop" });
      await registry.createTask(task);
      const updated = await registry.updateTaskStatus("noop", "created");
      expect(updated.status).toBe("created");
    });

    const invalidPaths: [TaskStatus, TaskStatus][] = [
      ["created", "pr_opened"],
      ["pr_opened", "created"],
      ["pr_opened", "ready"],
    ];

    for (const [from, to] of invalidPaths) {
      it(`rejects ${from} -> ${to}`, async () => {
        const task = makeTask({ taskId: `inv-${from}-${to}`, status: from });
        await registry.createTask(task);
        await expect(registry.updateTaskStatus(task.taskId, to)).rejects.toThrow(
          "Invalid task status transition",
        );
      });
    }

    it("throws when task not found", async () => {
      await expect(registry.updateTaskStatus("ghost", "mutating")).rejects.toThrow(
        "Task not found: ghost",
      );
    });
  });

  it("persists data across instances", async () => {
    const filePath = tmpStateFile("persist");
    const r1 = new TaskRegistry(filePath);
    await r1.createTask(makeTask({ taskId: "persist-1" }));

    const r2 = new TaskRegistry(filePath);
    const fetched = await r2.getTask("persist-1");
    expect(fetched?.taskId).toBe("persist-1");
  });
});
