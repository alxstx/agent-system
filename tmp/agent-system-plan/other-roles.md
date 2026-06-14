I now have everything I need: the canonical subagent pattern, the tool allowlists, the `run_check` closed-allowlist runner model, the memory layout, and the existing prompts. Here is the ranked menu.

---

# New sub-agent roles for the token-minimizing harness

Ranked by value-to-effort for experiment-heavy research + coding day-to-day. Every role below is an **isolated `pi` subprocess** (`--mode json -p --no-session -nc --no-skills --no-prompt-templates --no-extensions`), writes **exactly one `memory/` file**, returns a **`## SUMMARY` (≤10 lines)**, and gets **no general shell** — any execution goes through a closed-allowlist `run_check`-style runner. Each pairs with a canonical `harness/prompts/<role>.md`.

---

### 1. `/triage` — failing-run / stacktrace classifier → root-cause hypothesis
**Purpose:** Take a failing run (log, stacktrace, or a `run_check` test result) and produce a ranked root-cause hypothesis with the single next probe to run.
**Writes:** `memory/triage-<id>.md`
**Allowlist:** `read,grep,find,ls,run_check,write` (runner extended with read-only repro checks: rerun-test, git-log, git-blame, env-dump)
**Token discipline:** Parent passes only the failing log + MEMORY.md index in the user turn; agent greps the code on demand, never preloads the tree; only the hypothesis + next-probe crosses back.
**Effort:** S — clones the Verifier wiring almost verbatim (same tools, same runner shape).
**Strongest reason:** This is the single highest-frequency event in experiment-heavy work — runs fail constantly — and triage is exactly the read-heavy, shell-tempting task the isolation model is built to make safe. Highest raw call volume of any role here.
> Failing runs are your most common interruption, and a focused isolated agent that turns a wall of stderr into "most likely X, run Y to confirm" pays off many times a day. It reuses the Verifier's exact safety core, so it's nearly free to build. Best value-to-effort on the board.

---

### 2. `/research` — web-search research agent → cited memory note
**Purpose:** Answer an open research question (library choice, algorithm, API behavior, prior art) from the live web and write a cited, claim-checked note.
**Writes:** `memory/research-<topic>.md`
**Allowlist:** `read,grep,find,ls,web_search,fetch_content,write` (no `run_check` — it touches the web, never the repo's executables)
**Token discipline:** Sources are fetched and digested *inside* the isolated context and never re-enter the main session; only the synthesized findings + citations land on disk, and only a ≤10-line summary crosses back. This is the cleanest "detail on disk" win — research is inherently token-heavy.
**Effort:** M — new tool surface (`web_search`/`fetch_content`) instead of the runner; a `deep-research` skill already exists to model the prompt's verify-claims stance on.
**Strongest reason:** Research is the most token-bloating thing you do in the main session, so quarantining it into a subprocess that returns a one-screen cited brief is the largest per-use context saving of any role.
> Half of "experiment-heavy research" is literally reading the web, and doing it in the main session torches your context window with raw page text. This role keeps all that noise in a teardown subprocess and hands back a citeable note you can reopen on demand. Slightly more build because of the new web tools, but the payoff is the biggest single context saving here.

---

### 3. `/distill` — memory hygiene: prune MEMORY.md, split overgrown topic files
**Purpose:** Periodically compact `memory/`: prune stale entries from the index, split overgrown topic files, fix dangling pointers — keeping "index in context, detail on disk" actually true.
**Writes:** `memory/MEMORY.md` (and may emit split topic files — but the *one* contract file it must author and summarize is the index; splits are reported in the summary for the operator to confirm)
**Allowlist:** `read,grep,find,ls,write`
**Token discipline:** This is the meta-role that *protects* the whole scheme — every other agent loads MEMORY.md first, so an index that bloats silently raises the floor cost of every task. `/distill` keeps that floor low.
**Effort:** S — Planner-class tooling (`read,grep,find,ls,write`), no runner, no web.
**Strongest reason:** The harness's entire token budget rests on MEMORY.md staying small; nothing else keeps it small, and a research workflow generates churn fast.
> Every single task in this harness pays the MEMORY.md tax up front, so an agent whose only job is to keep that file lean compounds across everything else. It's cheap to build (Planner tools, no runner) and it's the one role that makes the others stay efficient over weeks. Slightly behind triage/research only because it's periodic rather than per-task.

---

### 4. `/repro` — reduce a bug to a minimal reproduction
**Purpose:** Shrink a failing scenario to the smallest deterministic repro (minimal input, seed, command) and record it so the fix and its test are obvious.
**Writes:** `memory/repro-<id>.md`
**Allowlist:** `read,grep,find,ls,run_check,write` (runner with a tightly-scoped rerun/`test-file` check so it can re-execute candidate repros — never arbitrary commands)
**Token discipline:** The iterative shrink loop (many runs, much output) happens entirely inside the subprocess; only the final minimal repro recipe and the failing assertion land on disk and in the summary.
**Effort:** M — needs the runner to safely re-run candidate cases via the existing `test-file` path-validated mechanism; bounding the iteration is the real work.
**Strongest reason:** A minimal repro is the artifact that makes both `/triage`'s hypothesis and the eventual fix's test trivial — it's the highest-leverage handoff between diagnosis and fix.
> When an experiment misbehaves, the expensive part is isolating *what* triggers it, and that's an iterate-and-observe loop that bloats context fast in the main session. Pinning it in an isolated agent that returns a one-line repro recipe is exactly the right trade. Pairs naturally with /triage, just costs more to bound safely.

---

### 5. `/doc` — refresh `memory/architecture.md` from the code
**Purpose:** Re-derive the architecture map / data-flow / glossary in `memory/architecture.md` from the current source so the "load on demand" detail file doesn't drift from reality.
**Writes:** `memory/architecture.md`
**Allowlist:** `read,grep,find,ls,write`
**Token discipline:** The whole-repo scan that would otherwise pollute the main session is confined to the subprocess; the main session only ever reads the resulting compact map, never the scan.
**Effort:** S — Planner-class tooling, single output file, no runner.
**Strongest reason:** `architecture.md` is the file the operating contract tells every agent to load for "the why," so stale content here silently misleads every future task.
> The harness explicitly routes "architecture → memory/architecture.md," so when that file lies, every downstream agent inherits the lie. A cheap isolated agent that regenerates it from source keeps the load-on-demand promise honest. Lower than /distill only because it covers one file rather than the whole index.

---

### 6. `/review-pr` — review a GitHub PR diff cold
**Purpose:** Adversarially review an external/teammate PR with no prior context, same rigor as `/verify` but against a fetched diff instead of the local task slice.
**Writes:** `memory/review-<pr>.md`
**Allowlist:** `read,grep,find,ls,run_check,write` (runner extended with a single fixed `gh-pr-diff <number>` fetch check — closed-allowlist, not a general `gh` shell)
**Token discipline:** Reuses the Verifier's exact "detail on disk, ≤10-line verdict" contract; only the PASS/FAIL + top findings cross back, full review on disk.
**Effort:** M — mostly the Verifier, but needs a path-validated `gh pr diff` check so the closed-allowlist rule isn't broken by a raw `gh` call.
**Strongest reason:** It's `/verify` aimed outward, so it reuses the most battle-tested role in the system with minimal new surface.
> You already have a cold-eyed adversarial reviewer in /verify; this just points it at a PR number instead of your working tree. The build is small because the prompt and contract are nearly identical — the only real work is a locked-down diff-fetch check. It ranks here, not higher, because PR review is less frequent in solo experiment-heavy work than triaging your own runs.

---

### 7. `/bench` — perf / throughput regression watch for experiments
**Purpose:** Run a fixed benchmark check, compare against the last recorded baseline, and flag regressions (latency, throughput, memory, token cost) before they hide in noise.
**Writes:** `memory/bench-<suite>.md` (rolling baseline + last delta)
**Allowlist:** `read,grep,find,ls,run_check,write` (runner with a fixed `bench` check defined in `checks.json`, same closed-set mechanism as `test`/`lint`)
**Token discipline:** Raw benchmark output (often huge, noisy tables) stays in the subprocess; only the regression verdict + the delta vs. baseline crosses back, and the baseline persists on disk between runs.
**Effort:** M — the runner already supports adding a `bench` check trivially; the work is baseline storage/diffing and noise-tolerant comparison logic in the prompt.
**Strongest reason:** Perf is exactly where experiment work silently regresses, and a numeric baseline-on-disk fits the memory model perfectly.
> Experiments live and die by throughput numbers, and regressions love to hide in run-to-run noise. An agent that keeps a baseline on disk and only surfaces "you regressed 12% vs last week" is a great fit for the memory model. It ranks last because it only pays off once you have a stable benchmark worth watching — high value, but narrower and more setup-dependent than the rest.

---

## Ranking at a glance (value-to-effort, strongest first)

| # | Role | Effort | One-line why it's ranked here |
|---|------|--------|-------------------------------|
| 1 | `/triage` | S | Highest call frequency; near-verbatim reuse of Verifier safety core |
| 2 | `/research` | M | Biggest single context saving; quarantines web noise off the main session |
| 3 | `/distill` | S | Protects the token budget every other role depends on |
| 4 | `/repro` | M | Highest-leverage handoff between diagnosis and fix |
| 5 | `/doc` | S | Keeps the load-on-demand architecture file from lying to everyone |
| 6 | `/review-pr` | M | `/verify` pointed outward; cheap reuse, less frequent solo |
| 7 | `/bench` | M | High value but narrow and setup-dependent |

**Build-order suggestion:** ship `/triage` and `/distill` first (both S, both reuse existing wiring — Verifier and Planner respectively), then `/research` for the largest context win, then `/repro` to close the diagnose→fix loop. The two Verifier-derived roles (`/triage`, `/review-pr`) only need new closed-set checks in the runner, not new architecture, so they stay inside the safety model for free.

**Files referenced:** `/Users/alex/agent-system/harness/pi/subagents/index.ts` (canonical subprocess + allowlist pattern), `/Users/alex/agent-system/harness/prompts/verify-change.md` (prompt/verdict contract to mirror), `/Users/alex/agent-system/harness/checks.json` + `harness/pi/subagents/runner.ts` (the closed-allowlist `run_check` mechanism every execution-touching role must reuse instead of a shell).