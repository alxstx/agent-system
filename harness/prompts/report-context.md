<!--
Repo context for the REPORT sub-agent. Loaded after harness/prompts/report.md, into /report ONLY.

Two areas live here, both injected into the reporter's system prompt:
  1. "## Repo context"            — autofilled at bootstrap: who the audience usually is, which
                                     artifacts/metrics to cite for THIS project, and any house style
                                     (terminology, units, framing) to follow.
  2. "## Watch for (maintainer rules)" — reporting conventions a maintainer wants applied every time.
                                     Add with:  /enrich report <rule>   (or edit this file directly).

Keep it SHORT — the sub-agent pays for every line on every call; a few high-signal bullets, not prose.
Comment-only (this skeleton) = NOTHING injected: the reporter behaves exactly as the generic prompt
alone. Do NOT edit the generic harness/prompts/report.md (shared; must not drift per repo).
-->
