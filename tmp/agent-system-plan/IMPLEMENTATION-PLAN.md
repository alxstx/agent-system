# Implementation plan — extending the agent-system harness (curated)

> **Scratch / throwaway.** Lives in `/tmp/agent-system-plan/` for review only; delete when done.
> Companion design docs in this dir: `monitor-design.md`, `report-design.md`,
> `roles-elaborated.md` (full `/triage` + `/research` briefs; the struck roles are also there for reference),
> `extensions-ideas.md` (full non-sub-agent extension briefs).
> Repo: `/Users/alex/agent-system` → github.com/alxstx/agent-system

## What's in / out (curated 2026-06-13)

**Sub-agent roles to build:** `/monitor` ⚑, `/triage`, `/research`, `/report`.
**Struck** (designed but not building): `/distill`, `/repro`, `/doc`, `/review-pr`, `/bench`.
**New track:** non-sub-agent **extensions** (main-session tools/hooks/UI) — see §3.

> ⚑ **`/monitor` flag:** retained from the original ask (it's the experiment runner that `/report`
> consumes). If you actually meant to drop it too, say so and I'll remove Phase 1 — `/report`
> degrades gracefully and will just compose from whatever artifacts exist.

## Status snapshot

| Item | State |
|---|---|
| README: "Install pi" + "Install harness" sections | ✅ done |
| `--append-system-prompt` fix (`index.ts:270` → pass `combined`) | ✅ applied |
| Claude memory logged (repo overview + bug) | ✅ done |
| `/monitor`, `/triage`, `/research`, `/report` | ⏳ designed — awaiting approval |
| Extensions track | ⏳ designed — awaiting approval |

---

## Phase 0 — finish the bug-fix cleanly (S, ~10 min)

The applied fix leaves dead code: `runSubagent` still `mkdtempSync`s a dir, writes `system.md`, and `rmSync`s it — all now unused.
- **0.1** Remove the temp-file scaffolding in `runSubagent` (`index.ts`): drop `tmpDir`/`promptFile`/`writeFileSync` + the `finally` cleanup; pass `combined` directly. (~8 lines deleted.)
- **0.2** Verify against a live pi (not installed here): spawn one `/plan`, confirm the sub-agent now follows `plan.md` methodology it previously lacked.

---

## Phase 0.5 — per-role model & effort (applies to ALL sub-agents, existing + new)

Today every sub-agent inherits the operator's default pi model (`index.ts` passes no `--model`). New policy: **reviewing agents run on GPT-5.5; all other sub-agents run on Opus 4.8; both at `xhigh` ("extra-high") thinking.**

- **Mechanism (verified — `pi-api-verified.md` PART C, from `usage.md`):** `--model <provider/id>` + `--thinking xhigh`. Add two options to `runSubagent(opts)` — `model` and `thinking` (default `"xhigh"`) — and append them to the spawn `args` (`index.ts:258-272`): `args.push("--model", opts.model); args.push("--thinking", opts.thinking ?? "xhigh")`. (Equivalently the `--model <id>:xhigh` shorthand.)
- **Config (don't scatter ids):** constants at the top of `index.ts`, e.g.
  ```ts
  const EFFORT = "xhigh";
  const MODEL_DEFAULT = "anthropic/opus-4.8";   // plan, implement-less, monitor, triage, research, report
  const MODEL_REVIEW  = "openai/gpt-5.5";        // the reviewing/adversarial-judge agents
  ```
- **Role → model map** (each `registerCommand` passes the right one to `runSubagent`):

  | Role | Class | Model |
  |---|---|---|
  | `/verify` (verify-change) | **review** | `MODEL_REVIEW` (GPT-5.5) |
  | `/verify-plan` | **review** | `MODEL_REVIEW` (GPT-5.5) — ⚠ **Copilot prompt only today; no pi `registerCommand` exists** (index.ts registers only `plan`+`verify`). Applies only IF a pi `/verify-plan` command is built; otherwise out-of-scope for `runSubagent`. |
  | `/plan` | default | `MODEL_DEFAULT` (Opus 4.8) |
  | `/monitor` | default | `MODEL_DEFAULT` |
  | `/triage` | default | `MODEL_DEFAULT` |
  | `/research` | default | `MODEL_DEFAULT` |
  | `/report` | default | `MODEL_DEFAULT` |

  "Reviewing" = the adversarial **judge** roles (verify-change, verify-plan; `/review-pr` too if ever built). Diagnostic/observer/author roles (triage, monitor, research, report) are **default**. Move a row if you class it differently.
- **Operator prerequisite:** GPT-5.5 means the **OpenAI provider must be authenticated in pi** (`OPENAI_API_KEY` env or `/login`) — otherwise the reviewer subprocess errors. The default (Opus) needs Anthropic auth, which the operator already has. Note this in `harness/pi/subagents/README.md` and have the verify handlers `ctx.ui.notify` a clear hint if the model can't load.
- **⚠ FLAG-to-verify (live pi):** the exact model-id strings — run `pi --list-models` and confirm the canonical ids (the doc shows `provider/id` form, e.g. `openai/gpt-4o`; `opus`/`sonnet` aliases also resolve). `--thinking xhigh` is **verified** (values: `off|minimal|low|medium|high|xhigh`). If `gpt-5.5` isn't yet a listed id, the constant is the one line to update.
- **Touches the existing engine:** this edits `runSubagent` + the **existing** `/plan` and `/verify` handlers (so `/verify` moves to GPT-5.5, `/plan` to Opus 4.8), not just the new roles — do it alongside Phase 0. Smoke test: run `/verify` and confirm the subprocess reports the GPT-5.5 model; run `/plan` and confirm Opus 4.8.

---

## Phase 1 — sub-agent roles

Each role = the same 3-part wiring as `/plan` and `/verify`: a canonical `harness/prompts/<role>.md`, a `.github/prompts/<role>.prompt.md` Copilot wrapper, and a `registerCommand` in `index.ts` that spawns an isolated subprocess with a strict `--tools` allowlist, writes ONE `memory/` file, and returns a ≤10-line `## SUMMARY`. All reuse `findRepoRoot`/`runSubagent`/`extractSummary`/`fileSig`/`subagentFailed` — and pass `model` per the Phase 0.5 map.

### 1a. `/triage` — failing-run → ranked root-cause + one next probe  (Effort: S)
Design: `roles-elaborated.md §/triage`. Verifier-class.
- **New files:** `harness/prompts/triage.md`, `.github/prompts/triage.prompt.md`.
- **Edit `index.ts`:** `registerCommand('triage')` (clones `/verify`), `handoffTriage`, `RepoPaths.triagePrompt`, log-path arg parsing (first token = file under repo → read+cap; else `note`).
- **Edit `runner.ts`:** add a `READONLY_PROBES` group — `git-blame` (new `validateBlamePath`, clone of `validateTestPath`), `git-log-file`, and `env-dump` (a TS prefix-filtered read of `process.env`, **no subprocess** → no secrets, nothing to escape). Optional `blamePathRegex` in `checks.json`.
- **Tools:** `read,grep,find,ls,run_check,write`. Verdict token = the top hypothesis label.

### 1b. `/report` — experiment/change → polished, audience-facing document  (Effort: S–M)
Design: `report-design.md`. Planner-class. **Its contract inverts the others: the document is the deliverable; only a teaser SUMMARY + path cross back.** Unlike `/monitor`/`/triage`/`/verify`, `/report`'s SUMMARY carries **NO first-token verdict** (it's an abstract); the parent posts `details:{audience}`, not `details:{verdict}` — intentional asymmetry, not a missing verdict.
- **New files:** `harness/prompts/report.md` (writing methodology — lead with the result, quantify, cite `file:line`, honest caveats, audience-tuned), `.github/prompts/report.prompt.md`.
- **Edit `index.ts`:** `registerCommand('report')`, `handoffReport`, a "newest `memory/monitor-*.md`" auto-discovery helper, `mkdir memory/reports/`. **⚠ FIX (verifier R7 #2):** reuses `computeDiff` (`index.ts:382`) **plus a NEW `computeGitLog()` parent helper** (mirrors `computeDiff` — runs `git log --oneline -N <base>..HEAD`, same base resolution + truncation) — the report contract references both diff *and* log, and no git-log helper exists today. **No `runner.ts`/`checks.json` change.** Done-condition: the report's first user turn contains BOTH the diff and the log.
- **Invocation:** `/report <subject> [--for=team|paper|self] [sources...]`. Composes from `memory/monitor-<runId>.md` + `memory/runs/<runId>.log` + `memory/verdict.md` + `memory/tasks.md` + a parent-computed diff **and** log.
- **Output:** `memory/reports/<subject>-<date>.md` (a NEW dir; **kept, not gitignored** — reports are durable).
- **Tools:** `read,grep,find,ls,write`. The "**always** write a doc after an experiment" automation is NOT in this sub-agent — it's the `auto-report` hook in §3.

### 1c. `/research` — web question → cited, claim-checked note  (Effort: M)
Design: `roles-elaborated.md §/research`.
- **New files:** `harness/prompts/research.md`, `.github/prompts/research.prompt.md`.
- **Edit `index.ts`:** `registerCommand('research')` (clones `/plan`), `handoffResearch`.
- **⚠ FIX (verifier blocker #1) — web tools must be explicitly loaded.** `runSubagent` spawns with `--no-extensions` (`index.ts:267`), so an *installed* `pi-web-access` is **not** reachable in the subprocess by design. Tools only enter a sub-agent via an explicit `-e` (the same way the Verifier gets `run_check` from `-e runner.ts`). So `/research` MUST pass a `runnerPath` too. Two resolutions:
  - **Primary:** load `pi-web-access` explicitly — resolve its installed entry path and pass it as `runSubagent({ runnerPath: <pi-web-access index> })` (or `-e npm:pi-web-access`). **Mandatory live test:** confirm an `-e`-loaded npm extension actually exposes its `web_search`/`fetch_content` tools under `--no-extensions`.
  - **Fallback (if the above doesn't expose the tools):** ship a thin `harness/pi/subagents/research-runner.ts` that `registerTool`s `web_search` + **`fetch_content`** (the SAME names pi-web-access uses, so the prompt + `--tools` allowlist are identical either way; delegating to a keyed provider, e.g. Exa), loaded via `-e` exactly like `runner.ts`. Same SSRF caveat as any web agent — add a basic internal-IP/localhost block.
- **Tools:** `read,grep,find,ls,write,web_search,fetch_content` (the web tools resolve **only** once the `-e` extension above is loaded). Verdict token = `CONFIDENT|MIXED|INCONCLUSIVE`. **Done-condition includes a passing live test where `/research` calls `web_search`.**

### 1d. `/monitor` ⚑ — run an allowlisted experiment + watch for errors  (Effort: M)
Design: `monitor-design.md`. Verifier-class; the one role that adds an execution path.
- **New files:** `harness/prompts/monitor.md`, `.github/prompts/monitor.prompt.md`.
- **Edit `index.ts`:** `registerCommand('monitor')`, `handoffMonitor`, `listExperiments`.
- **Edit `runner.ts`:** parse an `experiments` block, `validateLogFile`, `runFixedTee`, and a `run_experiment` tool registered via a **`registerRunExperiment(pi)` helper** called from the SAME single default export as `run_check`. **⚠ FIX (verifier #3/R4):** factor the existing `run_check` body into a `registerRunCheck(pi)` helper so the ONE `export default runner(pi)` calls both — never add a second/replacement `export default` (it would drop `run_check`). **Smoke test:** one `-e RUNNER_PATH` exposes BOTH `run_check` and `run_experiment`. **⚠ FIX (verifier R5 #3):** `registerRunExperiment` must early-return when `CONFIG.experiments` is empty — this runner is loaded by `/verify` in *every* harnessed repo, and most have no `experiments` block, so `StringEnum([])` must never be constructed. Smoke test: `/verify` + `run_check` still load in a repo with no experiments.
- **⚠ FIX (verifier blocker #2) — redact at the runner, not in a main-session hook.** `run_experiment` runs in the `--no-extensions` subprocess and `runFixedTee` writes raw output straight to `memory/runs/*.log`; the main-session `secret-redaction` hook (§2b) can **never** see that. So redaction must happen **in the runner path**: apply a shared `redact()` (from `harness/pi/shared/redact.ts`, the same patterns the §2b hook uses) to the stream **before** both the `onUpdate` the agent sees AND the tee write to disk. **Test:** an experiment that prints an `AKIA…`/token-shaped string → both the tool output and `memory/runs/*.log` come back `[REDACTED]`. Keep `memory/runs/` gitignored as defense-in-depth.
- **⚠ FIX (verifier #4) — per-run log, end-to-end.** The log must be keyed by **run**, not experiment, or repeated runs of one experiment clobber `memory/runs/<name>.log` and break `log:line` citations. The parent computes the canonical collision-resistant `runId` (`<experiment-slug>-<YYYYMMDDHHMMSSmmm>-<seq>` — ms stamp + monotonic counter; same id as `memory/monitor-<runId>.md`) and passes it in the handoff; `run_experiment`'s schema takes a validated `runId` param (`^[A-Za-z0-9._-]{1,80}$`, no traversal), tees to `memory/runs/<runId>.log`, and returns that exact path. The per-experiment `logFile` config field is **dropped**. **Test:** run the same experiment twice → two distinct logs + reports, no clobber.
- **Config/hygiene:** `experiments` block in `checks.json` (cmd/args/timeoutMs only — no `logFile`) + the example file; `memory/runs/` in `.gitignore`; docs.
- **Tools:** `read,grep,find,ls,run_experiment,write`. Verdict token = `OK|ERROR` (GREEN/RED report).

---

## Phase 2 — extensions (non-sub-agent: main-session hooks / commands / tools)

Per-extension full plans: `ext-command-guard.md`, `ext-secret-redaction.md`, `ext-slash-checks.md`, `ext-boundary-instructions.md`. (⚠ `ext-mcp-bridge.md` is **SUPERSEDED — do not build**: the custom in-repo bridge is shelved; the active MCP path is `pi-mcp-adapter` + arXiv only, §2e.) Verified pi event/UI API: `pi-api-verified.md`. These run in your **main session** and turn AGENTS.md *prose* rules into *structural* behavior (the harness's principle #5: "determinism where it belongs"). Sub-agents are immune — they spawn `--no-extensions` (`index.ts:267`), so these govern exactly the human-driven main session.

> **Verified field names (the sketches use these):** `tool_call`/`tool_result` payloads use `event.toolName`, `event.input`, `event.content` (array, mutable on `tool_result`), `event.isError`. Block = `return { block: true, reason }`. `ctx.ui.notify(msg, "info"|"warning"|"error")` — **no `"success"`**. `ctx.ui.setWidget(key, string[]|fn|undefined, {placement:"belowEditor"})`. A few items remain FLAG-to-verify-on-live-pi (noted per plan): `pi.unregisterTool`, `deliverAs:"steer"` landing in-turn, the `input.command` key for bash, and **`ctx.signal` on the *command* context** (verified for tool `execute()`, NOT confirmed for `registerCommand` handlers — `/checks` uses it only via optional chaining with a graceful fallback; see §2c).

### Shared prerequisites (do these once, first)
- **P2.0a — generalize `install.sh`:** replace the hardcoded `subagents` `SRC_DIR`/`DEST` (`install.sh:19-21,33-56`) with a loop over `harness/pi/*/` dirs containing an `index.ts`, installing each into `~/.pi/agent/extensions/<name>`. **⚠ FIX (verifier #4):** the symlink path works (the link target is the real repo dir, so `../shared/` resolves), but **`--copy` would copy only the extension dirs and leave `../shared/` missing** — so when copying, also copy `harness/pi/shared/` to `~/.pi/agent/extensions/shared/`. **Test BOTH** the default symlink and `--copy` installs of `/checks` (which imports `../shared/`). Keeps `--uninstall`/backup per-extension. **Every new extension depends on this.**
- **P2.0b — extract `harness/pi/shared/`:** (1) `checks-core.ts` — move `loadConfig`/`runFixed`(→`runFixedTee` adds the redacted tee)/`findRepoRoot`/`validateTestPath`/`gitCheckSpec`/`buildEnv`(made pure)/`tail`/`MAX_OUTPUT_BYTES` + a new `resolveCheck()` out of `runner.ts`; `runner.ts` shrinks to import them + wire `run_check`/`run_experiment`. (2) `redact.ts` — the secret-pattern set + `redact(text)`, imported by **both** the `secret-redaction` hook (§2b) and `runFixedTee` (so `/monitor` disk logs are scrubbed at the source — verifier #2). Imported by relative path so it travels with each install (see P2.0a copy fix). **`/checks` and `/monitor` depend on this; it also de-risks `runner.ts`.**
- Each extension = its own `harness/pi/<name>/index.ts`.

### 2a. `command-guard`  (Effort: S) — `ext-command-guard.md`
`pi.on('tool_call')` that returns `{block:true,reason}` for destructive `bash` (`rm -rf`, `git push --force` [allows `--force-with-lease`], `reset --hard`, truncating `>`) and for `write`/`edit` whose path matches a configured boundary. **Config:** a `boundaries` array (regex strings) in `harness/checks.json` (the machine form of the AGENTS.md "Boundaries" prose). **⚠ FIX (verifier #5) — override:** a `PI_GUARD_OFF=1 <cmd>` prefix is part of `event.input.command`, NOT pi's `process.env`, so `process.env.PI_GUARD_OFF` would never see it and the command stays blocked. Make the override a **session toggle**: a `/guard on|off` command (`registerCommand`, same extension) flipping a module-level `armed` flag (default on). Update the test: `/guard off` → `rm -rf build/` proceeds → `/guard on` re-arms. Never touches `memory/`.

### 2b. `secret-redaction`  (Effort: S) — `ext-secret-redaction.md`
`pi.on('tool_result')` that mutates `event.content` text blocks **in place** via the shared `redact()` (P2.0b `redact.ts`), before the model ingests them. **Config:** optional `harness/redaction.json` (`replacement`, `extraPatterns`, `disableDefault`). Patterns are **secret-shaped** (provider keys, `AKIA…`, Bearer/Authorization, `KEY=/TOKEN=` assignments, PEM blocks) — deliberately **not** bare hex/base64. **Scope (verifier #2):** this hook covers **main-session** tool output (`bash`, the arXiv MCP via `pi-mcp-adapter`, other main-session tools) only. It does **not** see `/monitor`'s subprocess output or its `memory/runs/*.log` tee — those are scrubbed by the **runner** calling the same `redact()` in `runFixedTee` (§1d). Same patterns, two call sites, one source of truth.

### 2c. `/checks`  (Effort: M) — `ext-slash-checks.md`
`registerCommand('checks')` runs the `checks.json` allowlist **inline** (no sub-agent, no model tokens) and prints a green/red widget. `/checks` (all project checks) / `/checks <name>` (one). **⚠ FIX (verifier R4 #1) — abort is optional:** `ctx.signal` is verified for tool `execute()` but **not** confirmed for command handlers, so `/checks` uses it only via optional chaining (`ctx.signal?.aborted`) and passes `ctx.signal` to `runFixed` (which already accepts `signal | undefined`). **Fallback if absent:** checks simply run to their own per-check `timeoutMs` with no mid-run cancel — no crash. Flagged for a live cancellation test (§2 FLAG list). **Decision: UI-only — results are NOT fed to the model** (operator smoke test; escalate to `/verify` to make the model act). Depends on P2.0b so the main session and the Verifier run the *exact same* allowlist.

### 2d. `boundary-instructions`  (Effort: M) — `ext-boundary-instructions.md`
Brings Copilot's `.github/instructions/*.instructions.md` path-scoped rules to pi: cache rules at `session_start`, and on an `edit`/`write` whose path matches a rule's `applyTo` glob, **steer the rule body into context** via `pi.sendMessage(…, {deliverAs:"steer"})` (so the model actually follows it), fired at most once per file per session. Tiny in-repo glob matcher (`**`,`*`,`?`,comma-alternatives), ~10-line frontmatter parser — no deps. Realizes "progressive disclosure": rules cost zero tokens until a matching file is touched.

### 2e. MCP for research only — arXiv  (Effort: S) — `mcp-web-arxiv.md`, appendix below
Scope cut to **external knowledge the shell can't give you.** Everything else (GitHub, cluster, GPU, cache, metrics) is **dropped** — those are installed CLIs / HTTP APIs, handled by `bash` or a read-only `harness/checks.json` entry (the "MCP vs just-run-it" call from the discussion).
- **Web search → use the `pi-web-access` extension, NOT an MCP.** Zero-key, native to pi, token-aware; it's what `/research` already uses (`web_search`/`fetch_content`/`code_search`) and it also serves interactive main-session search. **No web MCP is in scope.** (Dedicated web-engine MCPs like Exa/DuckDuckGo are documented as *reference-only alternatives* in `mcp-web-arxiv.md` — not part of this build.)
- **arXiv → one MCP server: `blazickjp/arxiv-mcp-server`** (zero-key; `search_papers`/`download_paper`/`read_paper`→markdown; **caches papers locally** under `--storage-path` so the agent can re-read a paper list without re-fetching). The one genuinely-MCP capability.
- **Bridge decision — flips to simple.** With only **read-only** research tools left (no destructive cluster tools to gate by name), the in-repo named-tool bridge is no longer justified. Just **`pi install npm:pi-mcp-adapter`** and point `mcp.json` at the arXiv server. The opaque-proxy concern is moot when nothing is destructive; the custom bridge + `ext-mcp-bridge.md` go on ice unless you later add write-capable servers.

**Config:** write the mcp config to a **verified pi load path** — **`.pi/mcp.json`** (project-local; `~/.pi/agent/mcp.json` for global) per `pi-api-verified.md` PART A. ⚠ FIX (verifier R9 #1): `harness/mcp.json` is **not** a path pi-mcp-adapter scans, so the server would never load. Keep a committable `harness/mcp.example.json` as the template and copy it to `.pi/mcp.json`. **One server: the arXiv server, read-only.**

**Deferred (designed earlier, not in this pass):** `token-budget` widget, `auto-memory`, `experiment-autocomplete`, `auto-report` hook (the "always-write-a-doc" automation over `/report`). Briefs in `extensions-ideas.md`.

---

## Shared infrastructure & cross-cutting notes
- **`harness/pi/shared/` (P2.0b)** holds `checks-core.ts` + `redact.ts`; **`install.sh` (P2.0a)** installs it alongside every extension (symlink **and** `--copy`). Do these first.
- **`runner.ts` one-default-export rule:** `run_check`, `run_experiment` (`/monitor`), and `/triage`'s probes all register inside ONE `runner(pi)` default export — never a second `export default` (verifier #3).
- **Isolation cuts both ways (the two blockers):** sub-agents spawn `--no-extensions`, so (a) main-session hooks like `secret-redaction` do NOT reach a sub-agent's output or disk tee → redact in the **runner** (`runFixedTee`); and (b) installed extensions like `pi-web-access` do NOT auto-load → `/research` must load its web tools via explicit `-e`. Tools enter a sub-agent **only** via `-e`.
- **One allowlist / one redactor:** `harness/checks.json` is read by `run_check`, `/checks`, and `command-guard`'s `boundaries`; `redact.ts` is the single pattern source for both the `secret-redaction` hook and the runner tee. Main session and sub-agents never diverge.
- **`auto-report` ⟷ `/report`** (deferred): the hook is the "always-write-a-doc" automation over the invocation-driven sub-agent — build `/report` first.

## Resolve before building (from plan verification — REVISE → addressed above)
1. **`/research` web-tool loading** — confirm `-e`-loading `pi-web-access` exposes `web_search`/`fetch_content` under `--no-extensions` on live pi; else use the `research-runner.ts` fallback. (§1c; companion doc `roles-elaborated.md §/research` now matched — verifier R2 #1)
2. **`/monitor` log redaction is real, in the runner** — `runFixedTee` calls shared `redact()` before `onUpdate` and the disk tee; test with a token-shaped string. (§1d, P2.0b; explicit in `monitor-design.md §6.3`/§7 — verifier R2 #3)
3. **`/monitor` per-run log, end-to-end** — `run_experiment` takes a validated `runId`; logs at `memory/runs/<runId>.log`; no per-experiment `logFile`. Test: same experiment twice → no clobber. (§1d, `monitor-design.md §2a/§6.2/§6.3/§7` — verifier R2 #4)
4. **Runner/install/guard cleaned, in the COMPANION docs too** — single `runner(pi)` default export (both tools); `--copy` carries `shared/` (`ext-slash-checks.md`); `command-guard` override is the `/guard` toggle, skeleton + risk text fixed (`ext-command-guard.md`). (verifier R2 #2/#3 — doc drift closed)

> **Verification status:** four REVISE rounds, all addressed; the verifier confirmed the substantive blockers closed after R3. R1 (5: the two isolation blockers + runner/install/guard). R2 (4: companion-doc drift + per-run-log bug). R3 (4: residual `runId` propagation + collision-resistant run id + 2 more doc drifts) — after which a **proactive grep sweep** caught 6 more `logFile` stragglers. R4 (2: `ctx.signal` unconfirmed for command contexts → flagged + graceful optional fallback; monitor runner skeleton rewritten as a `registerRunExperiment(pi)` **helper** called from the single existing default export, so it can't be copied as a replacement that drops `run_check`). R5 (4: the one-file write contract — removed `MEMORY.md` writes from the `/monitor` + `/report` prompts, lessons now surface via SUMMARY; `secret-redaction` now imports the shared `redact.ts` not a local `patterns.ts`; **`run_experiment` guarded so `StringEnum([])` can't break `/verify`'s runner load in repos with no experiments** — a real robustness fix; and `mcp-web-arxiv.md` retitled so web MCPs are clearly reference-only with arXiv the sole kept MCP). Remaining opens are **live-pi confirmations only** (the FLAG list), not paper holes — R3–R5 findings were wording/consistency/hardening, no design changes; the verifier's own live spot-checks confirmed the package choices (pi-web-access, pi-mcp-adapter, arxiv-mcp-server). R6 (3, ALL consequences of R5's own edits: `/research` fallback tool name `web_fetch`→`fetch_content` to match the allowlist/pi-web-access; `secret-redaction` now actually calls the shared `redact(text)` — `loadRedactor(cwd)` returns a configured `redact` closure, no local replace loop, so the `$1`-preserving Authorization rule works; secret-redaction build step + tests now include the `shared/` `--copy` requirement). **Note:** R5–R6 findings are increasingly *compile-level* (a tool-name mismatch, a reimplemented fn, a missing import path) — the kind `tsc` + one `/reload` catch in seconds. Paper review of the illustrative skeletons has reached the point of diminishing returns vs. just building them. R7 (2: `ext-mcp-bridge.md` banner-marked SUPERSEDED + dropped from the active list; `computeGitLog()` helper added for `/report`). **R8 — proactive comprehensive 2-lens audit (consistency + grounding) run by me** to drain the tail in bulk: fixed `report-design.md` still using per-EXPERIMENT log paths (the per-run `runId` fix hadn't reached it — same recurring class); propagated Phase-0.5 `model: MODEL_DEFAULT` into the monitor/report/triage/research `runSubagent` skeletons; fixed a bogus `*.log` `.gitignore` claim; aligned the runId-format prose with the skeleton; noted `/report`'s intentional no-verdict-token asymmetry; recorded the verified CLI flags in `pi-api-verified.md` PART C (closing "verified against an unprovided doc"). Grounding's "repo unreadable" blocker is environmental (macOS TCC) — the line citations were grounded against session-start reads; re-confirm on a readable checkout (see Things to confirm). **R9 (2 major + 2 nits, run against the now-readable repo at `/Users/alex/agent-system` — GROUNDING PASSED: `computeDiff` diff-only, `RunSubagentOptions` has `runnerPath?`/`onProgress?`, one default export registering `run_check`, no `experiments` block, `install.sh` hardcodes `subagents`): MCP config moved off the unverified `harness/mcp.json` to the verified `.pi/mcp.json` (+ `harness/mcp.example.json` template); `ext-command-guard.md` intro fixed (it DOES register `/guard`); `/verify-plan` clarified as Copilot-prompt-only (no pi command today); stale `Downloads/agent-system` path replaced everywhere with `/Users/alex/agent-system`.** Design is settled; remaining opens are the live-pi FLAG list only. **R10 (2 major + 2 nits): scope purity — removed the "optional Exa/DuckDuckGo web-MCP" from the ACTIVE master (§2e header/bullet/config/appendix/snippet) so the build is arXiv-only, web=`pi-web-access`; web-engine MCPs are reference-only in `mcp-web-arxiv.md`. Real bug — `boundary-instructions` matched `applyTo` globs against `ctx.cwd` not the repo root (fails when pi launches from a subdir); fixed to store `REPO_ROOT` at `session_start` and match `path.relative(REPO_ROOT, resolve(cwd,p))`, rejecting out-of-repo paths (skeleton + config + risk all aligned). Nits: replaced the superseded `mcp-bridge` example; updated the grounding caveat to "grounded on readable checkout."** **R11 (2 major + 1 nit): `command-guard` had the SAME cwd-vs-repo-root path bug as boundary-instructions (a write to `migrations/0001.sql` when pi is launched inside `migrations/` would miss the boundary) — `loadBoundaries` now returns `{repoRoot, boundaries}` and matching is repo-root-relative; checked all sibling extensions (no third instance). `mcp-web-arxiv.md` ARXIV section now marks `blazickjp` as the ONLY built server with the alternates under a "reference-only — not built" subsection. Nit: corrected report-design's `*.log` note — the real `.gitignore:8` DOES have `*.log` (my R8 edit, made under the TCC grounding blackout, wrongly claimed it didn't); `/monitor` adds `memory/runs/` as defense-in-depth. Lesson: when fixing a bug, immediately grep siblings for the same pattern.** **R12 ("last small review", 1 major + 1 nit): the master appendix still had the `openags/paper-search-mcp` scope-creep invite (the twin of R11's mcp-web-arxiv fix — same lesson) → reframed as out-of-scope; the stale "Open decisions" section (listing already-settled choices) retitled "Settled decisions (DECIDED)" with each marked ✅. Swept: no other scope-creep or undecided framing remains.**

## Recommended build order
1. **Phase 0 + 0.5** — append-system-prompt cleanup **and** wire per-role model/effort into `runSubagent` + the existing `/plan` (Opus 4.8) and `/verify` (GPT-5.5), both `--thinking xhigh`.
2. **P2.0a + P2.0b** shared prereqs (`install.sh` loop + `checks-core.ts`) — unblocks everything else.
3. **`command-guard` + `secret-redaction`** (S each, cheap, immediate safety) + **`/checks`** (M, rides on P2.0b).
4. **`/triage`** (S, no deps, highest daily frequency).
5. **`/monitor`** → **`/report`** (consumes its artifacts).
6. **`/research`** (after confirming the `pi-web-access` dependency).
7. **`boundary-instructions`**; the **arXiv MCP** via `pi-mcp-adapter` is a quick standalone add (S) whenever you want papers in-session (`pi-web-access` already covers web search).

## Settled decisions (for the record — DECIDED, not open)
1. **`/monitor`** — ✅ kept (the experiment runner `/report` consumes).
2. **`/research`** — ✅ depends on `pi-web-access` (don't build our own fetcher — SSRF).
3. **MCP scope** — ✅ web search via the `pi-web-access` extension + arXiv via `pi-mcp-adapter` only; the custom in-repo bridge and all cluster/GitHub MCPs are shelved (read-only research tools — nothing to gate).
4. **Phase 0** — ✅ remove the now-dead temp-file code.
5. **Design docs** — ✅ throwaway in `/tmp/agent-system-plan/` (graduate a trimmed copy to `harness/designs/` only if you want them version-controlled).

## Things to confirm before coding
- pi's lint/typecheck command for the extension (no `package.json` in `harness/pi/subagents/`; loads via `jiti`, TS uncompiled) — may want a dev `tsconfig` just for type-checking.
- Re-confirm the `--append-system-prompt` fix on a live pi.
- The FLAG items in `pi-api-verified.md`: `pi.unregisterTool` exists?; `deliverAs:"steer"` lands in-turn from `tool_call`?; bash arg key is `input.command`?; `mcpServers` wrapper in `mcp.json`?. Verify against a live pi before shipping the affected hook.
- **Model ids (Phase 0.5):** `pi --list-models` → confirm the canonical `openai/gpt-5.5` and `anthropic/opus-4.8` id strings (and that GPT-5.5 is available/authenticated). `--model`/`--thinking xhigh` flags are verified (recorded in `pi-api-verified.md` PART C).
- **Line citations are GROUNDED** against the readable checkout at `/Users/alex/agent-system` (confirmed twice — R9 and the R10 pass): `computeDiff`@382 (diff-only), `fileSig`@111, `extractSummary`@353, `RunSubagentOptions` already has `runnerPath?`+`onProgress?` (so adding `model?`/`thinking?` is clean), single `export default verifierRunner`@257 registering `run_check`, `GIT_CHECKS`@35, `StringEnum`@272, `checks.json` has no `experiments` block, `install.sh` hardcodes `subagents`. Just spot-check again after any large edit.

---

## Appendix — MCP we keep: arXiv only
Full detail: `mcp-web-arxiv.md`. Everything else researched earlier (GitHub, cluster/Slurm/k8s, GPU, Redis, Prometheus/Grafana/W&B) is **dropped from the plan** — those are installed CLIs / HTTP APIs reached via `bash` or a read-only `harness/checks.json` entry, not MCP. (Old detail kept for reference only in `mcp-servers.md` / `mcp-servers-domain.md`.)

### Web search → the `pi-web-access` extension (no MCP)
`pi install npm:pi-web-access` → adds `web_search` + `fetch_content` + `code_search`, **zero-key** (zero-config Exa fallback), token-aware. It's what the `/research` sub-agent uses **and** it serves interactive main-session search — so web search needs no bridge and **no web MCP is in scope.** (Dedicated web-engine MCP alternatives — Exa, DuckDuckGo — live in `mcp-web-arxiv.md` as reference-only; not built here.)

### arXiv papers → `blazickjp/arxiv-mcp-server` (the one MCP worth bridging)
Zero-key (arXiv is open). Tools: `search_papers` (filter by `cs.LG`/`cs.DC`/`cs.AR`, date), `download_paper` (HTML-first, PDF fallback), `read_paper` (→ markdown), `list_papers`. **Caches papers locally** at `--storage-path`, so a reading list of inference/serving papers stays re-readable with no re-fetch. *(PubMed/Semantic-Scholar servers are **out of scope for this build** — see `mcp-web-arxiv.md`'s reference-only alternatives if you ever widen scope.)*

### Connect via `pi-mcp-adapter` (not a custom bridge)
Since the kept tools are all read-only, the named-tool in-repo bridge is unnecessary — `pi install npm:pi-mcp-adapter` + a one-entry mcp config at a **verified load path** (`.pi/mcp.json` project-local, or `~/.pi/agent/mcp.json` global — NOT `harness/mcp.json`). Ship `harness/mcp.example.json` as the committable template; copy it to `.pi/mcp.json`:
```json
{ "mcpServers": {
  "arxiv": { "command": "uv",
             "args": ["tool","run","arxiv-mcp-server","--storage-path","${HOME}/papers"] }
}}
```
*(Install once: `uv tool install 'arxiv-mcp-server[pdf]'`.)*
