import crypto from "node:crypto";
import type http from "node:http";
import type { Controller } from "./controller.js";
import type { IssueTriageManager } from "./issueTriageManager.js";

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

export interface WebhookEvent {
  id: string;
  event: string;
  action: string | null;
  timestamp: string;
  deliveryId: string;
  repository: string | null;
  sender: string | null;
  processed: boolean;
  result: string | null;
  error: string | null;
}

interface PushPayload {
  ref: string;
  repository?: { full_name?: string };
  sender?: { login?: string };
  after?: string;
  head_commit?: { message?: string };
}

interface PullRequestPayload {
  action: string;
  number: number;
  pull_request: {
    number: number;
    title: string;
    body: string | null;
    head: { ref: string };
    base: { ref: string };
    html_url: string;
    user?: { login?: string };
  };
  repository?: { full_name?: string };
  sender?: { login?: string };
}

interface PullRequestReviewPayload {
  action: string;
  review: {
    state: string;
    user?: { login?: string };
    body: string | null;
  };
  pull_request: { number: number; title: string };
  repository?: { full_name?: string };
  sender?: { login?: string };
}

interface CheckPayload {
  action: string;
  check_suite?: {
    conclusion: string | null;
    head_branch: string | null;
    pull_requests?: Array<{ number: number }>;
  };
  check_run?: {
    name: string;
    conclusion: string | null;
    check_suite?: {
      head_branch: string | null;
      pull_requests?: Array<{ number: number }>;
    };
  };
  repository?: { full_name?: string };
  sender?: { login?: string };
}

interface IssuePayload {
  action: string;
  issue: {
    number: number;
    title: string;
    body: string | null;
    labels: Array<{ name: string }>;
    user?: { login?: string };
    html_url: string;
  };
  repository?: { full_name?: string };
  sender?: { login?: string };
}

interface IssueCommentPayload {
  action: string;
  comment: {
    body: string;
    user?: { login?: string };
  };
  issue: {
    number: number;
    title: string;
    body: string | null;
    html_url: string;
    pull_request?: { url: string };
  };
  repository?: { full_name?: string };
  sender?: { login?: string };
}

/* ------------------------------------------------------------------ */
/*  Constants                                                          */
/* ------------------------------------------------------------------ */

const MAX_AUDIT_ENTRIES = 1000;
const BODY_LIMIT_BYTES = 1024 * 256; // 256 KB max webhook payload

/* ------------------------------------------------------------------ */
/*  WebhookHandler                                                     */
/* ------------------------------------------------------------------ */

export class WebhookHandler {
  private readonly auditLog: WebhookEvent[] = [];
  private readonly webhookSecret: string | undefined;

  public constructor(
    private readonly controller: Controller,
    private readonly issueTriageManager: IssueTriageManager,
  ) {
    this.webhookSecret = process.env.GITHUB_WEBHOOK_SECRET?.trim() || undefined;
  }

  /**
   * Main HTTP handler for POST /webhooks/github
   * Verifies signature, parses event, routes to handler, returns 200 quickly.
   */
  public async handleRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    if (req.method !== "POST") {
      res.writeHead(405, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "method_not_allowed" }));
      return;
    }

    // Read body
    let body: string;
    try {
      body = await this.readBody(req, BODY_LIMIT_BYTES);
    } catch {
      res.writeHead(413, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "payload_too_large" }));
      return;
    }

    // Verify signature if secret is configured
    if (this.webhookSecret) {
      const signature = req.headers["x-hub-signature-256"] as string | undefined;
      if (!signature || !this.verifySignature(body, signature)) {
        res.writeHead(401, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "invalid_signature" }));
        return;
      }
    }

    // Parse event type
    const eventType = req.headers["x-github-event"] as string | undefined;
    const deliveryId = (req.headers["x-github-delivery"] as string | undefined) ?? crypto.randomUUID();

    if (!eventType) {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "missing_event_header" }));
      return;
    }

    // Parse payload
    let payload: unknown;
    try {
      payload = JSON.parse(body);
    } catch {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "invalid_json" }));
      return;
    }

    // Respond 200 immediately, process async
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, deliveryId }));

    // Process async
    void this.routeEvent(eventType, deliveryId, payload);
  }

  /**
   * Get the webhook audit log.
   */
  public getAuditLog(limit = 50): WebhookEvent[] {
    return this.auditLog.slice(-limit);
  }

  /* ---------------------------------------------------------------- */
  /*  Signature Verification                                          */
  /* ---------------------------------------------------------------- */

  private verifySignature(body: string, signature: string): boolean {
    if (!this.webhookSecret) return false;

    const expected = `sha256=${crypto
      .createHmac("sha256", this.webhookSecret)
      .update(body, "utf8")
      .digest("hex")}`;

    // Constant-time comparison
    try {
      return crypto.timingSafeEqual(
        Buffer.from(signature, "utf8"),
        Buffer.from(expected, "utf8"),
      );
    } catch {
      // Length mismatch
      return false;
    }
  }

  /* ---------------------------------------------------------------- */
  /*  Event Routing                                                    */
  /* ---------------------------------------------------------------- */

  private async routeEvent(
    eventType: string,
    deliveryId: string,
    payload: unknown,
  ): Promise<void> {
    const record = this.createAuditEntry(eventType, deliveryId, payload);

    try {
      switch (eventType) {
        case "push":
          await this.handlePush(payload as PushPayload, record);
          break;
        case "pull_request":
          await this.handlePullRequest(payload as PullRequestPayload, record);
          break;
        case "pull_request_review":
          await this.handlePullRequestReview(payload as PullRequestReviewPayload, record);
          break;
        case "check_suite":
        case "check_run":
          await this.handleCheckEvent(payload as CheckPayload, record);
          break;
        case "issues":
          await this.handleIssue(payload as IssuePayload, record);
          break;
        case "issue_comment":
          await this.handleIssueComment(payload as IssueCommentPayload, record);
          break;
        default:
          record.result = `unhandled_event_type: ${eventType}`;
          break;
      }
      record.processed = true;
    } catch (error) {
      record.error = error instanceof Error ? error.message : String(error);
      record.processed = true;
    }
  }

  /* ---------------------------------------------------------------- */
  /*  Event Handlers                                                   */
  /* ---------------------------------------------------------------- */

  private async handlePush(payload: PushPayload, record: WebhookEvent): Promise<void> {
    const branch = payload.ref?.replace("refs/heads/", "") ?? "unknown";
    record.result = `push to ${branch}`;

    // If there is a task associated with this branch, trigger verify
    try {
      const task = await this.findTaskByBranch(branch);
      if (task) {
        void this.controller.runVerify(task).catch(() => {
          // Non-critical: verification may fail
        });
        record.result = `push to ${branch} — triggered verify for task ${task}`;
      }
    } catch {
      // Non-critical
    }
  }

  private async handlePullRequest(payload: PullRequestPayload, record: WebhookEvent): Promise<void> {
    const action = payload.action;
    const prNumber = payload.pull_request.number;
    const branch = payload.pull_request.head.ref;
    record.action = action;

    if (action === "opened" || action === "synchronize") {
      // Trigger auto-review
      const task = await this.findTaskByBranch(branch);
      if (task) {
        void this.controller.reviewPR(task).catch(() => {
          // Non-critical
        });
        record.result = `PR #${prNumber} ${action} — triggered review for task ${task}`;
      } else {
        record.result = `PR #${prNumber} ${action} — no matching task for branch ${branch}`;
      }
    } else {
      record.result = `PR #${prNumber} action=${action} — logged`;
    }
  }

  private async handlePullRequestReview(
    payload: PullRequestReviewPayload,
    record: WebhookEvent,
  ): Promise<void> {
    const state = payload.review.state;
    const prNumber = payload.pull_request.number;
    const reviewer = payload.review.user?.login ?? "unknown";
    record.action = payload.action;
    record.result = `PR #${prNumber} review by ${reviewer}: ${state}`;
    // Just log — no further action needed
    await Promise.resolve();
  }

  private async handleCheckEvent(payload: CheckPayload, record: WebhookEvent): Promise<void> {
    const action = payload.action;
    record.action = action;

    if (action !== "completed") {
      record.result = `check event action=${action} — skipped (not completed)`;
      return;
    }

    const conclusion = payload.check_run?.conclusion ?? payload.check_suite?.conclusion ?? "unknown";
    const branch =
      payload.check_run?.check_suite?.head_branch ??
      payload.check_suite?.head_branch ??
      null;

    if (!branch) {
      record.result = `check completed conclusion=${conclusion} — no branch`;
      return;
    }

    // Feed CI results back
    const task = await this.findTaskByBranch(branch);
    if (task) {
      try {
        await this.controller.recordCIRun({
          taskId: task,
          passed: conclusion === "success",
          exitCode: conclusion === "success" ? 0 : 1,
          duration_ms: 0,
          failureCount: conclusion === "success" ? 0 : 1,
          failureSummary: conclusion !== "success" ? [`CI check ${conclusion}`] : [],
        });
        record.result = `check completed on ${branch} conclusion=${conclusion} — recorded CI for task ${task}`;
      } catch {
        record.result = `check completed on ${branch} conclusion=${conclusion} — failed to record CI`;
      }
    } else {
      record.result = `check completed on ${branch} conclusion=${conclusion} — no matching task`;
    }
  }

  private async handleIssue(payload: IssuePayload, record: WebhookEvent): Promise<void> {
    const action = payload.action;
    record.action = action;

    if (action !== "opened") {
      record.result = `issue #${payload.issue.number} action=${action} — skipped`;
      return;
    }

    // Trigger issue triage
    const repo = payload.repository?.full_name ?? null;
    try {
      const triageResult = await this.issueTriageManager.triageIssue({
        issueNumber: payload.issue.number,
        title: payload.issue.title,
        body: payload.issue.body ?? "",
        repo: repo ?? "",
        author: payload.issue.user?.login ?? "unknown",
        url: payload.issue.html_url,
        existingLabels: payload.issue.labels.map((l) => l.name),
      });
      record.result = `issue #${payload.issue.number} triaged as ${triageResult.classification} (complexity: ${triageResult.complexity})`;
    } catch (error) {
      record.error = error instanceof Error ? error.message : String(error);
      record.result = `issue #${payload.issue.number} triage failed`;
    }
  }

  private async handleIssueComment(payload: IssueCommentPayload, record: WebhookEvent): Promise<void> {
    const action = payload.action;
    record.action = action;

    if (action !== "created") {
      record.result = `comment on issue #${payload.issue.number} action=${action} — skipped`;
      return;
    }

    const body = payload.comment.body.trim();
    const commandMatch = /^\/codex\s+(.+)$/m.exec(body);

    if (!commandMatch?.[1]) {
      record.result = `comment on issue #${payload.issue.number} — no command trigger`;
      return;
    }

    const command = commandMatch[1].trim();
    const repo = payload.repository?.full_name ?? "";

    // Handle /codex fix this
    if (command.startsWith("fix this") || command.startsWith("fix")) {
      try {
        const result = await this.issueTriageManager.convertIssueToTask({
          issueNumber: payload.issue.number,
          title: payload.issue.title,
          body: payload.issue.body ?? "",
          repo,
          author: payload.comment.user?.login ?? "unknown",
          url: payload.issue.html_url,
          existingLabels: [],
        });
        record.result = `command "/codex ${command}" on issue #${payload.issue.number} — created task ${result.taskId}`;
      } catch (error) {
        record.error = error instanceof Error ? error.message : String(error);
        record.result = `command "/codex ${command}" on issue #${payload.issue.number} — failed`;
      }
    } else {
      record.result = `command "/codex ${command}" on issue #${payload.issue.number} — unknown command`;
    }
  }

  /* ---------------------------------------------------------------- */
  /*  Helpers                                                          */
  /* ---------------------------------------------------------------- */

  private async findTaskByBranch(branch: string): Promise<string | null> {
    try {
      const task = await this.controller.getTask(branch);
      if (task) return task.taskId;
    } catch {
      // Task not found by branch name as taskId
    }

    // Convention: taskId often matches the branch name slug
    // Try common patterns: branch = "codex/taskId" or "feat/taskId"
    const parts = branch.split("/");
    const lastPart = parts[parts.length - 1];
    if (lastPart) {
      try {
        const task = await this.controller.getTask(lastPart);
        if (task) return task.taskId;
      } catch {
        // Not found
      }
    }

    return null;
  }

  private createAuditEntry(
    eventType: string,
    deliveryId: string,
    payload: unknown,
  ): WebhookEvent {
    const p = payload as Record<string, unknown> | null;
    const repo = (p?.repository as Record<string, unknown> | undefined)?.full_name as string | undefined;
    const sender = (p?.sender as Record<string, unknown> | undefined)?.login as string | undefined;
    const action = typeof p?.action === "string" ? p.action : null;

    const entry: WebhookEvent = {
      id: `wh_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      event: eventType,
      action,
      timestamp: new Date().toISOString(),
      deliveryId,
      repository: repo ?? null,
      sender: sender ?? null,
      processed: false,
      result: null,
      error: null,
    };

    this.auditLog.push(entry);
    if (this.auditLog.length > MAX_AUDIT_ENTRIES) {
      this.auditLog.splice(0, this.auditLog.length - MAX_AUDIT_ENTRIES);
    }

    return entry;
  }

  private readBody(req: http.IncomingMessage, limitBytes: number): Promise<string> {
    return new Promise((resolve, reject) => {
      let total = 0;
      const chunks: Buffer[] = [];

      req.on("data", (chunk: Buffer) => {
        total += chunk.length;
        if (total > limitBytes) {
          reject(new Error("Request body too large"));
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });
      req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
      req.on("error", reject);
    });
  }
}
