import { mkdir, readFile, rename, writeFile, stat } from "node:fs/promises";
import { dirname } from "node:path";
import type { WorkspaceManager, CommandResult } from "./workspaceManager.js";

export interface EvalCheck {
  name: string;
  passed: boolean;
  score: number;
  details: string;
}

export interface EvalResult {
  taskId: string;
  timestamp: string;
  overallScore: number;
  passed: boolean;
  checks: EvalCheck[];
}

interface EvalHistoryFile {
  version: number;
  results: EvalResult[];
}

const EMPTY_HISTORY: EvalHistoryFile = { version: 1, results: [] };
const MAX_HISTORY_ENTRIES = 200;

export class EvalManager {
  public constructor(
    private readonly historyPath: string,
    private readonly workspaceManager: WorkspaceManager,
  ) {}

  public async runEval(taskId: string): Promise<EvalResult> {
    const checks: EvalCheck[] = [];

    checks.push(await this.checkVerification(taskId));
    checks.push(await this.checkDiffSize(taskId));
    checks.push(await this.checkNoBlockedFileEdits(taskId));
    checks.push(await this.checkNoNewDependencies(taskId));
    checks.push(await this.checkTestCoverage(taskId));
    checks.push(await this.checkTypeStrictness(taskId));
    checks.push(await this.checkOrgIdCompliance(taskId));

    const passedChecks = checks.filter((c) => c.passed).length;
    const totalWeight = checks.reduce((sum, c) => sum + c.score, 0);
    const maxWeight = checks.length;
    const overallScore = maxWeight > 0 ? totalWeight / maxWeight : 0;

    const result: EvalResult = {
      taskId,
      timestamp: new Date().toISOString(),
      overallScore,
      passed: passedChecks === checks.length && overallScore >= 0.7,
      checks,
    };

    await this.persistResult(result);
    return result;
  }

  public async getHistory(limit = 20): Promise<EvalResult[]> {
    const history = await this.loadHistory();
    return history.results.slice(-limit);
  }

  public async getAverageScore(lastN = 10): Promise<number> {
    const history = await this.loadHistory();
    const recent = history.results.slice(-lastN);
    if (recent.length === 0) {
      return 0;
    }

    return recent.reduce((sum, r) => sum + r.overallScore, 0) / recent.length;
  }

  public async getRegressions(): Promise<string[]> {
    const history = await this.loadHistory();
    if (history.results.length < 2) {
      return [];
    }

    const recent = history.results.slice(-5);
    const regressions: string[] = [];

    for (const result of recent) {
      for (const check of result.checks) {
        if (!check.passed) {
          regressions.push(`[${result.taskId}] ${check.name}: ${check.details}`);
        }
      }
    }

    return regressions;
  }

  private async checkVerification(taskId: string): Promise<EvalCheck> {
    try {
      const result = await this.workspaceManager.runInWorkspaceAllowNonZero(taskId, ["pnpm", "verify"]);
      const passed = result.exitCode === 0;
      return {
        name: "verification",
        passed,
        score: passed ? 1 : 0,
        details: passed ? "pnpm verify passed" : `pnpm verify failed (exit ${result.exitCode})`,
      };
    } catch (error) {
      return {
        name: "verification",
        passed: false,
        score: 0,
        details: `Verification error: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  private async checkDiffSize(taskId: string): Promise<EvalCheck> {
    try {
      const result = await this.workspaceManager.runInWorkspaceAllowNonZero(taskId, ["git", "diff", "--stat"]);
      const lines = result.stdout.split(/\r?\n/).filter((l) => l.trim().length > 0);
      const summaryLine = lines[lines.length - 1] ?? "";

      const insertionsMatch = /(\d+) insertions?/.exec(summaryLine);
      const deletionsMatch = /(\d+) deletions?/.exec(summaryLine);
      const insertions = insertionsMatch ? Number(insertionsMatch[1]) : 0;
      const deletions = deletionsMatch ? Number(deletionsMatch[1]) : 0;
      const totalChanges = insertions + deletions;

      const isMinimal = totalChanges <= 500;
      return {
        name: "diff-size",
        passed: isMinimal,
        score: isMinimal ? 1 : totalChanges <= 1000 ? 0.5 : 0.2,
        details: `${totalChanges} lines changed (${insertions}+, ${deletions}-)`,
      };
    } catch {
      return { name: "diff-size", passed: true, score: 0.5, details: "Unable to compute diff" };
    }
  }

  private async checkNoBlockedFileEdits(taskId: string): Promise<EvalCheck> {
    const BLOCKED = new Set(["package.json", "tsconfig.json", "eslint.config.mjs", "coordinator.ts"]);

    try {
      const result = await this.workspaceManager.runInWorkspaceAllowNonZero(taskId, ["git", "diff", "--name-only"]);
      const changedFiles = result.stdout.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0);
      const rootBlocked = changedFiles.filter((f) => !f.includes("/") && BLOCKED.has(f));
      const passed = rootBlocked.length === 0;

      return {
        name: "no-blocked-files",
        passed,
        score: passed ? 1 : 0,
        details: passed ? "No blocked root files modified" : `Blocked files modified: ${rootBlocked.join(", ")}`,
      };
    } catch {
      return { name: "no-blocked-files", passed: true, score: 0.5, details: "Unable to check" };
    }
  }

  private async checkNoNewDependencies(taskId: string): Promise<EvalCheck> {
    try {
      const result = await this.workspaceManager.runInWorkspaceAllowNonZero(taskId, ["git", "diff", "--name-only"]);
      const changedFiles = result.stdout.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0);
      const packageJsonChanges = changedFiles.filter((f) => f.endsWith("package.json") && f.includes("/"));
      const passed = packageJsonChanges.length === 0;

      return {
        name: "no-new-deps",
        passed,
        score: passed ? 1 : 0.5,
        details: passed ? "No package.json files modified" : `Modified: ${packageJsonChanges.join(", ")}`,
      };
    } catch {
      return { name: "no-new-deps", passed: true, score: 0.5, details: "Unable to check" };
    }
  }

  private async checkTestCoverage(taskId: string): Promise<EvalCheck> {
    try {
      const result = await this.workspaceManager.runInWorkspaceAllowNonZero(taskId, ["git", "diff", "--name-only"]);
      const changedFiles = result.stdout.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0);

      const sourceFiles = changedFiles.filter(
        (f) => f.endsWith(".ts") && !f.endsWith(".test.ts") && !f.endsWith(".spec.ts") && !f.endsWith(".d.ts"),
      );
      const testFiles = changedFiles.filter((f) => f.endsWith(".test.ts") || f.endsWith(".spec.ts"));

      if (sourceFiles.length === 0) {
        return { name: "test-coverage", passed: true, score: 1, details: "No source files changed" };
      }

      const hasTests = testFiles.length > 0;
      return {
        name: "test-coverage",
        passed: hasTests,
        score: hasTests ? 1 : 0.3,
        details: hasTests
          ? `${testFiles.length} test file(s) updated for ${sourceFiles.length} source file(s)`
          : `${sourceFiles.length} source file(s) changed with no test updates`,
      };
    } catch {
      return { name: "test-coverage", passed: true, score: 0.5, details: "Unable to check" };
    }
  }

  private async checkTypeStrictness(taskId: string): Promise<EvalCheck> {
    try {
      const result = await this.workspaceManager.runInWorkspaceAllowNonZero(taskId, ["git", "diff"]);
      const diff = result.stdout;

      const anyCount = (diff.match(/\+.*:\s*any\b/g) ?? []).length;
      const tsIgnoreCount = (diff.match(/\+.*@ts-ignore/g) ?? []).length;
      const tsExpectErrorCount = (diff.match(/\+.*@ts-expect-error/g) ?? []).length;
      const violations = anyCount + tsIgnoreCount + tsExpectErrorCount;

      const passed = violations === 0;
      return {
        name: "type-strictness",
        passed,
        score: passed ? 1 : Math.max(0, 1 - violations * 0.2),
        details: passed
          ? "No type strictness violations"
          : `Found ${anyCount} 'any', ${tsIgnoreCount} '@ts-ignore', ${tsExpectErrorCount} '@ts-expect-error'`,
      };
    } catch {
      return { name: "type-strictness", passed: true, score: 0.5, details: "Unable to check" };
    }
  }

  private async checkOrgIdCompliance(taskId: string): Promise<EvalCheck> {
    try {
      const result = await this.workspaceManager.runInWorkspaceAllowNonZero(taskId, ["git", "diff"]);
      const diff = result.stdout;

      const newQueryLines = diff
        .split(/\r?\n/)
        .filter((l) => l.startsWith("+") && !l.startsWith("+++"))
        .filter((l) => /\.(findMany|findFirst|findUnique|update|delete|count|aggregate)\s*\(/.test(l));

      if (newQueryLines.length === 0) {
        return { name: "orgid-compliance", passed: true, score: 1, details: "No new Prisma queries" };
      }

      const missingOrgId = newQueryLines.filter((l) => !l.includes("orgId"));
      const passed = missingOrgId.length === 0;

      return {
        name: "orgid-compliance",
        passed,
        score: passed ? 1 : 0,
        details: passed
          ? `All ${newQueryLines.length} new queries include orgId`
          : `${missingOrgId.length}/${newQueryLines.length} new queries missing orgId filter`,
      };
    } catch {
      return { name: "orgid-compliance", passed: true, score: 0.5, details: "Unable to check" };
    }
  }

  private async persistResult(result: EvalResult): Promise<void> {
    const history = await this.loadHistory();
    history.results.push(result);

    if (history.results.length > MAX_HISTORY_ENTRIES) {
      history.results = history.results.slice(-MAX_HISTORY_ENTRIES);
    }

    await this.saveHistory(history);
  }

  private async loadHistory(): Promise<EvalHistoryFile> {
    try {
      const raw = await readFile(this.historyPath, "utf8");
      const parsed = JSON.parse(raw) as Partial<EvalHistoryFile>;
      if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.results)) {
        return { ...EMPTY_HISTORY };
      }

      return { version: parsed.version ?? 1, results: parsed.results };
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        (error as { code?: unknown }).code === "ENOENT"
      ) {
        return { ...EMPTY_HISTORY };
      }

      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to load eval history from ${this.historyPath}: ${message}`);
    }
  }

  private async saveHistory(history: EvalHistoryFile): Promise<void> {
    await mkdir(dirname(this.historyPath), { recursive: true });
    const tempPath = `${this.historyPath}.tmp`;
    await writeFile(tempPath, `${JSON.stringify(history, null, 2)}\n`, "utf8");
    await rename(tempPath, this.historyPath);
  }
}
