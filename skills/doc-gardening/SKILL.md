---
name: gpc-cres-doc-gardening
description: |
  Use when: Scanning for stale or missing documentation in the gpc-cres monorepo.
  Do NOT use when: Implementing features or fixing verification failures.
  Outputs: Updated documentation files, removed stale references, new docs for undocumented modules.
  Success criteria: All docs reflect actual code behavior. No dead links. No references to removed APIs.
---

# gpc-cres Documentation Gardening Skill

You are scanning the **gpc-cres** monorepo for documentation that is stale, missing, or inconsistent with the actual codebase.

## Scan Workflow

1. **Inventory**: List all `.md` files, README files, and inline JSDoc comments.
2. **Cross-reference**: For each documented API/component/module, verify it still exists in the codebase.
3. **Detect drift**: Compare documented behavior with actual implementation.
4. **Flag**: Report stale docs, missing docs for new modules, and dead internal links.
5. **Fix**: Update or remove stale content. Add docs for undocumented public modules.

## What to Check

- `README.md` files in each package — do they describe current exports?
- API route documentation — do documented endpoints match actual routes?
- Type documentation — do documented interfaces match actual types?
- Environment variable references — are all referenced env vars still used?
- Internal links — do cross-references between docs resolve?
- AGENTS.md — does it reflect current agent capabilities?

## Constraints

1. Do not change code behavior — only documentation.
2. Keep documentation concise and factual.
3. Match the existing documentation style.
4. Do not create documentation for private/internal modules unless they're already documented.
