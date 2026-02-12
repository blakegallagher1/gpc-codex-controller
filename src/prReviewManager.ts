import type { WorkspaceManager } from "./workspaceManager.js";
import type { SkillsManager } from "./skillsManager.js";
import type { ReviewFinding, ReviewResult, ReviewSeverity } from "./types.js";

export class PRReviewManager {
  public constructor(
    private readonly workspaceManager: WorkspaceManager,
    private readonly skillsManager: SkillsManager,
  ) {}

  public async reviewDiff(taskId: string): Promise<ReviewResult> {
    const diff = await this.getDiff(taskId);
    const findings = this.analyzeDiff(diff);

    const errorCount = findings.filter((f) => f.severity === "error").length;
    const warningCount = findings.filter((f) => f.severity === "warning").length;
    const suggestionCount = findings.filter((f) => f.severity === "suggestion").length;

    return {
      taskId,
      timestamp: new Date().toISOString(),
      findings,
      errorCount,
      warningCount,
      suggestionCount,
      approved: errorCount === 0,
    };
  }

  public async generateReviewPrompt(taskId: string): Promise<string> {
    const diff = await this.getDiff(taskId);
    const diffStat = await this.getDiffStat(taskId);
    const skillContext = await this.skillsManager.buildSkillContext(["review"]);

    const sections: string[] = [
      "Task: review the following code changes for quality, correctness, and adherence to project conventions.",
      "",
      "Review criteria:",
      "1. Type safety — no `any`, no `@ts-ignore`, no unsafe casts.",
      "2. orgId compliance — all Prisma queries must include orgId filter.",
      "3. Import boundaries — no cross-package imports violating workspace structure.",
      "4. Error handling — all async operations must handle errors properly.",
      "5. Naming conventions — consistent with existing codebase patterns.",
      "6. Test coverage — source changes should have corresponding test changes.",
      "7. Minimal diff — only changes required for the feature, no unrelated modifications.",
      "",
      "git diff --stat:",
      diffStat,
      "",
      "git diff:",
      diff.slice(0, 8000), // Cap diff size for prompt
    ];

    if (skillContext) {
      sections.push(skillContext);
    }

    sections.push(
      "",
      "Respond with a structured JSON review:",
      '{ "findings": [{ "file": "...", "line": N, "severity": "error|warning|suggestion", "message": "...", "rule": "..." }], "approved": true/false }',
    );

    return sections.join("\n");
  }

  public async runReviewLoop(
    taskId: string,
    maxRounds: number,
    executeFix: (taskId: string, prompt: string) => Promise<void>,
  ): Promise<{ rounds: number; finalReview: ReviewResult }> {
    let round = 0;
    let review = await this.reviewDiff(taskId);

    while (round < maxRounds && !review.approved) {
      round += 1;

      const fixPrompt = this.buildFixPromptFromReview(taskId, review, round, maxRounds);
      await executeFix(taskId, fixPrompt);

      review = await this.reviewDiff(taskId);
    }

    return { rounds: round, finalReview: review };
  }

  private buildFixPromptFromReview(
    taskId: string,
    review: ReviewResult,
    round: number,
    maxRounds: number,
  ): string {
    const errors = review.findings.filter((f) => f.severity === "error");
    const warnings = review.findings.filter((f) => f.severity === "warning");

    const sections: string[] = [
      `Task: fix code review findings for taskId=${taskId} (round ${round}/${maxRounds}).`,
      "",
      `Errors (${errors.length}):`,
      ...errors.map((f) => `  - [${f.rule}] ${f.file}${f.line ? `:${f.line}` : ""}: ${f.message}`),
      "",
      `Warnings (${warnings.length}):`,
      ...warnings.map((f) => `  - [${f.rule}] ${f.file}${f.line ? `:${f.line}` : ""}: ${f.message}`),
      "",
      "Fix all errors first, then address warnings. Apply minimal changes only.",
    ];

    return sections.join("\n");
  }

  private async getDiff(taskId: string): Promise<string> {
    const result = await this.workspaceManager.runInWorkspaceAllowNonZero(taskId, ["git", "diff"]);
    return result.stdout;
  }

  private async getDiffStat(taskId: string): Promise<string> {
    const result = await this.workspaceManager.runInWorkspaceAllowNonZero(taskId, ["git", "diff", "--stat"]);
    return result.stdout.trim();
  }

  private analyzeDiff(diff: string): ReviewFinding[] {
    const findings: ReviewFinding[] = [];
    const lines = diff.split(/\r?\n/);

    let currentFile = "";

    for (const line of lines) {
      const fileMatch = /^\+\+\+ b\/(.+)$/.exec(line);
      if (fileMatch?.[1]) {
        currentFile = fileMatch[1];
        continue;
      }

      if (!line.startsWith("+") || line.startsWith("+++")) {
        continue;
      }

      const content = line.slice(1);

      // Check for `any` type usage
      if (/:\s*any\b/.test(content) && !content.includes("// allow-any")) {
        findings.push(this.finding(currentFile, "error", "Avoid using `any` type — use a specific type or `unknown`.", "type-safety"));
      }

      // Check for @ts-ignore
      if (/@ts-ignore/.test(content)) {
        findings.push(this.finding(currentFile, "error", "Do not use @ts-ignore — use @ts-expect-error with explanation if necessary.", "type-safety"));
      }

      // Check for console.log in non-test files
      if (/console\.log\(/.test(content) && !currentFile.includes(".test.") && !currentFile.includes(".spec.")) {
        findings.push(this.finding(currentFile, "warning", "Remove console.log — use structured logging instead.", "no-console"));
      }

      // Check for Prisma queries missing orgId
      if (/\.(findMany|findFirst|findUnique|update|delete|count|aggregate)\s*\(/.test(content)) {
        if (!content.includes("orgId")) {
          findings.push(this.finding(currentFile, "error", "Prisma query missing orgId filter — all tenant-sensitive queries must include orgId.", "orgid-compliance"));
        }
      }

      // Check for TODO/FIXME left in code
      if (/\bTODO\b|\bFIXME\b|\bHACK\b/.test(content)) {
        findings.push(this.finding(currentFile, "suggestion", "Address TODO/FIXME/HACK comment before merging.", "no-todo"));
      }

      // Check for hardcoded secrets patterns
      if (/(?:password|secret|api_key|token)\s*[:=]\s*["'][^"']{8,}["']/i.test(content)) {
        findings.push(this.finding(currentFile, "error", "Possible hardcoded secret detected — use environment variables.", "no-secrets"));
      }
    }

    return findings;
  }

  private finding(file: string, severity: ReviewSeverity, message: string, rule: string): ReviewFinding {
    return { file, line: null, severity, message, rule };
  }
}
