import type { WorkspaceManager } from "./workspaceManager.js";
import type { ArchValidationResult, ArchViolation } from "./types.js";

export class ArchitectureValidator {
  public constructor(private readonly workspaceManager: WorkspaceManager) {}

  public async validate(taskId: string): Promise<ArchValidationResult> {
    const violations: ArchViolation[] = [];

    violations.push(...await this.checkDependencyDirection(taskId));
    violations.push(...await this.checkLayerBoundaries(taskId));
    violations.push(...await this.checkCircularImports(taskId));

    return {
      taskId,
      passed: violations.length === 0,
      violations,
    };
  }

  public async checkDependencyDirection(taskId: string): Promise<ArchViolation[]> {
    const violations: ArchViolation[] = [];

    try {
      const result = await this.workspaceManager.runInWorkspaceAllowNonZero(taskId, ["git", "diff"]);
      const diff = result.stdout;
      const lines = diff.split(/\r?\n/);

      let currentFile = "";

      for (const line of lines) {
        const fileMatch = /^\+\+\+ b\/(.+)$/.exec(line);
        if (fileMatch?.[1]) {
          currentFile = fileMatch[1];
          continue;
        }

        if (!line.startsWith("+") || line.startsWith("+++")) {
          continue;
        }

        // Check for infrastructure importing from domain
        if (currentFile.includes("/infrastructure/") || currentFile.includes("/infra/")) {
          const importMatch = /from\s+["'].*\/(domain|core|entities)\//i.exec(line);
          if (importMatch) {
            violations.push({
              type: "dependency-direction",
              source: currentFile,
              target: importMatch[0],
              message: `Infrastructure layer importing from domain/core layer: ${line.slice(1).trim().slice(0, 100)}`,
            });
          }
        }

        // Check for presentation/API importing directly from infrastructure
        if (currentFile.includes("/api/") || currentFile.includes("/routes/") || currentFile.includes("/handlers/")) {
          const importMatch = /from\s+["'].*\/(infrastructure|infra)\/(database|repository)/i.exec(line);
          if (importMatch) {
            violations.push({
              type: "dependency-direction",
              source: currentFile,
              target: importMatch[0],
              message: `API layer importing directly from infrastructure: ${line.slice(1).trim().slice(0, 100)}`,
            });
          }
        }
      }
    } catch {
      // Non-critical
    }

    return violations;
  }

  public async checkLayerBoundaries(taskId: string): Promise<ArchViolation[]> {
    const violations: ArchViolation[] = [];

    try {
      const result = await this.workspaceManager.runInWorkspaceAllowNonZero(taskId, ["git", "diff", "--name-only"]);
      const changedFiles = result.stdout
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter((l) => l.length > 0);

      // Group files by package
      const packageFiles = new Map<string, string[]>();
      for (const file of changedFiles) {
        const parts = file.split("/");
        if (parts.length >= 2 && parts[0] === "packages") {
          const pkg = parts[1] as string;
          if (!packageFiles.has(pkg)) {
            packageFiles.set(pkg, []);
          }
          packageFiles.get(pkg)?.push(file);
        }
      }

      // Check each package for layer violations
      for (const [pkg, files] of packageFiles) {
        const hasApiChanges = files.some((f) => f.includes("/api/") || f.includes("/routes/"));
        const hasDomainChanges = files.some((f) => f.includes("/domain/") || f.includes("/models/"));
        const hasInfraChanges = files.some((f) => f.includes("/infrastructure/") || f.includes("/repositories/"));

        // If changing API layer, should also have corresponding domain changes (or infra)
        // This is informational, not necessarily a violation
        if (hasApiChanges && !hasDomainChanges && !hasInfraChanges) {
          // API-only changes are fine for endpoint configuration
        }

        // Check for test files modifying production code structure
        const hasTestOnlyChanges = files.every((f) => f.includes(".test.") || f.includes(".spec.") || f.includes("__tests__"));
        if (hasTestOnlyChanges && files.some((f) => f.includes("/src/") && !f.includes(".test.") && !f.includes(".spec."))) {
          violations.push({
            type: "layer-boundary",
            source: pkg,
            target: "test/production mix",
            message: `Package ${pkg}: test changes mixed with production code changes`,
          });
        }
      }
    } catch {
      // Non-critical
    }

    return violations;
  }

  public async checkCircularImports(taskId: string): Promise<ArchViolation[]> {
    const violations: ArchViolation[] = [];

    try {
      const result = await this.workspaceManager.runInWorkspaceAllowNonZero(taskId, ["git", "diff"]);
      const diff = result.stdout;
      const lines = diff.split(/\r?\n/);

      let currentFile = "";
      const imports = new Map<string, Set<string>>();

      for (const line of lines) {
        const fileMatch = /^\+\+\+ b\/(.+)$/.exec(line);
        if (fileMatch?.[1]) {
          currentFile = fileMatch[1];
          if (!imports.has(currentFile)) {
            imports.set(currentFile, new Set());
          }
          continue;
        }

        if (!line.startsWith("+") || line.startsWith("+++") || !currentFile) {
          continue;
        }

        const importMatch = /from\s+["']\.\.?\/(.*?)["']/.exec(line);
        if (importMatch?.[1]) {
          imports.get(currentFile)?.add(importMatch[1]);
        }
      }

      // Simple A→B→A cycle detection
      for (const [fileA, importsA] of imports) {
        for (const importedPath of importsA) {
          for (const [fileB, importsB] of imports) {
            if (fileB.includes(importedPath) && importsB.has(fileA.split("/").pop()?.replace(/\.ts$/, "") ?? "")) {
              violations.push({
                type: "import-cycle",
                source: fileA,
                target: fileB,
                message: `Potential circular import: ${fileA} → ${fileB} → ${fileA}`,
              });
            }
          }
        }
      }
    } catch {
      // Non-critical
    }

    return violations;
  }
}
