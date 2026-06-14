<!--
Repo context for the MONITOR sub-agent. Loaded after harness/prompts/monitor.md, into /monitor ONLY.

Two areas live here, both injected into the monitor's system prompt:
  1. "## Repo context"            — autofilled at bootstrap: what a healthy vs failing run looks like
                                     here (expected runtimes, normal log noise vs real errors,
                                     known-flaky signatures to classify rather than alarm on).
  2. "## Watch for (maintainer rules)" — signals a maintainer wants caught every run here.
                                     Add with:  /enrich monitor <rule>   (or edit this file directly).

Keep it SHORT — the sub-agent pays for every line on every call; a few high-signal bullets, not prose.
Comment-only (this skeleton) = NOTHING injected: the monitor behaves exactly as the generic prompt
alone. Do NOT edit the generic harness/prompts/monitor.md (shared; must not drift per repo).
-->
