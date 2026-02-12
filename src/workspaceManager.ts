import { mkdir, readdir, stat } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { spawn } from "node:child_process";

const DEFAULT_REPO_URL = "https://github.com/blakegallagher1/gpc-cres";
const DEFAULT_WORKSPACES_ROOT = "/workspaces";
const OUTPUT_LIMIT_BYTES = 2 * 1024 * 1024;

export interface WorkspaceManagerOptions {
  repoUrl?: string;
  workspacesRoot?: string;
}

export interface CommandResult {
  command: readonly string[];
  cwd: string;
  exitCode: number;
  stdout: string;
  stderr: string;
}

export class WorkspaceManager {
  private readonly repoUrl: string;
  private readonly workspacesRoot: string;

  public constructor(options: WorkspaceManagerOptions = {}) {
    this.repoUrl = options.repoUrl ?? DEFAULT_REPO_URL;
    this.workspacesRoot = resolve(options.workspacesRoot ?? DEFAULT_WORKSPACES_ROOT);
  }

  public async createWorkspace(taskId: string): Promise<string> {
    const workspacePath = this.resolveWorkspacePath(taskId);

    await mkdir(this.workspacesRoot, { recursive: true });

    if (await this.pathExists(workspacePath)) {
      await this.assertDirectory(workspacePath);
      const entries = await readdir(workspacePath);

      if (entries.length === 0) {
        await this.cloneInto(workspacePath);
        return workspacePath;
      }

      if (!entries.includes(".git")) {
        throw new Error(
          `Workspace path already exists and is not an initialized git repository: ${workspacePath}`,
        );
      }

      return workspacePath;
    }

    await this.cloneInto(workspacePath);
    return workspacePath;
  }

  public async runInWorkspace(taskId: string, cmd: readonly string[] | string): Promise<CommandResult> {
    const command = this.normalizeCommand(cmd);
    if (command.length === 0) {
      throw new Error("Command must include at least one token");
    }

    const workspacePath = this.resolveWorkspacePath(taskId);
    if (!(await this.pathExists(workspacePath))) {
      throw new Error(`Workspace does not exist for taskId=${taskId}. Call createWorkspace(taskId) first.`);
    }

    await this.assertDirectory(workspacePath);
    this.assertAllowedCommand(command, workspacePath);

    return this.runCommand({
      command,
      cwd: workspacePath,
      allowNonZeroExit: false,
    });
  }

  public getWorkspacePath(taskId: string): string {
    return this.resolveWorkspacePath(taskId);
  }

  public async runInWorkspaceAllowNonZero(taskId: string, cmd: readonly string[] | string): Promise<CommandResult> {
    const command = this.normalizeCommand(cmd);
    const workspacePath = this.resolveWorkspacePath(taskId);
    if (!(await this.pathExists(workspacePath))) {
      throw new Error(`Workspace does not exist for taskId=${taskId}. Call createWorkspace(taskId) first.`);
    }

    await this.assertDirectory(workspacePath);
    this.assertAllowedCommand(command, workspacePath);

    return this.runCommand({
      command,
      cwd: workspacePath,
      allowNonZeroExit: true,
    });
  }

  private normalizeCommand(cmd: readonly string[] | string): readonly string[] {
    if (typeof cmd === "string") {
      const tokens = cmd.match(/\"[^\"]*\"|'[^']*'|\S+/g) ?? [];
      return tokens.map((token) => token.replace(/^\"|\"$/g, "").replace(/^'|'$/g, ""));
    }

    if (Array.isArray(cmd)) {
      for (const token of cmd) {
        if (typeof token !== "string" || token.trim().length === 0) {
          throw new Error("Command array must include only non-empty strings");
        }
      }

      return [...cmd];
    }
    throw new Error("Unsupported command format");
  }

  private async cloneInto(workspacePath: string): Promise<void> {
    const parentDir = resolve(workspacePath, "..");
    await mkdir(parentDir, { recursive: true });

    await this.runCommand({
      command: [
        "git",
        "clone",
        "--origin",
        "origin",
        "--depth",
        "1",
        "--no-tags",
        this.repoUrl,
        workspacePath,
      ],
      cwd: this.workspacesRoot,
      allowNonZeroExit: false,
    });
  }

  private assertAllowedCommand(command: readonly string[], workspacePath: string): void {
    const [binary, ...args] = command;

    if (!binary) {
      throw new Error("Command is missing executable name");
    }

    const allowedBinaries = new Set(["pnpm", "node", "git", "npx", "bash"]);
    if (!allowedBinaries.has(binary)) {
      throw new Error(`Command not allowlisted: ${binary}`);
    }

    for (const arg of args) {
      if (arg.startsWith("/") || arg.startsWith("~")) {
        throw new Error(`Absolute/home path arguments are not allowed: ${arg}`);
      }

      if (/(^|\/)\.\.(\/|$)/.test(arg)) {
        throw new Error(`Parent-directory traversal is not allowed: ${arg}`);
      }
    }

    if (binary === "git") {
      const forbiddenGitArgs = new Set(["-C", "--git-dir", "--work-tree"]);
      for (const arg of args) {
        if (forbiddenGitArgs.has(arg)) {
          throw new Error(`Forbidden git argument in workspace mode: ${arg}`);
        }
      }
    }

    if (binary === "bash") {
      const scriptPath = args[0];
      if (!scriptPath) {
        throw new Error("bash is restricted to scripts/* and requires a script path");
      }

      if (!scriptPath.startsWith("scripts/")) {
        throw new Error(`bash is restricted to scripts/*, got: ${scriptPath}`);
      }

      const absoluteScriptPath = resolve(workspacePath, scriptPath);
      const workspacePrefix = workspacePath.endsWith(sep) ? workspacePath : `${workspacePath}${sep}`;
      if (!(absoluteScriptPath === workspacePath || absoluteScriptPath.startsWith(workspacePrefix))) {
        throw new Error(`Script path escapes workspace root: ${scriptPath}`);
      }
    }
  }

  private resolveWorkspacePath(taskId: string): string {
    const validatedTaskId = this.validateTaskId(taskId);
    const workspacePath = resolve(this.workspacesRoot, validatedTaskId);
    const rootPrefix = this.workspacesRoot.endsWith(sep) ? this.workspacesRoot : `${this.workspacesRoot}${sep}`;

    if (!(workspacePath === this.workspacesRoot || workspacePath.startsWith(rootPrefix))) {
      throw new Error(`Resolved workspace path escaped root: ${workspacePath}`);
    }

    return workspacePath;
  }

  private validateTaskId(taskId: string): string {
    const trimmed = taskId.trim();
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{1,63}$/.test(trimmed)) {
      throw new Error(
        "Invalid taskId. Use 2-64 chars from [a-zA-Z0-9_-], starting with an alphanumeric character.",
      );
    }

    return trimmed;
  }

  private async assertDirectory(path: string): Promise<void> {
    const fileStat = await stat(path);
    if (!fileStat.isDirectory()) {
      throw new Error(`Expected directory at path: ${path}`);
    }
  }

  private async pathExists(path: string): Promise<boolean> {
    try {
      await stat(path);
      return true;
    } catch (error) {
      if (typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === "ENOENT") {
        return false;
      }

      throw error;
    }
  }

  private runCommand(options: {
    command: readonly string[];
    cwd: string;
    allowNonZeroExit: boolean;
  }): Promise<CommandResult> {
    const [binary, ...args] = options.command;
    if (!binary) {
      throw new Error("runCommand called with an empty command");
    }

    return new Promise<CommandResult>((resolvePromise, rejectPromise) => {
      let settled = false;
      const resolveOnce = (result: CommandResult): void => {
        if (!settled) {
          settled = true;
          resolvePromise(result);
        }
      };
      const rejectOnce = (error: Error): void => {
        if (!settled) {
          settled = true;
          rejectPromise(error);
        }
      };

      const child = spawn(binary, args, {
        cwd: options.cwd,
        stdio: ["ignore", "pipe", "pipe"],
        env: process.env,
      });

      let stdout = "";
      let stderr = "";

      child.stdout.on("data", (chunk: Buffer) => {
        stdout += chunk.toString("utf8");
        if (Buffer.byteLength(stdout, "utf8") > OUTPUT_LIMIT_BYTES) {
          child.kill("SIGTERM");
          rejectOnce(new Error(`Command stdout exceeded ${OUTPUT_LIMIT_BYTES} bytes`));
        }
      });

      child.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString("utf8");
        if (Buffer.byteLength(stderr, "utf8") > OUTPUT_LIMIT_BYTES) {
          child.kill("SIGTERM");
          rejectOnce(new Error(`Command stderr exceeded ${OUTPUT_LIMIT_BYTES} bytes`));
        }
      });

      child.on("error", (error: Error) => {
        rejectOnce(error);
      });

      child.on("close", (code, signal) => {
        const exitCode = code ?? (signal ? 128 : 1);
        const result: CommandResult = {
          command: options.command,
          cwd: options.cwd,
          exitCode,
          stdout,
          stderr,
        };

        if (signal) {
          rejectOnce(new Error(`Command terminated by signal ${signal}: ${options.command.join(" ")}`));
          return;
        }

        if (exitCode !== 0 && !options.allowNonZeroExit) {
          rejectOnce(
            new Error(
              `Command failed (exit ${exitCode}): ${options.command.join(" ")}\nstdout:\n${stdout}\nstderr:\n${stderr}`,
            ),
          );
          return;
        }

        resolveOnce(result);
      });
    });
  }
}
