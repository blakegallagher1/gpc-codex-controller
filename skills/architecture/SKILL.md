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

### 2. Layer Boundaries
Logical layers must remain isolated:
- **Domain layer** (`types.ts`, interfaces) — no infrastructure deps
- **Manager layer** (`*Manager.ts`, `*Validator.ts`) — may depend on domain, not on transport
- **Transport layer** (`rpcServer.ts`, `mcpServer.ts`) — may depend on controller
- **Entry point** (`index.ts`) — wires everything together

### 3. Import Cycles
Circular import chains are flagged as violations. The validator traces import graphs and reports any A→B→...→A cycles.

## Violation Output
Each violation includes:
- `type` — `dependency-direction` | `layer-boundary` | `import-cycle`
- `source` — file originating the bad import
- `target` — file being imported incorrectly
- `message` — human-readable explanation

## When to Run
- After any structural refactor
- Before PR merge (via `run_review_loop`)
- As part of `get_quality_score` composite check
