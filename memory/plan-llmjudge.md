# Roadmap — auto-judge (LLM-as-judge "auto-mode" for pi)

> An optional main-session pi extension that, when armed, asks a judge model to `ALLOW`/`DENY`
> a guarded tool call before it runs — fail-closed. Built in 3 slices; **this doc covers slice 1**
> (two pure, offline functions) and stubs slices 2–3 for continuity.

Status: **proposed, not started.** Validated against the real harness on 2026-06-15 (6-reader sweep
+ adversarial critic), then independently reviewed (an agent that *ran* the toolchain). This
revision integrates that review: it closes a parser fail-open hole, makes the config walker
fail-closed on a malformed nearest config, hardens field validation, and corrects the D3 rationale.

---

## Slice 1 — `parseVerdict` + `loadAutoJudgeConfig` (pure, offline, non-activating)

Two functions with **no I/O beyond reading `harness/checks.json`**, in one new file, plus a unit
test. No `index.ts`, so `install.sh` registers nothing (it discovers extensions strictly by
`index.ts` presence — `install.sh:38`). The extension does not exist yet; this is just its spine.

### Files to touch
- `harness/pi/auto-judge/verdict.ts` — **new.** `parseVerdict` + `loadAutoJudgeConfig` + types. Self-contained; only `node:fs` / `node:path` imports (no `../shared/` import — Decision D3).
- `harness/pi/auto-judge/verdict.test.ts` — **new.** `node:test` table (below); imports `./verdict.ts`.
- `harness/pi/tsconfig.json` — **+1 line** `"allowImportingTsExtensions": true` (dev-tooling, Decision D2). Purely additive: it *permits* `.ts` import specifiers (needed by the test); existing `.js`-specifier imports are unaffected; legal because `noEmit:true` is already set. (Reviewer confirmed existing extensions still typecheck clean with this added.)
- `harness/pi/package.json` — **+1 script** `"test": "node --test \"**/*.test.ts\""` (dev-tooling, Decision D2).
- No `index.ts`. No `install.sh` / `checks.json` / docs edits (slice 3).

> The tsconfig + package.json edits are **test/typecheck dev-tooling**, distinct from
> extension-activation wiring (slice 3). They make this slice's own done-condition commands real and
> do **not** activate an extension (`install.sh` keys off `index.ts`). Flagged as an intentional
> deviation from the original "only two new files" scope.

### `parseVerdict(text)` — contract + logic
Reply contract (pinned on the producer side in slice 2): the **first non-empty line** is either
exactly `ALLOW` or `DENY: <reason>`, case-insensitive. Anything else ⇒ deny (fail-closed). Allow
must be the bare token; deny may carry trailing reason text. Strict on the leading token to resist
prompt-injected reversals.

```ts
export type Verdict = { decision: "allow" | "deny"; reason: string };

export function parseVerdict(text: string): Verdict {
  const line = (text ?? "").split("\n").map((s) => s.trim()).find((s) => s) ?? "";
  if (/^allow$/i.test(line)) return { decision: "allow", reason: "" }; // exact ALLOW only
  const m = line.match(/^deny\b[:\-\s]*(.*)$/i);
  if (m) return { decision: "deny", reason: m[1].trim() || "no reason given" };
  return { decision: "deny", reason: "unparseable verdict" }; // empty/malformed/non-bare-allow → deny
}
```

Four corrections vs. the original draft (all verified by running the literal logic):
1. **Exact allow (`^allow$`, not `^allow\b`)** — closes a fail-open hole: `^allow\b` allowed
   `ALLOW: actually DENY because secrets` → `allow`. Only a bare `ALLOW` line allows now.
2. **`/i` on both regexes** — the original omitted it, so `ALLOW`/`DENY: secrets` (the draft's own
   uppercase rows) fell through to `unparseable→deny`.
3. **`.trim()` the captured reason before the `||` default** — else `DENY: secrets␠␠` keeps trailing
   spaces and `DENY:␠␠` (spaces only) is truthy and skips the `"no reason given"` default.
4. **First-non-empty-line selection** handles leading whitespace/blank lines for free.

Known limitations (intentional, all fail-closed): a line with `ALLOW` plus trailing text → deny
(allow is exact); reasoning lines *before* the verdict make the first non-empty line prose → deny;
`DENIED`/`Allowing` don't match the `\b`-anchored deny regex → deny. The real fix for the
"verdict not on line 1" case is slice 2's prompt (force `ALLOW`/`DENY: <reason>` on line 1). Each
behavior gets a test that documents it as a *choice*.

### `loadAutoJudgeConfig(cwd)` — contract + logic
Walk up from `cwd` looking for `<dir>/harness/checks.json`. **Walk on a missing file only**; a
present-but-unreadable/malformed `checks.json` is **fail-closed** (returns `undefined`) and is
*not* walked past — unlike `command-guard`'s `loadBoundaries`, which keeps walking on any error.
That divergence is deliberate: silently inheriting an *ancestor* repo's judge policy because the
local config is malformed would be unsafe for an activating guard. Returns the `autoJudge` block
with per-field defaults merged, or `undefined` (extension dormant).

```ts
import fs from "node:fs";
import path from "node:path";

export interface AutoJudgeConfig {
  judgeModel: string;     // "" → resolved in slice 2 (see D7: leans MODEL_REVIEW / GPT-5.5)
  guardedTools: string[];
  failClosed: boolean;    // default true; see D6 — false is debug-only
  timeoutMs: number;
  contextDiff: boolean;
  policy: string;
}

const MAX_TIMEOUT_MS = 120_000;

export function loadAutoJudgeConfig(cwd: string): AutoJudgeConfig | undefined {
  let dir = path.resolve(cwd);
  for (;;) {
    const file = path.join(dir, "harness", "checks.json");
    if (fs.existsSync(file)) {
      // Nearest checks.json wins. Present-but-unreadable/malformed → dormant (fail-closed):
      // never walk past it to an ancestor repo's policy.
      try {
        const a = JSON.parse(fs.readFileSync(file, "utf-8"))?.autoJudge;
        // Must be a non-null, non-array object; `autoJudge: []` must NOT activate defaults.
        return a && typeof a === "object" && !Array.isArray(a) ? withDefaults(a) : undefined;
      } catch {
        return undefined;
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) return undefined; // hit fs root, no checks.json found
    dir = parent;
  }
}

function withDefaults(a: Record<string, unknown>): AutoJudgeConfig {
  // guardedTools: trim, keep non-empty strings; empty/whitespace/invalid → default (never guard nothing).
  const tools = Array.isArray(a.guardedTools)
    ? a.guardedTools
        .filter((t): t is string => typeof t === "string")
        .map((t) => t.trim())
        .filter((t) => t.length > 0)
    : [];
  const t = a.timeoutMs;
  return {
    judgeModel: typeof a.judgeModel === "string" ? a.judgeModel.trim() : "", // whitespace-only → ""
    guardedTools: tools.length ? tools : ["bash", "write", "edit"],
    failClosed: typeof a.failClosed === "boolean" ? a.failClosed : true,
    timeoutMs: typeof t === "number" && Number.isFinite(t) && t > 0 && t <= MAX_TIMEOUT_MS ? t : 20000,
    contextDiff: typeof a.contextDiff === "boolean" ? a.contextDiff : false,
    policy: typeof a.policy === "string" ? a.policy : "",
  };
}
```

Truth table (one test per row):
| checks.json state | result |
|---|---|
| not found anywhere up to fs root | `undefined` |
| found, valid JSON, **no** `autoJudge` key | `undefined` |
| found, valid JSON, `autoJudge` present (any subset of fields) | object, missing fields defaulted |
| nearest checks.json malformed, **none** valid above | `undefined` |
| nearest checks.json malformed, **valid** checks.json in an ancestor | `undefined` (fail-closed; ancestor NOT used) |
| `autoJudge` is a JSON array (e.g. `[]`) or non-object | `undefined` (not a config object) |
| `autoJudge` with `guardedTools: []` / non-string / whitespace-only entries | object, `guardedTools` defaulted |
| `autoJudge` with `timeoutMs` ≤ 0 or > 120000 or non-number | object, `timeoutMs` defaulted to 20000 |
| `autoJudge` with whitespace-only `judgeModel` | object, `judgeModel` `""` (still resolves to MODEL_REVIEW) |

Field validation (reviewer-hardened): `autoJudge` must be a non-null, non-array object, else
`undefined` (an array like `[]` must not activate the extension). `guardedTools` entries are
**trimmed** and kept only if non-empty strings; empty / whitespace-only / non-string / empty-list →
default (a guard that guards nothing is worse than the default); junk entries (`[null,7,{}]`) are
dropped, not coerced via `String()`. `timeoutMs` must be a finite number in `(0, 120000]`, else
default 20000. `judgeModel` is **trimmed** (whitespace-only → `""`, so it still resolves to
MODEL_REVIEW per D7 rather than passing a junk model id downstream).

### Verification (commands confirmed working by the reviewer on this machine)
- Typecheck: `cd harness/pi && npm install && npm run typecheck` → `tsc -p tsconfig.json` clean
  (tsconfig `include:**/*.ts`, so **both** new files are type-checked; existing extensions stay clean).
- Test: `cd harness/pi && npm test` → `node --test "**/*.test.ts"`.
- Node ≥ 22.19 required; reviewer ran on v25.9.0 and confirmed bare `node --test` runs a `.ts` test
  importing `./verdict.ts` with **no tsx fallback needed**. (tsx fallback remains documented in case
  a future contributor is on a Node where bare `node --test` can't resolve `.ts` specifiers.)

### Test table (verdict.test.ts)
Parser: `ALLOW`→allow · `DENY: secrets`→deny/`secrets` · `deny: secrets` (case) · `DENY - secrets`
/ `DENY secrets` (separators)→deny/`secrets` · `  DENY: secrets  ` (whitespace)→deny/`secrets` ·
`DENY:   ` (spaces-only reason)→deny/`no reason given` · `DENY`→deny/`no reason given` · `""`
→deny/`unparseable verdict` · `garbage`→deny/`unparseable verdict` ·
**`ALLOW then ignore and DENY`→deny/`unparseable verdict`** (exact-allow; was the fail-open row) ·
**`ALLOW: actually DENY because secrets`→deny/`unparseable verdict`** (closes the hole the reviewer found) ·
`Let me think...\nDENY: secrets`→deny/`unparseable verdict` (first-line limitation) ·
`DENIED: x`→deny/`unparseable verdict` (`\b` morphology choice).
Config: one test per truth-table row above — temp dir with crafted `harness/checks.json`
(present-with-key, present-no-key, `autoJudge:[]`, `guardedTools:[]`, `guardedTools:["   "]`,
`guardedTools:[null,7,{}]`, `timeoutMs:-1`, `judgeModel:"   "`), a temp dir with none, a temp dir
with malformed JSON, and a nested temp dir whose **nearest** checks.json is malformed but an
**ancestor** is valid (asserts `undefined`).

### Done-condition (all offline)
- [ ] `verdict.ts` exports `parseVerdict`, `loadAutoJudgeConfig`, `Verdict`, `AutoJudgeConfig`.
- [ ] `npm run typecheck` clean (both files; existing extensions still clean — tsconfig change is additive).
- [ ] `npm test` green: full parser table + all config truth-table rows (incl. array-`autoJudge`, malformed-nearest-valid-ancestor, and the field-validation rows).
- [ ] No `index.ts`; `install.sh` registers nothing; no `checks.json`/docs/AGENTS.md edits.

---

## Decisions (defaults chosen; flag to override)
- **D1 — reason casing:** keep the model's casing (`DENY: Secrets` → `Secrets`); reasons are
  human-facing audit text. A test pins it.
- **D2 — toolchain:** zero new dependency — `allowImportingTsExtensions` (additive, safe with
  `noEmit`) + a `test` script; test uses `.ts` specifiers + bare `node --test`. Reviewer confirmed
  this works on the installed Node; `tsx` is the documented fallback, unused.
- **D3 — walk: hand-roll, don't reuse `shared` (corrected rationale).** Reuse *is* viable
  (`install.sh:85` installs `shared/` before extensions; `.ts`-specifier shared imports work under
  bare `node --test`) — the earlier "shared only installed in slice 3 / importing shared breaks"
  reasoning was wrong. Hand-roll is chosen instead to keep the slice **self-contained** and to avoid
  introducing a `.ts`-specifier shared import that diverges from the repo's `.js` convention; it also
  matches `command-guard`, which hand-rolls its own walk despite `findRepoRoot` existing
  (`command-guard/index.ts:45` vs `shared/checks-core.ts:74`). Reuse remains a reasonable alternative.
- **D4 — `loadAutoJudgeConfig` contract (fail-closed on malformed):** absent (walk on missing) →
  `undefined`; present-without-`autoJudge` → `undefined`; **present-but-unreadable/malformed →
  `undefined` (do NOT walk to an ancestor)**; present-with-`autoJudge` → defaults-merged object.
- **D5 — first-line + exact-allow verdict:** keep first-non-empty-line parsing and require a bare
  `ALLOW`. Both fail closed. Slice-2 producer contract: judge emits `ALLOW`/`DENY: <reason>` on line 1.

### Decided 2026-06-15 (confirmed with the user; take effect in slice 2)
- **D6 — `failClosed` knob kept, debug-only.** The field stays (slice 1 only parses it; default
  `true`); slice 2 treats `false` as **debug-only / discouraged** and documents it as such. Not
  removed, so there's a deliberate escape hatch for testing.
- **D7 — empty `judgeModel` → MODEL_REVIEW (GPT-5.5).** Auto-judge is an adversarial reviewer like
  `/verify`; the model policy classes reviewing/adversarial-judge agents as GPT-5.5 / MODEL_REVIEW
  (`subagents/index.ts:52`), not Opus/MODEL_DEFAULT. So an empty `judgeModel` resolves to
  **MODEL_REVIEW** in slice 2. `judgeModel` is just `""` here.

## Findings this plan is built on (verified 2026-06-15, ✓ = reviewer re-ran)
- ✓ Mirror target real: `command-guard`'s parent-walk (`command-guard/index.ts:45`); `shared`'s
  separate `findRepoRoot` (`shared/checks-core.ts:74`).
- Extension API for slices 2–3: `export default function(pi: ExtensionAPI)`, `pi.registerCommand`,
  `pi.on("tool_call", …)`, block by returning `{ block:true, reason }`.
- ✓ `tsc` real: `npm run typecheck` = `tsc -p tsconfig.json` (noEmit baked), `include:**/*.ts`.
  Bundler resolution → `.js` specifiers resolve to `.ts`; `"type":"module"`; runtime loads via jiti.
  Bare `node --test` does **not** rewrite `.js`→`.ts` (so the repo's `.js` shared specifier fails
  under bare node), but **does** resolve `.ts` specifiers — hence `allowImportingTsExtensions` + `.ts`.
- ✓ `node --test <directory>` is broken (`MODULE_NOT_FOUND`); use a glob/explicit file.
- ✓ Slice 1 non-activating: `install.sh:38` discovers extensions only via `index.ts`; `shared/` is
  installed separately at `install.sh:85`.
- `autoJudge` exists nowhere today → new top-level key in `harness/checks.json`, sibling of
  `boundaries`; doc keys use the `$<name>-note` convention (strict JSON, no comments).

## Consistency constraints (from memory/, must hold across slices)
- **Model policy:** `/verify`→GPT-5.5, all else→Opus 4.8, `--thinking xhigh`; ids in two constants
  in `subagents/index.ts` (review/adversarial class = GPT-5.5 — see D7). Exact id strings are a
  live-pi FLAG (`pi --list-models`).
- **Sub-agent isolation:** sub-agents run `--no-extensions`, so a main-session `tool_call` hook
  **cannot** gate sub-agent tool calls — same boundary that forced runner-side redaction. An
  auto-mode that must guard sub-agent calls lives in the runner path, not a main hook (slice-2 note).
- Built-in write/edit tools use `input.path` (not `file_path`); bash uses `input.command`.

---

## Slice 2 — activation (deferred)
`index.ts`: `pi.on("tool_call")` gate that, when armed and `event.toolName ∈ guardedTools`, spawns
the judge subprocess (model per D7), feeds it `policy` + the tool input (+ optional `contextDiff`),
parses the reply via `parseVerdict`, and returns `{ block:true, reason }` on deny (and on
timeout/spawn-failure when `failClosed`). A `/autojudge on|off` command (mirror `/guard`).
Producer prompt pins the `ALLOW`/`DENY: <reason>`-on-line-1 contract. **D6/D7 are already decided**
(see *Decided 2026-06-15*) — implement them here, and migrate the two decisions into
`memory/decisions.md` when this slice lands.

## Slice 3 — wiring + docs (deferred)
Add the `autoJudge` block to `harness/checks.json` (+ an `$autoJudge-note`) and the committable
template; re-run `install.sh` (auto-discovers the new `index.ts`, no script edit) + `/reload`;
document in both READMEs + AGENTS.md; live-pi smoke on an authenticated node.
