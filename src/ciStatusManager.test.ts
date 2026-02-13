import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { CIStatusManager, type CheckSuitePayload } from "./ciStatusManager.js";
import { tmpStateFile, cleanupTmpFiles } from "./test-helpers.js";

const EMPTY_CI = JSON.stringify({ version: 1, runs: [] });

describe("CIStatusManager", () => {
  let mgr: CIStatusManager;

  beforeEach(async () => {
    mgr = new CIStatusManager(tmpStateFile("ci-status", EMPTY_CI));
  });

  afterAll(async () => {
    await cleanupTmpFiles();
  });

  const baseRun = {
    taskId: "task-1",
    passed: true,
    exitCode: 0,
    duration_ms: 1234,
    failureCount: 0,
    failureSummary: [] as string[],
  };

  it("records a run and assigns id + timestamp", async () => {
    const run = await mgr.recordRun(baseRun);
    expect(run.runId).toMatch(/^ci_/);
    expect(run.timestamp).toBeTruthy();
    expect(run.taskId).toBe("task-1");
    expect(run.passed).toBe(true);
  });

  it("getStatus returns summary with pass rate", async () => {
    await mgr.recordRun({ ...baseRun, passed: true });
    await mgr.recordRun({ ...baseRun, passed: true });
    await mgr.recordRun({ ...baseRun, passed: false, exitCode: 1, failureCount: 2 });

    const status = await mgr.getStatus("task-1");
    expect(status.taskId).toBe("task-1");
    expect(status.totalRuns).toBe(3);
    expect(status.passRate).toBeCloseTo(2 / 3);
    expect(status.lastRun?.passed).toBe(false);
  });

  it("getStatus returns zeros for unknown task", async () => {
    const status = await mgr.getStatus("unknown");
    expect(status.totalRuns).toBe(0);
    expect(status.passRate).toBe(0);
    expect(status.lastRun).toBeNull();
  });

  it("getHistory returns runs for specific task", async () => {
    await mgr.recordRun({ ...baseRun, taskId: "a" });
    await mgr.recordRun({ ...baseRun, taskId: "b" });
    await mgr.recordRun({ ...baseRun, taskId: "a" });

    const history = await mgr.getHistory("a");
    expect(history).toHaveLength(2);
    expect(history.every((r) => r.taskId === "a")).toBe(true);
  });

  it("getHistory respects limit", async () => {
    for (let i = 0; i < 5; i++) {
      await mgr.recordRun(baseRun);
    }
    const history = await mgr.getHistory("task-1", 3);
    expect(history).toHaveLength(3);
  });

  it("getAllHistory returns runs across all tasks", async () => {
    await mgr.recordRun({ ...baseRun, taskId: "a" });
    await mgr.recordRun({ ...baseRun, taskId: "b" });
    const all = await mgr.getAllHistory();
    expect(all).toHaveLength(2);
  });

  describe("FIFO eviction at MAX_RUNS (500)", () => {
    it("evicts oldest runs beyond 500", async () => {
      const filePath = tmpStateFile("ci-fifo", EMPTY_CI);
      const m = new CIStatusManager(filePath);
      for (let i = 0; i < 510; i++) {
        await m.recordRun({ ...baseRun, taskId: `task-${i}` });
      }
      const all = await m.getAllHistory(1000);
      expect(all.length).toBeLessThanOrEqual(500);
    });
  });

  describe("recordFromWebhook", () => {
    it("maps success payload correctly", async () => {
      const payload: CheckSuitePayload = {
        check_suite: { id: 999, head_sha: "abc123", status: "completed", conclusion: "success" },
        repository: { full_name: "org/repo" },
      };
      const run = await mgr.recordFromWebhook("task-1", payload);
      expect(run.passed).toBe(true);
      expect(run.ghRunId).toBe(999);
      expect(run.source).toBe("webhook");
      expect(run.failureCount).toBe(0);
    });

    it("maps failure payload correctly", async () => {
      const payload: CheckSuitePayload = {
        check_suite: { id: 100, head_sha: "def456", status: "completed", conclusion: "failure" },
        repository: { full_name: "org/repo" },
      };
      const run = await mgr.recordFromWebhook("task-2", payload);
      expect(run.passed).toBe(false);
      expect(run.failureCount).toBe(1);
      expect(run.failureSummary).toEqual(["check_suite conclusion: failure"]);
    });

    it("treats null conclusion as failure", async () => {
      const payload: CheckSuitePayload = {
        check_suite: { id: 101, head_sha: "ghi789", status: "queued", conclusion: null },
        repository: { full_name: "org/repo" },
      };
      const run = await mgr.recordFromWebhook("task-3", payload);
      expect(run.passed).toBe(false);
    });
  });

  describe("recordFromCI", () => {
    it("records CI run with correct fields", async () => {
      const run = await mgr.recordFromCI("task-1", 42, true, 5000, []);
      expect(run.passed).toBe(true);
      expect(run.ghRunId).toBe(42);
      expect(run.source).toBe("ci");
      expect(run.duration_ms).toBe(5000);
    });

    it("records failure with summary", async () => {
      const run = await mgr.recordFromCI("task-1", 43, false, 3000, ["Test A failed", "Test B failed"]);
      expect(run.passed).toBe(false);
      expect(run.failureCount).toBe(2);
      expect(run.failureSummary).toEqual(["Test A failed", "Test B failed"]);
    });
  });

  describe("regression detection", () => {
    it("detects pass -> fail regression", async () => {
      await mgr.recordRun({ ...baseRun, passed: true });
      await mgr.recordRun({ ...baseRun, passed: false, exitCode: 1, failureCount: 3 });

      const regressions = await mgr.detectRegressionsForTask("task-1");
      expect(regressions.length).toBeGreaterThan(0);
      expect(regressions[0]).toContain("Regression");
    });

    it("detects failure count increase as degradation", async () => {
      await mgr.recordRun({ ...baseRun, passed: false, exitCode: 1, failureCount: 1 });
      await mgr.recordRun({ ...baseRun, passed: false, exitCode: 1, failureCount: 5 });

      const regressions = await mgr.detectRegressionsForTask("task-1");
      expect(regressions.length).toBeGreaterThan(0);
      expect(regressions[0]).toContain("Degradation");
    });

    it("returns empty for single run", async () => {
      await mgr.recordRun(baseRun);
      const regressions = await mgr.detectRegressionsForTask("task-1");
      expect(regressions).toEqual([]);
    });

    it("returns empty for consistent passes", async () => {
      const fresh = new CIStatusManager(tmpStateFile("ci-consistent", EMPTY_CI));
      await fresh.recordRun({ ...baseRun, passed: true });
      await fresh.recordRun({ ...baseRun, passed: true });
      const regressions = await fresh.detectRegressionsForTask("task-1");
      expect(regressions).toEqual([]);
    });
  });

  describe("compareWithPrevious", () => {
    it("detects regression when prev passed and curr failed", async () => {
      await mgr.recordRun({ ...baseRun, passed: true });
      await mgr.recordRun({ ...baseRun, passed: false, exitCode: 1, failureCount: 2 });

      const result = await mgr.compareWithPrevious("task-1");
      expect(result.regressed).toBe(true);
      expect(result.detail).toContain("Regression");
    });

    it("detects degradation when failure count increases", async () => {
      await mgr.recordRun({ ...baseRun, passed: false, exitCode: 1, failureCount: 1 });
      await mgr.recordRun({ ...baseRun, passed: false, exitCode: 1, failureCount: 4 });

      const result = await mgr.compareWithPrevious("task-1");
      expect(result.regressed).toBe(true);
      expect(result.detail).toContain("Degradation");
    });

    it("detects improvement when fail -> pass", async () => {
      await mgr.recordRun({ ...baseRun, passed: false, exitCode: 1, failureCount: 1 });
      await mgr.recordRun({ ...baseRun, passed: true });

      const result = await mgr.compareWithPrevious("task-1");
      expect(result.regressed).toBe(false);
      expect(result.detail).toContain("Improvement");
    });

    it("returns no regression for insufficient runs", async () => {
      const fresh = new CIStatusManager(tmpStateFile("ci-insufficient", EMPTY_CI));
      await fresh.recordRun({ ...baseRun, taskId: "solo" });
      const result = await fresh.compareWithPrevious("solo");
      expect(result.regressed).toBe(false);
      expect(result.detail).toContain("Not enough runs");
    });
  });
});
