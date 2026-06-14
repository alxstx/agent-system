I have everything I need. The frontmatter uses `applyTo` with comma-separated globs and an optional `description`. No glob dep exists, so I'll specify a tiny matcher. Here is the implementation plan.

## boundary-instructions — path-scoped `.github/instructions/*.instructions.md` rules surfaced into pi

Brings Copilot's path-scoped rules to pi: each `.github/instructions/*.instructions.md` has YAML frontmatter with an `applyTo` glob (comma-separated, per `example.instructions.md:3`). When the model is about to `edit`/`write` a matching file, steer that rule's body into context *before* the edit runs — realizing the harness "progressive disclosure" principle: rules cost zero tokens until a matching file is touched.

### 1. Where it lives + how it's installed
Path: `harness/pi/boundary-instructions/index.ts` (matches the `harness/pi/<name>/index.ts` convention of `subagents/`).

`install.sh` today hardcodes a single `subagents` dir (`install.sh:19-21`). **Choice: keep one extension = one symlink, and generalize `install.sh` to loop over every `harness/pi/*/` dir that contains an `index.ts`**, symlinking each into `~/.pi/agent/extensions/<name>`. Justification: pi loads each extension dir independently; bundling unrelated hooks into one file couples lifecycles and defeats `--no-extensions`-style selective control. A loop keeps each extension a clean, separately-installable unit while staying one script. Minimal change: replace the fixed `SRC_DIR`/`DEST` with a `for d in "$ROOT"/harness/pi/*/; do [ -f "$d/index.ts" ] && link …; done`, preserving the existing `--copy`/`--uninstall`/backup logic per target.

### 2. Registration code (real pi API, verified field names)
```ts
import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

interface Rule { applyTo: string[]; title: string; body: string; file: string }
let RULES: Rule[] = [];
let REPO_ROOT = "";                  // ⚠ FIX (verifier R10 #2): applyTo globs are REPO-ROOT-relative, not cwd-relative
const SURFACED = new Set<string>(); // fire at most once per file per session

export default function boundaryInstructions(pi: ExtensionAPI) {
  pi.on("session_start", (_e, ctx) => {
    REPO_ROOT = findRepoRoot(ctx.cwd);                                   // reuse the walk-up helper (index.ts:136)
    RULES = loadInstructions(path.join(REPO_ROOT, ".github", "instructions"));
    SURFACED.clear();
  });

  pi.on("tool_call", (event, ctx) => {
    if (event.toolName !== "edit" && event.toolName !== "write") return;       // verified: toolName
    const p = event.input?.file_path ?? event.input?.path ?? "";               // verified: input
    if (!p) return;
    const abs = path.resolve(ctx.cwd, p);                  // resolve the target against the CALLER's cwd…
    const rel = path.relative(REPO_ROOT, abs);             // …but match/dedupe/display REPO-ROOT-relative
    if (rel.startsWith("..") || path.isAbsolute(rel)) return;  // edit outside the repo → no repo rules apply
    const hits = RULES.filter(r => r.applyTo.some(g => matchGlob(g, rel)) && !SURFACED.has(`${r.file}::${rel}`));
    if (!hits.length) return;
    for (const r of hits) SURFACED.add(`${r.file}::${rel}`);
    const text = hits.map(h => `### Rule for \`${rel}\` (${h.title})\n${h.body.trim()}`).join("\n\n");
    pi.sendMessage(
      { customType: "boundary-rule",
        content: `Path-scoped rules apply to ${rel}. Follow them in this edit:\n\n${text}`,
        display: true },
      { deliverAs: "steer" } // inject into the CURRENT turn so the model obeys before editing
    );
    ctx.ui.notify(`Loaded ${hits.length} path-scoped rule(s) for ${rel}`, "info");
  });
}
```

**Surfacing mechanism — justification.** `ctx.ui.notify` is human-only and the model never sees it, so it can't make the model *follow* the rule. The brief's goal is adherence, so steer the rule text into the model's context via `pi.sendMessage(..., { deliverAs: "steer" })` (matching the existing `deliverAs` usage in `subagents/index.ts:488,512`), with a `notify` only as an operator breadcrumb. `steer` over `nextTurn` because the edit is *this* turn — we want the rule in front of the model before/as it commits the change. (FLAG: confirm `deliverAs: "steer"` lands in-turn against live pi; if `tool_call` cannot inject mid-turn, fall back to mutating `event.input` is N/A here — instead block once with `{ block: true, reason: <rule text> }` so the model re-issues the edit having seen the rule. Decide after a live test in §5.)

### 3. Config / inputs
Reads `<repoRoot>/.github/instructions/*.instructions.md`. No new config file — the instructions files *are* the schema. Per file: YAML frontmatter `applyTo` (string; comma-separate multiple globs per `example.instructions.md:5`) and optional `description` (used as `title`); body is the markdown after the frontmatter. Defaults: missing dir → `RULES = []` (no-op); a file with no `applyTo` → skipped. Frontmatter parsing: a ~10-line hand-rolled reader (split on the first two `---` lines, regex `applyTo:` / `description:`) — avoid a YAML dep; the schema is two flat keys. Repo-root discovery: reuse `findRepoRoot` (the walk-up at `subagents/index.ts:136`). **⚠ Matching is REPO-ROOT-relative, not cwd-relative** — `applyTo` globs are written relative to the repo root (e.g. `src/api/**/*.ts`), so the hook resolves the edit target against `ctx.cwd` then computes `path.relative(REPO_ROOT, abs)` for matching/dedupe/display, and ignores edits outside the repo. (cwd-relative matching would silently miss when pi is launched from a subdirectory.)

**Glob matching — tiny matcher, no dep** (`package.json` has no glob dep). Support the Copilot subset actually used: `**`, `*`, `?`, comma-separated alternatives. Compile each glob to a RegExp once at `session_start`: escape regex-specials, then `**`→`.*`, `*`→`[^/]*`, `?`→`[^/]`. This covers `src/api/**/*.ts`. (FLAG: brace `{a,b}` expansion not supported — comma-separating whole globs in `applyTo` covers the documented case, so braces are out of scope.)

### 4. Build steps
1. Create `harness/pi/boundary-instructions/index.ts` with the skeleton above.
2. Add `loadInstructions`, `findRepoRoot` (reuse the one at `index.ts:136`), `parseFrontmatter`, `matchGlob` helpers (compile globs at load); store `REPO_ROOT` at `session_start`.
3. Generalize `install.sh` to loop over `harness/pi/*/index.ts`.
4. Type-check against `@earendil-works/pi-coding-agent`.
5. Run `harness/pi/install.sh`; `/reload` in pi.
6. Confirm the symlink at `~/.pi/agent/extensions/boundary-instructions`.

### 5. Testing (live pi)
1. In the repo, ask pi to "edit `src/api/users.ts`." Expect a `notify` "Loaded 1 path-scoped rule(s)…" and the model to acknowledge/apply the three rules from `example.instructions.md` (boundary validation, shared error envelope) — verify the steered text appears in the model's reasoning before it writes.
2. Edit the *same* file again in the session → **no** second surfacing (dedupe via `SURFACED`).
3. Edit a non-matching file (`README.md`) → no rule fires.
4. Edit a file matching after you add a new `*.instructions.md` and `/reload` → new rule loads (cache rebuilt at `session_start`).

### 6. Effort / dependencies / risks
**Effort: M** (glob matcher + frontmatter parser are the only real work). **Dependencies:** none new (stdlib `fs`/`path`); relies on `tool_call`/`input`/`toolName` + `pi.sendMessage` deliverAs.
- *Risk: steer mid-`tool_call` may not be supported* → mitigate by the `{ block: true, reason }` fallback decided in §5's live test.
- *Risk: glob matcher misses a Copilot pattern (braces)* → keep the matcher's supported subset documented; comma-separate globs instead of braces.
- *Risk: nagging on every edit of a hot file* → `SURFACED` set keys on `file::relpath`, fires once per file per session.
- *Risk: relative-path mismatch when pi launches from a subdirectory* → ⚠ FIX (verifier R10 #2): the `applyTo` globs are **repo-root-relative**, so match `rel = path.relative(REPO_ROOT, path.resolve(ctx.cwd, p))` (with `REPO_ROOT` stored at `session_start`) and reject paths outside the repo — **not** `path.relative(ctx.cwd, …)`, which fails from a subdir (`src/api/users.ts` → `users.ts` or `../src/api/users.ts`).

### 7. Composition with runner / sub-agents / other extensions
One consistent policy: **structural gates (`command-guard`, `runner.ts` allowlist) decide what may run; `boundary-instructions` shapes what the model knows before it acts.** It is advisory/contextual, complementing — never overriding — `command-guard`'s `{ block: true }` on the AGENTS.md Boundaries paths. It runs only in the **main session**; sub-agents spawn with `--no-extensions` (`subagents/index.ts:267`), so the Verifier/Planner never re-enter it — exactly the isolation the harness already enforces. Like `runner.ts`, it reads repo config (here `.github/instructions/`) at load so main session and any future tooling share one source of truth for path-scoped rules.