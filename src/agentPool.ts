/**
 * Agent Pool Manager — manages a pool of concurrent Codex agents with
 * resource-aware scheduling, configurable turn budgets, and unified monitoring.
 *
 * This replaces the simple Promise.allSettled fan-out with:
 *  - Resource-aware scheduling (respects system limits)
 *  - Configurable per-task turn budgets (not fixed at 5)
 *  - Agent lifecycle management (start, monitor, cancel)
 *  - Unified monitoring dashboard data
 *  - Backpressure when pool is at capacity
 */

import crypto from "node:crypto";

export type AgentStatus = "queued" | "running" | "completed" | "failed" | "cancelled";

export interface AgentConfig {
  /** Max Codex turns for this agent. Default: 30 (supports multi-hour tasks). */
  maxTurns: number;
  /** Priority: higher runs first. Default: 0 */
  priority: number;
  /** Timeout in ms for the entire agent run. Default: 6 * 60 * 60 * 1000 (6 hours). */
  timeoutMs: number;
}

export interface AgentEntry {
  agentId: string;
  taskId: string;
  objective: string;
  config: AgentConfig;
  status: AgentStatus;
  currentTurn: number;
  startedAt: string | null;
  completedAt: string | null;
  lastActivityAt: string;
  error: string | null;
  result: unknown | null;
}

export interface PoolConfig {
  /** Max concurrent agents. Default: 5 */
  maxConcurrent: number;
  /** Default max turns per agent. Default: 30 */
  defaultMaxTurns: number;
  /** Default timeout per agent in ms. Default: 6 hours. */
  defaultTimeoutMs: number;
}

export interface PoolStatus {
  totalAgents: number;
  running: number;
  queued: number;
  completed: number;
  failed: number;
  cancelled: number;
  maxConcurrent: number;
  agents: AgentEntry[];
}

const DEFAULT_POOL_CONFIG: PoolConfig = {
  maxConcurrent: 5,
  defaultMaxTurns: 30,
  defaultTimeoutMs: 6 * 60 * 60 * 1000,
};

export class AgentPool {
  private readonly config: PoolConfig;
  private agents = new Map<string, AgentEntry>();
  private runningCount = 0;
  private executeFn: ((entry: AgentEntry) => Promise<unknown>) | null = null;

  public constructor(config: Partial<PoolConfig> = {}) {
    this.config = { ...DEFAULT_POOL_CONFIG, ...config };
  }

  /**
   * Set the execution function that runs an agent. This is injected by the
   * controller so the pool doesn't depend on controller internals.
   */
  public setExecutor(fn: (entry: AgentEntry) => Promise<unknown>): void {
    this.executeFn = fn;
  }

  /**
   * Submit a new agent to the pool. It will be queued and executed when
   * capacity is available.
   */
  public async submit(
    taskId: string,
    objective: string,
    config: Partial<AgentConfig> = {},
  ): Promise<AgentEntry> {
    const agentId = `agent_${crypto.randomBytes(6).toString("hex")}`;
    const now = new Date().toISOString();

    const entry: AgentEntry = {
      agentId,
      taskId,
      objective,
      config: {
        maxTurns: config.maxTurns ?? this.config.defaultMaxTurns,
        priority: config.priority ?? 0,
        timeoutMs: config.timeoutMs ?? this.config.defaultTimeoutMs,
      },
      status: "queued",
      currentTurn: 0,
      startedAt: null,
      completedAt: null,
      lastActivityAt: now,
      error: null,
      result: null,
    };

    this.agents.set(agentId, entry);

    // Try to schedule immediately
    void this.scheduleNext();

    return entry;
  }

  /**
   * Submit multiple agents and return when all complete.
   */
  public async submitBatch(
    tasks: Array<{ taskId: string; objective: string; config?: Partial<AgentConfig> }>,
  ): Promise<AgentEntry[]> {
    const entries: AgentEntry[] = [];
    for (const task of tasks) {
      const entry = await this.submit(task.taskId, task.objective, task.config);
      entries.push(entry);
    }

    // Wait for all to complete
    await this.waitForAll(entries.map((e) => e.agentId));
    return entries.map((e) => this.agents.get(e.agentId) ?? e);
  }

  /**
   * Cancel a running or queued agent.
   */
  public cancel(agentId: string): boolean {
    const entry = this.agents.get(agentId);
    if (!entry) return false;
    if (entry.status === "completed" || entry.status === "failed" || entry.status === "cancelled") {
      return false;
    }

    const wasRunning = entry.status === "running";
    entry.status = "cancelled";
    entry.completedAt = new Date().toISOString();
    if (wasRunning) {
      this.runningCount = Math.max(0, this.runningCount - 1);
    }

    // Schedule next queued agent
    void this.scheduleNext();
    return true;
  }

  /**
   * Get the current status of a specific agent.
   */
  public getAgent(agentId: string): AgentEntry | null {
    return this.agents.get(agentId) ?? null;
  }

  /**
   * Get the overall pool status for monitoring/dashboard.
   */
  public getStatus(): PoolStatus {
    const agents = Array.from(this.agents.values());
    return {
      totalAgents: agents.length,
      running: agents.filter((a) => a.status === "running").length,
      queued: agents.filter((a) => a.status === "queued").length,
      completed: agents.filter((a) => a.status === "completed").length,
      failed: agents.filter((a) => a.status === "failed").length,
      cancelled: agents.filter((a) => a.status === "cancelled").length,
      maxConcurrent: this.config.maxConcurrent,
      agents: agents.sort((a, b) => {
        // Running first, then queued, then completed
        const order: Record<AgentStatus, number> = {
          running: 0, queued: 1, completed: 2, failed: 3, cancelled: 4,
        };
        return (order[a.status] ?? 5) - (order[b.status] ?? 5);
      }),
    };
  }

  /**
   * Update the turn count for an agent (called by controller during execution).
   */
  public recordTurn(agentId: string): void {
    const entry = this.agents.get(agentId);
    if (entry) {
      entry.currentTurn += 1;
      entry.lastActivityAt = new Date().toISOString();
    }
  }

  /**
   * Check if an agent has exceeded its turn budget.
   */
  public isOverBudget(agentId: string): boolean {
    const entry = this.agents.get(agentId);
    if (!entry) return true;
    return entry.currentTurn >= entry.config.maxTurns;
  }

  /**
   * Update pool configuration.
   */
  public updateConfig(config: Partial<PoolConfig>): void {
    if (config.maxConcurrent !== undefined) {
      this.config.maxConcurrent = config.maxConcurrent;
    }
    if (config.defaultMaxTurns !== undefined) {
      this.config.defaultMaxTurns = config.defaultMaxTurns;
    }
    if (config.defaultTimeoutMs !== undefined) {
      this.config.defaultTimeoutMs = config.defaultTimeoutMs;
    }
    // Potentially schedule more agents if we increased capacity
    void this.scheduleNext();
  }

  /**
   * Remove completed/failed/cancelled agents from the pool.
   */
  public prune(): number {
    let pruned = 0;
    for (const [id, entry] of this.agents) {
      if (entry.status === "completed" || entry.status === "failed" || entry.status === "cancelled") {
        this.agents.delete(id);
        pruned++;
      }
    }
    return pruned;
  }

  private async scheduleNext(): Promise<void> {
    if (!this.executeFn) return;

    while (this.runningCount < this.config.maxConcurrent) {
      const next = this.getNextQueued();
      if (!next) break;

      this.runningCount++;
      next.status = "running";
      next.startedAt = new Date().toISOString();
      next.lastActivityAt = new Date().toISOString();

      // Fire and forget — errors are captured in the entry
      void this.executeAgent(next);
    }
  }

  private getNextQueued(): AgentEntry | null {
    const queued = Array.from(this.agents.values())
      .filter((a) => a.status === "queued")
      .sort((a, b) => b.config.priority - a.config.priority);

    return queued[0] ?? null;
  }

  private async executeAgent(entry: AgentEntry): Promise<void> {
    const timeoutId = setTimeout(() => {
      if (entry.status === "running") {
        entry.status = "failed";
        entry.error = `Agent timed out after ${entry.config.timeoutMs}ms`;
        entry.completedAt = new Date().toISOString();
        this.runningCount = Math.max(0, this.runningCount - 1);
        void this.scheduleNext();
      }
    }, entry.config.timeoutMs);

    try {
      const result = await this.executeFn!(entry);
      clearTimeout(timeoutId);

      if (entry.status === "cancelled") {
        // Was cancelled during execution
        return;
      }

      entry.status = "completed";
      entry.result = result;
      entry.completedAt = new Date().toISOString();
    } catch (error) {
      clearTimeout(timeoutId);

      if (entry.status === "cancelled") return;

      entry.status = "failed";
      entry.error = error instanceof Error ? error.message : String(error);
      entry.completedAt = new Date().toISOString();
    } finally {
      this.runningCount = Math.max(0, this.runningCount - 1);
      void this.scheduleNext();
    }
  }

  private waitForAll(agentIds: string[]): Promise<void> {
    return new Promise((resolve) => {
      const check = () => {
        const allDone = agentIds.every((id) => {
          const entry = this.agents.get(id);
          return !entry || entry.status === "completed" || entry.status === "failed" || entry.status === "cancelled";
        });

        if (allDone) {
          resolve();
        } else {
          setTimeout(check, 1000);
        }
      };

      check();
    });
  }
}
