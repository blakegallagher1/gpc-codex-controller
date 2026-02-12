# Bug Reproduction Skill

## Purpose
Create minimal, reliable reproductions for reported bugs using automated test generation.

## Tools
- `reproduce_bug` — Given a task workspace and bug description, generates a reproduction test and verifies it fails as expected.

## Workflow
1. **Parse bug description** — Extract expected vs actual behavior, trigger conditions
2. **Generate reproduction prompt** — Build a Codex-targeted prompt that creates a minimal test
3. **Execute via Codex agent** — Agent writes a test file in the workspace
4. **Verify reproduction** — Run the test to confirm it fails as described
5. **Return result** — Includes test file path, reproduction steps, and pass/fail status

## Bug Description Best Practices
Provide:
- **What happens** — The actual broken behavior
- **What should happen** — Expected correct behavior
- **Trigger conditions** — Steps, inputs, or state that cause the bug
- **Environment** — Relevant versions, config, or feature flags

## Output
```json
{
  "taskId": "...",
  "reproduced": true,
  "testFile": "test/repro-bug-123.test.ts",
  "error": null,
  "steps": [
    "Created reproduction test",
    "Test fails with: expected 200, got 500",
    "Bug confirmed reproducible"
  ]
}
```

## Integration
- Use before `fix_until_green` — reproduce first, then fix
- Reproduction tests become regression tests after the fix lands
