I have everything I need. The patterns are clear: the 3-part wiring, `run_check`/`GIT_CHECKS` for read-only git context, `runSubagent` with the tool allowlist, `fileSig` fallback, `extractSummary`, `ctx.ui.setStatus`, and the `*.log` gitignore. Here is the design brief.

---

## /report sub-agent for the token-minimizing harness

> After an experiment or any notable change, compose a WELL-WRITTEN, audience-facing report document from the existing artifacts — `memory/monitor-<run>.md`, `memory/verdict.md`, the diff, `memory/tasks.md` — and write it to `memory/reports/<subject>-<date>.md`. The polished DOCUMENT is the deliverable; only a ≤10-line SUMMARY + the path cross back. A faithful sibling of `/plan` and `/verify`, but its contract inverts theirs: the prose is the product, not a verdict.

This is a buildable design that reuses the exact machinery in `harness/pi/subagents/index.ts`. No new spawn/summary/fallback plumbing.

---

### 1. Purpose & triggers

The "writer" role. The user's words: *"some skill sub-agent who always writes a document after an experiment or anything different, who can write reports pretty well."* `/report` is the writer; the **"always"** is automation, addressed below.

Triggers (invocation-driven): after `/monitor` finishes an experiment; after `/verify` returns; after a notable change lands (a feature merged, a benchmark moved, a decision reversed) — any time someone other than the doer needs to *read* what happened. Unlike `/verify` (adversarial, internal) and `/monitor` (a GREEN/RED machine verdict), `/report` is constructive and **audience-facing**: it explains, contextualizes, and leads with the result.

The **"always"** part is a separate `pi.on` hook (an extension), NOT this sub-agent — a tiny bridge that fires `/report <run> --for=team` when a `subagent-monitor` message lands. Designed below as a follow-up; the sub-agent stands alone and is invocation-driven so it's testable in isolation.

### 2. Invocation

```
/report <subject> [--for=team|paper|self] [sources...]
```

- `<subject>` — first token, slugified (reuse `slugify`, `index.ts:173`) → names the output file and seeds the title (e.g. `lmcache-throughput`).
- `--for=` — audience knob (default `team`). `team` = colleagues who know the project, lead with the result and next steps; `paper` = rigorous, neutral, method-and-limitations-forward; `self` = a terse lab-notebook entry for future-you. Parsed out of args before slugifying; controls register/length only, not structure.
- `[sources...]` — optional explicit artifact paths under `memory/` to compose from. If omitted, the parent **auto-discovers**: the newest `memory/monitor-*.md`, `memory/verdict.md`, `memory/tasks.md`, plus a fresh `git diff`/`git log` (computed by the parent, like `/verify` at `index.ts:565`). The agent reads more on demand with `read`/`grep`.

### 3. What crosses back vs stays on disk

This is the role's distinguishing decision. The **document** is long and audience-facing and lives entirely on disk at `memory/reports/<subject>-<date>.md`. Only a **≤10-line SUMMARY + the path** cross back into the main session — extracted by the existing `extractSummary(res.finalText, 10)` (`index.ts:353`). The SUMMARY is a *teaser/abstract* (headline result + where to read it), not the report; the parent never echoes the body. This keeps the main context cheap even as the document grows, the same "index in context, detail on disk" rule the harness lives by — but here the on-disk detail is the *point*, not a side effect.

### 4. Output file (compact example)

`memory/reports/<subject>-<date>.md`, authored by the sub-agent with its `write` tool. A real report structure:

```markdown
# LMCache throughput: 2.1× on the smoke config

**TL;DR.** Enabling the prefix cache raised decode throughput from 41→88 tok/s
(+115%) on smoke.yaml with no correctness regressions; p99 latency held at 240ms.
Recommend promoting to the default config (see Next steps).

## Context & goal
We were chasing decode throughput on the smoke benchmark; done-condition was
≥1.5× with the verifier passing (memory/tasks.md).

## What was done (method)
Ran `python bench/throughput.py --duration 600` via /monitor; compared against
the main baseline. Change under review: cache wiring in `engine/cache.py`
(git log: a1b2c3d).

## Results
- Throughput 41 → 88 tok/s, +115% (memory/runs/lmcache-throughput-20260613141005123-0.log:1184).
- p99 latency 238 → 240ms, flat (log:1190).
- Verifier: PASS WITH NITS (memory/verdict.md).

## Interpretation
The win is real and load-bearing on prefix reuse; it tracks cache hit-rate (0.73).

## Limitations & caveats
Single smoke config, one run; no cold-cache or multi-tenant numbers.

## Next steps
Promote to default config; add a cold-cache benchmark before claiming general 2×.
```

### 5. Wiring (3 parts — identical shape to `/plan`, `/verify`, `/monitor`)

**5a. `harness/prompts/report.md`** — the canonical methodology body (the writing instructions; full draft in §7). Stable, data-free, cache-friendly; prefixed with the `AGENTS.md` brief by `runSubagent` (`index.ts:250-252`) and appended via `--append-system-prompt`.

**5b. `.github/prompts/report.prompt.md`** — the Copilot wrapper, byte-for-byte the shape of `verify-change.prompt.md`: YAML front-matter (`description`, `mode: agent`) plus one paragraph linking to `harness/prompts/report.md`. Keeps both harnesses reading the *same* methodology so they never drift:

```markdown
---
description: Write an audience-facing report of an experiment or change, composing from memory/ artifacts
mode: agent
---
Follow the instructions in [harness/prompts/report.md](../../harness/prompts/report.md).
Inputs: a subject, an audience (--for=team|paper|self), and source artifacts
(memory/monitor-<run>.md, memory/runs/<run>.log, memory/verdict.md, memory/tasks.md, a git diff/log).
Lead with the result, quantify every claim, cite each number as `file:line`, and write the
full report to memory/reports/<subject>-<date>.md.
```

**5c. `pi.registerCommand('report', …)`** in `index.ts`, beside the others. Reuses: `findRepoRoot`, `readIfExists`, `slugify`, `computeDiff` (git **diff**, `index.ts:382`), `runSubagent`, `subagentFailed`, `fileSig`, `extractSummary`, and the `ctx.ui.setStatus` progress pattern — plus **ONE new helper, `computeGitLog()`** (⚠ verifier R7 #2: the live engine has no git-log helper; `computeDiff` does diff only — so add a sibling that runs `git log --oneline -N <base>..HEAD` with the same base resolution + `MAX_DIFF_BYTES` truncation). It: parses subject + `--for` + sources; auto-discovers the newest `memory/monitor-*.md` if no sources given; ensures `memory/reports/` exists; builds the first user turn (MEMORY.md index + each source's content + the diff/log + audience + a `handoffReport(...)` block, the twin of `handoffVerify` at `index.ts:91`); spawns via `runSubagent({ …, model: MODEL_DEFAULT })` (Opus 4.8, thinking xhigh — Phase 0.5); runs the `fileSig` write-fallback; extracts the SUMMARY; posts one `pi.sendMessage(..., { deliverAs: "nextTurn", details: { audience } })` and one `ctx.ui.notify` with the path.

### 6. Execution model & security

Tool allowlist: **`read,grep,find,ls,write`** — Planner-class. The writer composes; it does not run anything, so it needs no execution tool, no `edit`, no `bash`. **The parent computes the git diff (`computeDiff`, `index.ts:382`) AND the git log (the new `computeGitLog()` sibling helper)** deterministically and injects both into the user turn, exactly as `/verify` injects its diff — so the agent never needs even read-only `run_check`. (If the diff is huge, the parent truncates via the existing `MAX_DIFF_BYTES` path at `index.ts:402`.) `write` is present solely so the agent authors its **one** report file; `handoffReport` instructs that the only file it may write is `memory/reports/<subject>-<date>.md`.

Isolation is the proven core: a separate `pi` subprocess with `--no-session -nc --no-skills --no-prompt-templates --no-themes --no-extensions` (`index.ts:262-268`), so it can't re-enter `index.ts` or load ambient config. No `-e runner.ts` is loaded — there is no execution surface to gate. This is *more* locked-down than the Verifier, not less.

### 7. Methodology prompt sketch — draft `harness/prompts/report.md`

```markdown
# Prompt: Report (writer agent)

You are writing ONE report for a human reader who was not in the room. The DOCUMENT
is the deliverable — write it well. You are not grading the work; you are explaining
what happened so a reader can trust it and act on it. Lead with the result.

## Inputs (provided in your first turn; read more on demand)
- The subject and the AUDIENCE (`--for=team|paper|self`).
- The experiment report (`memory/monitor-<runId>.md`) and its **per-run** log (`memory/runs/<runId>.log` — the runId names BOTH, per monitor-design §6; never a per-experiment name).
- The verifier's verdict (`memory/verdict.md`), the goal + done-condition (`memory/tasks.md`),
  and a `git diff` / `git log` of what changed.
- Operator notes: the angle, what to emphasize, who's reading.

## How to write it
- **Lead with the result.** The first two sentences are the headline a busy reader keeps
  if they read nothing else. State the outcome and the number, then explain.
- **Quantify every claim.** "Faster" is not a result; "41→88 tok/s (+115%)" is. No adjective
  without a number behind it.
- **Cite your sources.** Every figure gets a `file:line` or `log:line` citation into the
  artifacts (e.g. `memory/runs/<runId>.log:1184`). If you can't cite it, don't claim it.
- **Be honest about caveats.** One run is not a trend; a smoke config is not production.
  State the limits plainly — a report that hides them is worth less, not more.
- **No fluff, no marketing.** Cut "successfully", "seamlessly", "robust", "significant"
  (unless it's a statistic). Strong nouns and verbs; short sentences; no hedging walls.
- **Tune to the audience.** `team`: lead with result + next steps, assume project context,
  ~1 screen. `paper`: neutral and rigorous, method + limitations forward, no first person.
  `self`: terse lab-notebook entry — what I did, what I saw, what's next.

## Structure — write to `memory/reports/<subject>-<date>.md`
Title (a real headline, not "Report") · TL;DR / headline result · Context & goal ·
What was done (method) · Results (quantified, each figure cited) · Interpretation ·
Limitations & caveats · Next steps. Drop a section only if it would be empty; never pad one.

## Output contract
After the file is written, your final message is a line exactly `## SUMMARY` followed by
AT MOST 10 lines: the one-line headline result, then the 2–4 facts a reader most needs,
then the report path. Nothing else after it. The harness surfaces only the SUMMARY; the
document is the product and lives on disk.

## Stance
Clear, specific, honest. Write the report you'd want to read about someone else's
experiment: it tells you the result in one breath, backs every number, and admits what
it doesn't know. Write ONLY the report file — you may not touch `memory/MEMORY.md` (the
handoff allows one file); if a durable lesson emerged, name it in your SUMMARY for the
operator to file from the main session.
```

### 8. Effort, deps, risks

**Effort: S–M.** Smaller than `/monitor` (no `runner.ts` changes, no new tool, no config schema). It's a fourth `registerCommand` block + two new markdown files + a `handoffReport` helper + a tiny "newest `memory/monitor-*.md`" discovery helper + `mkdir memory/reports/`. **Deps:** the existing `index.ts` helpers (all reused); ideally `/monitor` and `/verify` having run so artifacts exist (degrades gracefully if not — it reports from whatever sources it's given). Add `memory/reports/` to `.gitignore`? No — reports are durable artifacts meant to be kept. (Note: `memory/runs/*.log` is **already** covered by the existing `*.log` rule in `.gitignore:8`; `/monitor` additionally adds an explicit `memory/runs/` entry as defense-in-depth — that also covers any non-`.log` files written under it.)

Sharpest risks + mitigations:
1. **Hallucinated/uncited numbers** (the worst failure for a *writer* — fabricated results read as confident). Mitigation: the prompt's "if you can't cite it, don't claim it" rule + every figure requires a `file:line` citation into the real artifacts the parent injected; the agent has `read`/`grep` to verify against the log, not invent.
2. **Marketing fluff / no honest caveats** (the role's whole point is writing *quality*). Mitigation: explicit cut-list of banned words, a mandatory "Limitations & caveats" section, and the `--for=paper` register that forbids first person and front-loads limitations.
3. **Stale or wrong source auto-discovery** (newest `monitor-*.md` ≠ the run the operator means). Mitigation: explicit `[sources...]` override; the parent echoes the discovered source paths in its `ctx.ui.notify` so the operator sees what was composed from; subject slug ties the report to a named run.
4. **Report drifts longer than the SUMMARY budget / SUMMARY becomes the report.** Mitigation: the ≤10-line SUMMARY is enforced by the same `extractSummary(…, 10)` truncation the others use (`index.ts:353`); the contract explicitly frames SUMMARY as a teaser and the document as the product, so length lives in the file, not the channel.

### 9. Worked example

Invocation:
```
/report lmcache-throughput --for=team
```
The parent auto-discovers the newest `memory/monitor-lmcache-throughput-20260613141005123-0.md` + its paired `memory/runs/lmcache-throughput-20260613141005123-0.log` (same collision-resistant runId monitor-design §6.2 produces), reads `memory/verdict.md` and `memory/tasks.md`, computes `git diff main` (`computeDiff`) + `git log` (the new `computeGitLog()`), and spawns the writer with `tools: read,grep,find,ls,write` and `model: MODEL_DEFAULT` (Phase 0.5). The agent writes `memory/reports/lmcache-throughput-2026-06-13.md` (the §4 document) and returns:

```
## SUMMARY
Headline: LMCache prefix cache gives 2.1× decode throughput (41→88 tok/s) on smoke.yaml.
Latency flat: p99 238→240ms (log:1190). Verifier PASS WITH NITS.
Caveat: one run, smoke config only — no cold-cache/multi-tenant numbers yet.
Recommends promoting to default config; add a cold-cache benchmark first.
Full report -> memory/reports/lmcache-throughput-2026-06-13.md
```

The parent posts that SUMMARY + the path to the main session and `ctx.ui.notify("Report written: memory/reports/lmcache-throughput-2026-06-13.md", "info")`. The document — the actual deliverable — stays on disk for the team to read.

---

**Bridge note (the "always" automation, a separate follow-up):** a `pi.on('message', …)` hook that watches for a `subagent-monitor` message (`customType` from `/monitor`'s `pi.sendMessage`) and auto-fires `/report <experiment> --for=team` for it. That's an extension/hook concern (the harness reacts to events), distinct from this invocation-driven sub-agent — keep it out of the `/report` core and track it in `memory/tasks.md`.

**Files this design adds/touches:** New — `harness/prompts/report.md`, `.github/prompts/report.prompt.md`. Edit — `harness/pi/subagents/index.ts` (+`registerCommand('report')`, +`handoffReport`, +tiny newest-artifact discovery helper), `harness/pi/subagents/README.md` + `memory/MEMORY.md` (document `/report` and `memory/reports/`). New runtime dir — `memory/reports/` (kept, not gitignored). No `runner.ts`/`checks.json` changes.