import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { tmpStateFile, cleanupTmpFiles } from "./test-helpers.js";

// Mock execSync so we don't actually call gh CLI
vi.mock("node:child_process", () => ({
  execSync: vi.fn().mockReturnValue(Buffer.from("")),
}));

// Dynamically import after mock is in place
const { IssueTriageManager } = await import("./issueTriageManager.js");
type TriageInput = import("./issueTriageManager.js").TriageInput;

function mockController() {
  return {
    createTask: vi.fn().mockResolvedValue({
      taskId: "mock-task",
      workspacePath: "/tmp/ws",
      branchName: "mock-branch",
      threadId: "mock-thread",
      createdAt: new Date().toISOString(),
      status: "created",
    }),
    startAutonomousRun: vi.fn().mockResolvedValue({
      runId: "mock-run",
      prUrl: null,
    }),
  } as any;
}

function makeInput(overrides: Partial<TriageInput> = {}): TriageInput {
  return {
    issueNumber: 1,
    title: "Test issue",
    body: "Some description",
    repo: "org/repo",
    author: "testuser",
    url: "https://github.com/org/repo/issues/1",
    existingLabels: [],
    ...overrides,
  };
}

const EMPTY_TRIAGE = JSON.stringify({ version: 1, records: [] });

describe("IssueTriageManager", () => {
  let mgr: InstanceType<typeof IssueTriageManager>;
  let controller: ReturnType<typeof mockController>;

  beforeEach(async () => {
    controller = mockController();
    mgr = new IssueTriageManager(tmpStateFile("triage", EMPTY_TRIAGE), controller);
  });

  afterAll(async () => {
    await cleanupTmpFiles();
  });

  describe("classification logic", () => {
    it("classifies as bug when bug keywords in body", async () => {
      const result = await mgr.triageIssue(makeInput({
        title: "Something broken",
        body: "There is an error and crash happening. The app fails to start.",
      }));
      expect(result.classification).toBe("bug");
    });

    it("classifies as feature when feature keywords present", async () => {
      const result = await mgr.triageIssue(makeInput({
        title: "Add dark mode support",
        body: "We need a new feature to implement dark mode. Please add this ability.",
      }));
      expect(result.classification).toBe("feature");
    });

    it("classifies as refactor when refactor keywords present", async () => {
      const result = await mgr.triageIssue(makeInput({
        title: "Cleanup technical debt",
        body: "Refactor the auth module. Simplify and reorganize the code.",
      }));
      expect(result.classification).toBe("refactor");
    });

    it("classifies as unknown when no keywords match", async () => {
      const result = await mgr.triageIssue(makeInput({
        title: "Hello world",
        body: "Just saying hi.",
      }));
      expect(result.classification).toBe("unknown");
    });

    it("title prefix [bug] gives +3 bonus to bug score", async () => {
      const result = await mgr.triageIssue(makeInput({
        title: "[bug] minor thing",
        body: "",
      }));
      expect(result.classification).toBe("bug");
    });

    it("title prefix feat: gives +3 bonus to feature score", async () => {
      const result = await mgr.triageIssue(makeInput({
        title: "feat: something",
        body: "",
      }));
      expect(result.classification).toBe("feature");
    });

    it("title prefix refactor: gives +3 bonus to refactor score", async () => {
      const result = await mgr.triageIssue(makeInput({
        title: "refactor: something",
        body: "",
      }));
      expect(result.classification).toBe("refactor");
    });
  });

  describe("complexity estimation", () => {
    it("estimates small for short issues", async () => {
      const result = await mgr.triageIssue(makeInput({
        title: "Fix typo",
        body: "Line 5.",
      }));
      expect(result.complexity).toBe("small");
    });

    it("estimates medium for medium-length issues", async () => {
      const result = await mgr.triageIssue(makeInput({
        title: "Bug in login",
        body: "x".repeat(500),
      }));
      expect(result.complexity).toBe("medium");
    });

    it("estimates large for long issues", async () => {
      const result = await mgr.triageIssue(makeInput({
        title: "Major change",
        body: "x".repeat(2000),
      }));
      expect(result.complexity).toBe("large");
    });

    it("estimates large when large keywords present", async () => {
      const result = await mgr.triageIssue(makeInput({
        title: "Migration plan",
        body: "This requires a complete rewrite and architecture redesign.",
      }));
      expect(result.complexity).toBe("large");
    });
  });

  describe("label determination", () => {
    it("applies classification, complexity, and auto-triaged labels", async () => {
      const result = await mgr.triageIssue(makeInput({
        title: "[bug] crash",
        body: "App crashes with error",
      }));
      expect(result.labelsApplied).toContain("bug");
      expect(result.labelsApplied.some((l) => l.startsWith("complexity:"))).toBe(true);
      expect(result.labelsApplied).toContain("auto-triaged");
    });

    it("uses needs-triage for unknown classification", async () => {
      const result = await mgr.triageIssue(makeInput({
        title: "Hello",
        body: "World",
      }));
      expect(result.labelsApplied).toContain("needs-triage");
    });

    it("skips labels already present", async () => {
      const result = await mgr.triageIssue(makeInput({
        title: "[bug] crash",
        body: "error",
        existingLabels: ["bug", "auto-triaged"],
      }));
      expect(result.labelsApplied.filter((l) => l === "bug")).toHaveLength(0);
      expect(result.labelsApplied.filter((l) => l === "auto-triaged")).toHaveLength(0);
    });
  });

  describe("persistence", () => {
    it("triage record is persisted and retrievable", async () => {
      const input = makeInput({ issueNumber: 42 });
      await mgr.triageIssue(input);

      const record = await mgr.getTriageRecord(42, "org/repo");
      expect(record).not.toBeNull();
      expect(record!.issueNumber).toBe(42);
      expect(record!.repo).toBe("org/repo");
    });

    it("returns null for unknown record", async () => {
      const record = await mgr.getTriageRecord(999, "org/repo");
      expect(record).toBeNull();
    });

    it("getTriageHistory returns records", async () => {
      const freshCtrl = mockController();
      const fresh = new IssueTriageManager(tmpStateFile("triage-hist", EMPTY_TRIAGE), freshCtrl);
      await fresh.triageIssue(makeInput({ issueNumber: 1 }));
      await fresh.triageIssue(makeInput({ issueNumber: 2 }));

      const history = await fresh.getTriageHistory();
      expect(history).toHaveLength(2);
    });

    it("getTriageHistory respects limit", async () => {
      for (let i = 0; i < 5; i++) {
        await mgr.triageIssue(makeInput({ issueNumber: i + 1, title: `Issue ${i}` }));
      }
      const history = await mgr.getTriageHistory(2);
      expect(history).toHaveLength(2);
    });
  });

  describe("updateProgress", () => {
    it("updates prUrl", async () => {
      await mgr.triageIssue(makeInput({ issueNumber: 10 }));
      const record = await mgr.updateProgress(10, "org/repo", {
        prUrl: "https://github.com/org/repo/pull/99",
      });
      expect(record!.prUrl).toBe("https://github.com/org/repo/pull/99");
    });

    it("returns null for unknown issue", async () => {
      const result = await mgr.updateProgress(999, "org/repo", { prUrl: "x" });
      expect(result).toBeNull();
    });

    it("closes issue when prMerged is set", async () => {
      const { execSync } = await import("node:child_process");
      await mgr.triageIssue(makeInput({ issueNumber: 20 }));
      await mgr.updateProgress(20, "org/repo", { prMerged: true });

      const record = await mgr.getTriageRecord(20, "org/repo");
      expect(record!.prMerged).toBe(true);
      expect(record!.issueClosed).toBe(true);
      expect(execSync).toHaveBeenCalledWith(
        expect.stringContaining("gh issue close"),
        expect.any(Object),
      );
    });
  });

  describe("FIFO eviction (MAX_RECORDS=500)", () => {
    it("caps records at 500", async () => {
      for (let i = 0; i < 510; i++) {
        await mgr.triageIssue(makeInput({ issueNumber: i + 1, title: `Issue ${i}` }));
      }
      const history = await mgr.getTriageHistory(1000);
      expect(history.length).toBeLessThanOrEqual(500);
    });
  });
});
