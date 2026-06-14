# Implementation brief — build the agent-system sub-agent/extension plan, verify against live pi, then self-review

You are an implementation agent. Build the work specified in the plan, **verify every live-pi FLAG item against a real running pi (don't assume — test)**, keep the repo green with small reversible commits, and as your **final step launch an independent reviewer** (brief in §REVIEW). You have a shell, git, filesystem read/write, npm, and the ability to spawn a fresh sub-agent/agent session.

## Sources (read first, fully)
- **The spec (authoritative):** `/tmp/agent-system-plan/IMPLEMENTATION-PLAN.md`. Its **"Verification status"** note records 12 review rounds of settled decisions — treat them as DECIDED; do not re-litigate.
- **Companion design docs (rationale + skeletons):** same dir — `monitor-design.md`, `report-design.md`, `roles-elaborated.md` (`/triage`+`/research`), `ext-command-guard.md`, `ext-secret-redaction.md`, `ext-slash-checks.md`, `ext-boundary-instructions.md`, `pi-api-verified.md` (verified pi event/UI/CLI API + the FLAG list), `mcp-web-arxiv.md`. **Where a companion conflicts with the master plan, the master wins.** `ext-mcp-bridge.md`, `mcp-servers*.md`, `other-roles.md` are SUPERSEDED — do not build from them.
- **The repo (now readable + writable):** `/Users/alex/agent-system/` — this IS the agent-system harness; you're extending its pi engine at `harness/pi/subagents/{index.ts,runner.ts}` + adding `harness/pi/<ext>/` extensions. Git remote: `github.com/alxstx/agent-system`.

## Operating rules
- **The master plan is the spec.** Build exactly its curated scope; the skeletons in the companion docs are your starting code (they carry inline `⚠ FIX (verifier R#)` corrections — honor those).
- **Small, reversible steps; keep the repo green.** Commit per logical unit with clear messages. **Branch off `main` first** (e.g. `feat/sub-agent-extensions`); first commit = the 2 pending already-reviewed working-tree changes (`README.md` + the `index.ts:270` fix) as a clean base.
- **Do NOT push or open a PR** unless the operator explicitly approves — outward-facing actions need a human OK. Local commits on the branch only.
- **Honesty over green checkmarks.** Every FLAG item must be *actually executed* against live pi and the observed result recorded. If you can't run a test (e.g. pi can't authenticate), say so plainly and leave it for the human — never report "verified" without having verified.
- **Ground before you edit.** Spot-check the cited `index.ts`/`runner.ts` symbols against the real file before changing them (the plan's grounding passed, but confirm). Match surrounding code style; reuse existing helpers.
- **Security invariants are non-negotiable** (the whole point of this harness): sub-agents get NO general shell — execution only via the closed-allowlist `run_check`/`run_experiment`; `run_experiment` is a helper inside the ONE `runner.ts` default export (never a second `export default`); `/monitor` disk logs are redacted in the runner (`runFixedTee` → shared `redact()`); `command-guard` + `boundary-instructions` match paths **repo-root-relative**, not cwd-relative.

## Build order (from the plan)
1. **Phase 0 + 0.5** — remove the dead temp-file scaffolding in `runSubagent`; add `model`/`thinking` opts to `runSubagent` and wire the per-role model map (reviewers→`openai/gpt-5.5`, others→`anthropic/opus-4.8`, `--thinking xhigh`) into the existing `/plan`+`/verify` and every new role.
2. **Shared prereqs** — generalize `harness/pi/install.sh` to symlink every `harness/pi/*/index.ts` (and copy `harness/pi/shared/` on `--copy`); create `harness/pi/shared/redact.ts` (one `loadRedactor(cwd)→redact(text)` closure, owns ALL replacement incl. the `$1`-preserving Authorization rule) and `harness/pi/shared/checks-core.ts` (extracted from `runner.ts`, behavior-identical — `/verify` must still pass).
3. **Extensions** (additive, lowest-risk first) — `command-guard`, `secret-redaction`, then `/checks` (depends on `checks-core.ts`), then `boundary-instructions`.
4. **Sub-agent roles** — `/triage`, `/monitor` (→ `run_experiment` runner + `experiments` in `checks.json`, guarded for the empty case), `/report` (+ `computeGitLog()` helper), `/research` (web tools via `-e`).
5. **Docs/hygiene** — update `harness/pi/subagents/README.md`, the `memory/MEMORY.md` index template, add `memory/runs/` runtime dir; `.gitignore` already has `*.log`.

## Live-pi FLAG verification (install pi, then TEST each — this is the core of the task)
Install pi (`npm install -g --ignore-scripts @earendil-works/pi-coding-agent`; Node ≥22.19) and authenticate (`OPENAI_API_KEY`/`ANTHROPIC_API_KEY` env or `/login`). **GPT-5.5 needs the OpenAI provider authed** — if you can't, build everything else and flag the model-policy tests as operator-blocked. Then, for EACH item, run the test and record CONFIRMED or the applied fallback:

1. **`--append-system-prompt` (Phase 0.2):** spawn one `/plan`; confirm the sub-agent actually follows `plan.md` methodology (the brief+methodology is in its system prompt). 
2. **Model ids + `--thinking xhigh` (Phase 0.5):** `pi --list-models` → confirm the canonical `openai/gpt-5.5` + `anthropic/opus-4.8` ids (and GPT-5.5 availability). Run `/verify` → subprocess reports GPT-5.5; `/plan` → Opus 4.8. *Fallback:* if `gpt-5.5` isn't a listed id, set `MODEL_REVIEW` to the correct one and record it.
3. **`-e` exposes `pi-web-access` tools under `--no-extensions` (/research):** `pi install npm:pi-web-access`; run `/research`; confirm it calls `web_search`. *Fallback:* if `-e`-loading the npm extension doesn't expose the tools, build the thin `research-runner.ts` (`web_search`+`fetch_content`) and load it via `-e`.
4. **`ctx.signal` on command context (/checks):** start a long `/checks`, press Esc → does it abort? *Fallback (already coded):* if `ctx.signal` is absent on commands, confirm checks just run to their `timeoutMs` (no crash).
5. **`deliverAs:"steer"` lands in-turn from `tool_call` (boundary-instructions):** edit a file matching an `applyTo` glob; confirm the steered rule reaches the model *before* it writes. *Fallback:* if steer can't inject mid-turn, switch to `{ block: true, reason: <rule text> }`.
6. **bash `input.command` key (command-guard):** log `event.input` once on a `bash` call; confirm the command string is at `input.command` (adjust the key if not). Then confirm `rm -rf build/` is blocked and `/guard off` overrides.
7. **`mcpServers` wrapper + `.pi/mcp.json` (arXiv):** `pi install npm:pi-mcp-adapter`; copy `harness/mcp.example.json` → `.pi/mcp.json` (arXiv server); confirm `/mcp` lists it and the model can call `search_papers`.

## Done-condition smoke tests (run these; all must pass or be honestly reported)
- `/verify` still passes after the `checks-core.ts` extraction (behavior-identical). 
- `tsc --noEmit` clean against `@earendil-works/pi-coding-agent` types (install it for the types; add a dev `tsconfig` if needed). 
- One `-e RUNNER_PATH` exposes BOTH `run_check` and `run_experiment`; `/verify` still loads in this repo (which has NO `experiments` block → empty-enum guard exercised). 
- secret-redaction: an experiment printing `AKIAIOSFODNN7EXAMPLE` / `ghp_…` → `[REDACTED]` in BOTH tool output AND `memory/runs/<runId>.log`; an `Authorization: Bearer …` header keeps the header, redacts the token. 
- `/monitor` the same experiment twice → two distinct `memory/runs/<runId>.log` + reports, no clobber. 
- `command-guard`/`boundary-instructions`: launch pi from a SUBDIRECTORY and confirm a `migrations/`-boundary write is still blocked / a path-scoped rule still fires (the repo-root-relative fix). 
- `/checks` loads under BOTH default symlink and `install.sh --copy` (shared/ resolves).

Record results in a short `BUILD-REPORT.md` (what was built, each FLAG item's CONFIRMED/fallback outcome, any operator-blocked item, test results).

## FINAL STEP — launch an independent reviewer
When the build + verification are done, **spawn a FRESH reviewer agent** (new session/sub-agent, no shared context with you) and hand it the brief below. Wait for its verdict; if it returns REVISE, address the findings and re-launch it. Surface its final verdict to the operator.

---

### §REVIEW — brief for the reviewing agent (paste into the fresh agent)

You are an adversarial code reviewer. An implementation agent just built a set of pi sub-agents + extensions per `/tmp/agent-system-plan/IMPLEMENTATION-PLAN.md` and recorded results in `/Users/alex/agent-system/BUILD-REPORT.md`. Judge whether the **implementation faithfully realizes the plan** and the **live-pi FLAG items are genuinely resolved with evidence** — assume it's subtly wrong until the code + test logs prove otherwise.

Read: the master plan + companion docs in `/tmp/agent-system-plan/`; the actual changed code in `/Users/alex/agent-system/` (`git diff main` on the build branch); and `BUILD-REPORT.md`.

Check:
1. **Fidelity** — every plan item built as specified; the curated scope only (arXiv-only MCP, web via `pi-web-access`; no superseded/out-of-scope pieces snuck in).
2. **Security invariants hold in the actual code** — no general shell in any sub-agent; `run_experiment`/`run_check` share ONE `runner.ts` default export; `run_experiment` guarded when no `experiments`; `/monitor` redaction is in `runFixedTee` (covers the disk tee); `command-guard` + `boundary-instructions` match **repo-root-relative** (test from a subdir, not just read the code); `secret-redaction` calls the shared `redact()` (no local loop); the `$1`-preserving Authorization rule works.
3. **FLAG items REALLY verified** — for each of the 7, confirm `BUILD-REPORT.md` shows an actual live-pi result (or an honest operator-blocked note), not an assumption. Re-run the highest-risk ones yourself if pi is available (the per-run-log clobber test; the subdir path-matching test; `tsc --noEmit`; one `-e RUNNER_PATH` exposing both tools; `/verify` still passing after the extraction).
4. **Tests + tsc** — `tsc --noEmit` clean; the done-condition smoke tests pass; `/verify` is behavior-identical post-refactor.
5. **Repo hygiene** — small sensible commits on a branch (not main); nothing pushed without approval; docs + memory updated; no secrets committed; `memory/runs/` gitignored.

Output: **APPROVE / APPROVE WITH NITS / REVISE**, then findings as a list — each with `file:line`, severity (blocker/major/nit), and a concrete fix. If REVISE, hand the blockers back to the implementer. Be precise; three real defects beat thirty nits. Do not approve any FLAG item that was assumed rather than tested.
