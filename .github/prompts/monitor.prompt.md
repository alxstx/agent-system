---
description: Run an allowlisted experiment and watch its output for errors, writing a GREEN/RED report
mode: agent
---
Follow the instructions in [harness/prompts/monitor.md](../../harness/prompts/monitor.md).

Inputs: an experiment name from `harness/checks.json` (`experiments`) and an optional note. Run it via the allowlisted runner, watch the streamed log for error patterns, and end with a verdict: GREEN (clean) / RED (errors detected), each finding cited as `log:line`. Write the full report to `memory/monitor-<run>.md`.
