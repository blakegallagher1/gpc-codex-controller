import { describe, it, expect, beforeEach, afterAll, afterEach } from "vitest";
import { RefactoringManager } from "./refactoringManager.js";
import { tmpStateFile, cleanupTmpFiles } from "./test-helpers.js";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

let tempDirs: string[] = [];

async function makeTempWorkspace(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "refactor-test-"));
  tempDirs.push(dir);
  for (const [name, content] of Object.entries(files)) {
    const filePath = join(dir, name);
    await mkdir(join(filePath, ".."), { recursive: true });
    await writeFile(filePath, content, "utf8");
  }
  return dir;
}

describe("RefactoringManager", () => {
  let mgr: RefactoringManager;

  beforeEach(async () => {
    mgr = new RefactoringManager(tmpStateFile("refactor"));
  });

  afterEach(async () => {
    for (const d of tempDirs.splice(0)) {
      await rm(d, { recursive: true, force: true });
    }
  });

  afterAll(async () => {
    await cleanupTmpFiles();
  });

  it("returns null report when no scan has run", async () => {
    const report = await mgr.getViolationReport();
    expect(report).toBeNull();
  });

  describe("scanForViolations", () => {
    it("scans empty workspace with no violations", async () => {
      const ws = await makeTempWorkspace({
        "src/index.ts": 'console.log("hello");\n',
      });
      const report = await mgr.scanForViolations(ws);
      expect(report.totalFiles).toBe(1);
      expect(report.workspacePath).toBe(ws);
    });

    it("detects duplicate-helper violations", async () => {
      const ws = await makeTempWorkspace({
        "src/a.ts": "export function doStuff() { return 1; }\n",
        "src/b.ts": "export function doStuff() { return 2; }\n",
      });
      const report = await mgr.scanForViolations(ws);
      const dups = report.violations.filter((v) => v.type === "duplicate-helper");
      expect(dups.length).toBeGreaterThanOrEqual(2);
      expect(report.byType["duplicate-helper"]).toBeGreaterThanOrEqual(2);
    });

    it("detects untyped-boundary violations", async () => {
      const ws = await makeTempWorkspace({
        "src/api.ts": "export function handle(req: any): any { return req; }\n",
      });
      const report = await mgr.scanForViolations(ws);
      const untyped = report.violations.filter((v) => v.type === "untyped-boundary");
      expect(untyped.length).toBeGreaterThanOrEqual(1);
    });

    it("skips lines with // allow-any", async () => {
      const ws = await makeTempWorkspace({
        "src/ok.ts": "export const data: any = null; // allow-any\n",
      });
      const report = await mgr.scanForViolations(ws);
      const untyped = report.violations.filter((v) => v.type === "untyped-boundary");
      expect(untyped).toHaveLength(0);
    });

    it("detects import-hygiene (deep relative imports)", async () => {
      const ws = await makeTempWorkspace({
        "src/deep/nested/file.ts": 'import { foo } from "../../../../bar/baz";\nexport const x = 1;\n',
      });
      const report = await mgr.scanForViolations(ws);
      const hygiene = report.violations.filter((v) => v.type === "import-hygiene");
      expect(hygiene.length).toBeGreaterThanOrEqual(1);
      expect(hygiene[0]!.message).toContain("Deep relative import");
    });

    it("detects dead-code (unused exports)", async () => {
      const ws = await makeTempWorkspace({
        "src/utils.ts": "export function unusedUtil() { return 42; }\n",
        "src/main.ts": 'export function main() { return "hello"; }\n',
      });
      const report = await mgr.scanForViolations(ws);
      const dead = report.violations.filter((v) => v.type === "dead-code");
      const unusedNames = dead.map((v) => v.message);
      expect(unusedNames.some((m) => m.includes("unusedUtil"))).toBe(true);
    });

    it("skips .test.ts, .d.ts, node_modules", async () => {
      const ws = await makeTempWorkspace({
        "src/real.ts": "export function a(): any { return 1; }\n",
        "src/real.test.ts": "export function a(): any { return 1; }\n",
        "src/real.d.ts": "export declare const a: any;\n",
        "node_modules/dep/index.ts": "export function a(): any { return 1; }\n",
      });
      const report = await mgr.scanForViolations(ws);
      expect(report.totalFiles).toBe(1);
    });

    it("returns at most 100 violations in response", async () => {
      const files: Record<string, string> = {};
      for (let i = 0; i < 60; i++) {
        files[`src/file${i}.ts`] = `export function helper${i}(x: any): any { return x; }\n`;
      }
      const ws = await makeTempWorkspace(files);
      const report = await mgr.scanForViolations(ws);
      expect(report.violations.length).toBeLessThanOrEqual(100);
      expect(report.violationCount).toBeGreaterThanOrEqual(report.violations.length);
    });
  });

  describe("getViolationReport", () => {
    it("returns persisted report after scan", async () => {
      const ws = await makeTempWorkspace({
        "src/x.ts": "export function foo(): any { return 1; }\n",
      });
      await mgr.scanForViolations(ws);
      const report = await mgr.getViolationReport();
      expect(report).not.toBeNull();
      expect(report!.scannedAt).toBeTruthy();
    });
  });

  describe("generateRefactoringPR", () => {
    it("generates a refactoring prompt for a violation type", async () => {
      const ws = await makeTempWorkspace({
        "src/a.ts": "export function dup() { return 1; }\n",
        "src/b.ts": "export function dup() { return 2; }\n",
      });
      await mgr.scanForViolations(ws);
      const run = await mgr.generateRefactoringPR("duplicate-helper");
      expect(run.runId).toMatch(/^refactor_/);
      expect(run.violationType).toBe("duplicate-helper");
      expect(run.violationCount).toBeGreaterThanOrEqual(2);
      expect(run.prompt).toContain("duplicate");
    });

    it("throws when no violations found for type", async () => {
      const ws = await makeTempWorkspace({
        "src/clean.ts": "export const x = 1;\n",
      });
      await mgr.scanForViolations(ws);
      await expect(mgr.generateRefactoringPR("untyped-boundary")).rejects.toThrow(
        "No violations found for type: untyped-boundary",
      );
    });
  });

  describe("getRefactoringHistory", () => {
    it("returns empty history initially", async () => {
      const history = await mgr.getRefactoringHistory();
      expect(history.runs).toEqual([]);
      expect(history.lastScanAt).toBeNull();
    });

    it("tracks runs after generateRefactoringPR", async () => {
      const ws = await makeTempWorkspace({
        "src/a.ts": "export function dup() { return 1; }\n",
        "src/b.ts": "export function dup() { return 2; }\n",
      });
      await mgr.scanForViolations(ws);
      await mgr.generateRefactoringPR("duplicate-helper");

      const history = await mgr.getRefactoringHistory();
      expect(history.runs).toHaveLength(1);
      expect(history.lastScanAt).toBeTruthy();
    });
  });
});
