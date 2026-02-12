import { readdir, readFile, stat } from "node:fs/promises";
import { resolve, join } from "node:path";

export interface SkillManifest {
  name: string;
  description: string;
  path: string;
  content: string;
}

export interface SkillsManagerOptions {
  skillsRoot?: string;
}

const DEFAULT_SKILLS_ROOT = "skills";

export class SkillsManager {
  private readonly skillsRoot: string;
  private cache = new Map<string, SkillManifest>();
  private loaded = false;

  public constructor(controllerRoot: string, options: SkillsManagerOptions = {}) {
    this.skillsRoot = resolve(controllerRoot, options.skillsRoot ?? DEFAULT_SKILLS_ROOT);
  }

  public async loadSkills(): Promise<void> {
    this.cache.clear();

    const exists = await this.pathExists(this.skillsRoot);
    if (!exists) {
      this.loaded = true;
      return;
    }

    const entries = await readdir(this.skillsRoot, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }

      const skillPath = join(this.skillsRoot, entry.name, "SKILL.md");
      const skillExists = await this.pathExists(skillPath);
      if (!skillExists) {
        continue;
      }

      const raw = await readFile(skillPath, "utf8");
      const manifest = this.parseSkillManifest(entry.name, skillPath, raw);
      this.cache.set(manifest.name, manifest);
    }

    this.loaded = true;
  }

  public async getSkill(name: string): Promise<SkillManifest | null> {
    if (!this.loaded) {
      await this.loadSkills();
    }

    return this.cache.get(name) ?? null;
  }

  public async listSkills(): Promise<SkillManifest[]> {
    if (!this.loaded) {
      await this.loadSkills();
    }

    return [...this.cache.values()];
  }

  public async getSkillContent(name: string): Promise<string | null> {
    const skill = await this.getSkill(name);
    return skill?.content ?? null;
  }

  public async buildSkillContext(skillNames: string[]): Promise<string> {
    const sections: string[] = [];

    for (const name of skillNames) {
      const content = await this.getSkillContent(name);
      if (content) {
        sections.push(`<skill name="${name}">\n${content}\n</skill>`);
      }
    }

    if (sections.length === 0) {
      return "";
    }

    return `\n\n--- SKILLS ---\n${sections.join("\n\n")}\n--- END SKILLS ---\n`;
  }

  private parseSkillManifest(dirName: string, path: string, raw: string): SkillManifest {
    let name = dirName;
    let description = "";

    const frontmatterMatch = /^---\n([\s\S]*?)\n---/.exec(raw);
    if (frontmatterMatch?.[1]) {
      const frontmatter = frontmatterMatch[1];

      const nameMatch = /^name:\s*(.+)$/m.exec(frontmatter);
      if (nameMatch?.[1]) {
        name = nameMatch[1].trim();
      }

      const descMatch = /^description:\s*\|?\s*\n([\s\S]*?)(?=\n\w|\n---)/m.exec(frontmatter);
      if (descMatch?.[1]) {
        description = descMatch[1].trim();
      } else {
        const singleLineDesc = /^description:\s*["']?(.+?)["']?\s*$/m.exec(frontmatter);
        if (singleLineDesc?.[1]) {
          description = singleLineDesc[1].trim();
        }
      }
    }

    return { name, description, path, content: raw };
  }

  private async pathExists(path: string): Promise<boolean> {
    try {
      await stat(path);
      return true;
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        (error as { code?: unknown }).code === "ENOENT"
      ) {
        return false;
      }

      throw error;
    }
  }
}
