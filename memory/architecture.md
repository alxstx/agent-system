# Architecture (on-demand)
<!-- Loaded only when a task needs the map. Keep it a navigable index, not a novel. -->

## Module map
- `harness/pi/shared/checks-core.ts` — the check-running core: config (`loadConfig`), the closed-set
  dispatch (`resolveCheck`, `allCheckNames`), path validation (`validateTestPath`, `validateProbePath`,
  `validateLogFile`), and the `shell:false` executors (`runFixed`, `runFixedTee`, `tail`). Imported by
  both the Verifier's `run_check` and the main-session `/checks` so they never diverge.
- `harness/pi/shared/redact.ts` — `loadRedactor(cwd)` → a configured `redact(text)` closure (secret-
  shaped patterns, capture-group-preserving). The ONE redactor, used by secret-redaction AND runFixedTee.
- `harness/pi/shared/subagent-core.ts` — the ONE subagent-subprocess core: `runSubagent` (spawns an
  isolated `pi` with `--model/--thinking` + a `--tools` allowlist; optional `signal`), `getPiInvocation`,
  `extractSummary`, `subagentFailed`, the model/effort constants (`MODEL_DEFAULT`/`MODEL_REVIEW`/`EFFORT`),
  and the cross-cutting safety helpers `cleanDetails` (metadata-only `details`) + `redactOnWrite` (redact-
  at-source before fs writes) + a live-children `Set`/`registerShutdownGuard(pi)` (SIGTERM→SIGKILL on
  session_shutdown). Imported by the 6 roles AND auto-judge (its dup deleted) AND the planned delegate/workflow.
- `harness/pi/subagents/index.ts` — the parent: registers all 6 commands, builds per-role first turns
  (`computeDiff`/`computeGitLog`, `handoff*` blocks), calls `runSubagent`/`extractSummary` from
  subagent-core. Runs in the main session.
- `harness/pi/subagents/runner.ts` — loaded ONLY into a sub-agent via `-e`. ONE default export →
  `registerRunCheck` + `registerRunExperiment`.
- `harness/pi/{command-guard,secret-redaction,checks,boundary-instructions}/index.ts` — main-session
  extensions (hooks/commands). Each its own dir + default export.
- `harness/pi/auto-judge/` — optional main-session LLM-as-judge gate (default OFF, `/autojudge on`):
  `verdict.ts` = pure `parseVerdict` + `loadAutoJudgeConfig` (slice 1, unit-tested); `index.ts` = the
  `tool_call` hook that spawns a single-shot judge subprocess (GPT-5.5 class) and blocks DENY/fail-closed.
- `harness/pi/delegate/` — the **model-callable** read-only subagent tool (`registerTool("delegate")`,
  the pi analog of Claude Code's Task/Agent; opt-in via a `delegate` block in checks.json): `config.ts` =
  pure `loadDelegateConfig`/`capResult`/`buildDelegateUserTurn` (offline-tested, verdict.ts rigor);
  `index.ts` = always-register, check-at-execute, read-only worker via `runSubagent` (read,grep,find,ls),
  per-request cap (reset on agent_start), confirm-on-spawn, shutdown guard. Worker prompt: `harness/prompts/delegate.md`.
- `harness/pi/workflow/` — the **model-callable** governed parallel fan-out (`registerTool("workflow")`,
  opt-in via a `workflow` block): `config.ts` (`loadWorkflowConfig`, verdict.ts rigor) + `right-size.ts`
  (PURE governor: `normalizeTasks`/`clampKept`/`parseRightSizerReply`/`runPool` injectable pool — bare-node
  testable) + `pruner.ts` (impure `rightSize`, the `runJudge`-backed right-sizer) + `paths.ts` (filename +
  `memory/workflow/` validator) + `index.ts` (govern → pool → read-only workers → `redactOnWrite` files +
  compact index). Worker prompt: `harness/prompts/workflow.md`. Reuses delegate's worker core (`subagent-core`).
- `harness/checks.json` — per-repo allowlist: `checks` / `testFile`, `boundaries`, `experiments`,
  `autoJudge` (auto-judge config), `delegate` (delegate-tool config), `workflow` (workflow-tool config;
  presence opts each tool in), optional `blamePathRegex`. `harness/redaction.json` (optional) overrides redaction patterns.
- **ponytail** (external, optional) — reuse-discipline pi extension installed via
  `pi install git:github.com/DietrichGebert/ponytail`; NOT vendored. The same reuse-ladder is baked
  into `AGENTS.md` ("Build discipline") so sub-agents + non-pi tools inherit it. Main-session only;
  see `decisions.md`.

## Data flow
`/role <args>` → parent (index.ts) builds the first user turn (MEMORY.md index + role inputs +
diff/log + a `handoff` block) → `runSubagent` spawns `pi --mode json -p --no-session --no-extensions
[-e runner|web] --model X --thinking xhigh --tools <allowlist> <turn>` → the sub-agent reads on demand,
runs only allowlisted tools, writes ONE `memory/*` file → parent extracts the `## SUMMARY` (only that
crosses back) + posts it via `pi.sendMessage`.

## Key abstractions / glossary
- **Sub-agent** — a separate, torn-down `pi` subprocess with its own context; no general shell, only a
  `--tools` allowlist; writes its own output file. Reached two ways: **human-invoked** (`/<role>`) and,
  for the 6 roles, **model-invoked** mid-turn (`subagent_<role>`).
- **delegate** — a model-callable tool (`registerTool`, separate `harness/pi/delegate/` extension): the
  MAIN-session model spawns a general-purpose, isolated, READ-ONLY sub-agent (read,grep,find,ls) with a
  prompt IT chooses, and gets the final text back. Unlike the fixed-role sub-agents it has no SUMMARY/file
  contract — its last message IS the answer. Opt-in via the `delegate` block; returned text is untrusted data.
- **workflow** — a model-callable tool (`registerTool`, separate `harness/pi/workflow/` extension): a
  GOVERNED parallel fan-out of read-only sub-agents. The model passes an `objective` + `tasks[]`; a
  governor (hard cap + optional `runJudge` right-sizer that prunes/merges overlap, fails OPEN) right-sizes
  it, a concurrency pool runs the kept workers, results are written (redacted) under `memory/workflow/<runId>/`
  and a compact index returns. `delegate` = one worker; `workflow` = a governed batch. Opt-in via the `workflow` block.
- **run_check / run_experiment** — the ONLY execution surface a sub-agent gets: a closed StringEnum of
  named, fixed-argv commands run `shell:false` (no shell to chain into).
- **Index in context, detail on disk** — agents load AGENTS.md + MEMORY.md by default; everything else
  is pulled in just-in-time; only SUMMARYs cross back.
