# gpc-cres Architecture Reference

> This document is the source of truth for the gpc-cres monorepo architecture.
> Agents must consult this before making structural changes.

## Monorepo Layout

gpc-cres is a **pnpm workspaces** monorepo. Every package under `packages/` is an independent workspace with its own `package.json` and `tsconfig.json`.

### Package Dependency Graph

```
web (Next.js) ──→ shared ──→ db (Prisma)
api (Express)  ──→ shared ──→ db (Prisma)
scripts ───────→ shared
```

### Package Responsibilities

| Package | Purpose | Entry Point |
|---------|---------|-------------|
| `packages/api` | REST API server | `src/index.ts` |
| `packages/web` | Next.js frontend | `src/app/` |
| `packages/db` | Prisma schema, migrations, client | `src/index.ts` |
| `packages/shared` | Types, utils, constants, middleware | `src/index.ts` |
| `packages/scripts` | Build tooling, CI helpers | `src/` |

## Multi-Tenancy

gpc-cres is a **multi-tenant** system. Every data model that stores tenant-specific data includes an `orgId` field.

### Rules

- All database queries on tenant-scoped tables MUST filter by `orgId`.
- API routes use `requireAuth` middleware which injects `req.auth.orgId`.
- Never return data from one tenant to another.
- The `orgId` comes from the authenticated session — never from request parameters.

## Database (Prisma)

- Schema lives at `packages/db/prisma/schema.prisma`.
- Migrations are serial. Never create parallel migrations.
- Use `pnpm prisma migrate dev --name <name>` from `packages/db/`.
- After schema changes, run `pnpm prisma generate` to update the client.

## Verification Pipeline

`pnpm verify` at the root runs (in order):
1. `pnpm -r build` — compiles all packages
2. `pnpm -r lint` — ESLint across all packages
3. `pnpm -r test` — Jest/Vitest test suites
4. `pnpm -r typecheck` — `tsc --noEmit` for each package

## Environment Variables

Documented in each package's `.env.example`. Never hard-code secrets. The controller injects credentials via environment at runtime.
