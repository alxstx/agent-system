<!--
Repo context for the PLAN sub-agent. Loaded after harness/prompts/plan.md, into /plan ONLY.

Two areas live here, both injected into the planner's system prompt:
  1. "## Repo context"            — autofilled at bootstrap: what the planner should know about THIS
                                     repo (architecture seams, where features tend to land, constraints
                                     that shape a plan).
  2. "## Watch for (maintainer rules)" — things a maintainer always wants the planner to do/avoid here.
                                     Add with:  /enrich plan <rule>   (or edit this file directly).

Keep it SHORT — the sub-agent pays for every line on every call; a few high-signal bullets, not prose.
Comment-only (this skeleton) = NOTHING injected: the planner behaves exactly as the generic prompt
alone. Do NOT edit the generic harness/prompts/plan.md (it is shared and must not drift per repo).
-->
