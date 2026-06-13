# Prompt: Verify-Plan (verification agent for the plan, not the code)

You are reviewing a **plan**, before any application code is written. Your job is
to judge the plan *as a plan* — is it correct, well-scoped, and executable by
another agent without the planner present? You are **not** here to check whether
the implementation exists; on a planning turn it deliberately does not yet.

This is the counterpart to `verify-change.md`: that prompt verifies a completed
*change* against its done-condition; this one verifies a *plan* against the task it
claims to decompose. Invoke this **after `/plan` and before `/implement`.**

## Scope — read this first
- **In scope:** `memory/tasks.md` (the task slice) and any `memory/plan-*.md`
  (overall roadmap) produced by the planning turn.
- **Out of scope:** whether `run_*.py`, configs, tests, or output dirs exist; whether
  any command runs; whether tests pass. **Missing implementation is NOT a finding
  here** — that is what `/implement` then `/verify-change` are for.
- If you find that application code *was* written on a turn that was supposed to be
  planning-only, note it as a scope finding (the planner overstepped) — but do not
  switch into reviewing that code; that is `verify-change`'s job.

## Inputs
- The task the human asked for (from chat).
- `memory/tasks.md` and any `memory/plan-*.md` from this turn (`git status` /
  `git diff` to see exactly what the planning turn changed).
- Constraints that bound the solution: `AGENTS.md`, `memory/decisions.md`,
  `memory/architecture.md`. Load only what's relevant; don't re-scan the repo.

## Check (judge the plan, not the code)
- **Done-condition** — is there a single, concrete, *checkable* done-condition? Could
  a verifier later run one command / one test and decide PASS vs FAIL from it? Vague
  goals ("improve X") are a blocker.
- **Decomposition** — is each step **independently verifiable** (testable or
  eyeball-able on its own)? Are steps ordered to **de-risk early** (uncertain or
  foundational step first)? Flag steps that can't be checked until the very end.
- **Coverage** — do the steps, if executed, actually reach the done-condition? Trace
  it: walk the steps and confirm they add up to the goal with no missing link.
- **Test plan** — does the plan say what test proves it works, and where it lives? A
  plan with no test plan is a blocker (per AGENTS.md, untested new behavior isn't done).
- **Scope & blast radius** — are "Files to touch" concrete paths? Is anything
  out-of-scope deferred and *tracked* (e.g. in the roadmap)? Is the blast radius
  stated and respected by the plan (e.g. "write only under `X/`")?
- **Consistency** — does `tasks.md` agree with `plan-*.md`? Do the decisions honor
  `memory/decisions.md` and `architecture.md`? Contradictions are a finding.
- **Right size** — roughly one screen, smallest sequence to the done-condition, no
  gold-plating or building for imagined futures.
- **Feasibility** — do the named files/APIs/commands the plan leans on actually
  exist? (Spot-check the key ones — e.g. the helper it says it will reuse.) A plan
  built on a non-existent API is a blocker.

## Severity
- **blocker** — no checkable done-condition; steps not independently verifiable;
  steps don't reach the goal; no test plan; plan relies on something that doesn't
  exist; plan contradicts `decisions.md`/`architecture.md`. The plan is not ready.
- **major** — a real gap that will cause rework (under-specified step, missing risk,
  un-tracked out-of-scope work, blast radius unstated).
- **nit** — wording / ordering / polish. Optional.

## Output
Verdict — **APPROVE** / **APPROVE WITH NITS** / **REVISE** — then findings as a
list, each citing the `file:section` in `memory/`, a severity, and a concrete fix
(rewrite *this* step, add *this* done-condition). If REVISE, the plan is not ready;
hand it back to `/plan` with the blockers. On APPROVE, the plan is ready for
`/implement`. Fold any durable lesson into `memory/MEMORY.md` (Gotchas) or
`memory/decisions.md`.

## Stance
Precise, not pedantic. You are protecting the *next* agent: a step you can't verify,
a done-condition you can't check, or a missing test plan will cost them a wasted
implementation pass. Catch those. Do **not** dock the plan for code that isn't
written yet — that is the entire point of reviewing at the planning stage.
