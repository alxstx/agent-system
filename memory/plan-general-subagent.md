# Plan — model-callable general subagent ("delegate" tool)

> Status: PLAN ONLY (investigated 2026-06-18; not implemented) — **defaults LOCKED, implementation-ready**.
> Revised after FIVE independent reviews (A–J; NIT-1/2/3; R3: registration/`details`/return-path-injection/
> headless/promptSnippet; R4: session_shutdown orphans, visibility, doc-reconciliation, input schema, RPC
> `hasUI`; R5: delete auto-judge duplicates [not just the comment], config-validation rigor vs `verdict.ts`,
> shutdown-guard import purity, already-aborted signal, multi-session RPC counter). Every security/API
> claim re-verified against the actual code. Feasibility confirmed against the installed
> `@earendil-works/pi-coding-agent` types.

## Goal
Let the **main-session model** spawn a general-purpose, isolated, **read-only** pi subagent with a
prompt **it** chooses — the pi analog of Claude Code's `Task`/`Agent` tool. Today every subagent is a
**human-invoked** slash command with a *fixed* role; this adds a **model-invoked, free-prompt** path.

## Context (what exists today)
- `harness/pi/subagents/index.ts` registers 6 roles via `pi.registerCommand`. Each builds a system
  prompt (`AGENTS.md` + `harness/prompts/<role>.md`) + fixed handoff + fixed `--tools` allowlist, calls
  `runSubagent` (`:343`, spawns `pi --mode json -p --no-session --no-extensions … --tools <allowlist>`),
  extracts a `## SUMMARY`.
- `harness/pi/subagents/runner.ts` — the `pi.registerTool` surface (`run_check`/`run_experiment`).
- `harness/pi/auto-judge/index.ts` — a main-session extension spawning a single-shot `pi` subprocess.
- `harness/pi/{secret-redaction,command-guard}/index.ts` — the two main-session guards (see Security).

## Feasibility — confirmed against types + code
- `ExtensionAPI.registerTool` exposes a model-callable tool (`types.d.ts:840`). `ToolDefinition.execute`
  returns `AgentToolResult` (`{content:[{type:"text",text}], details?, isError?}`).
- `execute(id, params, signal, onUpdate, ctx)` — `ctx: ExtensionContext` exposes **`ctx.cwd`**,
  **`ctx.signal`** (AbortSignal), **`ctx.hasUI`**, **`ctx.ui.confirm(title,msg)`**, and
  **`ctx.ui.setStatus(key,text)`** (`types.d.ts:79`). So per-call cwd, abort-threading, and a live status
  line are available; the confirm is type-available but its mid-`execute` behaviour during streaming is
  **unproven** (NIT-3 — slice 0 probes it). `hasUI` is true in **both TUI and RPC** (`types.d.ts:214`),
  false only in `--mode json/print` (R4 — slice 0 probes all three).
- **No `session_shutdown` handler exists in the harness (R4-MAJOR).** `SessionShutdownEvent`
  (`reason:"quit"|"reload"|…`, `types.d.ts:439-444`) is available via `pi.on('session_shutdown')`. The 6
  roles run inside command handlers so reload-mid-call isn't a normal path; `delegate`/`workflow` `execute`
  runs **during streaming**, so a `/reload` or quit mid-call tears down the runtime with children still
  burning tokens → needs a shutdown handler (Decision 11).
- `install.sh` auto-discovers `harness/pi/*/index.ts` — a new `harness/pi/delegate/` is picked up.
- **Recursion bounded (Claim 2, airtight):** workers run `--no-extensions` → `delegate` absent inside →
  depth capped at 1.
- **Guards do NOT compose for free (corrected — Finding C, verified):** `command-guard` only acts on
  `bash`/`shell` + `write`/`edit` (`command-guard/index.ts:82,93`); a `delegate` call is none of those →
  **never gated**, and it never gates `read` at all. `auto-judge` *would* gate `delegate`, but only if
  the operator adds `"delegate"` to `autoJudge.guardedTools` **and** arms it (default OFF). So in an
  out-of-the-box harness, nothing gates a `delegate` spawn — this drives the mitigations below.

## Approach / architecture
A new main-session extension `harness/pi/delegate/index.ts`. The factory **always registers** ONE
read-only tool (`delegate`) — the factory has no cwd (`ExtensionFactory = (pi) => void`,
`types.d.ts:1029`), so config can only be checked at call time. On call it:
1. resolves the repo root via `findRepoRoot(ctx.cwd)` — `ctx.cwd` exists on `execute` (R3-MAJOR);
2. reads the `harness/checks.json` `delegate` block; if absent/malformed → **refuse (inert)** with a
   one-line message (Decision 2);
3. enforces the **per-request call cap** (Decision 7, reset on `agent_start`); refuses past it;
4. when `ctx.hasUI`, asks `ctx.ui.confirm` before spawning (Decision 8);
5. builds system prompt = `AGENTS.md` brief + `harness/prompts/delegate.md`; user turn = (optional
   `memory/MEMORY.md` index) + the model's `prompt` + a small handoff;
6. calls `runSubagent` with `read,grep,find,ls`, the shared subagent model `MODEL_DEFAULT` (Decision 6),
   `ctx.signal`, and **`onProgress → ctx.ui.setStatus("delegate: turn N…")`** (cleared in `finally` —
   Decision 10); the spawned child is **tracked for shutdown** (Decision 11);
7. on `subagentFailed`, returns an **explicit `isError` result** (NOT a silent empty string — R3-NIT);
   otherwise returns the subagent's **raw final text, capped** (~16 KB) as the tool-result `content`
   (Finding I — no `extractSummary`; no SUMMARY contract). `details` carries **metadata only** (Decision
   3 — R3-MAJOR). The `secret-redaction` `tool_result` hook scrubs the `content` on the way to the model
   (verified); `details` is NOT scrubbed, hence the metadata-only rule.

## Key decisions
1. **Surface — read-only `explore` only:** `read,grep,find,ls`. No write/edit/shell — preserves the
   no-mutation invariant. (Reviewer agreed; residual risk is *leak/exfil*, not mutation — see Security.)
2. **Opt-in — always-register, check at `execute` (R3-MAJOR correction).** The factory has no cwd
   (`ExtensionFactory = (pi) => void`), so the earlier "register only when a block is present, cwd-walk
   from launch cwd" was impossible — the factory could only see `process.cwd()`. Switched to the
   **repo-standard pattern** (`command-guard`/`checks`/`auto-judge` all do this): always register, and at
   `execute` resolve `findRepoRoot(ctx.cwd)` + read the `delegate` block — **no block or malformed →
   refuse with a one-line message** (parse in try/catch, fail safe). Tradeoff: the tool is *visible* to
   the model even where unconfigured (it refuses) — a minor token cost; in exchange, no `/reload` to
   toggle and no factory-cwd hazard. **`delegate` block fields (optional, LOCKED defaults):**
   `maxCallsPerRequest` (3), `confirmOnSpawn` (true), `model`/`effort` (override `MODEL_DEFAULT`/`EFFORT`),
   `capBytes` (16 KB result cap).
3. **Output + the `details` exfil channel (R3-MAJOR).** Return raw capped `finalText` as tool-result
   `content`; **drop `extractSummary`** (Finding I). **`details` must carry METADATA ONLY**
   (`turns`/`mode`/`model`) and **never** worker-derived text: `secret-redaction` iterates only
   `event.content` (`index.ts:24-28`), so `details: unknown` (`types.d.ts:691`) reaches the model
   **unredacted**. Enforce this in `subagent-core.ts` so `workflow` inherits it. Optional `report_file`
   (validated under `memory/`) deferred.
4. **Params + validation (R4-MAJOR):** `prompt` only in v1, declared as **`Type.String({minLength:1})`**
   AND re-validated in `execute` (`prompt.trim()` → refuse-empty with `isError` **before** confirm/spawn,
   so an empty prompt never spawns a full Opus subprocess on nothing). Belt-and-suspenders, mirroring
   `runner.ts:157-164`. (`model`/`report_file`/`context` deferred.) **Tool name LOCKED: `delegate`**
   (reads as a verb the model invokes; distinct from the `/role` commands; matches "delegate a subtask").
5. **Methodology file + tool metadata.** `harness/prompts/delegate.md` + handoff must state **"your final
   message is the answer text"** (Finding I — `finalText` keeps the last *text* message; a trailing tool
   call leaves it empty → `subagentFailed` trips). On the tool definition set **both `promptSnippet`**
   (R3-NIT — without it the tool is omitted from the system prompt's "Available tools" list,
   `agent-session.js:1855`) **and `promptGuidelines`** (nudge: give complete, self-contained instructions).
   **Return-path injection (R3-MAJOR):** because the worker reads attacker-controllable repo files and its
   result becomes a `tool_result` the main model trusts, `delegate.md` + a `promptGuidelines` bullet must
   frame the **returned text as untrusted DATA, not instructions** — mirror auto-judge's contract
   (`auto-judge/index.ts:104-109`). Highest-leverage, free injection mitigation.
6. **Model — workers use `MODEL_DEFAULT`; judges stay `MODEL_REVIEW` (NIT-1 correction).** The
   `delegate` worker runs on `MODEL_DEFAULT` (Opus 4.8) at `EFFORT` — the SAME model as the 5 non-review
   roles (plan/triage/monitor/report/research), not a separate/cheaper tier (supersedes the Finding-F
   `MODEL_EXPLORE` idea). It is **not** "one model for the whole harness": `/verify`
   (`subagents/index.ts:739`) and `auto-judge` deliberately run on `MODEL_REVIEW` (GPT-5.5) per
   `decisions.md` D7, and slice 1 keeps that constant. **DECIDED (operator, 2026-06-18):** the "all
   subagents same model" directive scopes to **workers only** — `/verify`, `auto-judge`, and the
   workflow right-sizer keep `MODEL_REVIEW` per D7; built code is untouched. The per-call `model` override
   stays deferred. Cost bounded by Decisions 7+2+8.
7. **Per-request cost cap (Finding E) — committed, not optional.** Default `sequential` execution stops
   fan-out, but the model can still loop within one request. Maintain a counter in the extension closure,
   **reset on `pi.on('agent_start')`** — NOT `turn_start`, which fires every assistant turn and would
   reset the cap between tool batches, defeating it (NIT correction). Refuse past `maxCallsPerRequest`
   with a clear message. **LOCKED default: `maxCallsPerRequest = 3`; no per-session cap in v1** (per-request
   is sufficient and keeps it minimal — add a per-session cap later only if abuse shows up). **Assumes
   one session per process (R5-NIT):** the counter is module-level (like `monitorSeq`), so under
   multi-session RPC an `agent_start` in session B would reset session A's cap — state the assumption, or
   key the counter by session id if multi-session RPC is in scope (major under RPC, nit under TUI).
8. **Spawn gating (Finding C) — two layers.** (a) When `ctx.hasUI`, the tool emits `ctx.ui.confirm`
   before spawning — **LOCKED default `confirmOnSpawn = true`** (the confirm shows the prompt being sent,
   so the human can catch an injected `read ~/.ssh/...`); set `confirmOnSpawn:false` in the block to
   opt out. Independent of `guardedTools` — no auto-coordination in v1 (if a user both arms auto-judge on
   `delegate` and leaves confirm on, two prompts fire; auto-judge is default OFF, so this is an edge
   case). **Caveat (NIT-3 — live-pi
   unknown):** no repo extension calls `.confirm`; it is type-available (`types.d.ts:67-71`) but whether
   a modal confirm actually blocks+renders inside a tool's `execute` *during streaming* (vs. only in
   user-initiated command handlers) is UNPROVEN — slice 0 now probes it. It is **load-bearing**; if it
   misbehaves, fall back to relying on the (b) `guardedTools` gate and skip the confirm (don't silently
   auto-allow as if confirmed). (b) Ship the `delegate` block's docs + the slice-3 `checks.json` example
   **with `"delegate"` already in `autoJudge.guardedTools`**, so arming auto-judge actually gates it. Do
   not claim the existing guards cover it for free. **Headless = zero gates (R3-NIT):** in `--mode
   json/print`, `hasUI` is false → confirm no-ops, command-guard ignores custom tools, auto-judge is
   default-OFF — i.e. the two layers become *zero* in exactly the automated contexts most exposed to
   injection. So `"delegate"` in `guardedTools` (+ arming auto-judge) is the **primary** gate for
   headless, documented as such — not merely a fallback.
9. **Root resolution (Finding J):** `delegate` keys opt-in off the **`checks.json` root** (the
   `checks-core` `findRepoRoot`, not the `plan.md`+`MEMORY.md` one). `AGENTS.md`/`MEMORY.md` are read
   **best-effort** from that same root (`readIfExists` already tolerates absence), so a repo with a
   `delegate` block but no `plan.md` still works.
10. **Operator visibility (R4-MAJOR) — match the existing roles.** A multi-minute Opus spawn must not be
    a silent block: thread `onProgress → ctx.ui.setStatus("delegate: turn N (tool)…")` (cleared in
    `finally`), exactly as the 6 roles do (`subagents/index.ts:616`). **Trade stated explicitly:** unlike
    the roles, a tool's `AgentToolResult` goes to the **model only** — the operator sees it only by
    expanding the tool row. Add a one-line completion `ctx.ui.notify` so there's a human-visible "done".
11. **Lifecycle / shutdown (R4-MAJOR) + abort.** In `subagent-core.ts`, track live children in a
    module-level `Set` and register ONE `pi.on('session_shutdown')` that `SIGTERM→SIGKILL`s them (reuse
    auto-judge's ladder, `auto-judge/index.ts:191-211`) — `ctx.signal` covers operator-abort, but NOT a
    `/reload`/quit mid-`execute`, which would otherwise orphan the subprocess. Shared so `workflow`'s
    fan-out inherits it.

## Milestones / slices (reordered to de-risk — Finding A)
0. **Prove the premises FIRST (throwaway, ~5–10 lines).** A tiny main-session extension that
   `registerTool`s an echo tool; `install.sh` + `/reload` on an authed node; confirm the **main model can
   call it** (Claim 1) **and probe `ctx.ui.confirm` mid-`execute` in all three UI modes — TUI, RPC,
   `--mode json/print`** (NIT-3 + R4: `hasUI` is true in TUI *and* RPC, false only headless) so the
   confirm gate isn't an unproven dependency later. Removes the two real unknowns *before* touching the 6
   working roles. Delete after.
1. **Refactor (now safe):** extract `harness/pi/shared/subagent-core.ts` (`runSubagent` **+ an OPTIONAL
   `signal` param** — net-new behavior, but the 6 roles pass none and stay byte-for-byte unaffected; the
   abort path is verified in slice 4, NOT by the "6 roles run" done-condition — NIT-2), `getPiInvocation`,
   `extractSummary`, `SubagentResult`, `subagentFailed`, model/effort constants
   `MODEL_DEFAULT`/`MODEL_REVIEW`/`EFFORT`). Also put the **shared safety helpers here so both tools
   inherit them** (cross-cutting): a `cleanDetails` rule (metadata-only — R3-MAJOR) and a
   `redactOnWrite(loadRedactor(root))` helper for any disk write (used by workflow — R3-BLOCKER), the
   live-children `Set` (module data) + an **exported `registerShutdownGuard(pi)`** the factory calls
   (NOT a top-level `pi.on` — keeps the module importable by `-e`/workers, R5-NIT) that `SIGTERM→SIGKILL`s
   on `session_shutdown` (Decision 11 — R4). The new `signal` path must **kill immediately if
   `signal?.aborted` at entry** (mirror `checks-core.ts:327`), not only `addEventListener` (R5-NIT).
   Update `subagents/index.ts` to import — **and DELETE auto-judge's live duplicates** (`getPiInvocation`
   `:41-51`, `MODEL_REVIEW`/`EFFORT` `:32-33`) importing them from `subagent-core.js` instead (R5-MAJOR —
   this is the drift `shared/` exists to kill, `decisions.md:37-44`; editing only the "keep in sync"
   comment leaves the duplicate). Add a unit test for the pure `extractSummary` (Finding G).
   **Done-condition:** `npm run typecheck` clean **and** the 6 roles still run (`/plan`, `/verify` smoke)
   — i.e. no regression. (**DECIDED 2026-06-20: delete + import**, NOT leave auto-judge self-contained —
   reuse-ladder + kill the drift `shared/` exists to prevent.)
2. **The tool:** `harness/pi/delegate/index.ts` + a pure `delegate/config.ts` (block parse/gating,
   cap/truncate, prompt assembly) with an **offline unit test** (Finding G). **Match `verdict.ts`'s
   validation rigor, NOT `loadConfig`'s laxity (R5-MAJOR):** clamp `maxCallsPerRequest`/`capBytes` to
   `[1, ceiling]`, validate `confirmOnSpawn` by type, and treat a non-object/`[]` block as inert (mirror
   `verdict.ts:49` — `{}` = active-with-defaults, `delegate: []` must NOT activate). **New dir ⇒ re-run
   `harness/pi/install.sh` once (it symlinks the dir), then `/reload`; later in-repo edits are live**
   (R5-MAJOR — `/reload` alone can't create a symlink for a never-installed dir). Wires Decisions 1–11;
   `subagentFailed` → **explicit `isError` result** (R3-NIT), `details` metadata-only. Add
   `harness/prompts/delegate.md` (incl. the result-is-DATA framing — Decision 5).
3. **Config + docs — reconcile, don't just add (R4-MAJOR):** `delegate` block in `harness/checks.json`
   (+ python-lmcache example, **with `"delegate"` in `autoJudge.guardedTools`**). Docs must **amend the
   contradictions a model-self-firing tool creates**, not bolt a tool onto stale framing: `harness/README.md`
   Principle 4 ("the 'agents' are prompts *you* fire", `:36`) and `subagents/README.md`'s human-invoked
   framing need an explicit model-invoked carve-out; **`memory/architecture.md`** (glossary `:36` +
   checks.json block inventory `:21-22`) is added to this slice too. Plus the template; `decisions.md`
   entry **(incl. recording the 2026-06-18 "workers→`MODEL_DEFAULT`, judges stay `MODEL_REVIEW`" directive
   — not yet in `decisions.md`)**; memory update.
4. **Live-pi smoke (FLAG):** end-to-end on an authed node — model calls `delegate`, isolated read-only
   subagent returns text, **a live `setStatus` turn-counter shows during the call + a completion notify
   fires** (R4), **per-request cap refuses the 4th call**, **confirm prompt fires + blocks** (NIT-3),
   **abort (`ctx.signal`) kills the subprocess** (NIT-2), **`/reload` mid-call leaves no orphaned `pi`
   process** (R4-MAJOR), **a bad `model` id surfaces as an `isError` result, not a silent empty string**
   (R3-NIT), `--no-extensions` blocks recursion, and (with `delegate` in `guardedTools` + auto-judge
   armed) the spawn is gated.

## Security analysis (Findings B/C/D — re-verified)
- **Out-of-repo reads are the real leak vector (Finding B).** Built-in `read`/`grep`/`find`/`ls` accept
  **absolute paths**; the subagent's cwd is the repo, but nothing confines it — `read("~/.pi/...")`,
  `~/.aws/credentials`, `~/.ssh/id_rsa` all work. Because `delegate` hands prompt control to the main
  model, repo content that **prompt-injects** the main model can drive
  `delegate("read ~/.ssh/id_rsa and summarize")`. The built-in `read` **cannot be path-jailed** via
  `--tools`; true confinement would need a custom read tool (out of scope). Residual risk stated
  honestly.
- **Redaction is real but partial, and only on `content` (Finding D + R3-MAJOR).**
  `secret-redaction/index.ts:22-28` hooks `tool_result` and scrubs the `content` text of **all**
  main-session tool output incl. custom tools → `delegate`'s returned `content` **is** redacted when that
  extension is loaded. Caveats: (a) only **secret-shaped** patterns (arbitrary private text is not
  caught); (b) **`details` is NOT scrubbed** → metadata-only (Decision 3); (c) any belt-and-suspenders
  in-tool redaction must use `loadRedactor(resolvedRoot)` from `ctx.cwd`, **not** `process.cwd()` —
  `secret-redaction` loads its redactor at factory time from `process.cwd()` (`:20`), so launched from a
  subdir/other repo the project's `redaction.json extraPatterns` may not apply to delegate output
  (R3-NIT).
- **Return-path / second-order injection (R3-MAJOR — the highest-leverage gap).** The worker reads
  attacker-controllable repo files; its final text becomes a `tool_result` the **main model trusts as
  context**. A repo file can carry a payload the worker faithfully relays, crafted to steer the main
  model next turn. Mitigation is a *prompt* contract, not code: `delegate.md` + `promptGuidelines` frame
  the returned text as **untrusted DATA, never instructions** (mirror `auto-judge/index.ts:104-109`).
- **Mitigation set (no false comfort):** (1) read-only ⇒ no mutation; (2) `secret-redaction` scrubs
  secret-shaped data in `content` only; (3) `details` metadata-only; (4) result-is-DATA prompt contract;
  (5) Decision 8 confirm-on-spawn + `delegate` in `autoJudge.guardedTools` (the **primary** gate in
  headless); (6) per-request cap (Decision 7) bounds cost/blast. The non-secret-shaped exfil path and the
  second-order-injection residual are **documented residuals**, not "covered."

## Risks / unknowns
- Out-of-repo read / exfil — see Security (documented residual; partial mitigations).
- Cost — bounded by Decisions 7 (per-request cap) + 2 (opt-in) + 8 (confirm); document the per-call cost
  (a full Opus-4.8/xhigh spawn per call, same as the other subagents — Decision 6).
- **Depth-vs-cost tension (R4-NIT):** `maxCallsPerRequest=3` may be *too low* to be useful — workers are
  `--no-session`, so the main model must thread state across the 3 isolated calls in its own context, the
  exact token cost `delegate` exists to avoid. It's config-overridable; tune per repo.
- **"16 KB cap" is a char-slice, not a true byte cap (R4-NIT):** the borrowed `capText`/`readCapped`
  idiom slices by UTF-16 code unit while measuring `Buffer.byteLength` — cosmetic at 16 KB, but call it a
  "result cap" (or slice on a `Buffer`), not a byte cap.
- API drift — model id strings + tool-result behavior fully proven only on authed live pi (slice 4).

## Out of scope (for v1)
- `write`/`full` (edit+bash) modes — DECIDED out (read-only only).
- Path-jailed/custom `read`; multi-level recursion; parallel fan-out (that's `memory/plan-workflow.md`).
- A Copilot/other-tool analog (pi-specific surface).

## Resolved defaults (implementation-ready — 2026-06-18)
All prior open questions are now LOCKED:
- **Model scope:** workers only (`/verify`+`auto-judge`+right-sizer keep `MODEL_REVIEW` per D7; built
  code untouched). See Decision 6.
- **`maxCallsPerRequest` = 3**; no per-session cap in v1 (Decision 7).
- **`confirmOnSpawn` = true** when `hasUI`, config-overridable, no auto-coordination with `guardedTools`
  (Decision 8a).
- **Tool name = `delegate`** (Decision 4).
