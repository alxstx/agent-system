# Prompt — Independent Verification Agent

Hand the block below to a FRESH agent (no shared context) running where a **live, authenticated pi**
is available. Unlike the build environment (which had no pi login/model access), this agent can run the
model-driven tests — so it must actually exercise the live-pi FLAG items, not just the offline ones.

---

You are an INDEPENDENT verification agent with NO shared context. A pi (earendil-works/pi-coding-agent)
extension suite was built on branch `feat/roles-and-extensions` of `github.com/alxstx/agent-system`.
Your job: verify it END-TO-END on a live, authenticated pi and return a verdict. Do NOT trust the
author's self-report (`BUILD-REPORT.md`) — re-run things yourself and ground every conclusion in
something you actually ran or read (cite `file:line` or paste the command + output).

## Setup (do this first; report any step that fails)
1. **Toolchain:** Node **≥ 22.19** (`node -v`), pi installed (`pi --version`), TypeScript available.
2. **Get the code:** clone the repo (or `cd` into it), `git checkout feat/roles-and-extensions`.
3. **pi auth (REQUIRED for the live tests):** authenticate pi first — GitHub Copilot via `/login`
   is sufficient when it exposes the target models. Then run `pi --list-models` and record whether
   `github-copilot/claude-opus-4.8` (for /plan /triage /monitor /report /research) and `github-copilot/gpt-5.5` (for
   /verify) are listed as selectable models (FLAG #2). If those exact ids differ, update only the
   constants in `harness/pi/shared/subagent-core.ts`.
4. **Optional capabilities** (needed for /research + MCP tests): `pi install npm:pi-web-access`,
   `pi install npm:pi-mcp-adapter`, `uv tool install 'arxiv-mcp-server[pdf]'`,
   `cp harness/mcp.example.json .pi/mcp.json`.
5. **Type-check deps:** `cd harness/pi && npm install && npm run typecheck` (must be tsc-clean).
6. **Install the extensions:** `harness/pi/install.sh` (test `--copy` too); open pi in the repo, `/reload`.

## A. Offline / structural checks (re-run; don't trust the report)
1. `cd harness/pi && npm run typecheck` → **tsc --noEmit clean** (zero diagnostics).
2. **Security invariants:** no sub-agent role grants `bash`/`edit`/`shell` (grep the `tools:` strings in
   `harness/pi/subagents/index.ts`); `runner.ts` has exactly ONE `export default` that registers BOTH
   `run_check` and `registerRunExperiment` (helpers, never a second default export); confirm one `-e
   runner.ts` exposes both tools AND that a repo with no `experiments` registers `run_check` only.
3. **Redaction at the source:** confirm `/monitor`'s log is scrubbed by the runner (`runFixedTee` in
   `harness/pi/shared/checks-core.ts`), NOT a main-session hook; one shared `redact()` in
   `harness/pi/shared/redact.ts` with a capture-group-preserving `Authorization:` rule.
4. **Repo-root-relative path matching:** read command-guard + boundary-instructions — both match the
   target RELATIVE TO THE REPO ROOT, not `ctx.cwd`.
5. **Commits & hygiene:** atomic commits on the branch; no real secrets in committed code (the
   `AKIAIOSFODNN7EXAMPLE`/`ghp_0123…` fixtures in `tmp/agent-system-plan/` are AWS's public example key
   + obvious fakes — not real); `node_modules`/lockfile/`.pi/` are gitignored.

## B. LIVE pi tests — the FLAG items the build could NOT run (run these for real)
For each, paste the invocation and what you observed; do NOT mark verified unless you ran it live.
1. **/plan + /verify models (FLAG #1, #2):** run `/plan demo add a hello function`, then `/verify`.
   Confirm `/verify` runs on **GPT-5.5** and `/plan` on **Opus 4.8** (check the model in the subprocess
   footer/output; if a model id is wrong, the fix is the `MODEL_DEFAULT`/`MODEL_REVIEW` constants at the
   top of `index.ts`). Confirm `/plan` writes `memory/plan-demo.md` + `memory/tasks.md` and `/verify`
   writes `memory/verdict.md` and returns PASS/FAIL.
3. **--append-system-prompt (FLAG #1):** confirm `/plan` actually follows the `harness/prompts/plan.md`
   methodology (it should produce the Goal/Files/Plan/Test-plan structure), proving the brief reaches the model.
4. **/triage:** paste a failing stderr → confirm a ranked hypothesis SUMMARY + `memory/triage-*.md`, and
   that it used read-only probes (git-blame/env-dump) via run_check, never a shell.
5. **/monitor:** add a real `experiments` entry to `harness/checks.json` (or use a harmless one), run
   `/monitor <name>` → confirm `memory/monitor-*.md` + `memory/runs/<runId>.log`; run it TWICE → two
   distinct logs (no clobber); make the experiment print a fake token (e.g. `AKIA…`) → confirm it shows
   `[REDACTED]` in BOTH the transcript AND the on-disk log.
6. **/report:** after a /monitor or /verify, run `/report <subject> --for=team` → confirm a real
   document in `memory/reports/<subject>-<date>.md` (cited, with a Limitations section) and a teaser SUMMARY.
7. **/research web_search (FLAG #3):** run `/research <topic> <a real question>` → confirm it actually
   calls `web_search`/`fetch_content` and writes a cited `memory/research-<topic>.md`. If it can't search,
   the hint should point to `pi install npm:pi-web-access`.
8. **command-guard (FLAG #6):** ask pi to `rm -rf build/` → BLOCKED with the reason; `/guard off` → it
   proceeds; `/guard on` → blocked again. Ask it to write `migrations/0001.sql` (a boundary) → BLOCKED;
   **launch pi from inside a subdirectory and repeat** → still BLOCKED (repo-root-relative).
9. **secret-redaction (FLAG, main session):** have pi run a command that prints `AKIA…` + an
   `Authorization: Bearer …` header → values `[REDACTED]` in the transcript, header name preserved; a
   plain git SHA / base64 NOT redacted.
10. **boundary-instructions (FLAG #5 — the important one):** edit a file matching
    `.github/instructions/example.instructions.md`'s `applyTo` (`src/api/**/*.ts`). Determine whether the
    steered rule reaches the model **BEFORE** the edit lands. If `deliverAs:"steer"` does NOT arrive in
    time, recommend switching the handler to `{ block: true, reason: <rule text> }` (the documented
    fallback in `harness/pi/boundary-instructions/index.ts`).
11. **/checks (FLAG #4):** `/checks` shows a green/red widget; start a long check and press Esc →
    determine whether `ctx.signal` cancels it mid-run (graceful no-op if not).
12. **MCP arXiv (FLAG #7):** with `.pi/mcp.json` in place, `/mcp` lists `arxiv`; ask the model to find a
    paper → confirm it calls the arXiv server (search_papers).

## Output
A one-line verdict **APPROVE** / **APPROVE WITH NITS** / **REVISE**, then a findings list — each with
`file:line`, severity (blocker/major/nit), what's wrong, and a concrete fix. For every live test in §B,
state exactly what you ran and what you observed. Do NOT approve any FLAG item you did not actually run.
Be specific and adversarial — this is the gate before the system is relied on.
