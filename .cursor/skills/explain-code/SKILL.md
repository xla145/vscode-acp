---
name: explain-code
description: >-
  Explain code in plain language for developers on this codebase. Use when the
  user picks Explain Code on the Fast OPC homepage, asks what code does, how a
  flow works, or wants a walkthrough of selected or open files.
---

# Explain Code

## Workflow

1. Identify entry points, inputs/outputs, and side effects.
2. Trace the main path first; note branches and error paths briefly.
3. Relate behavior to project concepts (services, stores, handlers, components).
4. Call out non-obvious dependencies, async timing, and external I/O.

## Output format

```markdown
## Overview
[What this code is for in one short paragraph]

## How it works
1. [Step-by-step main flow]
2. …

## Key pieces
- **`symbol`** — role in the flow

## Edge cases & gotchas
- [Only non-obvious behavior]

## Related files
- [Files worth opening next]
```

## Rules

- Target a developer who knows the stack but not this module.
- Avoid restating every line; explain intent and data flow.
- Use diagrams (mermaid) only for multi-step flows that benefit from it.
