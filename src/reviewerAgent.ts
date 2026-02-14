/**
 * Reviewer Agent — a separate agent persona for adversarial code review.
 *
 * Unlike PRReviewManager which uses static rule checks, the Reviewer Agent
 * creates a dedicated Codex session with review-focused system prompts.
 * Its job is to find problems, not rubber-stamp.
 *
 * Flow:
 *  1. Author agent finishes writing code
 *  2. ReviewerAgent spawns a separate Codex thread with adversarial review prompts
 *  3. Reviewer produces findings
 *  4. Findings are routed back to the author agent for fixes
 *  5. Repeat (max rounds) until approved or budget exhausted
 */

import type { WorkspaceManager } from "./workspaceManager.js";
import type { SkillsManager } from "./skillsManager.js";
import type { ReviewFinding, ReviewResult, ReviewSeverity } from "./types.js";

export interface ReviewerAgentConfig {
  /** Max rounds of review-then-fix. Default: 3 */
  maxRounds: number;
  /** Severity threshold for blocking merge. Default: "error" */
  blockOnSeverity: ReviewSeverity;
  /** Max diff size (lines) before the reviewer truncates. Default: 8000 */
  maxDiffLines: number;
}

export interface AgentReviewRound {
  round: number;
  findings: ReviewFinding[];
  approved: boolean;
  reviewerOutput: string;
}

export interface AgentReviewResult {
  taskId: string;
  rounds: AgentReviewRound[];
  totalRounds: number;
  finalApproved: boolean;
  timestamp: string;
}

const DEFAULT_CONFIG: ReviewerAgentConfig = {
  maxRounds: 3,
  blockOnSeverity: "error",
  maxDiffLines: 8000,
};

const REVIEWER_SYSTEM_PROMPT = `You are a senior code reviewer for gpc-cres, a multi-tenant commercial real estate platform.

Your job is ADVERSARIAL REVIEW. You are NOT the author's friend. Your goal is to find every problem before this code reaches production.

## Review Priorities (ordered by severity)

1. **Security**: Data leaks between tenants (missing orgId), SQL injection, XSS, hardcoded secrets
2. **Correctness**: Logic errors, race conditions, missing error handling, incorrect types
3. **Architecture**: Import boundary violations, wrong dependency direction, layer leakage
4. **Performance**: N+1 queries, unnecessary re-renders, missing indexes, unbounded data loads
5. **Maintainability**: Dead code, unclear naming, missing tests, overly complex logic

## Output Format

Produce findings as a JSON array:
[
  {
    "file": "path/to/file.ts",
    "line": 42,
    "severity": "error|warning|suggestion",
    "message": "What's wrong",
    "rule": "category-name",
    "remediation": "Exactly how to fix it — specific, actionable, with code examples if helpful"
  }
]

## Rules

- Be specific. "Code looks wrong" is useless. Cite the exact file, line, and what's wrong.
- Every finding MUST include a remediation. The author agent will use your remediation to fix the code.
- severity=error means "this MUST be fixed before merge".
- severity=warning means "this SHOULD be fixed but won't block merge".
- severity=suggestion means "nice to have".
- If the code is good, return an empty array []. Don't manufacture problems.
- Focus on the DIFF, not pre-existing issues in unchanged code.
`;

export class ReviewerAgent {
  private readonly config: ReviewerAgentConfig;

  public constructor(
    private readonly workspaceManager: WorkspaceManager,
    private readonly skillsManager: SkillsManager,
    private readonly startReviewSession: (
      systemPrompt: string,
      userPrompt: string,
      workspacePath: string,
    ) => Promise<{ output: string; threadId: string }>,
    config: Partial<ReviewerAgentConfig> = {},
  ) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Run a full adversarial review cycle.
   *
   * @param taskId - The task to review
   * @param executeFix - Callback to invoke the author agent for fixes
   * @returns Review result with all rounds
   */
  public async runAdversarialReview(
    taskId: string,
    executeFix: (taskId: string, prompt: string) => Promise<void>,
  ): Promise<AgentReviewResult> {
    const rounds: AgentReviewRound[] = [];
    let approved = false;

    for (let round = 1; round <= this.config.maxRounds; round++) {
      // Get current diff
      const diff = await this.getDiff(taskId);
      const diffStat = await this.getDiffStat(taskId);

      if (diff.trim().length === 0) {
        approved = true;
        rounds.push({
          round,
          findings: [],
          approved: true,
          reviewerOutput: "No changes to review.",
        });
        break;
      }

      // Build review prompt
      const reviewPrompt = this.buildReviewPrompt(diff, diffStat, round);

      // Start separate Codex session as the reviewer
      const workspacePath = this.workspaceManager.resolveWorkspacePath(taskId);
      const session = await this.startReviewSession(
        REVIEWER_SYSTEM_PROMPT,
        reviewPrompt,
        workspacePath,
      );

      // Parse reviewer output into findings
      const findings = this.parseReviewerOutput(session.output);

      // Determine approval
      const blockingFindings = findings.filter(
        (f) => this.severityRank(f.severity) >= this.severityRank(this.config.blockOnSeverity),
      );
      approved = blockingFindings.length === 0;

      rounds.push({
        round,
        findings,
        approved,
        reviewerOutput: session.output,
      });

      if (approved) {
        break;
      }

      // Route findings back to author agent for fixes
      if (round < this.config.maxRounds) {
        const fixPrompt = this.buildFixPromptFromFindings(taskId, findings, round);
        await executeFix(taskId, fixPrompt);
      }
    }

    return {
      taskId,
      rounds,
      totalRounds: rounds.length,
      finalApproved: approved,
      timestamp: new Date().toISOString(),
    };
  }

  /**
   * Run a single review pass (no fix loop).
   */
  public async reviewOnce(taskId: string): Promise<AgentReviewRound> {
    const diff = await this.getDiff(taskId);
    const diffStat = await this.getDiffStat(taskId);

    if (diff.trim().length === 0) {
      return { round: 1, findings: [], approved: true, reviewerOutput: "No changes to review." };
    }

    const reviewPrompt = this.buildReviewPrompt(diff, diffStat, 1);
    const workspacePath = this.workspaceManager.resolveWorkspacePath(taskId);
    const session = await this.startReviewSession(
      REVIEWER_SYSTEM_PROMPT,
      reviewPrompt,
      workspacePath,
    );

    const findings = this.parseReviewerOutput(session.output);
    const blockingFindings = findings.filter(
      (f) => this.severityRank(f.severity) >= this.severityRank(this.config.blockOnSeverity),
    );

    return {
      round: 1,
      findings,
      approved: blockingFindings.length === 0,
      reviewerOutput: session.output,
    };
  }

  private buildReviewPrompt(diff: string, diffStat: string, round: number): string {
    const truncatedDiff = diff.split("\n").slice(0, this.config.maxDiffLines).join("\n");

    const sections: string[] = [
      `Review round ${round}/${this.config.maxRounds}.`,
      "",
      "git diff --stat:",
      diffStat,
      "",
      "git diff:",
      truncatedDiff,
      "",
      "Review these changes and produce your findings as a JSON array.",
      "Remember: your remediation messages will be fed directly to the author agent, so be specific and actionable.",
    ];

    return sections.join("\n");
  }

  private buildFixPromptFromFindings(
    taskId: string,
    findings: ReviewFinding[],
    round: number,
  ): string {
    const errors = findings.filter((f) => f.severity === "error");
    const warnings = findings.filter((f) => f.severity === "warning");

    const sections: string[] = [
      `A separate reviewer agent found issues in your code (round ${round}/${this.config.maxRounds}).`,
      `Fix all errors. Fix warnings if possible.`,
      "",
      `Errors (${errors.length}):`,
      ...errors.map((f) => [
        `  - [${f.rule}] ${f.file}${f.line ? `:${f.line}` : ""}: ${f.message}`,
        f.remediation ? `    FIX: ${f.remediation}` : "",
      ].filter(Boolean).join("\n")),
      "",
    ];

    if (warnings.length > 0) {
      sections.push(
        `Warnings (${warnings.length}):`,
        ...warnings.map((f) => [
          `  - [${f.rule}] ${f.file}${f.line ? `:${f.line}` : ""}: ${f.message}`,
          f.remediation ? `    FIX: ${f.remediation}` : "",
        ].filter(Boolean).join("\n")),
      );
    }

    return sections.join("\n");
  }

  private parseReviewerOutput(output: string): ReviewFinding[] {
    // Try to extract JSON array from the output
    const jsonMatch = /\[[\s\S]*?\]/m.exec(output);
    if (!jsonMatch) {
      return [];
    }

    try {
      const parsed = JSON.parse(jsonMatch[0]) as Array<{
        file?: string;
        line?: number;
        severity?: string;
        message?: string;
        rule?: string;
        remediation?: string;
      }>;

      if (!Array.isArray(parsed)) {
        return [];
      }

      return parsed
        .filter((f) => typeof f.file === "string" && typeof f.message === "string")
        .map((f) => ({
          file: f.file!,
          line: typeof f.line === "number" ? f.line : null,
          severity: this.validateSeverity(f.severity ?? "warning"),
          message: f.message!,
          rule: typeof f.rule === "string" ? f.rule : "reviewer-agent",
          remediation: typeof f.remediation === "string" ? f.remediation : null,
        }));
    } catch {
      return [];
    }
  }

  private validateSeverity(raw: string): ReviewSeverity {
    if (raw === "error" || raw === "warning" || raw === "suggestion") {
      return raw;
    }
    return "warning";
  }

  private severityRank(severity: ReviewSeverity): number {
    switch (severity) {
      case "error": return 3;
      case "warning": return 2;
      case "suggestion": return 1;
    }
  }

  private async getDiff(taskId: string): Promise<string> {
    const result = await this.workspaceManager.runInWorkspaceAllowNonZero(taskId, ["git", "diff"]);
    return result.stdout;
  }

  private async getDiffStat(taskId: string): Promise<string> {
    const result = await this.workspaceManager.runInWorkspaceAllowNonZero(taskId, ["git", "diff", "--stat"]);
    return result.stdout.trim();
  }
}
