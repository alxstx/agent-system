# Decisions (why-log, ADR-lite)
<!-- One short entry per non-obvious choice. Record the trade-off, not just the outcome. -->

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
  `index.ts`. **Trade-off:** the operator must authenticate pi first (GitHub Copilot login is enough
  when it lists these models), then the ids are just model selections. Exact id strings remain a
  live-pi FLAG (`pi --list-models`); the handler surfaces a load error if a selected model is absent.

## 2026-06-14 — Repo-root-relative path matching
- **Decision:** command-guard boundaries and boundary-instructions `applyTo` match the target's path
  RELATIVE TO THE REPO ROOT (where harness/checks.json lives / cached at session_start), not `ctx.cwd`.
- **Why:** cwd-relative matching silently misses when pi is launched from a subdirectory.

## 2026-06-14 — MCP scope = arXiv only; web = pi-web-access (not an MCP)
- **Decision:** web search via the `pi-web-access` extension; arXiv via `pi-mcp-adapter` + a one-server
  `.pi/mcp.json`. No custom in-repo MCP bridge.
- **Why:** the kept tools are read-only research — nothing destructive to gate by name, so the simple
  adapter suffices; a hand-rolled web fetcher would reintroduce SSRF/egress that the closed allowlist exists to avoid.
