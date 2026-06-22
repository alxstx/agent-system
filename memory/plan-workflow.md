# Plan — minimal workflow function (governed parallel fan-out)

> Status: PLAN ONLY (investigated 2026-06-18, not implemented) — **defaults LOCKED, implementation-ready**;
> reviewed four times (R2 REVISE → MAJOR-1/2/3; R3 → 1 BLOCKER [disk writes un-redacted] + MAJORs
> [gitignore, synth laundering, governor-is-cost-not-safety, stacked spawn exhaustion]; R4 → MAJORs
> [session_shutdown orphans, visibility, doc reconciliation, input schema, governor-efficacy threshold,
> dead `objective`, pool not offline-testable]; R5 → MAJORs [delete auto-judge dupes + ordered runJudge
> move, config-validation rigor + `maxParallel` ceiling, `workflowSeq`/`<i>` filename uniqueness, re-run
> `install.sh` for new dir] + NITs] — all folded in; claims re-verified against code). **Depends on
> `memory/plan-general-subagent.md`** — a workflow is N parallel `delegate`
> workers + a governor that right-sizes the fan-out + result aggregation. Build `delegate` first; this
> reuses its worker core.

## Goal
Let the main agent fan a task out to **several** isolated subagents at once — a *minimal* analog of the
cloud Workflow tool — but with a **governor** that right-sizes the fan-out: "you proposed 20 subagents,
5 cover the objective." The governor is the point: keep parallelism cheap and honest, not a fan-out bomb.

## Context (what this reuses)
- `runSubagent` (`harness/pi/subagents/index.ts:343`) spawns one isolated `pi` subprocess and returns a
  Promise. Running several concurrently is just `Promise.all` over N calls with a small concurrency pool
  — no new runtime primitive needed; they're separate OS processes.
- `auto-judge`'s `runJudge` (`harness/pi/auto-judge/index.ts:147`) is the "single-shot judge subprocess"
  pattern the **governor** needs — BUT it is a **non-exported local** (only `autoJudge(pi)` is exported,
  `:266`), so it must be **extracted into `shared/` first** (MAJOR-1), not "reused" in place.
- `delegate` (planned) gives the read-only worker core. A workflow worker runs via **`runSubagent`
  directly** (the shared worker core) — NOT through the `delegate` *tool* wrapper, so it does NOT
  double-count delegate's per-request cap or double-prompt its confirm (NIT-3). Same `subagent-core.ts`.
- Opt-in pattern (`experiments`/`autoJudge` blocks in `harness/checks.json`) → a `workflow` block.

## Feasibility — confirmed
- `pi.registerTool` exposes a model-callable tool (proven for `delegate`). A `workflow` tool's `execute`
  can `await` many `runSubagent` calls and return one aggregated `AgentToolResult`.
- The governor reuses the auto-judge judge machinery (single-shot, `--no-tools`, strict parse) — which
  requires **extracting `runJudge` into `shared/`** (MAJOR-1; private local today).
- `runSubagent` **never rejects** (`subagents/index.ts:375-427` resolves in both close+error handlers) →
  a failed worker yields a `SubagentResult` with `subagentFailed`, not a thrown promise. So `Promise.all`
  over workers won't fail the batch — lean on this for the partial-index design. The real throw risks are
  the **fs writes** and the **hand-rolled pool** → wrap both in try/catch (NIT-1).
- Recursion bounded for free: workers run `--no-extensions` → cannot call `workflow`/`delegate` → no
  recursive fan-out. The `workflow(...)` call is a main-session tool call → command-guard/auto-judge can
  gate the *spawn*.
- `execute(id, params, signal, …)` receives an `AbortSignal` → wire it to all children so one abort kills
  the whole fan-out. (`runSubagent` needs an OPTIONAL `signal` added — `runJudge` already has one; fold
  both into the `subagent-core.ts` extraction.) **Copy auto-judge's `SIGTERM`→`SIGKILL` ladder with
  `{once:true}` + `cleanup()` (`auto-judge/index.ts:191-211`)** so an aborted N-wide fan-out doesn't
  orphan up to `concurrency` Opus children still burning tokens (R3-MAJOR). **Abort kills all in-flight +
  drains the queue** — a slice-1 pool test, not a slice-4 smoke.
- **Shutdown ≠ abort (R4-MAJOR):** `ctx.signal` covers operator-abort but NOT `/reload`/quit
  mid-`execute` — a fan-out is live *during streaming*, so a reload tears down the runtime with up to
  `concurrency` children alive. Inherit the shared live-children `Set` + one `pi.on('session_shutdown')`
  handler from `subagent-core.ts` (delegate Decision 11) — no `session_shutdown` handler exists in the
  harness today (verified).

## Approach / architecture
A new main-session extension `harness/pi/workflow/index.ts` registering ONE tool (`workflow`). On call:
1. **Input + validation (R4-MAJOR):** the main agent passes `objective: string` + `tasks: string[]`.
   Declare a real schema — `tasks: Type.Array(Type.String({minLength:1}), {minItems:1,
   maxItems:maxInputTasks})` — AND re-validate in `execute`: **trim, drop empties, dedupe** (mirror
   `verdict.ts:62-67`) before anything spawns, so `[]`/whitespace/duplicate/non-string elements can't
   charge the cap or spawn duplicate workers + duplicate files. The tool does NOT decompose. **`objective`
   is fed into EVERY worker's user turn as shared context (R4-MAJOR)** — otherwise it is dead input on the
   common path (read only by the judge, which is skipped below the threshold); feeding it to workers both
   uses it and improves worker quality.
2. **Govern (right-size):** two complementary layers —
   - **Baseline (always on, free — the real floor):** a hard cap `maxParallel` + a `promptGuidelines`
     bullet ("use the fewest subagents that cover the objective; the workflow caps at N"). **The kept
     list is ALWAYS code-clamped: `kept = list.slice(0, maxParallel)` unconditionally — even on a
     *successful* judge reply** (MAJOR-3: an injected `tasks[]` saying "keep all 20" would otherwise
     spawn 20; the concurrency pool bounds *concurrent* processes, not *total* spawns). This answers the
     plan's own injection question: yes, unless the clamp is enforced in code.
   - **Smart (optional):** an LLM **right-sizer judge** (the extracted `runJudge`, on `MODEL_REVIEW` per
     D7 — Decision 9) — gets `objective` + `tasks` + the cap, returns a **pruned/merged** list (merge
     overlapping, drop redundant) + one-line rationale each. **Run the judge ONLY when `tasks.length ≥
     judgeThreshold` (default `2×maxParallel`)** — below that the judge (≈1 worker's cost at
     `MODEL_REVIEW`/xhigh) is pure overhead and the agent's own priority order makes a blind
     `slice(0, maxParallel)` fine; the judge earns its keep only on a real over-ask where a *merge* beats
     truncation (R4-MAJOR — the efficacy thesis made explicit + bounded, not just asserted). Parse
     leniently; on parse/spawn failure **fall open to the clamp** (first `maxParallel`), NOT fail-closed.
     So the judge is *quality + cost-control at large fan-out*; the baseline clamp is the actual cost floor.
3. **Fan out:** run the clamped kept-tasks through a small **concurrency pool** (run `concurrency` at a
   time, default = cap). The pool takes an **injectable `(task, signal) => Promise<R>` worker** (R4-MAJOR)
   — real `runSubagent` (`read,grep,find,ls` + the `objective` shared context + the shared `signal`, NOT
   via the delegate tool — NIT-3) in prod, a stub in tests — so the pool's scheduling/abort/drain is
   genuinely offline-testable (a pool hard-coding `runSubagent` is not pure). Live progress via
   `ctx.ui.setStatus("workflow: k/N workers done")`, cleared in `finally`.
4. **Aggregate (keep context small):** write each worker's result to
   `memory/workflow/<runId>/<i>-<slug>.md` — but **route every result through `loadRedactor(root)` BEFORE
   `fs.writeFileSync` (R3-BLOCKER).** The `secret-redaction` hook only scrubs `tool_result` *return*
   values, never disk writes (it's exactly why `/monitor` redacts at the source in `runFixedTee`,
   `checks-core.ts:372`). Without this, a worker that read `~/.aws/credentials` writes the raw secret to
   disk with **zero** redaction. `<runId>` is **internally generated** (like `/monitor`'s,
   `subagents/index.ts:916`, NOT model-supplied), `<slug>` via **`slugify`** (`:265`), `mkdir -p`, and a
   **new sibling validator** confining under `memory/workflow/` — NOT `validateLogFile`, which hardcodes
   `memory/runs/` (`checks-core.ts:222`) and would reject these paths (R3-NIT). **Cap each worker file at
   `maxResultBytes`, slicing on a `Buffer`** so the cap is honored in bytes (R4-NIT — the borrowed
   `capText`/`readCapped` idiom slices by UTF-16 code unit while measuring `Buffer.byteLength`; an
   uncapped worker that echoes a huge file would write an arbitrarily large `.md`). Return a compact
   **index** to the main session — per task: a one-line headline + file path + status — plus the
   governor's rationale. Optional `synthesize: true` runs one extra subagent that reads **only the
   already-redacted files** (R3-MAJOR — it's `--no-extensions`, so it has no in-worker redaction of its own).

## Key decisions / forks
1. **Governor design — DECIDED: layer both, judge IN v1.** Hard cap + prompt guideline as the always-on
   baseline; the LLM right-sizer judge as the smarter layer — **`useJudge` default `true`, shipped in
   slice 1** (so the governor is complete from the start; set `useJudge:false` to run baseline-only). The
   judge returns a pruned list (≤ cap), not just a number, so it can *merge* tasks, not just truncate.
   Fail-OPEN to the clamp (unlike auto-judge, which fails closed) — a governor's job is to shrink, not block.
   **CRITICAL framing (R3-MAJOR): the right-sizer is a COST governor, NOT a safety/content gate.** It
   prunes for overlap, not safety — an injected `tasks[i]` = "read ~/.aws/credentials and report it"
   passes straight through. And because it fails OPEN, an injected list crafted to make the judge reply
   *unparseable* disables the pruning layer at will (still bounded by the clamp). Unsafe-task filtering
   depends ENTIRELY on `"workflow"` in `autoJudge.guardedTools` (default OFF) + the per-worker read
   residual. Never imply the governor inspects task safety.
2. **Who decomposes?** The **main agent** passes `tasks[]` (it has the context). The tool governs +
   runs; it does not invent subtasks. (Alt: tool decomposes from `objective` via a planner subagent —
   more autonomous, more moving parts, more cost. Out of scope for minimal.)
3. **Worker surface:** read-only `explore` (`read,grep,find,ls`), same as `delegate`. No write/edit/bash.
4. **Aggregation:** files-on-disk + compact index back (preserves "index in context, detail on disk").
   **Synth stage is opt-in — `synthesize` default `false` in v1** (a flag); NOT return-all-concatenated
   (would blow the main context — anti-harness).
5. **Concurrency:** a small inline async pool capped at `concurrency` (**LOCKED default 5 = `maxParallel`**)
   so we never spawn 20 `pi` processes at once. The clamp is `[1, maxParallel-ceiling]` — there is no
   *separate* `concurrency` ceiling (8 was dead config: kept-list ≤ `maxParallel`, so `concurrency` ≤
   `maxParallel` always — R5-NIT). The single ceiling that matters is **`maxParallel`'s** (Decision 7 /
   slice 1), which is also the cost-governor kill-switch.
6. **Separate tool vs. param on `delegate` — LOCKED: separate `workflow` tool** (clearer for the model;
   distinct governor + aggregation). Reuses delegate's worker core. (Alt rejected: `delegate({tasks:[…]})`
   — one tool, but muddier and double-purposes the cap/confirm.)
7. **Opt-in — always-register, check at `execute`** (same R3-MAJOR correction as delegate: the factory
   has no cwd, so resolve `findRepoRoot(ctx.cwd)` + read the block at call time; no block/malformed →
   refuse). **Block fields with LOCKED defaults:** `maxParallel` (5, **hard ceiling 8 — the cost-governor
   kill-switch, clamped in code**, R5), `concurrency` (5; clamped to `[1, maxParallel]`),
   `maxWorkflowsPerRequest` (2), `useJudge` (true), `judgeThreshold` (`2×maxParallel` — run the judge only
   at/above this — R4), `judgeModel` (override `MODEL_REVIEW`), `synthesize` (false), `maxInputTasks`
   (**cap incoming `tasks[]` BEFORE the judge — default e.g. 30 —** so a 500-element array can't bloat the
   right-sizer prompt; R3-NIT), `maxResultBytes` (per-worker file cap, byte-honest — R4-NIT), `timeoutMs`
   (per-worker; **LOCKED default + hard ceiling, code-clamped** like auto-judge clamps its judge timeout).
8. **Per-request workflow-call cap (MAJOR-3) — committed, not just a risk note.** A counter **reset on
   `pi.on('agent_start')`** (NOT `turn_start`, which resets between tool batches and defeats it); refuse
   past **`maxWorkflowsPerRequest` (LOCKED default 2)**. Fan-out needs this more than `delegate` does; it
   stacks with the total-kept clamp (step 2) and the concurrency pool. (Worst case per request: 2
   workflows × 5 workers = 10 worker spawns, bounded.) Module-level counter ⇒ **one-session-per-process
   assumption** (R5-NIT — under multi-session RPC, `agent_start` in session B resets session A's cap;
   key by session id if multi-session RPC is in scope).
9. **Right-sizer model (MAJOR-2) — `MODEL_REVIEW` per D7 (DECIDED).** The right-sizer is an
   adversarial-judge-class subagent, and `decisions.md` D7 routes that class to `MODEL_REVIEW` (GPT-5.5);
   the workers run on `MODEL_DEFAULT` like the 5 non-review roles. The operator resolved (2026-06-18)
   that "all subagents same model" scopes to **workers only**, so this stays `MODEL_REVIEW` — no D7
   divergence. `judgeModel` in the block can override.
10. **Stacked spawn exhaustion (R3-MAJOR) — DECIDED 2026-06-20: document-only in v1.** `delegate`'s
    per-request cap and `workflow`'s caps are independent closures — nothing bounds their *sum*. Worst
    case in one user request ≈ delegate 3 + workflow 2×5 = **~13 full Opus-4.8/xhigh subprocesses**. v1
    ships the per-tool caps and **documents this stacked worst case loudly**; a **shared per-request spawn
    budget** in `subagent-core.ts` (both tools decrement, reset on `agent_start`) is **deferred** — add it
    only if it bites. The abort/shutdown ladder still reclaims in-flight spawns regardless.
11. **Operator visibility + lifecycle (R4-MAJOR) — match the existing roles.** A `k/N workers done`
    `ctx.ui.setStatus` counter (cleared in `finally`) + a completion `ctx.ui.notify` — the
    `AgentToolResult` goes to the **model only** (operator sees it by expanding the tool row), so a
    multi-minute fan-out must not be a silent block. Live children tracked in the shared `Set` +
    `session_shutdown` handler (Feasibility) so `/reload` mid-fan-out orphans nothing.

## Milestones / slices
0. **Prereq (ordered — R5-MAJOR):** `delegate` slice 1 must land FIRST (it moves `getPiInvocation` into
   `subagent-core.ts` and makes auto-judge import it). THEN move **only the `runJudge` plumbing**
   (`RunJudgeOptions`/`JudgeOutcome`/the spawn+timeout loop, `auto-judge/index.ts:147`) into the SAME
   `subagent-core.ts` — required because `runJudge` calls `getPiInvocation` (`:176`), so they must co-locate
   — and auto-judge then imports `runJudge` too, **deleting its second local** (it loses
   `getPiInvocation` in slice 1, `runJudge` here — two ordered edits, stated). **Do NOT drag along
   `JUDGE_SYSTEM_PROMPT` (ALLOW/DENY) or `parseVerdict`** — the right-sizer needs its own system prompt +
   parser (R3-NIT).
1. **Governor (pure + judge):** a `right-size` module — pure **cap/clamp/prune/parse/dedupe** logic AND
   the **injectable concurrency-pool scheduler** ((task,signal)=>Promise, stubbed worker — R4), BOTH
   unit-tested offline like `verdict.ts` (Finding G + NIT-1) + a `runJudge`-backed pruner
   (strict-but-lenient parser, `MODEL_REVIEW` per D7, only above `judgeThreshold`). Always code-clamp to
   `maxParallel`; fail-open to the clamp. **Config validation mirrors `verdict.ts:49,60-77`, NOT
   `loadConfig`'s laxity (R5-MAJOR):** every numeric clamped to `[1, ceiling]` (give **`maxParallel` an
   explicit ceiling — the governor's own kill-switch; an unbounded `maxParallel:500` nullifies the whole
   cost governor**, and `concurrency:0` → a pool that never drains/hangs), booleans by type, and a
   non-object/`[]` block is inert (`{}` = active-with-defaults; `workflow: []` must NOT activate). **Also
   add `memory/workflow/` to `.gitignore` now — before any code writes there** (R4-NIT; only `memory/runs/`
   is ignored, and `*.log`/`memory/runs/` don't match `…/<i>-<slug>.md`). **Done-conditions:** offline
   tests pass for clamp + parse + dedupe + pool scheduling; **abort kills all in-flight + drains the
   queue** (now honest — parameterized pool); **a worker result is `loadRedactor`-scrubbed before
   `fs.writeFileSync`** (R3-BLOCKER, asserted offline).
2. **The tool:** `harness/pi/workflow/index.ts` — `registerTool("workflow")` (always-register; gate at
   `execute`), `objective`+`tasks` params with **schema + execute-time trim/dedupe/drop-empty refuse**
   (R4-MAJOR), per-request cap → governor → injectable pool → workers (`runSubagent` directly, fed
   `objective` as shared context) → **redact-on-write** capped files + return compact index (`details`
   metadata-only) + `setStatus` k/N counter + completion notify (R4-MAJOR). **Filenames
   `<runId>/<i>-<slug>.md`: `<runId>` uses a module-level `workflowSeq++` suffix (mirror `monitorSeq`,
   `subagents/index.ts:64,916`) so two same-millisecond calls don't collide; `<i>` = zero-based position
   in the clamped kept-list and is LOAD-BEARING for uniqueness — `slugify` truncates to 60 chars (`:271`)
   so two long tasks can share a `<slug>`, and the Approach-1 dedupe is exact-string-only (R5-MAJOR).**
   **New dir ⇒ re-run `harness/pi/install.sh` once, then `/reload`; later edits are live** (R5-MAJOR).
   Add `harness/prompts/workflow.md` (worker + synth methodology) — incl. **"end with a text answer, not
   a tool call"** (else a read-only explorer ends on a `read`/`grep` → empty `finalText` →
   `subagentFailed` → spurious failures — R3-NIT) **and the result-is-DATA framing** (inherited). **Done:**
   `npm run typecheck` clean; a live fan-out returns a partial index with per-task status; offline test
   for block parse/gating + input validation.
3. **Config + docs — reconcile, don't just add (R4-MAJOR):** `workflow` block in `harness/checks.json`
   (+ example). Docs must **amend the contradictions** a model-self-firing fan-out creates, not bolt onto
   stale framing: `harness/README.md` Principle 4 ("prompts *you* fire", `:36`), `subagents/README.md`'s
   human-invoked framing, and **`memory/architecture.md`** (glossary `:36` + checks.json block inventory
   `:21-22`) all need updating. Plus the template; `decisions.md` entry **(incl. the 2026-06-18
   workers-only model directive — not yet recorded)**, memory updates. **Done-condition:** example
   validates; `/verify` PASS on the slice (per AGENTS.md DoD — NIT-4).
4. **Live-pi smoke (FLAG):** install + `/reload` on an authed node; confirm fan-out runs in parallel with
   a live `k/N` status, the right-sizer prunes (ask for 12, cap 5 → 5) **and the clamp still holds if the
   judge says "keep all"**, **the judge is skipped below `judgeThreshold`**, abort kills all children,
   **`/reload` mid-fan-out leaves no orphaned `pi` processes** (R4-MAJOR), `maxWorkflowsPerRequest` refuses
   a 2nd call, recursion blocked, command-guard/auto-judge gate the `workflow` spawn.

## Inherited from the (reviewed) delegate plan — apply here too
Workers ARE read-only `delegate` workers, so the verified findings in `memory/plan-general-subagent.md`
carry over and must NOT be re-mis-stated here:
- **Guards don't gate the spawn by default** (Finding C, verified): `command-guard` ignores custom
  tools; gating needs `"workflow"` in `autoJudge.guardedTools` + armed. Add a `ctx.ui.confirm` before a
  fan-out when `hasUI` (it spawns N processes — confirm matters more here than for one delegate).
- **Redaction (Finding D + R3-BLOCKER — corrected):** `secret-redaction`'s `tool_result` hook scrubs the
  **returned index** only (secret-shaped) — it does **NOT** cover the **disk files** the parent writes
  (`fs.writeFileSync` is not a tool result). So worker results MUST be `loadRedactor`-scrubbed before
  write (Approach step 4), and `details` must be metadata-only (R3-MAJOR, inherited from delegate
  Decision 3). Out-of-repo reads (`~/.ssh`, `~/.aws`, `~/.pi`) remain a documented residual — N workers
  widen the surface; built-in `read` can't be path-jailed.
- **Model (NIT-1/MAJOR-2 — corrected, DECIDED workers-only 2026-06-18):** workers run on `MODEL_DEFAULT`
  (Opus 4.8), same as the 5 non-review roles; the **right-sizer judge runs on `MODEL_REVIEW`** per D7
  (adversarial-judge class). Not a whole-harness uniformity claim. N× cost is bounded by the clamp +
  concurrency pool + per-request cap + opt-in + confirm.
- **Opt-in mechanics** (Finding H, R3-corrected): **always-register, check the block at `execute`** via
  `findRepoRoot(ctx.cwd)` (the factory has no cwd) — refuse/inert if no block or malformed. Same as
  `delegate` Decision 2. **Tests** (Finding G): the pure right-sizer (cap/clamp/prune/parse) AND the pool
  scheduler in an offline-tested module like `verdict.ts`.

## Risks / unknowns
- **Disk exfil (R3-BLOCKER, now mitigated in-plan):** worker results are written to disk; redact at the
  source before `fs.writeFileSync` + `.gitignore memory/workflow/` (see Approach 4 + slice 3).
- **Cost / spawn exhaustion is the headline risk:** fan-out multiplies model spawns (workers on Opus
  `MODEL_DEFAULT`), and delegate's + workflow's caps don't bound their *sum* (~13 worst case, Decision 10).
  Mitigations stack: hard cap + **total-kept code-clamp** (step 2) + concurrency pool + right-sizer
  (quality + cost-control at *large* fan-out; the baseline clamp is the real floor — NIT-5) + opt-in block
  + per-tool per-request cap (reset on `agent_start`; a shared cross-tool budget is **deferred** — Decision
  10) + abort/shutdown ladder + confirm-on-spawn. Document the ~13 stacked worst case loudly.
- **The governor is a COST gate, not a safety gate (R3-MAJOR):** it does not filter unsafe task content
  and fails open; task-content safety rests on `"workflow"` in `guardedTools` (default off) + the
  per-worker read residual. Don't imply otherwise.
- **Right-sizer parse fragility:** a free-form judge reply is hard to parse into a clean task list. Keep
  the output contract strict (numbered `KEEP:`/`MERGE:` lines), parse leniently, fail OPEN to the cap.
- **Partial failure:** some workers fail/timeout. Recommend a partial index with per-task status +
  clearly-marked failures (vs. failing the whole call).
- **No synthesis by default:** raw N results may need a human or a synth pass to be useful; synth is
  opt-in to keep the minimal version minimal.
- **Namespace hygiene (R5-NIT, pre-existing) — DECIDED 2026-06-20: keep under `plan-*`.** These design
  docs match `listPlanSlugs`' `plan-*.md` glob, so `/verify`'s single-plan auto-select is off — but it
  already was (`plan-llmjudge.md` etc. exist), so moving only these two wouldn't restore it, and
  `memory/plan-<feature>.md` is the repo's established roadmap location (where pi `/plan` writes). Kept;
  no churn.

## Out of scope (for v1 / "minimal")
- A scripting/DAG engine (phases, pipelines, schemas, budgets) — that's the full cloud Workflow. This is
  one governed fan-out call, nothing more.
- Tool decomposing the objective itself (main agent supplies `tasks[]`).
- Multi-level / recursive workflows; write/edit/bash workers; cross-worker communication.
- Streaming live per-worker progress beyond a status line.

## Resolved defaults (implementation-ready — 2026-06-18)
All prior open questions are now LOCKED:
- **Right-sizer model:** `MODEL_REVIEW` per D7 (Decision 9).
- **Judge in v1:** `useJudge` default `true`, but fires only at `tasks.length ≥ judgeThreshold`
  (`2×maxParallel`) — R4 (Decision 1 / step 2).
- **Defaults:** `maxParallel` 5 (**hard ceiling 8 — the governor kill-switch**), `concurrency` 5 (clamped
  to `[1, maxParallel]`), `maxWorkflowsPerRequest` 2 (Decisions 5, 7, 8).
- **Aggregation:** files + compact index in v1; `synthesize` default `false`, opt-in flag (Decision 4).
- **Separate `workflow` tool** (Decision 6).
