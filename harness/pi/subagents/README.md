# Sub-agents: Planner → Implement → Verify (pi extension)

A pi extension that runs the token-minimizing **Planner → Implement → Verify**
workflow as real `/plan` and `/verify` commands. It mirrors the same methodology
the markdown harness uses for GitHub Copilot, reading the *same* markdown
(`AGENTS.md`, `harness/prompts/*.md`, `memory/`) so the two harnesses never drift.

- **Canonical source (version-controlled):** `harness/pi/subagents/` (`index.ts` + `runner.ts`
  + `userturns.ts`), with the shared core in `harness/pi/shared/` (`subagent-core.ts` +
  `checks-core.ts` + `redact.ts`)
- **Install into pi:** `harness/pi/install.sh` → links/copies every `harness/pi/<ext>/` + `shared/`
  into `~/.pi/agent/extensions/`
- **Commands:** `/plan`, `/verify`, `/triage`, `/monitor`, `/report`, `/research` (this engine);
  plus `/checks` and `/guard` from the sibling extensions

### Two ways to invoke a role

Every role is reachable two ways — both funnel through the SAME isolated-sub-agent
core (`runXRole` in `index.ts`), so they explore the repo, write their own file, and
return only a ≤10-line summary identically. They differ only at the seam:

| Mode | How | Result delivery | Timeout / abort |
|---|---|---|---|
| **Command** (operator) | you type `/<role> …` | ≤10-line SUMMARY posted to the session on the **next turn** (`deliverAs:"nextTurn"`) | none (unchanged) |
| **Tool** (the model) | the model calls **`subagent_<role>`** mid-turn | the SUMMARY is the tool result the model sees **in the same turn** | wall-clock timeout + `ctx.signal` |

- **Tool names are namespaced** (`subagent_plan` / `subagent_verify` / `subagent_triage` /
  `subagent_monitor` / `subagent_report` / `subagent_research`). The `subagent_` prefix is
  mandatory: pi's tool registry is **last-write-wins with no collision error**, so an un-prefixed
  name (e.g. `verify`) would silently shadow a built-in or sibling tool.
- On failure a `subagent_<role>` tool **throws** a short, redaction-safe error (a *returned*
  `isError:true` is inert — only a thrown error marks the tool result failed). The artifact still
  lives on disk; only the summary (or the error) crosses back.
- The model can spawn these mid-turn, so the extension arms a `session_shutdown` guard that
  SIGTERM→SIGKILLs any live child on `/reload`/quit (`ctx.signal` covers operator-abort only).
- *(Coming in a later slice: a third `/<role>-main` mode that runs the **main** session under a
  role's methodology.)*

### Per-role model & effort (Phase 0.5)

Every sub-agent is spawned with an explicit `--model` and `--thinking xhigh`:

| Role | Class | Model |
|---|---|---|
| `/verify` | reviewer / adversarial judge | **GPT-5.5** (`MODEL_REVIEW`) |
| `/plan`, `/triage`, `/monitor`, `/report`, `/research` | default | **Opus 4.8** (`MODEL_DEFAULT`) |

The ids live in two constants at the top of `index.ts` — change them in ONE place if `pi --list-models`
shows different canonical strings. Authenticate pi first (for example with GitHub Copilot via
`/login`); after that, GPT-5.5 and Opus 4.8 are model selections. If a selected model can't load, the
handler surfaces the subprocess error via `ctx.ui.notify`.

### The other roles (same 3-part wiring)

`/triage` (failing-run → ranked hypotheses + one probe; read-only `run_check` probes git-blame /
git-log-file / env-dump), `/monitor` (runs an allowlisted **experiment** via `run_experiment`,
redacted per-run log at `memory/runs/<runId>.log`), `/report` (composes an audience-facing document
into `memory/reports/`), `/research` (web search via `-e npm:pi-web-access` → `memory/research-<topic>.md`).
Each reads its canonical `harness/prompts/<role>.md` + a `.github/prompts/<role>.prompt.md` wrapper.
- **Generic:** the project-specific verifier checks live in **`harness/checks.json`**, not in
  the code. One installed engine serves every repo that ships a `harness/` skeleton +
  `harness/checks.json`. Drop the harness into a new project, edit `harness/checks.json`,
  and `/plan` + `/verify` work there with no code change.
- **Works in:** any repo with `harness/prompts/plan.md` + `memory/MEMORY.md` above the
  cwd (auto-detected — see *Repo detection*)

> **Core rule honored:** *index in context, detail on disk.* Sub-agents run in their
> own isolated context, **write their own full markdown file** to disk, and return
> only a ≤10-line summary to your main session.

---

## TL;DR

```text
/plan health-endpoint add a /health endpoint to the operator HTTP server
      → Planner (isolated, can write its own plan files) explores the repo
      → Planner writes/updates the OVERALL plan -> memory/plan-health-endpoint.md
      → Planner writes the current TASK SLICE      -> memory/tasks.md
      → ≤10-line SUMMARY posted back to your session

# ...you review the two files, edit if needed, then implement normally...
# Run /plan health-endpoint <next task> again to UPDATE the same overall plan.

/verify
      → Verifier (isolated, allowlisted test/lint runner, can write its own verdict file)
      → checks the diff vs main against BOTH the overall plan and the task slice
      → Verifier writes the full verdict to memory/verdict.md itself
      → PASS/FAIL + ≤10-line SUMMARY posted back
```

---

## The workflow

### 1. `/plan <feature> <task>`
Spawns the **Planner** sub-agent in an isolated `pi` subprocess. The **first
token is a feature name** (slugified) that scopes the durable overall plan; the
rest is the task for the next slice. Example:
`/plan health-endpoint add a /health route to the operator server`.

- **System prompt** (stable, cache-friendly): your `AGENTS.md` brief **+**
  `harness/prompts/plan.md`, appended to Pi's default prompt.
- **First user turn** (variable): `memory/MEMORY.md` index + the existing
  `memory/plan-<feature>.md` (if any) + the current `memory/tasks.md` (for
  reference) + your task.
- **Tools:** `read, grep, find, ls, write`. It writes **only** its two plan
  files; it has **no `edit`** and **no shell**. It reads `memory/**` detail
  files *on demand* — nothing is preloaded.
- **Output (both written by the sub-agent itself):**
  - **Overall plan** → **`memory/plan-<feature>.md`** — the durable roadmap
    (Goal, Context, Approach, Key decisions, Milestones, Risks, Out of scope).
    **New feature** → fresh file; **same feature** (file already exists) →
    updated/extended in place, preserving prior decisions.
  - **Task slice** → **`memory/tasks.md`** — the concrete next batch to
    implement (numbered steps, files to touch, test plan); overwritten each run.
  - ≤10-line **SUMMARY** + the file paths → posted into your main session.
  - (If the sub-agent fails to write `tasks.md`, the parent persists the
    returned text as a fallback.)

The feature you last planned is remembered in `memory/.active-plan` so `/verify`
finds the right overall plan automatically.

Then **you** review the two files and edit them directly if needed. Nothing is
auto-implemented.

### 2. Implement (no sub-agent)
Just work normally in your main session with full tools (read/write/edit/bash),
following `memory/tasks.md` (and the overall `memory/plan-<feature>.md`). There
is no `/implement` command — this step is ordinary main-session work.

### 3. `/verify [feature] [note]`
Spawns the **Verifier** sub-agent in a fresh, isolated subprocess. It is
deliberately *not* given your implementation reasoning — it judges the change
cold. The overall plan is resolved from the optional first `feature` token, else
from `memory/.active-plan`, else the sole `plan-*.md` if there's only one.

- **System prompt** (stable): your `AGENTS.md` brief **+**
  `harness/prompts/verify-change.md`, appended to Pi's default prompt.
- **First user turn** (variable): `memory/MEMORY.md` index + the overall
  `memory/plan-<feature>.md` (if found) + the task slice (`memory/tasks.md`) +
  the **diff vs `main`** (computed by the parent) + your optional note.
- **Tools:** `read, grep, find, ls, write` + a constrained **`run_check`** runner
  (see *The Verifier's command runner*). It writes **only** its verdict file and
  never touches source code; it has **no `edit`** and **no general shell**.
- **Output:**
  - Full verdict → **`memory/verdict.md`**, written by the sub-agent itself
    (per-criterion findings with `file:line`, test excerpts), judged against
    **both** the overall plan and the task slice. The parent persists the
    returned text only as a fallback if the file wasn't written.
  - **PASS / FAIL** + a ≤10-line SUMMARY + the file path → posted into your
    main session.

If it FAILs, fix the code in your main session and run `/verify` again.

---

## Why this file convention

- `memory/plan-<feature>.md` — the **durable overall plan** for a feature/effort.
  Created on the first `/plan <feature> …` and **updated/extended** on every
  subsequent `/plan <feature> …`. One file per feature; they persist.
- `memory/tasks.md` — the **single active task slice** (overwritten by each
  `/plan`): the concrete next batch derived from the overall plan.
- `memory/.active-plan` — a one-line pointer to the last-planned feature, so
  `/verify` knows which overall plan to check against.
- `memory/verdict.md` — the **latest verdict** (overwritten by each `/verify`).

Durable lessons still belong in `memory/MEMORY.md` (Gotchas) or
`memory/decisions.md`, per `harness/prompts/verify-change.md`.

---

## The Verifier's command runner (`run_check`)

The Verifier cannot run an arbitrary shell. Its `run_check` tool exposes a
**closed set of named checks**, each mapped to a **fixed command vector** run
with `shell:false` — so `;`, `&&`, `||`, `|`, backticks, `$( )`, redirects and
newlines are *structurally impossible*, not merely discouraged.

The check set is **defined per-repo in `harness/checks.json`** (the engine code is
generic). That file maps each check name to a fixed `{cmd, args, timeoutMs}` vector.
The engine also always provides four universal git checks — `git-diff`,
`git-diff-stat`, `git-status`, `git-log` — so the tool works in any git repo even
with no config. For the current repo, `harness/checks.json` defines:

| `check` | Runs |
|---|---|
| `test` | the full non-CUDA pytest subset (the AGENTS.md ignore list) |
| `test-file` | `pytest -xvs <path>` — `<path>` validated against `testFile.pathRegex`, must stay under `testFile.rootDir` |
| `lint` | `ruff check .` |
| `format-check` | `ruff format --check .` (read-only; never rewrites) |
| `imports-check` | `isort --check-only --diff .` |
| `typecheck` | `mypy --config-file=pyproject.toml` |
| `spell` | `codespell --toml pyproject.toml` |
| `precommit` | `pre-commit run --all-files` |
| `docs-build` | `make -C docs html` |
| `git-diff` / `git-diff-stat` | `git diff [--stat] <base>` (base from `diffBases`) |
| `git-status` | `git status --porcelain` |
| `git-log` | `git log --oneline -20 <base>..HEAD` |

The only free-text input is the `test-file` path, validated against
`testFile.pathRegex`, with no `..`, and it must resolve inside `testFile.rootDir`.
Anything else is **refused and reported** — the runner never edits, never runs
off-list. If the repo has the directory named by `env.venvBinDir` (e.g. `.venv/bin`),
it is prepended to `PATH` so project tools resolve.

To change the allowlist, **edit `harness/checks.json`** — no code change. Add a
key under `checks` with its `cmd`/`args`/`timeoutMs`, or adjust `testFile` /
`diffBases` / `env`.

---

## Safety & isolation guarantees

- **Isolated context** — each sub-agent is a separate `pi` process
  (`--mode json -p --no-session`), torn down on exit. It never sees your main
  session transcript.
- **Tooling is a structural allowlist** — each sub-agent gets `write` so it can
  author its *own* output file, but `edit` is never in the `--tools` allowlist
  and there is no general shell, so it *cannot* patch source code or run
  arbitrary commands, regardless of what it's told. The handoff tells the
  Planner to write exactly two files (`memory/plan-<feature>.md` +
  `memory/tasks.md`) and the Verifier exactly one (`memory/verdict.md`).
- **No ambient config** — sub-agents run with `--no-extensions -nc --no-skills
  --no-prompt-templates --no-themes`, so they don't re-enter this extension or
  load anything unexpected. The Verifier loads **only** `runner.ts` via `-e`.
- **Parent fallback** — the parent detects (via mtime/size) whether the
  sub-agent actually wrote its file; if not, it persists the returned text. It
  always surfaces only the summary.
- **Your model, no API key** — sub-agents inherit your default model from
  `~/.pi/agent/settings.json`, using your existing pi login.

---

## Token discipline

- The expensive work (repo exploration, diff review) happens **inside** the
  sub-agent's own context and stays on disk.
- Your main session grows by only the ≤10-line summary per call.
- The methodology lives in the (stable, cache-friendly) system prompt; only the
  task/diff/index vary per call.

---

## Repo detection

Both commands walk up from your current directory looking for a folder that
contains **both** `harness/prompts/plan.md` and `memory/MEMORY.md`. That folder
is treated as the repo root; `memory/` and `git diff` run there. If you run a
command outside such a repo, it errors out with a clear message.

The methodology source files it reads:

- `AGENTS.md` (the brief, prefixed onto each sub-agent's system prompt)
- `harness/prompts/plan.md` (Planner methodology)
- `harness/prompts/verify-change.md` (Verifier methodology)
- `memory/MEMORY.md` (live index, into the first user turn)

These are **never modified** by the extension — edit them to evolve the
methodology, and both this harness and your Copilot agents stay in sync.

---

## Troubleshooting

- **"Not inside the harness repo"** — `cd` into `lm-cachebenchmarking` (or a
  subdirectory) before running the command.
- **"No memory/tasks.md to verify against"** — run `/plan` first, or create the
  plan file manually.
- **Planner/Verifier seems to hang** — real repo exploration can take a few
  minutes; the footer shows live `turn N (toolname)…` progress. In **command-mode**
  there is no artificial timeout on the sub-agent itself (only individual `run_check`
  commands have timeouts). In **tool-mode** (a model-invoked `subagent_<role>`) a
  wall-clock timeout bounds the spawn — 15 min for most roles, and the experiment's
  own `timeoutMs` + a buffer for `subagent_monitor` — after which the child is killed
  and the tool reports a timeout.
- **A test/lint tool isn't found** — ensure the project venv exists
  (`uv venv && source .venv/bin/activate`, then install test deps), or that the
  tools are on your `PATH`, or that `env.venvBinDir` in `harness/checks.json`
  points at the right bin dir.
- **Want to see the full output** — open `memory/plan-<feature>.md`,
  `memory/tasks.md`, or `memory/verdict.md`; only the summary is posted to the
  session.

---

## Files

```
harness/pi/
├── install.sh              # link/copy the engine into ~/.pi/agent/extensions/
├── shared/
│   └── subagent-core.ts    # runSubagent + the live-children shutdown guard + extractSummary (reused)
└── subagents/
    ├── index.ts            # the 6 /<role> commands AND the 6 subagent_<role> tools; shared runXRole core
    ├── userturns.ts        # pure slug + handoff + first-user-turn builders (offline-tested)
    ├── userturns.test.ts   # offline unit tests for the builders
    ├── runner.ts           # run_check / run_experiment tools (reads harness/checks.json) — loaded into the sub-agent
    └── README.md           # this file

harness/checks.json         # per-repo check definitions consumed by runner.ts
```

Installed location: `~/.pi/agent/extensions/subagents/` (a symlink to the repo
copy by default, so editing in-repo applies live). After editing either `.ts`
file, run `/reload` in pi to pick up the changes.
