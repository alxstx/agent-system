# Decisions (why-log, ADR-lite)
<!-- One short entry per non-obvious choice. Record the trade-off, not just the outcome. -->

## 2026-06-21 — dual-mode subagents: model-auto-invocation trust boundary + `/<role>-main`
- **Context:** the 6 roles were model-UNREACHABLE (only `/`-commands; the model emits tool calls, not
  commands). Wanted (a) the running model to invoke a role mid-turn, and (b) the operator to run the main
  session *under* a role's methodology.
- **Trust boundary (tool-mode, slices 1+3):** the six `subagent_<role>` tools let the *model* spawn an
  isolated sub-agent mid-turn — a new auto-invocation surface. Bounded by: the children stay
  `--no-extensions`, shell-free, edit-free, per-role `--tools` allowlist (same isolation as the commands);
  the result is **summary-only** (artifact on disk → main context protected); failures **throw** (a
  returned `isError` is inert). No hard count cap by owner decision — gating is **auto-judge-only**
  (the six exact names in `autoJudge.guardedTools`, exact-match), so an armed judge is the only DENY gate.
- **`/<role>-main` (slice 4) — key choices:** inject **body-only** (just `harness/prompts/<role>.md`, NOT
  the AGENTS.md brief — the main session already auto-loads it without `-nc`; re-injecting duplicates it,
  F1). The tool **clamp + a `tool_call` block-gate** are BOTH required — the clamp narrows what the model
  sees, the gate enforces (role restrictions are otherwise advisory). The terminal "write ONE file / reply
  only `## SUMMARY`" contract was **stripped from triage.md + report.md bodies** (F2) — it lived in the
  body AND the `handoff*` builder; injecting it into an interactive chat would truncate replies + nudge a
  stray write. It now lives ONLY in the handoff builders (so the isolated sub-agent is unchanged; plan.md +
  verify-change.md were already clean).
- **Reload/resume (N2, highest-risk):** `activeRole` + the pre-clamp tool snapshot **persist** via
  `appendEntry` and restore on `session_start` (re-apply clamp + status; the always-armed
  `before_agent_start` re-injects the body). Without this, `/reload` re-applies the persisted tool clamp
  but resets in-memory `activeRole→null` → user stranded clamped-read-only with no role. Plus a null→full
  safety net so a clamp can never outlive its role.
- **4b — monitor/research-main spawn the isolated sub-agent**, not an in-session clamp: their real tools
  (`run_experiment`, web) are subprocess-only. Routing through the subprocess avoids registering privileged
  tools into the full-tools main session. Net: real in-session `-main` is the four clean roles.
- **Trade-off / caveat:** `run_check` is **sub-agent-only** (registered by runner.ts via `-e`, NOT in the
  main session), so the verify/triage-main clamp lists it but pi's `setActiveToolsByName` silently drops
  it — those roles are effectively read-only in-session; real checks run via the `/verify` or `/checks`
  commands. Listed anyway so the clamp + gate already permit it the day it becomes a main-session tool.

## 2026-06-21 — workflow: governed parallel fan-out (a governed batch of delegate workers)
- **Context:** `delegate` spawns ONE read-only worker. Wanted the minimal local analog of the cloud
  Workflow tool — fan ONE objective out to SEVERAL isolated read-only workers at once — without it
  becoming a fan-out bomb or a scripting/DAG engine.
- **Decision:** a separate `harness/pi/workflow/` extension registers `workflow({objective, tasks[]})`.
  The main agent decomposes (passes `tasks[]`); the tool GOVERNS + runs, it does not invent subtasks.
  **The governor is the point:** (1) a hard `maxParallel` cap (ceiling 8 — the cost kill-switch) that the
  kept-list is ALWAYS code-clamped to, even on a successful judge reply (an injected "keep all 20" can't
  spawn 20); (2) an optional `runJudge`-backed right-sizer (MODEL_REVIEW per D7) that prunes/merges
  overlap, runs ONLY at `tasks.length ≥ judgeThreshold` (≈2×cap; below it the judge is pure overhead),
  and **fails OPEN to the clamp** — it's a COST gate, NOT a safety gate. Kept tasks run through a
  concurrency pool of isolated read-only workers (`runSubagent` directly, fed `objective` as shared
  context — NOT via the delegate tool, so no double-cap/confirm). Results are **redacted at the source**
  (`redactOnWrite`) before being written to `memory/workflow/<runId>/<i>-<slug>.md` (the `<i>` index is
  load-bearing for filename uniqueness — slugs truncate + collide); only a compact index returns.
  Per-request cap (`maxWorkflowsPerRequest`, reset on `agent_start`) + confirm-on-fanout + the shared
  shutdown guard bound cost/blast. `synthesize` (default false) opt-in.
- **Why:** keeps parallelism cheap and honest — the clamp is the real cost floor, the judge earns its
  keep only on a genuine over-ask (where a merge beats truncation). Reuses delegate's worker core +
  `subagent-core`'s shared helpers, so no new spawn/redaction/shutdown machinery.
- **Trade-offs / residuals:** the right-sizer can't filter unsafe task content (fails open) — that rests
  on `"workflow"` in `autoJudge.guardedTools` (gates the fan-out spawn) + the per-worker read residual
  (out-of-repo reads, same as delegate). `delegate`'s + `workflow`'s per-request caps don't bound their
  *sum* (~13 worst-case Opus spawns/request) — documented; a shared spawn budget is **deferred** to v2.
  Disk exfil mitigated by redact-at-source + `.gitignore memory/workflow/`. Workers `--no-extensions` ⇒ no recursion.

## 2026-06-21 — model policy: Copilot-only ids, enforced by a repo-wide guard (dual-mode slice 2)
- **Context:** the harness selects models by id. A bare `gpt-5.5` is ambiguous (many providers); a
  provider-qualified `openai/<id>` or `anthropic/<id>` is NOT rejected — it resolves to the **direct**
  provider, needing that provider's own key/auth. The owner authenticates with **GitHub Copilot** only.
- **Decision:** every id is fully-qualified `github-copilot/<id>`. `MODEL_DEFAULT` =
  `github-copilot/claude-opus-4.8`, `MODEL_REVIEW` = `github-copilot/gpt-5.5`, in ONE place
  (`harness/pi/shared/subagent-core.ts`; `subagents` + `auto-judge` import them). **No direct
  `openai/`|`anthropic/` id may appear in ANY tracked file** — enforced by `harness/pi/model-id-guard.test.ts`
  (repo-wide `git grep`, runs in `npm test`). The throwaway `tmp/` scratch was untracked + gitignored
  rather than kept in the sweep list.
- **Why repo-wide, not harness-scoped:** a narrower guard passes green while a tracked file elsewhere
  (the formerly-tracked `tmp/`) still carries a forbidden id. The guard builds its pattern from parts so
  it never flags itself.
- **Trade-off / FLAG:** the exact Copilot ids are **unverified** — the dev node has only `anthropic` +
  `ollama` providers (no `github-copilot`), so `pi --list-models` couldn't confirm them, including the id
  FORMAT (`claude-opus-4.8` dotted here vs the live anthropic `claude-opus-4-8` dashed). Accepted per the
  plan ("if you can't auth Copilot, set the specified ids and flag it"); confirm on a Copilot node.

## 2026-06-20 — delegate: model-callable read-only sub-agent tool + workers-only model scope
- **Context:** the 6 human-fired roles each run a FIXED methodology. Wanted the pi analog of Claude
  Code's Task/Agent tool — the **main-session model** spawning a free-prompt, isolated investigator.
- **Decision:** a separate `harness/pi/delegate/` extension registers a `delegate({prompt})` tool.
  Key choices: **read-only** surface (`read,grep,find,ls` — no write/edit/shell, so the residual risk
  is leak/exfil, not mutation); **opt-in** via a `delegate` block resolved at `execute` (factory has no
  cwd — presence opts in, absent/malformed = inert refuse); **per-request spawn cap** (default 3, reset
  on `agent_start` not `turn_start`); **confirm-on-spawn** when `hasUI`, with `"delegate"` in
  `autoJudge.guardedTools` as the **headless** gate; **raw final text** returned (no SUMMARY/file
  contract — the worker's last message IS the answer), byte-capped, `details` **metadata-only**
  (secret-redaction never scrubs `details`); returned text framed as **untrusted DATA** (return-path
  injection mitigation is a prompt contract, not code). On hard `subagentFailed` the tool **THROWs**
  (a *returned* `isError` is inert — `agent-loop.js:433` hardcodes `isError:false` on the no-throw path;
  only a throw flags a real error), while **refusals** (cap/inert/declined-confirm) **return** informative
  content — they're control-flow, not errors. Mirrors the dual-mode `subagent_<role>` tool-mode pattern.
- **Why:** gives the model a bounded, isolated, read-only investigation primitive without exposing
  mutation; opt-in + caps + confirm bound cost/blast; throw-vs-return matches the verified loop behavior.
- **Model scope (records the 2026-06-18 operator directive):** "all sub-agents share one model" scopes
  to **workers only**. Workers — the 5 non-review roles AND the delegate/workflow workers — run on
  **MODEL_DEFAULT** (Opus 4.8); the adversarial-judge class (`/verify`, `auto-judge`, the workflow
  right-sizer) stays on **MODEL_REVIEW** (GPT-5.5) per D7. No D7 divergence; built code untouched.
- **Trade-off / residual:** built-in `read` takes ABSOLUTE paths and can't be path-jailed via `--tools`,
  so out-of-repo reads (`~/.ssh`, `~/.aws`) are a documented residual; true confinement needs a custom
  read tool (out of scope). Workers run `--no-extensions` ⇒ recursion bounded at depth 1.

## 2026-06-15 — auto-judge: `failClosed` kept as a debug-only knob (D6)
- **Context:** auto-judge gates main-session tool calls on a judge subprocess; when the judge times out
  or fails to spawn, the gate must choose allow vs block.
- **Decision:** keep a `failClosed` config field, default **true** (block on judge timeout/failure).
  `false` (allow-on-failure) is retained only as a **debug-only / discouraged** escape hatch — slice 2
  documents it as such and emits a warning notify when it lets a call through on failure.
- **Why:** a safety gate that fails *open* is worse than no gate (it implies protection it isn't giving).
  Keeping the knob (vs hard-coding) leaves a deliberate testing escape hatch without making fail-open the
  default. Parsed in slice 1 (`verdict.ts`), enforced in slice 2 (`auto-judge/index.ts`).

## 2026-06-15 — auto-judge: empty `judgeModel` → MODEL_REVIEW / GPT-5.5 (D7)
- **Context:** auto-judge is an adversarial reviewer of a proposed action — the same shape as `/verify`.
- **Decision:** an empty/whitespace `judgeModel` resolves to **MODEL_REVIEW** (`github-copilot/gpt-5.5`,
  `--thinking xhigh`), NOT MODEL_DEFAULT (Opus). The model policy classes reviewing/adversarial-judge
  agents as GPT-5.5 (`MODEL_REVIEW`); auto-judge joins that class.
- **Why:** keep ONE model policy (see the 2026-06-14 "Per-role model policy" entry below). The id now lives
  in ONE place — `harness/pi/shared/subagent-core.ts` — which `auto-judge/index.ts` imports (the old local
  dup is gone). Exact id is a live-pi FLAG (`pi --list-models` on a Copilot node) — update only that constant if it differs.

## 2026-06-15 — auto-judge: default OFF + single-shot no-tools judge (slice-2 design)
- **Context:** unlike command-guard's `/guard` (cheap regex, default ON), auto-judge spawns a model AND
  blocks the session on every guarded tool call — real cost + latency per call.
- **Decision:** (1) the gate defaults **OFF** — opt-in per session via `/autojudge on` (an `autoJudge`
  config block is necessary but not sufficient). (2) the judge is a **single-shot** subprocess with
  **`--no-tools`** (verified in pi's CLI arg parser: disables all tools — `--tools ""` would NOT, pi's
  falsy check at `main.js:336` falls back to the full default toolset), deciding from the policy +
  serialized tool input (+ optional working-tree diff) in one round-trip.
- **Why:** default-OFF avoids a committed config surprise-activating an LLM gate on `/reload`;
  single-shot/no-tools keeps per-call latency predictable for a blocking gate (a multi-turn, file-reading
  judge would stall the session on every bash/write/edit). Both confirmed with the user.
- **Trade-off:** the judge can't inspect files beyond the optional diff (enable `contextDiff`, or widen
  in a later slice). End-to-end behavior needs an authenticated pi — a live-pi FLAG (slice-3 smoke test).

## 2026-06-14 — Shared core in harness/pi/shared/, imported by relative path
- **Context:** `/checks` and `run_check` must run the SAME allowlist; secret-redaction and `/monitor`
  must redact with the SAME patterns — otherwise main session and sub-agents drift.
- **Decision:** extract `checks-core.ts` + `redact.ts` to `harness/pi/shared/`, imported via `../shared/`.
  `install.sh` installs `shared/` alongside every extension (symlink resolves via the link target; `--copy`
  copies it too — verified both).
- **Why:** one source of truth beats keeping two copies in sync; jiti resolves the relative `.js`→`.ts`
  import (verified with pi's real loader).

## 2026-06-14 — Redact in the runner, not only in a main-session hook
- **Context:** `/monitor`'s `run_experiment` runs in a `--no-extensions` subprocess and tees raw output
  to `memory/runs/<runId>.log`; the main-session `secret-redaction` hook can never see that.
- **Decision:** `runFixedTee` applies the shared `redact()` (injected) per line BEFORE both the agent-
  visible stream AND the disk write. Two call sites, one pattern set.
- **Why:** redaction must live where the bytes are produced; a hook on main-session `tool_result` is the
  wrong layer for subprocess/disk output.

## 2026-06-14 — Per-role model policy (verify=GPT-5.5, rest=Opus 4.8, xhigh)
- **Decision:** `runSubagent` always passes `--model` + `--thinking xhigh`; ids in two constants in
  `index.ts`. **Trade-off:** the operator must authenticate pi first (GitHub Copilot login is enough
  when it lists these models), then the ids are just model selections. Exact id strings remain a
  live-pi FLAG (`pi --list-models`); the handler surfaces a load error if a selected model is absent.

## 2026-06-14 — Repo-root-relative path matching
- **Decision:** command-guard boundaries and boundary-instructions `applyTo` match the target's path
  RELATIVE TO THE REPO ROOT (where harness/checks.json lives / cached at session_start), not `ctx.cwd`.
- **Why:** cwd-relative matching silently misses when pi is launched from a subdirectory.

## 2026-06-14 — Ponytail integrated by reference (not vendored) + ladder baked into the brief
- **Context:** wanted ponytail's "lazy senior dev" reuse discipline (YAGNI → stdlib → platform →
  installed dep → one-liner → minimum) in the harness. Ponytail ships a native pi extension
  (`pi install git:github.com/DietrichGebert/ponytail`) AND a tool-agnostic ruleset.
- **Decision:** (1) **reference + install** the upstream pi extension — do NOT vendor it into
  `harness/pi/ponytail/` (same call as MCP: document the external piece, don't copy it); install.sh
  prints a pointer instead of running a network install. (2) **Bake** a compact reuse-ladder into
  `AGENTS.md` + `harness/templates/AGENTS.template.md` ("Build discipline") so it reaches every tool
  AND the `--no-extensions` sub-agents.
- **Why reference, not vendor:** copying a third-party repo we don't own contradicts both this
  harness's reuse ethos and ponytail's own philosophy; upstream packaging + `pi install` auto-tracks
  updates with zero sync burden.
- **Caveat / trade-off:** the pi extension is **main-session only** (sub-agents spawn
  `--no-extensions`) — the baked `AGENTS.md` ladder is what covers sub-agents + non-pi tools. While
  active it injects its ruleset into the system prompt every turn (always-on token cost the harness
  otherwise minimizes); `lite` is the cheap default, `off` is free.

## 2026-06-14 — MCP scope = arXiv only; web = pi-web-access (not an MCP)
- **Decision:** web search via the `pi-web-access` extension; arXiv via `pi-mcp-adapter` + a one-server
  `.pi/mcp.json`. No custom in-repo MCP bridge.
- **Why:** the kept tools are read-only research — nothing destructive to gate by name, so the simple
  adapter suffices; a hand-rolled web fetcher would reintroduce SSRF/egress that the closed allowlist exists to avoid.
