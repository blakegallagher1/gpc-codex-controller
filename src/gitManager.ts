import { WorkspaceManager } from "./workspaceManager.js";

export interface GitManagerOptions {
  clock?: () => Date;
}

export class GitManager {
  private readonly clock: () => Date;

  public constructor(
    private readonly workspaceManager: WorkspaceManager,
    options: GitManagerOptions = {},
  ) {
    this.clock = options.clock ?? (() => new Date());
  }

  public async createBranch(taskId: string): Promise<string> {
    await this.workspaceManager.createWorkspace(taskId);

    const timestamp = this.formatTimestamp(this.clock());
    const slug = this.slugify(taskId);
    const branchName = `ai/${timestamp}-${slug}`;

    await this.workspaceManager.runInWorkspace(taskId, ["git", "switch", "-c", branchName]);
    return branchName;
  }

  public async commitAll(taskId: string, message: string): Promise<boolean> {
    const trimmedMessage = message.trim();
    if (trimmedMessage.length === 0) {
      throw new Error("Commit message must not be empty");
    }

    await this.workspaceManager.createWorkspace(taskId);

    await this.workspaceManager.runInWorkspace(taskId, ["git", "add", "-A"]);

    const statusResult = await this.workspaceManager.runInWorkspaceAllowNonZero(taskId, ["git", "status", "--porcelain"]);
    if (statusResult.stdout.trim().length === 0) {
      return false;
    }

    await this.workspaceManager.runInWorkspace(taskId, ["git", "commit", "-m", trimmedMessage]);
    return true;
  }

  public async pushBranch(taskId: string): Promise<string> {
    await this.workspaceManager.createWorkspace(taskId);

    const branchResult = await this.workspaceManager.runInWorkspace(taskId, [
      "git",
      "rev-parse",
      "--abbrev-ref",
      "HEAD",
    ]);

    const branchName = branchResult.stdout.trim();
    if (branchName.length === 0 || branchName === "HEAD") {
      throw new Error("Cannot push detached HEAD. Create a branch first.");
    }

    await this.workspaceManager.runInWorkspace(taskId, ["git", "push", "--set-upstream", "origin", branchName]);
    return branchName;
  }

  private formatTimestamp(value: Date): string {
    const year = value.getUTCFullYear().toString().padStart(4, "0");
    const month = (value.getUTCMonth() + 1).toString().padStart(2, "0");
    const day = value.getUTCDate().toString().padStart(2, "0");
    const hours = value.getUTCHours().toString().padStart(2, "0");
    const minutes = value.getUTCMinutes().toString().padStart(2, "0");
    const seconds = value.getUTCSeconds().toString().padStart(2, "0");

    return `${year}${month}${day}${hours}${minutes}${seconds}`;
  }

  private slugify(input: string): string {
    const normalized = input.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
    if (normalized.length === 0) {
      return "task";
    }

    return normalized.slice(0, 40);
  }
}
