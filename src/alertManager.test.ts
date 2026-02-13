import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { AlertManager } from "./alertManager.js";
import { tmpStateFile, cleanupTmpFiles } from "./test-helpers.js";

describe("AlertManager", () => {
  let mgr: AlertManager;

  beforeEach(async () => {
    mgr = new AlertManager(tmpStateFile("alert-cfg"), tmpStateFile("alert-hist"));
  });

  afterAll(async () => {
    await cleanupTmpFiles();
  });

  const baseAlert = {
    severity: "warning" as const,
    source: "ci",
    title: "Build failed",
    message: "Exit code 1",
  };

  it("sends an alert and returns event with dispatched=true", async () => {
    const event = await mgr.sendAlert(baseAlert);
    expect(event.id).toMatch(/^alert_/);
    expect(event.severity).toBe("warning");
    expect(event.dispatched).toBe(true);
    expect(event.channels).toContain("console");
  });

  it("populates metadata field (default empty)", async () => {
    const event = await mgr.sendAlert(baseAlert);
    expect(event.metadata).toEqual({});
  });

  it("passes through custom metadata", async () => {
    const event = await mgr.sendAlert({ ...baseAlert, metadata: { taskId: "t-1" } });
    expect(event.metadata).toEqual({ taskId: "t-1" });
  });

  describe("deduplication", () => {
    it("deduplicates identical alerts within 5-minute window", async () => {
      const first = await mgr.sendAlert(baseAlert);
      expect(first.dispatched).toBe(true);

      const second = await mgr.sendAlert(baseAlert);
      expect(second.dispatched).toBe(false);
    });

    it("does not dedup alerts with different titles", async () => {
      const a = await mgr.sendAlert(baseAlert);
      const b = await mgr.sendAlert({ ...baseAlert, title: "Different title" });
      expect(a.dispatched).toBe(true);
      expect(b.dispatched).toBe(true);
    });

    it("does not dedup alerts with different severity", async () => {
      const a = await mgr.sendAlert(baseAlert);
      const b = await mgr.sendAlert({ ...baseAlert, severity: "critical" });
      expect(a.dispatched).toBe(true);
      expect(b.dispatched).toBe(true);
    });
  });

  describe("muting", () => {
    it("suppresses alerts matching mute pattern (case-insensitive)", async () => {
      await mgr.muteAlert("build", 60_000);
      const event = await mgr.sendAlert(baseAlert);
      expect(event.dispatched).toBe(false);
    });

    it("mute matches against source", async () => {
      await mgr.muteAlert("ci", 60_000);
      const event = await mgr.sendAlert(baseAlert);
      expect(event.dispatched).toBe(false);
    });

    it("mute matches against message", async () => {
      await mgr.muteAlert("exit code", 60_000);
      const event = await mgr.sendAlert(baseAlert);
      expect(event.dispatched).toBe(false);
    });

    it("does not suppress non-matching alerts", async () => {
      await mgr.muteAlert("deployment", 60_000);
      const event = await mgr.sendAlert(baseAlert);
      expect(event.dispatched).toBe(true);
    });

    it("getActiveMuteRules returns active rules", async () => {
      await mgr.muteAlert("test", 60_000);
      const rules = mgr.getActiveMuteRules();
      expect(rules).toHaveLength(1);
      expect(rules[0]!.pattern).toBe("test");
    });

    it("prunes expired mute rules", async () => {
      await mgr.muteAlert("expired", 0);
      await new Promise((r) => setTimeout(r, 5));
      const rules = mgr.getActiveMuteRules();
      expect(rules).toHaveLength(0);
    });
  });

  describe("config", () => {
    it("returns default config with console channel", async () => {
      const config = await mgr.getAlertConfig();
      expect(config.channels).toHaveLength(1);
      expect(config.channels[0]!.type).toBe("console");
      expect(config.channels[0]!.enabled).toBe(true);
    });

    it("setAlertConfig replaces channels", async () => {
      const updated = await mgr.setAlertConfig({
        channels: [
          { type: "slack", enabled: true, url: "https://hooks.slack.com/test" },
        ],
      });
      expect(updated.channels).toHaveLength(1);
      expect(updated.channels[0]!.type).toBe("slack");
    });

    it("setAlertConfig updates updatedAt", async () => {
      const before = await mgr.getAlertConfig();
      await new Promise((r) => setTimeout(r, 5));
      const after = await mgr.setAlertConfig({ channels: before.channels });
      expect(new Date(after.updatedAt).getTime()).toBeGreaterThanOrEqual(
        new Date(before.updatedAt).getTime(),
      );
    });
  });

  describe("history", () => {
    it("returns history in reverse chronological order", async () => {
      await mgr.sendAlert({ ...baseAlert, title: "First" });
      await mgr.sendAlert({ ...baseAlert, title: "Second" });
      await mgr.sendAlert({ ...baseAlert, title: "Third" });

      const history = await mgr.getAlertHistory();
      expect(history[0]!.title).toBe("Third");
      expect(history[2]!.title).toBe("First");
    });

    it("respects limit parameter", async () => {
      for (let i = 0; i < 5; i++) {
        await mgr.sendAlert({ ...baseAlert, title: `Alert ${i}` });
      }
      const history = await mgr.getAlertHistory(2);
      expect(history).toHaveLength(2);
    });

    it("enforces MAX_HISTORY_ENTRIES (1000)", async () => {
      const cfgPath = tmpStateFile("hist-cfg");
      const histPath = tmpStateFile("hist-hist");
      const m = new AlertManager(cfgPath, histPath);

      for (let i = 0; i < 1010; i++) {
        await m.sendAlert({ ...baseAlert, title: `Alert #${i}` });
      }
      const history = await m.getAlertHistory(2000);
      expect(history.length).toBeLessThanOrEqual(1000);
    });
  });
});
