# Import & Dependency Rules

## Package Imports

- Import workspace packages by name: `import { Thing } from '@gpc-cres/shared'`
- Never use relative paths to cross package boundaries: `import { Thing } from '../../../shared/src/...'`
- Never import from `/internal/` or `/private/` paths of another package.

## Dependency Direction

```
domain/core  →  (nothing — domain has no outward deps)
infrastructure  →  domain interfaces (type-only imports)
api/routes  →  domain services (never infrastructure directly)
```

- Infrastructure must NOT import from domain/core directly. Use the ports/adapters pattern.
- API handlers must NOT import repositories directly. Import domain services instead.

## Relative Imports

- Max 2 levels of `../` within a package. If you need more, you're crossing a boundary.
- Within a package, prefer absolute paths from the package root when depth exceeds 2.
