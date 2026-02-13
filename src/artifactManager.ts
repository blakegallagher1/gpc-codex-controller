import { readdir, readFile, stat, writeFile, mkdir, rename } from "node:fs/promises";
import { join, resolve, basename, extname } from "node:path";
import { randomUUID } from "node:crypto";
import { WorkspaceManager } from "./workspaceManager.js";
import type { Artifact, ArtifactCollectionResult } from "./types.js";

/**
 * Artifact handoff boundary manager.
 *
 * Article tip #7: "Make /mnt/data your handoff boundary for artifacts."
 *
 * Tools write to disk, models reason over disk, developers retrieve from disk.
 * This manager creates a standardized artifact collection directory per task,
 * catalogs all outputs, and provides a clean handoff boundary.
 */

const ARTIFACT_DIR = "_artifacts";
const CATALOG_FILE = "artifacts.json";

// Common artifact file patterns
const ARTIFACT_PATTERNS: Record<string, string> = {
  ".md": "report",
  ".json": "dataset",
  ".csv": "dataset",
  ".xlsx": "dataset",
  ".png": "screenshot",
  ".jpg": "screenshot",
  ".svg": "screenshot",
  ".log": "log",
  ".txt": "report",
  ".html": "report",
  ".pdf": "report",
};

export class ArtifactManager {
  private readonly workspaceManager: WorkspaceManager;
  private readonly catalogPath: string;
  private catalog: Artifact[] = [];

  public constructor(catalogPath: string, workspaceManager: WorkspaceManager) {
    this.catalogPath = catalogPath;
    this.workspaceManager = workspaceManager;
  }

  /**
   * Register an artifact in the catalog.
   */
  public async registerArtifact(
    taskId: string,
    name: string,
    path: string,
    type?: Artifact["type"],
    metadata?: Record<string, string>,
  ): Promise<Artifact> {
    await this.loadCatalog();

    let sizeBytes = 0;
    try {
      const info = await stat(path);
      sizeBytes = info.size;
    } catch {
      // File may not exist yet; allow registration anyway
    }

    const artifact: Artifact = {
      id: randomUUID(),
      taskId,
      name,
      type: type ?? this.inferType(path),
      path,
      sizeBytes,
      createdAt: new Date().toISOString(),
      metadata: metadata ?? {},
    };

    this.catalog.push(artifact);
    await this.saveCatalog();
    return artifact;
  }

  /**
   * Collect all artifacts from a task's workspace into the handoff directory.
   * Scans the workspace for known artifact patterns and registers them.
   */
  public async collectFromWorkspace(taskId: string): Promise<ArtifactCollectionResult> {
    await this.loadCatalog();

    const workspacePath = this.workspaceManager.getWorkspacePath(taskId);
    const handoffPath = join(workspacePath, ARTIFACT_DIR);

    try {
      await mkdir(handoffPath, { recursive: true });
    } catch {
      // Directory may already exist
    }

    // Scan workspace for artifact-like files
    const collected = await this.scanForArtifacts(taskId, workspacePath, handoffPath);
    let totalSizeBytes = 0;

    for (const artifact of collected) {
      totalSizeBytes += artifact.sizeBytes;
    }

    return {
      taskId,
      artifacts: collected,
      totalSizeBytes,
      handoffPath,
    };
  }

  /**
   * Get all artifacts for a task.
   */
  public async getArtifacts(taskId: string): Promise<Artifact[]> {
    await this.loadCatalog();
    return this.catalog.filter((a) => a.taskId === taskId);
  }

  /**
   * Get a specific artifact by ID.
   */
  public async getArtifact(artifactId: string): Promise<Artifact | null> {
    await this.loadCatalog();
    return this.catalog.find((a) => a.id === artifactId) ?? null;
  }

  /**
   * List artifacts, optionally filtered by type.
   */
  public async listArtifacts(type?: Artifact["type"]): Promise<Artifact[]> {
    await this.loadCatalog();
    if (!type) {
      return [...this.catalog];
    }
    return this.catalog.filter((a) => a.type === type);
  }

  /**
   * Get the handoff directory path for a task.
   */
  public getHandoffPath(taskId: string): string {
    const workspacePath = this.workspaceManager.getWorkspacePath(taskId);
    return join(workspacePath, ARTIFACT_DIR);
  }

  private async scanForArtifacts(
    taskId: string,
    workspacePath: string,
    _handoffPath: string,
  ): Promise<Artifact[]> {
    const artifacts: Artifact[] = [];

    // Prioritize _artifacts/ directory (auto-saved turn outputs live here)
    const artifactsDir = join(workspacePath, ARTIFACT_DIR);
    await this.scanDirectory(taskId, artifactsDir, artifacts);

    // Also scan workspace root for any top-level artifact files
    await this.scanDirectory(taskId, workspacePath, artifacts, false);

    return artifacts;
  }

  private async scanDirectory(
    taskId: string,
    dirPath: string,
    artifacts: Artifact[],
    recursive = true,
  ): Promise<void> {
    try {
      const entries = await readdir(dirPath, { withFileTypes: true });

      for (const entry of entries) {
        // Skip node_modules, .git, and other noise
        if (entry.isDirectory()) {
          if (recursive && !entry.name.startsWith(".") && entry.name !== "node_modules") {
            await this.scanDirectory(taskId, join(dirPath, entry.name), artifacts, true);
          }
          continue;
        }

        if (!entry.isFile()) {
          continue;
        }

        const ext = extname(entry.name).toLowerCase();
        const type = ARTIFACT_PATTERNS[ext];
        if (!type) {
          continue;
        }

        const srcPath = join(dirPath, entry.name);

        // Skip if already registered (avoid duplicates)
        const alreadyRegistered = artifacts.some((a) => a.path === srcPath);
        if (alreadyRegistered) {
          continue;
        }

        const artifact = await this.registerArtifact(
          taskId,
          entry.name,
          srcPath,
          type as Artifact["type"],
          { scanned: "true", originalDir: dirPath },
        );

        artifacts.push(artifact);
      }
    } catch {
      // Directory may not exist; skip
    }
  }

  private inferType(path: string): Artifact["type"] {
    const ext = extname(path).toLowerCase();
    return (ARTIFACT_PATTERNS[ext] as Artifact["type"]) ?? "file";
  }

  private async loadCatalog(): Promise<void> {
    try {
      const raw = await readFile(this.catalogPath, "utf8");
      this.catalog = JSON.parse(raw) as Artifact[];
    } catch {
      this.catalog = [];
    }
  }

  private async saveCatalog(): Promise<void> {
    const tmpPath = `${this.catalogPath}.tmp`;
    await writeFile(tmpPath, JSON.stringify(this.catalog, null, 2), "utf8");
    await rename(tmpPath, this.catalogPath);
  }
}
