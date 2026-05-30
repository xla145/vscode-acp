---
name: document-generation
description: >-
  Generate documentation and inline comments for modules and APIs. Use when the
  user picks Document Generation on the Fast OPC homepage or asks for README
  sections, JSDoc, docstrings, or API docs for selected or open code.
---

# Document Generation

## Workflow

1. Identify audience: internal devs, API consumers, or end-user docs.
2. Scan existing doc style (JSDoc, TSDoc, docstrings, README patterns).
3. Document public API, parameters, return values, errors, and examples.
4. Add only comments that explain non-obvious behavior—not narrated code.

## Output format

```markdown
## Scope
[What was documented]

## Updates
- `path` — summary of doc additions

## Example
[Minimal usage example if helpful]
```

## Rules

- Public exports get full signatures and behavior notes; keep private helpers undocumented unless complex.
- Examples must compile or match real API usage.
- Prefer updating existing README/API docs over duplicating content in chat only.
