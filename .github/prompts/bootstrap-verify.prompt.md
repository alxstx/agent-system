---
description: Verify the filled token-harness against the real repository
mode: agent
---
Follow the instructions in [harness/prompts/2-bootstrap-verify.md](../../harness/prompts/2-bootstrap-verify.md).

Check every concrete claim in `AGENTS.md` and `memory/` against the actual repo — commands, paths, module responsibilities, and every `(?)` / (inferred) item. Output a `✓ / ✗ / ⚠` checklist with `file:line`, then apply only safe, unambiguous fixes. State whether the harness is ready or what must be fixed first.
