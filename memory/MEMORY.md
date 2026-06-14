# Memory — live index
<!-- The ONLY memory file loaded by default, so keep it SHORT (aim < 60 lines). It's an INDEX + rolling log, not an archive: a few lines of current state plus pointers to detail files. Prune ruthlessly. -->

## Current focus
The harness is a pi extension suite: 6 sub-agent roles (/plan /verify /triage /monitor /report
/research) + 4 main-session extensions (command-guard, secret-redaction, /checks, boundary-instructions),
sharing one allowlist + one redactor via `harness/pi/shared/`. Each role also loads a per-repo
`harness/prompts/<role>-context.md` overlay (3rd prompt layer; autofill + `/enrich <role>`).

## Recent changes (newest first — keep ~7 max)
- 2026-06-14 — Added a 3rd sub-agent prompt layer: per-role `harness/prompts/<role>-context.md`
  (autofilled at bootstrap; refined via new `/enrich <role>` command). `runSubagent` injects it after
  the generic methodology (`readContext`); comment-only ⇒ nothing injected. AGENTS.md just points at it.
- 2026-06-14 — Built /triage /monitor /report /research roles + command-guard / secret-redaction /
  /checks / boundary-instructions extensions; extracted `harness/pi/shared/{checks-core,redact}.ts`;
  generalized `install.sh` (loops all `harness/pi/<ext>/` + installs `shared/`). Validate via `TESTING.md`.
- 2026-06-14 — Phase 0.5: per-role model policy wired into `runSubagent` (/verify→GPT-5.5, rest→Opus
  4.8, `--thinking xhigh`); Phase 0 dead temp-file code removed from `index.ts`.

## Gotchas / rules learned
- pi runtime needs **Node ≥ 22.19**; extensions load via **jiti** (uncompiled TS). Type-check with
  `cd harness/pi && npm install && npm run typecheck` (dev-only deps; `tsc` must stay clean).
- Built-in **write/edit tools use `input.path`** (NOT `file_path`); bash uses `input.command`.
- Sub-agents spawn `--no-extensions`, so main-session hooks (secret-redaction) never see their output
  → the **runner** redacts /monitor logs at the source (`runFixedTee`). Tools enter a sub-agent ONLY
  via `-e` (that's why /research loads web tools via `-e npm:pi-web-access`).
- `runner.ts` has ONE `export default` registering `run_check` + `run_experiment` (helpers); never a
  second default export. `run_experiment` is guarded off when no experiments are configured.
- Path matching (command-guard boundaries, boundary-instructions applyTo) is **repo-root-relative**,
  not cwd-relative — works when pi is launched from a subdir.
- `deliverAs:"steer"` is delivered *after* the current turn's tool calls — for boundary-instructions
  this is a live-pi FLAG (rule may not reach the model before the edit; `{block:true}` is the fallback).

## Index — where detail lives
- Test every feature on a real pi (hands-on checklist) → `TESTING.md`
- How to use the system (worked session + config) → `README.md`
- Architecture / module map → `memory/architecture.md`
- Why behind decisions → `memory/decisions.md`
- Current plan / task slice → `memory/tasks.md`
- Per-feature roadmaps → `memory/plan-<feature>.md` (pi `/plan`); latest verdict → `memory/verdict.md`
- /triage → `memory/triage-<id>.md`; /monitor → `memory/monitor-<run>.md` (+ `memory/runs/<run>.log`,
  gitignored); /report → `memory/reports/<subject>-<date>.md`; /research → `memory/research-<topic>.md`
- Engine internals + per-role model policy → `harness/pi/subagents/README.md`
- Per-role repo context (3rd prompt layer) + `/enrich` → `harness/prompts/<role>-context.md`;
  engine in `harness/pi/subagents/index.ts`; why → `memory/decisions.md`
