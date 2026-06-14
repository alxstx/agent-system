---
description: Classify a failing run into ranked root-cause hypotheses + the single next probe
mode: agent
---
Follow the instructions in [harness/prompts/triage.md](../../harness/prompts/triage.md).
Also read [harness/prompts/triage-context.md](../../harness/prompts/triage-context.md) if present — this repo's context + watch-for rules for triage; it takes precedence over the generic guidance where they conflict.

Inputs: the failing log/stderr (or its path) and `memory/MEMORY.md`. Output a ranked hypothesis list (top label first) and ONE next probe to run. Grep on demand; do not dump the tree.
