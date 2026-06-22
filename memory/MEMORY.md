# Memory — live index
<!-- The ONLY memory file loaded by default, so keep it SHORT (aim < 60 lines). It's an INDEX + rolling log, not an archive: a few lines of current state plus pointers to detail files. Prune ruthlessly. -->

## Current focus
The harness is a pi extension suite: 6 sub-agent roles (/plan /verify /triage /monitor /report
/research) + 4 main-session extensions (command-guard, secret-redaction, /checks, boundary-instructions),
sharing one allowlist + one redactor via `harness/pi/shared/`. Reuse discipline (ponytail) is baked
into the brief + offered as an optional referenced pi extension. A 5th, opt-in main-session extension —
auto-judge (LLM-as-judge tool-call gate, default OFF) — is built (slices 1–3: parser/config, activation
wiring, checks.json/docs); only the live-pi smoke (re-run `install.sh` + `/reload` on an authed node) remains. See `memory/plan-llmjudge.md`.
**`delegate` (model-callable read-only subagent) is COMPLETE — slices 1–4** per `memory/plan-general-subagent.md`:
slice 1 = shared `subagent-core.ts` + auto-judge de-dup; slice 2 = the `harness/pi/delegate/` tool; slice 3 =
`delegate` block in checks.json (+ example, `"delegate"` in guardedTools) + doc reconciliation + `decisions.md`;
slice 4 = **live smoke PASSED keyless** (model→delegate→isolated read-only worker→text; confirm blocks+declines;
per-request cap refuses; bad-model→throw→isError; details metadata-only). Worker OUTPUT quality needs Opus
(local 8B emits tool-calls-as-text); plumbing all proven. **Next: `workflow`** (`memory/plan-workflow.md`, depends
on delegate). **Slice 0 is
PROVEN via a local keyless model** (Ollama `llama3.1:8b` in `~/.pi/agent/models.json`, no auth/cost): the
main model calls a main-session `registerTool` tool (Claim 1, `--mode json` + RPC); `ctx.ui.confirm` blocks
mid-execute when `hasUI=true` (NIT-3, via RPC). Only the cosmetic TUI modal *render* needs human eyes.
Other live FLAGs (slice-2/4 smokes) can now run the same keyless way; subscription `/login` no longer required.
**Also done — dual-mode subagents** (`memory/plan-subagent-dual-mode.md`): every role is model-callable
mid-turn (`subagent_*`) + `/<role>-main` in-session modes + Copilot-only models. **All 4 slices BUILT
(offline-gated).** Remaining: live-pi smokes (tool-mode round-trip, `/verify-main` survives /reload,
gate) — keyless-runnable but model-quality-limited (see `TESTING.md`); + the Copilot-id live FLAG.

## Recent changes (newest first — keep ~7 max)
- 2026-06-21 — **Dual-mode slice 4 BUILT (`/<role>-main` in-session modes) — feature COMPLETE.** New pure
  `subagents/role-main.ts` (tool-clamp tables + the load-bearing `isToolBlockedInRoleMain` gate predicate +
  on/off parser; no `.js` imports → bare-node-testable). 4a: `/plan|verify|triage|report-main on|off` —
  single-slot `activeRole`, snapshot→clamp tools (`setActiveTools`), `before_agent_start` injects BODY-ONLY
  (F1), `tool_call` block-gate (load-bearing), **persist via `appendEntry` + restore on `session_start`**
  (re-clamp + re-arm) + null→full safety net (N2). 4b: `/monitor-main`+`/research-main` = isolated
  sub-agent (shared `monitorCmd`/`researchCmd` + `postXOutcome` helpers). **F2:** stripped the terminal
  file/SUMMARY contract from triage.md + report.md bodies (it stays in the `handoff*` builders → isolated
  sub-agent unchanged). `run_check` is sub-agent-only → silently dropped from verify/triage-main clamp
  (documented). +8 tests (**118**), typecheck clean. README/TESTING/decisions updated. See `memory/plan-subagent-dual-mode.md`.
- 2026-06-21 — **Dual-mode slice 3 BUILT (auto-judge gate config).** Added the six EXACT role-tool names
  (`subagent_plan/verify/triage/monitor/report/research`) to `autoJudge.guardedTools` in `harness/checks.json`
  + the python-lmcache example (alongside `delegate`); `contextDiff` stays false (cost, N8); `$autoJudge-note`
  documents the posture (auto-judge-only gating, no hard cap, exact-match → typo silently un-gates). New
  offline **drift guard** `subagents/gate-config.test.ts` (4 tests): the `subagent_*` names REGISTERED in
  index.ts == those GUARDED in both checks.json files, + contextDiff false; negative-tested (drop a name → FAIL).
  typecheck clean, **110 tests**. See `memory/plan-subagent-dual-mode.md`.
- 2026-06-21 — **Dual-mode slice 2 BUILT (Copilot-only model ids + repo-wide guard).** `MODEL_DEFAULT`/
  `MODEL_REVIEW` in `shared/subagent-core.ts` → `github-copilot/claude-opus-4.8` / `github-copilot/gpt-5.5`
  (auto-judge + subagents import them — ONE place, no per-file edits). Swept the stale direct ids from 4
  tracked docs (README, VERIFICATION-AGENT-PROMPT, BUILD-REPORT, decisions) + untracked plan-live-pi-e2e;
  **`git rm --cached tmp/agent-system-plan/` + `.gitignore tmp/`** (carried forbidden ids). New repo-wide
  guard `harness/pi/model-id-guard.test.ts` (git-grep; FAILS on any `openai/`|`anthropic/` id in tracked
  files; negative-tested). New `TESTING.md` runbook (offline gate + live smokes + gotchas). typecheck clean,
  **~102 tests** (+1 guard; count drifts with concurrent workflow work). **LIVE FLAG:** the 2 Copilot ids
  are UNVERIFIED — this node has only `anthropic`+`ollama`
  providers (no `github-copilot`); id format (`4.8` dotted vs live anthropic `4-8` dashed) also unconfirmed.
  Confirm via `pi --list-models` on a Copilot node. See `memory/plan-subagent-dual-mode.md`.
- 2026-06-21 — **workflow slice 2 BUILT** (the tool; offline-gated, review-clean). `workflow/index.ts` =
  `registerTool("workflow")`: schema + execute-time `normalizeTasks` refuse; per-request cap (reset on
  agent_start); `hasUI` confirm; `rightSize` governor → `runPool` → read-only workers (`runSubagent`,
  fed `objective`, per-worker timeout via `AbortSignal.any`); **`redactOnWrite`** capped files at
  `memory/workflow/<runId>/<i>-<slug>.md` (`workflowSeq`+`<i>` uniqueness, `paths.ts` validator); compact
  index back, `details` metadata-only; opt-in synth over already-redacted files. `harness/prompts/workflow.md`.
  **106 tests** (+4 paths); review folded 1 minor (the standalone `mkdirSync` + synth fs writes now guarded
  → partial index survives an fs throw — plan NIT-1). workflow symlinked. **Slice 3 DONE** (review-clean,
  0 findings): `workflow` block + `$workflow-note` in checks.json + the python-lmcache example, `"workflow"`
  in `autoJudge.guardedTools` (both files); doc reconciliation (README/architecture/glossary/subagents-README/
  AGENTS+template) + `decisions.md` entry. **110 tests.** Next: slice 4 (keyless live fan-out smoke).
- 2026-06-21 — **workflow slices 0–1 BUILT** (governed parallel fan-out; offline-gated). Slice 0: `runJudge`
  moved to `subagent-core.ts` (auto-judge's 2nd dup gone). Slice 1 — `harness/pi/workflow/`: `config.ts`
  (`loadWorkflowConfig`, verdict.ts rigor — maxParallel ceiling 8 = kill-switch, concurrency clamped to
  [1,maxParallel] incl. default-collapse, judgeThreshold 2×maxParallel); `right-size.ts` (PURE: normalize/
  clampKept/parseRightSizerReply/runPool — bare-node-testable, no `.js` imports); `pruner.ts` (impure
  `rightSize` — runJudge-backed, MODEL_REVIEW per D7, fail-OPEN + ALWAYS-clamp). `runPool` = injectable
  concurrency pool (cap-honoring, throw→null, **abort drains queue + in-flight see signal**). `.gitignore
  memory/workflow/`. **102 tests** (+24); review folded 1 major (redact-BEFORE-write ordering now pinned by
  a throwing-redactor test, in workflow + subagent-core) + 1 nit (bare `KEEP:` → no junk task). Next:
  slice 2 (the `workflow` tool: registerTool → governor → pool → workers → redact-on-write index). See `memory/plan-workflow.md`.
- 2026-06-21 — **delegate slice 4 — LIVE SMOKE PASSED (keyless, Ollama llama3.1:8b).** End-to-end: main
  model CALLS delegate → spawns an ISOLATED read-only worker (nested `/v1`) → returns text; `details`
  metadata-only (`{mode,turns,model}`); block `model` override honored. Confirm gate (RPC, hasUI=true):
  fires BEFORE spawn showing the prompt, BLOCKS until answered (held ~1.2s), and `confirmed:false` →
  "spawn declined" (no spawn). Per-request cap (set to 1) → 2nd call refused pre-spawn. Bad worker model
  → delegate THROWs → loop `isError=True` (proves the throw path; a returned isError is inert). Worker
  OUTPUT quality model-limited (8B emits tool-calls-as-text under the heavy prompt) — needs Opus; all
  PLUMBING proven. Not driven (lower value / hard keyless): abort-kill, /reload-orphan, auto-judge gate
  (mechanism = `"delegate"` in guardedTools, configured). Smoke-only config tweaks reverted. delegate done.
- 2026-06-20 — **delegate slice 3 BUILT** (config + docs; review-clean). `delegate` block + `$delegate-note`
  in `harness/checks.json` and the python-lmcache example, **both with `"delegate"` in `autoJudge.guardedTools`**
  (the headless gate). Doc reconciliation (R4-MAJOR, amend stale framing not bolt-on): `harness/README.md`
  Principle 4 carve-out + a delegate bullet; `subagents/README.md` cross-ref; `architecture.md` glossary +
  checks.json block inventory; `AGENTS.md` + template line-16 note; **`decisions.md`** entry (delegate +
  the 2026-06-18 **workers→MODEL_DEFAULT / judges→MODEL_REVIEW (D7)** directive, now recorded). Also: hard
  `subagentFailed` now **THROWs** (refusals still return) per the isError-inert finding. Both JSON validate;
  typecheck clean, 76 tests. Review folded 1 nit. delegate symlinked. See `memory/plan-general-subagent.md`.
- 2026-06-20 — **Slice 0 PROVEN without auth via a local keyless model.** Stood up Ollama + `llama3.1:8b`
  (wired in `~/.pi/agent/models.json`, `api:openai-completions`, `compat` developer-role/reasoning-effort
  off). Throwaway probe `harness/pi/_probe0/` (echo_probe tool). Verified: (1) **Claim 1** — the main model
  emits a real native tool call to a main-session `registerTool` tool (`--mode json -p` AND `--mode rpc`);
  (2) **NIT-3** — `ctx.ui.confirm` BLOCKS mid-execute when `hasUI=true` (RPC driver held the tool 1.5s until
  the `extension_ui_response`, result reflected the answer). qwen2.5-coder:7b emitted tool calls as TEXT
  (unusable) — llama3.1:8b does native `tool_calls`. **Residual:** TUI modal *render* = human eyes only.
  Probe + ollama still installed; clean up after the TUI check. See `memory/plan-general-subagent.md` slice 0.
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
  import them (dup DELETED 2026-06-20). `runJudge`/`JudgeOutcome`/`RunJudgeOptions` ALSO moved to
  `subagent-core.ts` (workflow slice 0, 2026-06-21) — auto-judge imports them; both its dups now gone.
  `JUDGE_SYSTEM_PROMPT`/`parseVerdict` stayed in auto-judge (the workflow right-sizer brings its own).
- **Running live-pi FLAGs keyless (no `/login`):** point `~/.pi/agent/models.json` at a local Ollama model
  (`api:openai-completions`, `baseUrl:.../v1`, `compat.supportsDeveloperRole/ReasoningEffort:false`). Model
  MUST do **native** `tool_calls` over `/v1` — `llama3.1:8b` does; `qwen2.5-coder:7b` emits tool calls as
  plain TEXT (pi can't see them). Verify a candidate with a direct `curl .../v1/chat/completions` + `tools`.
- **Live `subagent_*` tool-mode smoke — hard-won gotchas (2026-06-21, dual-mode slice 1):** the spawn
  round-trip DID run on Ollama — the main model called `subagent_verify`, the isolated verifier spawned,
  and the parent `fallbackWrite` persisted its `finalText` to `memory/verdict.md` (proof). But a CLEAN
  captured transcript was not achievable with `llama3.1:8b`, for 4 reasons worth remembering: (1) **`pi
  --mode json -p` buffers stdout; it flushes only on a CLEAN exit** — any run you SIGTERM/SIGKILL shows
  **0 bytes** even though work happened (only a fast clean-exit run like a trivial prompt captures). (2)
  **`--tools <extension-tool>` (e.g. `--tools subagent_verify`) HANGS pi at startup in `-p`** (0 bytes,
  even trivial prompt) — can't use `--tools` to force the call; force via the prompt and load ONLY the
  one extension with `--no-extensions -e <index.ts>` (loading ALL installed exts together also hung —
  suspect `_probe0`). (3) `llama3.1:8b` does native tool calls for SIMPLE prompts but **degrades to
  tool-call-AS-TEXT under the heavy verify system prompt** (`"...I am going to use the following json:
  {..."`), so it's a non-functional nested verifier. (4) an **unauthed `openai/`|`anthropic/` child
  HANGS** (doesn't fail fast) — so with the real model ids + no `/login`, a spawned verifier blocks.
  Net: for a clean captured slice-1/2/4 smoke, use a **fast, native-tool-call model** (authed Copilot, or
  a bigger local model), not `llama3.1:8b` as the sub-agent.
- **pi `-p`/`--mode json` HANGS on stdin in a non-TTY (piped) context** — zero output, times out, no error.
  Run `pi … < /dev/null` from a script (the harness spawns subagents with `stdio:["ignore",…]` for exactly
  this). `--mode rpc` is the opposite: keep stdin OPEN — it's the JSONL command channel. RPC has `hasUI=true`;
  `ctx.ui.confirm` → `extension_ui_request{method:"confirm"}` on stdout, BLOCKS until the client sends
  `extension_ui_response{confirmed}` on stdin (how slice 0 proved confirm-blocks-mid-execute without a TUI).

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
