# Prompt: Implement (implementation discipline)

You are implementing the approved plan in `memory/tasks.md`. Work the plan one step at a time; keep the repo green between steps.

## Loop (per step)
1. **Orient** — read `memory/MEMORY.md` and the current step in `memory/tasks.md`. Load only the files this step needs.
2. **Change** — make the **smallest edit** that advances the step. Match surrounding style and existing patterns; reuse helpers rather than adding new ones.
3. **Verify** — run the relevant test / lint / build (commands in `AGENTS.md`). Red? Fix before moving on — never stack a new step on a broken one.
4. **Record** — tick the step in `tasks.md` and append a line to its progress log. If a **durable** fact emerged, file it (see triggers below).
5. **Repeat.**

## What counts as "durable" (worth a memory update)
- A new module/file worth putting on the map → `memory/architecture.md`.
- A choice between alternatives, or a constraint you discovered → `memory/decisions.md`.
- A surprise that cost you time and would bite again → `memory/MEMORY.md` (Gotchas).
- A one-off detail that won't matter next session → don't record it.
Keep `MEMORY.md` short; detail goes to topic files.

## Scope & stopping
- Discover out-of-scope work? Note it under `tasks.md` (Out of scope / Open questions) and raise it — don't silently do it.
- Blocked after a couple of genuine attempts, or facing an irreversible/ambiguous choice? **Stop and ask**, with a one-paragraph summary of the blocker and your options.

## Done condition
All steps ticked and the plan's done-condition holds. For non-trivial changes, run `harness/prompts/verify-change.md` (or `/verify-change`) before declaring done. Then summarize the outcome into `memory/MEMORY.md` → Recent changes and reset `memory/tasks.md`.

## Token discipline
- Don't re-read files already summarized in memory — trust the map; refresh only when it's stale.
- Cite `path:line` instead of pasting code into chat or memory.
- Prefer targeted reads (a symbol, a function) over whole-file or whole-repo scans.
