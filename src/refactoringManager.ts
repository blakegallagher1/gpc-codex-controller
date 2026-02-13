import { mkdir, readdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname, resolve, relative } from "node:path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ViolationType =
  | "duplicate-helper"
  | "untyped-boundary"
  | "import-hygiene"
  | "dead-code"
  | "duplicate-logic";

export interface RefactoringViolation {
  id: string;
  type: ViolationType;
  file: string;
  line: number;
  message: string;
  suggestedFix: string;
  detectedAt: string;
}

export interface ViolationReport {
  scannedAt: string;
  workspacePath: string;
  totalFiles: number;
  violationCount: number;
  violations: RefactoringViolation[];
  byType: Record<ViolationType, number>;
}

export interface RefactoringRun {
  runId: string;
  violationType: ViolationType;
  violationCount: number;
  prompt: string;
  createdAt: string;
}

export interface RefactoringHistory {
  runs: RefactoringRun[];
  lastScanAt: string | null;
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

interface RefactoringStoreFile {
  version: number;
  violations: RefactoringViolation[];
  history: RefactoringRun[];
  lastScanAt: string | null;
}

const EMPTY_STORE: RefactoringStoreFile = {
  version: 1,
  violations: [],
  history: [],
  lastScanAt: null,
};

const MAX_VIOLATIONS = 500;
const MAX_HISTORY = 100;

// ---------------------------------------------------------------------------
// RefactoringManager
// ---------------------------------------------------------------------------

export class RefactoringManager {
  public constructor(private readonly filePath: string) {}

  public async scanForViolations(workspacePath: string): Promise<ViolationReport> {
    const violations: RefactoringViolation[] = [];
    const tsFiles = await this.collectTypeScriptFiles(workspacePath);

    const fileContents = new Map<string, string>();
    for (const filePath of tsFiles) {
      try {
        const content = await readFile(filePath, "utf8");
        fileContents.set(filePath, content);
      } catch {
        // Skip unreadable files
      }
    }

    // 1. Duplicate helpers
    violations.push(...this.checkDuplicateHelpers(fileContents, workspacePath));

    // 2. Untyped boundaries
    violations.push(...this.checkUntypedBoundaries(fileContents, workspacePath));

    // 3. Import hygiene
    violations.push(...this.checkImportHygiene(fileContents, workspacePath));

    // 4. Dead code
    violations.push(...this.checkDeadCode(fileContents, workspacePath));

    // 5. Duplicate logic
    violations.push(...this.checkDuplicateLogic(fileContents, workspacePath));

    // Persist
    const store = await this.load();
    store.violations = violations.slice(-MAX_VIOLATIONS);
    store.lastScanAt = new Date().toISOString();
    await this.save(store);

    const byType: Record<ViolationType, number> = {
      "duplicate-helper": 0,
      "untyped-boundary": 0,
      "import-hygiene": 0,
      "dead-code": 0,
      "duplicate-logic": 0,
    };

    for (const v of violations) {
      byType[v.type] += 1;
    }

    return {
      scannedAt: store.lastScanAt,
      workspacePath,
      totalFiles: tsFiles.length,
      violationCount: violations.length,
      violations: violations.slice(0, 100), // Return at most 100 in response
      byType,
    };
  }

  public async getViolationReport(): Promise<ViolationReport | null> {
    const store = await this.load();
    if (!store.lastScanAt) {
      return null;
    }

    const byType: Record<ViolationType, number> = {
      "duplicate-helper": 0,
      "untyped-boundary": 0,
      "import-hygiene": 0,
      "dead-code": 0,
      "duplicate-logic": 0,
    };

    for (const v of store.violations) {
      byType[v.type] += 1;
    }

    return {
      scannedAt: store.lastScanAt,
      workspacePath: "",
      totalFiles: 0,
      violationCount: store.violations.length,
      violations: store.violations.slice(0, 100),
      byType,
    };
  }

  public async generateRefactoringPR(violationType: ViolationType): Promise<RefactoringRun> {
    const store = await this.load();
    const violations = store.violations.filter((v) => v.type === violationType);

    if (violations.length === 0) {
      throw new Error(`No violations found for type: ${violationType}`);
    }

    const prompt = this.buildRefactoringPrompt(violationType, violations);

    const run: RefactoringRun = {
      runId: `refactor_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      violationType,
      violationCount: violations.length,
      prompt,
      createdAt: new Date().toISOString(),
    };

    store.history.push(run);
    if (store.history.length > MAX_HISTORY) {
      store.history = store.history.slice(-MAX_HISTORY);
    }

    await this.save(store);
    return run;
  }

  public async getRefactoringHistory(): Promise<RefactoringHistory> {
    const store = await this.load();
    return {
      runs: store.history,
      lastScanAt: store.lastScanAt,
    };
  }

  // ---------------------------------------------------------------------------
  // Golden Principle Checks
  // ---------------------------------------------------------------------------

  private checkDuplicateHelpers(
    fileContents: Map<string, string>,
    workspacePath: string,
  ): RefactoringViolation[] {
    const violations: RefactoringViolation[] = [];
    const functionMap = new Map<string, { file: string; line: number }[]>();

    // Collect all exported function names
    for (const [filePath, content] of fileContents) {
      const lines = content.split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i] ?? "";
        const match = /^export\s+(?:async\s+)?function\s+(\w+)/.exec(line);
        if (match?.[1]) {
          const name = match[1];
          if (!functionMap.has(name)) {
            functionMap.set(name, []);
          }
          functionMap.get(name)?.push({
            file: relative(workspacePath, filePath),
            line: i + 1,
          });
        }
      }
    }

    // Flag functions defined in multiple files
    for (const [name, locations] of functionMap) {
      if (locations.length > 1) {
        for (const loc of locations) {
          violations.push(this.makeViolation(
            "duplicate-helper",
            loc.file,
            loc.line,
            `Duplicate helper function "${name}" found in ${locations.length} files`,
            `Consolidate "${name}" into a shared utility module and import from there.`,
          ));
        }
      }
    }

    return violations;
  }

  private checkUntypedBoundaries(
    fileContents: Map<string, string>,
    workspacePath: string,
  ): RefactoringViolation[] {
    const violations: RefactoringViolation[] = [];

    for (const [filePath, content] of fileContents) {
      const relPath = relative(workspacePath, filePath);
      const lines = content.split(/\r?\n/);

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i] ?? "";

        // Check for `any` at module boundaries (exports)
        if (/^export\s/.test(line) && /:\s*any\b/.test(line) && !line.includes("// allow-any")) {
          violations.push(this.makeViolation(
            "untyped-boundary",
            relPath,
            i + 1,
            `Exported symbol uses \`any\` type at module boundary`,
            `Replace \`any\` with a specific type or \`unknown\` at module boundaries.`,
          ));
        }

        // Check for exported functions with `any` parameters
        if (/^export\s+(?:async\s+)?function\s/.test(line) && /\bany\b/.test(line)) {
          violations.push(this.makeViolation(
            "untyped-boundary",
            relPath,
            i + 1,
            `Exported function has \`any\` in signature`,
            `Use specific parameter types or generics instead of \`any\`.`,
          ));
        }
      }
    }

    return violations;
  }

  private checkImportHygiene(
    fileContents: Map<string, string>,
    workspacePath: string,
  ): RefactoringViolation[] {
    const violations: RefactoringViolation[] = [];
    const importGraph = new Map<string, Set<string>>();

    for (const [filePath, content] of fileContents) {
      const relPath = relative(workspacePath, filePath);
      const lines = content.split(/\r?\n/);
      const imports = new Set<string>();

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i] ?? "";

        // Check deep relative imports (>3 levels)
        const relativeMatch = /from\s+["'](\.\.\/(?:\.\.\/)*[^"']+)["']/.exec(line);
        if (relativeMatch?.[1]) {
          const depth = (relativeMatch[1].match(/\.\.\//g) ?? []).length;
          if (depth > 3) {
            violations.push(this.makeViolation(
              "import-hygiene",
              relPath,
              i + 1,
              `Deep relative import (${depth} levels up): ${relativeMatch[1]}`,
              `Use absolute imports or path aliases instead of deeply nested relative paths.`,
            ));
          }
        }

        // Collect imports for circular detection
        const importMatch = /from\s+["']\.\.?\/(.*?)(?:\.js)?["']/.exec(line);
        if (importMatch?.[1]) {
          imports.add(importMatch[1]);
        }
      }

      importGraph.set(relPath, imports);
    }

    // Simple A→B→A cycle detection
    for (const [fileA, importsA] of importGraph) {
      for (const importedPath of importsA) {
        for (const [fileB, importsB] of importGraph) {
          if (fileA === fileB) continue;
          if (
            fileB.includes(importedPath) &&
            [...importsB].some((imp) => fileA.includes(imp))
          ) {
            violations.push(this.makeViolation(
              "import-hygiene",
              fileA,
              1,
              `Potential circular import: ${fileA} -> ${fileB} -> ${fileA}`,
              `Break the cycle by extracting shared types into a separate module.`,
            ));
          }
        }
      }
    }

    return violations;
  }

  private checkDeadCode(
    fileContents: Map<string, string>,
    workspacePath: string,
  ): RefactoringViolation[] {
    const violations: RefactoringViolation[] = [];

    // Collect all exported names with their locations
    const exportedNames = new Map<string, { file: string; line: number }>();

    for (const [filePath, content] of fileContents) {
      const relPath = relative(workspacePath, filePath);
      const lines = content.split(/\r?\n/);

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i] ?? "";

        // Match various export patterns
        const patterns = [
          /^export\s+(?:async\s+)?function\s+(\w+)/,
          /^export\s+(?:const|let|var)\s+(\w+)/,
          /^export\s+class\s+(\w+)/,
          /^export\s+(?:type|interface)\s+(\w+)/,
        ];

        for (const pattern of patterns) {
          const match = pattern.exec(line);
          if (match?.[1]) {
            const key = `${relPath}:${match[1]}`;
            exportedNames.set(key, { file: relPath, line: i + 1 });
          }
        }
      }
    }

    // Check if each exported name is imported anywhere else
    const allContent = [...fileContents.values()].join("\n");

    for (const [key, loc] of exportedNames) {
      const name = key.split(":")[1];
      if (!name) continue;

      // Skip common lifecycle names and entry points
      if (["default", "main", "handler", "constructor"].includes(name)) {
        continue;
      }

      // Count references (imports) outside the defining file
      let referenceCount = 0;
      for (const [filePath, content] of fileContents) {
        const relPath = relative(workspacePath, filePath);
        if (relPath === loc.file) continue;

        // Check if the name appears in an import statement in another file
        const importPattern = new RegExp(`\\b${name}\\b`);
        if (importPattern.test(content)) {
          referenceCount += 1;
        }
      }

      if (referenceCount === 0) {
        violations.push(this.makeViolation(
          "dead-code",
          loc.file,
          loc.line,
          `Exported symbol "${name}" is not imported by any other file`,
          `Remove the export or delete the symbol if it is no longer needed.`,
        ));
      }
    }

    return violations;
  }

  private checkDuplicateLogic(
    fileContents: Map<string, string>,
    workspacePath: string,
  ): RefactoringViolation[] {
    const violations: RefactoringViolation[] = [];

    // Collect significant code blocks (5+ contiguous non-trivial lines)
    const blockSize = 5;
    const blockMap = new Map<string, { file: string; startLine: number }[]>();

    for (const [filePath, content] of fileContents) {
      const relPath = relative(workspacePath, filePath);
      const lines = content.split(/\r?\n/);

      for (let i = 0; i <= lines.length - blockSize; i++) {
        const block = lines
          .slice(i, i + blockSize)
          .map((l) => l.trim())
          .filter((l) => l.length > 0 && !l.startsWith("//") && !l.startsWith("*") && !l.startsWith("import"));

        if (block.length < 3) continue; // Not enough meaningful lines

        const key = block.join("\n");
        if (key.length < 80) continue; // Too short to be meaningful

        if (!blockMap.has(key)) {
          blockMap.set(key, []);
        }
        blockMap.get(key)?.push({ file: relPath, startLine: i + 1 });
      }
    }

    // Flag blocks that appear in multiple files
    const seen = new Set<string>();
    for (const [, locations] of blockMap) {
      // Deduplicate by file (same block appearing at adjacent offsets in same file)
      const uniqueFiles = new Map<string, number>();
      for (const loc of locations) {
        if (!uniqueFiles.has(loc.file)) {
          uniqueFiles.set(loc.file, loc.startLine);
        }
      }

      if (uniqueFiles.size > 1) {
        for (const [file, line] of uniqueFiles) {
          const dedupKey = `${file}:${line}`;
          if (seen.has(dedupKey)) continue;
          seen.add(dedupKey);

          violations.push(this.makeViolation(
            "duplicate-logic",
            file,
            line,
            `Similar code block found in ${uniqueFiles.size} files`,
            `Extract the shared logic into a reusable utility function.`,
          ));
        }
      }
    }

    return violations;
  }

  // ---------------------------------------------------------------------------
  // Prompt Generation
  // ---------------------------------------------------------------------------

  private buildRefactoringPrompt(
    violationType: ViolationType,
    violations: RefactoringViolation[],
  ): string {
    const principleDescriptions: Record<ViolationType, string> = {
      "duplicate-helper": "No hand-rolled helpers that duplicate shared utils",
      "untyped-boundary": "Typed SDK boundaries — no raw `any` types at module boundaries",
      "import-hygiene": "Import hygiene — no circular imports, no deep relative imports (>3 levels)",
      "dead-code": "Dead code — exported functions/types not imported elsewhere",
      "duplicate-logic": "Duplicate logic — similar code blocks across files",
    };

    const sections: string[] = [
      `Task: refactor codebase to fix "${principleDescriptions[violationType]}" violations.`,
      "",
      `Golden principle violated: ${principleDescriptions[violationType]}`,
      "",
      `Violations found (${violations.length}):`,
      ...violations.slice(0, 30).map(
        (v) => `  - ${v.file}:${v.line}: ${v.message}`,
      ),
    ];

    if (violations.length > 30) {
      sections.push(`  ... and ${violations.length - 30} more`);
    }

    sections.push(
      "",
      "Instructions:",
      "1. Fix all listed violations with minimal, focused changes.",
      "2. Keep each change scoped to the specific violation.",
      "3. Do not introduce new violations.",
      "4. Ensure all existing tests still pass after changes.",
      "5. Create a single focused PR for this violation type.",
    );

    return sections.join("\n");
  }

  // ---------------------------------------------------------------------------
  // File scanning
  // ---------------------------------------------------------------------------

  private async collectTypeScriptFiles(dir: string): Promise<string[]> {
    const results: string[] = [];

    try {
      const entries = await readdir(dir, { withFileTypes: true });

      for (const entry of entries) {
        const fullPath = resolve(dir, entry.name);

        // Skip node_modules, dist, .git
        if (
          entry.name === "node_modules" ||
          entry.name === "dist" ||
          entry.name === ".git" ||
          entry.name === ".next" ||
          entry.name === "coverage"
        ) {
          continue;
        }

        if (entry.isDirectory()) {
          const nested = await this.collectTypeScriptFiles(fullPath);
          results.push(...nested);
        } else if (
          entry.name.endsWith(".ts") &&
          !entry.name.endsWith(".d.ts") &&
          !entry.name.endsWith(".test.ts") &&
          !entry.name.endsWith(".spec.ts")
        ) {
          results.push(fullPath);
        }
      }
    } catch {
      // Directory not readable
    }

    return results;
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private makeViolation(
    type: ViolationType,
    file: string,
    line: number,
    message: string,
    suggestedFix: string,
  ): RefactoringViolation {
    return {
      id: `v_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      type,
      file,
      line,
      message,
      suggestedFix,
      detectedAt: new Date().toISOString(),
    };
  }

  // ---------------------------------------------------------------------------
  // Persistence (atomic write pattern)
  // ---------------------------------------------------------------------------

  private async load(): Promise<RefactoringStoreFile> {
    try {
      const raw = await readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as Partial<RefactoringStoreFile>;
      if (
        !parsed ||
        typeof parsed !== "object" ||
        !Array.isArray(parsed.violations)
      ) {
        return structuredClone(EMPTY_STORE);
      }

      return {
        version: parsed.version ?? 1,
        violations: parsed.violations,
        history: Array.isArray(parsed.history) ? parsed.history : [],
        lastScanAt: parsed.lastScanAt ?? null,
      };
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        (error as { code?: unknown }).code === "ENOENT"
      ) {
        return structuredClone(EMPTY_STORE);
      }
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to load refactoring state from ${this.filePath}: ${message}`);
    }
  }

  private async save(store: RefactoringStoreFile): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const tempPath = `${this.filePath}.tmp`;
    await writeFile(tempPath, `${JSON.stringify(store, null, 2)}\n`, "utf8");
    await rename(tempPath, this.filePath);
  }
}
