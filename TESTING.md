<!-- The single "what to run to test the system" runbook. Offline gate first (cheap, deterministic,
     runs everywhere); live-pi smokes second (need an authed pi). Keep in sync with the test files. -->
# Testing the agent-system harness

This harness is a suite of **pi** extensions (6 sub-agent roles + main-session extensions, sharing
`harness/pi/shared/`). Tests come in two tiers:

1. **Offline gate** — pure unit tests + typecheck. No pi, no network, no auth. **Run this for every
   change** — it's the Definition-of-Done gate.
2. **Live-pi smokes** — exercise the real extensions inside a running `pi`. Need an authenticated pi
   (or a keyless local model). Each is a checklist item, not automated.

---

## 1. Offline gate — run this every change

```bash
cd harness/pi && npm install && npm run typecheck && npm test
```

- `npm run typecheck` → `tsc -p tsconfig.json` must be **clean** (extensions ship as uncompiled TS,
  loaded by jiti at runtime; tsc is the only compile-time check). Needs **Node ≥ 22.19**.
- `npm test` → `node --test "**/*.test.ts"` must be **green** (~100 cases across the files below).

### What each offline test file covers

| File | Covers |
|---|---|
| `harness/pi/shared/subagent-core.test.ts` | `extractSummary` (the `## SUMMARY` grammar that crosses back to the main session); `cleanDetails` (metadata-only `details` filter — secret-redaction never scrubs `details`); `redactOnWrite` (redact-then-byte-cap before any disk write) |
| `harness/pi/subagents/userturns.test.ts` | `slugify`; the six per-role `handoff*` contracts; the six per-role first-user-turn builders. These are the **dual-mode** seam — command-mode and tool-mode build byte-identical prompts from here |
| `harness/pi/subagents/gate-config.test.ts` | Drift guard: the six `subagent_*` tools registered in `index.ts` are EXACTLY the ones gated in `harness/checks.json` (+ the example) `autoJudge.guardedTools`, and `contextDiff` stays false. The gate is exact-match — a typo silently un-gates a model-driven spawn, so this pins it |
| `harness/pi/auto-judge/verdict.test.ts` | `parseVerdict` (fail-closed ALLOW/DENY grammar); `loadAutoJudgeConfig` (defaults + validation, crafted `checks.json` under temp dirs) |
| `harness/pi/delegate/config.test.ts` | `delegate` tool config loader (read-only general sub-agent) |
| `harness/pi/workflow/config.test.ts`, `harness/pi/workflow/right-size.test.ts` | `workflow` config + the governor's fan-out right-sizer |
| `harness/pi/model-id-guard.test.ts` | **Repo-wide policy guard:** fails if ANY tracked file contains a direct provider-qualified model id (`openai/<id>` or `anthropic/<id>`). Policy is **Copilot-only** (`github-copilot/<id>`). Shells to `git grep`; needs git + a tracked tree |

> The model-id guard is intentionally **repo-wide**, not `harness/`-scoped — a narrower scan would pass
> green while a tracked file elsewhere still carried a forbidden id. It excludes `node_modules/` (and
> `pi-ai/dist` lives under it) and excludes itself. To prove it isn't vacuously green: `git add` a file
> containing a direct provider-qualified id (one of the two banned providers, a slash, then a model
> slug), run `node --test harness/pi/model-id-guard.test.ts` → it FAILS listing the offender; remove the
> file → it PASSES. (This very doc can't show a literal example — the guard would flag it.)

---

## 2. Live-pi smokes (need an authed pi)

These can't be unit-tested — they drive a real `pi` process. Two ways to get a model:

### 2a. With a subscription (Copilot / Anthropic) — `pi /login`
Then confirm the configured model ids resolve:
```bash
pi --list-models | grep -E 'github-copilot/claude-opus-4.8|github-copilot/gpt-5.5'
```
**FLAG (2026-06-21):** these two ids are **unverified** — the dev node only had `anthropic` + `ollama`
providers (no `github-copilot`), so the Copilot catalog ids + format (`claude-opus-4.8` dotted vs the live
anthropic `claude-opus-4-8` dashed) could not be confirmed. Re-run the above on a **Copilot-authenticated**
node and correct the two constants in `harness/pi/shared/subagent-core.ts` if the catalog differs.

### 2b. Keyless local (no subscription) — Ollama
Point `~/.pi/agent/models.json` at a local Ollama model:
```jsonc
{ "providers": { "ollama": {
  "baseUrl": "http://localhost:11434/v1", "api": "openai-completions", "apiKey": "ollama",
  "compat": { "supportsDeveloperRole": false, "supportsReasoningEffort": false },
  "models": [ { "id": "llama3.1:8b" } ] } } }
```
Then `pi --model ollama/llama3.1:8b …`. **The model MUST emit *native* `tool_calls`** — verify with a
direct `curl localhost:11434/v1/chat/completions` carrying a `tools` array. `llama3.1:8b` does;
`qwen2.5-coder:7b` emits tool calls as plain TEXT (pi can't see them → unusable).

### Smoke checklist

Install once: `harness/pi/install.sh` (symlinks every extension into `~/.pi/agent/extensions/`), then
`/reload` in pi.

- **Sub-agent commands** (the 6 roles): in a harnessed repo, run `/plan <feat> <task>` → writes
  `memory/plan-<feat>.md` + `memory/tasks.md`, posts a ≤10-line SUMMARY. Then `/verify` → writes
  `memory/verdict.md`, posts PASS/FAIL. Also `/triage`, `/monitor <exp>`, `/report <subj>`, `/research <topic> <q>`.
- **Sub-agent TOOL mode** (dual-mode slice 1): the running model calls **`subagent_verify`** mid-turn and
  sees its summary **in the same turn** (artifact stays on disk). A thrown failure (e.g. no
  `memory/tasks.md`) surfaces as an **error result** to the model (not a silent pass). `/reload` mid-call
  must not orphan the child (the `session_shutdown` guard reaps it).
- **auto-judge** (opt-in gate): `/autojudge on`, then trigger a guarded tool call → a judge subprocess
  ALLOW/DENYs it; DENY (or judge failure, fail-closed) blocks. `/autojudge off` to disarm.
- **Model selection** (dual-mode slice 2): `/verify` sub-agent runs on `MODEL_REVIEW`, the others on
  `MODEL_DEFAULT` (see `pi --list-models` confirmation above).

### Gotchas — read before running any live smoke (learned the hard way 2026-06-21)

1. **`pi --mode json -p` buffers stdout; it flushes only on a CLEAN exit.** A run you SIGTERM/SIGKILL
   shows **0 bytes** even though work happened. Let runs exit on their own; don't kill to "check".
2. **`--tools <extension-tool>` (e.g. `--tools subagent_verify`) HANGS pi at startup in `-p`** (0 bytes,
   even a trivial prompt). Force a specific tool call via the **prompt**, not `--tools`. Load just one
   extension with `--no-extensions -e <path/to/index.ts>` (loading ALL installed extensions together has
   also hung startup — suspect a stray throwaway extension).
3. **Use a fast, native-tool-call model.** `llama3.1:8b` does native calls for *simple* prompts but
   **degrades to tool-call-as-TEXT under a heavy system prompt** (e.g. the verify brief) — so it's a
   non-functional nested verifier. For a clean end-to-end transcript use a capable model (authed
   Copilot/Anthropic), not an 8B local model, as the **sub-agent**.
4. **An unauthed `openai/`|`anthropic/` child HANGS** (doesn't fail fast) — so a sub-agent pointed at a
   provider you're not logged into blocks instead of erroring.
5. **One `pi` at a time** — a single Ollama backend serializes requests; overlapping runs pile up and
   look hung.

> Evidence the dual-mode tool round-trip *does* work on Ollama despite the above: in a real session the
> main model called `subagent_verify`, the isolated verifier spawned on `ollama/llama3.1:8b`, and the
> parent's `fallbackWrite` persisted the child's output to `memory/verdict.md` — proof the whole
> tool→spawn→return→persist chain ran. A clean *captured* transcript needs a stronger sub-agent model.

---

## 3. Current live FLAGs (unverified, for the operator)

- The two Copilot model ids in `harness/pi/shared/subagent-core.ts` (§2a) — unverified on a node without
  a `github-copilot` provider.
- All §2 live smokes — need an authed pi; not yet run end-to-end on a capable model.
- See `BUILD-REPORT.md` and `memory/plan-live-pi-e2e.md` for the broader live-E2E checklist.
