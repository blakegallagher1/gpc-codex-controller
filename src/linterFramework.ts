import type { WorkspaceManager } from "./workspaceManager.js";
import type { LintFinding, LintResult } from "./types.js";

export class LinterFramework {
  public constructor(private readonly workspaceManager: WorkspaceManager) {}

  public async runLinter(taskId: string, rules?: string[]): Promise<LintResult> {
    const findings: LintFinding[] = [];

    // Run ESLint if available
    const eslintFindings = await this.runEslint(taskId);
    findings.push(...eslintFindings);

    // Run custom checks
    const customFindings = await this.runCustomChecks(taskId, rules);
    findings.push(...customFindings);

    const errorCount = findings.filter((f) => f.severity === "error").length;
    const warningCount = findings.filter((f) => f.severity === "warning").length;

    return {
      taskId,
      passed: errorCount === 0,
      errorCount,
      warningCount,
      findings,
    };
  }

  public async checkImportBoundaries(taskId: string): Promise<LintFinding[]> {
    const findings: LintFinding[] = [];

    try {
      const result = await this.workspaceManager.runInWorkspaceAllowNonZero(taskId, ["git", "diff", "--name-only"]);
      const changedFiles = result.stdout
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter((l) => l.endsWith(".ts") && l.length > 0);

      for (const file of changedFiles) {
        const diffResult = await this.workspaceManager.runInWorkspaceAllowNonZero(taskId, ["git", "diff", "--", file]);
        const addedLines = diffResult.stdout
          .split(/\r?\n/)
          .filter((l) => l.startsWith("+") && !l.startsWith("+++"));

        for (const line of addedLines) {
          // Check for cross-package absolute imports
          if (/from\s+["']@gpc-cres\//.test(line)) {
            const packageDir = file.split("/")[1] ?? "";
            const importMatch = /@gpc-cres\/([^/"']+)/.exec(line);
            if (importMatch?.[1] && importMatch[1] !== packageDir) {
              // Cross-package import is generally fine in a monorepo,
              // but flag if it's importing from an internal path
              if (/\/internal\/|\/private\//.test(line)) {
                findings.push({
                  file,
                  line: 0,
                  column: 0,
                  severity: "error",
                  message: `Cross-package import into internal module: ${line.slice(1).trim()}`,
                  rule: "import-boundary",
                });
              }
            }
          }

          // Check for relative imports that escape package boundary
          if (/from\s+["']\.\.\/(\.\.\/)*/.test(line)) {
            const depth = (line.match(/\.\.\//g) ?? []).length;
            if (depth >= 3) {
              findings.push({
                file,
                line: 0,
                column: 0,
                severity: "warning",
                message: `Deep relative import (${depth} levels up) may cross package boundary`,
                rule: "import-depth",
              });
            }
          }
        }
      }
    } catch {
      // Non-critical
    }

    return findings;
  }

  public async checkNamingConventions(taskId: string): Promise<LintFinding[]> {
    const findings: LintFinding[] = [];

    try {
      const result = await this.workspaceManager.runInWorkspaceAllowNonZero(taskId, ["git", "diff", "--name-only"]);
      const changedFiles = result.stdout
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter((l) => l.length > 0);

      for (const file of changedFiles) {
        const basename = file.split("/").pop() ?? "";

        // TypeScript files should be camelCase or kebab-case
        if (basename.endsWith(".ts") && !basename.endsWith(".d.ts")) {
          if (/[A-Z].*[A-Z]/.test(basename.replace(/\.ts$/, "")) && !basename.includes(".test.") && !basename.includes(".spec.")) {
            // PascalCase is OK for component files, but flag uppercase mid-name patterns like "myFile_Name.ts"
            if (/[_\s]/.test(basename.replace(/\.ts$/, ""))) {
              findings.push({
                file,
                line: 0,
                column: 0,
                severity: "warning",
                message: `File name "${basename}" uses underscores — prefer camelCase or kebab-case`,
                rule: "file-naming",
              });
            }
          }
        }
      }
    } catch {
      // Non-critical
    }

    return findings;
  }

  private async runEslint(taskId: string): Promise<LintFinding[]> {
    try {
      const result = await this.workspaceManager.runInWorkspaceAllowNonZero(taskId, [
        "npx", "eslint", "--format", "json", "--no-error-on-unmatched-pattern", ".",
      ]);

      if (result.exitCode === 0) {
        return [];
      }

      return this.parseEslintOutput(result.stdout);
    } catch {
      return [];
    }
  }

  private parseEslintOutput(output: string): LintFinding[] {
    const findings: LintFinding[] = [];

    try {
      const results = JSON.parse(output) as Array<{
        filePath: string;
        messages: Array<{
          line: number;
          column: number;
          severity: number;
          message: string;
          ruleId: string | null;
        }>;
      }>;

      for (const fileResult of results) {
        for (const msg of fileResult.messages) {
          findings.push({
            file: fileResult.filePath,
            line: msg.line,
            column: msg.column,
            severity: msg.severity >= 2 ? "error" : "warning",
            message: msg.message,
            rule: msg.ruleId ?? "eslint",
          });
        }
      }
    } catch {
      // JSON parse failed — ESLint may not have produced valid JSON
    }

    return findings;
  }

  private async runCustomChecks(taskId: string, rules?: string[]): Promise<LintFinding[]> {
    const findings: LintFinding[] = [];
    const activeRules = new Set(rules ?? ["import-boundary", "naming", "type-safety"]);

    if (activeRules.has("import-boundary")) {
      findings.push(...await this.checkImportBoundaries(taskId));
    }

    if (activeRules.has("naming")) {
      findings.push(...await this.checkNamingConventions(taskId));
    }

    return findings;
  }
}
