import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from "vitest";
import { SchedulerManager, type ScheduledJobName } from "./schedulerManager.js";
import { tmpStateFile, cleanupTmpFiles } from "./test-helpers.js";

describe("SchedulerManager", () => {
  let mgr: SchedulerManager;

  beforeEach(async () => {
    mgr = new SchedulerManager(tmpStateFile("scheduler"));
  });

  afterEach(async () => {
    await mgr.stopScheduler();
  });

  afterAll(async () => {
    await cleanupTmpFiles();
  });

  it("getScheduleStatus returns not running initially", async () => {
    const status = await mgr.getScheduleStatus();
    expect(status.running).toBe(false);
    expect(status.startedAt).toBeNull();
    expect(status.jobs).toHaveLength(4);
  });

  it("has all 4 default jobs", async () => {
    const status = await mgr.getScheduleStatus();
    const names = status.jobs.map((j) => j.name).sort();
    expect(names).toEqual([
      "architecture-sweep",
      "doc-gardening",
      "gc-sweep",
      "quality-scan",
    ]);
  });

  describe("start/stop lifecycle", () => {
    it("starts the scheduler", async () => {
      const status = await mgr.startScheduler();
      expect(status.running).toBe(true);
      expect(status.startedAt).toBeTruthy();
    });

    it("start is idempotent", async () => {
      const first = await mgr.startScheduler();
      const second = await mgr.startScheduler();
      expect(first.startedAt).toBe(second.startedAt);
    });

    it("stops the scheduler and clears nextRunAt", async () => {
      await mgr.startScheduler();
      const status = await mgr.stopScheduler();
      expect(status.running).toBe(false);
      for (const job of status.jobs) {
        expect(job.nextRunAt).toBeNull();
      }
    });
  });

  describe("triggerJob", () => {
    it("executes a job and records history", async () => {
      const executor = vi.fn().mockResolvedValue(undefined);
      mgr.setExecutor(executor);

      const entry = await mgr.triggerJob("quality-scan");
      expect(entry.jobName).toBe("quality-scan");
      expect(entry.status).toBe("success");
      expect(entry.durationMs).toBeGreaterThanOrEqual(0);
      expect(entry.error).toBeNull();
      expect(executor).toHaveBeenCalledWith("quality-scan");
    });

    it("records failure when executor throws", async () => {
      mgr.setExecutor(async () => {
        throw new Error("scan failed");
      });

      const entry = await mgr.triggerJob("quality-scan");
      expect(entry.status).toBe("failure");
      expect(entry.error).toBe("scan failed");
    });

    it("succeeds without executor (no-op)", async () => {
      const entry = await mgr.triggerJob("quality-scan");
      expect(entry.status).toBe("success");
    });

    it("updates job counters on success", async () => {
      mgr.setExecutor(vi.fn().mockResolvedValue(undefined));
      await mgr.triggerJob("quality-scan");
      await mgr.triggerJob("quality-scan");

      const status = await mgr.getScheduleStatus();
      const job = status.jobs.find((j) => j.name === "quality-scan")!;
      expect(job.successCount).toBe(2);
      expect(job.failureCount).toBe(0);
    });

    it("updates job counters on failure", async () => {
      mgr.setExecutor(async () => {
        throw new Error("boom");
      });
      await mgr.triggerJob("architecture-sweep");

      const status = await mgr.getScheduleStatus();
      const job = status.jobs.find((j) => j.name === "architecture-sweep")!;
      expect(job.failureCount).toBe(1);
      expect(job.lastError).toBe("boom");
    });

    it("clears lastError on subsequent success", async () => {
      mgr.setExecutor(async () => {
        throw new Error("first");
      });
      await mgr.triggerJob("quality-scan");

      mgr.setExecutor(vi.fn().mockResolvedValue(undefined));
      await mgr.triggerJob("quality-scan");

      const status = await mgr.getScheduleStatus();
      const job = status.jobs.find((j) => j.name === "quality-scan")!;
      expect(job.lastError).toBeNull();
    });
  });

  describe("setJobInterval", () => {
    it("updates interval for a job", async () => {
      const job = await mgr.setJobInterval("quality-scan", 120_000);
      expect(job.intervalMs).toBe(120_000);
    });

    it("rejects interval below 60000", async () => {
      await expect(mgr.setJobInterval("quality-scan", 1000)).rejects.toThrow(
        "intervalMs must be a safe integer >= 60000",
      );
    });

    it("rejects non-integer interval", async () => {
      await expect(mgr.setJobInterval("quality-scan", 60000.5)).rejects.toThrow(
        "intervalMs must be a safe integer",
      );
    });
  });

  describe("getJobHistory", () => {
    it("returns history filtered by job name", async () => {
      mgr.setExecutor(vi.fn().mockResolvedValue(undefined));
      await mgr.triggerJob("quality-scan");
      await mgr.triggerJob("architecture-sweep");
      await mgr.triggerJob("quality-scan");

      const history = await mgr.getJobHistory("quality-scan");
      expect(history).toHaveLength(2);
      expect(history.every((h) => h.jobName === "quality-scan")).toBe(true);
    });
  });

  describe("FIFO eviction (MAX_HISTORY=100)", () => {
    it("caps history at 100 entries", async () => {
      mgr.setExecutor(vi.fn().mockResolvedValue(undefined));
      for (let i = 0; i < 110; i++) {
        await mgr.triggerJob("quality-scan");
      }
      const status = await mgr.getScheduleStatus();
      const job = status.jobs.find((j) => j.name === "quality-scan")!;
      expect(job.successCount).toBe(110);

      const history = await mgr.getJobHistory("quality-scan");
      expect(history.length).toBeLessThanOrEqual(100);
    });
  });

  it("persists state across instances", async () => {
    const filePath = tmpStateFile("sched-persist");
    const m1 = new SchedulerManager(filePath);
    m1.setExecutor(vi.fn().mockResolvedValue(undefined));
    await m1.triggerJob("quality-scan");

    const m2 = new SchedulerManager(filePath);
    const status = await m2.getScheduleStatus();
    const job = status.jobs.find((j) => j.name === "quality-scan")!;
    expect(job.successCount).toBe(1);
  });
});
