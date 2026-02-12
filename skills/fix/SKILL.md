---
name: gpc-cres-fix
description: |
  Use when: `pnpm verify` has failed and you need to produce the minimal fix.
  Do NOT use when: Implementing new features or making non-fix changes.
  Outputs: The smallest valid diff that makes `pnpm verify` pass.
  Success criteria: `pnpm verify` exits 0 with no failures.
---

# gpc-cres Fix Skill

You are fixing verification failures in the **gpc-cres** monorepo.

## Diagnosis Workflow

1. **Read the error output**: Identify whether failures are TypeScript compilation, lint, or test failures.
2. **Categorize**: Sort failures by type — type errors, missing imports, lint violations, test assertions.
3. **Prioritize**: Fix compilation errors first (they cascade), then lint, then tests.
4. **Scope**: Only fix what's broken. Do not refactor, do not improve, do not add features.

## Fix Patterns by Error Type

### TypeScript Compilation Errors
- **Missing property**: Add the property to the interface or provide a default.
- **Type mismatch**: Cast correctly or fix the source type. Never use `as any`.
- **Missing import**: Add the import from the correct package (`@gpc-cres/*`).
- **Cannot find module**: Check if the package dependency exists in the workspace's `package.json`.

### ESLint Errors
- **unused-vars**: Remove the variable or prefix with `_` if it's a required parameter.
- **no-explicit-any**: Replace `any` with a proper type.
- **import-order**: Reorder imports per the project's eslint configuration.

### Test Failures
- **Assertion mismatch**: Update the test expectation if the behavior change was intentional.
- **Missing mock**: Add or update test mocks for new dependencies.
- **Timeout**: Check for unresolved promises or missing `await`.

## Constraints (MUST follow)

1. **Minimal diff**: Change only what's needed to fix the specific failure.
2. **No new features**: Do not add functionality while fixing.
3. **No root config changes**: `package.json`, `tsconfig.json`, `eslint.config.mjs` at root are off-limits.
4. **Preserve workspace boundaries**: Fix within the affected package only.
5. **Run verify after each fix attempt**: Confirm the fix actually resolves the failure.

## Negative Examples

- ❌ Rewriting a module to fix a type error (just fix the type)
- ❌ Disabling an ESLint rule to silence a warning
- ❌ Deleting a failing test instead of fixing it
- ❌ Adding `@ts-ignore` or `@ts-expect-error` comments
- ❌ Changing unrelated files while fixing a specific error
- ❌ Creating a new migration to fix a type error (migrations have side effects)

## When Stuck

If the same error persists after 2 fix attempts:
1. Re-read the full error message and stack trace.
2. Check if a dependency is missing from the workspace's `package.json`.
3. Check if the error is in generated code (Prisma client) that needs regeneration.
4. Look at git diff to see if a previous fix introduced a new error.
