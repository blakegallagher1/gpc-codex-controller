import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export interface LearningEntry {
  id: string;
  taskId: string;
  timestamp: string;
  category: "fix-pattern" | "error-resolution" | "convention-violation" | "performance" | "general";
  trigger: string;
  resolution: string;
  confidence: number;
  appliedCount: number;
}

interface MemoryFile {
  version: number;
  entries: LearningEntry[];
}

const EMPTY_MEMORY: MemoryFile = { version: 1, entries: [] };
const MAX_ENTRIES = 500;
const MIN_CONFIDENCE_FOR_PROMPT = 0.6;

export class MemoryManager {
  public constructor(private readonly filePath: string) {}

  public async recordLearning(entry: Omit<LearningEntry, "id" | "timestamp" | "appliedCount">): Promise<LearningEntry> {
    const memory = await this.load();

    const existing = memory.entries.find(
      (e) => e.category === entry.category && e.trigger === entry.trigger,
    );

    if (existing) {
      existing.resolution = entry.resolution;
      existing.confidence = Math.min(1, existing.confidence + 0.1);
      existing.appliedCount += 1;
      existing.timestamp = new Date().toISOString();
      await this.save(memory);
      return existing;
    }

    const newEntry: LearningEntry = {
      ...entry,
      id: `learn_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      timestamp: new Date().toISOString(),
      appliedCount: 0,
    };

    memory.entries.push(newEntry);

    if (memory.entries.length > MAX_ENTRIES) {
      memory.entries.sort((a, b) => b.confidence - a.confidence);
      memory.entries = memory.entries.slice(0, MAX_ENTRIES);
    }

    await this.save(memory);
    return newEntry;
  }

  public async getRelevantLearnings(category?: LearningEntry["category"], limit = 10): Promise<LearningEntry[]> {
    const memory = await this.load();

    let filtered = memory.entries;
    if (category) {
      filtered = filtered.filter((e) => e.category === category);
    }

    return filtered
      .filter((e) => e.confidence >= MIN_CONFIDENCE_FOR_PROMPT)
      .sort((a, b) => b.confidence - a.confidence || b.appliedCount - a.appliedCount)
      .slice(0, limit);
  }

  public async buildMemoryContext(categories?: LearningEntry["category"][]): Promise<string> {
    const allEntries: LearningEntry[] = [];

    if (categories && categories.length > 0) {
      for (const cat of categories) {
        const entries = await this.getRelevantLearnings(cat, 5);
        allEntries.push(...entries);
      }
    } else {
      const entries = await this.getRelevantLearnings(undefined, 15);
      allEntries.push(...entries);
    }

    if (allEntries.length === 0) {
      return "";
    }

    const uniqueEntries = [...new Map(allEntries.map((e) => [e.id, e])).values()];

    const lines = uniqueEntries.map(
      (e) => `- [${e.category}] When: "${e.trigger}" → Fix: "${e.resolution}" (confidence: ${e.confidence.toFixed(2)})`,
    );

    return `\n\n--- LEARNINGS FROM PREVIOUS TASKS ---\n${lines.join("\n")}\n--- END LEARNINGS ---\n`;
  }

  public async extractLearningsFromFixLoop(
    taskId: string,
    errorOutput: string,
    fixDiff: string,
  ): Promise<LearningEntry | null> {
    const trigger = this.extractErrorPattern(errorOutput);
    if (!trigger) {
      return null;
    }

    const resolution = this.extractFixSummary(fixDiff);
    if (!resolution) {
      return null;
    }

    return this.recordLearning({
      taskId,
      category: "fix-pattern",
      trigger,
      resolution,
      confidence: 0.5,
    });
  }

  private extractErrorPattern(output: string): string | null {
    const lines = output.split(/\r?\n/).filter((l) => l.trim().length > 0);

    const errorLine = lines.find((l) => /(error|Error|ERROR|TS\d{4}|✖)/.test(l));
    if (!errorLine) {
      return null;
    }

    return errorLine.trim().slice(0, 200);
  }

  private extractFixSummary(diff: string): string | null {
    if (!diff || diff.trim().length === 0) {
      return null;
    }

    const addedLines = diff
      .split(/\r?\n/)
      .filter((l) => l.startsWith("+") && !l.startsWith("+++"))
      .map((l) => l.slice(1).trim())
      .filter((l) => l.length > 0);

    if (addedLines.length === 0) {
      return null;
    }

    return `Added ${addedLines.length} line(s): ${addedLines.slice(0, 3).join("; ").slice(0, 200)}`;
  }

  private async load(): Promise<MemoryFile> {
    try {
      const raw = await readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as Partial<MemoryFile>;
      if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.entries)) {
        return { ...EMPTY_MEMORY };
      }

      return { version: parsed.version ?? 1, entries: parsed.entries };
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        (error as { code?: unknown }).code === "ENOENT"
      ) {
        return { ...EMPTY_MEMORY };
      }

      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to load memory from ${this.filePath}: ${message}`);
    }
  }

  private async save(memory: MemoryFile): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const tempPath = `${this.filePath}.tmp`;
    await writeFile(tempPath, `${JSON.stringify(memory, null, 2)}\n`, "utf8");
    await rename(tempPath, this.filePath);
  }
}
