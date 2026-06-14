# Architecture (on-demand)
<!-- Loaded only when a task needs the map. Keep it a navigable index, not a novel. -->

## Module map
- `harness/pi/shared/checks-core.ts` — the check-running core: config (`loadConfig`), the closed-set
  dispatch (`resolveCheck`, `allCheckNames`), path validation (`validateTestPath`, `validateProbePath`,
  `validateLogFile`), and the `shell:false` executors (`runFixed`, `runFixedTee`, `tail`). Imported by
  both the Verifier's `run_check` and the main-session `/checks` so they never diverge.
- `harness/pi/shared/redact.ts` — `loadRedactor(cwd)` → a configured `redact(text)` closure (secret-
  shaped patterns, capture-group-preserving). The ONE redactor, used by secret-redaction AND runFixedTee.
- `harness/pi/subagents/index.ts` — the parent: registers all 6 commands, `runSubagent` (spawns an
  isolated `pi` subprocess with `--model/--thinking` + a `--tools` allowlist), `computeDiff`/`computeGitLog`,
  per-role `handoff*` blocks, SUMMARY extraction. Runs in the main session.
- `harness/pi/subagents/runner.ts` — loaded ONLY into a sub-agent via `-e`. ONE default export →
  `registerRunCheck` + `registerRunExperiment`.
- `harness/pi/{command-guard,secret-redaction,checks,boundary-instructions}/index.ts` — main-session
  extensions (hooks/commands). Each its own dir + default export.
- `harness/checks.json` — per-repo allowlist: `checks` / `testFile`, `boundaries`, `experiments`,
  optional `blamePathRegex`. `harness/redaction.json` (optional) overrides redaction patterns.

## Data flow
`/role <args>` → parent (index.ts) builds the first user turn (MEMORY.md index + role inputs +
diff/log + a `handoff` block) → `runSubagent` spawns `pi --mode json -p --no-session --no-extensions
[-e runner|web] --model X --thinking xhigh --tools <allowlist> <turn>` → the sub-agent reads on demand,
runs only allowlisted tools, writes ONE `memory/*` file → parent extracts the `## SUMMARY` (only that
crosses back) + posts it via `pi.sendMessage`.

## Key abstractions / glossary
- **Sub-agent** — a separate, torn-down `pi` subprocess with its own context; no general shell, only a
  `--tools` allowlist; writes its own output file.
- **run_check / run_experiment** — the ONLY execution surface a sub-agent gets: a closed StringEnum of
  named, fixed-argv commands run `shell:false` (no shell to chain into).
- **Index in context, detail on disk** — agents load AGENTS.md + MEMORY.md by default; everything else
  is pulled in just-in-time; only SUMMARYs cross back.
