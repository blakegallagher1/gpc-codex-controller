/**
 * PR Automerge Manager — evaluates and executes automatic merges for PRs.
 *
 * Safety-first: NEVER automerges feature PRs without human approval.
 * Uses a configurable policy to decide eligibility.
 *
 * Policy is persisted to `automerge-policy.json` in the state directory.
 * Uses `gh` CLI for all GitHub API interactions.
 */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { WorkspaceManager } from "./workspaceManager.js";
import type { CIStatusManager } from "./ciStatusManager.js";
import type {
  AutomergePolicy,
  AutomergeEvaluation,
  AutomergeCheck,
  AutomergeResult,
} from "./types.js";

const DEFAULT_POLICY: AutomergePolicy = {
  prefixWhitelist: ["refactor:", "chore:", "docs:", "style:", "test:"],
  maxLinesChanged: 500,
  requireCIGreen: true,
  requireReviewApproval: true,
  neverAutomergePatterns: ["feat:", "fix:", "breaking:"],
  updatedAt: new Date().toISOString(),
};

export class PRAutomergeManager {
  private readonly policyPath: string;
  private readonly workspaceManager: WorkspaceManager;
  private readonly ciStatusManager: CIStatusManager;
  private policy: AutomergePolicy | null = null;

  public constructor(
    policyPath: string,
    workspaceManager: WorkspaceManager,
    ciStatusManager: CIStatusManager,
  ) {
    this.policyPath = policyPath;
    this.workspaceManager = workspaceManager;
    this.ciStatusManager = ciStatusManager;
  }

  /**
   * Evaluate whether a PR is eligible for automerge.
   * Returns detailed evaluation with per-check breakdown.
   */
  public async evaluateAutomerge(
    taskId: string,
    prNumber: number,
  ): Promise<AutomergeEvaluation> {
    const policy = await this.getAutomergePolicy();
    const checks: AutomergeCheck[] = [];
    let eligible = true;

    // 1. Get PR details via gh CLI
    const prInfo = await this.getPRInfo(taskId, prNumber);
    if (!prInfo) {
      return {
        eligible: false,
        reason: `Could not fetch PR #${prNumber} details.`,
        prNumber,
        taskId,
        checks: [{ name: "pr-exists", passed: false, detail: "PR not found or inaccessible." }],
      };
    }

    // 2. Check commit prefix against whitelist
    const title = prInfo.title;
    const matchesWhitelist = policy.prefixWhitelist.some((prefix) =>
      title.toLowerCase().startsWith(prefix.toLowerCase()),
    );
    const matchesBlocklist = policy.neverAutomergePatterns.some((pattern) =>
      title.toLowerCase().startsWith(pattern.toLowerCase()),
    );

    if (matchesBlocklist) {
      checks.push({
        name: "prefix-blocklist",
        passed: false,
        detail: `PR title "${title}" matches a blocked prefix. Requires human review.`,
      });
      eligible = false;
    } else {
      checks.push({
        name: "prefix-blocklist",
        passed: true,
        detail: "PR title does not match any blocked prefix.",
      });
    }

    if (matchesWhitelist) {
      checks.push({
        name: "prefix-whitelist",
        passed: true,
        detail: `PR title matches whitelisted prefix.`,
      });
    } else if (!matchesBlocklist) {
      checks.push({
        name: "prefix-whitelist",
        passed: false,
        detail: `PR title "${title}" does not match any whitelisted prefix.`,
      });
      eligible = false;
    }

    // 3. Check diff size
    const linesChanged = prInfo.additions + prInfo.deletions;
    if (linesChanged > policy.maxLinesChanged) {
      checks.push({
        name: "diff-size",
        passed: false,
        detail: `Diff size (${linesChanged} lines) exceeds max (${policy.maxLinesChanged}).`,
      });
      eligible = false;
    } else {
      checks.push({
        name: "diff-size",
        passed: true,
        detail: `Diff size (${linesChanged} lines) within limit (${policy.maxLinesChanged}).`,
      });
    }

    // 4. Check CI status
    if (policy.requireCIGreen) {
      const ciStatus = await this.ciStatusManager.getStatus(taskId);
      const ciGreen = ciStatus.lastRun?.passed === true;

      if (!ciGreen) {
        // Also check GitHub's check runs directly
        const ghChecksPass = await this.checkGitHubChecks(taskId, prNumber);
        if (!ghChecksPass) {
          checks.push({
            name: "ci-green",
            passed: false,
            detail: "CI is not green. Last run failed or no runs recorded.",
          });
          eligible = false;
        } else {
          checks.push({
            name: "ci-green",
            passed: true,
            detail: "GitHub check runs passing.",
          });
        }
      } else {
        checks.push({
          name: "ci-green",
          passed: true,
          detail: `CI is green (pass rate: ${(ciStatus.passRate * 100).toFixed(0)}%).`,
        });
      }
    } else {
      checks.push({
        name: "ci-green",
        passed: true,
        detail: "CI check skipped (not required by policy).",
      });
    }

    // 5. Check review approval
    if (policy.requireReviewApproval) {
      const hasApproval = await this.checkReviewApproval(taskId, prNumber);
      if (!hasApproval) {
        checks.push({
          name: "review-approval",
          passed: false,
          detail: "PR does not have an approved review.",
        });
        eligible = false;
      } else {
        checks.push({
          name: "review-approval",
          passed: true,
          detail: "PR has at least one approved review.",
        });
      }
    } else {
      checks.push({
        name: "review-approval",
        passed: true,
        detail: "Review approval skipped (not required by policy).",
      });
    }

    // 6. Final guard: NEVER automerge if title looks like a feature PR
    if (this.looksLikeFeaturePR(title)) {
      checks.push({
        name: "feature-guard",
        passed: false,
        detail: "PR appears to be a feature PR. Automerge is blocked for safety.",
      });
      eligible = false;
    } else {
      checks.push({
        name: "feature-guard",
        passed: true,
        detail: "PR does not appear to be a feature PR.",
      });
    }

    const failedChecks = checks.filter((c) => !c.passed);
    const reason = eligible
      ? "All checks passed. PR is eligible for automerge."
      : `Automerge blocked: ${failedChecks.map((c) => c.name).join(", ")}`;

    return { eligible, reason, prNumber, taskId, checks };
  }

  /**
   * Execute a merge for a PR.
   * IMPORTANT: This should only be called after evaluateAutomerge returns eligible=true.
   */
  public async executeMerge(
    taskId: string,
    prNumber: number,
    strategy: "squash" | "merge" | "rebase" = "squash",
  ): Promise<AutomergeResult> {
    const strategyFlag = `--${strategy}`;

    const result = await this.workspaceManager.runInWorkspaceAllowNonZero(
      taskId,
      ["gh", "pr", "merge", String(prNumber), "--auto", strategyFlag],
    );

    if (result.exitCode !== 0) {
      return {
        prNumber,
        merged: false,
        strategy,
        error: result.stderr.trim() || "Unknown error during merge.",
      };
    }

    return {
      prNumber,
      merged: true,
      strategy,
      error: null,
    };
  }

  /**
   * Get the current automerge policy.
   */
  public async getAutomergePolicy(): Promise<AutomergePolicy> {
    await this.loadPolicy();
    return this.policy!;
  }

  /**
   * Update the automerge policy.
   */
  public async setAutomergePolicy(policy: Partial<AutomergePolicy>): Promise<AutomergePolicy> {
    await this.loadPolicy();

    if (policy.prefixWhitelist !== undefined) {
      this.policy!.prefixWhitelist = policy.prefixWhitelist;
    }
    if (policy.maxLinesChanged !== undefined) {
      this.policy!.maxLinesChanged = policy.maxLinesChanged;
    }
    if (policy.requireCIGreen !== undefined) {
      this.policy!.requireCIGreen = policy.requireCIGreen;
    }
    if (policy.requireReviewApproval !== undefined) {
      this.policy!.requireReviewApproval = policy.requireReviewApproval;
    }
    if (policy.neverAutomergePatterns !== undefined) {
      this.policy!.neverAutomergePatterns = policy.neverAutomergePatterns;
    }

    this.policy!.updatedAt = new Date().toISOString();
    await this.savePolicy();
    return this.policy!;
  }

  private looksLikeFeaturePR(title: string): boolean {
    const lower = title.toLowerCase();
    // Guard against feature-like patterns that should always require human review
    const featurePatterns = [
      /^feat[\s(:]/,
      /^feature[\s(:]/,
      /^add[\s]/,
      /^implement[\s]/,
      /^new[\s]/,
      /^breaking[\s(:]/,
    ];
    return featurePatterns.some((pattern) => pattern.test(lower));
  }

  private async getPRInfo(
    taskId: string,
    prNumber: number,
  ): Promise<{ title: string; additions: number; deletions: number } | null> {
    const result = await this.workspaceManager.runInWorkspaceAllowNonZero(
      taskId,
      [
        "gh", "pr", "view", String(prNumber),
        "--json", "title,additions,deletions",
        "--jq", "{title: .title, additions: .additions, deletions: .deletions}",
      ],
    );

    if (result.exitCode !== 0) {
      return null;
    }

    try {
      return JSON.parse(result.stdout.trim()) as {
        title: string;
        additions: number;
        deletions: number;
      };
    } catch {
      return null;
    }
  }

  private async checkGitHubChecks(taskId: string, prNumber: number): Promise<boolean> {
    const result = await this.workspaceManager.runInWorkspaceAllowNonZero(
      taskId,
      [
        "gh", "pr", "checks", String(prNumber),
        "--json", "state",
        "--jq", "[.[] | .state] | all(. == \"SUCCESS\")",
      ],
    );

    if (result.exitCode !== 0) {
      return false;
    }

    return result.stdout.trim() === "true";
  }

  private async checkReviewApproval(taskId: string, prNumber: number): Promise<boolean> {
    const result = await this.workspaceManager.runInWorkspaceAllowNonZero(
      taskId,
      [
        "gh", "pr", "view", String(prNumber),
        "--json", "reviews",
        "--jq", "[.reviews[] | select(.state == \"APPROVED\")] | length",
      ],
    );

    if (result.exitCode !== 0) {
      return false;
    }

    const count = parseInt(result.stdout.trim(), 10);
    return Number.isFinite(count) && count > 0;
  }

  private async loadPolicy(): Promise<void> {
    if (this.policy) {
      return;
    }

    try {
      const raw = await readFile(this.policyPath, "utf8");
      this.policy = JSON.parse(raw) as AutomergePolicy;
    } catch {
      this.policy = { ...DEFAULT_POLICY };
    }
  }

  private async savePolicy(): Promise<void> {
    await mkdir(dirname(this.policyPath), { recursive: true });
    const tmpPath = `${this.policyPath}.tmp`;
    await writeFile(tmpPath, `${JSON.stringify(this.policy, null, 2)}\n`, "utf8");
    await rename(tmpPath, this.policyPath);
  }
}
