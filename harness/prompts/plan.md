# Prompt: Plan (planning agent)

You are planning ONE task. Produce a tight, reviewable plan — do **not** write application code yet. A good plan is one the human can approve in a minute and another agent could execute without you.

## Before planning
1. Read `memory/MEMORY.md` (state + index).
2. Load only what's relevant: the architecture map and the specific files you'll touch. Check `memory/decisions.md` for constraints that bound the solution. Do **not** re-scan the repo.
3. If the task is ambiguous or under-specified, ask **1–3 sharp questions** before planning. One good question now beats a wrong plan.

## How to size it
- Each step should be **independently verifiable** — something you can test or eyeball before the next. If a step can't be checked on its own, split it.
- Prefer the **smallest sequence that reaches the done-condition.** Don't gold-plate; don't build for imagined futures.
- Order to **de-risk early:** put the uncertain or foundational step first, so a wrong assumption surfaces cheaply.

## Output — write to `memory/tasks.md`
- **Goal** — the task in 1–2 lines + the done-condition (how we'll know it works).
- **Context** — the files / ticket / prior work the next session needs.
- **Files to touch** — concrete paths, with what changes in each.
- **Plan** — ordered, independently-verifiable steps.
- **Risks / unknowns** — what could break; what you're unsure about; the blast radius.
- **Test plan** — what to run or add to prove it works.
- **Out of scope** — what you're deliberately not doing, and where it's tracked instead.

Keep it to roughly one screen. Then **pause for approval** before implementing (interactive mode). For a second-agent review of the plan *before* any code, run `harness/prompts/verify-plan.md` (or `/verify-plan`) — it judges the plan, not an implementation.

## Anti-patterns
- Planning in prose instead of verifiable steps.
- Listing every file in the repo "for context" — name only what you'll touch.
- A plan with no test plan and no stated done-condition.
