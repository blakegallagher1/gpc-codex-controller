import { execFile } from "node:child_process";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ReviewVerdict = "APPROVE" | "REQUEST_CHANGES" | "COMMENT";

export interface InlineComment {
  path: string;
  line: number;
  body: string;
}

export interface PostReviewResult {
  prNumber: number;
  reviewId: number;
  verdict: ReviewVerdict;
  commentsPosted: number;
  htmlUrl: string;
}

export interface PostSummaryResult {
  prNumber: number;
  commentId: number;
  htmlUrl: string;
}

export interface ReviewStatus {
  prNumber: number;
  state: string;
  reviewCount: number;
  latestReviewVerdict: string | null;
  latestReviewSubmittedAt: string | null;
}

export interface ReviewFindingInput {
  file: string;
  line: number | null;
  severity: "error" | "warning" | "suggestion";
  message: string;
  rule: string;
}

export interface QualityScoreInput {
  overall: number;
  breakdown: {
    eval: number;
    ci: number;
    lint: number;
    architecture: number;
    docs: number;
  };
}

export interface EvalResultInput {
  passed: boolean;
  overallScore: number;
  checkCount: number;
  passedCount: number;
}

// ---------------------------------------------------------------------------
// GitHubReviewPoster
// ---------------------------------------------------------------------------

export class GitHubReviewPoster {
  /**
   * Post a PR review with inline comments mapped to the diff.
   */
  public async postReview(
    prNumber: number,
    findings: ReviewFindingInput[],
    verdict: ReviewVerdict,
  ): Promise<PostReviewResult> {
    const repo = await this.getRepo();
    const diffPositions = await this.parseDiffPositions(prNumber);

    // Build inline comments only for findings that can be mapped to the diff
    const comments: InlineComment[] = [];
    for (const finding of findings) {
      if (!finding.line) continue;

      const diffKey = `${finding.file}:${finding.line}`;
      const position = diffPositions.get(diffKey);

      if (position !== undefined) {
        comments.push({
          path: finding.file,
          line: finding.line,
          body: this.formatInlineComment(finding),
        });
      } else {
        // Still try to post at the file level if we know the line
        comments.push({
          path: finding.file,
          line: finding.line,
          body: this.formatInlineComment(finding),
        });
      }
    }

    // Build review body summary
    const errorCount = findings.filter((f) => f.severity === "error").length;
    const warningCount = findings.filter((f) => f.severity === "warning").length;
    const suggestionCount = findings.filter((f) => f.severity === "suggestion").length;

    const reviewBody = [
      `## Automated Review`,
      "",
      `| Severity | Count |`,
      `|----------|-------|`,
      `| Errors   | ${errorCount} |`,
      `| Warnings | ${warningCount} |`,
      `| Suggestions | ${suggestionCount} |`,
      "",
      `**Verdict:** ${verdict}`,
    ].join("\n");

    // Create the review using gh API
    const reviewPayload: Record<string, unknown> = {
      event: verdict,
      body: reviewBody,
    };

    // Only include comments if there are mappable ones
    if (comments.length > 0) {
      reviewPayload.comments = comments.map((c) => ({
        path: c.path,
        line: c.line,
        body: c.body,
      }));
    }

    const result = await this.ghApi(
      "POST",
      `/repos/${repo}/pulls/${prNumber}/reviews`,
      reviewPayload,
    );

    const parsed = JSON.parse(result) as {
      id?: number;
      html_url?: string;
    };

    return {
      prNumber,
      reviewId: parsed.id ?? 0,
      verdict,
      commentsPosted: comments.length,
      htmlUrl: parsed.html_url ?? "",
    };
  }

  /**
   * Post a summary comment with quality score and eval results.
   */
  public async postSummaryComment(
    prNumber: number,
    qualityScore: QualityScoreInput,
    evalResult: EvalResultInput,
  ): Promise<PostSummaryResult> {
    const repo = await this.getRepo();

    const gradeEmoji = qualityScore.overall >= 0.9
      ? "A"
      : qualityScore.overall >= 0.8
        ? "B"
        : qualityScore.overall >= 0.7
          ? "C"
          : qualityScore.overall >= 0.6
            ? "D"
            : "F";

    const body = [
      `## Quality Report`,
      "",
      `**Overall Score:** ${(qualityScore.overall * 100).toFixed(0)}% (Grade: ${gradeEmoji})`,
      "",
      `### Score Breakdown`,
      "",
      `| Category | Score |`,
      `|----------|-------|`,
      `| Eval | ${(qualityScore.breakdown.eval * 100).toFixed(0)}% |`,
      `| CI | ${(qualityScore.breakdown.ci * 100).toFixed(0)}% |`,
      `| Lint | ${(qualityScore.breakdown.lint * 100).toFixed(0)}% |`,
      `| Architecture | ${(qualityScore.breakdown.architecture * 100).toFixed(0)}% |`,
      `| Docs | ${(qualityScore.breakdown.docs * 100).toFixed(0)}% |`,
      "",
      `### Eval Results`,
      "",
      `- **Passed:** ${evalResult.passed ? "Yes" : "No"}`,
      `- **Score:** ${(evalResult.overallScore * 100).toFixed(0)}%`,
      `- **Checks:** ${evalResult.passedCount}/${evalResult.checkCount} passed`,
      "",
      `---`,
      `*Generated by gpc-codex-controller*`,
    ].join("\n");

    const result = await this.ghApi(
      "POST",
      `/repos/${repo}/issues/${prNumber}/comments`,
      { body },
    );

    const parsed = JSON.parse(result) as {
      id?: number;
      html_url?: string;
    };

    return {
      prNumber,
      commentId: parsed.id ?? 0,
      htmlUrl: parsed.html_url ?? "",
    };
  }

  /**
   * Check the current review state of a PR.
   */
  public async getReviewStatus(prNumber: number): Promise<ReviewStatus> {
    const repo = await this.getRepo();

    const result = await this.ghApi(
      "GET",
      `/repos/${repo}/pulls/${prNumber}/reviews`,
    );

    const reviews = JSON.parse(result) as Array<{
      id: number;
      state: string;
      submitted_at: string;
    }>;

    const latestReview = reviews.length > 0
      ? reviews[reviews.length - 1]
      : undefined;

    return {
      prNumber,
      state: latestReview?.state ?? "PENDING",
      reviewCount: reviews.length,
      latestReviewVerdict: latestReview?.state ?? null,
      latestReviewSubmittedAt: latestReview?.submitted_at ?? null,
    };
  }

  // ---------------------------------------------------------------------------
  // Diff parsing
  // ---------------------------------------------------------------------------

  /**
   * Parse `gh pr diff` output to build a map of file:line -> diff position.
   */
  private async parseDiffPositions(prNumber: number): Promise<Map<string, number>> {
    const positions = new Map<string, number>();

    try {
      const diffOutput = await this.execGh(["pr", "diff", String(prNumber)]);
      const lines = diffOutput.split(/\r?\n/);

      let currentFile = "";
      let lineInNewFile = 0;
      let diffPosition = 0;

      for (const line of lines) {
        // Match diff file header
        const fileMatch = /^\+\+\+ b\/(.+)$/.exec(line);
        if (fileMatch?.[1]) {
          currentFile = fileMatch[1];
          diffPosition = 0;
          lineInNewFile = 0;
          continue;
        }

        // Match hunk header
        const hunkMatch = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
        if (hunkMatch?.[1]) {
          lineInNewFile = parseInt(hunkMatch[1], 10) - 1;
          diffPosition += 1;
          continue;
        }

        // Skip file headers
        if (line.startsWith("---") || line.startsWith("diff ")) {
          continue;
        }

        diffPosition += 1;

        if (line.startsWith("+")) {
          lineInNewFile += 1;
          positions.set(`${currentFile}:${lineInNewFile}`, diffPosition);
        } else if (line.startsWith("-")) {
          // Removed line doesn't increment new file line number
        } else {
          // Context line
          lineInNewFile += 1;
          positions.set(`${currentFile}:${lineInNewFile}`, diffPosition);
        }
      }
    } catch {
      // Diff parsing failure is non-critical
    }

    return positions;
  }

  // ---------------------------------------------------------------------------
  // Formatting
  // ---------------------------------------------------------------------------

  private formatInlineComment(finding: ReviewFindingInput): string {
    const severityLabel = finding.severity === "error"
      ? "**ERROR**"
      : finding.severity === "warning"
        ? "**WARNING**"
        : "*suggestion*";

    return `${severityLabel} [${finding.rule}]: ${finding.message}`;
  }

  // ---------------------------------------------------------------------------
  // GitHub CLI helpers
  // ---------------------------------------------------------------------------

  private async getRepo(): Promise<string> {
    const result = await this.execGh([
      "repo",
      "view",
      "--json",
      "nameWithOwner",
      "-q",
      ".nameWithOwner",
    ]);

    const repo = result.trim();
    if (!repo || !repo.includes("/")) {
      throw new Error("Unable to determine repository from gh CLI");
    }

    return repo;
  }

  private async ghApi(
    method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
    endpoint: string,
    body?: Record<string, unknown>,
  ): Promise<string> {
    const args = ["api", endpoint, "--method", method];

    if (body) {
      args.push("--input", "-");
      return this.execGhWithStdin(args, JSON.stringify(body));
    }

    return this.execGh(args);
  }

  private execGh(args: string[]): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      execFile("gh", args, { maxBuffer: 10 * 1024 * 1024 }, (error, stdout, stderr) => {
        if (error) {
          reject(new Error(`gh ${args[0]} failed: ${stderr || error.message}`));
          return;
        }
        resolve(stdout);
      });
    });
  }

  private execGhWithStdin(args: string[], stdin: string): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const proc = execFile("gh", args, { maxBuffer: 10 * 1024 * 1024 }, (error, stdout, stderr) => {
        if (error) {
          reject(new Error(`gh ${args[0]} failed: ${stderr || error.message}`));
          return;
        }
        resolve(stdout);
      });

      if (proc.stdin) {
        proc.stdin.write(stdin);
        proc.stdin.end();
      }
    });
  }
}
