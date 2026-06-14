The `/monitor` extension and `memory/runs/<run>.log` don't exist in the repo yet (referenced as a sibling extension in the broader plan). I have enough to write the plan.

## `secret-redaction` — scrub secrets from tool output before context/disk

A main-session pi extension that mutates tool-result text in place, replacing detected secrets with `[REDACTED]` before the model ingests them or they're persisted. Precedent: the ecosystem `filter-output.ts`; in-repo it pairs with `runner.ts` (the runner controls *what* runs; this controls *what comes back*).

### 1. Where it lives + how it's installed
Path: `/Users/alex/agent-system/harness/pi/secret-redaction/index.ts` (mirrors the `harness/pi/subagents/` convention — one dir per extension, default export taking `ExtensionAPI`).

**Install choice:** keep extensions as **separate symlinked dirs**, but **generalize `install.sh`** to loop over every immediate subdir of `harness/pi/` instead of hard-coding `subagents`. Rationale: pi loads each top-level dir under `~/.pi/agent/extensions/` independently; bundling unrelated hooks into one file couples lifecycles and defeats the per-extension `--no-extensions`/`-e` selectivity the subagents engine relies on (`index.ts:267-269`). The loop preserves the existing `--copy`/`--uninstall`/backup semantics per dir (`install.sh:42-56`). This is a one-time edit that also installs every future `harness/pi/*` extension automatically.

### 2. Registration code (idiomatic skeleton, verified field names)
`event.content` is the result content-array on `tool_result` and is mutable; `event.toolName`/`event.isError` are the verified names. We redact on `tool_result` (not `tool_execution_end`, whose payload is `result`, not `content` — flagged in the API notes).

```ts
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
// ⚠ FIX (plan verification R5 #2 / R6 #2): the SHARED module is the ONE implementation. redact.ts owns ALL
// replacement logic — including per-pattern rules that must preserve a capture group (e.g. Authorization
// headers → "$1[REDACTED]"), which a flat out.replace(re, "[REDACTED]") can't do. The hook does NO loop of
// its own; it just calls the configured redact(). Same function the runner's runFixedTee uses → no drift.
import { loadRedactor } from "../shared/redact.js";

export default function secretRedaction(pi: ExtensionAPI) {
  const redact = loadRedactor(process.cwd()); // → a configured redact(text) closure (defaults + harness/redaction.json)

  // tool_result: event.content is the mutable content-block array the model will see.
  pi.on("tool_result", async (event) => {
    const content = (event as any).content;
    if (!Array.isArray(content)) return;
    for (const block of content) {
      if (block?.type === "text" && typeof block.text === "string") {
        block.text = redact(block.text); // mutate IN PLACE via the SHARED redactor — no local replace loop
      }
    }
    // returning nothing = keep the (now-mutated) result
  });
}
```

Mutating the block objects in place is what guarantees the model and any persistence see the scrubbed text — do not return a new array, since the verified API for `tool_result` modification is in-place mutation of `event.content`.

### 3. Config / inputs — owned by `harness/pi/shared/redact.ts` (the ONE implementation)
⚠ **FIX (plan verification R5 #2):** the patterns, the `redact(text)` function, and the `harness/redaction.json` loader live **only** in `harness/pi/shared/redact.ts` (a P2.0b deliverable). This extension and the runner's `runFixedTee` both import it — there is **no** local `patterns.ts`. The schema/defaults below describe what `redact.ts` implements:
Read once from repo root via the same walk-up pattern as `runner.ts:65-79`. Schema:
```json
{
  "replacement": "[REDACTED]",
  "extraPatterns": ["mycorp-[a-z0-9]{32}"],
  "disableDefault": false
}
```
Default pattern set (anchored, secret-shaped — deliberately NOT bare hex/base64, to avoid over-redaction):
- Provider keys: `\b(sk|pk|rk)-[A-Za-z0-9]{20,}\b`, `\bgh[pos]_[A-Za-z0-9]{36}\b`
- AWS: `\bAKIA[0-9A-Z]{16}\b`, `\bASIA[0-9A-Z]{16}\b`
- Slack/Google: `\bxox[baprs]-[A-Za-z0-9-]{10,}\b`, `\bAIza[0-9A-Za-z_\-]{35}\b`
- Bearer/Authorization headers: `/(Authorization:\s*(?:Bearer\s+)?)\S+/gi` → keep `$1[REDACTED]`
- Assignments: `/((?:API_)?(?:KEY|TOKEN|SECRET|PASSWORD)\s*[=:]\s*)(['"]?)[^\s'"]+\2/gi`
- PEM blocks: `/-----BEGIN [^-]+ PRIVATE KEY-----[\s\S]+?-----END [^-]+ PRIVATE KEY-----/g`

`extraPatterns` are compiled with a guard (try/catch around `new RegExp`, skip invalid — mirrors `runner.ts:150-154`). No config file = defaults only.

### 4. Build steps
1. Ensure `harness/pi/shared/redact.ts` exists (P2.0b): `loadRedactor(cwd)` walks up to the repo root, reads `harness/redaction.json`, compiles defaults + extras, and **returns a configured `redact(text)` closure**. ALL replacement logic lives here — including the per-pattern rules that preserve a capture group (the Authorization header → `$1[REDACTED]`), so callers never reimplement a replace loop. The same module/function is imported by the runner's `runFixedTee`. Then create `harness/pi/secret-redaction/index.ts` (above) importing from `../shared/redact.js`. **No local `patterns.ts`.**
2. Generalize `install.sh`: replace the fixed `SRC_DIR=.../subagents` with a loop installing each `harness/pi/*/` dir that has an `index.ts`. **⚠ FIX (verifier R6 #3): `--copy` installs MUST also copy `harness/pi/shared/` to `~/.pi/agent/extensions/shared/`** (this extension imports `../shared/redact.js`; symlink installs resolve via the link target, copies don't) — same requirement as `/checks` (IMPLEMENTATION-PLAN.md P2.0a). Thread `--copy`/`--uninstall`/backup per dir.
3. `tsc --noEmit` against `@earendil-works/pi-coding-agent` types to confirm the `tool_result` handler typechecks (the `as any` cast on `content` is the documented-but-untyped escape; flag for a real type once confirmed live).
4. Run `harness/pi/install.sh`; `/reload` in pi.

### 5. Testing (live pi)
- In a harnessed repo, run a tool that emits a secret: type `run a command that prints AKIAIOSFODNN7EXAMPLE and export API_TOKEN=ghp_0123456789abcdefghijABCDEFGHIJ012345`. In the transcript the values must appear as `[REDACTED]`; the surrounding command text stays intact.
- Negative test: print a plain 64-char git SHA-like hex string and a normal base64 blob → must NOT be redacted (proves no over-redaction).
- Add `{"extraPatterns":["EXP-[0-9]{6}"]}` to `harness/redaction.json`, `/reload`, print `EXP-123456` → redacted. Malformed regex in config → extension still loads (guard works).
- **`$1`-preserving rule:** a tool that emits `Authorization: Bearer ghp_0123456789abcdefghijABCDEFGHIJ012345` → the header name stays, the token becomes `[REDACTED]` (proves `redact()` owns the capture-group replacement, not a flat replace).
- **`--copy` install (verifier R6 #3):** run `harness/pi/install.sh --copy`, `/reload`, and confirm `secret-redaction` loads and redacts — i.e. `~/.pi/agent/extensions/shared/redact.*` was copied and `../shared/redact.js` resolves. (Same check `/checks` does.)

### 6. Effort / deps / risks
**Effort: S.** Deps: `@earendil-works/pi-coding-agent` types only (no new runtime deps); install.sh generalization.

- **Over-redaction of legit data** → patterns are length/prefix-anchored and assignment-keyword-gated; never match bare hex/base64.
- **Secret split across two content blocks / streamed chunks** → redaction is per-block; mitigate by also documenting that `run_check`/bash output arrives as a single text block (it does, per `runner.ts:330`), so cross-block splits are unlikely in practice.
- **`tool_execution_end` payload uses `result` not `content`** → we deliberately hook only `tool_result`; if a downstream consumer reads `tool_execution_end.result`, add a second handler scrubbing `event.result` (flagged: verify the `result` shape live before relying on it).
- **Disk tee bypasses this hook** → correct, and expected: `/monitor`'s `memory/runs/<runId>.log` is scrubbed by the **runner's own** `redact()` in `runFixedTee` (shared patterns), NOT by this main-session hook — see §7.

### 7. Composition (one policy, two enforcement points)
**⚠ FIX (plan verification #2/#4): this hook is MAIN-SESSION ONLY.** It fires on `tool_result` in the main session, so it scrubs `bash`/`run_check`/other main-session tool output. It does **NOT** see `/monitor`'s output: `/monitor` runs in a `--no-extensions` subprocess (this hook isn't even loaded there), and `run_experiment` tees raw process output straight to `memory/runs/<runId>.log` before any main-session event exists. So there is **no single chokepoint** — redaction lives in **two call sites sharing ONE pattern set**: (1) this hook (main session), and (2) the runner's `runFixedTee` (sub-agent stream + disk tee), both importing `redact()` from `harness/pi/shared/redact.ts` (P2.0b). Do **not** assume `/monitor` flows through this hook or try to make it tee "already-redacted `event.content`" — the runner owns its own redaction (see `monitor-design.md §6.3`). Net: every output path — main-session tools here, sub-agent + disk in the runner — is scrubbed by the same patterns from one source file.