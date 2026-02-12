---
name: architecture
description: |
  Use when: Validating architectural rules after refactors, before PR merge, or as part of quality scoring.
  Do NOT use when: Implementing features (use gpc-cres-mutation), fixing code (use gpc-cres-fix), or reviewing diffs (use review).
  Outputs: ArchValidationResult with violations categorized by type.
  Success criteria: Zero violations. All dependency directions, layer boundaries, and import graphs are clean.
---

# Architecture Validation Skill

## Purpose
Enforce architectural rules across the codebase: dependency direction, layer boundaries, and import cycle detection.

## Tools
- `validate_architecture` — Run full architectural validation on a task workspace.

## Rules Enforced

### 1. Dependency Direction
Code must depend downward through layers. Violations:
- `src/` importing from `test/` or `scripts/`
- Library modules importing from application entry points
- Shared utilities importing from feature-specific code
- `packages/shared` importing from `packages/api` or `packages/web`

### 2. Layer Boundaries (gpc-cres specific)
```
  packages/web  →  packages/shared  ←  packages/api
       ↓                ↓                    ↓
  packages/db  ← ← ← ← ← ← ← ← ← ← packages/db
```

Allowed dependency directions:
- `web` → `shared`, `db`
- `api` → `shared`, `db`
- `shared` → `db` (types only)
- `db` → nothing (leaf node)

Violations:
- `shared` importing from `web` or `api`
- `db` importing from any other package
- `web` importing from `api` or vice versa

### 3. Import Cycles
Circular import chains are flagged as violations. The validator traces import graphs and reports any A→B→...→A cycles.

## Output Template
```json
{
  "taskId": "task-123",
  "passed": false,
  "violations": [
    {
      "type": "dependency-direction",
      "source": "packages/shared/src/utils/tenant.ts",
      "target": "packages/api/src/middleware/auth.ts",
      "message": "packages/shared cannot import from packages/api (dependency inversion)"
    },
    {
      "type": "import-cycle",
      "source": "src/controller.ts",
      "target": "src/rpcServer.ts",
      "message": "Circular import: controller → rpcServer → controller"
    }
  ]
}
```

## Negative Examples (Do NOT flag these)
- ❌ Flagging dev dependencies in test files (tests can import test utils)
- ❌ Flagging type-only imports across boundaries (TypeScript erases these at compile time)
- ❌ Flagging re-exports in index.ts barrel files (these are standard patterns)
- ❌ Flagging dynamic imports used for code splitting (these are intentional)

## Edge Cases
- If the workspace has no `packages/` directory, skip layer boundary checks
- If a file imports from `node:*`, skip it (Node.js built-in modules are always allowed)
- Aliased imports (e.g., `@gpc-cres/shared`) should be resolved to actual paths
- Monorepo root files are exempt from package-level boundary checks

## When to Run
- After any structural refactor
- Before PR merge (via `run_review_loop`)
- As part of `get_quality_score` composite check
- When adding new packages to the monorepo
