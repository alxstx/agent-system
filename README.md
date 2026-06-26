# Token-minimizing agent-system (reusable starter)

A tool-agnostic harness that lets any coding agent (pi, GitHub Copilot, Cursor,
Claude Code, Codex…) do real work **without re-reading your whole repo every
session**, plus a **pi extension** that runs the **Planner → Implement → Verify**
loop as real `/plan` and `/verify` commands with context-isolated sub-agents.

**Core rule: index in context, detail on disk.** Agents load only `AGENTS.md` +
`memory/MEMORY.md` by default (a few hundred tokens); everything else is pulled
in just-in-time.

## What's in here

```
AGENTS.md                  always-on project brief (pristine template — fill it in)
CLAUDE.md                  @AGENTS.md (Claude Code entry point)
memory/                    externalized memory (templates — fill MEMORY.md first)
  ├── MEMORY.md            live index + rolling log (< 60 lines)
  ├── architecture.md      module map / data flow (on demand)
  ├── decisions.md         why-log (on demand)
  └── tasks.md             active task slice (the pi /plan agent overwrites this)
harness/
  ├── README.md            the full methodology + token-hygiene guide (read this)
  ├── prompts/*.md         canonical role prompts: bootstrap, plan, verify, implement,
  │                          triage, monitor, report, research
  ├── templates/           pristine AGENTS.template.md
  ├── checks.json          per-repo allowlist: checks (verify/checks), boundaries
  │                          (command-guard), experiments (/monitor), autoJudge (auto-judge)
  ├── redaction.json       (optional) secret-redaction pattern overrides
  ├── mcp.example.json     MCP template (arXiv via pi-mcp-adapter) — copy to .pi/mcp.json
  ├── examples/            checks.python-lmcache.json — a complete worked example
  └── pi/
      ├── install.sh       installs EVERY harness/pi/<ext> + shared/ into pi
      ├── shared/          checks-core.ts + redact.ts (one allowlist, one redactor)
      ├── subagents/       the engine: /plan /verify /triage /monitor /report /research
      │                          + model-callable subagent_* tools + /<role>-main modes (dual-mode)
      ├── command-guard/   blocks destructive bash + boundary writes (+ /guard toggle)
      ├── secret-redaction/ scrubs secrets from main-session tool output
      ├── checks/          /checks — run the allowlist inline (no sub-agent, no tokens)
      ├── boundary-instructions/  steers .github/instructions/ rules on matching edits
      ├── auto-judge/      optional LLM-as-judge gate on guarded tool calls (/autojudge; off by default)
      ├── delegate/        optional model-callable isolated READ-ONLY sub-agent (Task-tool analog; opt-in)
      └── workflow/        optional model-callable governed parallel fan-out of read-only workers (opt-in)
.github/
  ├── copilot-instructions.md, prompts/*.prompt.md, instructions/*.md  (Copilot wiring)
```

## Install pi (one-time, per machine)

The `/plan` and `/verify` commands run on **pi** — a minimal, self-extensible
coding-agent CLI ([`earendil-works/pi`](https://github.com/earendil-works/pi)).
Skip this section if you only want the markdown harness (it works with any agent,
no pi required); do it if you want the real sub-agent commands.

1. **Prerequisite:** Node.js **≥ 22.19.0** (`node -v` to check).
2. **Install the `pi` binary** (global) — either:
   ```bash
   npm install -g --ignore-scripts @earendil-works/pi-coding-agent
   # …or, on macOS / Linux:
   curl -fsSL https://pi.dev/install.sh | sh
   ```
3. **Authenticate.** Launch `pi`, then use a subscription login (GitHub Copilot
   works for the model selections below) or provide provider API keys:
   ```bash
   export ANTHROPIC_API_KEY=sk-ant-...   # or OPENAI_API_KEY, GEMINI_API_KEY, …
   pi
   ```
   …or run `/login` inside pi (Claude Pro/Max, ChatGPT Plus/Pro, or GitHub
   Copilot). Credentials live in `~/.pi/agent/auth.json`; settings in
   `~/.pi/agent/settings.json`.
4. **Confirm model selections** with `pi --list-models`, then pick a model inside
   pi with `/model` (or `Ctrl+L`).

`pi` is now on your `PATH`. Full docs: <https://pi.dev/docs/latest>.

## Install this harness into your repo (end-to-end)

1. **Drop it in.** Copy `AGENTS.md`, `CLAUDE.md`, `memory/`, `harness/`, and (for
   Copilot) `.github/` into your repo root.

2. **Fill the brief.** Edit `AGENTS.md` (replace the `{{...}}` placeholders) and
   `memory/MEMORY.md`, or let an agent do it: run `/bootstrap-fill` (Copilot/pi)
   or paste `harness/prompts/1-bootstrap-fill.md`, then `/bootstrap-verify`.

3. **Configure the checks.** Edit `harness/checks.json` to list **your** project's
   checks (test, lint, typecheck…). See `harness/examples/checks.python-lmcache.json`
   for a full Python example. With no edits you still get the universal git checks.

4. **Install the pi extensions.** Run `harness/pi/install.sh` once per machine — it
   symlinks **every** `harness/pi/<ext>/` (subagents, command-guard, secret-redaction,
   checks, boundary-instructions, auto-judge) plus `shared/` into `~/.pi/agent/extensions/`
   (override with `PI_EXTENSIONS_DIR`; `--copy` to copy instead of symlink, which also
   copies `shared/`). Open pi in the repo, run `/reload`.

5. **(Optional) extra capabilities.** `/research` needs web tools and the arXiv MCP needs
   the adapter:
   ```bash
   pi install npm:pi-web-access          # web_search + fetch_content for /research
   pi install npm:pi-mcp-adapter         # MCP support
   uv tool install 'arxiv-mcp-server[pdf]'   # the one in-scope MCP (arXiv)
   cp harness/mcp.example.json .pi/mcp.json  # enable it (project-local)
   pi install git:github.com/DietrichGebert/ponytail   # reuse-discipline extension (/ponytail*)
   ```

## Commands & extensions

**Sub-agent roles** (each = an isolated `pi` subprocess, no general shell, writes ONE
`memory/` file, returns only a ≤10-line SUMMARY):

- **`/plan <feature> <task>`** — durable roadmap `memory/plan-<feature>.md` + next slice `memory/tasks.md`.
- **`/verify [feature] [note]`** — judges the diff vs plan+slice, runs only allowlisted checks, writes `memory/verdict.md` → PASS/FAIL.
- **`/triage [<log>] [note]`** — ranks root-cause hypotheses + one next probe → `memory/triage-<id>.md`.
- **`/monitor <experiment> [note]`** — runs an allowlisted experiment, watches for errors, tees a redacted per-run log → `memory/monitor-<run>.md` (OK/ERROR).
- **`/report <subject> [--for=team|paper|self]`** — composes an audience-facing document from artifacts → `memory/reports/<subject>-<date>.md`.
- **`/research <topic> <question>`** — web-researches a cited, claim-checked note → `memory/research-<topic>.md` (needs `pi install npm:pi-web-access`).

Reviewing agents (`/verify`) run on **GPT-5.5**; all others on **Opus 4.8**; both at `xhigh`
thinking, resolved through the **GitHub Copilot** login (`github-copilot/<id>`). After authenticating
pi, these are just model selections; confirm the exact ids with `pi --list-models`.

**Each role is reachable three ways (dual-mode):** ① the **`/<role>`** command above (operator); ② the
*running model* can call the role mid-turn via its namespaced **`subagent_<role>`** tool — the summary
returns in the **same turn** (artifact still on disk); ③ **`/<role>-main on|off`** runs the *main*
session under that role's methodology (clamps the tool surface + injects the role body; `monitor`/
`research`-main spawn the isolated sub-agent instead). When an armed `auto-judge` is on, each model-driven
`subagent_*` spawn is judged. See `harness/pi/subagents/README.md`.

**Model-callable sub-agent tools** (opt-in; the *model* invokes these, not you):

- **delegate** — the model spawns ONE isolated **read-only** sub-agent (`read,grep,find,ls`) with a prompt
  it chooses and gets raw text back — the pi analog of Claude Code's Task/Agent tool. Opt-in via a
  `delegate` block in `checks.json`; per-request cap + confirm-on-spawn (or the `auto-judge` gate headless).
- **workflow** — the model fans ONE objective out to N isolated read-only workers (a **governed** parallel
  batch: a right-sizer prunes overlap, a hard cap is the cost kill-switch), writing each redacted result
  under `memory/workflow/<run>/` and returning a compact index. Opt-in via a `workflow` block.

**Main-session extensions** (govern the human-driven session; sub-agents are immune):

- **command-guard** — blocks destructive bash + writes into `checks.json` `boundaries`; `/guard on|off` overrides.
- **secret-redaction** — scrubs secret-shaped strings from tool output before the model sees them.
- **`/checks [name]`** — runs the `checks.json` allowlist inline (no sub-agent, no tokens) → green/red widget.
- **boundary-instructions** — surfaces `.github/instructions/*.instructions.md` rules when a matching file is edited.
- **auto-judge** *(optional, off by default)* — an LLM-as-judge gate: when armed (`/autojudge on`) and a `checks.json` `autoJudge` block is present, a judge model must `ALLOW`/`DENY` each guarded tool call before it runs, fail-closed. Guards `bash`/`write`/`edit` by default; the shipped config also gates the **model-driven spawn tools** — `delegate`, `workflow`, and the six `subagent_*` role tools (their headless gate). Each call spawns a judge subprocess and blocks until it replies — opt-in per session. Main-session only (sub-agents are immune).

**Optional companion — [ponytail](https://github.com/DietrichGebert/ponytail)** (`pi install git:github.com/DietrichGebert/ponytail`): a "lazy senior dev" reuse-ladder enforcer (YAGNI → stdlib → platform → installed dep → one-liner → minimum). Adds `/ponytail lite|full|ultra|off`, `/ponytail-review` (prune a diff), `/ponytail-audit` (prune the repo). The same ladder is baked into `AGENTS.md` ("Build discipline") so every tool and sub-agent already follows it; the extension adds live, toggleable enforcement in the pi main session (always-on at the chosen level — `lite` cheap, `off` free; doesn't reach the `--no-extensions` sub-agents). Referenced upstream, not vendored.

Only the short summaries cross back into your main session — the expensive
repo-reading stays inside the sub-agents and on disk.

## Using the system (a typical session)

Open `pi` in your harnessed repo. A normal feature loop:

```text
# 1. Plan — an isolated agent explores and writes the roadmap + the next slice.
/plan health-endpoint add a /health route to the operator HTTP server
      → memory/plan-health-endpoint.md (durable) + memory/tasks.md (this slice)
      → you review/edit those two files

# 2. Implement — ordinary work in your main session (full tools). command-guard and
#    secret-redaction are watching: a stray `rm -rf` or a write into a boundary path is
#    blocked (run /guard off to override); secrets in tool output are [REDACTED].
#    Editing a file covered by .github/instructions/*.instructions.md surfaces that rule.

# 3. Preflight — run the project checks inline, no sub-agent, no tokens.
/checks                 # all project checks → green/red widget
/checks lint            # just one

# 4. Verify — an adversarial GPT-5.5 agent judges the diff vs the plan + slice.
/verify                 # → memory/verdict.md, PASS / PASS WITH NITS / FAIL

# 5. (optional) Run + watch an experiment, then write it up.
/monitor smoke-bench    # → memory/monitor-<run>.md (OK/ERROR) + memory/runs/<run>.log
/report health-endpoint --for=team
                        # → memory/reports/health-endpoint-<date>.md

# When something breaks, or you have an open question:
/triage logs/run_4412.txt only started failing today   # → memory/triage-<id>.md
/research zod is zod or valibot smaller for a client bundle?  # → memory/research-zod.md
```

**When to reach for which:**

| You want to… | Use | Writes |
|---|---|---|
| Plan a feature / next slice | `/plan <feature> <task>` | `memory/plan-<feature>.md` + `tasks.md` |
| Sanity-check before review | `/checks [name]` | (UI only) |
| Adversarially review a change | `/verify [feature] [note]` | `memory/verdict.md` |
| Diagnose a failing run | `/triage [<log>] [note]` | `memory/triage-<id>.md` |
| Run + watch an experiment | `/monitor <experiment> [note]` | `memory/monitor-<run>.md` (+ log) |
| Write it up for an audience | `/report <subject> [--for=…]` | `memory/reports/<subject>-<date>.md` |
| Research a web question | `/research <topic> <question>` | `memory/research-<topic>.md` |
| Run the main session under a role | `/<role>-main on\|off` | (in-session methodology + tool clamp) |
| Toggle the destructive-command guard | `/guard on\|off` | (session state) |
| Toggle the LLM-as-judge gate (opt-in) | `/autojudge on\|off` | (session state) |

### Configure it (all per-repo, no code changes)

- **`harness/checks.json`** — the per-repo allowlists + opt-in tool blocks the engine reads at run time:
  - `checks` / `testFile` — the commands `/verify`'s `run_check` and `/checks` may run (fixed argv, `shell:false`).
  - `boundaries` — JS regexes (repo-root-relative) of paths **command-guard** blocks writes into. Keep in sync with AGENTS.md's "Boundaries" prose.
  - `experiments` — the closed allowlist of long-lived runs `/monitor` may launch.
  - `autoJudge` (optional) — config for the **auto-judge** LLM gate: `judgeModel`, `guardedTools`, `failClosed`, `timeoutMs`, `contextDiff`, `policy`. Dormant unless present **and** armed via `/autojudge on`; see the `$autoJudge-note` in `checks.json`.
  - `delegate` (optional) — opts in + configures the **delegate** model-callable tool: `maxCallsPerRequest`, `confirmOnSpawn`, `model`/`effort`, `capBytes`. Present (even `{}`) = active; absent = inert. See the `$delegate-note`.
  - `workflow` (optional) — opts in + configures the **workflow** fan-out: `maxParallel` (cap), `concurrency`, `maxWorkflowsPerRequest`, the right-sizer (`useJudge`/`judgeThreshold`/`judgeModel`), `synthesize`, `maxResultBytes`, `timeoutMs`. See the `$workflow-note`.
  - `blamePathRegex` (optional) — tightens `/triage`'s `git-blame` path validation.
  See `harness/examples/checks.python-lmcache.json` for a full worked example.
- **`harness/redaction.json`** (optional) — `{ replacement, extraPatterns, disableDefault }` to tune what secret-redaction (and the `/monitor` log tee) scrub.
- **`.github/instructions/*.instructions.md`** — path-scoped rules (`applyTo:` glob in frontmatter) that boundary-instructions surfaces when a matching file is edited.
- **`.pi/mcp.json`** (copy of `harness/mcp.example.json`) — enables the arXiv MCP.

### Requirements & models

- pi on **Node ≥ 22.19**; install the extensions with `harness/pi/install.sh`, then `/reload`.
- Reviewing agents (`/verify`) run on **GPT-5.5**; all other roles run on **Opus 4.8**.
  Authenticate pi first (GitHub Copilot subscription login is enough when those models are listed),
  then treat `github-copilot/claude-opus-4.8` and `github-copilot/gpt-5.5` as model selections to confirm with
  `pi --list-models`. Change the ids in one place: the `MODEL_DEFAULT` / `MODEL_REVIEW`
  constants in `harness/pi/shared/subagent-core.ts`.
- `/research` needs `pi install npm:pi-web-access`; the arXiv MCP needs `pi install npm:pi-mcp-adapter`
  + `uv tool install 'arxiv-mcp-server[pdf]'`.

> Verifying a fresh build? Hand `VERIFICATION-AGENT-PROMPT.md` to an independent agent on an
> authenticated pi — it re-runs the structural checks **and** the live model-driven FLAG tests.

## How it stays generic

The pi engine code (`harness/pi/subagents/`) contains **no project-specific
commands**. Everything project-specific lives in `harness/checks.json`, which the
engine reads at run time. One installed engine serves every repo that ships a
`harness/` skeleton + `harness/checks.json` — adapt a new project by editing JSON,
never code.

See `harness/README.md` for the full methodology, token-hygiene rules, and
per-tool wiring, and `harness/pi/subagents/README.md` for the engine internals,
the `run_check` security model, and the `checks.json` schema.
