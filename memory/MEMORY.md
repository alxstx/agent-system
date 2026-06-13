# Memory — live index
<!-- The ONLY memory file loaded by default, so keep it SHORT (aim < 60 lines). It's an INDEX + rolling log, not an archive: a few lines of current state plus pointers to detail files. Prune ruthlessly. -->

## Current focus
{{What you're working on right now, in one or two lines.}}

## Recent changes (newest first — keep ~7 max)
- {{date}} — {{what changed and where (path:line); the durable takeaway.}}

## Gotchas / rules learned
- {{Non-obvious fact future-you would otherwise rediscover the hard way.}}

## Index — where detail lives
- Architecture / module map → `memory/architecture.md`
- Why behind decisions → `memory/decisions.md`
- Current plan / task slice → `memory/tasks.md`
- Per-feature roadmaps → `memory/plan-<feature>.md` (written by the pi `/plan` sub-agent)
- Latest verdict → `memory/verdict.md` (written by the pi `/verify` sub-agent)
