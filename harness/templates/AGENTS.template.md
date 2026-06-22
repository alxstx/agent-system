<!-- token-harness v0.1 | pristine template — copy to repo root as AGENTS.md, then run harness/prompts/1-bootstrap-fill.md -->
<!-- This is the always-on project brief — every agent reads it first, every session. Keep it < 200 lines and at the "right altitude": concrete enough to act on, short enough to stay cheap. Stable facts only; moving state lives in memory/. -->
# {{PROJECT_NAME}}

> {{ONE_LINE_PURPOSE}}

{{2–3 sentence description: what this project does, who uses it, and the one thing to understand before touching the code.}}

## How to work here (operating contract)
- **Read `memory/MEMORY.md` first** every task — it's the live state + index. Do **not** re-scan the whole repo; use the map below and the memory index to find what you need.
- **Load detail on demand:** architecture → `memory/architecture.md`; the "why" behind choices → `memory/decisions.md`; the current plan → `memory/tasks.md`. Open a file when you need it, not pre-emptively.
- **Small, reversible steps.** Make the smallest change that advances the task; prefer several verifiable edits over one sprawling one. Match the surrounding code's style and reuse existing helpers.
- **Stay in scope.** Discover unrelated work? Note it in `memory/tasks.md` and raise it — don't silently expand the change.
- **When genuinely unsure, ask one sharp question** rather than guessing on something expensive to undo.
- **Update memory after meaningful changes** (rules in `memory/MEMORY.md`). Keep the index short; push detail to topic files.
- This repo runs **interactive**: propose a plan and pause for approval before large or irreversible changes. *(On pi, the optional `auto-judge` extension can enforce a tool-call policy automatically — an LLM gate that blocks guarded calls until they pass; off by default, arm with `/autojudge on`. The optional `delegate` (one isolated read-only sub-agent) and `workflow` (a governed parallel fan-out of them) tools let the model offload self-contained read-only investigations; opt-in via `delegate`/`workflow` blocks in `harness/checks.json`. See `harness/README.md`.)*

## Build discipline — the reuse ladder
Before writing code, stop at the first rung that holds: **(1)** does it need to exist at all? (YAGNI) → **(2)** does the stdlib do it? → **(3)** a native platform feature? → **(4)** an already-installed dependency? → **(5)** can it be one line? → **(6)** only then, the minimum code that works. Deletion over addition; boring over clever; fewest files. No abstractions, dependencies, or boilerplate nobody asked for. Mark an intentional shortcut with a `ponytail:` comment naming its ceiling + upgrade path. **Not** lazy about: trust-boundary validation, error handling that prevents data loss, security, accessibility, or anything explicitly requested. (This brief reaches every tool and every `--no-extensions` sub-agent; on pi, the optional `/ponytail` extension adds live `lite|full|ultra` modes + `/ponytail-review` — see `harness/README.md`.)

## Definition of done
A change is done only when:
- [ ] It satisfies the task's goal and stated done-condition.
- [ ] Tests for the affected area pass (`{{TEST_CMD}}`); new behavior has a test.
- [ ] Lint / format is clean (`{{LINT_CMD}}`).
- [ ] `memory/` is updated — the change is logged and any durable lesson filed.
- [ ] For non-trivial changes, `harness/prompts/verify-change.md` returned PASS.

## Stack & commands
<!-- fill: copy real commands verbatim from package scripts / Makefile / justfile / CI. Be exact — these run unattended. -->
- **Languages / frameworks:** {{STACK}}
- **Install:** `{{INSTALL_CMD}}`
- **Build:** `{{BUILD_CMD}}`
- **Test:** `{{TEST_CMD}}`  (single test: `{{TEST_ONE_CMD}}`)
- **Lint / format:** `{{LINT_CMD}}` / `{{FORMAT_CMD}}`
- **Run locally:** `{{RUN_CMD}}`
- **Other:** {{TYPECHECK_/_MIGRATE_/_SEED_/_ETC}}

## Architecture map (where things live)
<!-- fill: one line per top-level dir/module that matters — path → responsibility. This is what lets an agent navigate without re-reading the repo. Deeper detail goes in memory/architecture.md. -->
- `{{path/}}` — {{responsibility}}
- `{{path/}}` — {{responsibility}}

Entry point(s): {{ENTRYPOINTS}}. Request / data flow: {{ONE_LINE_DATA_FLOW}}.

## Conventions
<!-- fill: only non-obvious, enforceable rules — the things a new contributor gets wrong. Concrete > abstract. Add a tiny do/don't only where it prevents a repeated mistake. A rule that applies to just some files belongs in .github/instructions/ instead. -->
- {{CONVENTION — e.g. "Errors: return the shared `AppError`; never throw raw strings."}}
- {{CONVENTION}}

## Boundaries (do not touch without asking)
- {{GENERATED_OR_VENDORED_PATHS}}, {{SECURITY_SENSITIVE_AREAS}}, {{MIGRATIONS}}, {{PUBLIC_API_CONTRACTS}}

## When stuck
- Re-read the relevant `memory/` topic file before re-reading source.
- Check `memory/decisions.md` — the thing you're about to "fix" may be a deliberate choice.
- Blocked after a couple of genuine attempts? Stop and summarize the blocker + your options for the human.

## Pointers
- Glossary / domain terms: `memory/architecture.md`
- Known issues / tech debt: `memory/MEMORY.md` (Open questions) and `memory/decisions.md`
- External docs / dashboards / tickets: {{LINKS}}
