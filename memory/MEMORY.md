# Memory — live index
<!-- The ONLY memory file loaded by default, so keep it SHORT (aim < 60 lines). It's an INDEX + rolling log, not an archive: a few lines of current state plus pointers to detail files. Prune ruthlessly. -->

## Current focus
The harness is a pi extension suite: 6 sub-agent roles (/plan /verify /triage /monitor /report
/research) + 4 main-session extensions (command-guard, secret-redaction, /checks, boundary-instructions),
sharing one allowlist + one redactor via `harness/pi/shared/`. Reuse discipline (ponytail) is baked
into the brief + offered as an optional referenced pi extension. A 5th, opt-in main-session extension —
auto-judge (LLM-as-judge tool-call gate, default OFF) — is built (slices 1–3: parser/config, activation
wiring, checks.json/docs); only the live-pi smoke (re-run `install.sh` + `/reload` on an authed node) remains. See `memory/plan-llmjudge.md`.
**Now building two model-callable tools** — `delegate` (general read-only subagent) then `workflow` (governed
parallel fan-out) — per `memory/plan-general-subagent.md` + `memory/plan-workflow.md`. **delegate slice 1
(the shared `subagent-core.ts` extraction + auto-judge de-dup) is DONE** (offline-gated); slice 0 + all
live-pi smokes are FLAGs pending an authed pi (`pi` is installed here but `auth.json` is empty — needs `/login`).
**Also in flight — dual-mode subagents** (`memory/plan-subagent-dual-mode.md`): make every role model-callable
mid-turn + add `/<role>-main` + switch models to Copilot-only. Slice 1 (tool-mode `subagent_*`) is BUILT; slices
2–4 pending. Pausing for human review between slices.

## Recent changes (newest first — keep ~7 max)
- 2026-06-20 — **Dual-mode subagents slice 1 BUILT (tool-mode = the reported bug fix).** The 6 roles are
  now ALSO model-callable mid-turn via namespaced tools `subagent_{plan,verify,triage,monitor,report,research}`
  (the `subagent_` prefix is mandatory — registry is last-write-wins, no collision error). Each command
  body refactored into a shared `runXRole(input, rctx)`; pure prompt builders extracted to
  `subagents/userturns.ts` (offline-tested, +16 → **58 tests**). Tool-mode = summary-only `content`,
  THROW on failure (a *returned* `isError:true` is inert), `executionMode:"sequential"`, wall-clock timeout
  + `ctx.signal`, `registerShutdownGuard(pi)` reclaims children on /reload|quit. **Command-mode preserved
  byte-for-byte** (no signal, no timeout). typecheck clean. Slices 2 (Copilot ids) / 3 (gate) / 4 (`/<role>-main`)
  pending. See `memory/plan-subagent-dual-mode.md`.
- 2026-06-20 — **delegate slice 1 BUILT** (the subagent-core extraction; offline-gated). New
  `harness/pi/shared/subagent-core.ts` = `runSubagent` (+ optional `signal`, kills child immediately if
  pre-aborted), `getPiInvocation`, `extractSummary`, `subagentFailed`, `MODEL_DEFAULT`/`MODEL_REVIEW`/`EFFORT`,
  + cross-cutting safety helpers `cleanDetails` (metadata-only details) / `redactOnWrite` (redact-then-byte-cap
  before fs writes) / `registerShutdownGuard(pi)` (+ module live-children `Set`; SIGTERM→SIGKILL on
  session_shutdown; exported fn, NOT top-level `pi.on`). `subagents/index.ts` (−170 lines) + `auto-judge/index.ts`
  now IMPORT them — **auto-judge's dup `getPiInvocation`/`MODEL_REVIEW`/`EFFORT` DELETED** (drift killed).
  Typecheck clean; **42 tests** (13 new). Remaining: live `/plan`+`/verify` smoke (FLAG — authed pi). See `memory/plan-general-subagent.md`.
- 2026-06-18 — **Investigated + planned** a minimal **workflow** function: a `workflow` tool = N
  parallel read-only `delegate` workers + a governor that right-sizes the fan-out (hard cap + prompt
  guideline baseline, optional `runJudge`-backed LLM right-sizer that prunes/merges, fails OPEN to the
  cap). Depends on `delegate`. PLAN ONLY; reviewed 4× — R3 **BLOCKER** (disk writes bypass redaction →
  redact-at-source + `.gitignore memory/workflow/`) + governor is cost-not-safety gate; R4:
  session_shutdown orphans, dead `objective` (→ feed workers), judge only ≥`2×maxParallel`, injectable
  pool; R5: delete auto-judge dupes (ordered runJudge move), clamp `maxParallel` (governor kill-switch),
  `workflowSeq`/`<i>` filename uniqueness; all folded. See `memory/plan-workflow.md`.
- 2026-06-18 — **Investigated + planned** a model-callable general subagent (the pi analog of Claude
  Code's Task/Agent tool): `pi.registerTool("delegate")`, read-only (`explore`) surface, reusing
  `runSubagent`. PLAN ONLY; **revised after FIVE independent reviews** (de-risk ordering, cap reset on
  `agent_start`, exfil, guard gaps; R3: always-register+check-at-execute [factory has no cwd], `details`
  un-redacted channel, return-path injection, headless=zero-gates, `promptSnippet`; R4: session_shutdown
  orphans, operator-visibility regression, doc reconciliation, input-schema validation, RPC `hasUI`;
  R5: delete auto-judge dupes, config-validation rigor vs `verdict.ts`, shutdown-guard import purity).
  Model: workers→`MODEL_DEFAULT`; judges stay `MODEL_REVIEW` per D7 (DECIDED: scopes to workers only).
  See `memory/plan-general-subagent.md`.
- 2026-06-15 — **auto-judge** built (slices 1–3): pure `parseVerdict`/`loadAutoJudgeConfig` + 29-case
  test (`auto-judge/verdict.ts`), the `tool_call` activation gate (`index.ts`; default OFF, `/autojudge on`,
  single-shot GPT-5.5 judge, blocks DENY/fail-closed), and `checks.json`/template/docs wiring (D6/D7 in
  `decisions.md`). Remaining: re-run `install.sh` + `/reload` + live-pi smoke. See `memory/plan-llmjudge.md`.
- 2026-06-14 — Integrated ponytail (reuse discipline): baked the reuse-ladder into `AGENTS.md` +
  the template ("Build discipline"); documented the optional referenced pi extension
  (`pi install git:github.com/DietrichGebert/ponytail`) in both READMEs + install.sh. See `decisions.md`.
- 2026-06-14 — Added live end-to-end pi verification plan at `memory/plan-live-pi-e2e.md`;
  assumes installed tooling and focuses on model selection, roles, guards, redaction, /checks, and MCP.
  (Earlier 2026-06-14: built /triage /monitor /report /research + 4 main-session extensions + shared/
  extraction + generalized install.sh — see `BUILD-REPORT.md`.)

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
- **Custom-tool gating asymmetry** (verified, relevant to any `registerTool`): `command-guard` blocks
  ONLY `bash`/`shell` + `write`/`edit` (`command-guard/index.ts:82,93`) — it does NOT gate custom tools
  or `read`. `secret-redaction`'s `tool_result` hook scrubs ONLY the result **`content`** (not `details`,
  which is `unknown` and crosses back raw; not `fs.writeFileSync` — disk writes need source redaction like
  `runFixedTee`), and only secret-shaped patterns. Built-in `read` takes absolute paths, can't be
  path-jailed via `--tools`. `ExtensionFactory = (pi) => void` has **no cwd** (use `process.cwd()` at load
  or `ctx.cwd` at `execute`); a tool's `execute` ctx exposes `ctx.ui.confirm`, `ctx.ui.setStatus`,
  `ctx.hasUI`, `ctx.signal`, `ctx.cwd`. Tools need `promptSnippet` to appear in the "Available tools"
  list. `hasUI` is true in **TUI AND RPC**, false only in `--mode json/print`. **No `session_shutdown`
  handler exists in the harness** — a tool `execute` runs *during streaming*, so a subprocess it spawns
  needs a tracked-children `Set` + `session_shutdown` SIGTERM→SIGKILL to avoid orphans on `/reload`/quit
  (`ctx.signal` covers abort, not shutdown).
- **New extension dir needs `install.sh` (symlinks per-dir); `/reload` re-runs factories but can't add
  a never-installed dir.** Config rigor: `checks-core` `loadConfig` is near-zero validation — mirror
  `auto-judge/verdict.ts withDefaults` (clamp numerics `[1,ceiling]`, type booleans, non-object/`[]` block
  inert, `{}`=defaults). `subagent-core.ts` now owns `getPiInvocation`/`MODEL_REVIEW`/`EFFORT`/`runSubagent`
  + the cross-cutting `cleanDetails`/`redactOnWrite`/`registerShutdownGuard`; `subagents` + `auto-judge`
  import them (dup DELETED 2026-06-20). `runJudge` still lives in `auto-judge/index.ts` — move it to
  `subagent-core.ts` in the workflow slice (the right-sizer reuses it); do NOT drag `JUDGE_SYSTEM_PROMPT`/`parseVerdict` along.

## Index — where detail lives
- Build report + live-pi FLAG status → `BUILD-REPORT.md`
- Hand to an independent verifier (on an authed pi) → `VERIFICATION-AGENT-PROMPT.md`
- Live installed-machine E2E checklist → `memory/plan-live-pi-e2e.md`
- How to use the system (worked session + config) → `README.md`
- Architecture / module map → `memory/architecture.md`
- Why behind decisions → `memory/decisions.md`
- Current plan / task slice → `memory/tasks.md`
- Per-feature roadmaps → `memory/plan-<feature>.md` (pi `/plan`); latest verdict → `memory/verdict.md`
- /triage → `memory/triage-<id>.md`; /monitor → `memory/monitor-<run>.md` (+ `memory/runs/<run>.log`,
  gitignored); /report → `memory/reports/<subject>-<date>.md`; /research → `memory/research-<topic>.md`
- Engine internals + per-role model policy → `harness/pi/subagents/README.md`
- Dual-mode subagents (model-callable `subagent_*` tools + `/<role>-main`) + Copilot-only model fix (**slice 1 tool-mode BUILT 2026-06-20**; slices 2 Copilot-ids / 3 gate / 4 `/<role>-main` pending — namespaced tools, body-only `-main`, persist/restore, repo-wide id sweep) → `memory/plan-subagent-dual-mode.md`
