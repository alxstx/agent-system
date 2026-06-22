# Live pi End-to-End Test Plan

## Goal
Prove the pi extension suite works on a machine where pi, extension dependencies, web tools, and MCP
support are already installed. The done condition is an evidence-backed verdict that covers every
sub-agent role, every main-session extension, model selection, redaction, cancellation, and arXiv MCP.

Run this in a disposable clone or temporary branch. Keep exact command output, pi transcript excerpts,
and file paths for every item. Do not mark a FLAG item verified unless it was run live.

## Assumptions
- `pi`, Node >= 22.19, `npm`, `tsc`, `uv`, `pi-web-access`, `pi-mcp-adapter`, and
  `arxiv-mcp-server[pdf]` are already installed.
- pi is authenticated, for example with GitHub Copilot via `/login`.
- `pi --list-models` lists selectable models matching the constants in
  `harness/pi/shared/subagent-core.ts`:
  - `github-copilot/claude-opus-4.8` for `/plan`, `/triage`, `/monitor`, `/report`, `/research`
  - `github-copilot/gpt-5.5` for `/verify`
  - (FLAG: unverified — on a node with only `anthropic`+`ollama` providers these won't appear; needs a Copilot login.)

## Setup Snapshot
Record these before changing anything:

```bash
node -v
pi --version
pi --list-models | grep -E 'github-copilot/claude-opus-4.8|github-copilot/gpt-5.5'
git status --short --branch
git rev-parse HEAD
```

Expected: clean working tree, both model ids listed. If the model ids differ, this is not a runtime bug;
update only `MODEL_DEFAULT` / `MODEL_REVIEW` in `harness/pi/subagents/index.ts` and rerun.

## Baseline Build Checks
Even on an installed machine, confirm the repo-local TypeScript surface is clean:

```bash
cd harness/pi
npm install
npm run typecheck
cd ../..
```

Expected: `tsc -p tsconfig.json` exits 0. Any TypeScript diagnostic blocks live testing.

Confirm the installed extensions are current:

```bash
harness/pi/install.sh
pi list
```

Open `pi` in the repo and run:

```text
/reload
```

Expected: `/plan`, `/verify`, `/triage`, `/monitor`, `/report`, `/research`, `/checks`, and `/guard`
are available. If a command is missing, inspect the extension install location and rerun
`harness/pi/install.sh --copy` as a second install-mode check.

## Test Data
Use a harmless temporary experiment so `/monitor` can prove per-run logs and redaction. Edit
`harness/checks.json` on the temporary branch only:

```json
"experiments": {
  "secret-smoke": {
    "cmd": "node",
    "args": [
      "-e",
      "console.log('AKIAIOSFODNN7EXAMPLE'); console.log('Authorization: Bearer ghp_0123456789abcdefghijABCDEFGHIJ012345'); console.error('done')"
    ],
    "timeoutMs": 30000
  }
}
```

Also create a target for boundary-instructions:

```bash
mkdir -p src/api/demo
printf 'export const handler = () => ({ ok: true });\n' > src/api/demo/handler.ts
```

Do not commit these fixtures unless the test plan itself changes.

## Live Test Sequence

### 1. Model Selection and Planner Handoff
In pi:

```text
/plan demo add a hello function
```

Look for:
- The subprocess model is Opus 4.8.
- `memory/plan-demo.md` and `memory/tasks.md` are written.
- `memory/tasks.md` follows `harness/prompts/plan.md`: Goal, Context, Files to touch, Plan, Risks,
  Test plan, Out of scope.
- The main session receives only the short SUMMARY, not the full repo read.

Red flags:
- Plan shape ignores `harness/prompts/plan.md` -> `--append-system-prompt` is not reaching the sub-agent.
- Wrong model -> update `MODEL_DEFAULT`.
- It writes unrelated files -> tighten the handoff in `handoffPlan`.

### 2. Verifier Model and Allowlisted Checks
Make a tiny implementation change matching the plan, then run:

```text
/verify
```

Look for:
- The subprocess model is GPT-5.5.
- It uses `run_check` for checks and never uses bash/shell.
- It writes `memory/verdict.md`.
- The returned SUMMARY starts with PASS, PASS WITH NITS, or FAIL.

Red flags:
- Wrong model -> update `MODEL_REVIEW`.
- Shell access appears in the transcript -> inspect `tools:` strings in `harness/pi/subagents/index.ts`.
- A repo with no configured experiments breaks `/verify` -> inspect `registerRunExperiment` guard in
  `harness/pi/subagents/runner.ts`.

### 3. Triage Role
In pi:

```text
/triage TypeError: Cannot read properties of undefined reading 'foo'
```

Look for:
- Opus 4.8 model.
- Ranked hypotheses in the SUMMARY.
- `memory/triage-*.md` exists.
- Any probes are via `run_check` (`git-blame`, `git-log-file`, `env-dump`), not shell.

Red flags:
- It tries to fix code -> handoff wording is too weak.
- It requests arbitrary commands -> runner allowlist or prompt drift.

### 4. Monitor Role, Per-Run Logs, and Source Redaction
Run the temporary experiment twice:

```text
/monitor secret-smoke
/monitor secret-smoke
```

Look for:
- Opus 4.8 model.
- Two distinct `memory/monitor-*.md` files.
- Two distinct `memory/runs/<runId>.log` files; no clobbering.
- The transcript and both log files contain `[REDACTED]`, not `AKIAIOSFODNN7EXAMPLE` or the fake
  GitHub token.
- `Authorization: Bearer ` remains visible while only the token is redacted.

Red flags:
- Raw token in transcript or disk log -> `runFixedTee` is not applying the shared redactor before
  `onUpdate` and the disk tee.
- Same log path reused -> run id generation or `run_experiment` `runId` propagation is broken.
- Non-zero experiment exit is treated as tool failure instead of monitor evidence -> check
  `run_experiment` result handling.

### 5. Report Role
After `/monitor` and `/verify`:

```text
/report demo --for=team
```

Look for:
- Opus 4.8 model.
- `memory/reports/demo-<date>.md` exists.
- The report cites source artifacts with `file:line` or `memory/runs/<runId>.log:<line>`.
- It has a Limitations or caveats section.
- The main session only receives the teaser SUMMARY.

Red flags:
- Uncited numbers or claims -> report prompt is not being followed.
- It edits `memory/MEMORY.md` -> one-file handoff contract is being violated.

### 6. Research Role and Web Tools
In pi:

```text
/research pi-web-access what tools does pi-web-access expose?
```

Look for:
- Opus 4.8 model.
- It calls `web_search` and `fetch_content`.
- `memory/research-pi-web-access.md` exists.
- Claims are cited to fetched sources, not search snippets.

Red flags:
- `web_search` missing -> `pi install npm:pi-web-access` is not active in the environment.
- It invents citations -> research prompt/handoff needs tightening.

### 7. Command Guard
In pi from the repo root:

```text
ask the model to run: rm -rf build/
/guard off
ask the model to run: rm -rf build/
/guard on
ask the model to run: rm -rf build/
ask the model to write migrations/0001.sql
```

Then launch pi from a subdirectory and repeat the boundary write:

```bash
mkdir -p migrations
cd migrations
pi
```

```text
ask the model to write 0001.sql
```

Look for:
- `rm -rf build/` is blocked when armed.
- `/guard off` allows the command.
- `/guard on` blocks again.
- `migrations/0001.sql` is blocked from both repo root and subdirectory.

Red flags:
- Subdirectory write bypasses boundary -> path matching is accidentally cwd-relative.
- `--force-with-lease` is blocked like `--force` -> destructive regex is too broad.

### 8. Secret Redaction Main-Session Hook
In pi, ask for a command that prints:

```text
AKIAIOSFODNN7EXAMPLE
Authorization: Bearer ghp_0123456789abcdefghijABCDEFGHIJ012345
0123456789abcdef0123456789abcdef01234567
MDEyMzQ1Njc4OWFiY2RlZg==
```

Look for:
- AWS key and fake GitHub token are `[REDACTED]`.
- `Authorization: Bearer ` is preserved.
- The plain git SHA and base64 string are not redacted.

Red flags:
- Header name removed -> capture-group-preserving rule regressed.
- SHA/base64 redacted -> patterns are too broad.

### 9. Boundary Instructions Timing
Ask pi to edit `src/api/demo/handler.ts`.

Look for:
- `.github/instructions/example.instructions.md` is surfaced for `src/api/**/*.ts`.
- Determine whether the steered rule reaches the model before the edit lands.
- Inspect the actual edit for compliance with the surfaced rule.

Red flags:
- Rule arrives only after the first edit -> switch `boundary-instructions/index.ts` from
  `pi.sendMessage(..., { deliverAs: "steer" })` to returning `{ block: true, reason: <rule text> }`
  so the model retries after seeing the rule.
- Launching pi from a subdirectory prevents the rule from matching -> repo-root-relative matching is broken.

### 10. Inline Checks and Esc Cancellation
Temporarily add a long-running check to `harness/checks.json`:

```json
"slow": { "cmd": "node", "args": ["-e", "setTimeout(() => console.log('done'), 30000)"], "timeoutMs": 60000 }
```

In pi:

```text
/checks
/checks slow
```

Press Esc while `slow` is running.

Look for:
- `/checks` renders a green/red widget.
- Esc either cancels the process through `ctx.signal` or degrades clearly to waiting until timeout.
- The UI status clears after completion/cancel.

Red flags:
- Process continues after Esc with no timeout or status cleanup -> cancellation path needs work.
- `/checks` tries to send output into the model context -> violates the zero-token design.

### 11. MCP arXiv
Ensure project-local MCP config exists:

```bash
mkdir -p .pi
cp harness/mcp.example.json .pi/mcp.json
```

In pi:

```text
/reload
/mcp
ask the model to find a recent arXiv paper about retrieval augmented generation and summarize the title
```

Look for:
- `/mcp` lists `arxiv`.
- The model calls the arXiv MCP tool, especially `search_papers`.
- No write-capable external MCP server is introduced.

Red flags:
- `.pi/mcp.json` not detected -> adapter config path or install is wrong.
- Model uses web search instead of arXiv MCP for this test -> rerun with a stricter prompt.

## Cleanup
After collecting evidence, remove only files you created for this run. If this was not a disposable
clone, inspect `git status --short` before every restore/delete:

```bash
git status --short
git restore -- harness/checks.json
rm -f src/api/demo/handler.ts
rmdir -p src/api/demo 2>/dev/null || true
rm -f .pi/mcp.json
rmdir .pi 2>/dev/null || true
rm -f memory/plan-demo.md memory/verdict.md memory/triage-*.md memory/monitor-*.md
rm -rf memory/runs memory/reports memory/research-pi-web-access.md
```

Keep useful evidence separately if you need to attach it to the final verdict. Do not remove an
existing `.pi/mcp.json`, `memory/reports/`, or `memory/research-*.md` that predates this test run.

## Verdict Template
Use this shape for the final report:

```text
VERDICT: APPROVE | APPROVE WITH NITS | REVISE

Setup:
- node:
- pi:
- models listed:
- commit tested:

Findings:
- [severity] file:line or transcript excerpt - issue - fix

Live test results:
- /plan:
- /verify:
- /triage:
- /monitor:
- /report:
- /research:
- command-guard:
- secret-redaction:
- boundary-instructions:
- /checks:
- MCP arXiv:
```

Approve only if every live item was actually run and any remaining issues are nits with clear fixes.
