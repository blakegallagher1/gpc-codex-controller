---
name: gpc-cres-mutation
description: |
  Use when: Implementing a new feature, refactoring, or making code changes in the gpc-cres monorepo.
  Do NOT use when: Running verification only, creating PRs, or performing git operations without code changes.
  Outputs: Modified source files that pass `pnpm verify`.
  Success criteria: All TypeScript compiles, all lint rules pass, all tests pass, workspace boundaries preserved.
---

# gpc-cres Mutation Skill

You are mutating the **gpc-cres** monorepo — a pnpm workspaces-based commercial real estate platform.

## Repository Structure

```
gpc-cres/
├── packages/
│   ├── api/          # Express/Fastify API server
│   ├── web/          # Next.js frontend
│   ├── db/           # Prisma schema + migrations
│   ├── shared/       # Shared types, utils, constants
│   └── scripts/      # Build & CI tooling
├── package.json      # Root workspace config (DO NOT MODIFY)
├── tsconfig.json     # Root TS config (DO NOT MODIFY)
├── eslint.config.mjs # Root lint config (DO NOT MODIFY)
└── pnpm-workspace.yaml
```

## Constraints (MUST follow)

1. **Workspace boundaries**: Never import from another package using relative paths. Use the package name (e.g., `@gpc-cres/shared`).
2. **Strict TypeScript**: No `any`, no `@ts-ignore`, no `as unknown as`. Fix types properly.
3. **orgId scoping**: Every tenant-sensitive query, route, and middleware MUST include `orgId` filtering. Never return cross-tenant data.
4. **Prisma migrations**: NEVER create parallel migrations. Migration operations must be serial and explicit. If a migration is needed, create exactly ONE migration with a descriptive name.
5. **Minimal changes**: Apply the smallest diff that correctly implements the feature. Do not refactor unrelated code.
6. **No root config changes**: Do not modify `package.json`, `tsconfig.json`, or `eslint.config.mjs` at the repo root.
7. **Existing patterns**: Read 2-3 similar files before writing new code. Match the existing style, naming conventions, and error handling patterns.

## Workflow

1. **Understand**: Read the feature request carefully. Identify which packages are affected.
2. **Explore**: Read existing code in the affected packages. Find similar implementations to use as templates.
3. **Plan**: Determine the minimal set of files to create or modify.
4. **Implement**: Make changes one file at a time. Keep diffs small and focused.
5. **Verify**: Run `pnpm verify` and fix any failures before finishing.

## Templates

### New API Route (Express)
```typescript
import { Router } from "express";
import { requireAuth } from "@gpc-cres/shared/middleware";
import { db } from "@gpc-cres/db";

const router = Router();

router.get("/", requireAuth, async (req, res) => {
  const { orgId } = req.auth; // Always scope by orgId
  const items = await db.someModel.findMany({ where: { orgId } });
  res.json({ data: items });
});

export default router;
```

### New Prisma Migration
```bash
# In packages/db directory ONLY:
pnpm prisma migrate dev --name descriptive_migration_name
```

### New Shared Type
```typescript
// packages/shared/src/types/newEntity.ts
export interface NewEntity {
  id: string;
  orgId: string; // Always include orgId
  // ... fields
  createdAt: Date;
  updatedAt: Date;
}
```

## Negative Examples (Do NOT do these)

- ❌ Adding a package to root `package.json` instead of the workspace that needs it
- ❌ Creating `packages/db/prisma/migrations/` files manually (use `prisma migrate dev`)
- ❌ Importing `../../../packages/shared/src/types` (use `@gpc-cres/shared`)
- ❌ Writing a query without `where: { orgId }` on tenant-scoped data
- ❌ Modifying `coordinator.ts` at the root
- ❌ Running multiple Prisma migrations in one task
- ❌ Using `any` type to silence a TypeScript error
- ❌ Adding console.log for debugging (use the project's logger)

## Edge Cases

- If the feature requires a new package, create it under `packages/` with its own `package.json` and `tsconfig.json`. Add it to `pnpm-workspace.yaml`.
- If tests fail due to missing test fixtures, create minimal fixtures — do not skip tests.
- If a lint rule blocks your change, fix the code to comply — do not disable the rule.
