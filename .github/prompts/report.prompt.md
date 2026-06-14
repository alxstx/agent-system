---
description: Write an audience-facing report of an experiment or change, composing from memory/ artifacts
mode: agent
---
Follow the instructions in [harness/prompts/report.md](../../harness/prompts/report.md).
Also read [harness/prompts/report-context.md](../../harness/prompts/report-context.md) if present — this repo's context + watch-for rules for the reporter; it takes precedence over the generic guidance where they conflict.
Inputs: a subject, an audience (--for=team|paper|self), and source artifacts
(memory/monitor-<run>.md, memory/runs/<run>.log, memory/verdict.md, memory/tasks.md, a git diff/log).
Lead with the result, quantify every claim, cite each number as `file:line`, and write the
full report to memory/reports/<subject>-<date>.md.
