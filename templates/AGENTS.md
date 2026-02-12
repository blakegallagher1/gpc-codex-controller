# gpc-cres Agent Instructions

> This file is the agent's map to the gpc-cres monorepo.
> It points to deeper documentation — do NOT try to encode everything here.

## What This Repo Is

gpc-cres is a multi-tenant commercial real estate platform built as a pnpm workspaces monorepo.

## Quick Reference

| Topic | Location |
|-------|----------|
| Architecture & package layout | `docs/architecture.md` |
| Code conventions & naming | `docs/conventions.md` |
| Prisma migration rules | `docs/prisma-rules.md` |
| API routes | `packages/api/src/routes/` |
| Database schema | `packages/db/prisma/schema.prisma` |
| Shared types | `packages/shared/src/types/` |
| Frontend pages | `packages/web/src/app/` |

## Core Rules (Always Apply)

1. **orgId scoping**: All tenant data queries MUST include `orgId`.
2. **Workspace boundaries**: Import packages by name (`@gpc-cres/shared`), never by relative path.
3. **Strict TypeScript**: No `any`, no `@ts-ignore`.
4. **Minimal changes**: Smallest diff that correctly solves the problem.
5. **Verify before done**: Run `pnpm verify` and ensure it passes.

## Verification

```bash
pnpm verify    # Runs: build → lint → test → typecheck
```

## Blocked Files (Do Not Modify)

- `package.json` (root)
- `tsconfig.json` (root)
- `eslint.config.mjs` (root)
- `coordinator.ts` (root)
- `pnpm-lock.yaml` (auto-generated)

## When Adding New Code

1. Read 2-3 similar existing files first.
2. Match the existing patterns.
3. Place new code in the correct package.
4. Add tests for new functionality.
5. Run `pnpm verify` before finishing.
