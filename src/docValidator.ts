import type { WorkspaceManager } from "./workspaceManager.js";
import type { DocIssue, DocValidationResult } from "./types.js";

export class DocValidator {
  public constructor(private readonly workspaceManager: WorkspaceManager) {}

  public async validate(taskId: string): Promise<DocValidationResult> {
    const issues: DocIssue[] = [];

    issues.push(...await this.findStaleReferences(taskId));
    issues.push(...await this.checkAgentsMdAccuracy(taskId));
    issues.push(...await this.checkReadmeAccuracy(taskId));

    return {
      taskId,
      passed: issues.length === 0,
      issues,
    };
  }

  public async findStaleReferences(taskId: string): Promise<DocIssue[]> {
    const issues: DocIssue[] = [];

    try {
      // Find all markdown files
      const findResult = await this.workspaceManager.runInWorkspaceAllowNonZero(taskId, [
        "git", "ls-files", "--", "*.md",
      ]);

      const mdFiles = findResult.stdout
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter((l) => l.length > 0);

      for (const mdFile of mdFiles.slice(0, 20)) { // Cap to prevent timeout
        const catResult = await this.workspaceManager.runInWorkspaceAllowNonZero(taskId, [
          "git", "show", `HEAD:${mdFile}`,
        ]);

        if (catResult.exitCode !== 0) {
          continue;
        }

        const content = catResult.stdout;

        // Check for file path references
        const pathRefs = content.match(/(?:^|\s)(?:`|")([a-zA-Z][a-zA-Z0-9_/-]+\.[a-zA-Z]{1,5})(?:`|")/gm) ?? [];

        for (const ref of pathRefs) {
          const pathMatch = /([a-zA-Z][a-zA-Z0-9_/-]+\.[a-zA-Z]{1,5})/.exec(ref);
          if (!pathMatch?.[1]) continue;

          const referencedPath = pathMatch[1];

          // Skip common non-file references
          if (/\.(com|org|io|net|dev|md)$/.test(referencedPath) && referencedPath.includes(".")) {
            continue;
          }

          // Check if the referenced file exists
          const checkResult = await this.workspaceManager.runInWorkspaceAllowNonZero(taskId, [
            "git", "ls-files", "--", referencedPath,
          ]);

          if (checkResult.stdout.trim().length === 0 && referencedPath.endsWith(".ts")) {
            issues.push({
              file: mdFile,
              type: "stale-reference",
              message: `References "${referencedPath}" which does not exist in the repository`,
            });
          }
        }
      }
    } catch {
      // Non-critical
    }

    return issues;
  }

  public async checkAgentsMdAccuracy(taskId: string): Promise<DocIssue[]> {
    const issues: DocIssue[] = [];

    try {
      const agentsResult = await this.workspaceManager.runInWorkspaceAllowNonZero(taskId, [
        "git", "show", "HEAD:AGENTS.md",
      ]);

      if (agentsResult.exitCode !== 0) {
        // No AGENTS.md in repo — check if there's code that should have one
        const fileCountResult = await this.workspaceManager.runInWorkspaceAllowNonZero(taskId, [
          "git", "ls-files", "--", "packages/",
        ]);

        const fileCount = fileCountResult.stdout.split(/\r?\n/).filter((l) => l.trim().length > 0).length;
        if (fileCount > 20) {
          issues.push({
            file: "AGENTS.md",
            type: "missing-doc",
            message: "Repository has packages/ directory but no AGENTS.md for agent orientation",
          });
        }

        return issues;
      }

      const content = agentsResult.stdout;

      // Check that referenced paths in AGENTS.md exist
      const pathPatterns = content.match(/`([a-zA-Z][a-zA-Z0-9_\-/.]+)`/g) ?? [];

      for (const pattern of pathPatterns) {
        const path = pattern.replace(/`/g, "");
        if (path.includes("*") || path.includes("{") || !path.includes("/")) {
          continue;
        }

        const checkResult = await this.workspaceManager.runInWorkspaceAllowNonZero(taskId, [
          "git", "ls-files", "--", path,
        ]);

        if (checkResult.stdout.trim().length === 0) {
          // Could be a directory
          const dirCheck = await this.workspaceManager.runInWorkspaceAllowNonZero(taskId, [
            "git", "ls-files", "--", `${path}/`,
          ]);

          if (dirCheck.stdout.trim().length === 0) {
            issues.push({
              file: "AGENTS.md",
              type: "broken-link",
              message: `AGENTS.md references "${path}" which does not exist`,
            });
          }
        }
      }
    } catch {
      // Non-critical
    }

    return issues;
  }

  public async checkReadmeAccuracy(taskId: string): Promise<DocIssue[]> {
    const issues: DocIssue[] = [];

    try {
      const readmeResult = await this.workspaceManager.runInWorkspaceAllowNonZero(taskId, [
        "git", "show", "HEAD:README.md",
      ]);

      if (readmeResult.exitCode !== 0) {
        return issues;
      }

      const content = readmeResult.stdout;

      // Check for outdated package.json script references
      const scriptRefs = content.match(/(?:pnpm|npm|yarn)\s+(?:run\s+)?([a-z][a-z0-9_-]+)/g) ?? [];

      const pkgResult = await this.workspaceManager.runInWorkspaceAllowNonZero(taskId, [
        "git", "show", "HEAD:package.json",
      ]);

      if (pkgResult.exitCode === 0) {
        try {
          const pkg = JSON.parse(pkgResult.stdout) as { scripts?: Record<string, string> };
          const availableScripts = new Set(Object.keys(pkg.scripts ?? {}));

          for (const ref of scriptRefs) {
            const scriptName = ref.replace(/^(?:pnpm|npm|yarn)\s+(?:run\s+)?/, "");
            if (!availableScripts.has(scriptName) && !["install", "ci", "init", "test"].includes(scriptName)) {
              issues.push({
                file: "README.md",
                type: "outdated-example",
                message: `README references script "${scriptName}" which is not in package.json`,
              });
            }
          }
        } catch {
          // JSON parse error — skip
        }
      }
    } catch {
      // Non-critical
    }

    return issues;
  }
}
