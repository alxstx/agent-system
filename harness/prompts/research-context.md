<!--
Repo context for the RESEARCH sub-agent. Loaded after harness/prompts/research.md, into /research ONLY.

Two areas live here, both injected into the researcher's system prompt:
  1. "## Repo context"            — autofilled at bootstrap: the preferred primary sources/docs for
                                     THIS domain, terms of art, and which sources to distrust (so the
                                     researcher corroborates against the right places).
  2. "## Watch for (maintainer rules)" — sourcing rules a maintainer wants enforced every time here.
                                     Add with:  /enrich research <rule>   (or edit this file directly).

Keep it SHORT — the sub-agent pays for every line on every call; a few high-signal bullets, not prose.
Comment-only (this skeleton) = NOTHING injected: the researcher behaves exactly as the generic prompt
alone. Do NOT edit the generic harness/prompts/research.md (shared; must not drift per repo).
-->
