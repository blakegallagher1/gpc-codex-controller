import type { SkillManifest, SkillsManager } from "./skillsManager.js";
import type { SkillRouteDecision, SkillRoutingResult } from "./types.js";

/**
 * Dynamic skill selection based on task context.
 *
 * Article tips #1, #2, #5:
 * - Skills should have routing logic (Use when / Don't use when)
 * - Negative examples prevent misfires
 * - When determinism is needed, explicitly select the skill
 *
 * The router scores each available skill against the task description
 * and returns the best matches above a relevance threshold.
 */

const DEFAULT_THRESHOLD = 0.3;

// Keyword-to-skill mapping for fast routing
const SKILL_KEYWORDS: Record<string, string[]> = {
  "gpc-cres-mutation": [
    "implement", "feature", "add", "create", "build", "refactor",
    "new endpoint", "new route", "new component", "new model",
    "migration", "schema", "prisma",
  ],
  "gpc-cres-fix": [
    "fix", "error", "failure", "broken", "failing", "verify",
    "compile", "lint", "type error", "test fail", "pnpm verify",
  ],
  "gpc-cres-doc-gardening": [
    "documentation", "readme", "agents.md", "docs", "stale",
    "update docs", "gardening",
  ],
  review: [
    "review", "pr", "pull request", "diff", "code review",
    "ralph wiggum", "review loop",
  ],
  architecture: [
    "architecture", "dependency", "layer", "circular import",
    "boundary", "validate arch", "structure",
  ],
  quality: [
    "quality", "score", "composite", "overall", "health check",
    "quality gate",
  ],
  "bug-repro": [
    "bug", "reproduce", "repro", "reproduction", "regression",
    "minimal test", "failing test",
  ],
};

// Skills that should NEVER be loaded together (mutually exclusive)
const EXCLUSIVE_PAIRS: [string, string][] = [
  ["gpc-cres-mutation", "gpc-cres-fix"], // don't mix feature work with fix work
];

export class SkillRouter {
  private readonly skillsManager: SkillsManager;
  private readonly threshold: number;

  public constructor(skillsManager: SkillsManager, threshold?: number) {
    this.skillsManager = skillsManager;
    this.threshold = threshold ?? DEFAULT_THRESHOLD;
  }

  /**
   * Score all available skills against the task description.
   * Returns skills above threshold, sorted by score descending.
   */
  public async route(taskDescription: string): Promise<SkillRoutingResult> {
    const allSkills = await this.skillsManager.listSkills();
    const lowerDesc = taskDescription.toLowerCase();

    const scored: SkillRouteDecision[] = allSkills.map((skill) =>
      this.scoreSkill(skill, lowerDesc),
    );

    // Partition by threshold
    const selected: SkillRouteDecision[] = [];
    const rejected: SkillRouteDecision[] = [];

    for (const decision of scored) {
      if (decision.score >= this.threshold) {
        selected.push(decision);
      } else {
        rejected.push(decision);
      }
    }

    // Sort selected by score descending
    selected.sort((a, b) => b.score - a.score);

    // Enforce exclusivity: if two exclusive skills are both selected, keep only the higher-scored one
    const filtered = this.enforceExclusivity(selected);

    return {
      selectedSkills: filtered,
      rejectedSkills: rejected,
      totalCandidates: allSkills.length,
    };
  }

  /**
   * Deterministic skill selection: bypasses scoring and forces specific skills.
   * Article tip #5: "When you need determinism, explicitly tell the model to use the skill."
   */
  public async forceSelect(skillNames: string[]): Promise<SkillRoutingResult> {
    const allSkills = await this.skillsManager.listSkills();
    const selected: SkillRouteDecision[] = [];
    const rejected: SkillRouteDecision[] = [];

    for (const skill of allSkills) {
      if (skillNames.includes(skill.name)) {
        selected.push({
          skillName: skill.name,
          score: 1.0,
          reason: "Deterministic selection (forced)",
        });
      } else {
        rejected.push({
          skillName: skill.name,
          score: 0,
          reason: "Not in forced selection set",
        });
      }
    }

    return {
      selectedSkills: selected,
      rejectedSkills: rejected,
      totalCandidates: allSkills.length,
    };
  }

  /**
   * Build enriched skill context for selected skills only.
   * Reduces prompt bloat by loading only relevant skills.
   */
  public async buildRoutedSkillContext(taskDescription: string): Promise<string> {
    const routing = await this.route(taskDescription);
    const selectedNames = routing.selectedSkills.map((s) => s.skillName);

    if (selectedNames.length === 0) {
      return "";
    }

    return this.skillsManager.buildSkillContext(selectedNames);
  }

  private scoreSkill(skill: SkillManifest, lowerDesc: string): SkillRouteDecision {
    let score = 0;
    const reasons: string[] = [];

    // 1. Keyword matching (0–0.6)
    const keywords = SKILL_KEYWORDS[skill.name] ?? [];
    const matchedKeywords = keywords.filter((kw) => lowerDesc.includes(kw));
    if (matchedKeywords.length > 0) {
      const keywordScore = Math.min(0.6, (matchedKeywords.length / Math.max(keywords.length, 1)) * 0.8);
      score += keywordScore;
      reasons.push(`Keywords: ${matchedKeywords.join(", ")}`);
    }

    // 2. Description "Use when" matching (0–0.3)
    const useWhen = this.extractUseWhen(skill.description);
    if (useWhen && lowerDesc.length > 0) {
      const useWhenTerms = useWhen.toLowerCase().split(/\s+/).filter((t) => t.length > 3);
      const matched = useWhenTerms.filter((term) => lowerDesc.includes(term));
      if (matched.length > 0) {
        const descScore = Math.min(0.3, (matched.length / Math.max(useWhenTerms.length, 1)) * 0.4);
        score += descScore;
        reasons.push(`Description match: ${matched.length} terms`);
      }
    }

    // 3. "Don't use when" penalty (−0.5)
    const dontUseWhen = this.extractDontUseWhen(skill.description);
    if (dontUseWhen) {
      const dontTerms = dontUseWhen.toLowerCase().split(/\s+/).filter((t) => t.length > 3);
      const antiMatched = dontTerms.filter((term) => lowerDesc.includes(term));
      if (antiMatched.length > 2) {
        score -= 0.5;
        reasons.push(`Anti-match: ${antiMatched.join(", ")}`);
      }
    }

    // 4. Skill name in description (0.1 bonus)
    if (lowerDesc.includes(skill.name.toLowerCase())) {
      score += 0.1;
      reasons.push("Skill name mentioned directly");
    }

    return {
      skillName: skill.name,
      score: Math.max(0, Math.min(1, score)),
      reason: reasons.length > 0 ? reasons.join("; ") : "No matches",
    };
  }

  private extractUseWhen(description: string): string | null {
    const match = /Use when:\s*(.+?)(?:\n|$)/i.exec(description);
    return match?.[1]?.trim() ?? null;
  }

  private extractDontUseWhen(description: string): string | null {
    const match = /Do NOT use when:\s*(.+?)(?:\n|$)/i.exec(description);
    return match?.[1]?.trim() ?? null;
  }

  private enforceExclusivity(skills: SkillRouteDecision[]): SkillRouteDecision[] {
    const selected = new Set(skills.map((s) => s.skillName));
    const result = [...skills];

    for (const [a, b] of EXCLUSIVE_PAIRS) {
      if (selected.has(a) && selected.has(b)) {
        // Keep the higher-scored one (skills are already sorted by score desc)
        const idxA = result.findIndex((s) => s.skillName === a);
        const idxB = result.findIndex((s) => s.skillName === b);
        const removeIdx = idxA < idxB ? idxB : idxA; // remove the later (lower-scored) one
        result.splice(removeIdx, 1);
      }
    }

    return result;
  }
}
