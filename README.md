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
  ├── prompts/*.md         canonical role prompts: bootstrap, plan, verify, implement
  ├── templates/           pristine AGENTS.template.md
  ├── checks.json          per-repo allowlist of commands the /verify agent may run
  ├── examples/            checks.python-lmcache.json — a complete worked example
  └── pi/
      ├── install.sh       install the /plan + /verify engine into pi
      └── subagents/       the generic engine (index.ts + runner.ts + README.md)
.github/
  ├── copilot-instructions.md, prompts/*.prompt.md, instructions/*.md  (Copilot wiring)
```

## Quick start (3 steps)

1. **Drop it in.** Copy `AGENTS.md`, `CLAUDE.md`, `memory/`, `harness/`, and (for
   Copilot) `.github/` into your repo root.

2. **Fill the brief.** Edit `AGENTS.md` (replace the `{{...}}` placeholders) and
   `memory/MEMORY.md`, or let an agent do it: run `/bootstrap-fill` (Copilot/pi)
   or paste `harness/prompts/1-bootstrap-fill.md`, then `/bootstrap-verify`.

3. **Configure & install the pi engine.**
   - Edit `harness/checks.json` to list **your** project's checks (test, lint,
     typecheck…). See `harness/examples/checks.python-lmcache.json` for a full
     Python example. With no edits you still get the universal git checks.
   - Run `harness/pi/install.sh` once per machine. Open pi in the repo, `/reload`,
     then use `/plan <feature> <task>` and `/verify`.

## The workflow

- **`/plan <feature> <task>`** — Planner sub-agent (isolated `pi` process, no
  shell, no `edit`) explores the repo and writes the durable roadmap
  `memory/plan-<feature>.md` + the next slice `memory/tasks.md`; returns a
  ≤10-line summary.
- **Implement** — ordinary work in your main session, following `memory/tasks.md`.
- **`/verify`** — Verifier sub-agent judges the diff against the plan + slice,
  runs only the allowlisted checks from `harness/checks.json`, writes
  `memory/verdict.md`, returns PASS/FAIL + a ≤10-line summary.

Only the short summaries cross back into your main session — the expensive
repo-reading stays inside the sub-agents and on disk.

## How it stays generic

The pi engine code (`harness/pi/subagents/`) contains **no project-specific
commands**. Everything project-specific lives in `harness/checks.json`, which the
engine reads at run time. One installed engine serves every repo that ships a
`harness/` skeleton + `harness/checks.json` — adapt a new project by editing JSON,
never code.

See `harness/README.md` for the full methodology, token-hygiene rules, and
per-tool wiring, and `harness/pi/subagents/README.md` for the engine internals,
the `run_check` security model, and the `checks.json` schema.
