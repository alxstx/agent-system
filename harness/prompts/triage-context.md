<!--
Repo context for the TRIAGE sub-agent. Loaded after harness/prompts/triage.md, into /triage ONLY.

Two areas live here, both injected into the triager's system prompt:
  1. "## Repo context"            — autofilled at bootstrap: where THIS project's failures usually
                                     originate (flaky subsystems, common root causes, env/setup gotchas,
                                     which logs to trust).
  2. "## Watch for (maintainer rules)" — diagnostic hints a maintainer wants applied every time here.
                                     Add with:  /enrich triage <rule>   (or edit this file directly).

Keep it SHORT — the sub-agent pays for every line on every call; a few high-signal bullets, not prose.
Comment-only (this skeleton) = NOTHING injected: the triager behaves exactly as the generic prompt
alone. Do NOT edit the generic harness/prompts/triage.md (shared; must not drift per repo).
-->
