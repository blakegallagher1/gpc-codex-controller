# OrgId Scoping Rules

gpc-cres is multi-tenant. Every data access MUST be scoped to an orgId.

## Rules

1. Every Prisma query (`findMany`, `findFirst`, `findUnique`, `update`, `delete`, `count`, `aggregate`) MUST include `orgId` in the `where` clause.
2. The `orgId` comes from the authenticated request context: `req.orgId` or `ctx.orgId`.
3. Never pass orgId as a query parameter or URL path segment — it comes from the auth token.
4. When creating new records, always set `orgId` from the context.
5. When writing tests, always seed with a specific orgId and assert that queries only return data for that orgId.

## Examples

```typescript
// CORRECT
const properties = await prisma.property.findMany({
  where: { orgId, status: "active" },
});

// WRONG — missing orgId (data leak across tenants)
const properties = await prisma.property.findMany({
  where: { status: "active" },
});
```
