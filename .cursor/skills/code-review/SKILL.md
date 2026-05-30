---
name: code-review
description: >-
  Structured code review for quality, bugs, and security. Use when the user picks
  Code Review on the Fast OPC homepage, asks for a review, PR feedback, or
  potential issues in selected or open code.
---

# Code Review

## Workflow

1. Scope: selected code, diff, or files the user indicated.
2. Read surrounding context (callers, types, tests) before judging isolated lines.
3. Check correctness, edge cases, security, performance, maintainability, tests.
4. Prioritize findings; skip nitpicks unless they repeat a project anti-pattern.

## Output format

```markdown
## Summary
[1–2 sentences: overall risk and readiness]

## Findings

### Critical
- **[title]** — file:line — impact and fix

### Suggestion
- **[title]** — file:line — why and suggested change

### Nice to have
- [Optional polish]

## Test gaps
- [Missing or weak coverage, if any]
```

## Rules

- Every non-trivial finding references a file and line when possible.
- Prefer actionable fixes over vague advice.
- Do not rewrite large sections unless asked; propose targeted changes.
