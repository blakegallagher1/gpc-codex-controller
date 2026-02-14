# gpc-cres Agent Instructions

> This file is the agent's **map** to the gpc-cres monorepo.
> It is a table of contents — NOT an encyclopedia.
> Deep documentation lives in `docs/` — read the relevant doc before acting.

## What This Repo Is

gpc-cres is a multi-tenant commercial real estate platform built as a pnpm workspaces monorepo.

## Quick Reference — Where to Find Docs

| Topic | Doc Location | When to Read |
|-------|-------------|--------------|
| Architecture & layer rules | `docs/architecture.md` | Before creating new files or moving code |
| Code conventions & naming | `docs/conventions.md` | Before writing any new code |
| Prisma & migration rules | `docs/prisma-rules.md` | Before touching database schema |
| OrgId & multi-tenancy | `docs/orgid-scoping.md` | Before writing any data query |
| Import & dependency rules | `docs/import-rules.md` | Before adding imports |
| Testing patterns | `docs/testing.md` | Before writing tests |

## Quick Reference — Where to Find Code

| Area | Path |
|------|------|
| API routes | `packages/api/src/routes/` |
| Database schema | `packages/db/prisma/schema.prisma` |
| Shared types | `packages/shared/src/types/` |
| Frontend pages | `packages/web/src/app/` |
| Domain logic | `packages/*/src/domain/` |
| Infrastructure | `packages/*/src/infrastructure/` |

## Core Rules (Always Apply — No Exceptions)

1. **orgId scoping**: All tenant data queries MUST include `orgId`. Read `docs/orgid-scoping.md`.
2. **Workspace boundaries**: Import packages by name (`@gpc-cres/shared`), never by relative path across packages. Read `docs/import-rules.md`.
3. **Strict TypeScript**: No `any`, no `@ts-ignore`. Use `unknown` + type guards or `@ts-expect-error` with explanation.
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

1. Read the relevant `docs/*.md` file for the area you're working in.
2. Read 2-3 similar existing files and match the patterns.
3. Place new code in the correct package and layer.
4. Add tests for new functionality (read `docs/testing.md`).
5. Run `pnpm verify` before finishing.
