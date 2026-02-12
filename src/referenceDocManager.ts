import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { ReferenceDoc } from "./types.js";

interface DocStore {
  version: number;
  docs: ReferenceDoc[];
}

const EMPTY_STORE: DocStore = { version: 1, docs: [] };
const MAX_DOCS = 200;

export class ReferenceDocManager {
  public constructor(private readonly filePath: string) {}

  public async addDoc(doc: Omit<ReferenceDoc, "id" | "addedAt">): Promise<ReferenceDoc> {
    const store = await this.load();

    const newDoc: ReferenceDoc = {
      ...doc,
      id: `doc_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      addedAt: new Date().toISOString(),
    };

    store.docs.push(newDoc);

    if (store.docs.length > MAX_DOCS) {
      store.docs = store.docs.slice(-MAX_DOCS);
    }

    await this.save(store);
    return newDoc;
  }

  public async listDocs(category?: string): Promise<ReferenceDoc[]> {
    const store = await this.load();

    if (category) {
      return store.docs.filter((d) => d.category === category);
    }

    return store.docs;
  }

  public async getDoc(docId: string): Promise<ReferenceDoc | null> {
    const store = await this.load();
    return store.docs.find((d) => d.id === docId) ?? null;
  }

  public async removeDoc(docId: string): Promise<boolean> {
    const store = await this.load();
    const index = store.docs.findIndex((d) => d.id === docId);

    if (index === -1) {
      return false;
    }

    store.docs.splice(index, 1);
    await this.save(store);
    return true;
  }

  public async getCategories(): Promise<string[]> {
    const store = await this.load();
    const categories = new Set(store.docs.map((d) => d.category));
    return [...categories].sort();
  }

  public async buildContext(categories?: string[]): Promise<string> {
    const store = await this.load();

    let filtered = store.docs;
    if (categories && categories.length > 0) {
      const categorySet = new Set(categories);
      filtered = store.docs.filter((d) => categorySet.has(d.category));
    }

    if (filtered.length === 0) {
      return "";
    }

    const sections = filtered.map(
      (d) => `<reference category="${d.category}" title="${d.title}">\n${d.content}\n</reference>`,
    );

    return `\n\n--- REFERENCE DOCUMENTATION ---\n${sections.join("\n\n")}\n--- END REFERENCE DOCS ---\n`;
  }

  private async load(): Promise<DocStore> {
    try {
      const raw = await readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as Partial<DocStore>;
      if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.docs)) {
        return { ...EMPTY_STORE };
      }
      return { version: parsed.version ?? 1, docs: parsed.docs };
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        (error as { code?: unknown }).code === "ENOENT"
      ) {
        return { ...EMPTY_STORE };
      }
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to load reference docs from ${this.filePath}: ${message}`);
    }
  }

  private async save(store: DocStore): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const tempPath = `${this.filePath}.tmp`;
    await writeFile(tempPath, `${JSON.stringify(store, null, 2)}\n`, "utf8");
    await rename(tempPath, this.filePath);
  }
}
