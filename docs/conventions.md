# gpc-cres Code Conventions

> Agents must follow these conventions for all code changes.

## TypeScript

- **Strict mode**: `strict: true` in all `tsconfig.json` files.
- **No `any`**: Use proper types. If uncertain, use `unknown` and narrow.
- **No `@ts-ignore`**: Fix the type error instead.
- **Explicit return types**: All exported functions must have explicit return types.
- **Readonly by default**: Use `readonly` for properties that should not be mutated.

## Naming

- **Files**: `kebab-case.ts` (e.g., `user-service.ts`)
- **Classes**: `PascalCase` (e.g., `UserService`)
- **Functions**: `camelCase` (e.g., `getUserById`)
- **Constants**: `SCREAMING_SNAKE_CASE` (e.g., `MAX_RETRY_COUNT`)
- **Interfaces**: `PascalCase`, no `I` prefix (e.g., `UserRecord`, not `IUserRecord`)
- **Type parameters**: Single uppercase letter (e.g., `T`, `K`, `V`)

## Imports

- Use package names for cross-package imports: `@gpc-cres/shared`.
- Group imports: Node built-ins → external packages → internal packages → relative.
- No circular imports between packages.

## Error Handling

- Use typed errors extending `Error`.
- Always include a descriptive `message`.
- API routes catch errors and return structured JSON responses.
- Never swallow errors silently (empty `catch {}`).

## Testing

- Test files: `*.test.ts` or `*.spec.ts` colocated with source.
- Use descriptive `describe`/`it` blocks.
- Mock external services; never call real APIs in tests.
- Test edge cases: empty inputs, null values, unauthorized access.

## Git

- Branch naming: `ai/<timestamp>-<slug>` for automated branches.
- Commit messages: `feat:`, `fix:`, `refactor:`, `test:`, `docs:` prefixes.
- One logical change per commit.
