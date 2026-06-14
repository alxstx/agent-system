# Decisions (why-log, ADR-lite)
<!-- One short entry per non-obvious choice. Record the trade-off, not just the outcome. -->

## 2026-06-14 — Per-role repo-context files (harness/prompts/<role>-context.md) as a third prompt layer
- **Context:** sub-agents got two prompt layers (AGENTS.md + the generic `harness/prompts/<role>.md`).
  Nothing made a generic agent good at THIS repo, and the generic prompts are shared (can't drift).
- **Decision:** add a third layer — a per-role context file co-located with each generic prompt,
  injected by `runSubagent` AFTER the methodology (`readContext`/`contextRole`). One file holds BOTH
  `## Repo context` (autofilled by `1-bootstrap-fill.md`) and `## Watch for` rules (added via `/enrich
  <role>` / by hand). AGENTS.md only *points* at the mechanism; detail lives in the files + memory.
- **Why these shapes:**
  - *Markdown co-located in `harness/prompts/`, not JSON / not in checks.json* — so the `.github`
    Copilot wrappers read the same sibling file (no harness drift), and it's per-role targetable.
  - *Named by role* (`verify-context.md`, even though the generic file is `verify-change.md`) — so
    `/enrich verify` maps cleanly and the pair sorts together in a listing.
  - *Comment-only skeletons ⇒ empty ⇒ nothing injected* (`stripComments`+trim) — backward-compatible:
    a repo that hasn't filled them in gets the exact old two-layer prompt, byte-identical.
  - *Read at run time from the repo, never installed into ~/.pi* — one installed engine, per-repo
    content; `install.sh` unchanged (the files live under `harness/prompts/`, not `harness/pi/*`).
- **Trade-off:** `harness/prompts/` now mixes shared generic prompts (never edit per-repo) with
  per-repo `-context.md` files (meant to be edited). The `-context` suffix + README note carry the
  distinction; `/enrich` and bootstrap touch ONLY the context files.

## 2026-06-14 — Shared core in harness/pi/shared/, imported by relative path
- **Context:** `/checks` and `run_check` must run the SAME allowlist; secret-redaction and `/monitor`
  must redact with the SAME patterns — otherwise main session and sub-agents drift.
- **Decision:** extract `checks-core.ts` + `redact.ts` to `harness/pi/shared/`, imported via `../shared/`.
  `install.sh` installs `shared/` alongside every extension (symlink resolves via the link target; `--copy`
  copies it too — verified both).
- **Why:** one source of truth beats keeping two copies in sync; jiti resolves the relative `.js`→`.ts`
  import (verified with pi's real loader).

## 2026-06-14 — Redact in the runner, not only in a main-session hook
- **Context:** `/monitor`'s `run_experiment` runs in a `--no-extensions` subprocess and tees raw output
  to `memory/runs/<runId>.log`; the main-session `secret-redaction` hook can never see that.
- **Decision:** `runFixedTee` applies the shared `redact()` (injected) per line BEFORE both the agent-
  visible stream AND the disk write. Two call sites, one pattern set.
- **Why:** redaction must live where the bytes are produced; a hook on main-session `tool_result` is the
  wrong layer for subprocess/disk output.

## 2026-06-14 — Per-role model policy (verify=GPT-5.5, rest=Opus 4.8, xhigh)
- **Decision:** `runSubagent` always passes `--model` + `--thinking xhigh`; ids in two constants in
  `index.ts`. **Trade-off:** GPT-5.5 adds an OpenAI-auth prerequisite for `/verify`; documented + the
  handler surfaces a load error. Exact id strings are a live-pi FLAG (`pi --list-models`).

## 2026-06-14 — Repo-root-relative path matching
- **Decision:** command-guard boundaries and boundary-instructions `applyTo` match the target's path
  RELATIVE TO THE REPO ROOT (where harness/checks.json lives / cached at session_start), not `ctx.cwd`.
- **Why:** cwd-relative matching silently misses when pi is launched from a subdirectory.

## 2026-06-14 — MCP scope = arXiv only; web = pi-web-access (not an MCP)
- **Decision:** web search via the `pi-web-access` extension; arXiv via `pi-mcp-adapter` + a one-server
  `.pi/mcp.json`. No custom in-repo MCP bridge.
- **Why:** the kept tools are read-only research — nothing destructive to gate by name, so the simple
  adapter suffices; a hand-rolled web fetcher would reintroduce SSRF/egress that the closed allowlist exists to avoid.
