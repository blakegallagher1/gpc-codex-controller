/**
 * AlertManager — Monitoring and alerting for task failures, CI regressions,
 * quality score drops, and autonomous run aborts.
 *
 * Supports channels: Slack webhook, generic webhook, console/log.
 * Includes deduplication (5-minute window), muting, and FIFO history.
 * Persists config and history to JSON files (atomic write via temp+rename).
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import crypto from "node:crypto";
import type {
  AlertChannelConfig,
  AlertChannelType,
  AlertConfig,
  AlertEvent,
  AlertMuteRule,
  AlertSeverity,
} from "./types.js";

const MAX_HISTORY_ENTRIES = 1000;
const DEDUP_WINDOW_MS = 5 * 60 * 1000; // 5 minutes

const DEFAULT_CONFIG: AlertConfig = {
  channels: [
    { type: "console", enabled: true },
  ],
  updatedAt: new Date().toISOString(),
};

export class AlertManager {
  private readonly configPath: string;
  private readonly historyPath: string;

  private config: AlertConfig | null = null;
  private history: AlertEvent[] = [];
  private muteRules: AlertMuteRule[] = [];
  private configLoaded = false;
  private historyLoaded = false;

  public constructor(configPath: string, historyPath: string) {
    this.configPath = configPath;
    this.historyPath = historyPath;
  }

  /**
   * Send an alert event. Dispatches to all enabled channels.
   * Respects deduplication and mute rules.
   */
  public async sendAlert(params: {
    severity: AlertSeverity;
    source: string;
    title: string;
    message: string;
    metadata?: Record<string, unknown>;
  }): Promise<AlertEvent> {
    await this.ensureConfigLoaded();
    await this.ensureHistoryLoaded();

    const event: AlertEvent = {
      id: `alert_${crypto.randomBytes(8).toString("hex")}`,
      severity: params.severity,
      source: params.source,
      title: params.title,
      message: params.message,
      metadata: params.metadata ?? {},
      timestamp: new Date().toISOString(),
      dispatched: false,
      channels: [],
    };

    // Check mute rules
    this.pruneExpiredMutes();
    if (this.isMuted(event)) {
      event.dispatched = false;
      this.addToHistory(event);
      await this.persistHistory();
      return event;
    }

    // Check deduplication
    if (this.isDuplicate(event)) {
      event.dispatched = false;
      this.addToHistory(event);
      await this.persistHistory();
      return event;
    }

    // Dispatch to channels
    const dispatched: AlertChannelType[] = [];
    for (const channel of this.config!.channels) {
      if (!channel.enabled) continue;

      try {
        await this.dispatchToChannel(channel, event);
        dispatched.push(channel.type);
      } catch {
        // Channel dispatch failure is non-critical
      }
    }

    event.dispatched = dispatched.length > 0;
    event.channels = dispatched;
    this.addToHistory(event);
    await this.persistHistory();
    return event;
  }

  /**
   * Get current alert configuration.
   */
  public async getAlertConfig(): Promise<AlertConfig> {
    await this.ensureConfigLoaded();
    return this.config!;
  }

  /**
   * Set alert configuration (replace channels list).
   */
  public async setAlertConfig(config: {
    channels?: AlertChannelConfig[];
  }): Promise<AlertConfig> {
    await this.ensureConfigLoaded();

    if (config.channels) {
      this.config!.channels = config.channels;
    }
    this.config!.updatedAt = new Date().toISOString();
    await this.persistConfig();
    return this.config!;
  }

  /**
   * Get alert history. Most recent first.
   */
  public async getAlertHistory(limit = 50): Promise<AlertEvent[]> {
    await this.ensureHistoryLoaded();
    return [...this.history].reverse().slice(0, limit);
  }

  /**
   * Temporarily suppress alerts matching a pattern.
   */
  public async muteAlert(pattern: string, durationMs: number): Promise<AlertMuteRule> {
    const rule: AlertMuteRule = {
      pattern,
      expiresAt: new Date(Date.now() + durationMs).toISOString(),
      createdAt: new Date().toISOString(),
    };
    this.muteRules.push(rule);
    return rule;
  }

  /**
   * Get active mute rules.
   */
  public getActiveMuteRules(): AlertMuteRule[] {
    this.pruneExpiredMutes();
    return [...this.muteRules];
  }

  private isDuplicate(event: AlertEvent): boolean {
    const cutoff = Date.now() - DEDUP_WINDOW_MS;
    return this.history.some(
      (h) =>
        h.title === event.title &&
        h.source === event.source &&
        h.severity === event.severity &&
        new Date(h.timestamp).getTime() > cutoff,
    );
  }

  private isMuted(event: AlertEvent): boolean {
    return this.muteRules.some((rule) => {
      const pattern = rule.pattern.toLowerCase();
      return (
        event.title.toLowerCase().includes(pattern) ||
        event.source.toLowerCase().includes(pattern) ||
        event.message.toLowerCase().includes(pattern)
      );
    });
  }

  private pruneExpiredMutes(): void {
    const now = Date.now();
    this.muteRules = this.muteRules.filter(
      (rule) => new Date(rule.expiresAt).getTime() > now,
    );
  }

  private async dispatchToChannel(channel: AlertChannelConfig, event: AlertEvent): Promise<void> {
    switch (channel.type) {
      case "console":
        this.dispatchToConsole(event);
        break;
      case "slack":
        if (channel.url) {
          await this.dispatchToSlack(channel.url, event);
        }
        break;
      case "webhook":
        if (channel.url) {
          await this.dispatchToWebhook(channel.url, event);
        }
        break;
    }
  }

  private dispatchToConsole(event: AlertEvent): void {
    const prefix = `[ALERT:${event.severity.toUpperCase()}]`;
    const line = `${prefix} [${event.source}] ${event.title}: ${event.message}`;
    if (event.severity === "critical" || event.severity === "error") {
      console.error(line);
    } else {
      console.log(line);
    }
  }

  private async dispatchToSlack(url: string, event: AlertEvent): Promise<void> {
    const severityEmoji: Record<AlertSeverity, string> = {
      info: ":information_source:",
      warning: ":warning:",
      error: ":x:",
      critical: ":rotating_light:",
    };
    const payload = {
      text: `${severityEmoji[event.severity]} *${event.title}*\nSource: ${event.source}\n${event.message}`,
    };

    const slackUrl = process.env.SLACK_WEBHOOK_URL ?? url;
    await fetch(slackUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  }

  private async dispatchToWebhook(url: string, event: AlertEvent): Promise<void> {
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(event),
    });
  }

  private addToHistory(event: AlertEvent): void {
    this.history.push(event);
    if (this.history.length > MAX_HISTORY_ENTRIES) {
      const excess = this.history.length - MAX_HISTORY_ENTRIES;
      this.history.splice(0, excess);
    }
  }

  private async ensureConfigLoaded(): Promise<void> {
    if (this.configLoaded) return;
    try {
      const raw = await readFile(this.configPath, "utf8");
      this.config = JSON.parse(raw) as AlertConfig;
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        (error as { code?: unknown }).code === "ENOENT"
      ) {
        this.config = { ...DEFAULT_CONFIG, channels: [...DEFAULT_CONFIG.channels] };
      } else {
        throw error;
      }
    }
    this.configLoaded = true;
  }

  private async ensureHistoryLoaded(): Promise<void> {
    if (this.historyLoaded) return;
    try {
      const raw = await readFile(this.historyPath, "utf8");
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        this.history = parsed;
      }
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        (error as { code?: unknown }).code === "ENOENT"
      ) {
        this.history = [];
      } else {
        throw error;
      }
    }
    this.historyLoaded = true;
  }

  private async persistConfig(): Promise<void> {
    await mkdir(dirname(this.configPath), { recursive: true });
    const tmpPath = `${this.configPath}.tmp`;
    await writeFile(tmpPath, JSON.stringify(this.config, null, 2), "utf8");
    await rename(tmpPath, this.configPath);
  }

  private async persistHistory(): Promise<void> {
    await mkdir(dirname(this.historyPath), { recursive: true });
    const tmpPath = `${this.historyPath}.tmp`;
    await writeFile(tmpPath, JSON.stringify(this.history, null, 2), "utf8");
    await rename(tmpPath, this.historyPath);
  }
}
