import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { EvalManager } from "./evalManager.js";
import type { CIStatusManager } from "./ciStatusManager.js";
import type { LinterFramework } from "./linterFramework.js";
import type { ArchitectureValidator } from "./architectureValidator.js";
import type { DocValidator } from "./docValidator.js";
import type { QualityScore, QualityScoreBreakdown } from "./types.js";

interface QualityHistoryFile {
  version: number;
  scores: QualityScore[];
}

const EMPTY_HISTORY: QualityHistoryFile = { version: 1, scores: [] };
const MAX_HISTORY = 200;

export class QualityScoreManager {
  public constructor(
    private readonly historyPath: string,
    private readonly evalManager: EvalManager,
    private readonly ciStatusManager: CIStatusManager,
    private readonly linterFramework: LinterFramework,
    private readonly architectureValidator: ArchitectureValidator,
    private readonly docValidator: DocValidator,
  ) {}

  public async getScore(taskId: string): Promise<QualityScore> {
    const breakdown = await this.computeBreakdown(taskId);

    const weights = { eval: 0.3, ci: 0.25, lint: 0.2, architecture: 0.15, docs: 0.1 };
    const overall =
      breakdown.eval * weights.eval +
      breakdown.ci * weights.ci +
      breakdown.lint * weights.lint +
      breakdown.architecture * weights.architecture +
      breakdown.docs * weights.docs;

    const score: QualityScore = {
      taskId,
      overall: Math.round(overall * 100) / 100,
      breakdown,
      timestamp: new Date().toISOString(),
    };

    await this.persistScore(score);
    return score;
  }

  public async getScoreBreakdown(taskId: string): Promise<QualityScoreBreakdown> {
    return this.computeBreakdown(taskId);
  }

  public async getHistoricalTrend(limit = 20): Promise<QualityScore[]> {
    const history = await this.loadHistory();
    return history.scores.slice(-limit);
  }

  private async computeBreakdown(taskId: string): Promise<QualityScoreBreakdown> {
    const [evalScore, ciScore, lintScore, archScore, docScore] = await Promise.allSettled([
      this.getEvalScore(taskId),
      this.getCIScore(taskId),
      this.getLintScore(taskId),
      this.getArchScore(taskId),
      this.getDocScore(taskId),
    ]);

    return {
      eval: evalScore.status === "fulfilled" ? evalScore.value : 0,
      ci: ciScore.status === "fulfilled" ? ciScore.value : 0,
      lint: lintScore.status === "fulfilled" ? lintScore.value : 0,
      architecture: archScore.status === "fulfilled" ? archScore.value : 0,
      docs: docScore.status === "fulfilled" ? docScore.value : 0,
    };
  }

  private async getEvalScore(taskId: string): Promise<number> {
    try {
      const evalResult = await this.evalManager.runEval(taskId);
      return evalResult.overallScore;
    } catch {
      return 0;
    }
  }

  private async getCIScore(taskId: string): Promise<number> {
    try {
      const status = await this.ciStatusManager.getStatus(taskId);
      return status.passRate;
    } catch {
      return 0;
    }
  }

  private async getLintScore(taskId: string): Promise<number> {
    try {
      const result = await this.linterFramework.runLinter(taskId);
      if (result.errorCount === 0 && result.warningCount === 0) return 1;
      if (result.errorCount === 0) return 0.8;
      return Math.max(0, 1 - result.errorCount * 0.1 - result.warningCount * 0.02);
    } catch {
      return 0;
    }
  }

  private async getArchScore(taskId: string): Promise<number> {
    try {
      const result = await this.architectureValidator.validate(taskId);
      if (result.violations.length === 0) return 1;
      return Math.max(0, 1 - result.violations.length * 0.15);
    } catch {
      return 0;
    }
  }

  private async getDocScore(taskId: string): Promise<number> {
    try {
      const result = await this.docValidator.validate(taskId);
      if (result.issues.length === 0) return 1;
      return Math.max(0, 1 - result.issues.length * 0.1);
    } catch {
      return 0;
    }
  }

  private async persistScore(score: QualityScore): Promise<void> {
    const history = await this.loadHistory();
    history.scores.push(score);

    if (history.scores.length > MAX_HISTORY) {
      history.scores = history.scores.slice(-MAX_HISTORY);
    }

    await this.saveHistory(history);
  }

  private async loadHistory(): Promise<QualityHistoryFile> {
    try {
      const raw = await readFile(this.historyPath, "utf8");
      const parsed = JSON.parse(raw) as Partial<QualityHistoryFile>;
      if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.scores)) {
        return { ...EMPTY_HISTORY };
      }
      return { version: parsed.version ?? 1, scores: parsed.scores };
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
      throw new Error(`Failed to load quality score history: ${message}`);
    }
  }

  private async saveHistory(history: QualityHistoryFile): Promise<void> {
    await mkdir(dirname(this.historyPath), { recursive: true });
    const tempPath = `${this.historyPath}.tmp`;
    await writeFile(tempPath, `${JSON.stringify(history, null, 2)}\n`, "utf8");
    await rename(tempPath, this.historyPath);
  }
}
