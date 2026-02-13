/**
 * CI Integration Manager — triggers and polls GitHub Actions workflows.
 *
 * Uses the `gh` CLI for all GitHub API interactions, consistent with
 * the rest of the codebase (no raw fetch to GitHub API).
 *
 * Flow:
 *   1. triggerCI(taskId, sha)   → starts a GH Actions workflow, returns run info
 *   2. pollCIStatus(ghRunId)    → polls until the run completes or times out
 *   3. getCIFailureLogs(ghRunId) → extracts failure details from failed jobs
 *
 * Results are fed back into CIStatusManager for tracking and regression detection.
 */

import type { WorkspaceManager } from "./workspaceManager.js";
import type { CIStatusManager } from "./ciStatusManager.js";
import type {
  CITriggerResult,
  CIPollResult,
  CIFailureLogs,
  CIFailedJob,
  CITriggerStatus,
} from "./types.js";

const DEFAULT_POLL_INTERVAL_MS = 15_000;
const DEFAULT_POLL_TIMEOUT_MS = 10 * 60_000; // 10 minutes
const DEFAULT_WORKFLOW_FILE = "ci.yml";

export class CIIntegrationManager {
  private readonly workspaceManager: WorkspaceManager;
  private readonly ciStatusManager: CIStatusManager;

  public constructor(
    workspaceManager: WorkspaceManager,
    ciStatusManager: CIStatusManager,
  ) {
    this.workspaceManager = workspaceManager;
    this.ciStatusManager = ciStatusManager;
  }

  /**
   * Trigger a GitHub Actions workflow for the given task's workspace.
   * Uses `gh workflow run` to dispatch the workflow, then immediately
   * queries for the resulting run ID.
   */
  public async triggerCI(
    taskId: string,
    sha: string,
    workflowFile = DEFAULT_WORKFLOW_FILE,
  ): Promise<CITriggerResult> {
    // Get the current branch name for the workflow dispatch
    const branchResult = await this.workspaceManager.runInWorkspaceAllowNonZero(
      taskId,
      ["git", "rev-parse", "--abbrev-ref", "HEAD"],
    );
    const branch = branchResult.stdout.trim();
    if (!branch || branchResult.exitCode !== 0) {
      throw new Error(`Failed to determine current branch for taskId=${taskId}`);
    }

    // Trigger the workflow
    const triggerResult = await this.workspaceManager.runInWorkspaceAllowNonZero(
      taskId,
      ["gh", "workflow", "run", workflowFile, "--ref", branch],
    );

    if (triggerResult.exitCode !== 0) {
      throw new Error(
        `Failed to trigger CI workflow '${workflowFile}' on branch '${branch}': ${triggerResult.stderr.trim()}`,
      );
    }

    // Wait briefly for the run to appear, then query for it
    await this.delay(3_000);

    const ghRunId = await this.findRecentRunId(taskId, workflowFile, branch);
    if (ghRunId === null) {
      throw new Error(
        `CI workflow was triggered but could not find the resulting run for '${workflowFile}' on branch '${branch}'`,
      );
    }

    const result: CITriggerResult = {
      taskId,
      ghRunId,
      status: "pending",
      url: await this.getRunUrl(taskId, ghRunId),
      triggeredAt: new Date().toISOString(),
    };

    return result;
  }

  /**
   * Poll a GitHub Actions run until it reaches a terminal state or times out.
   */
  public async pollCIStatus(
    taskId: string,
    ghRunId: number,
    timeoutMs = DEFAULT_POLL_TIMEOUT_MS,
  ): Promise<CIPollResult> {
    const startTime = Date.now();

    while (Date.now() - startTime < timeoutMs) {
      const runResult = await this.workspaceManager.runInWorkspaceAllowNonZero(
        taskId,
        ["gh", "api", `repos/{owner}/{repo}/actions/runs/${ghRunId}`, "--jq", ".status,.conclusion"],
      );

      if (runResult.exitCode !== 0) {
        throw new Error(`Failed to poll CI run ${ghRunId}: ${runResult.stderr.trim()}`);
      }

      const lines = runResult.stdout.trim().split("\n");
      const status = (lines[0] ?? "").trim();
      const conclusion = (lines[1] ?? "").trim() || null;

      if (status === "completed") {
        const passed = conclusion === "success";
        const durationMs = Date.now() - startTime;

        // Record in CI status manager
        const failureSummary = passed ? [] : [`Conclusion: ${conclusion ?? "unknown"}`];
        await this.ciStatusManager.recordFromCI(taskId, ghRunId, passed, durationMs, failureSummary);

        return {
          ghRunId,
          status: "completed",
          conclusion,
          passed,
          url: await this.getRunUrl(taskId, ghRunId),
          durationMs,
        };
      }

      await this.delay(DEFAULT_POLL_INTERVAL_MS);
    }

    // Timed out
    const durationMs = Date.now() - startTime;
    await this.ciStatusManager.recordFromCI(
      taskId,
      ghRunId,
      false,
      durationMs,
      ["CI run timed out after " + Math.floor(timeoutMs / 1000) + "s"],
    );

    return {
      ghRunId,
      status: "timed_out",
      conclusion: null,
      passed: false,
      url: await this.getRunUrl(taskId, ghRunId),
      durationMs,
    };
  }

  /**
   * Extract failure logs from a completed GitHub Actions run.
   * Queries each failed job for its log output.
   */
  public async getCIFailureLogs(taskId: string, ghRunId: number): Promise<CIFailureLogs> {
    // Get the list of jobs for this run
    const jobsResult = await this.workspaceManager.runInWorkspaceAllowNonZero(
      taskId,
      [
        "gh", "api",
        `repos/{owner}/{repo}/actions/runs/${ghRunId}/jobs`,
        "--jq", ".jobs[] | {name: .name, conclusion: .conclusion, id: .id, steps: [.steps[] | {name: .name, conclusion: .conclusion}]}",
      ],
    );

    if (jobsResult.exitCode !== 0) {
      return {
        ghRunId,
        failedJobs: [],
        summary: [`Failed to fetch job details: ${jobsResult.stderr.trim()}`],
      };
    }

    const failedJobs: CIFailedJob[] = [];
    const summary: string[] = [];

    // Parse each line of JSON output
    const lines = jobsResult.stdout.trim().split("\n").filter((l) => l.trim().length > 0);

    for (const line of lines) {
      let job: { name: string; conclusion: string; id: number; steps: Array<{ name: string; conclusion: string }> };
      try {
        job = JSON.parse(line) as typeof job;
      } catch {
        continue;
      }

      if (job.conclusion === "success" || job.conclusion === "skipped") {
        continue;
      }

      const failedSteps = (job.steps ?? [])
        .filter((s) => s.conclusion !== "success" && s.conclusion !== "skipped")
        .map((s) => ({
          stepName: s.name,
          conclusion: s.conclusion,
          logExcerpt: "", // Log excerpts fetched below
        }));

      // Try to get logs for the failed job
      const logResult = await this.workspaceManager.runInWorkspaceAllowNonZero(
        taskId,
        ["gh", "api", `repos/{owner}/{repo}/actions/jobs/${job.id}/logs`],
      );

      const logExcerpt = logResult.exitCode === 0
        ? this.tailOutput(logResult.stdout, 50)
        : "(logs not available)";

      // Attach log excerpt to the first failed step (or create a general one)
      if (failedSteps.length > 0) {
        failedSteps[0]!.logExcerpt = logExcerpt;
      } else {
        failedSteps.push({
          stepName: "(general)",
          conclusion: job.conclusion,
          logExcerpt,
        });
      }

      failedJobs.push({
        jobName: job.name,
        conclusion: job.conclusion,
        steps: failedSteps,
      });

      summary.push(`Job '${job.name}' ${job.conclusion}: ${failedSteps.length} failed step(s)`);
    }

    return { ghRunId, failedJobs, summary };
  }

  /**
   * Convenience method: trigger CI, poll until done, and return full results.
   * This is the main entry point for the fix-until-green loop integration.
   */
  public async triggerAndWait(
    taskId: string,
    sha: string,
    workflowFile = DEFAULT_WORKFLOW_FILE,
    timeoutMs = DEFAULT_POLL_TIMEOUT_MS,
  ): Promise<{ trigger: CITriggerResult; poll: CIPollResult; failures: CIFailureLogs | null }> {
    const trigger = await this.triggerCI(taskId, sha, workflowFile);
    const poll = await this.pollCIStatus(taskId, trigger.ghRunId, timeoutMs);

    let failures: CIFailureLogs | null = null;
    if (!poll.passed) {
      failures = await this.getCIFailureLogs(taskId, trigger.ghRunId);
    }

    return { trigger, poll, failures };
  }

  /**
   * Get the status of a specific check run for a commit SHA.
   * Useful for checking CI status from webhook payloads.
   */
  public async getCheckRunsForSha(
    taskId: string,
    sha: string,
  ): Promise<Array<{ name: string; status: CITriggerStatus; conclusion: string | null }>> {
    const result = await this.workspaceManager.runInWorkspaceAllowNonZero(
      taskId,
      [
        "gh", "api",
        `repos/{owner}/{repo}/commits/${sha}/check-runs`,
        "--jq", ".check_runs[] | {name: .name, status: .status, conclusion: .conclusion}",
      ],
    );

    if (result.exitCode !== 0) {
      return [];
    }

    const runs: Array<{ name: string; status: CITriggerStatus; conclusion: string | null }> = [];
    const lines = result.stdout.trim().split("\n").filter((l) => l.trim().length > 0);

    for (const line of lines) {
      try {
        const parsed = JSON.parse(line) as { name: string; status: string; conclusion: string | null };
        runs.push({
          name: parsed.name,
          status: this.mapGitHubStatus(parsed.status),
          conclusion: parsed.conclusion,
        });
      } catch {
        continue;
      }
    }

    return runs;
  }

  private mapGitHubStatus(ghStatus: string): CITriggerStatus {
    switch (ghStatus) {
      case "queued":
        return "pending";
      case "in_progress":
        return "in_progress";
      case "completed":
        return "completed";
      default:
        return "pending";
    }
  }

  private async findRecentRunId(
    taskId: string,
    workflowFile: string,
    branch: string,
  ): Promise<number | null> {
    const result = await this.workspaceManager.runInWorkspaceAllowNonZero(
      taskId,
      [
        "gh", "run", "list",
        "--workflow", workflowFile,
        "--branch", branch,
        "--limit", "1",
        "--json", "databaseId",
        "--jq", ".[0].databaseId",
      ],
    );

    if (result.exitCode !== 0 || !result.stdout.trim()) {
      return null;
    }

    const parsed = parseInt(result.stdout.trim(), 10);
    return Number.isFinite(parsed) ? parsed : null;
  }

  private async getRunUrl(taskId: string, ghRunId: number): Promise<string> {
    const result = await this.workspaceManager.runInWorkspaceAllowNonZero(
      taskId,
      [
        "gh", "api",
        `repos/{owner}/{repo}/actions/runs/${ghRunId}`,
        "--jq", ".html_url",
      ],
    );

    return result.exitCode === 0 ? result.stdout.trim() : `https://github.com/actions/runs/${ghRunId}`;
  }

  private tailOutput(output: string, lines: number): string {
    return output
      .split("\n")
      .slice(-lines)
      .join("\n")
      .trim();
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => {
      setTimeout(resolve, ms);
    });
  }
}
