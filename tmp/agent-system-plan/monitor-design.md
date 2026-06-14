I now have everything I need. I have a complete understanding of the patterns: the 3-part wiring (canonical prompt + Copilot wrapper + registerCommand), the runner security model (closed allowlist, shell:false, fixed argv, config-from-checks.json), the SUMMARY contract, file-signature fallback, isolation flags, and ctx.ui.setStatus progress. Here is the design doc.

---

# DESIGN DOC: `/monitor` sub-agent for the token-minimizing harness

> Run a long-lived experiment from a fixed allowlist while a read-only watcher classifies its output, then write one `memory/monitor-<run>.md` report and return an `OK`/`ERROR` SUMMARY — mirroring `/plan` and `/verify` exactly.

This is a buildable design, not shipped code. It reuses the exact patterns in `harness/pi/subagents/index.ts`, `harness/pi/subagents/runner.ts`, `harness/checks.json`, and `harness/prompts/*.md`. New files are named, schemas are concrete, and the three sketches are written against the verified pi extension API.

---

## 0. The core tension and the one-line answer

The user wants to "run an experiment and at the same time launch a sub-agent that monitors the process for errors." The hard constraint: **today no sub-agent has a general shell.** The Verifier's *only* execution path is `run_check` — a closed set of named checks, each a fixed `{cmd, args, timeoutMs}` argv run with `shell:false` (see `runner.ts:195-249`). A monitor that "runs an experiment" must launch a long-lived process **without** re-opening arbitrary shell.

**Answer:** add an `experiments` allowlist to `harness/checks.json` (named experiments → fixed `cmd`/`args`/`timeoutMs`; the per-run log path comes from the `runId`, not config — FIX #4), expose it through a new **`run_experiment`** runner tool that is the structural twin of `run_check` (`shell:false`, fixed argv, streamed via `onUpdate`), and adopt **Architecture A** (one monitor sub-agent that runs the experiment and scans the stream inline). The experiment name is a `StringEnum` over config keys — the model never assembles a command string, exactly as with `run_check`.

---

## 1. Role wiring (3 parts) — identical shape to `/plan` and `/verify`

### 1a. Canonical methodology — `harness/prompts/monitor.md`

New file, same voice and structure as `verify-change.md` (Inputs / Check / Severity / Output / Stance). This is the **stable system-prompt body**, prefixed with the `AGENTS.md` brief by `runSubagent` (`index.ts:250-252`) and appended to pi's default prompt via `--append-system-prompt`. It is methodology only — no run-specific data, so it stays cache-friendly. Draft in §6.1.

### 1b. Copilot wrapper — `.github/prompts/monitor.prompt.md`

New file, byte-for-byte the same shape as `.github/prompts/verify-change.prompt.md`: YAML front-matter (`description`, `mode: agent`) plus a one-paragraph body that points at the canonical `harness/prompts/monitor.md` via a relative link. This keeps the markdown (Copilot) harness and the pi harness reading the *same* methodology so they never drift — the explicit design goal in `subagents/README.md:4-6`.

```markdown
---
description: Run an allowlisted experiment and watch its output for errors, writing a GREEN/RED report
mode: agent
---
Follow the instructions in [harness/prompts/monitor.md](../../harness/prompts/monitor.md).

Inputs: an experiment name from `harness/checks.json` (`experiments`) and an optional note. Run it via the allowlisted runner, watch the streamed log for error patterns, and end with a verdict: GREEN (clean) / RED (errors detected), each finding cited as `log:line`. Write the full report to `memory/monitor-<run>.md`.
```

### 1c. `pi.registerCommand('monitor', …)` in `index.ts`

A third `registerCommand` block beside `plan` and `verify` (`index.ts:412,521`). It:

1. Parses `/monitor <experiment> [note…]` — first token is the experiment name (validated against the `experiments` keys in `harness/checks.json`, analogous to how `/verify` resolves a feature slug at `index.ts:541-560`).
2. Resolves repo root with `findRepoRoot(ctx.cwd)` (reused unchanged; `index.ts:136`).
3. Computes a **collision-resistant run id** — `<experiment-slug>-<YYYYMMDDHHMMSSmmm>-<seq>` (millisecond stamp + a module-scope monotonic counter; the exact form the §6.2 skeleton builds) — which names BOTH `memory/monitor-<runId>.md` and `memory/runs/<runId>.log`; ensures `memory/runs/` exists.
4. Builds the first user turn: `MEMORY.md` index + the chosen experiment's `{cmd,args,timeoutMs}` (so the agent knows what it's about to run, but cannot change it) + the operator note + a `handoffMonitor(...)` block (the twin of `handoffVerify`, §6.2).
5. Spawns the sub-agent via the **existing** `runSubagent(...)` with `runnerPath: RUNNER_PATH` and `tools: "read,grep,find,ls,run_experiment,write"`, streaming `ctx.ui.setStatus("subagents", "monitor: turn N (tool)…")` exactly like the other two (`index.ts:472,596`).
6. On return: file-signature fallback (reuse `fileSig`, `index.ts:111`) to persist `res.finalText` if the agent failed to write its report; extract the SUMMARY (reuse `extractSummary`, `index.ts:353`); derive the verdict word from the first token (`OK`/`ERROR`); post one `pi.sendMessage(..., { deliverAs: "nextTurn", details: { verdict } })` and one `ctx.ui.notify`.

No new plumbing: it reuses `runSubagent`, `getPiInvocation`, `subagentFailed`, `extractSummary`, `fileSig`, `findRepoRoot`, `readIfExists`. Sketch in §6.2.

---

## 2. The hard part — execution security (`run_experiment` + `experiments` config)

### 2a. `harness/checks.json` schema additions

Add a top-level `experiments` map, structurally parallel to `checks` — just `cmd`/`args`/`timeoutMs` per entry (a slightly longer default `timeoutMs` posture, since experiments are long-lived). **No `logFile` field (⚠ FIX #4):** the log path is per-run — `memory/runs/<runId>.log`, from the `runId` the parent passes to `run_experiment`. No change to existing `checks`/`testFile`/`git` behavior.

```jsonc
{
  "diffBases": ["main", "HEAD~1"],
  "env": { "venvBinDir": ".venv/bin", "virtualEnvDir": ".venv" },
  "testFile": { /* unchanged */ },
  "checks": { /* unchanged */ },

  // NEW — closed allowlist of long-lived experiments the Monitor may launch.
  // Each maps to a FIXED argv vector run with shell:false. The model picks a
  // NAME (StringEnum); it never assembles a command string. Same guarantee as `checks`.
  // ⚠ FIX #4: NO per-experiment `logFile` — the log path is per-RUN, derived from the runId
  // the parent passes to run_experiment (memory/runs/<runId>.log). A per-experiment logFile would
  // clobber across repeated runs. Each entry is just the fixed command + cap.
  "experiments": {
    "smoke-bench": {
      "cmd": "python",
      "args": ["bench/run.py", "--config", "configs/smoke.yaml"],
      "timeoutMs": 1800000              // 30 min hard cap; SIGTERM then SIGKILL
    },
    "lmcache-throughput": {
      "cmd": "python",
      "args": ["bench/throughput.py", "--duration", "600"],
      "timeoutMs": 900000
    }
  }
}
```

Validation rules the runner enforces on load (mirroring the spirit of `validateTestPath`, `runner.ts:142-168`):
- `cmd` is a string, `args` an array of strings — **no free-text from the model is ever interpolated into argv.** The only model inputs are the experiment *name* (a `StringEnum` key) and the *runId* (validated `^[A-Za-z0-9._-]{1,80}$`, no traversal).
- The log path is `memory/runs/<runId>.log`, `path.resolve`-validated to stay under `memory/runs/` (no `..`) — same confinement as before, now keyed per-run not per-experiment.
- `timeoutMs` is a positive number; if missing, a conservative default (e.g. 1_800_000).

### 2b. `run_experiment` runner — the structural twin of `run_check`

Lives in the **same** `runner.ts` (loaded only into the monitor/verifier subprocess via `-e`, `index.ts:594`). It reuses `findRepoRoot`, `loadConfig` (extended to parse `experiments`), `buildEnv`, and the `runFixed` execution core almost verbatim. Key properties carried over from `run_check`:

- **`shell: false`, fixed argv** (`runner.ts:205-210`): `;`, `&&`, `||`, `|`, backticks, `$( )`, redirects, newlines are structurally impossible.
- **`StringEnum` over config keys** (`runner.ts:272`): the `experiment` parameter is `StringEnum(Object.keys(CONFIG.experiments))` — built **only when ≥1 experiment is configured** (the helper early-returns otherwise, §6.3, so the enum is never empty). An unknown name is **refused and reported**, never run (`runner.ts:315-321`).
- **Streamed via `onUpdate`** (`runner.ts:217`): partial `content` text parts flow to the agent as the process emits output, so the monitor can scan inline (Architecture A).
- **Timeout → SIGTERM then SIGKILL** (`runner.ts:222-228`): same kill ladder; on timeout the outcome is reported as `TIMED OUT after Ns`, which the monitor treats as a finishable, non-fatal-but-flagged terminal state.
- **`AbortSignal`** (`runner.ts:230-236`): if the parent tears down the subprocess, the child experiment is SIGTERM'd — no orphans.

The **one new behavior** vs `run_check`: it applies the shared `redact()` (FIX #2) and then **tees** the (rolling, capped) stream to the validated per-run log on disk via a `fs.createWriteStream`, so a durable, **already-scrubbed** `memory/runs/<runId>.log` exists for the report's `log:line` citations and for post-mortem, even though only the tail is kept in the tool's in-memory `content`. Skeleton in §6.3.

### 2c. Why this preserves the no-arbitrary-shell guarantee

The trust boundary is unchanged: **the allowlist is operator-authored config, not model output.** A `/monitor` agent can only launch experiments an operator pre-declared in `harness/checks.json`, each as a fixed argv. Adding an experiment is a config edit (and, ideally, a code review), exactly like adding a `check` today. There is no `edit` tool and no `bash`/general shell in the monitor's `--tools` allowlist (§5), so it cannot patch the config or escape the allowlist regardless of prompt content.

---

## 3. "Launch a sub-agent that monitors for errors" — two architectures, one pick

### Architecture A — single monitor agent, inline scan (CHOSEN)

One monitor sub-agent runs the experiment via `run_experiment` and scans the **streamed** output (`onUpdate` partials → its own context) for error patterns inline, then writes `memory/monitor-<run>.md`.

- **Pros:** matches `/plan` and `/verify` *exactly* — one command, one subprocess, one output file, one SUMMARY. Reuses `runSubagent` with zero new spawn plumbing. The "runner" and the "watcher" are the same isolated process, so there's no cross-process log-tailing race, no second context window to pay for, and the kill/timeout/abort story is the single, already-proven `runFixed` ladder. The durable per-run log tee still gives an independent on-disk record for citations and post-mortem.
- **Cons:** the runner and watcher share one context. For *enormous* logs this is mitigated by the same rolling cap `run_check` already uses (`MAX_OUTPUT_BYTES`, tail-only in `content`; full stream goes to disk, §7).

### Architecture B — parent backgrounds the experiment; a separate read-only watcher tails the log

The parent command spawns the experiment as a detached background process writing `memory/runs/<run>.log`, and spawns a *second*, read-only watcher sub-agent that tails+classifies the log.

- **Pros:** runner and watcher are fully isolated; the watcher needs no execution tool at all (pure read). Naturally fits a never-terminating experiment (watcher samples, parent owns lifecycle).
- **Cons:** **breaks the established shape.** It introduces parent-owned process lifecycle (start/stop/orphan-reaping) that today lives *inside* the runner's `runFixed`; a polling/tailing protocol with its own EOF/rotation/race edges; two subprocesses and two context windows per run; and a second SUMMARY/output-file contract to reconcile. It also moves "launch a long-lived process" out of the audited `shell:false` runner and into the parent extension, widening the surface the security model has to reason about.

### Decision

**Adopt A.** It honors the user's intent — one agent both *runs* the experiment and *watches it for errors* — while staying a faithful sibling of `/plan` and `/verify`: same `runSubagent`, same allowlisted-runner pattern, same single-file + SUMMARY contract, same isolation flags. B's extra isolation buys little here because the inline watcher is already read-only over the stream and the per-run log tee already provides an independent durable record; B's costs (new parent-side lifecycle + a second agent + a tail protocol) are real complexity that this harness deliberately avoids. **Keep B documented as the upgrade path** for a permanently non-terminating service that must be watched for hours (see §3a) — at that point the parent-owned background process and a sampling watcher become worth their cost.

### 3a. Long / non-terminating experiments

- **Timeouts (primary control):** every experiment has a config `timeoutMs` hard cap. `runFixed` SIGTERMs at the cap, SIGKILLs 5s later (`runner.ts:222-228`). A non-terminating experiment thus *always* ends in bounded time and is reported as `TIMED OUT after Ns` — a clean terminal state the monitor classifies as "ran to cap without crashing" (verdict GREEN unless errors were seen) rather than a hang.
- **Bounded-window pattern:** experiments meant to be observed for a fixed window should bake the bound into their fixed argv (e.g. `--duration 600`), so the process self-terminates and the timeout is only a backstop. This is the recommended way to "monitor a long run" under Architecture A.
- **Where logs live:** `memory/runs/<run>.log` (validated under `memory/runs/`), tee'd live by the runner. The report `memory/monitor-<run>.md` lives beside the other `memory/*.md` artifacts. `memory/runs/` is the only new directory.
- **Live progress to the operator:** the parent streams `ctx.ui.setStatus("subagents", "monitor: turn N (run_experiment)…")` on every `onProgress` tick — identical to `/plan` (`index.ts:472`) and `/verify` (`index.ts:596`) — and clears it in `finally`. The runner's `onUpdate` partials also surface the rolling log tail inside the agent's turn, so the footer shows forward motion during a long run.
- **True 24/7 services:** out of scope for v1; the answer is Architecture B as a follow-up (`/monitor --watch <name>`), explicitly tracked in `memory/tasks.md` rather than silently scope-crept.

---

## 4. Output contract — one file + an `OK`/`ERROR` SUMMARY

Mirrors `/verify`'s `PASS`/`FAIL` contract (`index.ts:619-634`, `verify-change.md:23-24`) precisely.

**One file:** `memory/monitor-<run>.md`, authored by the sub-agent itself with its `write` tool. Required sections:
- **Command** — the exact `cmd + args` that ran (echoed from config; the agent cannot have altered it).
- **Duration** — wall-clock, and whether it hit the timeout cap.
- **Exit status** — `exit 0` / `exit N (signal …)` / `TIMED OUT after Ns`.
- **Detected errors** — each as a `log:line` citation into `memory/runs/<run>.log` with a short excerpt and a one-line classification (crash / traceback / assertion / OOM / non-zero exit / known-flaky).
- **Verdict** — **GREEN** (clean run, no error signatures) or **RED** (one or more errors, or a crash/non-zero exit).

**SUMMARY (the only thing crossing back):** the agent's final message is a line `## SUMMARY` whose **first token is `OK` or `ERROR`**, followed by ≤10 lines of headlines. The parent extracts it with the existing `extractSummary(res.finalText, 10)` (`index.ts:353`) and maps the first token to the verdict word for `details.verdict` and the `ctx.ui.notify` severity (`ERROR` → `"warning"`, like `FAIL`). `GREEN`↔`OK`, `RED`↔`ERROR` (report uses the colors; SUMMARY uses the tokens, just as the verdict file says PASS/FAIL and the SUMMARY's first token is PASS/FAIL).

Parent fallback is unchanged in spirit: if `fileSig` shows the agent didn't write `memory/monitor-<run>.md`, persist `res.finalText` there instead (`index.ts:619-622`).

---

## 5. Tool allowlist

**Monitor sub-agent (Architecture A):**
```
read, grep, find, ls, run_experiment, write
```
Same shape as the Verifier's `read,grep,find,ls,run_check,write` (`index.ts:593`): `write` only so it can author its **one** output file; **no `edit`**, **no `bash`/general shell**. The only execution path is `run_experiment` (closed allowlist). `runner.ts` is loaded via `-e RUNNER_PATH`; the subprocess still runs with `--no-extensions -nc --no-skills --no-prompt-templates --no-themes` (`index.ts:262-268`), so it cannot re-enter `index.ts` or load ambient config.

**Watcher sub-agent (only if Architecture B is ever built):**
```
read, grep, find, ls, write
```
Pure read-only over `memory/runs/<run>.log` — **no runner at all**, no execution, no `edit`. It never launches anything; the parent owns the experiment lifecycle in B.

---

## 6. Sketches (against the verified pi API + existing code)

### 6.1 Draft `harness/prompts/monitor.md`

```markdown
# Prompt: Monitor (experiment-running watch agent)

You are running ONE allowlisted experiment and watching its output for errors. You did **not** write this experiment; you are not here to make it pass. Report what actually happened.

## Inputs
- An experiment NAME from `harness/checks.json` (`experiments`) and its fixed command (shown in your first turn). You cannot change the command — you choose the name.
- An optional operator note (what "healthy" looks like, known-flaky signatures to ignore).

## How to run it
- Launch the experiment with the `run_experiment` tool, calling it as `run_experiment({ experiment: "<name>", runId: "<the run id from your handoff>" })` — pass BOTH the experiment NAME and the exact `runId` you were given. There is no shell; you cannot run anything off the allowlist, and you cannot change the command.
- Watch the streamed output as it arrives (secrets are already redacted). The full stream is also tee'd to `memory/runs/<runId>.log` for citations — use that exact path in your `log:line` references.

## Watch for
- **Crashes / non-zero exit** — the process dies or returns non-zero. Always RED.
- **Tracebacks / stack dumps** — Python `Traceback`, `panic:`, `Segmentation fault`, fatal logs.
- **Assertions / failed checks** — `AssertionError`, `FAILED`, `ERROR`, test-style failures in the stream.
- **Resource failures** — OOM (`CUDA out of memory`, `Killed`, signal 9), disk-full, connection refused.
- **Timeout** — hit the configured cap. Note it; it is RED only if accompanied by errors, else a flagged GREEN ("ran to cap, no crash").
- **Flaky vs real** — if the operator note names a known-flaky signature, classify it as flaky, not a blocker. A clean run with zero error signatures is GREEN.

## Severity
- **error (RED)** — crash, non-zero exit, traceback, or unignored failure signature. The run is not healthy.
- **warning** — a flagged-but-tolerated signature (known-flaky, expected retry).
- **clean (GREEN)** — ran without any error signature (timeout-at-cap with no errors counts as GREEN, flagged).

## Output — write ONLY `memory/monitor-<run>.md` (one file)
Command (exact argv) · Duration (and whether it hit the cap) · Exit status · Detected errors (each as `log:line` + excerpt + classification) · Verdict **GREEN** / **RED**. Make it a standalone report. **Write nothing else** — you may NOT touch `memory/MEMORY.md` (the handoff allows exactly one file). If you found a durable lesson (a real flaky signature, a config gotcha), **name it in your SUMMARY** so the operator can file it into `memory/MEMORY.md` from the main session.

## Stance
Precise, not alarmist. A retry that succeeds is not a failure; a single real traceback is. Cite every error with `log:line` so the human can read it themselves — don't paraphrase a crash you can quote.
```

### 6.2 `registerCommand('monitor', …)` skeleton (in `index.ts`, beside `plan`/`verify`)

```ts
let monitorSeq = 0;   // module-scope monotonic counter for collision-resistant run ids (FIX #2)

pi.registerCommand("monitor", {
  description:
    "Monitor subagent (allowlisted experiment runner, isolated) -> runs one experiment, watches for errors, writes memory/monitor-<run>.md, returns OK/ERROR",
  handler: async (args: string, ctx: ExtensionCommandContext) => {
    const raw = args.trim();
    const firstSpace = raw.search(/\s/);
    const expName = (firstSpace === -1 ? raw : raw.slice(0, firstSpace)).trim();
    const note = firstSpace === -1 ? "" : raw.slice(firstSpace + 1).trim();
    if (!expName) {
      ctx.ui.notify("Usage: /monitor <experiment-name> [note]", "warning");
      return;
    }
    const repo = findRepoRoot(ctx.cwd);
    if (!repo) {
      ctx.ui.notify("Not inside the harness repo (need harness/prompts/monitor.md + memory/MEMORY.md above cwd).", "error");
      return;
    }

    // Resolve the experiment from harness/checks.json (names only — no model-chosen argv).
    const exp = listExperiments(repo.root)[expName]; // small helper reading checks.json.experiments
    if (!exp) {
      ctx.ui.notify(`Unknown experiment '${expName}'. Allowed: ${Object.keys(listExperiments(repo.root)).join(", ") || "(none configured)"}`, "error");
      return;
    }

    // ⚠ FIX #2: collision-resistant run id (the old slice(0,13) was minute-resolution → two runs in the
    // same window clobbered). Full ms timestamp + a monotonic per-process suffix → unique even within a ms.
    // (new Date() is fine in real extension code; only the Workflow scripting sandbox forbids it.)
    const stamp = new Date().toISOString().replace(/[-:T]/g, "").replace("Z", "").replace(".", ""); // YYYYMMDDHHMMSSmmm
    const run = `${slugify(expName)}-${stamp}-${(monitorSeq++).toString(36)}`;  // matches runId regex ^[A-Za-z0-9._-]{1,80}$
    const reportPath = path.join(repo.memoryDir, `monitor-${run}.md`);
    fs.mkdirSync(path.join(repo.memoryDir, "runs"), { recursive: true });

    const memory = readIfExists(repo.memory) ?? "(memory/MEMORY.md missing)";
    const userTurn = [
      "# Current memory index (memory/MEMORY.md)", memory, "---",
      `# Experiment to run: ${expName}`,
      "```", `${exp.cmd} ${exp.args.join(" ")}`, "```",
      `(fixed command from harness/checks.json — you cannot change it; timeout ${Math.round(exp.timeoutMs / 1000)}s)`,
      `# Run id (pass this verbatim as run_experiment's runId): ${run}`,   // ⚠ FIX #4: per-run log id
      `(per-run log will be at memory/runs/${run}.log)`,
      ...(note ? ["---", "# Operator note", note] : []),
      "",
      handoffMonitor(reportPath, expName, run, `memory/runs/${run}.log`),  // handoff tells the agent to call run_experiment with {experiment, runId: run}
    ].join("\n\n");

    ctx.ui.setStatus("subagents", `monitor: starting ${expName}…`);
    const sigBefore = fileSig(reportPath);
    let res: SubagentResult;
    try {
      res = await runSubagent({
        repoRoot: repo.root,
        agentsPath: repo.agents,
        promptBodyPath: path.join(repo.root, "harness", "prompts", "monitor.md"),
        tools: "read,grep,find,ls,run_experiment,write",
        runnerPath: RUNNER_PATH,
        model: MODEL_DEFAULT,            // Phase 0.5: Opus 4.8 (thinking defaults to xhigh)
        userTurn,
        onProgress: (turns, lastTool) =>
          ctx.ui.setStatus("subagents", `monitor: turn ${turns}${lastTool ? ` (${lastTool})` : ""}…`),
      });
    } finally {
      ctx.ui.setStatus("subagents", "");
    }

    if (subagentFailed(res)) {
      const why = res.errorMessage || res.stopReason || res.stderr.trim() || "no output";
      ctx.ui.notify(`Monitor failed: ${why}`, "error");
      pi.sendMessage({ customType: "subagent-monitor", content: `Monitor FAILED (${res.stopReason ?? `exit ${res.exitCode}`}): ${why}`, display: true }, { deliverAs: "nextTurn" });
      return;
    }

    const wroteItself = fileSig(reportPath) !== sigBefore && (readIfExists(reportPath)?.trim()?.length ?? 0) > 0;
    if (!wroteItself) fs.writeFileSync(reportPath, res.finalText.endsWith("\n") ? res.finalText : `${res.finalText}\n`, "utf-8");

    const summary = extractSummary(res.finalText, 10);
    const verdictWord = /^\s*ERROR\b/i.test(summary) ? "ERROR" : "OK";
    pi.sendMessage(
      { customType: "subagent-monitor", content: `Monitor verdict (${expName}, ${res.turns} turns):\n\n${summary}\n\nFull report -> memory/monitor-${run}.md\nLog -> memory/runs/${run}.log`, display: true, details: { verdict: verdictWord, experiment: expName, runId: run } },
      { deliverAs: "nextTurn" },
    );
    ctx.ui.notify(`Monitor: ${verdictWord} — written to memory/monitor-${run}.md`, verdictWord === "ERROR" ? "warning" : "info");
  },
});
```

`handoffMonitor(reportPath, expName, runId, logRel)` is the twin of `handoffVerify` (`index.ts:91`): tells the agent it has read+write, must launch **only** via `run_experiment({ experiment: expName, runId })` (both args, verbatim), may write **only** the one report file, cite errors as `log:line` into `logRel` (`memory/runs/<runId>.log`), and end with `## SUMMARY` whose first token is `OK` or `ERROR`.

### 6.3 `run_experiment` runner skeleton (added to `runner.ts`)

```ts
// --- config additions: parse CONFIG.experiments alongside CONFIG.checks ---
interface ExperimentSpec { cmd: string; args: string[]; timeoutMs: number; }  // ⚠ FIX #4: NO logFile — log path is per-run from runId
// loadConfig(): experiments: parsed.experiments ?? {}
// validateLogFile(repoRoot, "memory/runs/<runId>.log"): must resolve under <repoRoot>/memory/runs, no "..".

const RUNS_DIR = "memory/runs";

// ⚠ CORRECTION (plan verification #3 + R4): run_experiment is registered by a HELPER, NOT a default export.
// pi loads ONE default export per `-e` file, and runner.ts ALREADY has one that registers run_check
// (harness/pi/subagents/runner.ts:257). A second `export default` here would REPLACE it and silently drop
// run_check. So define helpers and call BOTH from the single existing default export:
//
//   function registerRunCheck(pi) { /* the CURRENT run_check body, factored out of the existing export */ }
//   export default function runner(pi: ExtensionAPI) {   // the ONE default export in runner.ts
//     registerRunCheck(pi);        // unchanged behavior
//     registerRunExperiment(pi);   // NEW (below)
//   }
//
// Smoke test: one `-e RUNNER_PATH` exposes BOTH run_check and run_experiment.
// Also (verification #2): runFixedTee applies shared redact() to the stream BEFORE both the onUpdate
// AND the disk tee, so memory/runs/<runId>.log is scrubbed at source.
function registerRunExperiment(pi: ExtensionAPI) {   // a helper — splice a call into the existing default export, do NOT export this
  const expNames = Object.keys(CONFIG.experiments);
  // ⚠ FIX (plan verification R5 #3): do NOT register run_experiment when no experiments are configured.
  // This runner is loaded by /verify in EVERY harnessed repo (same default export as run_check), and most
  // repos have no `experiments` block (e.g. the current harness/checks.json) → expNames would be [] →
  // StringEnum([]) is an empty enum (unsafe/unproven). Guard so run_check still loads cleanly there.
  // Smoke test: /verify loads + run_check works in a repo with NO experiments block.
  if (expNames.length === 0) return;

  pi.registerTool({
    name: "run_experiment",
    label: "Run Experiment",
    description: [
      "Launch ONE allowlisted long-lived experiment (no shell, fixed command).",
      `Allowed: ${expNames.join(", ") || "(none configured)"}.`,
      "Output streams back live (secrets redacted) and is tee'd to memory/runs/<runId>.log. Any other command is refused.",
    ].join(" "),
    // ⚠ FIX (plan verification #4): per-run log. The tool takes the parent's canonical runId so the log lines up
    // with memory/monitor-<runId>.md; without it, repeated runs of one experiment clobber memory/runs/<name>.log
    // and break the report's log:line citations. (The experiments-config `logFile` field is dropped/ignored.)
    parameters: Type.Object({
      experiment: StringEnum(expNames, { description: "Which allowlisted experiment to launch" }),
      runId: Type.String({ description: "Run id from your handoff (e.g. smoke-bench-2026...); names the per-run log" }),
    }),
    async execute(_id, params, signal, onUpdate, ctx) {
      const repoRoot = ctx.cwd;
      const name = params.experiment as string;
      const spec = CONFIG.experiments[name];
      if (!spec) {
        return { content: [{ type: "text", text: `Refused: '${name}' is not an allowed experiment.` }], details: { experiment: name, refused: true }, isError: true };
      }
      // Strictly validate runId to a safe slug (no traversal), then derive the per-run log path.
      const runId = String((params as any).runId ?? "").trim();
      if (!/^[A-Za-z0-9._-]{1,80}$/.test(runId)) {
        return { content: [{ type: "text", text: `Refused: runId must match ^[A-Za-z0-9._-]{1,80}$ (got '${runId}')` }], details: { experiment: name, refused: true }, isError: true };
      }
      const logRel = `${RUNS_DIR}/${runId}.log`;          // per-RUN, not per-experiment
      const v = validateLogFile(repoRoot, logRel); // under memory/runs/, no ".."
      if (!v.ok) {
        return { content: [{ type: "text", text: `Refused: ${v.reason}` }], details: { experiment: name, refused: true }, isError: true };
      }
      fs.mkdirSync(path.dirname(v.abs), { recursive: true });

      // runFixedTee = runFixed (shell:false, fixed argv, SIGTERM->SIGKILL, AbortSignal) PLUS, on every chunk:
      // (a) apply shared redact() to the stream BEFORE both the onUpdate the agent sees AND the disk write
      //     (plan verification #2 — so memory/runs/<runId>.log is scrubbed at source); (b) tee the redacted
      //     stream to the validated per-run log. Returns the exact logRel it wrote.
      const outcome = await runFixedTee(repoRoot, spec.cmd, spec.args, spec.timeoutMs, v.abs, signal, onUpdate);

      const status = outcome.timedOut
        ? `TIMED OUT after ${Math.round(spec.timeoutMs / 1000)}s`
        : outcome.exitCode === 0 ? "exit 0 (clean)"
        : `exit ${outcome.exitCode ?? "?"}${outcome.signal ? ` (signal ${outcome.signal})` : ""}`;

      const text = `$ ${outcome.cmdline}\n[${status}] (full log: ${logRel})\n\n${tail(outcome.output) || "(no output)"}`;
      return {
        content: [{ type: "text", text }],
        details: { experiment: name, exitCode: outcome.exitCode, timedOut: outcome.timedOut, logFile: logRel, cmdline: outcome.cmdline },
        // NOT isError on non-zero: the monitor classifies; the experiment "ran" successfully as a tool call.
      };
    },
  });
}
```

`runFixedTee` is `runFixed` (`runner.ts:195-249`) plus a `fs.createWriteStream(absLogPath)` that the `append` callback also writes to (the in-memory `output` stays capped at `MAX_OUTPUT_BYTES*2`; the full stream goes to disk). The kill ladder, abort handling, and `RunOutcome` shape are unchanged. Note: unlike `run_check`, a non-zero exit is **not** flagged `isError` on the tool result — a crashing experiment is a *successful observation*, and it's the monitor's job (and the report's verdict) to call it RED.

---

## 7. Risks / edges and how the design handles each

| Risk | Handling |
|---|---|
| **Runaway / non-terminating process** | Hard `timeoutMs` cap per experiment with SIGTERM→SIGKILL ladder (`runner.ts:222-228`), reused verbatim. Parent teardown propagates via `AbortSignal` → child SIGTERM (`runner.ts:230-236`), so no orphans. Bounded-window experiments self-terminate via fixed `--duration` argv; the cap is a backstop. |
| **Huge logs blowing up context** | In-memory `content` is tail-capped at `MAX_OUTPUT_BYTES` exactly like `run_check` (`runner.ts:215-216,251-255`); the **full** stream goes to `memory/runs/<run>.log` on disk for citations. The agent reads specific log ranges with `read`/`grep` on demand — never the whole file into context. Consider a per-run on-disk cap / rotation if experiments can emit gigabytes (tracked as a follow-up). |
| **Secrets leaking into logs** | ⚠ FIX #2: redaction is **mandatory and at the source** — `runFixedTee` runs the shared `redact()` (`harness/pi/shared/redact.ts`, same patterns as the `secret-redaction` hook) on every chunk BEFORE both the agent-visible `onUpdate` and the disk tee, so `memory/runs/<runId>.log` is already scrubbed. (A main-session `tool_result` hook can NOT do this — the experiment runs in the `--no-extensions` subprocess.) Plus `memory/runs/` is gitignored, and the prompt cites only error excerpts. Test: an experiment printing an `AKIA…`/token string → both tool output and the disk log read `[REDACTED]`. |
| **Experiment that never errors (false confidence) vs flaky** | The verdict is evidence-based: GREEN requires *zero* error signatures across the full stream, and a timeout-at-cap is reported as a flagged GREEN ("ran to cap, no crash") rather than silently "passed". Known-flaky signatures are passed in via the operator note and classified as `warning`, not blockers — the prompt explicitly separates "a retry that succeeds" from "a real traceback." |
| **Concurrent / repeated runs clobbering logs** | ⚠ FIX #4: the per-run **`runId`** (the parent's `<experiment>-<timestamp>`, passed into the handoff and given to `run_experiment` as a validated param) names BOTH `memory/monitor-<runId>.md` AND `memory/runs/<runId>.log` — so repeated or concurrent runs of the *same* experiment never clobber each other's report, log, or `log:line` citations. The experiments-config `logFile` field is dropped (it keyed logs by experiment NAME, the bug). Each run is its own isolated subprocess (`--no-session`), so contexts never mix. |
| **Model trying to escape the allowlist** | Structurally impossible: `experiment` is a `StringEnum` over config keys (`runner.ts:272` pattern), argv is fixed config, `shell:false`, no `edit`/`bash` in `--tools`, `--no-extensions` prevents re-entering `index.ts`. Unknown names are refused and reported (`runner.ts:315-321`). |
| **Log path traversal** | The per-run log path `memory/runs/<runId>.log` is `path.resolve`-validated to stay under `memory/runs/` with no `..`, mirroring `validateTestPath` (`runner.ts:160-165`); the `runId` itself is regex-validated (`^[A-Za-z0-9._-]{1,80}$`). An out-of-bounds path is refused at runtime. |

---

## Files this design adds or touches

- **New:** `harness/prompts/monitor.md` (methodology) · `.github/prompts/monitor.prompt.md` (Copilot wrapper).
- **Edit:** `harness/pi/subagents/index.ts` (+`registerCommand('monitor')`, +`handoffMonitor`, +tiny `listExperiments` helper) · `harness/pi/subagents/runner.ts` (+`experiments` parsing, +`validateLogFile`, +`run_experiment` tool, +`runFixedTee`) · `harness/checks.json` (+`experiments` map) · `harness/examples/checks.python-lmcache.json` (add a couple of example experiments) · `harness/pi/subagents/README.md` and `memory/MEMORY.md` index (document `/monitor`, `memory/monitor-<run>.md`, `memory/runs/`).
- **New runtime dir:** `memory/runs/` (gitignored).

No new spawn/summary/fallback plumbing is introduced — `/monitor` is a third sibling that reuses `runSubagent`, `getPiInvocation`, `subagentFailed`, `extractSummary`, `fileSig`, `findRepoRoot`, the `ctx.ui.setStatus` progress pattern, and the `run_check` security core, keeping the pi harness and the Copilot harness reading the same canonical markdown so they never drift.