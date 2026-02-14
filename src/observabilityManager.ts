/**
 * Per-Workspace Observability Manager — structured logging, metrics,
 * and basic tracing that the agent can query to diagnose runtime issues.
 *
 * Each workspace gets its own isolated observability data:
 *  - Structured logs (append-only, queryable by level/pattern/time)
 *  - Metrics (counters, gauges, histograms with labels)
 *  - Basic request traces (span-like entries with timing)
 *
 * The agent can query this data via tools/RPC methods to understand
 * application behavior without needing raw stdout parsing.
 */

import crypto from "node:crypto";
import { mkdir, readFile, writeFile, appendFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import type { WorkspaceManager } from "./workspaceManager.js";

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface StructuredLogEntry {
  timestamp: string;
  level: LogLevel;
  message: string;
  source: string;
  metadata: Record<string, unknown>;
}

export interface MetricEntry {
  name: string;
  type: "counter" | "gauge" | "histogram";
  value: number;
  labels: Record<string, string>;
  timestamp: string;
}

export interface TraceSpan {
  traceId: string;
  spanId: string;
  parentSpanId: string | null;
  operationName: string;
  startTime: string;
  endTime: string | null;
  durationMs: number | null;
  status: "ok" | "error" | "running";
  attributes: Record<string, unknown>;
}

export interface LogQueryOptions {
  level?: LogLevel;
  source?: string;
  pattern?: string;
  since?: string;
  limit?: number;
}

export interface LogQueryResult {
  taskId: string;
  entries: StructuredLogEntry[];
  totalMatched: number;
  truncated: boolean;
}

export interface MetricsSnapshot {
  taskId: string;
  metrics: MetricEntry[];
  collectedAt: string;
}

export interface TraceQueryResult {
  taskId: string;
  spans: TraceSpan[];
  totalSpans: number;
}

interface ObservabilityStore {
  logs: StructuredLogEntry[];
  metrics: MetricEntry[];
  traces: TraceSpan[];
}

const EMPTY_STORE: ObservabilityStore = { logs: [], metrics: [], traces: [] };
const MAX_LOG_ENTRIES = 5000;
const MAX_METRIC_ENTRIES = 2000;
const MAX_TRACE_SPANS = 1000;

export class ObservabilityManager {
  private stores = new Map<string, ObservabilityStore>();

  public constructor(
    private readonly workspaceManager: WorkspaceManager,
  ) {}

  /**
   * Write a structured log entry for a task workspace.
   */
  public async writeLog(
    taskId: string,
    level: LogLevel,
    message: string,
    source: string,
    metadata: Record<string, unknown> = {},
  ): Promise<void> {
    const store = this.getOrCreateStore(taskId);
    const entry: StructuredLogEntry = {
      timestamp: new Date().toISOString(),
      level,
      message,
      source,
      metadata,
    };

    store.logs.push(entry);
    if (store.logs.length > MAX_LOG_ENTRIES) {
      store.logs = store.logs.slice(-MAX_LOG_ENTRIES);
    }

    // Also persist to disk for durability
    await this.appendLogToDisk(taskId, entry);
  }

  /**
   * Query structured logs for a task workspace.
   */
  public async queryLogs(taskId: string, options: LogQueryOptions = {}): Promise<LogQueryResult> {
    const store = this.getOrCreateStore(taskId);

    // Also load any persisted logs not in memory
    await this.loadLogsFromDisk(taskId, store);

    let entries = store.logs;

    if (options.level) {
      const levelOrder: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };
      const minLevel = levelOrder[options.level];
      entries = entries.filter((e) => levelOrder[e.level] >= minLevel);
    }

    if (options.source) {
      entries = entries.filter((e) => e.source.includes(options.source!));
    }

    if (options.pattern) {
      const regex = new RegExp(options.pattern, "i");
      entries = entries.filter((e) => regex.test(e.message) || regex.test(JSON.stringify(e.metadata)));
    }

    if (options.since) {
      entries = entries.filter((e) => e.timestamp >= options.since!);
    }

    const totalMatched = entries.length;
    const limit = options.limit ?? 100;
    const truncated = totalMatched > limit;
    entries = entries.slice(-limit);

    return {
      taskId,
      entries,
      totalMatched,
      truncated,
    };
  }

  /**
   * Record a metric value.
   */
  public recordMetric(
    taskId: string,
    name: string,
    type: "counter" | "gauge" | "histogram",
    value: number,
    labels: Record<string, string> = {},
  ): void {
    const store = this.getOrCreateStore(taskId);
    const entry: MetricEntry = {
      name,
      type,
      value,
      labels,
      timestamp: new Date().toISOString(),
    };

    store.metrics.push(entry);
    if (store.metrics.length > MAX_METRIC_ENTRIES) {
      store.metrics = store.metrics.slice(-MAX_METRIC_ENTRIES);
    }
  }

  /**
   * Get current metrics snapshot.
   */
  public getMetrics(taskId: string): MetricsSnapshot {
    const store = this.getOrCreateStore(taskId);

    // Aggregate: latest value per metric name + labels
    const latest = new Map<string, MetricEntry>();
    for (const entry of store.metrics) {
      const key = `${entry.name}:${JSON.stringify(entry.labels)}`;
      if (entry.type === "counter") {
        const existing = latest.get(key);
        if (existing) {
          existing.value += entry.value;
          existing.timestamp = entry.timestamp;
        } else {
          latest.set(key, { ...entry });
        }
      } else {
        latest.set(key, entry);
      }
    }

    return {
      taskId,
      metrics: Array.from(latest.values()),
      collectedAt: new Date().toISOString(),
    };
  }

  /**
   * Start a trace span.
   */
  public startSpan(
    taskId: string,
    operationName: string,
    attributes: Record<string, unknown> = {},
    parentSpanId?: string,
  ): TraceSpan {
    const store = this.getOrCreateStore(taskId);
    const span: TraceSpan = {
      traceId: this.generateId(),
      spanId: this.generateId(),
      parentSpanId: parentSpanId ?? null,
      operationName,
      startTime: new Date().toISOString(),
      endTime: null,
      durationMs: null,
      status: "running",
      attributes,
    };

    store.traces.push(span);
    if (store.traces.length > MAX_TRACE_SPANS) {
      store.traces = store.traces.slice(-MAX_TRACE_SPANS);
    }

    return span;
  }

  /**
   * End a trace span.
   */
  public endSpan(
    taskId: string,
    spanId: string,
    status: "ok" | "error" = "ok",
    attributes?: Record<string, unknown>,
  ): TraceSpan | null {
    const store = this.getOrCreateStore(taskId);
    const span = store.traces.find((s) => s.spanId === spanId);
    if (!span) return null;

    span.endTime = new Date().toISOString();
    span.durationMs = new Date(span.endTime).getTime() - new Date(span.startTime).getTime();
    span.status = status;
    if (attributes) {
      span.attributes = { ...span.attributes, ...attributes };
    }

    return span;
  }

  /**
   * Query traces for a task.
   */
  public queryTraces(taskId: string, operationPattern?: string): TraceQueryResult {
    const store = this.getOrCreateStore(taskId);
    let spans = store.traces;

    if (operationPattern) {
      const regex = new RegExp(operationPattern, "i");
      spans = spans.filter((s) => regex.test(s.operationName));
    }

    return {
      taskId,
      spans: spans.slice(-100),
      totalSpans: spans.length,
    };
  }

  /**
   * Capture application output and ingest as structured logs.
   * Parses stdout/stderr from app boot into structured entries.
   */
  public async ingestAppOutput(
    taskId: string,
    stdout: string,
    stderr: string,
    source: string,
  ): Promise<number> {
    let count = 0;

    for (const line of stdout.split(/\r?\n/).filter((l) => l.trim())) {
      const parsed = this.parseLogLine(line);
      await this.writeLog(taskId, parsed.level, parsed.message, source, parsed.metadata);
      count++;
    }

    for (const line of stderr.split(/\r?\n/).filter((l) => l.trim())) {
      await this.writeLog(taskId, "error", line, `${source}:stderr`, {});
      count++;
    }

    return count;
  }

  /**
   * Tear down observability data for a task (ephemeral per worktree).
   */
  public async teardown(taskId: string): Promise<void> {
    this.stores.delete(taskId);
  }

  private getOrCreateStore(taskId: string): ObservabilityStore {
    let store = this.stores.get(taskId);
    if (!store) {
      store = { ...EMPTY_STORE, logs: [], metrics: [], traces: [] };
      this.stores.set(taskId, store);
    }
    return store;
  }

  private parseLogLine(line: string): { level: LogLevel; message: string; metadata: Record<string, unknown> } {
    // Try JSON structured log format
    try {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      if (typeof parsed.message === "string" || typeof parsed.msg === "string") {
        return {
          level: this.normalizeLevel((parsed.level ?? parsed.severity ?? "info") as string),
          message: (parsed.message ?? parsed.msg) as string,
          metadata: parsed,
        };
      }
    } catch {
      // Not JSON
    }

    // Try common log format: [LEVEL] message or LEVEL: message
    const levelMatch = /^\[?(DEBUG|INFO|WARN|WARNING|ERROR)\]?\s*:?\s*(.+)/i.exec(line);
    if (levelMatch) {
      return {
        level: this.normalizeLevel(levelMatch[1] as string),
        message: levelMatch[2] as string,
        metadata: {},
      };
    }

    return { level: "info", message: line, metadata: {} };
  }

  private normalizeLevel(raw: string): LogLevel {
    const lower = raw.toLowerCase();
    if (lower === "debug" || lower === "trace") return "debug";
    if (lower === "warn" || lower === "warning") return "warn";
    if (lower === "error" || lower === "fatal" || lower === "critical") return "error";
    return "info";
  }

  private async appendLogToDisk(taskId: string, entry: StructuredLogEntry): Promise<void> {
    try {
      const wsPath = this.workspaceManager.resolveWorkspacePath(taskId);
      const logDir = resolve(wsPath, ".gpc-codex-controller", "observability");
      await mkdir(logDir, { recursive: true });
      const logFile = resolve(logDir, "structured-logs.jsonl");
      await appendFile(logFile, JSON.stringify(entry) + "\n", "utf8");
    } catch {
      // Non-critical: in-memory store is the primary
    }
  }

  private async loadLogsFromDisk(taskId: string, store: ObservabilityStore): Promise<void> {
    try {
      const wsPath = this.workspaceManager.resolveWorkspacePath(taskId);
      const logFile = resolve(wsPath, ".gpc-codex-controller", "observability", "structured-logs.jsonl");
      await stat(logFile);
      const raw = await readFile(logFile, "utf8");
      const diskEntries: StructuredLogEntry[] = raw.split("\n").filter((line: string) => line.trim()).map((line: string): StructuredLogEntry | null => {
        try {
          return JSON.parse(line) as StructuredLogEntry;
        } catch {
          return null;
        }
      }).filter((entry: StructuredLogEntry | null): entry is StructuredLogEntry => entry !== null);

      // Merge: only add entries that aren't already in memory (by timestamp)
      const existing = new Set(store.logs.map((e) => e.timestamp + e.message));
      for (const entry of diskEntries) {
        if (!existing.has(entry.timestamp + entry.message)) {
          store.logs.push(entry);
        }
      }

      store.logs.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
      if (store.logs.length > MAX_LOG_ENTRIES) {
        store.logs = store.logs.slice(-MAX_LOG_ENTRIES);
      }
    } catch {
      // No disk logs
    }
  }

  private generateId(): string {
    return crypto.randomBytes(8).toString("hex");
  }
}
