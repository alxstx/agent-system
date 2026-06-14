I now have enough cross-verified information. The `mcpServers` wrapper key appeared in the first README fetch (the standard Claude Code-compatible format) but the bare-entry examples in later fetches show only the inner shape. I'll flag this ambiguity. Here is the brief.

# PART A — How pi connects MCP (via pi-mcp-adapter)

**Context:** pi (earendil-works/pi) has no native MCP support. Issue #563 is the feature request; `nicobailon/pi-mcp-adapter` is a third-party extension that adds MCP support. Confidence is **medium-high** for the adapter README content (corroborated across two raw fetches + DeepWiki); **medium** where noted; ambiguities flagged.

## Install command
**Confidence: high** (identical across two fetches)
```bash
pi install npm:pi-mcp-adapter
```

## Where `mcp.json` lives (config file locations + precedence)
**Confidence: high** for the four paths; precedence order had minor wording differences between fetches.

- `~/.config/mcp/mcp.json` — user-global shared config
- `.mcp.json` — project-local shared config
- `<Pi agent dir>/mcp.json` — Pi global override (default: `~/.pi/agent/mcp.json`)
- `.pi/mcp.json` — Pi project override

Precedence (as quoted): `~/.config/mcp/mcp.json` > `<Pi agent dir>/mcp.json` > `.mcp.json` > `.pi/mcp.json`. Issue #563 independently corroborates `~/.pi/agent/mcp.json` and `<cwd>/.pi/mcp.json` and says the format should "Follow the established format used by Claude Code and other harnesses."

## Server-entry shape

**`mcpServers` wrapper — FLAG (ambiguous).** The first README fetch wrapped entries under a top-level `"mcpServers": { ... }` key (the Claude Code-compatible shape); later fetches showed only the bare inner object. Given the README states it follows the Claude Code format, the `mcpServers` wrapper is most likely correct, but I could **not** confirm this verbatim across all fetches. Treat the wrapper as probable-but-unconfirmed.

**Stdio entry** (command / args / env / cwd) — **Confidence: high** for command/args; env/cwd shown in one fetch:
```json
{
  "mcpServers": {
    "server-name": {
      "command": "npx",
      "args": ["-y", "chrome-devtools-mcp@latest"],
      "env": { },
      "cwd": "~"
    }
  }
}
```

**HTTP entry** (url / headers) — **Confidence: high**:
```json
{
  "url": "http://localhost:3845/mcp",
  "headers": { }
}
```
A server definition "requires at least a name and a method to connect (either a `command` for stdio or a `url` for HTTP)."

## Supported transports
**Confidence: high** for stdio + HTTP; **medium** on SSE naming.
- **Stdio** — via `command` + `args`.
- **HTTP** — via `url`, described as "StreamableHTTP with SSE fallback."
- Issue #563 (the original request) describes "stdio and SSE transports" using the MCP TypeScript SDK. So: stdio + HTTP (streamable, SSE fallback).

## Auth handling
**Confidence: medium-high** (fields consistent across fetches; exact JSON for OAuth shown once).
- **Env interpolation:** the `"env"` field supports `${VAR}` and `$env:VAR` interpolation (shown once — **medium**).
- **Bearer:** `"bearerToken": "..."` or `"bearerTokenEnv": "ENV_VAR_NAME"`; also `"auth": "bearer"`.
- **OAuth:** `"auth": "oauth"` with an `oauth` object:
```json
"auth": "oauth",
"oauth": {
  "grantType": "authorization_code",
  "clientId": "...",
  "clientSecret": "...",
  "scope": "...",
  "redirectUri": "http://localhost:3118/callback"
}
```
- `/mcp logout <server>` clears stored OAuth credentials.

## How MCP tools are surfaced as pi tools (proxy pattern + token note)
**Confidence: high.**
- **Default = single proxy tool.** The adapter registers ONE `mcp` tool (~200 tokens) instead of registering hundreds of individual tools (which "would consume 10,000+ tokens per server"). The LLM uses it for on-demand discovery. The proxy exposes operations: **search, describe, list, execute**.
  - Search: `mcp({ search: "query" })`
  - Call: `mcp({ tool: "name", args: '{"key": "value"}' })`
- **`directTools`** promotes specific tools to first-class pi tools (bypassing the proxy). Each direct tool costs "~150–300 tokens in the system prompt." Config forms:
```json
"directTools": true,                 // all tools
"directTools": ["tool_a", "tool_b"], // specific tools
"directTools": false                 // proxy only (default)
```
- Direct tools register from a metadata cache (`~/.pi/agent/mcp-cache.json` by default) so no server connection is needed at startup. Servers are lazy (connect on first call), metadata is cached to disk, idle servers disconnect after ~10 min and auto-reconnect.

**FLAG — `mcp_server_tool` / `mcp_<server>_<tool>` naming:** Issue #563 specifies a tool naming convention `"mcp_<server-name>_<toolname>"` and dynamic enable/disable via `setActiveTools`. The shipped adapter README instead documents the single-`mcp`-proxy model + `directTools`. I could **not** confirm the exact `mcp_<server>_<tool>` naming string in the adapter's own docs — it appears in the feature-request issue, which may differ from what shipped. Do not rely on that exact tool-name string without checking the adapter source.

## `/mcp` commands + init / host-config scanning
**Confidence: high** on commands; **medium** on the precise enable/disable mechanism.
- `/mcp` — interactive panel & first-run onboarding
- `/mcp setup` — guided setup / config import walkthrough
- `/mcp tools` — list all tools
- `/mcp reconnect` and `/mcp reconnect <server>` — reconnect server(s)
- `/mcp logout <server>` — clear OAuth credentials
- **Enable/disable:** Issue #563 describes enabling/disabling a server dynamically, which "adds/removes tools via `setActiveTools`." I did **not** see an explicit `/mcp enable`/`/mcp disable` subcommand quoted verbatim in the adapter README — the enable/disable is described as a TUI panel action. **FLAG: no verbatim `/mcp enable|disable` subcommand confirmed.**
- **Init / scan existing host configs:**
```bash
pi-mcp-adapter init
```
"scans for host-specific configs and add[s] missing compatibility imports" to Pi's agent directory. Supported imports: `cursor`, `claude-code`, `claude-desktop`, `vscode`, `windsurf`, `codex`.

---

# PART B — pi extension event/UI API (for correct hook code)

Source: `packages/coding-agent/docs/extensions.md`. **Confidence: high** — field names were identical across two independent raw fetches. Type-signature caveats flagged below.

## Event payload field names

Handlers are registered with `pi.on("<event>", async (event, ctx) => { ... })`.

### `tool_call` (fires before execution; can block)
- Tool NAME: **`event.toolName`**
- Tool INPUT/arguments: **`event.input`** (described as mutable)
- Also: `event.toolCallId`

### `tool_result` (fires after execution; can modify)
- Tool NAME: **`event.toolName`**
- Tool INPUT: **`event.input`**
- RESULT content array: **`event.content`** (array of content blocks)
- isError: **`event.isError`** (boolean)
- Also: `event.toolCallId`, `event.details`

### `tool_execution_end`
- Tool NAME: **`event.toolName`**
- RESULT: **`event.result`** (final result object — note: NOT `content` here)
- isError: **`event.isError`**
- Also: `event.toolCallId`

### `turn_end`
- **`event.turnIndex`**
- **`event.message`** (assistant message)
- **`event.toolResults`** (results executed this turn)

**Field-name summary for tool NAME / INPUT / content / isError:**
- NAME = `toolName` (NOT `name`) on all tool events.
- INPUT = `input` (NOT `args`/`arguments`) on `tool_call`/`tool_result`.
- RESULT content array = `content` on `tool_result`; on `tool_execution_end` it is `result` (a result object), not `content` — **FLAG this distinction.**
- isError = `isError` on `tool_result` and `tool_execution_end`.

## Blocking a tool from `tool_call`
**Confidence: high.** Return:
```typescript
return { block: true, reason: "Dangerous command" };
```
(`block: true` + `reason` string. Returning nothing/undefined allows the call. To modify args, mutate `event.input` instead.)

## UI API signatures

### `ctx.ui.setWidget`
**Confidence: high on examples; FLAG: no formal type signature in docs — only examples.**
```typescript
ctx.ui.setWidget("key", ["Line 1", "Line 2"]);
ctx.ui.setWidget("key", ["Line 1"], { placement: "belowEditor" });
ctx.ui.setWidget("key", (tui, theme) => new Text(...));
ctx.ui.setWidget("key", undefined); // clear
```
Signature (inferred from examples): `setWidget(key: string, content: string[] | ((tui, theme) => Widget) | undefined, opts?: { placement?: "belowEditor" | ... })`. Placement value `"belowEditor"` is confirmed verbatim; other placement values not confirmed.

### `ctx.ui.addAutocompleteProvider`
**Confidence: high on shape; FLAG: no formal interface type in docs.** Takes a factory `(current) => provider`:
```typescript
ctx.ui.addAutocompleteProvider((current) => ({
  triggerCharacters: ["#"],
  async getSuggestions(lines, line, col, options) {
    return current.getSuggestions(lines, line, col, options);
  },
  applyCompletion(lines, line, col, item, prefix) {
    return current.applyCompletion(lines, line, col, item, prefix);
  },
  shouldTriggerFileCompletion(lines, line, col) {
    return current.shouldTriggerFileCompletion?.(lines, line, col) ?? true;
  },
}));
```
Provider members: `triggerCharacters: string[]`, `getSuggestions(lines, line, col, options)`, `applyCompletion(lines, line, col, item, prefix)`, `shouldTriggerFileCompletion(lines, line, col)`.

### `ctx.ui.notify`
**Confidence: high on enum.** Signature: `ctx.ui.notify(message: string, level)`.
```typescript
ctx.ui.notify("Done!", "info");
```
Documented accepted levels (verbatim): **`"info" | "warning" | "error"`**. **FLAG:** one example showed `"success"`, but the documented enum is only `info | warning | error` — `"success"` is NOT in the accepted list. Use `info`/`warning`/`error` to be safe.

### `registerCommand` reading `ctx.cwd`
**Confidence: high.** Handler is `async (args, ctx) => { ... }`; `args` is the unparsed string after the command name; `ctx.cwd` is the session working directory (absolute path).
```typescript
pi.registerCommand("name", {
  description: "What command does",
  handler: async (args, ctx) => {
    const files = await readdir(ctx.cwd);
    ctx.ui.notify(`Working in ${ctx.cwd}`, "info");
  }
});
```

# PART C — CLI flags (verified from packages/coding-agent/docs/usage.md)

Source: pi `usage.md` (fetched directly; the headless subprocess + Phase 0.5 model policy rest on these). **Confidence: verified-quoted** unless noted.

- `--mode json` — output all events as JSON lines (the subagent transport). `--mode rpc` also exists.
- `-p`, `--print` — print response and exit (non-interactive one-shot).
- `--no-session` — ephemeral; do not save.
- `-nc`, `--no-context-files` — disable AGENTS.md/CLAUDE.md discovery. (The harness's `-nc` maps here.)
- `--no-skills`, `--no-prompt-templates`, `--no-themes` — disable that discovery.
- `--no-extensions` — disable extension discovery. **A specific extension can still be loaded with `-e` under `--no-extensions`** (this is how sub-agents get `run_check` and why `/research` must `-e` its web tools).
- `-e`, `--extension <source>` — load an extension from path, npm, or git; repeatable.
- `--tools <list>`, `-t <list>` — allowlist specific built-in/extension/custom tools. **Built-in tool names: `read, bash, edit, write, grep, find, ls`.**
- `--append-system-prompt <text>` — append to the system prompt (**text arg, not a file** — the source of the engine bug fixed at index.ts:270). `--system-prompt <text>` replaces.
- **`--model <pattern>`** — model id; supports `provider/id` (e.g. `openai/gpt-4o`) and a `:<thinking>` shorthand (e.g. `sonnet:high`). `--provider <name>`. `--models <patterns>` (Ctrl+P cycling). `--list-models [search]`.
- **`--thinking <level>`** — values: `off | minimal | low | medium | high | xhigh`. (Phase 0.5 uses `xhigh`.)

**Still FLAG-to-verify on live pi** (format confirmed, *values* not): the exact model-id strings `openai/gpt-5.5` and `anthropic/opus-4.8` (run `pi --list-models`); whether `gpt-5.5` is available/authenticated.

## Things I could NOT confirm verbatim
- The `mcpServers` top-level wrapper key in pi-mcp-adapter's `mcp.json` (probable, Claude-Code-compatible, but not quoted in every fetch).
- A literal `/mcp enable` / `/mcp disable` subcommand (enable/disable described as a TUI panel action via `setActiveTools`, per issue #563).
- The `mcp_<server>_<tool>` tool-naming string in the shipped adapter (only in feature-request issue #563, not the adapter README).
- Formal TypeScript type signatures for `setWidget` / `addAutocompleteProvider` (docs give examples, not type defs).

Sources:
- https://github.com/nicobailon/pi-mcp-adapter (README, main/master)
- https://deepwiki.com/nicobailon/pi-mcp-adapter/2-getting-started
- https://github.com/earendil-works/pi/issues/563
- https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md