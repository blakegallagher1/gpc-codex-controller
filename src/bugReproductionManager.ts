import type { WorkspaceManager } from "./workspaceManager.js";
import type { SkillsManager } from "./skillsManager.js";
import type { BugReproResult } from "./types.js";

export class BugReproductionManager {
  public constructor(
    private readonly workspaceManager: WorkspaceManager,
    private readonly skillsManager: SkillsManager,
  ) {}

  public async reproduce(
    taskId: string,
    bugDescription: string,
    executeTurn: (taskId: string, threadId: string, prompt: string, cwd: string) => Promise<void>,
    threadId: string,
  ): Promise<BugReproResult> {
    const workspacePath = await this.workspaceManager.createWorkspace(taskId);

    try {
      const prompt = await this.generateReproPrompt(bugDescription);

      await executeTurn(taskId, threadId, prompt, workspacePath);

      // Check if a reproduction test was created
      const testFile = await this.findReproTest(taskId);
      if (!testFile) {
        return {
          taskId,
          reproduced: false,
          testFile: null,
          error: "Agent did not create a reproduction test file",
          steps: this.extractSteps(bugDescription),
        };
      }

      // Run the reproduction test
      const reproduced = await this.verifyReproduction(taskId);

      return {
        taskId,
        reproduced,
        testFile,
        error: reproduced ? null : "Reproduction test did not confirm the bug",
        steps: this.extractSteps(bugDescription),
      };
    } catch (error) {
      return {
        taskId,
        reproduced: false,
        testFile: null,
        error: error instanceof Error ? error.message : String(error),
        steps: this.extractSteps(bugDescription),
      };
    }
  }

  public async generateReproPrompt(bugDescription: string): Promise<string> {
    const skillContext = await this.skillsManager.buildSkillContext(["bug-repro"]);

    const sections: string[] = [
      "Task: reproduce the following bug with a minimal test case.",
      "",
      "Instructions:",
      "1. Analyze the bug description to understand the expected vs actual behavior.",
      "2. Create a focused reproduction test file at `__tests__/repro.test.ts`.",
      "3. The test should FAIL — it demonstrates the bug exists.",
      "4. Keep the reproduction minimal — only the code needed to trigger the bug.",
      "5. Include clear comments explaining each step of the reproduction.",
      "6. Do NOT fix the bug — only reproduce it.",
      "",
      "Bug description:",
      bugDescription.trim(),
    ];

    if (skillContext) {
      sections.push(skillContext);
    }

    return sections.join("\n");
  }

  public async verifyReproduction(taskId: string): Promise<boolean> {
    try {
      // Run the reproduction test — it should FAIL to confirm the bug
      const result = await this.workspaceManager.runInWorkspaceAllowNonZero(taskId, [
        "pnpm", "verify",
      ]);

      // A failing test (non-zero exit) confirms the bug is reproduced
      return result.exitCode !== 0;
    } catch {
      return false;
    }
  }

  private async findReproTest(taskId: string): Promise<string | null> {
    try {
      const result = await this.workspaceManager.runInWorkspaceAllowNonZero(taskId, [
        "git", "diff", "--name-only",
      ]);

      const files = result.stdout
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter((l) => l.length > 0);

      const reproFile = files.find(
        (f) => f.includes("repro") || (f.includes(".test.") && files.length <= 3),
      );

      return reproFile ?? null;
    } catch {
      return null;
    }
  }

  private extractSteps(bugDescription: string): string[] {
    const lines = bugDescription.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0);

    // Look for numbered steps
    const steps = lines.filter((l) => /^\d+[\.\)]\s/.test(l));
    if (steps.length > 0) {
      return steps;
    }

    // Fallback: split into sentences
    return lines.slice(0, 5);
  }
}
