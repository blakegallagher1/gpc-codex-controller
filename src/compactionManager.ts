import { readFile, rename, writeFile } from "node:fs/promises";
import type { CompactionConfig, CompactionEvent } from "./types.js";
import type { AppServerClient } from "./appServerClient.js";

/**
 * Token-aware compaction manager.
 *
 * Article tip #4:
 * "Long-horizon agents rarely succeed as one-shot prompts. Plan for continuity.
 *  Use compaction as a default long-run primitive, not an emergency fallback."
 *
 * Replaces the naive every-N-turns counter with a strategy-based approach:
 * - turn-interval: Original behavior (compact every N turns)
 * - token-threshold: Estimate tokens and compact when threshold exceeded
 * - auto: Compact when estimated context reaches N% of max window
 */

// Rough token estimation: ~4 chars per token for English text/code
const CHARS_PER_TOKEN = 4;

const DEFAULT_CONFIG: CompactionConfig = {
  strategy: "auto",
  turnInterval: 3,
  tokenThreshold: 80_000,
  autoThresholdPercent: 70,
  maxContextTokens: 200_000, // gpt-5.2-codex context window
};

const MAX_EVENTS = 200;

export class CompactionManager {
  private readonly historyPath: string;
  private readonly appServerClient: AppServerClient;
  private config: CompactionConfig;
  private events: CompactionEvent[] = [];
  private loaded = false;

  // Per-thread tracking
  private readonly turnCountByThread = new Map<string, number>();
  private readonly estimatedTokensByThread = new Map<string, number>();
  private readonly promptHistoryByThread = new Map<string, string[]>();

  public constructor(
    historyPath: string,
    appServerClient: AppServerClient,
    config?: Partial<CompactionConfig>,
  ) {
    this.historyPath = historyPath;
    this.appServerClient = appServerClient;
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Track a turn's prompt size and decide whether compaction is needed.
   * Call this after each turn completes.
   *
   * Returns true if compaction was triggered.
   */
  public async trackAndCompactIfNeeded(
    threadId: string,
    promptText: string,
    responseEstimateChars?: number,
  ): Promise<boolean> {
    // Update turn count
    const turns = (this.turnCountByThread.get(threadId) ?? 0) + 1;
    this.turnCountByThread.set(threadId, turns);

    // Update token estimate
    const promptTokens = Math.ceil(promptText.length / CHARS_PER_TOKEN);
    const responseTokens = responseEstimateChars
      ? Math.ceil(responseEstimateChars / CHARS_PER_TOKEN)
      : promptTokens * 2; // rough: assume response is ~2x prompt

    const currentEstimate = (this.estimatedTokensByThread.get(threadId) ?? 0)
      + promptTokens + responseTokens;
    this.estimatedTokensByThread.set(threadId, currentEstimate);

    // Store prompt for context size tracking
    const history = this.promptHistoryByThread.get(threadId) ?? [];
    history.push(promptText);
    this.promptHistoryByThread.set(threadId, history);

    // Decide based on strategy
    const shouldCompact = this.shouldCompact(threadId, turns, currentEstimate);

    if (shouldCompact) {
      await this.executeCompaction(threadId, turns, currentEstimate);
      return true;
    }

    return false;
  }

  /**
   * Force compaction regardless of strategy/thresholds.
   */
  public async forceCompact(threadId: string): Promise<boolean> {
    const turns = this.turnCountByThread.get(threadId) ?? 0;
    const tokens = this.estimatedTokensByThread.get(threadId) ?? 0;
    await this.executeCompaction(threadId, turns, tokens);
    return true;
  }

  /**
   * Get current compaction config.
   */
  public getConfig(): CompactionConfig {
    return { ...this.config };
  }

  /**
   * Update compaction config.
   */
  public setConfig(config: Partial<CompactionConfig>): CompactionConfig {
    this.config = { ...this.config, ...config };
    return { ...this.config };
  }

  /**
   * Get estimated context usage for a thread.
   */
  public getContextUsage(threadId: string): {
    estimatedTokens: number;
    maxTokens: number;
    percentUsed: number;
    turnCount: number;
  } {
    const estimatedTokens = this.estimatedTokensByThread.get(threadId) ?? 0;
    const maxTokens = this.config.maxContextTokens;
    return {
      estimatedTokens,
      maxTokens,
      percentUsed: maxTokens > 0 ? Math.round((estimatedTokens / maxTokens) * 100) : 0,
      turnCount: this.turnCountByThread.get(threadId) ?? 0,
    };
  }

  /**
   * Get compaction event history.
   */
  public async getHistory(limit?: number): Promise<CompactionEvent[]> {
    await this.loadHistory();
    const max = limit ?? 50;
    return this.events.slice(-max);
  }

  private shouldCompact(threadId: string, turns: number, estimatedTokens: number): boolean {
    switch (this.config.strategy) {
      case "turn-interval":
        return turns > 0 && turns % this.config.turnInterval === 0;

      case "token-threshold":
        return estimatedTokens >= this.config.tokenThreshold;

      case "auto": {
        const percentUsed = (estimatedTokens / this.config.maxContextTokens) * 100;
        return percentUsed >= this.config.autoThresholdPercent;
      }

      default:
        return false;
    }
  }

  private async executeCompaction(
    threadId: string,
    turnNumber: number,
    estimatedTokensBefore: number,
  ): Promise<void> {
    try {
      await this.appServerClient.compactThread(threadId);

      // After compaction, estimate ~30% of original context remains
      const estimatedTokensAfter = Math.ceil(estimatedTokensBefore * 0.3);
      this.estimatedTokensByThread.set(threadId, estimatedTokensAfter);

      // Record event
      const event: CompactionEvent = {
        threadId,
        timestamp: new Date().toISOString(),
        strategy: this.config.strategy,
        estimatedTokensBefore,
        estimatedTokensAfter,
        turnNumber,
      };

      await this.loadHistory();
      this.events.push(event);

      // Trim history
      if (this.events.length > MAX_EVENTS) {
        this.events = this.events.slice(-MAX_EVENTS);
      }

      await this.saveHistory();
    } catch {
      // Compaction is best-effort; failures should not abort the workflow.
    }
  }

  private async loadHistory(): Promise<void> {
    if (this.loaded) {
      return;
    }

    try {
      const raw = await readFile(this.historyPath, "utf8");
      this.events = JSON.parse(raw) as CompactionEvent[];
    } catch {
      this.events = [];
    }

    this.loaded = true;
  }

  private async saveHistory(): Promise<void> {
    const tmpPath = `${this.historyPath}.tmp`;
    await writeFile(tmpPath, JSON.stringify(this.events, null, 2), "utf8");
    await rename(tmpPath, this.historyPath);
  }
}
