# Token-minimizing harness (tool-agnostic)

A thin set of markdown files that lets any coding agent (Copilot, Cursor, Claude Code, Codex…) do implementation work **without re-reading your whole repo every session**. It keeps a tiny always-loaded brief plus a live memory index in context, and pushes everything else to files loaded on demand.

**Core rule: index in context, detail on disk.** The only files an agent loads by default are `AGENTS.md` and `memory/MEMORY.md` (a few hundred tokens). Everything else is pulled in just-in-time.

## The flow — one-time bootstrap, then repeatable use
1. **Drop** the harness into a repo: copy `AGENTS.md`, `memory/`, `harness/`, and — for Copilot — `.github/`.
2. **Fill** — run `/bootstrap-fill` or paste `harness/prompts/1-bootstrap-fill.md`. An agent reads the repo and fills `AGENTS.md` + seeds `memory/`.
3. **Verify** — run `/bootstrap-verify` or paste `harness/prompts/2-bootstrap-verify.md`. A second agent checks the filled harness against the real repo and flags/fixes errors.
4. **Hand-verify** — skim the report; fix anything marked `(?)`, `✗`, or `⚠`. ~5 minutes.
5. **Use** — per task: `/plan` → `/verify-plan` *(optional plan review)* → *(you approve)* → `/implement` → `/verify-change`. Memory updates as you go.

`/verify-plan` is invocation-only: fire it when you want a second agent to vet the **plan** (before any code) the way `/verify-change` vets a **diff** (after the code). It never dings the plan for missing implementation — that's by design at the planning stage.

## File map
| File | Loaded | Purpose |
|---|---|---|
| `AGENTS.md` | **always** | Project brief + operating contract. The filled template. < 200 lines. |
| `memory/MEMORY.md` | **always** | Live state + index: current focus, recent changes, gotchas, pointers. < 60 lines. |
| `memory/architecture.md` | on demand | Module map, data flow, key abstractions, glossary. |
| `memory/decisions.md` | on demand | Why-log (ADR-lite). |
| `memory/tasks.md` | on demand | Active plan & progress. Survives context resets. |
| `harness/prompts/*.md` | invoked | Canonical prompts: fill, verify, plan, verify-plan, implement, verify-change. |
| `harness/checks.json` | by Verifier | Per-repo allowlist of verification commands the pi `/verify` sub-agent may run. |
| `harness/pi/` | installed | pi extension (`subagents/` + `install.sh`) exposing `/plan` + `/verify` as real, context-isolated sub-agents. |
| `.github/prompts/*.prompt.md` | invoked | Copilot slash commands (`/plan`, `/implement`, …) that call the canonical prompts. |
| `.github/instructions/*.instructions.md` | path-scoped | Rules that load only for files matching `applyTo`. |
| `harness/templates/*` | reference | Pristine `AGENTS.template.md` for re-bootstrapping. |

## Principles
The harness is just the delivery mechanism for a few context-engineering ideas:
1. **Progressive disclosure** — keep an *index* in context (`AGENTS.md`, `MEMORY.md`); load detail (`architecture.md`, a source file) only when the task needs it. Dozens of on-demand files cost nothing until opened.
2. **Right altitude** — `AGENTS.md` is concrete enough to act on ("handlers in `src/api/handlers/`") yet short enough to stay cheap. Not a wall of edge cases; not vague platitudes.
3. **Externalized memory** — the agent writes durable facts to `memory/` and reads them back later, instead of holding everything in a context window that resets every session.
4. **Invocation over always-on** — the "agents" are prompts you fire (`/plan`, `/verify-change`), each doing focused work, instead of agent definitions that load on every message. *(On pi, a few are now **model-invoked** too — the running model can call `subagent_<role>` or the read-only `delegate` tool mid-turn — but these are still focused, isolated, torn-down spawns, not always-on agent files; they're opt-in and return a short result.)*
5. **Determinism where it belongs** — "always run tests / lint" lives in CI or a hook, not in prose the model has to remember.

## How it saves tokens
- A blank harness costs ~700 always-on tokens; filled, it stays under ~2K (`AGENTS.md` < 200 lines, `MEMORY.md` < 60). Contrast with frameworks that ship 20–100+ always-on agent files — one shipped ~300K tokens loaded on *every* message.
- The expensive work (reading the repo, verifying a diff) happens inside one invoked prompt and returns a short result, instead of accumulating in your main session.
- You stop paying the "re-discover the codebase" tax each session: the map already lives in `AGENTS.md` + `memory/`.

## Wiring it into your tool
- **GitHub Copilot** — `AGENTS.md` is read natively, and `.github/copilot-instructions.md` forces memory-first behavior. Slash commands ship in `.github/prompts/` — `/plan`, `/verify-plan`, `/implement`, `/verify-change`, `/bootstrap-fill`, `/bootstrap-verify` (thin wrappers that call the canonical `harness/prompts/*.md`). For narrow rules that cost no tokens elsewhere, see `.github/instructions/example.instructions.md` (`applyTo:` globs).
- **Cursor** — add a `.cursor/rules/*.mdc` (or `.cursorrules`) that says "read `AGENTS.md` and `memory/MEMORY.md` first."
- **Claude Code** — add a `CLAUDE.md` containing `@AGENTS.md`; its native auto-memory can supplement `memory/`.
- **pi** — install the bundled extension once with `harness/pi/install.sh`. It adds real `/plan` and `/verify` commands that spawn **context-isolated sub-agents** (separate `pi` processes): the Planner writes `memory/plan-<feature>.md` + `memory/tasks.md`, the Verifier judges the diff and writes `memory/verdict.md`, and only a ≤10-line summary returns to your main session. The engine is generic — it reads each repo's `harness/checks.json` for the checks the Verifier may run, so one install serves every harnessed repo. See `harness/pi/subagents/README.md`.
- **Any tool** — plain markdown: paste the prompt, attach `AGENTS.md` + `memory/MEMORY.md` as context.
- **Reuse discipline (ponytail)** — the reuse-ladder in `AGENTS.md` ("Build discipline") is always-on for every tool *and* every sub-agent, so the discipline travels with the brief. On pi you can additionally install the upstream [ponytail](https://github.com/DietrichGebert/ponytail) extension for live, toggleable enforcement: `pi install git:github.com/DietrichGebert/ponytail`, then `/ponytail lite|full|ultra|off`, `/ponytail-review` (prune a diff), `/ponytail-audit` (prune the repo). It injects its ruleset into the main-session system prompt while active — a real per-turn token cost at the chosen level (`lite` is the cheap default; `off` is free) — and, like all pi extensions, it does **not** reach the `--no-extensions` sub-agents (`/plan`, `/verify`, `/implement`); those rely on the baked-in `AGENTS.md` ladder. Referenced, not vendored: see `memory/decisions.md`.
- **Tool-call gate (auto-judge, optional)** — on pi, `harness/pi/auto-judge` adds an LLM-as-judge gate over the main session: when armed (`/autojudge on`; **OFF by default**) and a `harness/checks.json` `autoJudge` block is present, a judge model (the GPT-5.5 review class) must `ALLOW`/`DENY` each guarded tool call (bash/write/edit) before it runs, fail-closed. It spawns a judge subprocess and blocks the session per guarded call, so it's opt-in. Main-session only — sub-agents run `--no-extensions`. See the `$autoJudge-note` in `harness/checks.json` and the roadmap in `memory/plan-llmjudge.md`.
- **Model-callable subagent (delegate, optional)** — on pi, `harness/pi/delegate` adds a `delegate` tool the **main-session model** can call mid-turn to spawn one isolated, **read-only** subagent (`read,grep,find,ls`) that investigates a self-contained subtask and returns its findings as text — the pi analog of Claude Code's Task/Agent tool, and the free-prompt, general-purpose complement to the fixed-role `/plan`…`/research` commands. Opt-in per repo via a `delegate` block in `harness/checks.json` (absent ⇒ inert). Read-only (no mutation), a per-request spawn cap, and confirm-on-spawn when interactive bound the cost; for **headless** runs (no confirm) add `"delegate"` to `autoJudge.guardedTools` and arm `/autojudge`. Out-of-repo reads can't be path-jailed and the returned text is untrusted **data** — both documented residuals. Workers run `--no-extensions`, so recursion is bounded. See the `$delegate-note` in `harness/checks.json` and the roadmap in `memory/plan-general-subagent.md`.
- **Governed parallel fan-out (workflow, optional)** — on pi, `harness/pi/workflow` adds a `workflow` tool the model calls with an `objective` + `tasks[]`; it **right-sizes** the fan-out (a hard cap plus an optional LLM right-sizer that prunes/merges overlapping tasks) and runs the kept tasks as several isolated **read-only** subagents at once, writing each result (redacted at the source) under `memory/workflow/<runId>/` and returning a compact index. The minimal local analog of the cloud Workflow tool — `delegate` is one worker, `workflow` is a *governed batch* of them. Opt-in via a `workflow` block (absent ⇒ inert). The right-sizer is a **cost** gate (prunes overlap, fails open), not a safety gate; a hard cap + concurrency pool + per-request cap + confirm bound the spend, and `"workflow"` in `autoJudge.guardedTools` gates the spawn. Same read-only / out-of-repo-read / untrusted-data residuals as delegate. See the `$workflow-note` in `harness/checks.json` and `memory/plan-workflow.md`.

## Customizing
- **Add a role:** drop a new `harness/prompts/<role>.md`, plus (Copilot) a `.github/prompts/<role>.prompt.md` wrapper. Resist adding always-on agents.
- **Narrow rules:** put file-type/folder-specific rules in `.github/instructions/*.instructions.md` with an `applyTo:` glob — they load only for matching files. See `example.instructions.md`.
- **Split memory:** if a topic file grows big, split it and add a one-line pointer in `MEMORY.md`. The index stays small; the shelves get deeper.

## Keeping it cheap (token hygiene)
- Keep `AGENTS.md` < 200 lines and `memory/MEMORY.md` < 60. If they grow, move detail to topic files.
- Update memory in small increments during work; prune the index — it's a rotating log, not an archive.
- Cite `path:line`; don't paste big code into memory.
- Anything that "must happen every time" (run tests, lint) belongs in CI or a tool hook, not in prose the model has to remember.

## Maintenance
- Treat `MEMORY.md` as a rotating log — prune it when it crosses ~60 lines.
- Re-run `/bootstrap-verify` after a big refactor; the map drifts as the code moves.
- Periodically scan `AGENTS.md` and `memory/` for contradictions — conflicting instructions make an agent pick arbitrarily.

## FAQ
- **Isn't more memory better?** No — more *findable* memory is better. A bloated always-on file degrades adherence and costs tokens every turn. Keep the index small, the shelves deep.
- **Why not one big `AGENTS.md` with everything?** It loads in full every session. Past ~200 lines, adherence drops and cost rises. Push detail to on-demand files.
- **Does this lock me to Copilot?** No. The core is plain markdown; `.github/` is the only Copilot-specific part, and `AGENTS.md` is read by most agents.
- **Do I need git hooks / CI?** Optional but recommended for "always run" steps — it keeps them out of the token budget and enforces them regardless of what the model decides.

## Tag
The harness is marked `token-harness v0.1` at the top of `AGENTS.md` and `harness/templates/AGENTS.template.md`, so you can tell a repo is harnessed and which version it's on. Bump it when you change the template.
