# Prisma Migration Rules

> Critical rules for database changes in gpc-cres. Violations can corrupt data or break deployments.

## Golden Rules

1. **ONE migration per task**: Never create multiple migrations in a single task.
2. **Serial only**: Migrations execute in filename order. Never create parallel migrations.
3. **Use the CLI**: Always use `pnpm prisma migrate dev --name <name>`. Never hand-write migration SQL.
4. **Regenerate client**: After any schema change, run `pnpm prisma generate`.
5. **Test migrations**: Ensure `pnpm prisma migrate deploy` works on a fresh database.

## Schema Conventions

- All tenant-scoped models include `orgId String`.
- Primary keys use `id String @id @default(cuid())`.
- Timestamps: `createdAt DateTime @default(now())` and `updatedAt DateTime @updatedAt`.
- Relations use explicit `@relation` with descriptive names.
- Indexes on `orgId` for all tenant-scoped models.
- Unique constraints use `@@unique` compound indexes where needed.

## Migration Naming

Format: `YYYYMMDDHHMMSS_descriptive_name`

Examples:
- `20250210143000_add_property_status_field`
- `20250211091500_create_lease_table`

## What NOT to Do

- ❌ Rename columns in production (use add-then-deprecate pattern)
- ❌ Drop tables without a migration plan
- ❌ Change field types without a data migration strategy
- ❌ Add non-nullable columns without defaults to tables with existing data
- ❌ Modify the `_prisma_migrations` table directly
