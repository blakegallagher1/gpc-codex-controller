import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { execSync } from "node:child_process";
import type { Controller } from "./controller.js";

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

export type IssueClassification = "bug" | "feature" | "refactor" | "unknown";
export type IssueComplexity = "small" | "medium" | "large";

export interface TriageInput {
  issueNumber: number;
  title: string;
  body: string;
  repo: string;
  author: string;
  url: string;
  existingLabels: string[];
}

export interface TriageRecord {
  id: string;
  issueNumber: number;
  repo: string;
  title: string;
  url: string;
  author: string;
  classification: IssueClassification;
  complexity: IssueComplexity;
  labelsApplied: string[];
  taskId: string | null;
  taskStarted: boolean;
  prUrl: string | null;
  prMerged: boolean;
  issueClosed: boolean;
  triagedAt: string;
  updatedAt: string;
}

export interface TriageResult {
  id: string;
  issueNumber: number;
  classification: IssueClassification;
  complexity: IssueComplexity;
  labelsApplied: string[];
  commentPosted: boolean;
}

export interface ConvertResult {
  id: string;
  issueNumber: number;
  taskId: string;
  classification: IssueClassification;
  autonomousRunStarted: boolean;
}

/* ------------------------------------------------------------------ */
/*  Store                                                              */
/* ------------------------------------------------------------------ */

interface TriageStore {
  version: number;
  records: TriageRecord[];
}

const EMPTY_STORE: TriageStore = { version: 1, records: [] };
const MAX_RECORDS = 500;

/* ------------------------------------------------------------------ */
/*  Classification Keywords                                            */
/* ------------------------------------------------------------------ */

const BUG_KEYWORDS = [
  "bug", "error", "crash", "broken", "fix", "issue", "fail", "failure",
  "doesn't work", "not working", "incorrect", "unexpected", "regression",
  "exception", "traceback", "stack trace", "segfault", "panic",
  "null pointer", "undefined", "nan", "500", "404", "timeout",
];

const FEATURE_KEYWORDS = [
  "feature", "add", "new", "implement", "enhancement", "request",
  "support", "ability", "allow", "enable", "integrate", "proposal",
  "rfc", "suggest", "want", "need", "should",
];

const REFACTOR_KEYWORDS = [
  "refactor", "cleanup", "clean up", "technical debt", "tech debt",
  "reorganize", "restructure", "simplify", "optimize", "performance",
  "deprecate", "remove", "migrate", "upgrade", "modernize",
];

/* ------------------------------------------------------------------ */
/*  IssueTriageManager                                                 */
/* ------------------------------------------------------------------ */

export class IssueTriageManager {
  public constructor(
    private readonly filePath: string,
    private readonly controller: Controller,
  ) {}

  /* ---------------------------------------------------------------- */
  /*  Triage an Issue                                                  */
  /* ---------------------------------------------------------------- */

  public async triageIssue(input: TriageInput): Promise<TriageResult> {
    const classification = this.classify(input.title, input.body);
    const complexity = this.estimateComplexity(input.title, input.body);
    const labels = this.determineLabels(classification, complexity, input.existingLabels);

    // Apply labels via gh CLI
    const labelsApplied = await this.applyLabels(input.repo, input.issueNumber, labels);

    // Post triage comment
    const commentPosted = await this.postTriageComment(
      input.repo,
      input.issueNumber,
      classification,
      complexity,
      labels,
    );

    // Create triage record
    const record: TriageRecord = {
      id: `triage_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      issueNumber: input.issueNumber,
      repo: input.repo,
      title: input.title,
      url: input.url,
      author: input.author,
      classification,
      complexity,
      labelsApplied,
      taskId: null,
      taskStarted: false,
      prUrl: null,
      prMerged: false,
      issueClosed: false,
      triagedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    const store = await this.load();
    store.records.push(record);
    if (store.records.length > MAX_RECORDS) {
      store.records = store.records.slice(-MAX_RECORDS);
    }
    await this.save(store);

    return {
      id: record.id,
      issueNumber: input.issueNumber,
      classification,
      complexity,
      labelsApplied,
      commentPosted,
    };
  }

  /* ---------------------------------------------------------------- */
  /*  Convert Issue to Task                                            */
  /* ---------------------------------------------------------------- */

  public async convertIssueToTask(input: TriageInput): Promise<ConvertResult> {
    // Find existing triage record, or triage first
    const store = await this.load();
    let record = store.records.find(
      (r) => r.issueNumber === input.issueNumber && r.repo === input.repo,
    );

    if (!record) {
      const triageResult = await this.triageIssue(input);
      const reloaded = await this.load();
      record = reloaded.records.find((r) => r.id === triageResult.id);
      if (!record) {
        throw new Error(`Failed to find triage record after triaging issue #${input.issueNumber}`);
      }
    }

    // Create task via controller
    const taskId = `issue-${input.issueNumber}-${Date.now().toString(36)}`;
    await this.controller.createTask(taskId);

    // Update record
    record.taskId = taskId;
    record.taskStarted = true;
    record.updatedAt = new Date().toISOString();
    await this.save(store);

    // Post progress comment
    await this.postComment(
      input.repo,
      input.issueNumber,
      `Task \`${taskId}\` created. Starting autonomous processing...`,
    );

    // Start appropriate autonomous run based on classification
    let autonomousRunStarted = false;
    const objective = this.buildObjective(record.classification, input.title, input.body);
    try {
      void this.controller.startAutonomousRun({
        objective,
        maxPhaseFixes: 3,
        qualityThreshold: 0,
        autoCommit: true,
        autoPR: true,
        autoReview: true,
      }).then(async (run) => {
        // Update record with any PR URL when run completes
        const updatedStore = await this.load();
        const updatedRecord = updatedStore.records.find((r) => r.id === record!.id);
        if (updatedRecord && run.prUrl) {
          updatedRecord.prUrl = run.prUrl;
          updatedRecord.updatedAt = new Date().toISOString();
          await this.save(updatedStore);

          // Comment on issue with PR link
          await this.postComment(
            input.repo,
            input.issueNumber,
            `PR created: ${run.prUrl}`,
          );
        }
      }).catch(() => {
        // Non-critical: autonomous run may fail
      });
      autonomousRunStarted = true;
    } catch {
      // Non-critical
    }

    return {
      id: record.id,
      issueNumber: input.issueNumber,
      taskId,
      classification: record.classification,
      autonomousRunStarted,
    };
  }

  /* ---------------------------------------------------------------- */
  /*  History                                                          */
  /* ---------------------------------------------------------------- */

  public async getTriageHistory(limit = 50): Promise<TriageRecord[]> {
    const store = await this.load();
    return store.records.slice(-limit);
  }

  public async getTriageRecord(issueNumber: number, repo: string): Promise<TriageRecord | null> {
    const store = await this.load();
    return store.records.find(
      (r) => r.issueNumber === issueNumber && r.repo === repo,
    ) ?? null;
  }

  /* ---------------------------------------------------------------- */
  /*  Progress Updates                                                 */
  /* ---------------------------------------------------------------- */

  public async updateProgress(
    issueNumber: number,
    repo: string,
    update: Partial<Pick<TriageRecord, "prUrl" | "prMerged" | "issueClosed">>,
  ): Promise<TriageRecord | null> {
    const store = await this.load();
    const record = store.records.find(
      (r) => r.issueNumber === issueNumber && r.repo === repo,
    );
    if (!record) return null;

    if (update.prUrl !== undefined) record.prUrl = update.prUrl;
    if (update.prMerged !== undefined) record.prMerged = update.prMerged;
    if (update.issueClosed !== undefined) record.issueClosed = update.issueClosed;
    record.updatedAt = new Date().toISOString();

    await this.save(store);

    // Close issue if PR merged
    if (update.prMerged && !record.issueClosed) {
      await this.closeIssue(repo, issueNumber);
      record.issueClosed = true;
      record.updatedAt = new Date().toISOString();
      await this.save(store);
    }

    return record;
  }

  /* ---------------------------------------------------------------- */
  /*  Classification Logic                                             */
  /* ---------------------------------------------------------------- */

  private classify(title: string, body: string): IssueClassification {
    const text = `${title} ${body}`.toLowerCase();

    let bugScore = 0;
    let featureScore = 0;
    let refactorScore = 0;

    for (const kw of BUG_KEYWORDS) {
      if (text.includes(kw)) bugScore += 1;
    }
    for (const kw of FEATURE_KEYWORDS) {
      if (text.includes(kw)) featureScore += 1;
    }
    for (const kw of REFACTOR_KEYWORDS) {
      if (text.includes(kw)) refactorScore += 1;
    }

    // Title keywords get extra weight
    const titleLower = title.toLowerCase();
    if (titleLower.startsWith("[bug]") || titleLower.startsWith("bug:")) bugScore += 3;
    if (titleLower.startsWith("[feature]") || titleLower.startsWith("feat:")) featureScore += 3;
    if (titleLower.startsWith("[refactor]") || titleLower.startsWith("refactor:")) refactorScore += 3;

    const maxScore = Math.max(bugScore, featureScore, refactorScore);
    if (maxScore === 0) return "unknown";
    if (bugScore === maxScore) return "bug";
    if (featureScore === maxScore) return "feature";
    return "refactor";
  }

  private estimateComplexity(title: string, body: string): IssueComplexity {
    const combinedLength = title.length + body.length;
    const text = `${title} ${body}`.toLowerCase();

    // Large indicators
    const largeKeywords = ["migration", "redesign", "rewrite", "architecture", "breaking change", "multi-step", "complex"];
    const hasLargeIndicator = largeKeywords.some((kw) => text.includes(kw));

    // If body is very long or has large keywords
    if (combinedLength > 2000 || hasLargeIndicator) return "large";
    if (combinedLength > 500) return "medium";
    return "small";
  }

  private determineLabels(
    classification: IssueClassification,
    complexity: IssueComplexity,
    existingLabels: string[],
  ): string[] {
    const labels: string[] = [];
    const existing = new Set(existingLabels);

    // Classification label
    const classLabel = classification === "unknown" ? "needs-triage" : classification;
    if (!existing.has(classLabel)) labels.push(classLabel);

    // Complexity label
    const complexityLabel = `complexity:${complexity}`;
    if (!existing.has(complexityLabel)) labels.push(complexityLabel);

    // Auto-triage label
    if (!existing.has("auto-triaged")) labels.push("auto-triaged");

    return labels;
  }

  private buildObjective(classification: IssueClassification, title: string, body: string): string {
    const truncatedBody = body.length > 500 ? `${body.slice(0, 500)}...` : body;

    switch (classification) {
      case "bug":
        return `Fix bug: ${title}\n\nDescription:\n${truncatedBody}`;
      case "feature":
        return `Implement feature: ${title}\n\nDescription:\n${truncatedBody}`;
      case "refactor":
        return `Refactor: ${title}\n\nDescription:\n${truncatedBody}`;
      default:
        return `Address issue: ${title}\n\nDescription:\n${truncatedBody}`;
    }
  }

  /* ---------------------------------------------------------------- */
  /*  GitHub CLI Helpers                                                */
  /* ---------------------------------------------------------------- */

  private async applyLabels(repo: string, issueNumber: number, labels: string[]): Promise<string[]> {
    if (labels.length === 0 || !repo) return [];

    const applied: string[] = [];
    for (const label of labels) {
      try {
        execSync(
          `gh issue edit ${issueNumber} --repo "${repo}" --add-label "${label}"`,
          { timeout: 15_000, stdio: "pipe" },
        );
        applied.push(label);
      } catch {
        // Label may not exist; continue with others
      }
    }
    return applied;
  }

  private async postTriageComment(
    repo: string,
    issueNumber: number,
    classification: IssueClassification,
    complexity: IssueComplexity,
    labels: string[],
  ): Promise<boolean> {
    const body = [
      "**Auto-Triage Summary**",
      "",
      `- **Classification:** ${classification}`,
      `- **Complexity:** ${complexity}`,
      `- **Labels applied:** ${labels.length > 0 ? labels.map((l) => `\`${l}\``).join(", ") : "none"}`,
      "",
      `Use \`/codex fix this\` to start autonomous processing.`,
    ].join("\n");

    return this.postComment(repo, issueNumber, body);
  }

  private async postComment(repo: string, issueNumber: number, body: string): Promise<boolean> {
    if (!repo) return false;

    try {
      execSync(
        `gh issue comment ${issueNumber} --repo "${repo}" --body "${body.replace(/"/g, '\\"')}"`,
        { timeout: 15_000, stdio: "pipe" },
      );
      return true;
    } catch {
      return false;
    }
  }

  private async closeIssue(repo: string, issueNumber: number): Promise<boolean> {
    if (!repo) return false;

    try {
      execSync(
        `gh issue close ${issueNumber} --repo "${repo}"`,
        { timeout: 15_000, stdio: "pipe" },
      );
      return true;
    } catch {
      return false;
    }
  }

  /* ---------------------------------------------------------------- */
  /*  Persistence                                                      */
  /* ---------------------------------------------------------------- */

  private async load(): Promise<TriageStore> {
    try {
      const raw = await readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as Partial<TriageStore>;
      if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.records)) {
        return { ...EMPTY_STORE };
      }
      return { version: parsed.version ?? 1, records: parsed.records };
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
      throw new Error(`Failed to load triage store from ${this.filePath}: ${message}`);
    }
  }

  private async save(store: TriageStore): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const tempPath = `${this.filePath}.tmp`;
    await writeFile(tempPath, `${JSON.stringify(store, null, 2)}\n`, "utf8");
    await rename(tempPath, this.filePath);
  }
}
