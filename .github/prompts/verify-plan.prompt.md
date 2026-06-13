---
description: Verify the PLAN (not the implementation) in memory/tasks.md before any code is written
mode: agent
---
Follow the instructions in [harness/prompts/verify-plan.md](../../harness/prompts/verify-plan.md).

Inputs: the task I describe in chat plus the planning deliverables from this turn — `memory/tasks.md` and any `memory/plan-*.md` (use `git status`/`git diff` to see what the planning turn changed). Judge the plan *as a plan*: checkable done-condition, independently-verifiable steps that reach the goal, a test plan, bounded scope, and consistency with `memory/decisions.md`.

Do NOT treat missing implementation as a defect — no code exists yet by design; that is what `/implement` then `/verify-change` cover. End with a verdict: APPROVE / APPROVE WITH NITS / REVISE, plus findings as `file:section` + fix.
