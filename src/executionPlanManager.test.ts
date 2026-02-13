import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { ExecutionPlanManager } from "./executionPlanManager.js";
import { tmpStateFile, cleanupTmpFiles } from "./test-helpers.js";

const EMPTY_PLANS = JSON.stringify({ version: 1, plans: {} });

describe("ExecutionPlanManager", () => {
  let mgr: ExecutionPlanManager;

  beforeEach(async () => {
    mgr = new ExecutionPlanManager(tmpStateFile("exec-plan", EMPTY_PLANS));
  });

  afterAll(async () => {
    await cleanupTmpFiles();
  });

  it("creates a plan with 4 phases", async () => {
    const plan = await mgr.createPlan("task-1", "Implement user authentication with OAuth");
    expect(plan.taskId).toBe("task-1");
    expect(plan.phases).toHaveLength(4);
    expect(plan.phases.map((p) => p.name)).toEqual([
      "Analysis",
      "Implementation",
      "Testing",
      "Verification",
    ]);
  });

  it("all phases start as pending with null timestamps", async () => {
    const plan = await mgr.createPlan("task-2", "Add a button");
    for (const phase of plan.phases) {
      expect(phase.status).toBe("pending");
      expect(phase.startedAt).toBeNull();
      expect(phase.completedAt).toBeNull();
    }
  });

  it("generates correct phase dependencies", async () => {
    const plan = await mgr.createPlan("task-3", "Build a widget");
    expect(plan.phases[0]!.dependencies).toEqual([]);
    expect(plan.phases[1]!.dependencies).toEqual([0]);
    expect(plan.phases[2]!.dependencies).toEqual([1]);
    expect(plan.phases[3]!.dependencies).toEqual([2]);
  });

  it("scales estimatedLOC by description complexity", async () => {
    const short = await mgr.createPlan("short", "Fix typo");
    const long = await mgr.createPlan(
      "long",
      "Implement a comprehensive user authentication system with OAuth 2.0 support including refresh tokens session management rate limiting and multi-factor authentication with TOTP and SMS fallback plus admin dashboard integration for user management and audit logging",
    );
    expect(long.phases[1]!.estimatedLOC).toBeGreaterThan(short.phases[1]!.estimatedLOC);
  });

  it("rejects duplicate plan for same taskId", async () => {
    await mgr.createPlan("dup", "First plan");
    await expect(mgr.createPlan("dup", "Second plan")).rejects.toThrow(
      "Execution plan already exists for taskId=dup",
    );
  });

  it("returns null for unknown plan", async () => {
    expect(await mgr.getPlan("nonexistent")).toBeNull();
  });

  describe("updatePhaseStatus", () => {
    it("sets startedAt when moving to in_progress", async () => {
      await mgr.createPlan("up-1", "Do work");
      const plan = await mgr.updatePhaseStatus("up-1", 0, "in_progress");
      expect(plan.phases[0]!.status).toBe("in_progress");
      expect(plan.phases[0]!.startedAt).toBeTruthy();
      expect(plan.phases[0]!.completedAt).toBeNull();
    });

    it("sets completedAt when moving to completed", async () => {
      await mgr.createPlan("up-2", "Do work");
      await mgr.updatePhaseStatus("up-2", 0, "in_progress");
      const plan = await mgr.updatePhaseStatus("up-2", 0, "completed");
      expect(plan.phases[0]!.status).toBe("completed");
      expect(plan.phases[0]!.completedAt).toBeTruthy();
    });

    it("sets completedAt for failed status", async () => {
      await mgr.createPlan("up-3", "Do work");
      const plan = await mgr.updatePhaseStatus("up-3", 0, "failed");
      expect(plan.phases[0]!.completedAt).toBeTruthy();
    });

    it("sets completedAt for skipped status", async () => {
      await mgr.createPlan("up-4", "Do work");
      const plan = await mgr.updatePhaseStatus("up-4", 0, "skipped");
      expect(plan.phases[0]!.completedAt).toBeTruthy();
    });

    it("updates plan.updatedAt on phase change", async () => {
      const original = await mgr.createPlan("up-5", "Do work");
      await new Promise((r) => setTimeout(r, 5));
      const updated = await mgr.updatePhaseStatus("up-5", 0, "in_progress");
      expect(new Date(updated.updatedAt).getTime()).toBeGreaterThanOrEqual(
        new Date(original.updatedAt).getTime(),
      );
    });

    it("throws for out-of-range phase index", async () => {
      await mgr.createPlan("up-6", "Do work");
      await expect(mgr.updatePhaseStatus("up-6", 10, "in_progress")).rejects.toThrow(
        "Phase index 10 out of range",
      );
      await expect(mgr.updatePhaseStatus("up-6", -1, "in_progress")).rejects.toThrow(
        "Phase index -1 out of range",
      );
    });

    it("throws for unknown taskId", async () => {
      await expect(mgr.updatePhaseStatus("ghost", 0, "in_progress")).rejects.toThrow(
        "No execution plan found",
      );
    });
  });

  describe("validatePlan", () => {
    it("validates a freshly created plan as valid", async () => {
      await mgr.createPlan("val-1", "Simple task");
      const result = await mgr.validatePlan("val-1");
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it("detects in_progress phase with incomplete dependency", async () => {
      await mgr.createPlan("val-2", "Simple task");
      await mgr.updatePhaseStatus("val-2", 1, "in_progress");
      const result = await mgr.validatePlan("val-2");
      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.errors[0]).toContain("dependency");
    });

    it("returns error for unknown taskId", async () => {
      const result = await mgr.validatePlan("nonexistent");
      expect(result.valid).toBe(false);
      expect(result.errors[0]).toContain("No plan found");
    });
  });

  it("lists all plans", async () => {
    await mgr.createPlan("list-1", "Plan A");
    await mgr.createPlan("list-2", "Plan B");
    const plans = await mgr.listPlans();
    const taskIds = plans.map((p) => p.taskId);
    expect(taskIds).toContain("list-1");
    expect(taskIds).toContain("list-2");
    expect(plans.length).toBeGreaterThanOrEqual(2);
  });

  it("persists across instances", async () => {
    const filePath = tmpStateFile("plan-persist");
    const m1 = new ExecutionPlanManager(filePath);
    await m1.createPlan("persist", "Persistent plan");

    const m2 = new ExecutionPlanManager(filePath);
    const plan = await m2.getPlan("persist");
    expect(plan?.taskId).toBe("persist");
  });
});
