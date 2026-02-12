import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { ExecutionPlan, PlanPhase, PlanPhaseStatus } from "./types.js";

interface PlanStore {
  version: number;
  plans: Record<string, ExecutionPlan>;
}

const EMPTY_STORE: PlanStore = { version: 1, plans: {} };

export class ExecutionPlanManager {
  public constructor(private readonly filePath: string) {}

  public async createPlan(taskId: string, description: string): Promise<ExecutionPlan> {
    const store = await this.load();

    if (store.plans[taskId]) {
      throw new Error(`Execution plan already exists for taskId=${taskId}`);
    }

    const phases = this.generatePhases(description);
    const now = new Date().toISOString();

    const plan: ExecutionPlan = {
      taskId,
      description: description.trim(),
      phases,
      createdAt: now,
      updatedAt: now,
    };

    store.plans[taskId] = plan;
    await this.save(store);
    return plan;
  }

  public async getPlan(taskId: string): Promise<ExecutionPlan | null> {
    const store = await this.load();
    return store.plans[taskId] ?? null;
  }

  public async updatePhaseStatus(
    taskId: string,
    phaseIndex: number,
    status: PlanPhaseStatus,
  ): Promise<ExecutionPlan> {
    const store = await this.load();
    const plan = store.plans[taskId];
    if (!plan) {
      throw new Error(`No execution plan found for taskId=${taskId}`);
    }

    if (phaseIndex < 0 || phaseIndex >= plan.phases.length) {
      throw new Error(`Phase index ${phaseIndex} out of range (0-${plan.phases.length - 1})`);
    }

    const phase = plan.phases[phaseIndex] as PlanPhase;
    const now = new Date().toISOString();

    if (status === "in_progress" && !phase.startedAt) {
      phase.startedAt = now;
    }

    if (status === "completed" || status === "failed" || status === "skipped") {
      phase.completedAt = now;
    }

    phase.status = status;
    plan.updatedAt = now;

    await this.save(store);
    return plan;
  }

  public async validatePlan(taskId: string): Promise<{ valid: boolean; errors: string[] }> {
    const plan = await this.getPlan(taskId);
    if (!plan) {
      return { valid: false, errors: [`No plan found for taskId=${taskId}`] };
    }

    const errors: string[] = [];

    for (let i = 0; i < plan.phases.length; i++) {
      const phase = plan.phases[i] as PlanPhase;

      for (const depIndex of phase.dependencies) {
        if (depIndex < 0 || depIndex >= plan.phases.length) {
          errors.push(`Phase ${i} ("${phase.name}") has invalid dependency index: ${depIndex}`);
          continue;
        }

        if (depIndex >= i) {
          errors.push(`Phase ${i} ("${phase.name}") depends on phase ${depIndex} which comes later`);
        }

        const dep = plan.phases[depIndex] as PlanPhase;
        if (phase.status === "in_progress" && dep.status !== "completed") {
          errors.push(
            `Phase ${i} ("${phase.name}") is in_progress but dependency phase ${depIndex} ("${dep.name}") is ${dep.status}`,
          );
        }
      }
    }

    return { valid: errors.length === 0, errors };
  }

  public async listPlans(): Promise<ExecutionPlan[]> {
    const store = await this.load();
    return Object.values(store.plans);
  }

  private generatePhases(description: string): PlanPhase[] {
    const words = description.trim().split(/\s+/).length;
    const estimatedComplexity = Math.min(5, Math.max(2, Math.ceil(words / 15)));

    const phases: PlanPhase[] = [
      {
        name: "Analysis",
        description: "Analyze requirements and identify affected files",
        status: "pending",
        estimatedLOC: 0,
        dependencies: [],
        startedAt: null,
        completedAt: null,
      },
      {
        name: "Implementation",
        description: "Write the core implementation",
        status: "pending",
        estimatedLOC: estimatedComplexity * 50,
        dependencies: [0],
        startedAt: null,
        completedAt: null,
      },
      {
        name: "Testing",
        description: "Add or update tests for the changes",
        status: "pending",
        estimatedLOC: estimatedComplexity * 30,
        dependencies: [1],
        startedAt: null,
        completedAt: null,
      },
      {
        name: "Verification",
        description: "Run full verification suite",
        status: "pending",
        estimatedLOC: 0,
        dependencies: [2],
        startedAt: null,
        completedAt: null,
      },
    ];

    return phases;
  }

  private async load(): Promise<PlanStore> {
    try {
      const raw = await readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as Partial<PlanStore>;
      if (!parsed || typeof parsed !== "object" || !parsed.plans) {
        return { ...EMPTY_STORE };
      }
      return { version: parsed.version ?? 1, plans: parsed.plans };
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
      throw new Error(`Failed to load execution plans from ${this.filePath}: ${message}`);
    }
  }

  private async save(store: PlanStore): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const tempPath = `${this.filePath}.tmp`;
    await writeFile(tempPath, `${JSON.stringify(store, null, 2)}\n`, "utf8");
    await rename(tempPath, this.filePath);
  }
}
