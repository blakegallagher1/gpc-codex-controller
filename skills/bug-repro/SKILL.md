---
name: bug-repro
description: |
  Use when: A bug has been reported and you need to create a minimal reproduction test before fixing it.
  Do NOT use when: The bug is already reproduced and you need to fix it (use gpc-cres-fix), or when implementing new features (use gpc-cres-mutation).
  Outputs: A test file that fails with the described bug, plus a BugReproResult summary.
  Success criteria: Test file exists, runs, and fails with the expected behavior mismatch.
---

# Bug Reproduction Skill

## Purpose
Create minimal, reliable reproductions for reported bugs using automated test generation. Always reproduce before you fix — the reproduction test becomes your regression test.

## Tools
- `reproduce_bug` — Given a task workspace and bug description, generates a reproduction test and verifies it fails as expected.

## Workflow
1. **Parse bug description** — Extract expected vs actual behavior, trigger conditions
2. **Identify affected module** — Determine which package/file contains the bug
3. **Generate reproduction prompt** — Build a Codex-targeted prompt that creates a minimal test
4. **Execute via Codex agent** — Agent writes a test file in the workspace
5. **Verify reproduction** — Run the test to confirm it fails as described
6. **Return result** — Includes test file path, reproduction steps, and pass/fail status

## Bug Description Best Practices
Provide:
- **What happens** — The actual broken behavior (e.g., "returns 500 instead of 200")
- **What should happen** — Expected correct behavior (e.g., "should return the deal object")
- **Trigger conditions** — Steps, inputs, or state that cause the bug (e.g., "when orgId has no deals")
- **Environment** — Relevant package, API route, or component (e.g., "packages/api/src/routes/deals.ts")

## Output Template
```json
{
  "taskId": "task-123",
  "reproduced": true,
  "testFile": "packages/api/test/repro-deals-500.test.ts",
  "error": null,
  "steps": [
    "Created reproduction test in packages/api/test/",
    "Test calls GET /api/deals with orgId that has zero deals",
    "Expected: 200 with empty array. Actual: 500 with 'Cannot read properties of null'",
    "Bug confirmed reproducible"
  ]
}
```

## Test Template
```typescript
import { describe, it, expect } from "vitest";
// Import the module under test

describe("Bug reproduction: [short description]", () => {
  it("should [expected behavior] but instead [actual behavior]", async () => {
    // Setup: create the conditions that trigger the bug
    // Act: call the function/endpoint
    // Assert: verify the bug manifests
    expect(result.status).toBe(200); // This will FAIL — proving the bug
  });
});
```

## Negative Examples (Do NOT do these)
- ❌ Writing a fix while reproducing (reproduce ONLY, fix comes later)
- ❌ Creating a test that passes (the point is to demonstrate the failure)
- ❌ Testing unrelated functionality in the reproduction test
- ❌ Modifying source code while creating the reproduction
- ❌ Using hardcoded IDs or real data in reproduction tests (use fixtures)
- ❌ Skipping the verification step (always run the test to confirm it fails)

## Edge Cases
- If the bug description is vague, focus on the most likely interpretation
- If the affected module isn't clear, search for keywords in the codebase first
- If the bug requires database state, create test fixtures in the test file
- If the test passes (bug doesn't reproduce), report `reproduced: false` with details

## Integration
- Use before `fix_until_green` — reproduce first, then fix
- Reproduction tests become regression tests after the fix lands
- Chain: `reproduce_bug` → `gpc-cres-fix` → `review_pr` → `create_pr`
