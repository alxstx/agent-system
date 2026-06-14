<!--
Repo context for the VERIFY sub-agent. Loaded after harness/prompts/verify-change.md, into /verify ONLY.

Two areas live here, both injected into the verifier's system prompt:
  1. "## Repo context"            — autofilled at bootstrap: the failure modes and risky areas a
                                     reviewer must always check in THIS repo; project-specific
                                     correctness/security invariants; conventions that are easy to break.
  2. "## Watch for (maintainer rules)" — specific things a maintainer wants flagged on every review here.
                                     Add with:  /enrich verify <rule>   (or edit this file directly).

Keep it SHORT — the sub-agent pays for every line on every call; a few high-signal bullets, not prose.
Comment-only (this skeleton) = NOTHING injected: the verifier behaves exactly as the generic prompt
alone. Do NOT edit the generic harness/prompts/verify-change.md (shared; must not drift per repo).
-->
