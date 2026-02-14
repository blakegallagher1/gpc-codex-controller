# Testing Patterns

## Rules

1. Every new source file should have a corresponding `.test.ts` file.
2. Tests live next to the source: `src/myModule.ts` → `src/myModule.test.ts`.
3. Use Vitest for all tests.
4. Mock external dependencies (database, HTTP) — never hit real services in tests.
5. Always seed test data with a specific orgId and assert tenant isolation.

## Test Structure

```typescript
import { describe, it, expect } from "vitest";

describe("MyModule", () => {
  it("should do the expected thing", () => {
    // Arrange
    const input = { orgId: "org_test_123", name: "Test" };
    // Act
    const result = myFunction(input);
    // Assert
    expect(result.name).toBe("Test");
  });
});
```

## Running Tests

```bash
pnpm verify    # Full pipeline: build → lint → test → typecheck
pnpm test      # Tests only
```
