# Testing the system on a real pi

A hands-on checklist to confirm **every feature works** on a live, authenticated `pi`. Work top to
bottom; for each step run the command and check it produced the **Expect** result. Most of this needs a
provider-authenticated pi on **Node ≥ 22.19** — the offline-only steps are marked *(no model)*.

Record a ✓/✗ per step; for any ✗ note the command, what you saw, and `file:line` if it's a code fix.

---

## 0. Setup (do this first)

1. **Toolchain** *(no model)* — `node -v` (≥ 22.19), `pi --version`, TypeScript available.
2. **Auth both providers** — the engine runs `/verify` on **GPT-5.5** (OpenAI) and every other role on
   **Opus 4.8** (Anthropic). Set `ANTHROPIC_API_KEY` + `OPENAI_API_KEY`, or `/login` for each.
   - `pi --list-models` → **Expect** `anthropic/opus-4.8` and `openai/gpt-5.5` listed. If an id differs,
     fix the one place: the `MODEL_DEFAULT` / `MODEL_REVIEW` constants at the top of
     `harness/pi/subagents/index.ts`.
3. **Optional capabilities** — only needed for the `/research` and MCP steps:
   ```bash
   pi install npm:pi-web-access                 # web_search + fetch_content for /research
   pi install npm:pi-mcp-adapter                # MCP support (adds /mcp, /mcp-auth)
   uv tool install 'arxiv-mcp-server[pdf]'      # the one in-scope MCP (arXiv)
   cp harness/mcp.example.json .pi/mcp.json     # enable it (project-local)
   ```
4. **Type-check** *(no model)* — `cd harness/pi && npm install && npm run typecheck` → **Expect** `tsc`
   clean (zero diagnostics).
5. **Install + load** — `harness/pi/install.sh` (try `--copy` too), open pi in this repo, run `/reload`.
   - Type `/` → **Expect** `plan verify triage monitor report research enrich checks guard` all present.

---

## 1. Sub-agent roles

Each role is an isolated `pi` subprocess with **no general shell** — it writes ONE `memory/` file and
returns a ≤10-line SUMMARY.

| Step | Run | Expect |
|---|---|---|
| **/plan** | `/plan demo add a hello() function` | `memory/plan-demo.md` + `memory/tasks.md` written; SUMMARY posted; footer shows it on **Opus 4.8**; the plan follows the `harness/prompts/plan.md` structure (Goal / Files / Test plan) — proves `--append-system-prompt` reached the model. |
| **/verify** | `/verify` (after making a small diff) | `memory/verdict.md` written; first SUMMARY token is **PASS / PASS WITH NITS / FAIL**; footer shows it on **GPT-5.5**. |
| **/triage** | `/triage <paste a stderr or a log path>` | `memory/triage-<id>.md`; a ranked hypothesis list (top label first) + ONE next probe; it used read-only probes (git-blame / git-log-file / env-dump) via `run_check`, **never a shell**. |
| **/monitor** | add a harmless entry under `experiments` in `harness/checks.json`, then `/monitor <name>` | `memory/monitor-<run>.md` + `memory/runs/<run>.log`; verdict **OK/ERROR**. Run it **twice** → two distinct logs (no clobber). Make the experiment print a fake `AKIA…` token → **`[REDACTED]`** in BOTH the transcript and the on-disk log. |
| **/report** | `/report demo --for=team` (after a /verify or /monitor) | `memory/reports/demo-<date>.md` — a real, cited document with a Limitations/caveats note + a teaser SUMMARY. |
| **/research** | `/research perf <a real question>` | calls `web_search` / `fetch_content`; writes a cited `memory/research-perf.md` (claims tagged VERIFIED/UNCERTAIN). If web tools are missing, it should say so and point to `pi install npm:pi-web-access` (needs that install). |

---

## 2. Per-role context layer + `/enrich`

The third prompt layer: each sub-agent also loads `harness/prompts/<role>-context.md` (repo context +
watch-for rules) after its generic prompt.

1. **Backward-compat** — with every `harness/prompts/*-context.md` still comment-only, run `/verify`.
   **Expect** behaviour unchanged from §1 and no errors (an empty context file injects nothing).
2. **List** — `/enrich` (no args). **Expect** all six roles listed as `(empty)`.
3. **Add a rule** — `/enrich verify always check CUDA stream cleanup in kernels`.
   **Expect** `harness/prompts/verify-context.md` now has a `## Watch for` bullet; `/enrich` lists
   `verify: 1 rule(s) — …`.
4. **Injection works** — `/verify` again on a diff. **Expect** the verdict explicitly addresses the
   injected rule (proves the context file reached the verifier's system prompt).
5. **Role isolation** — `/plan demo add a hello() function`. **Expect** the planner does **not** pick up
   verify's rule (only `plan-context.md` loads into `/plan`).
6. **Bootstrap autofill** *(optional)* — run `/bootstrap-fill` against a sample project. **Expect** it
   fills the `## Repo context` area of the `<role>-context.md` files and does **not** edit the generic
   `harness/prompts/<role>.md`.

---

## 3. Main-session extensions

These govern your interactive session; sub-agents are immune to them.

1. **command-guard** — ask pi to `rm -rf build/`. **Expect** BLOCKED with a reason. `/guard off` → it
   proceeds; `/guard on` → blocked again. Ask it to write a `boundaries` path (e.g.
   `migrations/0001.sql`) → BLOCKED. **Relaunch pi from a subdirectory and repeat** → still BLOCKED
   (matching is repo-root-relative, not cwd-relative).
2. **secret-redaction** — have pi run a command that prints `AKIA…` and an `Authorization: Bearer …`
   header. **Expect** the values shown as `[REDACTED]` with the header *name* preserved; a plain git SHA
   or base64 blob is **not** redacted.
3. **/checks** — `/checks` → green/red widget for the `harness/checks.json` allowlist; `/checks lint`
   runs just one. Start a long check and press **Esc** → it cancels mid-run (graceful no-op if
   `ctx.signal` is unavailable).
4. **boundary-instructions** — edit a file matching the `applyTo` glob in
   `.github/instructions/example.instructions.md` (`src/api/**/*.ts`). **Expect** the rule surfaces.
   Note whether it lands **before** the edit; if `deliverAs:"steer"` is too late, switch the handler to
   `{ block: true, reason }` (the documented fallback in `harness/pi/boundary-instructions/index.ts`).

---

## 4. MCP — arXiv *(optional)*

With `.pi/mcp.json` in place (Setup step 3), run `/mcp`. **Expect** `arxiv` listed; ask the model to find
a paper → it calls the arXiv server (`search_papers`).

---

## 5. Security spot-checks *(no model)*

- `grep -n 'tools:' harness/pi/subagents/index.ts` → **Expect** no role's allowlist contains `bash`,
  `edit`, or a general shell — only `read,grep,find,ls,write` (+ `run_check` / `run_experiment` /
  `web_search` per role).
- `harness/pi/subagents/runner.ts` has exactly **one** `export default`, registering BOTH `run_check`
  and `run_experiment`; a repo with no `experiments` registers `run_check` only.
- Redaction lives at the source: `/monitor`'s log is scrubbed in `runFixedTee`
  (`harness/pi/shared/checks-core.ts`), not a main-session hook; one shared `redact()` in
  `harness/pi/shared/redact.ts`.

---

## Result

One line per section (✓/✗), then the defect list — each with `file:line`, severity, and a concrete fix.
Don't mark a model-driven step ✓ unless you actually ran it on the authenticated pi.
