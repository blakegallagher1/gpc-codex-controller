/**
 * Autonomous Orchestrator — drives end-to-end coding workflows.
 *
 * Given a high-level objective, the orchestrator:
 *  1. Creates a task (workspace + branch + thread)
 *  2. Generates an execution plan (Analysis → Implementation → Testing → Verification)
 *  3. For each phase: sends enriched prompts to Codex, verifies, fix-loops, checkpoints
 *  4. Scores quality, commits, opens PR, runs review loop
 *
 * Runs are fire-and-forget (async job pattern) — callers poll via getRun().
 */
import crypto from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { Controller } from "./controller.js";
import type {
  AutonomousPhaseResult,
  AutonomousRunParams,
  AutonomousRunRecord,
  AutonomousRunStatus,
  PlanPhase,
} from "./types.js";

interface RunStore {
  version: number;
  runs: Record<string, AutonomousRunRecord>;
}

const EMPTY_STORE: RunStore = { version: 1, runs: {} };

export class AutonomousOrchestrator {
  public constructor(
    private readonly controller: Controller,
    private readonly filePath: string,
  ) {}

  /* ------------------------------------------------------------------ */
  /*  Public API                                                         */
  /* ------------------------------------------------------------------ */

  public async startRun(params: AutonomousRunParams): Promise<AutonomousRunRecord> {
    const runId = `run_${crypto.randomBytes(8).toString("hex")}`;
    const taskId = `auto-${runId}`;
    const now = new Date().toISOString();

    const record: AutonomousRunRecord = {
      runId,
      taskId,
      objective: params.objective,
      status: "planning",
      params,
      phases: [],
      startedAt: now,
      updatedAt: now,
      finishedAt: null,
      qualityScore: null,
      commitHash: null,
      prUrl: null,
      reviewPassed: null,
      error: null,
    };

    const store = await this.load();
    store.runs[runId] = record;
    await this.save(store);

    // Fire-and-forget — callers poll via getRun()
    void this.executeRun(record).catch(() => {
      // Errors are persisted in the run record, not thrown.
    });

    return record;
  }

  public async getRun(runId: string): Promise<AutonomousRunRecord | null> {
    const store = await this.load();
    return store.runs[runId] ?? null;
  }

  public async listRuns(limit = 20): Promise<AutonomousRunRecord[]> {
    const store = await this.load();
    return Object.values(store.runs)
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
      .slice(0, limit);
  }

  public async cancelRun(runId: string): Promise<boolean> {
    const store = await this.load();
    const run = store.runs[runId];
    if (!run || run.status === "completed" || run.status === "failed" || run.status === "cancelled") {
      return false;
    }
    run.status = "cancelled";
    run.updatedAt = new Date().toISOString();
    run.finishedAt = new Date().toISOString();
    await this.save(store);
    return true;
  }

  /* ------------------------------------------------------------------ */
  /*  Core execution loop                                                */
  /* ------------------------------------------------------------------ */

  private async executeRun(record: AutonomousRunRecord): Promise<void> {
    const params = record.params;

    try {
      // ── Phase 1: Planning ──────────────────────────────────────────
      await this.updateRunStatus(record.runId, "planning");

      // Create task (workspace + branch + thread)
      const task = await this.controller.createTask(record.taskId);
      await this.controller.prepareWorkspace(record.taskId);

      // Create execution plan (auto-generates Analysis → Implementation → Testing → Verification)
      const plan = await this.controller.createExecutionPlan(record.taskId, params.objective);

      // ── Phase 2: Execution ─────────────────────────────────────────
      await this.updateRunStatus(record.runId, "executing");

      const maxPhaseFixes = params.maxPhaseFixes;

      for (let i = 0; i < plan.phases.length; i++) {
        // Cooperative cancellation check
        const currentRun = await this.getRun(record.runId);
        if (!currentRun || currentRun.status === "cancelled") {
          return;
        }

        const phase = plan.phases[i] as PlanPhase;
        const phaseStart = Date.now();

        await this.controller.updatePlanPhase(record.taskId, i, "in_progress");

        // Ensure task is in a state that can transition to "mutating".
        // After a previous phase's fix loop the task may still be "verifying" or "fixing".
        try {
          await this.controller.updateTaskStatus(record.taskId, "ready");
        } catch {
          // Already in a state that can reach "mutating" — proceed.
        }
        await this.controller.updateTaskStatus(record.taskId, "mutating");

        const phaseResult: AutonomousPhaseResult = {
          phaseIndex: i,
          phaseName: phase.name,
          status: "completed",
          turnId: null,
          verifyPassed: false,
          fixIterations: 0,
          durationMs: 0,
          error: null,
        };

        try {
          // Build enriched prompt with skill routing + memory + phase context
          const phasePrompt = await this.buildPhasePrompt(
            params.objective,
            phase,
            i,
            plan.phases.length,
            record.phases,
          );

          // Execute the turn via Codex
          const turnResult = await this.controller.continueTask(task.threadId, phasePrompt);
          phaseResult.turnId = turnResult.turnId;

          // Verify
          await this.controller.updateTaskStatus(record.taskId, "verifying");
          const verifyResult = await this.controller.runVerify(record.taskId);

          if (verifyResult.success) {
            phaseResult.verifyPassed = true;
          } else {
            // Fix loop
            const fixResult = await this.controller.fixUntilGreen(record.taskId, maxPhaseFixes);
            phaseResult.fixIterations = fixResult.iterations;
            phaseResult.verifyPassed = fixResult.success;

            if (!fixResult.success) {
              phaseResult.status = "failed";
              phaseResult.error = `Verification did not pass after ${fixResult.iterations} fix iterations`;
              await this.controller.updatePlanPhase(record.taskId, i, "failed");
              // Continue to next phase — partial success is better than total failure
            }
          }

          if (phaseResult.status === "completed") {
            await this.controller.updatePlanPhase(record.taskId, i, "completed");

            // Checkpoint after successful phase
            try {
              await this.controller.checkpointTask(record.taskId, `Phase ${i}: ${phase.name} completed`);
            } catch {
              // Non-critical
            }
          }
        } catch (error) {
          phaseResult.status = "failed";
          phaseResult.error = error instanceof Error ? error.message : String(error);
          try {
            await this.controller.updatePlanPhase(record.taskId, i, "failed");
          } catch {
            // Preserve original error
          }
        }

        phaseResult.durationMs = Date.now() - phaseStart;
        record.phases.push(phaseResult);
        await this.updateRunRecord(record);
      }

      // Abort if zero phases succeeded
      const anyPhaseSucceeded = record.phases.some((p) => p.status === "completed");
      if (!anyPhaseSucceeded) {
        throw new Error("All phases failed — no changes to commit");
      }

      // ── Phase 3: Validation ────────────────────────────────────────
      await this.updateRunStatus(record.runId, "validating");

      try {
        const qualityScore = await this.controller.getQualityScore(record.taskId);
        record.qualityScore = qualityScore.overall;
      } catch {
        // Quality scoring is non-critical
      }

      const qualityThreshold = params.qualityThreshold;
      if (record.qualityScore !== null && qualityThreshold > 0 && record.qualityScore < qualityThreshold) {
        // Below threshold — try one more fix round
        try {
          await this.controller.fixUntilGreen(record.taskId, 2);
          const requality = await this.controller.getQualityScore(record.taskId);
          record.qualityScore = requality.overall;
        } catch {
          // Proceed anyway — we have passing tests from phase execution
        }
      }

      // ── Phase 4: Commit ────────────────────────────────────────────
      if (params.autoCommit) {
        await this.updateRunStatus(record.runId, "committing");

        const commitMessage = this.generateCommitMessage(params.objective);
        const committed = await this.controller.commitAllChanges(record.taskId, commitMessage);

        if (committed) {
          // Retrieve commit hash via shell tool
          try {
            const hashResult = await this.controller.executeShellCommand(
              record.taskId,
              ["git", "rev-parse", "--short", "HEAD"],
            );
            record.commitHash = hashResult.stdout.trim() || "committed";
          } catch {
            record.commitHash = "committed";
          }
        }
      }

      // ── Phase 5: PR + Review ───────────────────────────────────────
      if (params.autoPR && record.commitHash) {
        await this.updateRunStatus(record.runId, "reviewing");

        const prTitle = this.generatePRTitle(params.objective);
        const prBody = this.generatePRBody(record);

        try {
          record.prUrl = await this.controller.createPullRequest(record.taskId, prTitle, prBody);
        } catch (error) {
          record.error = `PR creation failed: ${error instanceof Error ? error.message : String(error)}`;
        }

        if (params.autoReview && record.prUrl) {
          try {
            const reviewResult = await this.controller.runReviewLoop(record.taskId, 2);
            record.reviewPassed = reviewResult.finalReview.approved;
          } catch {
            // Review failure is non-fatal
          }
        }
      }

      // ── Done ───────────────────────────────────────────────────────
      record.status = "completed";
      record.finishedAt = new Date().toISOString();
      try {
        await this.controller.updateTaskStatus(record.taskId, "ready");
      } catch {
        // Non-critical
      }
    } catch (error) {
      record.status = "failed";
      record.error = error instanceof Error ? error.message : String(error);
      record.finishedAt = new Date().toISOString();
      try {
        await this.controller.updateTaskStatus(record.taskId, "failed");
      } catch {
        // Preserve original error
      }
    }

    record.updatedAt = new Date().toISOString();
    await this.updateRunRecord(record);
  }

  /* ------------------------------------------------------------------ */
  /*  Prompt construction                                                */
  /* ------------------------------------------------------------------ */

  private async buildPhasePrompt(
    objective: string,
    phase: PlanPhase,
    phaseIndex: number,
    totalPhases: number,
    previousResults: AutonomousPhaseResult[],
  ): Promise<string> {
    // Get enriched base prompt (includes skill routing, memory, secrets, reference docs)
    const basePrompt = await this.controller.buildMutationPrompt(objective);

    const sections: string[] = [
      basePrompt,
      "",
      `--- AUTONOMOUS PHASE ${phaseIndex + 1}/${totalPhases}: ${phase.name} ---`,
      "",
      `Phase goal: ${phase.description}`,
      "",
    ];

    if (previousResults.length > 0) {
      sections.push("Previous phase results:");
      for (const prev of previousResults) {
        const icon = prev.status === "completed" ? "[OK]" : "[FAIL]";
        sections.push(
          `  ${icon} Phase ${prev.phaseIndex + 1} (${prev.phaseName}): ${prev.status}${prev.error ? ` — ${prev.error}` : ""}`,
        );
      }
      sections.push("");
    }

    sections.push(
      "Phase instructions:",
      `1. Focus ONLY on the "${phase.name}" phase described above.`,
      "2. Build on any work completed in previous phases.",
      "3. Make minimal, correct changes.",
      "4. Ensure all changes pass verification (pnpm verify).",
      "5. Follow existing code conventions and architecture.",
    );

    return sections.join("\n");
  }

  /* ------------------------------------------------------------------ */
  /*  Commit / PR helpers                                                */
  /* ------------------------------------------------------------------ */

  private generateCommitMessage(objective: string): string {
    const slug = objective.replace(/\s+/g, " ").trim();
    const truncated = slug.length > 60 ? `${slug.slice(0, 57)}...` : slug;
    return `feat: ${truncated}`;
  }

  private generatePRTitle(objective: string): string {
    const slug = objective.replace(/\s+/g, " ").trim();
    const truncated = slug.length > 72 ? `${slug.slice(0, 69)}...` : slug;
    return `feat: ${truncated}`;
  }

  private generatePRBody(record: AutonomousRunRecord): string {
    const lines: string[] = [
      `## Autonomous Run: ${record.runId}`,
      "",
      `**Objective:** ${record.objective}`,
      "",
      "### Phase Results",
      "",
    ];

    for (const phase of record.phases) {
      const icon = phase.status === "completed" ? "PASS" : "FAIL";
      lines.push(
        `- [${icon}] **${phase.phaseName}** — ${phase.status} (${phase.fixIterations} fix iterations, ${Math.round(phase.durationMs / 1000)}s)`,
      );
      if (phase.error) {
        lines.push(`  > ${phase.error}`);
      }
    }

    if (record.qualityScore !== null) {
      lines.push("", `**Quality Score:** ${record.qualityScore.toFixed(2)}`);
    }

    lines.push("", "---", "*Generated by gpc-codex-controller autonomous orchestrator*");

    return lines.join("\n");
  }

  /* ------------------------------------------------------------------ */
  /*  State persistence                                                  */
  /* ------------------------------------------------------------------ */

  private async updateRunStatus(runId: string, status: AutonomousRunStatus): Promise<void> {
    const store = await this.load();
    const run = store.runs[runId];
    if (run) {
      run.status = status;
      run.updatedAt = new Date().toISOString();
      await this.save(store);
    }
  }

  private async updateRunRecord(record: AutonomousRunRecord): Promise<void> {
    const store = await this.load();
    store.runs[record.runId] = { ...record, updatedAt: new Date().toISOString() };
    await this.save(store);
  }

  private async load(): Promise<RunStore> {
    try {
      const raw = await readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as Partial<RunStore>;
      if (!parsed || typeof parsed !== "object" || !parsed.runs) {
        return { ...EMPTY_STORE };
      }
      return { version: parsed.version ?? 1, runs: parsed.runs };
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        (error as { code?: unknown }).code === "ENOENT"
      ) {
        return { ...EMPTY_STORE };
      }
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to load autonomous runs from ${this.filePath}: ${message}`);
    }
  }

  private async save(store: RunStore): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const tempPath = `${this.filePath}.tmp`;
    await writeFile(tempPath, `${JSON.stringify(store, null, 2)}\n`, "utf8");
    await rename(tempPath, this.filePath);
  }
}
