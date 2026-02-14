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
          // Check for cross-package absolute imports into internal modules
          if (/from\s+["']@gpc-cres\//.test(line)) {
            const packageDir = file.split("/")[1] ?? "";
            const importMatch = /@gpc-cres\/([^/"']+)/.exec(line);
            if (importMatch?.[1] && importMatch[1] !== packageDir) {
              if (/\/internal\/|\/private\//.test(line)) {
                const targetPkg = importMatch[1];
                findings.push({
                  file,
                  line: 0,
                  column: 0,
                  severity: "error",
                  message: `Cross-package import into internal module: ${line.slice(1).trim()}`,
                  rule: "import-boundary",
                  remediation: [
                    `This import reaches into the internal implementation of @gpc-cres/${targetPkg}.`,
                    `Fix: Import from the package's public API instead.`,
                    `  Change: import { ... } from '@gpc-cres/${targetPkg}/internal/...'`,
                    `  To:     import { ... } from '@gpc-cres/${targetPkg}'`,
                    `If the symbol is not exported from the package root, add a re-export in packages/${targetPkg}/src/index.ts.`,
                  ].join("\n"),
                });
              }
            }
          }

          // Check for relative imports that escape package boundary
          if (/from\s+["']\.\.\/(\.\.\/)*/.test(line)) {
            const depth = (line.match(/\.\.\//g) ?? []).length;
            if (depth >= 3) {
              const packageDir = file.split("/").slice(0, 2).join("/");
              findings.push({
                file,
                line: 0,
                column: 0,
                severity: "warning",
                message: `Deep relative import (${depth} levels up) may cross package boundary`,
                rule: "import-depth",
                remediation: [
                  `This relative import goes ${depth} directories up, which likely crosses a package boundary.`,
                  `Fix: Replace the relative import with a workspace package import.`,
                  `  Change: import { ... } from '${"../".repeat(depth)}...'`,
                  `  To:     import { ... } from '@gpc-cres/<target-package>'`,
                  `Identify which package the target file belongs to (look at ${packageDir}/package.json) and import via the package name.`,
                ].join("\n"),
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
            if (/[_\s]/.test(basename.replace(/\.ts$/, ""))) {
              const suggested = basename
                .replace(/\.ts$/, "")
                .replace(/([a-z])([A-Z])/g, "$1-$2")
                .replace(/[_\s]+/g, "-")
                .toLowerCase() + ".ts";
              findings.push({
                file,
                line: 0,
                column: 0,
                severity: "warning",
                message: `File name "${basename}" uses underscores — prefer camelCase or kebab-case`,
                rule: "file-naming",
                remediation: [
                  `Rename the file from "${basename}" to "${suggested}" (kebab-case).`,
                  `Then update all imports that reference this file:`,
                  `  1. Run: git mv ${file} ${file.replace(basename, suggested)}`,
                  `  2. Find imports: grep -r '${basename.replace(".ts", "")}' --include='*.ts'`,
                  `  3. Update each import path to use '${suggested.replace(".ts", "")}'`,
                ].join("\n"),
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

  /**
   * Check for `any` type usage and @ts-ignore in changed files.
   * Provides agent-targeted remediation for each finding.
   */
  public async checkTypeStrictness(taskId: string): Promise<LintFinding[]> {
    const findings: LintFinding[] = [];

    try {
      const result = await this.workspaceManager.runInWorkspaceAllowNonZero(taskId, ["git", "diff"]);
      const lines = result.stdout.split(/\r?\n/);
      let currentFile = "";

      for (const line of lines) {
        const fileMatch = /^\+\+\+ b\/(.+)$/.exec(line);
        if (fileMatch?.[1]) {
          currentFile = fileMatch[1];
          continue;
        }

        if (!line.startsWith("+") || line.startsWith("+++") || !currentFile.endsWith(".ts")) {
          continue;
        }

        const content = line.slice(1);

        if (/:\s*any\b/.test(content) && !content.includes("// allow-any")) {
          findings.push({
            file: currentFile,
            line: 0,
            column: 0,
            severity: "error",
            message: `Avoid using 'any' type: ${content.trim().slice(0, 80)}`,
            rule: "no-any",
            remediation: [
              "Replace 'any' with the correct specific type. Options:",
              "  - Use 'unknown' if the type is truly unknown, then narrow with type guards.",
              "  - Use the specific interface/type if known (e.g., Record<string, string>).",
              "  - Use generics if the function needs to work with multiple types.",
              "  - For JSON parsing: use 'unknown' then validate with zod schema.",
              `Example: Change ': any' to ': unknown' and add a type guard before use.`,
            ].join("\n"),
          });
        }

        if (/@ts-ignore/.test(content)) {
          findings.push({
            file: currentFile,
            line: 0,
            column: 0,
            severity: "error",
            message: `Do not use @ts-ignore: ${content.trim().slice(0, 80)}`,
            rule: "no-ts-ignore",
            remediation: [
              "Replace @ts-ignore with @ts-expect-error and a comment explaining why.",
              "Better yet, fix the underlying type error instead of suppressing it.",
              "  - If it's a missing property: add the property to the interface.",
              "  - If it's a type mismatch: add a proper type assertion or guard.",
              "  - If it's a third-party type issue: use @ts-expect-error with explanation.",
              "Example: // @ts-expect-error — WidgetLib types are incomplete for v3 API",
            ].join("\n"),
          });
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
            remediation: null, // ESLint provides its own fix suggestions
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

    if (activeRules.has("type-safety")) {
      findings.push(...await this.checkTypeStrictness(taskId));
    }

    return findings;
  }
}
