# Plan — live-testing `workflow` on a GitHub Copilot node (slice-4 FLAG)

> The workflow tool (`harness/pi/workflow/`) is offline-complete (slices 0–3, review-clean, in the
> 110-test gate). Its **slice-4 live smoke could not be done locally**: the keyless Ollama 8B can't emit
> the structured `workflow({objective, tasks[]})` tool call (array-of-strings schema) — it role-plays the
> fan-out in prose. A **capable model (Copilot Opus 4.8 / GPT-5.5) on an authed node** can. This is the
> runbook for that node. General setup/gotchas live in `TESTING.md §2a` + `§Gotchas`; this is the
> workflow-specific matrix. The identical `registerTool→execute→runSubagent→redact-on-write` path is
> already live-proven by the **delegate** smoke, so the new ground here is the **fan-out orchestration**
> (govern → pool → N parallel workers → files → index) and the **right-sizer judge**.

## 0. Prerequisites (do these first, in order)
1. **Auth Copilot:** open `pi`, run `/login` → GitHub Copilot → github.com (see `TESTING.md §2a`).
2. **VERIFY THE MODEL IDS (standing FLAG):** `pi --list-models | grep -i copilot`. Confirm
   `github-copilot/claude-opus-4.8` and `github-copilot/gpt-5.5` exist **verbatim**. If the catalog spells
   them differently (e.g. dashed `claude-opus-4-8`, or a different Copilot id), edit the TWO constants in
   `harness/pi/shared/subagent-core.ts` (`MODEL_DEFAULT`/`MODEL_REVIEW`), then `cd harness/pi && npm test`
   (the `model-id-guard` must stay green — Copilot ids only) and `/reload`. Workers run on `MODEL_DEFAULT`,
   the right-sizer judge on `MODEL_REVIEW`.
3. **Install + reload:** `harness/pi/install.sh` (symlinks `workflow/` + `delegate/` + the rest), then
   `/reload` in pi. Confirm the tool is offered: ask the model "what tools do you have?" → `workflow` listed.
4. **Confirm opt-in:** `harness/checks.json` already has a `workflow` block (presence opts it in). The
   defaults: `maxParallel 5`, `concurrency 5`, `maxWorkflowsPerRequest 2`, `useJudge true`,
   `judgeThreshold 10`, `synthesize false`, `maxResultBytes 32768`, `timeoutMs 600000`.
5. **Cost note:** every kept task = one real Opus-4.8/xhigh subprocess; a right-sized run also spends one
   GPT-5.5 judge call. A 5-wide fan-out ≈ 5 Opus + (maybe) 1 GPT-5.5. Keep test fan-outs small.

## 1. Minimal first run (T1 — do this one first; everything else builds on it)
In the TUI, prompt (the model decomposes; you can also hand it the tasks):
> "Use the workflow tool. objective: 'understand the harness redaction + config layer'. tasks: four
> separate read-only investigations — (1) what harness/pi/shared/redact.ts does, (2) the top-level keys
> in harness/checks.json, (3) what the secret-redaction extension hooks, (4) what runFixedTee redacts."

**Expect, in order:**
- a **confirm dialog** ("workflow: fan out read-only subagents?") showing the objective + "4 task(s) → up
  to 5 parallel read-only workers" → answer **yes**;
- a live footer status cycling `workflow: k/4 workers done`;
- a **completion notify** "workflow: 4/4 workers ok — memory/workflow/<runId>/";
- a **compact index** in the tool result: a header line (`… 4 worker(s) (clamped), 4 ok`), a `Governor:`
  rationale, then `1. [ok] <real headline>  → memory/workflow/<runId>/0-<slug>.md` per task.

**Then inspect on disk:** `ls memory/workflow/<runId>/` → four `<i>-<slug>.md` files, each with a REAL
worker answer (Copilot actually reads the files, unlike the 8B). `git status` → the dir is gitignored.

## 2. Full FLAG matrix
| # | What it proves | How to drive it | PASS = |
|---|---|---|---|
| T1 | model emits the array-arg call → parallel fan-out → files → index | §1 above | confirm → k/N status → notify → index with per-task `[ok]` + paths; real `.md` files on disk |
| T2 | **right-sizer prunes** at scale (judge runs ≥ `judgeThreshold`) | give **12** overlapping tasks (or set `judgeThreshold:4` in the block + `/reload`) | the `Governor:` line says "right-sizer kept N of 12"; **kept ≤ maxParallel (5)**; a GPT-5.5 judge call happened |
| T3 | judge **skipped** below threshold | 3 tasks | `Governor:` says "… < judgeThreshold …: baseline clamp"; no judge spend |
| T4 | **clamp holds even if the judge over-keeps** (MAJOR-3) | T2's 12-task run | the result is ALWAYS ≤ 5 regardless of what the judge returns (code-clamped) |
| T5 | **per-request cap** | set `maxWorkflowsPerRequest:1`, `/reload`; ask the model to call workflow **twice** in one turn | the 2nd call returns "per-request cap reached (1)"; no 2nd fan-out spawns |
| T6 | **partial failure → marked, not fatal** | set `timeoutMs:5000` (too short), `/reload`, run T1 | some workers return `[FAILED: …]` in the index, others `[ok]`; the index still returns (not a thrown error) |
| T7 | **abort kills all children** | start a fan-out, immediately **Esc/Ctrl-C** the turn | the workers die; `ps aux \| grep '[p]i --mode json'` → none left |
| T8 | **/reload mid-fan-out leaves no orphans** (shutdown guard) | start a fan-out, `/reload` while `k/N` is mid-count | after reload, `ps aux \| grep '[p]i --mode json'` → none left |
| T9 | **recursion bounded** | (structural) read a worker file / its handoff | workers spawn `--no-extensions --tools read,grep,find,ls`; `workflow` is not in their tool set — they can't fan out |
| T10 | **auto-judge gates the spawn** (headless gate) | `/autojudge on` (the block already lists `"workflow"` in `guardedTools`), then run T1 | a judge ALLOW/DENY fires on the `workflow` call before it fans out; on DENY, no spawn |
| T11 | **synthesize** | set `synthesize:true`, `/reload`, run T1 | after the workers, a `synthesis.md` is written + a `## Synthesis →` block is appended to the index |
| T12 | **redact-on-write at the source** | create a throwaway file with a fake secret (e.g. `echo 'AKIAEXAMPLE1234567890 token' > /tmp/leak.txt` — or a repo scratch file), add a task "read /tmp/leak.txt and quote the token" | the worker's `.md` on disk shows `[REDACTED]`, NOT the raw `AKIA…` (redaction happens before the write; the secret-redaction hook never sees disk) |
| T13 | **details metadata-only** | headless (below), inspect the tool_result `details` | `details` = `{mode, runId, workers, ok, judged}` only — no worker text |

## 3. Headless / scriptable recipe (for CI or non-interactive checks)
```bash
# hasUI=false → the confirm is SKIPPED (so auto-judge is the only headless gate). stdin MUST be /dev/null
# (pi hangs on an open non-TTY stdin — see TESTING.md §Gotchas).
pi --mode json -p --tools workflow \
  "Call the workflow tool. objective: <…>. tasks: [\"<t1>\",\"<t2>\",\"<t3>\"]." \
  < /dev/null > /tmp/wf.jsonl 2>/tmp/wf.err
# then parse /tmp/wf.jsonl:
#   - a turn_end with toolCall name=workflow, arguments.tasks = the array  → CLAIM (model emitted the call)
#   - tool_execution_end toolName=workflow → result.content[0].text is the index; result.details metadata-only
#   - ls memory/workflow/<runId>/ → the redacted per-worker files
```
A capable headless model should emit the array call; if a given model won't, fall back to the TUI (T1).

## 4. Pass criteria (the slice-4 done-condition)
The FLAG is satisfied when, on the Copilot node: T1 (parallel fan-out + real files + index), T2/T3 (judge
prunes at scale / skipped below threshold), T4 (clamp always ≤ maxParallel), T5 (per-request cap), T7+T8
(abort + /reload leave no orphans), T12 (redact-on-write) all pass. T6/T9/T10/T11/T13 are confirmations.
Record results in `TESTING.md §3` (flip the workflow FLAG from unverified → verified) and update
`memory/MEMORY.md`.

## 5. Notes
- **Do NOT simulate this with a local model.** The 8B can't emit the array-arg call; a local run validates
  nothing here. The fan-out *machinery* (pool/redact/paths/governor) is already covered offline + by the
  delegate live smoke — the new thing this FLAG adds is a **capable model driving it** + the **GPT-5.5
  right-sizer actually pruning**, both of which need real Copilot models.
- Revert any block tweaks (`judgeThreshold`/`timeoutMs`/`maxWorkflowsPerRequest`/`synthesize`) to defaults
  after testing.
- Same residuals as delegate apply (out-of-repo reads can't be path-jailed; worker text is untrusted DATA);
  these are documented, not re-tested here.
