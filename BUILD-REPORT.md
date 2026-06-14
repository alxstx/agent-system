# BUILD REPORT — agent-system roles + extensions

Branch `feat/roles-and-extensions` (off `main`). Implemented per `tmp/agent-system-plan/IMPLEMENTATION-PLAN.md`.
**Nothing pushed.** Honesty note: every item below is marked **CONFIRMED** (actually tested), **CONFIRMED
(mechanism)** (the API/loader path was tested offline but the full model-driven flow was not), or
**BLOCKED — needs live pi** (could not be run here; left for the human with the exact command). Nothing
is claimed "verified" that was only assumed.

## Environment reality (read first)
- This box had **Node 18.19.1**; pi requires **≥ 22.19**. Installed Node v22.22.3 into `~/.local/node22`
  (prepend `~/.local/node22/bin` to PATH) and `pi` 0.79.3 + TypeScript globally. The repo + plan docs
  were at `/home/ubuntu/agent-system` (the brief's macOS `/Users/alex/...`/`/tmp/...` paths are that
  machine; same git remote `github.com/alxstx/agent-system`).
- **No pi login/model access** (`~/.pi/agent/auth.json` empty; `pi --list-models` → "No models available").
  So NO model-driven test was possible. Everything model-dependent is BLOCKED and left for the human.
- The "2 pending reviewed changes" (README install sections + the `index.ts:270` `--append-system-prompt`
  fix) were **already committed in `main`** (HEAD), so the clean base already existed; the branch was cut
  from it directly.
- Offline verification used pi's **real extension loader** (`loadExtensions`) so the tests exercise the
  exact load + registration path pi uses, plus direct calls into the registered tool/command/handler
  functions. `tsc --noEmit` runs against the real pi `.d.ts` (dev-only `harness/pi/package.json` +
  `tsconfig.json`; lockfile gitignored).

## What was built (commits on the branch)
1. `Phase 0+0.5` — removed dead temp-file scaffolding in `runSubagent`; per-role `--model`/`--thinking xhigh`.
2. `P2.0a+P2.0b` — generalized `install.sh`; extracted `harness/pi/shared/{checks-core,redact}.ts`.
3. `Extensions` — command-guard, secret-redaction, `/checks`, boundary-instructions.
4. `/triage`, `/monitor`, `/report`, `/research` — one commit each.
5. `MCP` — `harness/mcp.example.json` (arXiv via pi-mcp-adapter) + `.pi/` gitignore.

`tsc --noEmit` is **clean** after every commit.

## Live-pi FLAG items (the brief's numbered list)

| # | Item | Status | Evidence / fallback |
|---|---|---|---|
| 1 | `--append-system-prompt` → /plan follows plan.md | **CONFIRMED (mechanism)** | `pi --help` + `usage.md`: flag takes text. `index.ts` passes the combined brief+methodology text directly; dead temp-file path removed. Whether the model *follows* it needs a live /plan → BLOCKED. |
| 2 | model ids + `--thinking xhigh` | **PARTLY CONFIRMED** | `--thinking` enum incl. `xhigh` CONFIRMED (`--help`). `--model provider/id[:thinking]` form CONFIRMED. Exact ids `openai/gpt-5.5` / `anthropic/opus-4.8` are model selections after pi auth (GitHub Copilot login is enough when they are listed) and remain **BLOCKED** here because `pi --list-models` needs a login. Fallback ready: the two constants at the top of `index.ts` are the one-line fix. |
| 3 | `-e` exposes pi-web-access tools under `--no-extensions` | **CONFIRMED (mechanism)** | Loading pi-web-access via pi's loader registers `web_search`,`fetch_content` (+`code_search`,`get_search_content`). CLI `-e npm:pi-web-access` under the FULL subagent flag set (`--no-extensions … --tools read,web_search,fetch_content`) resolved+loaded the extension and ran to the model call (only "No API key" stopped it). An actual web_search returning results → BLOCKED (auth/network). `research-runner.ts` fallback NOT needed. |
| 4 | `ctx.signal` on command handlers → /checks aborts on Esc | **CONFIRMED (typed) + graceful fallback** | `ExtensionContext.signal: AbortSignal \| undefined` (types.d.ts:227-228); `ExtensionCommandContext extends ExtensionContext`. It is `undefined` when no turn is streaming, so `/checks` uses `ctx.signal?.aborted` + passes it to `runFixed` → cancels when present, runs to `timeoutMs` when absent. The live Esc-abort behavior → BLOCKED (needs the TUI). |
| 5 | `deliverAs:"steer"` lands before the edit (boundary rule) | **BLOCKED — needs live pi** | `"steer"` is a valid `deliverAs` value (CONFIRMED, types.d.ts:861). BUT the docs/types say steer is delivered *after the current turn's tool calls*, so it may NOT reach the model before the edit. Implemented steer per the plan; the **`{block:true,reason}` fallback is documented in the code** — decide on a live pi. |
| 6 | bash `input.command`; rm -rf blocked; `/guard off` overrides | **CONFIRMED** | `BashToolInput.command: string` (pi types); `isToolCallEventType("bash",…)` narrows `event.input.command`. Offline matrix (43/43): `rm -rf build/`, `git push --force`/`-f`, `reset --hard`, `clean -fd`, truncating `>` blocked; `rm file.txt`, `--force-with-lease`, `>>`, `2>&1` allowed; `/guard off` disarms, `/guard on` re-arms. |
| 7 | `mcpServers` + `.pi/mcp.json`; /mcp lists arXiv | **CONFIRMED (adapter) / BLOCKED (server)** | `pi install npm:pi-mcp-adapter` succeeds; the adapter loads via pi's loader and registers the `mcp` proxy tool + `/mcp` + `/mcp-auth` commands. `harness/mcp.example.json` uses the `mcpServers` wrapper (adapter's Claude-Code-compatible form) and is copied to the verified `.pi/mcp.json` path. `/mcp` actually listing arxiv + a `search_papers` call → BLOCKED (needs `uv` + `arxiv-mcp-server` + a model). |

### API-shape items (ground-truthed against pi's own `.d.ts` — all CONFIRMED)
- `tool_call`/`tool_result` shapes: `event.toolName`, `event.input` (mutable), `event.content` (array,
  mutable), `event.isError` — confirmed from `types.d.ts`. **Built-in write/edit use `input.path`, NOT
  `file_path`** (the skeleton's primary key was wrong; code leads with `path`, tolerates `file_path`).
- Block shape `{block?:boolean, reason?:string}` (ToolCallEventResult) — confirmed.
- `ctx.ui.notify(msg, "info"|"warning"|"error")` — **no `"success"`** (confirmed; code never uses it).
- `setWidget(key, string[]|fn|undefined, {placement:"belowEditor"})`, `WidgetPlacement="aboveEditor"|"belowEditor"` — confirmed.
- `session_start` event exists (confirmed) — boundary-instructions caches REPO_ROOT + rules there.
- `pi.unregisterTool` does **NOT** exist (use `setActiveTools`) — confirmed; unused by this build.
- `execute(toolCallId, params, signal, onUpdate, ctx)` 5-arg form + `ctx.cwd` — confirmed.
- `StringEnum([])` does not throw at construction (yields `{type:"string",enum:[]}`); the no-experiments
  guard is still kept (don't register a tool the model can never call).

## Offline verification (what was actually run here)
- **`tsc --noEmit` clean** (`cd harness/pi && npm install && npm run typecheck`). Fixed a pre-existing
  latent type error in `runFixed`'s `onUpdate` (the original never typechecked).
- **Extraction byte-identical:** `run_check` loads via pi's loader and runs `git status --porcelain`
  with the same content/details/isError as before.
- **install.sh** symlink AND `--copy`: every extension loads and `../shared/` resolves in both;
  `--copy` carries `shared/*.ts`; uninstall removes extensions + shared.
- **Extensions behavior (43/43)** via pi's loader: command-guard bash matrix + boundary writes
  **repo-root-relative from a subdir** (`cwd=repo/migrations`, write `0001.sql` → blocked) + `/guard`
  toggle; secret-redaction AKIA/ghp_/Authorization `$1`/assignment redacted, SHA + base64 NOT redacted,
  `extraPatterns` + custom replacement + malformed-regex resilience; boundary-instructions glob
  (`**/`, zero + nested dirs), dedupe, repo-root-relative-from-subdir.
- **/triage probes:** env-dump (allowlisted env, no subprocess), git-blame/git-log-file run, traversal
  (`../etc/passwd`) refused; `index` registers plan/verify/triage.
- **/monitor (12/12):** one `-e` exposes BOTH `run_check`+`run_experiment`; a repo with no experiments
  registers `run_check` only (R5 guard); same experiment twice → two distinct `memory/runs/<id>.log`
  (no clobber); AKIA/ghp_ redacted in tool output AND the disk log with the Authorization name kept
  (also the echoed cmdline is redacted); bad runId + unknown experiment refused; non-zero exit not
  flagged isError.
- **/report:** `computeGitLog` matches real `git log main..HEAD`; commands register.
- **/research:** see FLAG #3. pi-web-access registers the web tools; `-e npm:pi-web-access` loads.
- **MCP:** see FLAG #7. pi-mcp-adapter loads + registers the `mcp` tool/command.

## Security invariants (all CONFIRMED)
- Sub-agents get **no general shell** — only the `--tools` allowlist; `bash`/`edit` never present;
  the only execution surface is `run_check`/`run_experiment` (closed StringEnum, fixed argv, `shell:false`).
- `run_experiment` is a **helper called from the ONE `runner.ts` default export** alongside `run_check`
  (verified both register from one `-e`); never a second `export default`.
- `/monitor` output is **redacted in `runFixedTee`** before both the stream and the disk tee.
- Path matching (command-guard boundaries + boundary-instructions applyTo) is **repo-root-relative**
  (tested from a subdir).
- One shared `redact()` with the capture-group-preserving `$1` Authorization rule.

## Corrections made beyond the skeletons (ground-checked)
- `write`/`edit` field is `input.path` (not `file_path`) — code leads with `path`.
- command-guard `rm` regex required a leading dash (skeleton matched `rm file.txt`); added `git push -f`;
  redirect rule excludes `>&`/`2>&1`.
- `runFixedTee` redacts the cmdline ONCE up front, so the live stream preview, the returned
  `outcome.cmdline`, the `run_experiment` text echo AND `details.cmdline` are all scrubbed (a secret in
  experiment argv → `echo [REDACTED]`). Defense-in-depth; argv is operator config (the disk log never
  contained the cmdline). (Closed an independent-review nit.)

## Independent review
A fresh reviewer (no shared context) re-ran all six high-risk FLAG checks (a–f) against pi's real
loader — all PASS — and confirmed the phases, security invariants, honest BLOCKED markings, clean
commits, and no real secrets. Verdict: **APPROVE WITH NITS**; the 3 nits (cmdline redaction in the live
stream + `details`, and a redundant `/research` ternary) were addressed in the final commit.

## Left for the human (live-pi, need Node ≥22.19 + authenticated pi)
1. `pi --list-models` → confirm `openai/gpt-5.5` + `anthropic/opus-4.8` (FLAG #2); else edit the two
   constants in `index.ts`.
2. Run `/verify` → confirm it selects GPT-5.5 and `/plan` → Opus 4.8 after pi auth (FLAG #1, #2).
3. `/research <topic> <q>` → confirm `web_search` returns results (FLAG #3).
4. Edit a file matching `.github/instructions/*.instructions.md` → confirm the steered rule reaches the
   model BEFORE the edit; if not, switch boundary-instructions to `{block:true,reason}` (FLAG #5).
5. `/checks` then press Esc → confirm cancel (FLAG #4).
6. `cp harness/mcp.example.json .pi/mcp.json` (+ `uv tool install 'arxiv-mcp-server[pdf]'`) → `/mcp`
   lists arxiv; model calls `search_papers` (FLAG #7).
