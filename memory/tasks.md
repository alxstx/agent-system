# Active task slice
<!-- Overwritten by the pi `/plan` sub-agent each run; the concrete next batch to implement. -->

## Goal
(No active slice — the roles + extensions build is complete and committed on
`feat/roles-and-extensions`. See `BUILD-REPORT.md` for status and the live-pi FLAG list.)

## Deferred / follow-ups (not built this pass — track here, don't scope-creep)
- **Live-pi FLAG confirmations** (need an authenticated pi on Node ≥22.19; GitHub Copilot login is
  sufficient when the target models are listed): see `BUILD-REPORT.md`
  — model ids via `pi --list-models`; `/research` web_search actually returning results; `deliverAs:"steer"`
  landing before the edit (else flip boundary-instructions to `{block:true}`); `/mcp` listing arxiv.
- **auto-report hook** — the "always write a doc after an experiment" automation: a `pi.on('message')`
  hook that fires `/report <run> --for=team` when a `subagent-monitor` message lands (build over `/report`).
- **/monitor Architecture B** — `/monitor --watch <name>` for truly non-terminating services (parent-owned
  background process + a separate read-only tailing watcher). v1 uses Architecture A (one agent, inline scan).
- **Deferred extensions** (designed, not built): token-budget widget, auto-memory, experiment-autocomplete.
- **Struck roles** (designed, not building): /distill, /repro, /doc, /review-pr, /bench.

## Test plan
- `cd harness/pi && npm install && npm run typecheck` → tsc clean.
- Re-run the offline harness checks in `BUILD-REPORT.md` (guard/redact/glob/runId/probes via pi's loader).
