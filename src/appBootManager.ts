import { spawn, type ChildProcess } from "node:child_process";
import type { WorkspaceManager } from "./workspaceManager.js";
import type { AppBootResult } from "./types.js";

const BOOT_TIMEOUT_MS = 30_000;
const HEALTH_CHECK_INTERVAL_MS = 2_000;
const DEFAULT_PORT = 3000;

export class AppBootManager {
  private readonly processes = new Map<string, ChildProcess>();

  public constructor(private readonly workspaceManager: WorkspaceManager) {}

  public async bootApp(taskId: string): Promise<AppBootResult> {
    const workspacePath = this.workspaceManager.getWorkspacePath(taskId);

    // Stop any existing process for this task
    await this.stopApp(taskId);

    try {
      const child = spawn("pnpm", ["dev"], {
        cwd: workspacePath,
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, PORT: String(DEFAULT_PORT) },
        detached: false,
      });

      this.processes.set(taskId, child);

      let stderr = "";
      child.stderr?.on("data", (chunk: Buffer) => {
        stderr += chunk.toString("utf8");
      });

      child.on("exit", () => {
        this.processes.delete(taskId);
      });

      // Wait for health check
      const healthy = await this.waitForHealth(taskId, BOOT_TIMEOUT_MS);

      if (!healthy) {
        await this.stopApp(taskId);
        return {
          taskId,
          started: false,
          healthCheck: false,
          url: null,
          pid: null,
          error: stderr.slice(0, 500) || "Health check timed out",
        };
      }

      return {
        taskId,
        started: true,
        healthCheck: true,
        url: `http://localhost:${DEFAULT_PORT}`,
        pid: child.pid ?? null,
        error: null,
      };
    } catch (error) {
      return {
        taskId,
        started: false,
        healthCheck: false,
        url: null,
        pid: null,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  public async checkHealth(taskId: string): Promise<boolean> {
    try {
      const response = await fetch(`http://localhost:${DEFAULT_PORT}/healthz`, {
        signal: AbortSignal.timeout(5_000),
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  public async stopApp(taskId: string): Promise<void> {
    const child = this.processes.get(taskId);
    if (!child) {
      return;
    }

    child.kill("SIGTERM");
    this.processes.delete(taskId);

    // Give it a moment to shut down
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        child.kill("SIGKILL");
        resolve();
      }, 5_000);

      child.on("exit", () => {
        clearTimeout(timeout);
        resolve();
      });
    });
  }

  public getRunningApps(): string[] {
    return [...this.processes.keys()];
  }

  private async waitForHealth(taskId: string, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      const healthy = await this.checkHealth(taskId);
      if (healthy) {
        return true;
      }

      // Check if process is still alive
      const child = this.processes.get(taskId);
      if (!child || child.exitCode !== null) {
        return false;
      }

      await new Promise<void>((resolve) => setTimeout(resolve, HEALTH_CHECK_INTERVAL_MS));
    }

    return false;
  }
}
