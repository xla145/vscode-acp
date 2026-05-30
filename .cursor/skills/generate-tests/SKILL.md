---
name: generate-tests
description: >-
  Generate unit or integration tests using the project's test framework and
  patterns. Use when the user picks Generate Tests on the Fast OPC homepage or
  asks for test coverage for selected or open code.
---

# Generate Tests

## Workflow

1. Detect test stack from repo (`package.json`, `vitest`, `jest`, `pytest`, `@Nested`, etc.).
2. Read existing tests in the same module for naming, mocks, and assertions.
3. Cover happy path, key edge cases, and one meaningful failure path.
4. Prefer testing behavior over implementation details.
5. Run the focused test command when possible and fix failures.

## Output format

```markdown
## Test plan
- [Cases to cover]

## Files
- `path/to/test` — new or updated tests

## Commands
`[command to run these tests]`
```

## Rules

- Match project conventions (`@DisplayName`, AssertJ, MockMvc, etc.) when present.
- Mock external I/O; do not hit real network or databases unless integration tests exist.
- No trivial tests that only assert constants or framework behavior.
