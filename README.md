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
  │                          (command-guard), experiments (/monitor)
  ├── redaction.json       (optional) secret-redaction pattern overrides
  ├── mcp.example.json     MCP template (arXiv via pi-mcp-adapter) — copy to .pi/mcp.json
  ├── examples/            checks.python-lmcache.json — a complete worked example
  └── pi/
      ├── install.sh       installs EVERY harness/pi/<ext> + shared/ into pi
      ├── shared/          checks-core.ts + redact.ts (one allowlist, one redactor)
      ├── subagents/       the engine: /plan /verify /triage /monitor /report /research
      ├── command-guard/   blocks destructive bash + boundary writes (+ /guard toggle)
      ├── secret-redaction/ scrubs secrets from main-session tool output
      ├── checks/          /checks — run the allowlist inline (no sub-agent, no tokens)
      └── boundary-instructions/  steers .github/instructions/ rules on matching edits
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
3. **Authenticate.** Launch `pi`, then provide a provider API key *or* use a
   subscription login:
   ```bash
   export ANTHROPIC_API_KEY=sk-ant-...   # or OPENAI_API_KEY, GEMINI_API_KEY, …
   pi
   ```
   …or run `/login` inside pi (Claude Pro/Max, ChatGPT Plus/Pro, or GitHub
   Copilot). Credentials live in `~/.pi/agent/auth.json`; settings in
   `~/.pi/agent/settings.json`.
4. **Pick a model** inside pi with `/model` (or `Ctrl+L`).

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
   checks, boundary-instructions) plus `shared/` into `~/.pi/agent/extensions/`
   (override with `PI_EXTENSIONS_DIR`; `--copy` to copy instead of symlink, which also
   copies `shared/`). Open pi in the repo, run `/reload`.

5. **(Optional) extra capabilities.** `/research` needs web tools and the arXiv MCP needs
   the adapter:
   ```bash
   pi install npm:pi-web-access          # web_search + fetch_content for /research
   pi install npm:pi-mcp-adapter         # MCP support
   uv tool install 'arxiv-mcp-server[pdf]'   # the one in-scope MCP (arXiv)
   cp harness/mcp.example.json .pi/mcp.json  # enable it (project-local)
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
thinking. GPT-5.5 needs the OpenAI provider authenticated in pi (else `/verify` errors).

**Main-session extensions** (govern the human-driven session; sub-agents are immune):

- **command-guard** — blocks destructive bash + writes into `checks.json` `boundaries`; `/guard on|off` overrides.
- **secret-redaction** — scrubs secret-shaped strings from tool output before the model sees them.
- **`/checks [name]`** — runs the `checks.json` allowlist inline (no sub-agent, no tokens) → green/red widget.
- **boundary-instructions** — surfaces `.github/instructions/*.instructions.md` rules when a matching file is edited.

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
