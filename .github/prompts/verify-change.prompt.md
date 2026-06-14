---
description: Adversarially verify the current change against the task in memory/tasks.md
mode: agent
---
Follow the instructions in [harness/prompts/verify-change.md](../../harness/prompts/verify-change.md).
Also read [harness/prompts/verify-context.md](../../harness/prompts/verify-context.md) if present — this repo's context + watch-for rules for the verifier; it takes precedence over the generic guidance where they conflict.

Inputs: the goal + done-condition in `memory/tasks.md` and the current diff. Be adversarial — assume the change is subtly wrong until proven otherwise. End with a verdict: PASS / PASS WITH NITS / FAIL, plus findings as `file:line` + fix.
