---
name: code-generation
description: >-
  Generate new code following project conventions. Use when the user picks Code
  Generation on the Fast OPC homepage, asks to implement a feature, scaffold a
  module, or write boilerplate that fits the existing codebase.
---

# Code Generation

## Workflow

1. Inspect nearby code: same directory, similar modules, types, and tests.
2. Confirm stack (framework, ORM, test runner) from repo files—not assumptions.
3. Plan the smallest change: files to add or edit, public API surface.
4. Implement with consistent naming, imports, and error handling.
5. Run compile/lint/tests relevant to the touched area when available.

## Output format

```markdown
## Plan
- [Brief bullet plan]

## Changes
- `path/to/file` — what changed and why

## Usage
[How to call or wire the new code, if non-obvious]
```

## Rules

- Reuse existing helpers and patterns; avoid parallel abstractions.
- No speculative features, config, or tests outside the requested scope.
- If the task is underspecified, state assumptions explicitly before coding.
