# Elaborated sub-agent roles (besides /monitor)

> Scratch doc — /tmp/agent-system-plan/. One buildable brief per role, designed against the real harness code.



---

## /triage — failing-run / stacktrace classifier → ranked root-cause hypothesis + the single next probe

### 1. Purpose & triggers
One line: given a failing run's log/stderr, classify it into a ranked list of root-cause hypotheses and name the single cheapest next probe to confirm the top one — without preloading the tree or touching code.
You'd reach for this when:
- A pytest/CI run dumps a 2000-line traceback and you want the likely cause + the one test to rerun, not a full read of the repo.
- An experiment job died with `CUDA out of memory` / a flaky assertion and you need "is this my diff or the environment?" before spending a debugging session.
- A stderr blob references a symbol/file and you want it greped + git-blamed in isolation, returning only "hypothesis: stale fixture, probe: rerun test X".

### 2. Invocation
`/triage [<log-path>] [note...]`
- `<log-path>` — optional. If the first token resolves to an existing file under the repo, the parent reads it (capped) and injects it as the failing log. Otherwise the whole arg string is treated as `note`.
- `note...` — free text pasted by the operator: the stderr/traceback itself, or a hint ("only fails on CI", "started after the refactor"). The parent injects it verbatim.
At least one of {a readable log-path, a non-empty note} must be present, else `ctx.ui.notify` a usage string (mirrors `/plan`'s guard at index.ts:424).

### 3. What crosses back vs stays on disk
Parent builds the user turn from existing inputs only (no tree dump):
- `memory/MEMORY.md` index (`readIfExists(repo.memory)`, as verify does at index.ts:564).
- The failing log: either the capped contents of `<log-path>` (reuse the `MAX_DIFF_BYTES` truncation idiom from computeDiff, index.ts:402) or the operator `note`.
- The recent change context: parent runs nothing here — the subagent pulls `git-log`/`git-diff` on demand via run_check.
- The triage id (a `slugify`'d label from the first log line or note, or a short timestamp).

SUMMARY shape (≤10 lines, first token is the **top hypothesis label** — an uppercase tag from a small closed vocab so the operator can scan it):
```
## SUMMARY
ENV-OOM (confidence: high)
2nd: STALE-FIXTURE (low) · 3rd: FLAKY-ORDER (low)
Evidence: trace top frame in alloc.py:212; git-log shows no related change
Next probe: run_check test-file tests/test_alloc.py::test_big   (≈40s)
Triage -> memory/triage-oom-test-big.md
```
Only this crosses back (via `extractSummary(res.finalText, 10)`); the full reasoning, greps, and probe output stay in the file.

### 4. Output file
Path: `memory/triage-<id>.md`. Compact section structure:
```markdown
# Triage: <id>  (2026-06-13)

## Failure
<one-line classification of the error class + the load-bearing frame>

## Hypotheses (ranked)
1. ENV-OOM — high — top frame alloc.py:212; matches known OOM signature; git-log: no related change
2. STALE-FIXTURE — low — would explain X but fixture untouched (git-blame conftest.py:8 = 3wk old)
3. FLAKY-ORDER — low — only if test isolation broken; unverified

## Next probe (one)
run_check test-file tests/test_alloc.py::test_big  — expect OOM to reproduce in isolation → confirms #1; if it PASSES, promote #3.

## Ruled out
- DIFF-REGRESSION — git-diff touches only docs/
```

### 5. Wiring (3 parts)
**(a) `harness/prompts/triage.md`** — methodology body (sketch in §7), appended to the AGENTS.md brief by `runSubagent` (index.ts:250-252).

**(b) `.github/prompts/triage.prompt.md`** — mirrors verify-change.prompt.md exactly:
```
---
description: Classify a failing run into ranked root-cause hypotheses + the single next probe
mode: agent
---
Follow the instructions in [harness/prompts/triage.md](../../harness/prompts/triage.md).

Inputs: the failing log/stderr (or its path) and `memory/MEMORY.md`. Output a ranked hypothesis list (top label first) and ONE next probe to run. Grep on demand; do not dump the tree.
```

**(c) `registerCommand("triage", …)`** — clones the `/verify` handler (index.ts:521) almost verbatim:
- `findRepoRoot(ctx.cwd)` → guard. Add `triagePrompt: path.join(dir,"harness","prompts","triage.md")` to `RepoPaths` (alongside verifyPrompt, index.ts:151).
- Arg parsing: split `args.trim()`; if `tokens[0]` resolves via `path.resolve(repo.root, tokens[0])` to an existing file inside repo.root, read+cap it as the log and `slug = slugify(<id-from-log-or-token>)`; else log is empty and the full string is `note`. Reuse `slugify` (index.ts:173) for `<id>`, falling back to a `Date`-based stamp.
- `triagePath = path.join(repo.memoryDir, ´triage-${slug}.md´)`.
- Build `userTurn`, then `runSubagent({ promptBodyPath: repo.triagePrompt, tools:"read,grep,find,ls,run_check,write", runnerPath: RUNNER_PATH, model: MODEL_DEFAULT, … })` — needs the runner because of the probe checks (§6); `model: MODEL_DEFAULT` (Opus 4.8, thinking xhigh) per Phase 0.5.
- Reuses `fileSig` (write-fallback to `triagePath`), `subagentFailed`, `extractSummary`, `pi.sendMessage({customType:"subagent-triage", details:{hypothesis: firstToken}}, {deliverAs:"nextTurn"})`, and `ctx.ui.setStatus`/`notify`. A new `handoffTriage(triagePath, probeChecks)` clones `handoffVerify` (index.ts:91): "you NEVER touch source code", "write exactly this one file", "final line `## SUMMARY` whose FIRST token is the top hypothesis label".

### 6. Execution model & security
`--tools read,grep,find,ls,run_check,write` — identical to the Verifier. It **needs the runner** for read-only probes. No general shell ever; every probe is a fixed argv with `shell:false`.

It already gets the universal `GIT_CHECKS` (git-diff, git-diff-stat, git-status, git-log — runner.ts:35) and `test-file` (validated by `validateTestPath`, runner.ts:142) for free. Add to runner.ts as a new `READONLY_PROBES` group, each a fixed argv, mirroring `gitCheckSpec` (runner.ts:125):
- `git-blame` — only check taking free text. New `validateBlamePath(repoRoot, p)` cloned from `validateTestPath`: reject empty/`..`, require match against a config `blamePathRegex` (default `^[A-Za-z0-9_./\-]+$`), `path.resolve` must stay under repoRoot. Argv: `["git","blame","-L","1,40","--",rel]` (line-capped so output stays bounded). Refuse otherwise.
- `git-log-file` — argv `["git","log","--oneline","-10","--",rel]`, same validated path.
- `env-dump` — no free text; a fixed *allowlisted-prefix* dump, **not** raw `env`. Argv `["printenv"]` is too broad, so instead read-and-filter in TS: collect `process.env` keys matching a fixed prefix set (`PYTHON*`, `CUDA*`, `VIRTUAL_ENV`, `PATH`, `LANG`) and return them as text — no subprocess at all, so nothing to escape.

checks.json gains optional `blamePathRegex` and an optional `probes` on/off (default: git-blame/git-log-file/env-dump available in any git repo, like GIT_CHECKS). The `run_check` schema's `StringEnum` (runner.ts:272) auto-extends via `allCheckNames`. `MAX_OUTPUT_BYTES` (runner.ts:32) already caps every probe. No external deps (no gh, no web): triage is local-only, which keeps it sandbox-trivial.

### 7. Methodology prompt sketch — `harness/prompts/triage.md`
```markdown
# Prompt: Triage (failing-run classifier)

You are triaging ONE failing run. You are a diagnostician, not a fixer: you produce ranked
hypotheses and the single cheapest probe to confirm the top one. You did not write this code.
Do not edit anything. Do not dump the repo — read only the frames the failure points at.

## Inputs
- The failing log / stderr (or its path), provided in the user turn.
- `memory/MEMORY.md` (state + known gotchas). Check it: this failure may already be a known issue.

## How to triage
1. Find the load-bearing frame — the deepest frame in *this* repo's code, not library internals.
   `read`/`grep` exactly that file:line; do not read more than the trace demands.
2. Form 2–4 hypotheses, each a labeled class: DIFF-REGRESSION, ENV-OOM, FLAKY-ORDER,
   STALE-FIXTURE, DEP-VERSION, CONFIG, DATA, UPSTREAM. Rank by likelihood given the evidence.
3. Use run_check to gather evidence cheaply, never to "try fixes": `git-log`/`git-diff` (did my
   change touch this path?), `git-blame <file>` (how old is the suspect line?), `env-dump`
   (versions/paths for ENV/DEP classes). Each probe must change a hypothesis's rank or be skipped.
4. Pick ONE next probe to run next (usually `test-file` rerunning the single failing test, or a
   git-blame) — the one whose result most cleanly separates your top two hypotheses.

## Verdict
Top hypothesis = a single uppercase label + confidence (high/med/low). Confidence is high only if a
probe or the trace directly supports it; otherwise med/low. Always name what would falsify #1.

## Output — write to memory/triage-<id>.md
Failure (one line) · Hypotheses (ranked, each: label — confidence — evidence with file:line) ·
Next probe (one, with the exact run_check invocation + what each outcome would prove) · Ruled out.

## Stance
Decisive but honest about uncertainty. One confident wrong hypothesis costs more than three ranked
maybes. Never speculate past the evidence; if the trace is ambiguous, say so and let the probe decide.
```

### 8. Effort, dependencies, risks
**Effort: S** — the command clones `/verify` wiring near-verbatim; only new code is `handoffTriage`, the log-path arg parsing, and three runner probes. Depends on: existing `subagents/index.ts` + `runner.ts`; one new `RepoPaths` field; optional checks.json keys. No new npm/external deps.

Risks (each with its mitigation):
- **Shell-injection via git-blame's free-text path** — the only attack surface. Mitigation: `validateBlamePath` clones `validateTestPath` (regex + `..` reject + under-repoRoot resolve) and argv uses `--` to terminate options; `shell:false` makes chaining structurally impossible.
- **Huge log blows the context budget** — a 50k-line traceback. Mitigation: parent caps the injected log at `MAX_DIFF_BYTES` with the same truncation note as computeDiff (index.ts:402); the subagent is told to read only the load-bearing frame.
- **env-dump leaking secrets back to the main session** — env often holds tokens. Mitigation: env-dump is not a subprocess; it returns only a fixed allowlisted key-prefix set (no `*KEY*`/`*TOKEN*`/`*SECRET*`), and only the ≤10-line SUMMARY crosses back anyway.
- **Probe-creep into "just fix it"** — model tempted to rerun-and-patch. Mitigation: no `edit` tool present (structural), handoff says "report, don't fix", and every probe is read-only by construction; the prompt requires each probe to *change a rank* or be skipped.

### 9. Worked example
Invocation:
`/triage logs/run_4412.txt only started failing today`

SUMMARY the operator sees come back:
```
Verifier-style triage (4 turns):

## SUMMARY
DIFF-REGRESSION (confidence: high)
2nd: STALE-FIXTURE (low) · ruled out ENV-OOM (no alloc frames)
Evidence: top repo frame loader.py:88 (KeyError 'shape'); git-blame -> changed today by HEAD; git-log HEAD..main touches loader.py
Next probe: run_check test-file tests/test_loader.py::test_shape  (≈12s) — if it FAILS, #1 confirmed; if PASS, the fixture in conftest is stale (promote #2)

Triage -> memory/triage-run-4412.md
```


---

## /research — web-search research agent → a cited, claim-checked note

### 1. Purpose & triggers
One adversarial, web-backed research pass on a single open question; raw page text stays in the subprocess, only a cited note lands on disk and a ≤10-line brief crosses back.
- "Should we use `zod` or `valibot` for runtime validation?" → a cited tradeoff note with verified bundle-size/maintenance claims.
- "Does Postgres `SELECT ... FOR UPDATE SKIP LOCKED` block concurrent workers?" → an API-behavior note citing the official docs, marking what's verified vs inferred.
- "Prior art for token-minimizing subagent harnesses?" → a survey note with source links and a confidence flag per claim.

### 2. Invocation
`/research <topic> <question...>`
- `<topic>` — first whitespace token; `slugify()`'d to scope the output file `memory/research-<topic>.md`.
- `<question...>` — the rest: the actual open question, verbatim, as the research target. Both required (mirror `/plan`'s guard at index.ts:424).

### 3. What crosses back vs stays on disk
Parent builds the user turn from `memory/MEMORY.md` (index only) + the question + the handoff. It injects **no** diff and **no** plan — this role reads the web, not the repo state. Detail (search hits, fetched pages, per-claim reasoning) stays inside the subprocess and is distilled into the output file; only the SUMMARY returns.

SUMMARY shape (first token is a confidence verdict `CONFIDENT` / `MIXED` / `INCONCLUSIVE`):
```
## SUMMARY
CONFIDENT — valibot if bundle size dominates; zod if ecosystem matters.
- valibot ~1.4kb vs zod ~13kb gzipped [verified: 2 sources]
- zod has far wider adapter ecosystem [verified]
- valibot v1 stable since 2024 [uncertain: single source]
Full note + citations -> memory/research-validation-lib.md
```

### 4. Output file
`memory/research-<topic>.md`:
```markdown
# Research: <question>
**Verdict:** MIXED — <one line>

## Findings
- <claim> [VERIFIED — refs [1][2]]
- <claim> [UNCERTAIN — single source, ref [3]]
- <claim> [DISPUTED — [2] vs [4]]

## Open questions
- <what couldn't be settled and why>

## Sources
[1] <title> — <url> (accessed 2026-06-13)
[2] ...
```
Every claim carries an inline `[VERIFIED|UNCERTAIN|DISPUTED — ref]` tag; every ref resolves in `## Sources`.

### 5. Wiring (3 parts)
- **`harness/prompts/research.md`** — methodology body (sketch in §7), appended to `AGENTS.md` by `runSubagent` (index.ts:250-252).
- **`.github/prompts/research.prompt.md`** — IDE entry, same front-matter shape as `verify-change.prompt.md`:
  ```markdown
  ---
  description: Web-research one open question into a cited, claim-checked note in memory/research-<topic>.md
  mode: agent
  ---
  Follow the instructions in [harness/prompts/research.md](../../harness/prompts/research.md).
  Research the question I describe. Cite every claim; mark VERIFIED vs UNCERTAIN; write the note to `memory/research-<topic>.md` and end with a ≤10-line SUMMARY.
  ```
- **`registerCommand("research", …)`** — clone `/plan`'s handler. Parse `<topic> <question>` via `raw.search(/\s/)` exactly as index.ts:420-423; guard with `ctx.ui.notify('Usage: /research <topic> <question>')`. `findRepoRoot(ctx.cwd)`; compute `researchPath = path.join(repo.memoryDir, \`research-${slug}.md\`)`. Build the user turn (MEMORY.md + question + a new `handoffResearch(researchPath)`). `fileSig(researchPath)` before; `runSubagent({ tools: "read,grep,find,ls,write,web_search,fetch_content", runnerPath: <pi-web-access -e source>, model: MODEL_DEFAULT })` (Opus 4.8, thinking xhigh, Phase 0.5) — **⚠ CORRECTION (plan verification): a `runnerPath`/`-e` IS required** (see IMPLEMENTATION-PLAN.md §1c). Sub-agents spawn `--no-extensions`, so an installed `pi-web-access` does NOT auto-load; the web tools resolve only when loaded via `-e`. Live-test that `web_search` resolves; fallback = a `research-runner.ts` exposing `web_search`/`fetch_content` (same names as pi-web-access, so the `--tools` allowlist + prompt are identical either way). On `subagentFailed` → notify + `pi.sendMessage` (index.ts:479-491 pattern). Else write-fallback if `fileSig` unchanged, `extractSummary(res.finalText, 10)`, first-token verdict via regex like index.ts:624, `pi.sendMessage(deliverAs:"nextTurn")`. Reuses: `findRepoRoot`, `runSubagent`, `extractSummary`, `fileSig`, `subagentFailed`, `slugify`. No `.active-plan` pointer (each topic is self-contained).

### 6. Execution model & security
`--tools read,grep,find,ls,write,web_search,fetch_content`.
**⚠ CORRECTION (plan verification):** it uses no `run_check` (no repo-executable access), BUT it MUST load a web-tool extension via `-e` (`runnerPath`). Sub-agents spawn `--no-extensions`, so an ambient `pi-web-access` is invisible to the subprocess — tools enter a sub-agent ONLY via `-e`. Load `pi-web-access` (resolve its installed path / `npm:pi-web-access`) **or** a thin `research-runner.ts` via `runnerPath`; `web_search`/`fetch_content` resolve only then. The original "no runnerPath, installed package suffices" framing was the verified blocker. Operator still runs `pi install npm:pi-web-access` once to have it on disk. **Justification for depending on it vs building our own:** a hand-rolled fetch tool inside `runner.ts` would need an HTTP egress path — and `runFixed`'s whole safety argument is *fixed argv, no network reasoning*; bolting a URL-fetcher on reintroduces exactly the open-ended input (arbitrary URLs, SSRF to `169.254.169.254`/`localhost`) that the closed allowlist exists to forbid. The off-the-shelf tool is a maintained, sandboxed boundary; we keep our runner pristinely shell-and-network-free. Trade-off accepted: an external dependency the operator installs, gated by the `--tools` allowlist (if `pi-web-access` isn't installed, those tool names simply don't resolve and the subagent degrades to repo-only — handler should `notify` a hint). No `gh`, no general shell, no `edit`.

### 7. Methodology prompt sketch (`harness/prompts/research.md`)
```markdown
# Prompt: Research (web research agent)

You are answering ONE open question from the web. Be adversarial about sources: a confident page is not a fact. You are not summarizing the first result — you are cross-checking until a claim earns a verdict. You touch the WEB, never the repo's code or executables.

## Inputs
- The question (from the operator's turn). The `memory/MEMORY.md` index for repo context only — do not re-scan the repo.
- `web_search` to find sources; `fetch_content` to read them. That is your only reach outside this dir.

## How to
- **Decompose** the question into 2–4 sub-claims you must settle. Search each; don't stop at one hit.
- **Corroborate** — a claim is VERIFIED only with ≥2 independent, primary-leaning sources (official docs/repo > blog > forum). One source = UNCERTAIN. Sources that conflict = DISPUTED; name both.
- **Distrust** marketing pages, undated posts, and content that merely restates another source. Prefer the primary (the API doc, the changelog, the maintainer).
- **Date everything** — APIs and library facts rot. Record access date; flag claims that may be stale.
- Fetch the page before you cite it. Never cite a URL you only saw in a search snippet.

## Verdict
- **CONFIDENT** — the core question is answered by corroborated claims.
- **MIXED** — answered, but key claims rest on single/weak sources (flag them).
- **INCONCLUSIVE** — sources insufficient or contradictory; say what's missing.

## Output — write to `memory/research-<topic>.md`
Verdict line, then `## Findings` (each claim tagged `[VERIFIED|UNCERTAIN|DISPUTED — ref]`), `## Open questions`, and a numbered `## Sources` (title — url — accessed date). Every inline ref must resolve in Sources.

## Stance
Cite or don't claim. Better three corroborated findings than thirty scraped ones. When the web won't settle it, say INCONCLUSIVE — do not manufacture confidence.
```

### 8. Effort, dependencies, risks
**Effort: M.** ~1 new handler (cloned from `/plan`), 2 prompt files, no `runner.ts`/`checks.json` change. **Dependency:** `pi-web-access` (operator-installed); `slugify`/`runSubagent`/`extractSummary`/`fileSig`/`subagentFailed` reused as-is.
- **Web tools absent** (package not installed) → subagent silently degrades to opinion. *Mitigation:* handler probes once and `notify`s "run `pi install npm:pi-web-access`"; prompt instructs INCONCLUSIVE if it can't search.
- **Fabricated/uncorroborated citations** (LLM confabulates URLs) → *Mitigation:* "fetch before cite" rule + ≥2-source VERIFIED bar; refs must resolve in `## Sources`.
- **Unbounded fetching** burns the subprocess budget → *Mitigation:* prompt caps at 2–4 sub-claims; raw pages never cross back, so blast radius is one subprocess.
- **SSRF / internal egress** via a fetch tool → *Mitigation:* we deliberately don't build the fetcher; the off-the-shelf tool owns egress, our runner stays network-free.

### 9. Worked example
Invocation: `/research validation-lib should we adopt zod or valibot for runtime input validation in a bundle-size-sensitive client?`

SUMMARY the operator sees:
```
Research summary (topic: validation-lib, 9 turns):

## SUMMARY
MIXED — valibot for the size-sensitive client; keep zod where the ecosystem is in use.
- valibot ~1.4kb vs zod ~13kb gzipped, tree-shakeable [VERIFIED — [1][2]]
- zod's adapter ecosystem (tRPC, RHF) is far broader [VERIFIED — [1][3]]
- valibot API stable since v1 (2024) [UNCERTAIN — single source [4]]
- migration cost: schemas are not drop-in compatible [VERIFIED — [2]]
Open: no independent runtime-perf benchmark found.

Full note + citations -> memory/research-validation-lib.md
```


---

## /distill — periodic memory-hygiene sub-agent

### 1. Purpose & triggers
Keep "index in context, detail on disk" literally true: prune `memory/MEMORY.md` back under its line budget, relocate (never delete) durable detail into topic files, and fix dangling pointers — so every other agent's first read stays cheap. Runs periodically, not per-task.
- "MEMORY.md has crept to 120 lines; Recent-changes has 20 entries and three Gotchas are really decisions" → `/distill`.
- "We renamed `memory/plan-auth.md` and now an index pointer 404s" → `/distill` audits and repairs links.
- "`memory/architecture.md` ballooned into a 600-line novel" → `/distill` proposes a split and reports it for you to confirm.

### 2. Invocation
`/distill [note]`
- `note` (optional, free text) — a hint to bias the pass, e.g. `/distill focus on Gotchas` or `/distill the architecture file is too big`. No feature arg; this role is repo-global, like `/verify` minus the feature resolution.

### 3. What crosses back vs stays on disk
Parent builds the user turn by injecting the **whole `memory/` index surface** the role curates: full `MEMORY.md`, plus a *manifest* of `memory/` (filenames + line counts + first heading, computed by the parent via `fs`/`readdirSync` — not the file bodies) so the agent knows what topic files exist without preloading them. Topic-file bodies are read **on demand** inside the subprocess. Only the SUMMARY returns.

SUMMARY shape (≤10 lines), first token is a verdict:
```
## SUMMARY
CLEAN | TRIMMED | SPLIT      <- first token
MEMORY.md: 118 -> 54 lines
Moved 3 Gotchas -> memory/decisions.md; pruned 11 stale Recent-changes
SPLIT proposed: memory/architecture.md (612 ln) -> +memory/architecture-ingest.md  [CONFIRM]
Fixed 2 dangling pointers (plan-auth.md, verdict.md)
```
`TRIMMED` = edited in place; `SPLIT` = it created a new topic file that the operator should confirm; `CLEAN` = nothing needed.

### 4. Output file
The ONE contract file it authors is **`memory/MEMORY.md`** (same "writes exactly one memory file" rule as `/plan`→tasks.md, `/verify`→verdict.md). Splits write *additional* topic files, but those are reported, not the contract output. Compact target structure (must stay < 60 lines, matching the file's own banner comment at MEMORY.md:2):
```
# Memory — live index
## Current focus
<1–2 lines, preserved verbatim unless clearly superseded>
## Recent changes (newest first — keep ~7 max)
- 2026-06-13 — <kept the 7 freshest; older rolled into decisions.md or dropped>
## Gotchas / rules learned
- <durable only; speculative/one-off removed>
## Index — where detail lives
- Architecture → `memory/architecture.md`  (+ `architecture-ingest.md` if split)
- Why behind decisions → `memory/decisions.md`
...
```

### 5. Wiring (3 parts)
**a. `harness/prompts/distill.md`** — methodology body (sketch in §7), appended to the AGENTS.md brief by `runSubagent` (index.ts:250-252).

**b. `.github/prompts/distill.prompt.md`** — mirror of `verify-change.prompt.md`:
```
---
description: Periodic memory hygiene — prune memory/MEMORY.md, split overgrown topic files, fix dangling pointers
mode: agent
---
Follow the instructions in [harness/prompts/distill.md](../../harness/prompts/distill.md).
Be conservative: never DROP a Gotcha or decision — relocate it to a topic file. Keep MEMORY.md under 60 lines and all [[links]]/pointers valid. End with `## SUMMARY` whose first token is CLEAN / TRIMMED / SPLIT.
```

**c. `registerCommand("distill", …)`** in `index.ts`, modeled on the `/verify` handler but simpler (no diff, no plan resolution):
- Reuse **`findRepoRoot(ctx.cwd)`** for repo paths; bail with `ctx.ui.notify` if not in the harness.
- Build a `memory/` manifest by reading `repo.memoryDir` with `fs.readdirSync` + per-file line count/first heading (parent-side, cheap). Add a `memoryManifest` field; no new `RepoPaths` member strictly needed — derive inline.
- `note = args.trim()`; no `slugify` (no feature). Inject `MEMORY.md` body + manifest + optional note into the user turn, plus a `handoffDistill(repo.memory, manifestPaths)` block (same shape as `handoffVerify`).
- `sigBefore = fileSig(repo.memory)`; call **`runSubagent`** with `tools: "read,grep,find,ls,write"`, **no `runnerPath`**.
- On return: `subagentFailed(res)` guard → notify + `pi.sendMessage` failure (copy the `/verify` branch). Else the write-fallback: if `fileSig(repo.memory) === sigBefore`, persist `res.finalText` into `repo.memory` (exactly the index.ts:619-622 pattern). Extract verdict from `extractSummary(res.finalText, 10)`: `first = summary.split("\n")[0]`; `verdict = /\bSPLIT\b/i.test(first) ? "SPLIT" : /\bTRIMMED\b/i.test(first) ? "TRIMMED" : "CLEAN"`. **`pi.sendMessage`** with `customType: "subagent-distill"`, `deliverAs: "nextTurn"`, `details: { verdict }`; `ctx.ui.notify` warning if `SPLIT` (operator must confirm new files) else info.

### 6. Execution model & security
- `--tools read,grep,find,ls,write` — **Planner-class**, identical to `/plan` (index.ts:470). It only reads/searches `memory/` and rewrites Markdown.
- **No runner, no `-e RUNNER_PATH`, no `run_check`, no web.** There is nothing to execute: hygiene is pure file I/O. So **no new checks in `runner.ts` and no `checks.json` changes** — the role adds zero new execution surface, which is the safest possible extension of the scheme.
- Isolation inherited from `runSubagent`: separate `pi` subprocess, `--no-extensions/-nc/--no-skills/--no-prompt-templates`, torn down on exit (index.ts:258-268). `write` lets it author `MEMORY.md` and split files; absence of `edit`/shell is structural.
- One residual risk vs `/plan`: `write` can create *any* path. Mitigation is prompt-enforced ("only write under `memory/`") plus a **parent-side post-check**: after the run, diff `fs.readdirSync(repo.memoryDir)` against a pre-run snapshot; if a new file landed outside `memory/` (shouldn't be possible since cwd-relative writes target the repo, but defense in depth), surface it loudly in the notify and don't claim success. No external dependency to sandbox.

### 7. Methodology prompt sketch — `harness/prompts/distill.md`
```markdown
# Prompt: Distill (memory-hygiene agent)

You are doing periodic upkeep on this repo's memory so the next agent's first read stays cheap. You did **not** write these notes. Your job is to SHRINK the index and RELOCATE detail — never to invent state or quietly delete knowledge.

## Inputs
- The full `memory/MEMORY.md` (the only file loaded by default; budget < 60 lines).
- A manifest of `memory/` (filenames, line counts, first heading). Open a topic file with read/grep ONLY when you need to move something into it or verify a pointer — do not dump them.

## How to (in order)
1. **Verify pointers first.** Every `[[link]]` / `memory/<file>.md` reference in the index must resolve (use `ls`/`find`). Repair or remove dead ones; note each.
2. **Prune the rolling log.** `Recent changes`: keep ~7 freshest; older entries are dropped only if their lesson is already captured elsewhere, else move the lesson down into `decisions.md`.
3. **Triage Gotchas/decisions CONSERVATIVELY.** A Gotcha or decision is durable by default. If it's stale or oversized for the index, **MOVE it into the right topic file** (`decisions.md` for "why", `architecture.md` for "where") — never delete it. When unsure, keep it.
4. **Split overgrown topic files** (> ~300 lines or two unrelated subjects): create ONE new `memory/<topic>-<slice>.md`, move the cohesive section, and update the index pointer. Splitting is the only time you author a second file.
5. **Rewrite the index** under 60 lines, preserving `Current focus` verbatim unless clearly superseded.

## Verdict (first token of SUMMARY)
- **CLEAN** — already healthy; no edits beyond trivial.
- **TRIMMED** — pruned/relocated in place; no new files.
- **SPLIT** — you created a new topic file; the operator must confirm it.

## Output
Write the rewritten index to `memory/MEMORY.md` (and any split file). End with `## SUMMARY`: verdict token, before→after line count, what moved where, any split [CONFIRM], pointers fixed. ≤10 lines.

## Stance
Conservative and reversible. When torn between dropping and moving, move. The index should read as *current state + pointers*, nothing an agent could instead look up on disk. Better to relocate ten facts than to lose one.
```

### 8. Effort, dependencies, risks
**Effort: S** — one `registerCommand` cloned from `/verify` minus diff/plan logic, one prompt, one `.prompt.md`. No `runner.ts`/`checks.json` work. **Deps:** existing `findRepoRoot`, `runSubagent`, `extractSummary`, `fileSig`, `subagentFailed`, `pi.sendMessage`, `ctx.ui` — nothing new.
- **Lossy pruning** (drops a real Gotcha) → prompt rule "move, never delete; durable by default"; verdict `TRIMMED`/`SPLIT` names what moved so the operator can audit one summary line.
- **Dangling pointers after a split** → step 1 verifies pointers *before* editing and the agent must update the index pointer in the same write; manifest gives it the live file list.
- **Hallucinated `Current focus`/state** → "preserve `Current focus` verbatim unless clearly superseded"; the agent is a janitor, not a planner — it has no diff or task to invent from.
- **`write` to an unintended path** → prompt restricts writes to `memory/`; parent snapshots `readdirSync(memoryDir)` pre/post and flags any out-of-tree creation instead of reporting success.

### 9. Worked example
Invocation: `/distill MEMORY.md is huge and architecture.md feels bloated`

SUMMARY the operator sees (via `subagent-distill` message + `ctx.ui.notify`):
```
## SUMMARY
SPLIT
MEMORY.md: 124 -> 52 lines (under 60 budget)
Pruned 13 stale Recent-changes entries (kept 7 freshest)
Moved 4 Gotchas -> memory/decisions.md (durable, not dropped)
SPLIT: memory/architecture.md (588 ln) -> +memory/architecture-ingest.md (241 ln)  [CONFIRM]
Index pointer added for architecture-ingest.md; fixed dead link to plan-auth.md
No content deleted; all relocations are reversible
```
Notify: `Distill: SPLIT — review memory/architecture-ingest.md` (warning). Full rewritten index is on disk at `memory/MEMORY.md`; only these lines crossed back.


---

## /repro — minimal deterministic reproduction builder

Reduces a failing scenario to the smallest deterministic recipe (minimal input, seed, single command) and records it so the fix and its test write themselves. Confirms what `/triage` hypothesized; the shrink loop's churn stays in the subprocess.

### 1. Purpose & triggers
Turn "it fails sometimes" into "this exact case fails every time, here's the assertion." Reach for it when:
- `/triage` named a suspect path but you need a one-line repro before fixing (e.g. "concurrent cache writes corrupt the index — find the smallest case").
- A flaky/large failing test needs shrinking to a deterministic minimal target before anyone writes the regression test.
- A bug report has a huge input/long sequence and you need the minimal trigger + seed.

### 2. Invocation
```
/repro <id> <failing-scenario description>
```
- `<id>` — first whitespace token; slug for the output file `memory/repro-<id>.md` (scopes/overwrites that bug's recipe). Reuse `/triage`'s id to pair them.
- `<scenario>` — the rest: what fails, observed symptom, and any starting test target/seed/input to shrink from.

### 3. What crosses back vs stays on disk
Parent injects the same index-first user turn as `/verify`: `memory/MEMORY.md` (index), plus `memory/triage-<id>.md` if it exists (the hypothesis to confirm), `memory/tasks.md` (active slice), and the operator scenario. The shrink loop — every candidate run through `run_check`, all stdout — stays inside the subprocess and only its conclusions land in `memory/repro-<id>.md`. The `## SUMMARY` (≤10 lines), first token a verdict: **REPRODUCED** / **NOT-REPRODUCED** / **FLAKY** (reproduces <100% over N runs), then: the minimal command, the failing assertion (`file:line: message`), seed/env, and where the fix should go.

### 4. Output file
`memory/repro-<id>.md`:
```markdown
# Repro: <id> — <one-line symptom>
Verdict: REPRODUCED (12/12 runs, seed=1337)
## Minimal recipe
- Check: test-file  path: tests/cache/test_index.py::test_concurrent_write
- Seed/env: PYTHONHASHSEED=0, PYTEST_SEED=1337
- Minimal input: 2 writers, 1 key (was 50 writers / 4k keys)
## Failing assertion
tests/cache/test_index.py:88: assert index.get(k) == v  -> KeyError
## Shrink log (what was removed without losing the failure)
- dropped 48 writers, 3999 keys, the sleep(), the network mock — still fails
## Likely fix site
src/cache/index.py:140 (lost update under lock release)
```

### 5. Wiring (3 parts)
- **`harness/prompts/repro.md`** — methodology (sketch in §7).
- **`.github/prompts/repro.prompt.md`** — mirrors `verify-change.prompt.md`:
```markdown
---
description: Shrink a failing scenario to a minimal deterministic reproduction in memory/repro-<id>.md
mode: agent
---
Follow the instructions in [harness/prompts/repro.md](../../harness/prompts/repro.md).

Inputs: the scenario I describe, the triage hypothesis (if any), and the test target to shrink. Re-run candidates ONLY through allowlisted checks (run_check). End with a verdict: REPRODUCED / NOT-REPRODUCED / FLAKY, the minimal recipe, and the failing assertion as `file:line`.
```
- **`registerCommand("repro", …)`** in `index.ts`, modeled on `/verify` (index.ts:521). Arg parsing splits like `/plan` (index.ts:420-423): first token → `id`, rest → scenario; `slugify(id)` (index.ts:173); reject empty via `ctx.ui.notify` usage. Resolve `findRepoRoot` (index.ts:136); read `memory/triage-${slug}.md` with `readIfExists`. Add `reproFilePath(repo, slug)` = `memory/repro-${slug}.md` (mirrors `planFilePath`, index.ts:182). Call `runSubagent` with `tools:"read,grep,find,ls,run_check,write"` and `runnerPath:RUNNER_PATH`. Reuse `fileSig` write-fallback (index.ts:619-622), `extractSummary(res.finalText, 10)`, `subagentFailed`, `ctx.ui.setStatus` progress, and the verdict-token surfacing (index.ts:624) extended to the three tokens above.

### 6. Execution model & security
Isolated `pi` subprocess, `--tools read,grep,find,ls,run_check,write` — identical surface to the Verifier (index.ts:593): no `edit`, no shell, writes exactly one file. It **needs the runner** (`-e RUNNER_PATH`) because shrinking re-runs candidates. **No new tool is needed**: re-running goes through the existing path-validated `test-file` check (runner.ts:291-309, `validateTestPath` at runner.ts:142). The agent shrinks by editing the *test target/node id it passes* (e.g. parametrized case `tests/cache/test_index.py::test_x[2-1]`), which is already covered by the `pathRegex` + `rootDir` + no-`..` validation — no arbitrary command, no shell (`shell:false`, fixed argv, runner.ts:205-210).

One config addition (no engine change) lets the recipe pin a seed deterministically: a fixed `repro` check in `checks.json` whose argv hard-codes the seed flag, e.g.
```json
"repro": { "cmd": "pytest", "args": ["-x","-q","-p","no:randomly","--seed=1337"], "timeoutMs": 600000 }
```
Seed/env are otherwise asserted by re-running `test-file` N times and reporting the hit rate; the agent never composes env inline (that would need a shell). No external deps (no `gh`/web).

### 7. Methodology prompt sketch — `harness/prompts/repro.md`
```markdown
# Prompt: Repro (minimal-reproduction agent)

You are turning a vague failure into one deterministic, minimal command. Be adversarial about determinism: a repro you can't reproduce is not a repro. You confirm — you do not fix.

## Inputs
- The failing scenario from the operator, and the triage hypothesis in `memory/triage-<id>.md` if present.
- The starting test target / seed / input to shrink from.

## How to repro and shrink
- **Confirm first.** Run the candidate via `run_check` (test-file or the seeded `repro` check). If it doesn't fail at all, stop: verdict NOT-REPRODUCED, say what you tried.
- **Pin determinism.** Fix the seed/env and re-run N times (default 5). If it fails <100%, verdict FLAKY; record the hit rate and the likely source of nondeterminism.
- **Shrink, don't sprawl.** One change per candidate: remove an input element, a step, a fixture, or narrow to one parametrized node id. Keep a change ONLY if the failure survives. Re-run through `run_check` every time. NEVER invent a command — only allowlisted checks; there is no shell.
- **Bound the loop.** Hard caps: ≤12 candidate runs and ≤8 minutes total. When the budget is spent, report the smallest case found so far.

## Minimal = stop condition
Stop when no single further removal keeps the failure — the case is minimal. Smaller seed/input that still fails always wins.

## Output — write `memory/repro-<id>.md`
Verdict (REPRODUCED / NOT-REPRODUCED / FLAKY) + run count, the minimal `run_check` recipe (check + path + seed/env), the failing assertion as `file:line: message`, the shrink log (what you removed without losing the failure), and the likely fix site. Standalone report, not a summary.

## Stance
Smaller and surer beats clever. Report the minimal case you actually observed fail — never a case you assume would fail.
```

### 8. Effort, dependencies, risks
**Effort: M.** Depends on: `index.ts` plumbing, `RUNNER_PATH` (reused as-is), one optional `repro` entry in `checks.json`. Pairs with `/triage` (input) and the fix's test (output).
- **Unbounded shrink loop / runaway cost** → hard caps in the prompt (≤12 runs, ≤8 min) plus the runner's per-check `timeoutMs` (runner.ts:222) and `signal` abort (runner.ts:230); each run is independently bounded.
- **Agent tries to shrink by editing source** → it has no `edit` and only `write` for the one repro file; shrinking happens via the `path`/node-id passed to `test-file`, validated by `validateTestPath`. Anything else is refused (runner.ts:300).
- **Flaky bug declared REPRODUCED on one lucky run** → the N-run determinism gate forces a FLAKY verdict below 100%, with hit rate recorded.
- **Seed/env injection via free text** → env is never composed inline; determinism comes from the fixed-argv `repro` check (seed baked into `checks.json`), keeping it shell-free.

### 9. Worked example
Invocation:
```
/repro cache-lost-update concurrent writers drop a key under load; triage points at index.py lock release. start from tests/cache/test_index.py::test_concurrent_write
```
SUMMARY the operator sees:
```
## SUMMARY REPRODUCED (12/12 runs, seed=1337)
Minimal: run_check test-file  path tests/cache/test_index.py::test_concurrent_write[2-1]
Shrank 50→2 writers, 4000→1 key; dropped sleep + network mock, still fails.
Assertion: tests/cache/test_index.py:88: assert index.get(k)==v -> KeyError
Determinism: PYTHONHASHSEED=0, PYTEST_SEED=1337; 0 passes in 12 runs.
Confirms triage hypothesis: lost update at src/cache/index.py:140 (write after lock release).
Fix site: src/cache/index.py:140. Full recipe -> memory/repro-cache-lost-update.md
```


---

## /doc — re-derive `memory/architecture.md` from current source

A Planner-class subagent that scans the real tree and regenerates the module map, data flow, and glossary in `memory/architecture.md` — diffing against the existing file and **proposing** rather than clobbering, so the on-demand "map" stops drifting from the code every agent trusts.

### 1. Purpose & triggers
Re-derive the architecture index from current source when it has gone stale. Reach for it when:
- A refactor moved/renamed top-level modules and `memory/architecture.md` still lists the old layout.
- A new agent loaded `architecture.md` for "the map" and it didn't match the tree.
- Onboarding a repo whose `architecture.md` is still the `{{path/}}` template stub.

### 2. Invocation
`/doc [scope] [note]`
- `scope` (optional) — a subdirectory to focus the rescan (e.g. `harness/pi`); default = repo root. Resolved like the Verifier's first-token check: if `tokens[0]` resolves to an existing directory under the repo, it's the scope and is stripped from `note`; else the whole arg is the note.
- `note` (optional) — operator steer, e.g. `"glossary is fine, just fix the module map"`. Passed verbatim into the user turn.

### 3. What crosses back vs stays on disk
Parent builds the user turn (mirrors `/plan`, index.ts:443): `memory/MEMORY.md` (index), the **current** `memory/architecture.md` verbatim (so the subagent diffs against it, not invents fresh), `AGENTS.md`'s Architecture-map section (the canonical top-level dir list), the resolved scope, the operator note, then `handoffDoc(...)`. The whole-tree `find`/`grep`/`read` happens in the subprocess and stays on disk; only the SUMMARY returns.

SUMMARY shape (first token = verdict):
```
## SUMMARY
REGENERATED | IN-SYNC   <- first token
modules: 3 added, 1 renamed, 1 dropped
data-flow: rewritten (entrypoint moved to harness/pi/index.ts)
glossary: 7 human entries preserved, 2 auto entries refreshed
note: 2 dirs unmapped — see file
```
`IN-SYNC` ⇒ the derived map already matched; file untouched.

### 4. Output file
`memory/architecture.md` — same three sections as the template (no new headings):
```markdown
# Architecture (on-demand)
## Module map
- harness/pi/subagents/ — isolated Planner/Verifier subagents + closed-allowlist runner
- harness/prompts/ — methodology prompt bodies (plan, verify-change, doc)
## Data flow
/plan → Planner subprocess writes memory/plan-*.md + tasks.md → SUMMARY → main session
## Key abstractions / glossary
- run_check — closed-set named-check tool; fixed argv, shell:false  <!-- auto -->
- Slice — the current actionable batch vs the durable overall plan    <!-- human -->
```
Auto-derived glossary lines carry a trailing `<!-- auto -->`; lines without it are hand-written and preserved untouched (see §8).

### 5. Wiring (3 parts)
**a. `harness/prompts/doc.md`** — methodology body (§7).
**b. `.github/prompts/doc.prompt.md`** — front-matter `description: Re-derive memory/architecture.md from current source`, `mode: agent`, body pointing at `[harness/prompts/doc.md](../../harness/prompts/doc.md)`, mirroring `plan.prompt.md`.
**c. `registerCommand("doc", …)`** in index.ts. Reuses, verbatim: `findRepoRoot` (add `archPrompt`/`architecture` to `RepoPaths`), `readIfExists`, `runSubagent`, `fileSig`, `subagentFailed`, `extractSummary`. Arg parse mirrors `/verify` (index.ts:541–551) but tests `fs.statSync(path.join(root,tok)).isDirectory()` instead of a plan file; no `slugify` (scope is a path, validated below). Tools `"read,grep,find,ls,write"`, **no `runnerPath`** (Planner-class). After the run: `wrote = fileSig(arch) !== sigBefore`; if not, fall back to persisting `res.finalText` to `architecture.md`; surface SUMMARY via `pi.sendMessage({customType:"subagent-doc", deliverAs:"nextTurn"})`, `details:{verdict}` parsed `REGENERATED|IN-SYNC` from the first SUMMARY line like index.ts:624.

### 6. Execution model & security
`--tools read,grep,find,ls,write` — identical to the Planner (index.ts:470). **No runner, no `run_check`, no `checks.json` additions** — there is nothing to *execute*; deriving a map is pure reading. `find`/`grep`/`ls`/`read` are pi's own read-only tools (sandboxed by pi, not shell). `write` authors exactly one file. No `gh`/web/npm dependency. Scope validation in the parent before it reaches the subprocess (mirroring `validateTestPath`, runner.ts:142): reject if scope contains `..`, isn't a directory, or `path.resolve(root,scope)` escapes `root + path.sep`; on failure `ctx.ui.notify(...,"warning")` and return. The subagent inherits `--no-extensions/-nc/--no-skills` so it can't re-enter the extension.

### 7. Methodology prompt sketch (`harness/prompts/doc.md`)

```markdown
# Prompt: Doc (architecture re-derivation agent)

You are re-deriving the on-demand architecture index from the CURRENT tree. It has drifted; the code is the source of truth, the existing file is a draft to correct — not gospel, not garbage. Produce a navigable INDEX, not prose. If it's already accurate, say so and change nothing.

## Inputs
- `memory/MEMORY.md` (index) and the CURRENT `memory/architecture.md` (above) — your diff baseline.
- The AGENTS.md "Architecture map" — the blessed top-level dir list to reconcile against.
- The scope to (re)scan, and any operator note.

## How to derive
- Map the tree: `ls`/`find` the top-level dirs in scope; for each that matters, `read`/`grep` enough to state its ONE responsibility in a line. Skip vendored/generated/`node_modules`.
- Trace data flow from the real entrypoint(s) — name the 3–5 hops that matter, not every call.
- Glossary: refresh terms you can derive from code; mark each derived line with `<!-- auto -->`.
- PRESERVE every existing line WITHOUT `<!-- auto -->` — those are human notes. Never delete or reword them; only add, drop, or fix `<!-- auto -->` lines and the map/flow.
- Don't list every file "for completeness." One line per dir/module that matters.

## Verdict
- **REGENERATED** — you rewrote drifted sections; file updated.
- **IN-SYNC** — the derived map already matched; leave the file unchanged.

## Output — write `memory/architecture.md`
Same three headings as the template. Keep it to roughly one screen. Write the file with the write tool, then emit `## SUMMARY` (first token the verdict) ≤10 lines: counts of modules added/renamed/dropped, whether data-flow changed, human entries preserved.

## Stance
Terse and load-bearing. A line earns its place only if it helps an agent navigate without re-reading the repo. When unsure whether a line is human or stale, preserve it and flag it in the SUMMARY.
```

### 8. Effort, dependencies, risks
**Effort: S.** Depends only on the existing index.ts/runner-free Planner path; no new runner tool, no `checks.json` schema change.

- **Clobbering human glossary/notes.** → `<!-- auto -->` marker convention: only auto lines are rewritable; unmarked lines are copied through verbatim. Prompt enforces it; SUMMARY reports the preserved count so the operator can audit.
- **Map bloats into a novel.** → Prompt + template cap: "one line per dir that matters, ≤ one screen," same constraint the existing template states.
- **Scope arg used to traverse out of repo (`/doc ../../etc`).** → Parent rejects `..` and any path escaping `root + path.sep` before spawn, mirroring `validateTestPath` (runner.ts:158–165).
- **False REGENERATED churn on a clean repo.** → `IN-SYNC` verdict + `fileSig` no-write detection: if the derived map matches, the file is left untouched (no spurious mtime/diff), and the parent reports IN-SYNC.

### 9. Worked example
Operator runs after moving the entrypoint into `harness/pi/`:

`/doc harness "entrypoint moved, glossary is current"`

Returned to the main session:
```
Doc summary (scope: harness, 6 turns):

## SUMMARY
REGENERATED
modules: 2 added (harness/pi/subagents, harness/prompts), 1 renamed
data-flow: rewritten — entrypoint now harness/pi/index.ts
glossary: 9 human entries preserved, 3 auto entries refreshed
note: examples/ left unmapped (vendored)

Architecture map -> memory/architecture.md
```


---

## /review-pr — adversarial cold review of a fetched GitHub PR diff

`/verify` pointed outward: same isolated, allowlisted subagent and PASS / PASS WITH NITS / FAIL contract, but it fetches a PR diff via a closed-allowlist `gh-pr-diff` check instead of computing the local task slice, and judges the diff cold with no prior context.

### 1. Purpose & triggers
Cold-review an arbitrary GitHub PR with the same rigor as `/verify`, with no task slice and no assumption the surrounding code exists locally. Reach for it when:
- A teammate drops a PR number and you want an independent adversarial read before approving.
- You opened a PR off a branch you don't have checked out and want it judged against its own stated intent.
- Triaging a stack of community PRs where running them locally is impractical.

### 2. Invocation
`/review-pr <number> [note]`
- `<number>` — the PR number, **digits only** (e.g. `4821`). Validated to a fixed argv; nothing else is reachable.
- `[note]` — optional free-text steer ("focus on the auth path"), injected verbatim as an operator note, like `/verify`'s `note`.

### 3. What crosses back vs stays on disk
Parent builds the user turn from: `memory/MEMORY.md` (index, same as verify, index.ts:564), the operator `note` if any, and the **PR metadata + diff fetched by the subagent itself** via `gh-pr-diff` — the parent does NOT shell out; it only injects `MEMORY.md` + note + the handoff. The diff and all surrounding-code reads stay inside the subprocess / on disk. Only the SUMMARY crosses back. Shape (`<=10` lines, first token a verdict):

```
## SUMMARY
FAIL
PR #4821 "add retry backoff" — 3 files, +88/-12
blocker src/client.ts:140 backoff overflows i32 at >30 retries — clamp the shift
major  src/client.ts:90 no test for the 429 path the PR claims to fix
nit    naming: `ms2` → `delayMs`
surrounding code not local; reviewed from diff context only
```

### 4. Output file
`memory/review-<number>.md` (e.g. `memory/review-4821.md`), one file, authored by the subagent via `write`. Compact structure:

```markdown
# PR #4821 review — add retry backoff
Verdict: FAIL  (head abc1234, base main, +88/-12, 3 files)

## Findings
- blocker src/client.ts:140 — i32 shift overflow >30 retries. Fix: clamp shift to 30.
- major   src/client.ts:90  — no test covers the 429 retry this PR claims. Fix: add it.

## Notes / unknowns
- Surrounding code not checked out; src/limits.ts referenced by the diff was unread.
```

### 5. Wiring (3 parts)
1. **`harness/prompts/review-pr.md`** — methodology body (sketch in §7), appended to the AGENTS.md brief by `runSubagent` (index.ts:250-252).
2. **`.github/prompts/review-pr.prompt.md`** — thin pointer, mirroring `verify-change.prompt.md`:
   ```markdown
   ---
   description: Cold-review a GitHub PR diff adversarially (PASS / PASS WITH NITS / FAIL)
   mode: agent
   ---
   Follow the instructions in [harness/prompts/review-pr.md](../../harness/prompts/review-pr.md).
   Input: the PR diff you fetch with the gh-pr-diff check. No local task context. End with a verdict: PASS / PASS WITH NITS / FAIL, each finding `file:line` + fix.
   ```
3. **`registerCommand("review-pr", …)`** — clone the `/verify` handler (index.ts:521). Arg parse: `const m = /^(\d{1,12})(?:\s+(.*))?$/s.exec(args.trim())`; reject with `ctx.ui.notify("Usage: /review-pr <number> [note]")` if no digit token. Reuses **`findRepoRoot`** (resolve repo + prompt paths — add `reviewPrompt` + a `reviewPath(repo, number)` helper alongside `planFilePath`), **`runSubagent`** with `tools: "read,grep,find,ls,run_check,write"` and `runnerPath: RUNNER_PATH`, **`fileSig`** before/after for the write-fallback, **`subagentFailed`**, **`extractSummary`** (10), and the `verdictWord` regex + `pi.sendMessage({ customType: "subagent-review-pr", details: { verdict } })` block. It does **not** call `computeDiff` (no local diff), does **not** require `tasks.md`, and does **not** touch `slugify`/active-plan (number is the slug). Inject the validated `number` into the handoff so the subagent runs `gh-pr-diff` with it.

### 6. Execution model & security
- **Allowlist:** `--tools read,grep,find,ls,run_check,write` — identical to `/verify`. No `edit`, no `bash`.
- **Runner: yes.** Add ONE closed check to `runner.ts` + `checks.json`. No general `gh` shell.
- **New check `gh-pr-diff`** in `checks.json` (per-repo, so repos without `gh` simply omit it):
  ```json
  "gh-pr-diff": { "cmd": "gh", "args": ["pr", "diff"], "timeoutMs": 60000, "numberArg": true }
  ```
  In `runner.ts`, treat `numberArg: true` like `test-file`'s `path`: take the optional `path` param, run `validatePrNumber` (mirrors `validateTestPath`), then `cmdArgs = [...spec.args, n]`. The PR number is the only free-text input and is regex-pinned:
  ```ts
  function validatePrNumber(p: string){ const n=p.trim();
    if(!/^[0-9]{1,12}$/.test(n)) return {ok:false,reason:"PR number must be digits only"};
    return {ok:true,rel:n}; }
  ```
  Because `spawn(cmd,args,{shell:false})` (runner.ts:205) and `args` is the **fixed** `["pr","diff",n]`, no other `gh` subcommand (`gh api`, `gh pr merge`, `gh auth`) is reachable — the model never assembles `gh`'s first arg. `gh` auth is inherited from `process.env`/`buildEnv` (runner.ts:174), so it can READ the PR but cannot escalate past `pr diff`. Add `--patch`? No — bare `gh pr diff <n>` already emits unified diff. Optionally add a second fixed check `gh-pr-view` (`["pr","view","--json","title,state,baseRefName,headRefName,files", n]`) for metadata, same `numberArg` validation; keep it a separate fixed entry, never a free `--json` field list.
- **External dep:** `gh` CLI, sandboxed exactly as every other check — fixed argv, `shell:false`, per-repo opt-in. No web tools, no npm additions.

### 7. Methodology prompt sketch — `harness/prompts/review-pr.md`

```markdown
# Prompt: Review-PR (cold reviewer of a GitHub pull request)

You are reviewing a pull request you did not write, with NO prior task context. Be adversarial: assume it is subtly wrong until the diff proves otherwise. Judge the PR against its OWN stated intent (title/description), not a task slice — there isn't one.

## Inputs
- The PR number is in your handoff. Fetch the diff yourself: run the `gh-pr-diff` check with that number. Optionally run `gh-pr-view` for title/base/files.
- The surrounding code may NOT be checked out locally. Read what you can with read/grep/find/ls; when a referenced symbol isn't on disk, reason from the diff hunk and SAY so — never invent the missing code.

## How to review
- **Intent** — does the diff do what the PR title/description claims? Trace the changed logic on a real input.
- **Correctness & edges** — empty/null/zero/huge inputs, error paths, boundaries, overflow, concurrency. Which hunk is wrong?
- **Tests** — does the diff add/adjust a test for the behavior it changes? A behavior change with no test in-diff is not done.
- **Regressions** — what call sites does this hunk invalidate? Flag them even if those files aren't local.
- **Scope / safety** — unrelated churn, debug prints, secrets, destructive ops, missing input validation.

## Verdict
**PASS** / **PASS WITH NITS** / **FAIL**, then findings as a list, each `file:line` (diff path) + severity (blocker / major / nit) + a concrete fix. blocker = wrong behavior, missing test for changed behavior, regression, or security issue.

## Output
Write the COMPLETE review to the file named in your handoff (`memory/review-<number>.md`) with `write` — a standalone report, not a summary. Then a final `## SUMMARY` whose FIRST token is PASS, PASS WITH NITS, or FAIL, then <=10 lines.

## Stance
Precise, not pedantic. Don't penalize a PR for code outside its diff — but DO flag where the diff assumes something you couldn't verify. Three real defects beat thirty nits.
```

### 8. Effort, dependencies, risks
**Effort: M.** ~95% reuse of the `/verify` command + runner; net-new surface is the `numberArg`/`validatePrNumber` branch in `runner.ts`, two `checks.json` entries, and two prompt files.
**Deps:** `gh` installed + authed in the repo (per-repo, opt-in via `checks.json`); existing pi subagent plumbing.
Risks:
- **Arg injection via the PR number** → `validatePrNumber` pins to `^[0-9]{1,12}$` and the argv is fixed `["pr","diff",n]` under `shell:false`; non-digits are refused before spawn.
- **Reachability creep (some other `gh` subcommand)** → the check name maps to a hard-coded `args` prefix the model cannot edit; only the trailing number is variable, exactly like `test-file`.
- **Reviewing code that isn't local → hallucinated findings** → the prompt forces "reason from the hunk and SAY when a symbol is unread," and the SUMMARY surfaces "surrounding code not local" so the operator calibrates.
- **`gh` not installed / not authed / PR not found** → the check returns non-zero like any failed check; `subagentFailed`/the verdict path report it cleanly; repos without `gh` just omit the check and `/review-pr` is unavailable there, no crash.

### 9. Worked example
Operator runs: `/review-pr 4821 focus on the retry math`

Subagent (isolated): runs `gh-pr-diff 4821`, optionally `gh-pr-view 4821`, greps local `src/` for `client.ts`, writes `memory/review-4821.md`. SUMMARY returned to the main session:

```
## SUMMARY
FAIL
PR #4821 "add retry backoff" — 3 files, +88/-12
blocker src/client.ts:140 1<<retries overflows i32 past 30 retries; clamp shift to 30
major  src/client.ts:90 PR claims to fix the 429 path but adds no test for it
nit    src/client.ts:77 `ms2` → `delayMs`
surrounding code not checked out; src/limits.ts (referenced) was unread
Full review -> memory/review-4821.md
```

Notify line: `Review-PR: FAIL — written to memory/review-4821.md`.


---

## /bench — perf/throughput regression watch

### 1. Purpose & triggers
Run one allowlisted benchmark check, parse its numeric metrics, diff them against the last accepted baseline on disk, and emit a REGRESSION/OK verdict before noise hides a real slowdown. Reach for it when:
- You just changed a hot path (serialization, cache lookup, a tokenizer) and want to know if p95 latency or throughput moved before merging.
- A nightly loop wants a cheap "did anything regress vs the blessed baseline" gate without a human eyeballing raw bench tables.
- Token cost per request crept up after a prompt/model change and you want the delta vs last week, not a re-read of 2k rows of output.

### 2. Invocation
`/bench <suite> [--accept] [note...]`
- `<suite>` — required; names the bench check in `checks.json` (`bench-<suite>`) AND the baseline file `memory/bench-<suite>.md`. Slugified.
- `--accept` — promote THIS run's numbers to the new baseline (operator decision, never automatic). Without it, baseline is read-only and only the delta is reported.
- `note...` — free text recorded in the run log (e.g. "after switching to msgpack").

### 3. What crosses back vs stays on disk
Parent builds the user turn by injecting: `memory/MEMORY.md` (index), the existing `memory/bench-<suite>.md` (current baseline block + last delta — or "no baseline yet"), the resolved check name `bench-<suite>`, the noise threshold, and `--accept`/note flags. The subagent runs the check (huge noisy tables stay in the subprocess), parses metrics, diffs, writes the file. SUMMARY shape (`<=10` lines, first token a verdict):
```
## SUMMARY
REGRESSION  (suite: serialize, vs baseline 2026-06-01)
latency_p95  +18.4%  (12.1ms -> 14.3ms)  [>5% thr]
throughput   -3.1%   (within noise)
mem_rss      +0.4%   tokens/req  +0.0%
baseline NOT updated (no --accept)
```
First token is `OK`, `NOISY` (run-to-run spread exceeds threshold; inconclusive), or `REGRESSION`. Parent maps it like `/verify`'s `verdictWord` and passes `details:{ verdict }`.

### 4. Output file
`memory/bench-<suite>.md` — rolling baseline + last delta, compact:
```
# Bench: serialize

## Baseline (accepted 2026-06-01, commit a1b2c3d)
| metric        | value   | unit |
|---------------|---------|------|
| latency_p95   | 12.1    | ms   |
| throughput    | 48200   | ops/s|
| mem_rss       | 512     | MiB  |
| tokens_per_req| 1830    | tok  |

## Last run (2026-06-13, note: after msgpack)
verdict: REGRESSION (threshold 5%)
| metric      | baseline | now  | delta  | flag |
|-------------|----------|------|--------|------|
| latency_p95 | 12.1     | 14.3 | +18.4% | REGRESSION |
| throughput  | 48200    | 46700| -3.1%  | noise |

## History (most recent first)
- 2026-06-13 REGRESSION latency_p95 +18.4% (not accepted)
- 2026-06-01 BASELINE accepted
```
On `--accept`, the agent rewrites the Baseline block from the current run and appends a `BASELINE accepted` history line. Otherwise Baseline is preserved verbatim.

### 5. Wiring (3 parts)
**`harness/prompts/bench.md`** — methodology (sketch in §7).
**`.github/prompts/bench.prompt.md`**:
```
---
description: Run a benchmark suite and diff it against the recorded baseline; flag regressions
mode: agent
---
Follow the instructions in [harness/prompts/bench.md](../../harness/prompts/bench.md).
Run ONLY the allowlisted bench-<suite> check, parse its numbers, diff vs memory/bench-<suite>.md, and end with a verdict: OK / NOISY / REGRESSION plus per-metric deltas.
```
**`registerCommand("bench", …)`** mirrors `/verify` (index.ts:521): parse `<suite>` as first token via `slugify` (reuse, index.ts:173); strip `--accept`; remainder is `note`. `findRepoRoot(ctx.cwd)` (index.ts:136); add `bench: path.join(memoryDir, \`bench-${slug}.md\`)` to `RepoPaths`. Refuse if `checks.json` has no `bench-<suite>` key (read via the same `listVerifyChecks` loader, index.ts:58) — fail fast like the empty-tasks guard (index.ts:533). Build `userTurn`, `fileSig` before/after (index.ts:111), `runSubagent` with `runnerPath: RUNNER_PATH` (the bench check needs `run_check`), `subagentFailed` guard (index.ts:345), `extractSummary(res.finalText, 10)` (index.ts:353), write-fallback to `bench-<suite>.md` if unwritten, `pi.sendMessage` with `details:{ verdict }`, `ctx.ui.setStatus`/`notify`.

### 6. Execution model & security
`--tools read,grep,find,ls,run_check,write` — same surface as the Verifier; needs `run_check` to run the bench. **No new tool, no new validated free-text arg.** A bench suite is a FIXED check, identical in shape to `test`/`lint` (runner.ts:310, the `check in CONFIG.checks` branch) — it requires ZERO runner.ts change. The operator adds one entry to `harness/checks.json`:
```json
"bench-serialize": { "cmd": ".venv/bin/python", "args": ["-m","bench.serialize","--json","--reps","5"], "timeoutMs": 900000 }
```
Fixed argv, `shell:false`, so chaining/redirects are structurally impossible (runner.ts:205). The agent may ONLY invoke `run_check{check:"bench-serialize"}`; it parses numbers from the returned text. No `--accept` reaches the runner — promotion is a markdown rewrite by the `write` tool, gated by the flag in the user turn, never an executed command. Bench reps live INSIDE the suite command (`--reps 5`) so noise tolerance is computed from one run's spread; no external deps, no `gh`, no web. If a suite needs a target arg later, model it on `test-file`'s `validateTestPath` (runner.ts:142) — regex + root-confinement + no `..` — never raw text.

### 7. Methodology prompt sketch (`harness/prompts/bench.md`)

```markdown
# Prompt: Bench (performance regression watch)

You are guarding a performance baseline. Be adversarial about noise: a number that
moved is not a regression until it clears the threshold AND the run's own spread.
You did not write this code and you are not here to celebrate a green run.

## Inputs
- The current baseline block + last delta from `memory/bench-<suite>.md` (or "no baseline yet").
- The allowlisted check name `bench-<suite>`, the regression threshold (default 5%), and
  whether the operator passed `--accept`.

## How to run
- Run the bench EXACTLY ONCE via `run_check{check:"bench-<suite>"}`. That is the ONLY command
  you may execute. No shell, no other check, no re-runs to "get a better number".
- Parse the metrics from its output: latency (p50/p95), throughput, memory (rss), tokens/req.
  If the output has per-rep rows, take the median per metric and note the min–max spread.
- If you cannot find a metric, report it MISSING — never invent or estimate a number.

## Verdict (per metric, then overall)
- **REGRESSION** — a worse-direction delta whose magnitude exceeds the threshold AND exceeds
  the run's own min–max spread (so it isn't run-to-run jitter). Latency/mem/tokens up = worse;
  throughput down = worse.
- **NOISY** — delta exceeds threshold but is within the observed spread: inconclusive, not a pass.
- **OK** — all metrics within threshold (or improved).
- Overall verdict is the worst per-metric verdict. No baseline yet => OK, and record this run AS
  the baseline only if `--accept`.

## Output — write `memory/bench-<suite>.md` yourself
- Preserve the Baseline block verbatim UNLESS `--accept`, in which case replace it with this run's
  numbers + commit + date and append a `BASELINE accepted` history line.
- Write the Last-run delta table (baseline | now | delta% | flag) and prepend one History line.
- Final message: `## SUMMARY` whose FIRST token is OK / NOISY / REGRESSION, then <=10 lines of the
  flagged metrics and whether the baseline was updated. Nothing after it.

## Stance
Precise, not trigger-happy. One real regression surfaced beats ten noise alarms. Never accept a
new baseline on your own — that is the operator's call via `--accept`.
```

### 8. Effort, dependencies, risks
**Effort: M.** Depends only on existing index.ts/runner.ts plumbing + one `checks.json` entry; the real work is baseline storage/diffing and noise-tolerant parsing — all inside the prompt + a small command handler.
- **Noise misfires as regression** → require delta to exceed BOTH a fixed threshold and the run's own min–max spread; emit `NOISY` (not OK, not REGRESSION) when ambiguous.
- **Silent baseline drift** (agent quietly re-blesses a slow run) → promotion is operator-gated by `--accept`; without it the Baseline block is preserved verbatim and the file says "NOT updated".
- **Unparseable / changed bench output** → mandate a stable `--json`-style emitter in the suite command; agent reports any metric it can't find as MISSING rather than guessing, and a MISSING key downgrades the verdict from OK.
- **Long/heavy bench wedging the run** → bounded by the check's `timeoutMs` (runner.ts:222 SIGTERM→SIGKILL) and a single no-re-run rule in the prompt; overlaps with `/monitor` but `/bench` never watches a live process — it runs once and compares numbers.

### 9. Worked example
Invocation: `/bench serialize after switching to msgpack`
Operator sees come back:
```
Bench verdict (4 turns):

## SUMMARY
REGRESSION  (suite: serialize, vs baseline 2026-06-01)
latency_p95  +18.4%  (12.1ms -> 14.3ms)  [>5% and beyond spread]
throughput   -3.1%   (within run spread -> noise)
mem_rss      +0.4%   tokens_per_req  +0.0%
baseline NOT updated (re-run with --accept to bless)

Full delta -> memory/bench-serialize.md
```