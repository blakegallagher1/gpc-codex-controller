import { mkdir, readdir, rm, stat } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { spawn } from "node:child_process";

const DEFAULT_REPO_URL = "https://github.com/blakegallagher1/gpc-cres";
const DEFAULT_WORKSPACES_ROOT = "/workspaces";
const OUTPUT_LIMIT_BYTES = 2 * 1024 * 1024;
const BARE_REPO_DIR = ".bare-repo";

export interface WorkspaceManagerOptions {
  repoUrl?: string;
  workspacesRoot?: string;
  /** Set to true to use git worktrees instead of full clones (default: true). */
  useWorktrees?: boolean;
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
  private readonly useWorktrees: boolean;
  private bareRepoReady = false;

  public constructor(options: WorkspaceManagerOptions = {}) {
    this.repoUrl = options.repoUrl ?? DEFAULT_REPO_URL;
    this.workspacesRoot = resolve(options.workspacesRoot ?? DEFAULT_WORKSPACES_ROOT);
    this.useWorktrees = options.useWorktrees ?? true;
  }

  /** Path to the shared bare repo used for worktree-based isolation. */
  public get bareRepoPath(): string {
    return resolve(this.workspacesRoot, BARE_REPO_DIR);
  }

  public async createWorkspace(taskId: string): Promise<string> {
    const workspacePath = this.resolveWorkspacePath(taskId);

    await mkdir(this.workspacesRoot, { recursive: true });

    if (await this.pathExists(workspacePath)) {
      await this.assertDirectory(workspacePath);
      const entries = await readdir(workspacePath);

      if (entries.length === 0) {
        if (this.useWorktrees) {
          await this.addWorktree(taskId, workspacePath);
        } else {
          await this.cloneInto(workspacePath);
        }
        return workspacePath;
      }

      if (!entries.includes(".git")) {
        throw new Error(
          `Workspace path already exists and is not an initialized git repository: ${workspacePath}`,
        );
      }

      return workspacePath;
    }

    if (this.useWorktrees) {
      await this.addWorktree(taskId, workspacePath);
    } else {
      await this.cloneInto(workspacePath);
    }
    return workspacePath;
  }

  /**
   * Remove a workspace. For worktree-based workspaces this also removes the
   * worktree from the bare repo. For clone-based workspaces this deletes the
   * directory.
   */
  public async destroyWorkspace(taskId: string): Promise<void> {
    const workspacePath = this.resolveWorkspacePath(taskId);
    if (!(await this.pathExists(workspacePath))) {
      return;
    }

    if (this.useWorktrees) {
      try {
        await this.runCommand({
          command: ["git", "worktree", "remove", "--force", workspacePath],
          cwd: this.bareRepoPath,
          allowNonZeroExit: true,
        });
      } catch {
        // Fall back to rm if worktree remove fails (e.g. bare repo gone)
        await rm(workspacePath, { recursive: true, force: true });
      }
    } else {
      await rm(workspacePath, { recursive: true, force: true });
    }
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

  /**
   * Ensure the shared bare repository exists. This is a one-time operation
   * that creates a bare clone used as the source for all worktrees.
   * Subsequent calls are no-ops.
   */
  private async ensureBareRepo(): Promise<void> {
    if (this.bareRepoReady) {
      return;
    }

    const barePath = this.bareRepoPath;

    if (await this.pathExists(barePath)) {
      // Validate it's a git repo
      const headPath = resolve(barePath, "HEAD");
      if (await this.pathExists(headPath)) {
        // Fetch latest from origin so worktrees are up to date
        try {
          await this.runCommand({
            command: ["git", "fetch", "origin", "--depth", "1"],
            cwd: barePath,
            allowNonZeroExit: true,
          });
        } catch {
          // Non-critical: offline is fine if we already have data
        }
        this.bareRepoReady = true;
        return;
      }
    }

    await mkdir(this.workspacesRoot, { recursive: true });
    await this.runCommand({
      command: [
        "git",
        "clone",
        "--bare",
        "--origin",
        "origin",
        "--depth",
        "1",
        "--no-tags",
        this.repoUrl,
        barePath,
      ],
      cwd: this.workspacesRoot,
      allowNonZeroExit: false,
    });

    this.bareRepoReady = true;
  }

  /**
   * Create a workspace using `git worktree add` from the shared bare repo.
   * Nearly instant compared to a full clone, and shares the object store.
   */
  private async addWorktree(taskId: string, workspacePath: string): Promise<void> {
    await this.ensureBareRepo();

    const parentDir = resolve(workspacePath, "..");
    await mkdir(parentDir, { recursive: true });

    // Create a detached worktree from the default branch
    await this.runCommand({
      command: [
        "git",
        "worktree",
        "add",
        "--detach",
        workspacePath,
      ],
      cwd: this.bareRepoPath,
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

  public resolveWorkspacePath(taskId: string): string {
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
