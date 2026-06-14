I now have a thorough understanding of the harness: the token philosophy (index in context, detail on disk; <200/<60 line caps), the prose rules in AGENTS.md (memory-update discipline, Boundaries, Definition of done, small reversible steps), the reusable `runner.ts` allowlist engine, the `checks.json` schema, the memory/plan/verdict file conventions, and the `/plan`-`/verify` extension pattern. I have everything needed to write the tailored menu.

# pi Main-Session Extensions for the Token-Minimizing Harness

All proposals run in the **main session** (tools / hooks / UI — not sub-agents), are tailored to this repo's actual mechanics (the `AGENTS.md` operating contract, the `<200`/`<60`-line caps, the `memory/plan-<feature>.md` + `tasks.md` + `verdict.md` file conventions, the `harness/checks.json` allowlist engine in `runner.ts`), and cite the exact pi mechanism. Ranked by value-to-effort, strongest first.

---

## 1. `command-guard` — structural enforcement of the "Boundaries (do not touch)" section
**(a) Mechanism:** `pi.on('tool_call', …)` returning `{ block: true, reason }`.
**(b) What it does:** Intercepts every `bash`/`write`/`edit` tool call; blocks destructive shell (`rm -rf`, `git push --force`, `git reset --hard`) and blocks writes/edits whose target path matches the repo's **Boundaries** list (generated/vendored paths, migrations, public API contracts) — returning a `reason` the model sees.
**(c) Why it fits:** AGENTS.md lists "Boundaries (do not touch without asking)" and "propose a plan and pause before large or irreversible changes" as **prose** the model must remember. The harness's own README principle #5 is "determinism where it belongs — always-run steps belong in a hook, not prose." This converts the single most expensive-to-undo rule into a structural gate, exactly mirroring the sub-agents' philosophy of a closed allowlist instead of trusting instructions. Precedent in this very repo: `runner.ts` already enforces "no shell, fixed argv" structurally rather than advisorily.
**(d) Effort:** S.
**(e) Sketch:**
```ts
const BOUNDARIES = [/(^|\/)migrations\//, /(^|\/)vendor\//, /\.generated\./];
const BAD_SHELL = /\brm\s+-rf\b|git\s+push\s+.*--force|git\s+reset\s+--hard/;
pi.on('tool_call', (e) => {
  const { name, input } = e.toolCall ?? e;
  if (name === 'bash' && BAD_SHELL.test(input?.command ?? ''))
    return { block: true, reason: 'Blocked by AGENTS.md Boundaries: destructive shell. Ask first.' };
  const p = input?.file_path ?? input?.path ?? '';
  if ((name === 'write' || name === 'edit') && BOUNDARIES.some(r => r.test(p)))
    return { block: true, reason: `Blocked: ${p} is a do-not-touch boundary. Propose a plan first.` };
});
```
**(f) Precedent:** Yes — `security.ts` (blocks dangerous commands) is the direct ecosystem precedent.

---

## 2. `token-budget` widget — make the `<200`/`<60`-line caps live and visible
**(a) Mechanism:** `ctx.ui.setWidget` (refreshed on `turn_end` and `tool_result` for edits).
**(b) What it does:** Renders a persistent widget showing live line counts of `AGENTS.md` and `memory/MEMORY.md` against their caps (e.g. `AGENTS 142/200 · MEMORY 71/60 ⚠`), turning the cap red and `notify`-ing once when either is exceeded.
**(c) Why it fits:** The "Keeping it cheap" section sets hard numeric caps (`AGENTS.md < 200`, `MEMORY.md < 60`) and the FAQ stresses that a bloated always-on file "degrades adherence and costs tokens every turn." These are the harness's headline invariants and currently invisible until someone counts lines. The whole project exists to minimize always-on tokens — surfacing the two always-loaded files' size is the most on-mission HUD possible.
**(d) Effort:** S.
**(e) Sketch:**
```ts
function refresh(ctx) {
  const n = (p, cap) => { const l = fs.readFileSync(p,'utf8').split('\n').length;
    return `${l}/${cap}${l>cap?' ⚠':''}`; };
  ctx.ui.setWidget('budget',
    `AGENTS ${n(agentsPath,200)} · MEMORY ${n(memoryPath,60)}`);
}
pi.on('turn_end', (_e, ctx) => refresh(ctx));
pi.on('session_start', (_e, ctx) => refresh(ctx));
```
**(f) Precedent:** `context-mode` (surfaces context state in the UI) is the analogue.

---

## 3. `/checks` — run the allowlisted checks in the MAIN session (reuse `runner.ts`)
> **NOTE:** this is the original brainstorm sketch — **superseded by `ext-slash-checks.md`** (the authoritative build plan: `checks-core.ts` extraction, `--copy` shared/ handling, and `ctx.signal` flagged as command-context-unconfirmed). Build from that doc, not this sketch.
**(a) Mechanism:** `pi.registerCommand('checks', …)` reading `harness/checks.json` and spawning the fixed argv vectors directly (the exact `loadConfig`/`runFixed` logic from `runner.ts`), no sub-agent.
**(b) What it does:** `/checks` runs the project's `test`/`lint`/`typecheck` allowlist (and git checks) inline and prints a compact green/red table; `/checks lint` runs one. A fast pre-`/verify` smoke test without spawning a subprocess.
**(c) Why it fits:** The Definition of done requires "Tests for the affected area pass (`{{TEST_CMD}}`); Lint/format is clean." Today the only way to run the allowlisted checks is to spawn the full Verifier sub-agent (a whole `pi` subprocess + model turns). For a quick "did I break lint?" the operator wants a deterministic, zero-token check. It reuses the same `checks.json` allowlist so the main session and the Verifier never diverge — and it keeps results off the model context (printed to UI, not fed back as tokens).
**(d) Effort:** M (factor the `loadConfig` + `runFixed` helpers out of `runner.ts` into a shared module both import).
**(e) Sketch:**
```ts
pi.registerCommand('checks', { description: 'Run allowlisted checks inline (green/red)',
  handler: async (args, ctx) => {
    const cfg = loadConfig(findRepoRoot(ctx.cwd));
    const names = args.trim() ? [args.trim()] : Object.keys(cfg.checks);
    for (const n of names) {
      const { cmd, args: a, timeoutMs } = cfg.checks[n];
      const out = await runFixed(ctx.cwd, cmd, a, timeoutMs, ctx.signal, undefined);
      ctx.ui.notify(`${out.exitCode === 0 ? '✓' : '✗'} ${n}`, out.exitCode ? 'warning' : 'info');
    }
  }});
```
**(f) Precedent:** No single named ext, but it's the same engine pattern as `runner.ts` already in-repo — high reuse, low novelty.

---

## 4. `auto-memory` — append a "Recent changes" line after a meaningful edit
**(a) Mechanism:** `pi.on('tool_result', …)` watching successful `edit`/`write` results, plus `pi.appendEntry` to dedupe across a turn; writes one line into the `## Recent changes` block of `memory/MEMORY.md`.
**(b) What it does:** After a turn that produced real source edits, prepends a dated bullet (`2026-06-13 — edited src/x.ts: <one-line summary>`) under "Recent changes (newest first — keep ~7 max)," and trims the list back to 7.
**(c) Why it fits:** "Update memory after meaningful changes" and "the change is logged" are in both the operating contract and the Definition of done — currently pure prose the model forgets. The MEMORY.md template literally pre-formats `## Recent changes (newest first — keep ~7 max)` waiting to be filled. Automating it both enforces the discipline and protects the `<60`-line cap by auto-pruning. This is determinism-where-it-belongs applied to the memory rule.
**(d) Effort:** M (deciding "meaningful," generating the one-line summary — fire on `turn_end`, summarize from the turn's edited paths; keep it mechanical to avoid an extra model call).
**(e) Sketch:**
```ts
const edited = new Set<string>();
pi.on('tool_result', (e) => { if (!e.isError && /^(edit|write)$/.test(e.name))
  edited.add(e.input.file_path ?? e.input.path); });
pi.on('turn_end', (_e, ctx) => {
  if (!edited.size) return;
  const line = `- ${today()} — edited ${[...edited].join(', ')}`;
  const md = fs.readFileSync(memoryPath,'utf8')
    .replace(/(## Recent changes[^\n]*\n)/, `$1${line}\n`);
  fs.writeFileSync(memoryPath, trimRecentTo7(md)); edited.clear();
});
```
**(f) Precedent:** Yes — `pi-todo-md` (an extension that maintains a markdown file from session activity) is the direct analogue.

---

## 5. `secret-redaction` — strip secrets from tool output before they hit context/disk
**(a) Mechanism:** `pi.on('tool_result', …)` (and `tool_execution_end`) mutating the output text in place with redaction patterns.
**(b) What it does:** Scrubs API keys, tokens, `.env` values, `Authorization:` headers, and AWS-style secrets from `bash`/`run_check` output before it enters the main context — replacing with `[REDACTED]`.
**(c) Why it fits:** The seed flags the `/monitor` "secrets in logs" risk; more fundamentally, this harness's premise is that everything entering the always-on context is precious and durable — and `/checks` (#3) and `auto-report` (#7) both surface raw command output. A leaked secret in the transcript is both a security and a token-permanence problem. It pairs naturally with the existing allowlist runner: the runner controls *what* runs, this controls *what comes back*.
**(d) Effort:** S.
**(e) Sketch:**
```ts
const PATTERNS = [/\b(sk|pk|ghp|gho)_[A-Za-z0-9]{20,}\b/g,
  /AKIA[0-9A-Z]{16}/g, /(?<=Authorization:\s*)\S+/gi,
  /(?<=_KEY=|_TOKEN=|_SECRET=)\S+/g];
pi.on('tool_result', (e) => {
  for (const c of e.content ?? [])
    if (c.type === 'text')
      for (const re of PATTERNS) c.text = c.text.replace(re, '[REDACTED]');
});
```
**(f) Precedent:** Yes — `filter-output.ts` (redacts secrets from output) is the exact precedent.

---

## 6. `experiment-autocomplete` — complete check + feature/plan names from disk
**(a) Mechanism:** `ctx.ui.addAutocompleteProvider`, sourcing from `harness/checks.json` keys and `memory/plan-*.md` slugs.
**(b) What it does:** When typing `/checks `, `/verify `, or `/plan `, offers completions: check names from `checks.json`, existing feature slugs from `plan-<feature>.md` files, and the current `.active-plan`.
**(c) Why it fits:** The experiment-heavy workflow keys everything off names that already live on disk — `checks.json` defines the check allowlist, `memory/plan-<feature>.md` files are the per-feature roadmaps, `.active-plan` is the pointer `/verify` resolves against. The operator currently has to remember or re-read these. It directly accelerates the `/plan` → `/verify` loop that is the harness's core cycle, and it reads from disk (no token cost) — perfectly on-philosophy.
**(d) Effort:** S.
**(e) Sketch:**
```ts
ctx.ui.addAutocompleteProvider({
  trigger: /^\/(verify|plan|checks)\s+(\S*)$/,
  complete: ({ cwd }) => {
    const repo = findRepoRoot(cwd);
    const feats = fs.readdirSync(path.join(repo,'memory'))
      .flatMap(f => /^plan-(.+)\.md$/.exec(f)?.[1] ?? []);
    const checks = Object.keys(loadConfig(repo).checks);
    return [...feats, ...checks].map(v => ({ value: v }));
  }});
```
**(f) Precedent:** Generic autocomplete-provider extensions exist; no single famous named one, but the API is first-class.

---

## 7. `auto-report` — write a durable verdict/run document automatically after `/verify`
**(a) Mechanism:** `pi.on('agent_end', …)` (or a custom event after the verify command) detecting that `memory/verdict.md` was just written, then appending a dated entry to a rolling `memory/reports/` log + a one-line MEMORY.md pointer.
**(b) What it does:** After every `/verify` (or `/monitor`) run, automatically files the verdict's PASS/FAIL + headline into a dated report and updates the MEMORY.md index pointer — "always write a document" without the operator remembering to.
**(c) Why it fits:** Definition of done step: "For non-trivial changes, `verify-change.md` returned PASS" — and the externalized-memory principle says durable results belong on disk, indexed, not held in context. The Verifier already writes `verdict.md` (overwritten each run); this preserves the history as a dated trail and keeps the MEMORY.md index current automatically, closing the "log the result" loop deterministically.
**(d) Effort:** M.
**(e) Sketch:**
```ts
let beforeSig: string | null = null;
pi.on('agent_start', () => { beforeSig = fileSig(verdictPath); });
pi.on('agent_end', (_e, ctx) => {
  if (fileSig(verdictPath) === beforeSig) return;           // verdict unchanged
  const v = fs.readFileSync(verdictPath,'utf8');
  const verdict = /\bFAIL\b/.test(v.split('\n')[0]) ? 'FAIL' : 'PASS';
  fs.appendFileSync(reportLog, `\n## ${nowIso()} — ${verdict}\n${firstLines(v,5)}\n`);
  ctx.ui.notify(`Report filed: ${verdict}`, 'info');
});
```
**(f) Precedent:** Partial — `pi-todo-md` (disk-file maintenance from events) is the closest analogue.

---

## 8. `boundary-instructions` loader — path-scoped rules in the main session
**(a) Mechanism:** `pi.on('tool_call', …)` for `edit`/`write` that injects (via `onUpdate`/notify, or by `pi.setActiveTools`) the matching `.github/instructions/*.instructions.md` rule whose `applyTo` glob matches the edited path — bringing Copilot's path-scoped rules to pi.
**(b) What it does:** Brings the repo's existing `.github/instructions/*.instructions.md` (`applyTo:` globbed rules) into pi: when the model is about to edit a matching file, the relevant narrow rule is surfaced — costing zero tokens until a matching file is touched.
**(c) Why it fits:** The README explicitly says path-scoped rules "load only for matching files" and are a token-saving mechanism — but that mechanism is Copilot-only today. pi currently ignores `.github/instructions/`, so a whole class of the harness's deliberately-cheap rules is dark in pi. This is "progressive disclosure" (the harness's principle #1) applied to rules, not just files.
**(d) Effort:** M (glob matching + frontmatter parsing of `applyTo`).
**(e) Sketch:**
```ts
const rules = loadInstructions(repo); // [{applyTo: glob, body}]
pi.on('tool_call', (e, ctx) => {
  if (!/^(edit|write)$/.test(e.name)) return;
  const p = e.input.file_path ?? e.input.path ?? '';
  const hit = rules.find(r => minimatch(p, r.applyTo));
  if (hit) ctx.ui.notify(`Rule for ${p}: ${hit.title}`, 'info');
});
```
**(f) Precedent:** No direct named ext, but it's the pi equivalent of Copilot's native `applyTo` feature already shipped in this repo.

---

## 9. `mcp-bridge` — unlock GitHub/browser/DB tools in the main session
**(a) Mechanism:** factory that connects MCP servers and re-exposes each as a `pi.registerTool`, per the `pi-mcp-adapter` / pi issue #563 pattern.
**(b) What it does:** Bridges configured MCP servers (GitHub, a browser, a DB) into pi tools usable in the main session, so the implement step can read issues/PRs or query a DB without leaving pi.
**(c) Why it fits:** Most generic of the set — it extends capability rather than enforcing a harness rule. It earns a place because the experiment-heavy workflow benefits from GitHub/DB context, and any new tools it adds automatically fall under #1's `command-guard` and #5's `secret-redaction`, so it composes with the harness's safety model rather than bypassing it.
**(d) Effort:** L.
**(e) Sketch:**
```ts
for (const srv of mcpServers) {
  const client = await connectMcp(srv);
  for (const t of await client.listTools())
    pi.registerTool({ name: `mcp_${srv.name}_${t.name}`, label: t.name,
      description: t.description, parameters: t.inputSchema,
      execute: (_id, p) => client.callTool(t.name, p) });
}
```
**(f) Precedent:** Yes — `pi-mcp-adapter` (pi issue #563) is the exact precedent.

---

## Ranking (value-to-effort)

| # | Extension | Mechanism | Effort | Why it ranks here |
|---|-----------|-----------|--------|-------------------|
| 1 | **command-guard** | `tool_call` → `{block}` | S | Highest-stakes rule (Boundaries / irreversible changes) made structural; direct `security.ts` precedent; tiny code. |
| 2 | **token-budget widget** | `setWidget` | S | Surfaces the harness's headline `<200`/`<60` invariants; pure on-mission HUD; trivial. |
| 3 | **/checks** | `registerCommand` + reuse `runner.ts` | M | Zero-token, no-subprocess green/red on the *same* allowlist; serves Definition of done daily. |
| 4 | **auto-memory** | `tool_result`/`turn_end` + `appendEntry` | M | Automates the memory-update discipline the contract demands; `pi-todo-md` precedent; auto-prunes the cap. |
| 5 | **secret-redaction** | `tool_result` | S | Mitigates the logs-secrets risk; protects permanent context; `filter-output.ts` precedent. Just below auto-memory only because it's risk-mitigation vs daily-flow value. |
| 6 | **experiment-autocomplete** | `addAutocompleteProvider` | S | Speeds the core `/plan`→`/verify` loop from on-disk names; cheap. |
| 7 | **auto-report** | `agent_end` diff of `verdict.md` | M | Closes the "log the result" loop, builds a dated trail; medium value, medium effort. |
| 8 | **boundary-instructions** | `tool_call` + glob | M | Brings Copilot-only path-scoped rules to pi; valuable but narrower payoff. |
| 9 | **mcp-bridge** | `registerTool` over MCP | L | Most capability, least harness-specific, largest build. |

**Top picks to build first:** #1, #2, #5 (all S, all with real ecosystem precedents) as a "safety + visibility" bundle, then #3 and #4 as the "daily workflow" bundle. #1, #3, and #5 deliberately compose with the existing `runner.ts` allowlist so the main session and the sub-agents enforce one consistent, deterministic policy.

Files referenced: `/Users/alex/agent-system/harness/pi/subagents/index.ts`, `/Users/alex/agent-system/harness/pi/subagents/runner.ts`, `/Users/alex/agent-system/harness/checks.json`, `/Users/alex/agent-system/memory/MEMORY.md`, `/Users/alex/agent-system/AGENTS.md`, `/Users/alex/agent-system/harness/README.md`.