---
description: SAMPLE path-scoped rule — customize the applyTo glob and rules for your repo, or delete
applyTo: "src/api/**/*.ts"
---
<!-- SAMPLE — edit or delete. Files in .github/instructions/ load ONLY for files matching `applyTo`, and STACK with copilot-instructions.md, so deep/narrow rules cost zero tokens everywhere else. One file per topic; comma-separate multiple globs in applyTo. -->

- Validate input at the boundary in every API handler; reject early.
- Use the shared error envelope from `src/api/errors.ts` — never hand-roll error shapes.
- One handler per file; export a typed handler signature.
