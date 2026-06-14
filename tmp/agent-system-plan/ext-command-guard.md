I have everything I need. Here is the implementation plan.

## `command-guard` — structural enforcement of AGENTS.md "Boundaries" + "pause before irreversible changes"

A main-session extension — **one `pi.on('tool_call')` hook plus one `/guard on|off` command** (the override toggle, §2/§5) — that BLOCKS destructive bash and writes/edits into configured boundary paths, mirroring `runner.ts`'s "structural, not advisory" philosophy. It spawns no subprocess — a pure pre-execution gate.

### 1. Where it lives + how it is installed

Path: `harness/pi/command-guard/index.ts` (matches the `harness/pi/<name>/index.ts` convention of `subagents/`). Single file, no runner needed.

Installation: **extend `install.sh` to symlink every `harness/pi/*` extension that has an `index.ts`**, rather than hardcoding `subagents`. pi loads each directory under `~/.pi/agent/extensions/` independently, and these are independent concerns (one is commands, one is a guard hook) — bundling them into one extension would couple unrelated lifecycles and break the clean `--no-extensions ... -e runner.ts` isolation the Verifier relies on. Concretely, replace the fixed `SRC_DIR=.../subagents` / `DEST=.../subagents` (install.sh:19-21, 33-56) with a loop over `harness/pi/*/index.ts`, symlinking each basename into `$DEST_PARENT`. The `--copy`/`--uninstall` paths apply per-extension. Keep `subagents` working identically.

### 2. Registration code (complete skeleton, verified field names)

```ts
import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const DESTRUCTIVE: { re: RegExp; why: string }[] = [
  { re: /\brm\s+(-\w*\s+)*-?\w*[rf]/i, why: "recursive/forced rm" },
  { re: /\bgit\s+push\b[^\n]*--force(?!-with-lease)/i, why: "git push --force" },
  { re: /\bgit\s+reset\s+--hard\b/i, why: "git reset --hard" },
  { re: /\bgit\s+clean\s+-\w*[fd]/i, why: "git clean -fd" },
  { re: /(^|[^>])>(?!>)\s*\S/, why: "truncating redirect (>)" }, // not >>
];

function loadBoundaries(cwd: string): { repoRoot: string; boundaries: string[] } {
  let dir = path.resolve(cwd);
  for (;;) {
    try {
      const cfg = JSON.parse(fs.readFileSync(path.join(dir, "harness", "checks.json"), "utf-8"));
      if (Array.isArray(cfg.boundaries)) return { repoRoot: dir, boundaries: cfg.boundaries as string[] }; // repoRoot = where checks.json lives
    } catch { /* keep walking */ }
    const parent = path.dirname(dir);
    if (parent === dir) return { repoRoot: path.resolve(cwd), boundaries: [] };
    dir = parent;
  }
}

// ⚠ FIX (plan verification #5): override is a SESSION TOGGLE, not a `PI_GUARD_OFF=1 <cmd>` prefix.
// That prefix is part of event.input.command, NOT process.env — so process.env.PI_GUARD_OFF would
// never see it and the command would stay blocked. Use a /guard command flipping a module flag.
export default function commandGuard(pi: ExtensionAPI) {
  let armed = true;                                                 // default on
  pi.registerCommand("guard", {
    description: "Toggle command-guard for this session: /guard on|off",
    handler: async (args, ctx) => {
      const a = args.trim().toLowerCase();
      if (a === "off") armed = false; else if (a === "on") armed = true;
      ctx.ui.notify(`command-guard ${armed ? "ARMED" : "OFF"}`, armed ? "info" : "warning");
    },
  });
  pi.on("tool_call", (event, ctx) => {
    if (!armed) return;                                             // operator disarmed via /guard off
    const name = event.toolName;                                    // VERIFIED: toolName
    const input = (event.input ?? {}) as Record<string, any>;        // VERIFIED: input
    if (name === "bash" || name === "shell") {
      const cmd = String(input.command ?? "");
      const hit = DESTRUCTIVE.find((d) => d.re.test(cmd));
      if (hit) return { block: true, reason: `command-guard: ${hit.why} blocked by AGENTS.md "pause before irreversible changes". Run /guard off to override.` };
    }
    if (name === "write" || name === "edit") {
      const p = String(input.file_path ?? input.path ?? "");
      // ⚠ FIX (verifier R11 #1): boundaries are REPO-ROOT-relative (same bug fixed in boundary-instructions).
      // Match against the path relative to where harness/checks.json lives — NOT ctx.cwd — else launching pi
      // inside e.g. migrations/ and writing 0001.sql makes the (^|/)migrations/ boundary miss.
      const abs = path.resolve(ctx.cwd, p);
      const { repoRoot, boundaries } = loadBoundaries(ctx.cwd);
      const inRepo = abs === repoRoot || abs.startsWith(repoRoot + path.sep);
      const rel = inRepo ? path.relative(repoRoot, abs) : abs;       // repo-relative inside the repo; absolute outside
      const bad = boundaries.find((g) => new RegExp(g).test(rel) || new RegExp(g).test(p));
      if (bad) return { block: true, reason: `command-guard: ${p} matches AGENTS.md Boundary "${bad}". Propose a plan first (/guard off to override).` };
    }
  });
}
```

`{ block: true, reason }` is the VERIFIED block shape. Returning `undefined` allows the call.

### 3. Config / inputs

Add a **`boundaries` array to the existing `harness/checks.json`** (not a new file): one config object already walked by the runner, one place to keep in sync, and the `$schema-note` documents it. Each entry is a JS regex string matched against the edit target resolved **relative to the repo root** (where `checks.json` lives — NOT `ctx.cwd`; see the §2 skeleton fix), plus the raw path. Sane defaults to seed:

```json
"boundaries": ["(^|/)migrations/", "(^|/)vendor/", "\\.generated\\.", "(^|/)dist/", "(^|/)node_modules/", "(^|/)\\.venv/"]
```

Keeping in sync with AGENTS.md "Boundaries (do not touch without asking)" (AGENTS.md:48-49, currently a `{{PLACEHOLDER}}`): treat AGENTS.md prose as the human-readable source and `checks.json:boundaries` as its machine form. Document in the `$schema-note` that the two must be edited together; the destructive-bash list stays in code (it is a fixed safety floor, not per-project). No live-pi API needed to read either.

### 4. Build steps

1. Create `harness/pi/command-guard/index.ts` with the skeleton above.
2. Add the `boundaries` array + a note to `harness/checks.json` and to the example configs under `harness/examples/`.
3. Generalize `install.sh` to loop over `harness/pi/*/index.ts` (symlink each); verify `subagents` still installs.
4. Run `install.sh`; `/reload` in pi.
5. Typecheck against `@earendil-works/pi-coding-agent` types (confirm `event.toolName`/`event.input` against live pi — see risks).

### 5. Testing (live pi)

- Ask pi to `rm -rf build/` → tool call is blocked; you see the `reason` text in the transcript and the model adapts.
- Ask it to run `echo hi > notes.txt` (truncating `>`) → blocked; `echo hi >> notes.txt` (append) → allowed.
- Ask it to edit `migrations/0001.sql` → blocked with the Boundary reason; edit `src/foo.ts` → allowed.
- ⚠ CORRECTION (plan verification #5): the original `PI_GUARD_OFF=1 rm -rf build/` override is WRONG — that prefix is part of `event.input.command`, not pi's `process.env`, so `process.env.PI_GUARD_OFF` never sees it and the command stays blocked. Use a **session toggle** instead: add a `/guard on|off` command (same extension) flipping a module-level `armed` flag (default on). Test: `/guard off` → `rm -rf build/` proceeds → `/guard on` re-arms. Confirm `git push --force-with-lease` is NOT blocked (negative lookahead).

### 6. Effort / dependencies / risks

Effort: **S**. Dependencies: `@earendil-works/pi-coding-agent` types only; reads `harness/checks.json` (shares discovery logic with `runner.ts`/`index.ts` `findRepoRoot`). No subprocess.

- **Risk: payload field names unconfirmed against live pi.** The brief VERIFIES `event.toolName` + `event.input` for `tool_call`, but the bash arg key (`input.command`) is inferred. Mitigation: log `event.input` once on first run; the skeleton already falls back across `file_path`/`path`.
- **Risk: false positive — legit `rm` inside a build script.** A regex on `bash` `command` can't see intent. Mitigation: the **`/guard off` session toggle** is the explicit approve path (NOT a `PI_GUARD_OFF=1` command prefix — see §5 correction); also the redirect rule excludes `>>` and the `rm` rule only fires on `-r`/`-f`.
- **Risk: regex evasion** (`/bin/rm`, `git  push --force`, `\` line-continuation). Mitigation: patterns use `\b` and tolerate whitespace runs; document that this is a guardrail against accidents, not a sandbox — the real isolation is the Verifier's closed allowlist.
- **Risk: blocking the harness's own writes** (e.g. a subagent writing `memory/`). Mitigation: this hook runs only in the MAIN session; subagents spawn with `--no-extensions` (index.ts:267) so they never load it. Keep boundaries scoped to source/generated paths, never `memory/`.

### 7. Composition with runner / sub-agents / other extensions

One consistent policy: **`checks.json` is the single allowlist/denylist source.** The Verifier sub-agent enforces "only these checks may RUN" via `runner.ts`; `command-guard` enforces "only these paths may NOT be WRITTEN" via the same file in the main session. They never diverge because both read `harness/checks.json`. Sub-agents are immune (they load `--no-extensions`), so the guard governs exactly the surface that needs it — the human-driven main session. It composes additively with the other proposed main-session extensions (each its own `harness/pi/*` dir, all installed by the generalized `install.sh`): `command-guard` gates writes, a future `secret-redaction` gates outputs, the `token-budget` widget observes — independent hooks, one shared config file, zero subprocess overhead.