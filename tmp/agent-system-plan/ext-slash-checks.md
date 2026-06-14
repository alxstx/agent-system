I now have everything needed. Let me write the implementation plan.

## `/checks` — run the allowlisted checks inline in the main session

A `pi.registerCommand('checks', …)` that runs the `harness/checks.json` allowlist (test/lint/typecheck + git checks) **inline** in the main session and prints a compact green/red table, with **no Verifier sub-agent**. The non-negotiable core: factor `loadConfig` + `runFixed` (and friends) out of `runner.ts` into a shared module that both `runner.ts` and this command import, so the main session and the Verifier execute the same argv from one allowlist and can never diverge.

### 1. Where it lives + how it's installed
- New shared module: `harness/pi/shared/checks-core.ts`. Move from `runner.ts` (lines 32–255): `MAX_OUTPUT_BYTES`, the `FixedCheck`/`TestFileSpec`/`ChecksConfig` interfaces, `GIT_CHECKS`, `findRepoRoot`, `loadConfig`, `allCheckNames`, `resolveGitBase`, `gitCheckSpec`, `validateTestPath`, `buildEnv`, `runFixed`, `tail`, plus a new `resolveCheck(cfg, repoRoot, check, path)` that returns `{cmd,args,timeoutMs}` or `{refused,reason}` (the dispatch currently inlined in `runner.ts` `execute`, lines 281–321). `runner.ts` shrinks to importing these and wiring the tool. `buildEnv` currently closes over module-level `CONFIG`; refactor it to take `cfg` as a parameter so it's pure.
- New extension: `harness/pi/checks/index.ts` (mirrors the `harness/pi/subagents/` convention), importing from `../shared/checks-core.ts`.
- **Install:** extend `install.sh` to install **each** `harness/pi/*/` extension dir (loop over subdirs containing `index.ts`) rather than hardcoding `subagents`. One install-per-extension keeps each loadable independently and keeps the "edits in-repo apply live" symlink default. The shared module lives under `harness/pi/shared/`, imported by **relative path** (`../shared/`). For **symlink** installs `../shared/` resolves (the link target is the real repo dir). **⚠ FIX (plan verification #3/#4): `--copy` installs MUST also copy `harness/pi/shared/` to `~/.pi/agent/extensions/shared/`** — otherwise the copied `/checks` can't resolve `../shared/checks-core.js`. **Verify BOTH** the default symlink and `--copy` installs of `/checks` (per IMPLEMENTATION-PLAN.md P2.0a). Bundling into one extension was rejected: it would couple `/checks` releases to the subagents engine.

### 2. Registration code (idiomatic skeleton)
```ts
import * as path from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { findRepoRoot, loadConfig, allCheckNames, resolveCheck, runFixed } from "../shared/checks-core.js";

export default function checks(pi: ExtensionAPI) {
  pi.registerCommand("checks", {
    description: "Run allowlisted checks inline (green/red table). Usage: /checks [name]",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const repoRoot = findRepoRoot(ctx.cwd);
      const cfg = loadConfig(repoRoot);
      const one = args.trim();
      const names = one ? [one] : Object.keys(cfg.checks); // default: project checks only, not git
      if (one && !allCheckNames(cfg).includes(one)) {
        ctx.ui.notify(`Unknown check '${one}'. Allowed: ${allCheckNames(cfg).join(", ")}`, "error");
        return;
      }
      if (!names.length) { ctx.ui.notify("No checks defined in harness/checks.json.", "warning"); return; }

      const rows: string[] = [];
      let failed = 0;
      for (const name of names) {
        if (ctx.signal?.aborted) break;   // FLAG: ctx.signal unconfirmed for command handlers — optional chaining = graceful no-op if absent
        const r = resolveCheck(cfg, repoRoot, name, undefined); // test-file needs a path → skip in 'all'
        if ("refused" in r) { rows.push(`  ?  ${name.padEnd(14)} ${r.reason}`); continue; }
        ctx.ui.setStatus("checks", `running ${name}…`);
        const o = await runFixed(repoRoot, r.cmd, r.args, r.timeoutMs, ctx.signal, undefined);
        const ok = o.exitCode === 0 && !o.timedOut;
        if (!ok) failed++;
        rows.push(`  ${ok ? "✓" : "✗"}  ${name.padEnd(14)} ${o.timedOut ? "TIMEOUT" : `exit ${o.exitCode ?? "?"}`}`);
      }
      ctx.ui.setStatus("checks", "");
      ctx.ui.setWidget("checks", ["checks:", ...rows], { placement: "belowEditor" });
      ctx.ui.notify(failed ? `${failed} check(s) failed` : "all checks passed",
        failed ? "warning" : "info"); // FLAG: "success" not in confirmed enum — use info
    },
  });
}
```

### 3. Config / inputs
Reads only `harness/checks.json` (schema already defined in `runner.ts` lines 42–61: `diffBases`, `env.{venvBinDir,virtualEnvDir}`, `testFile`, `checks: Record<name,{cmd,args,timeoutMs}>`). Defaults come from `loadConfig` (lines 81–95): empty config → `{diffBases:["main","HEAD~1"], env:{}, checks:{}}`. `/checks` (no arg) runs `Object.keys(cfg.checks)` only — git checks are excluded from "all" (they always "pass", noise) but runnable individually via `/checks git-status`. `test-file` is skipped in the "all" run because it needs a `path` arg; `/checks test-file` without a path notifies the refusal reason from `resolveCheck`.

### 4. Build steps
1. Create `harness/pi/shared/checks-core.ts`; move the listed symbols out of `runner.ts`, add exported `resolveCheck`, make `buildEnv(cfg, repoRoot)` pure.
2. Rewrite `runner.ts` to import from `../shared/checks-core.js` and keep only the `registerTool` wiring (its `execute` calls `resolveCheck` + `runFixed`).
3. Create `harness/pi/checks/index.ts` (skeleton above).
4. Edit `install.sh`: replace the fixed `SRC_DIR=.../subagents` with a loop installing every `harness/pi/*/` dir that contains `index.ts`. **⚠ FIX (verifier #3): `harness/pi/shared/` has no `index.ts` so it's not an extension, but `--copy` installs MUST still copy it to `~/.pi/agent/extensions/shared/`** (symlink installs resolve `../shared/` via the link target; copies don't). Keep `--copy`/`--uninstall` semantics per-extension.
5. Typecheck both extensions; verify `runner.ts` behavior is byte-identical (same allowlist, same refusals).
6. Run `install.sh`, then `/reload` in pi. **Verify BOTH install modes:** default symlink **and** `harness/pi/install.sh --copy` — confirm `/checks` loads and resolves `../shared/checks-core.js` in each.

### 5. Testing (live pi)
- `/checks` → widget below the editor: `✓ test exit 0`, `✓ lint exit 0` (with the placeholder `echo` config both pass); notify "all checks passed".
- Make `lint` fail (point it at a failing command) → `✗ lint exit 1`, notify "1 check(s) failed" (warning).
- `/checks lint` → runs only lint.
- `/checks git-status` → runs the universal git check; `/checks bogus` → error "Unknown check 'bogus'".
- Start a long check, press Esc/abort → **if `ctx.signal` is supported on commands** (FLAG), the loop breaks on `ctx.signal?.aborted` and status clears; if not, the check runs to its `timeoutMs`.
- Run `/verify` afterward → identical pass/fail, proving one allowlist.

### 6. Effort / dependencies / risks
**Effort: M** (the refactor is the bulk; the command is small). **Depends on:** the `checks-core.ts` extraction (also de-risks `runner.ts`); no new npm deps.
- **Risk: refactor breaks the Verifier's `run_check`.** → Keep `runner.ts`'s `execute` semantics identical; the live `/verify` test in §5 is the regression check.
- **Risk: relative import `../shared/` fails when symlinked.** → Symlink targets the real repo dir so `../shared/` resolves; verify by loading `/checks` post-install (do not copy only the extension dir without `shared/`).
- **Risk: failures only in UI, model unaware.** → **Decision:** print to UI only (widget + notify), do **not** feed results back to the model — this command's purpose is a zero-token operator smoke test; surfacing to context defeats it. (Operators escalate to `/verify` when they want the model to act on findings.) Document this in the command description.
- **Risk: `test-file` in "all" run.** → Excluded from "all" (needs a path); explicit `/checks test-file <path>` would require extending the handler to accept a path arg — note as a follow-up, out of scope now.
- **FLAG (verify live):** (1) **`ctx.signal` on the command context is unconfirmed** (verified for tool `execute()`, not for `registerCommand` handlers). The skeleton uses it only via `ctx.signal?.aborted` and passes it to `runFixed` (which accepts `signal | undefined`), so if it's absent `/checks` still works — it just can't be cancelled mid-run (checks bounded by their own `timeoutMs`). Add a live cancellation test. (2) `ctx.ui.notify` "success" level is unconfirmed — code uses `info`/`warning` only. (3) `setWidget` `placement:"belowEditor"` is confirmed; the array-of-strings content form is example-only — verify the widget renders.

### 7. Composition with the runner / sub-agents / other extensions
One allowlist, one policy: `checks-core.ts` is the single source of truth for "what may run and with what argv," imported by **both** the Verifier's `run_check` tool (`runner.ts`) and this main-session `/checks`. The Verifier still spawns an isolated subprocess and writes `verdict.md`; `/checks` is the cheap, no-subprocess, no-token preflight that runs the *exact same* commands, so a green `/checks` predicts a clean Verifier run. It composes cleanly with `command-guard` (#1) — `/checks` only ever runs fixed argv from the allowlist, so the guard has nothing to block — and with `experiment-autocomplete` (#6), which can complete `/checks <name>` from `allCheckNames(cfg)`. No state is shared beyond the on-disk `harness/checks.json`.