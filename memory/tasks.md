# Active task slice
<!-- Overwritten by the pi `/plan` sub-agent each run; the concrete next batch to implement. -->

## Goal
(No active slice — the roles + extensions build + the per-role context layer are complete on
`feat/roles-and-extensions`. To validate on a live pi, work through `TESTING.md`.)

## Deferred / follow-ups (not built this pass — track here, don't scope-creep)
- **Live-pi confirmations** (need a provider-authenticated pi on Node ≥22.19): see `TESTING.md`
  — model ids via `pi --list-models`; `/verify` on GPT-5.5 + `/plan` on Opus 4.8; `/enrich` rule actually
  reaching the sub-agent (and role isolation); `/research` web_search returning results;
  `deliverAs:"steer"` landing before the edit (else flip boundary-instructions to `{block:true}`);
  `/mcp` listing arxiv.
- **auto-report hook** — the "always write a doc after an experiment" automation: a `pi.on('message')`
  hook that fires `/report <run> --for=team` when a `subagent-monitor` message lands (build over `/report`).
- **/monitor Architecture B** — `/monitor --watch <name>` for truly non-terminating services (parent-owned
  background process + a separate read-only tailing watcher). v1 uses Architecture A (one agent, inline scan).
- **Deferred extensions** (designed, not built): token-budget widget, auto-memory, experiment-autocomplete.
- **Struck roles** (designed, not building): /distill, /repro, /doc, /review-pr, /bench.

## Test plan
- `cd harness/pi && npm install && npm run typecheck` → tsc clean.
- Live pi (Node ≥22.19, both providers authed): walk through `TESTING.md` — all roles, the `/enrich`
  context layer, the main-session extensions, and MCP.
