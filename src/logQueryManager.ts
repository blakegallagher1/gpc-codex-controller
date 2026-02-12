import type { WorkspaceManager } from "./workspaceManager.js";
import type { LogQueryResult } from "./types.js";

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;

export class LogQueryManager {
  public constructor(private readonly workspaceManager: WorkspaceManager) {}

  public async queryLogs(taskId: string, pattern: string, limit = DEFAULT_LIMIT): Promise<LogQueryResult> {
    const effectiveLimit = Math.min(Math.max(1, limit), MAX_LIMIT);

    try {
      // Search through workspace files for the pattern
      const result = await this.workspaceManager.runInWorkspaceAllowNonZero(taskId, [
        "git", "log", "--all", "--oneline", `--grep=${pattern}`, `-${effectiveLimit}`,
      ]);

      const lines = result.stdout
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter((l) => l.length > 0);

      return {
        taskId,
        pattern,
        matchCount: lines.length,
        lines: lines.slice(0, effectiveLimit),
        truncated: lines.length >= effectiveLimit,
      };
    } catch {
      return {
        taskId,
        pattern,
        matchCount: 0,
        lines: [],
        truncated: false,
      };
    }
  }

  public async getRecentErrors(taskId: string, limit = 20): Promise<LogQueryResult> {
    try {
      const result = await this.workspaceManager.runInWorkspaceAllowNonZero(taskId, [
        "git", "log", "--all", "--oneline", "--grep=error", "--grep=Error", "--grep=ERROR",
        `-${limit}`,
      ]);

      const lines = result.stdout
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter((l) => l.length > 0);

      return {
        taskId,
        pattern: "error|Error|ERROR",
        matchCount: lines.length,
        lines,
        truncated: false,
      };
    } catch {
      return {
        taskId,
        pattern: "error|Error|ERROR",
        matchCount: 0,
        lines: [],
        truncated: false,
      };
    }
  }

  public async getVerifyOutput(taskId: string, tailLines = 50): Promise<LogQueryResult> {
    try {
      const result = await this.workspaceManager.runInWorkspaceAllowNonZero(taskId, ["pnpm", "verify"]);
      const combined = `${result.stdout}\n${result.stderr}`;
      const lines = combined
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter((l) => l.length > 0);

      const tail = lines.slice(-tailLines);

      return {
        taskId,
        pattern: "pnpm verify",
        matchCount: lines.length,
        lines: tail,
        truncated: lines.length > tailLines,
      };
    } catch (error) {
      return {
        taskId,
        pattern: "pnpm verify",
        matchCount: 0,
        lines: [error instanceof Error ? error.message : String(error)],
        truncated: false,
      };
    }
  }
}
