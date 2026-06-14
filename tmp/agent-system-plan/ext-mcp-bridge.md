> # ⚠ SUPERSEDED — REFERENCE ONLY, DO NOT BUILD
> This doc proposed a custom in-repo MCP bridge (and recommended *against* `pi-mcp-adapter`) back when the
> plan was wiring write-capable cluster/GitHub MCP servers that needed per-tool gating. **That scope was
> dropped.** The active MCP path is now: **web search via the `pi-web-access` extension; arXiv via
> `blazickjp/arxiv-mcp-server` connected with `pi install npm:pi-mcp-adapter`** — all read-only, so no custom
> named-tool bridge is justified. See `IMPLEMENTATION-PLAN.md §2e` + `mcp-web-arxiv.md`. Keep this only as the
> design to revisit *if* you ever add write-capable MCP servers that need command-guard-by-name.

## `mcp-bridge` — connect MCP servers and re-expose their tools as pi tools  *(superseded — see banner above)*

### 1. Where it lives + how it is installed

Path: `harness/pi/mcp-bridge/index.ts` (mirrors `harness/pi/subagents/index.ts`). Config schema lives next to it as `harness/pi/mcp-bridge/mcp.example.json`; the live config is read from the repo at `harness/mcp.json` (project-shared, checked-in-able with `${ENV}` placeholders — never raw secrets).

**Decision — build a thin in-repo bridge, do NOT depend on `pi-mcp-adapter`.** Justification: (a) The adapter's default surface is a single opaque `mcp` proxy tool (search/describe/execute) — that is the *opposite* of what `command-guard` and `secret-redaction` need: those hooks key off `event.toolName`/`event.input`, and a proxy collapses every GitHub/browser call into one `mcp(...)` call the guards can't distinguish (you can't block `push_files` but allow `get_file_contents` if both are `mcp`). The brief itself demands "re-expose each server tool as a pi tool (`pi.registerTool`)" and "/mcp enable/disable", and the adapter's verbatim `/mcp enable|disable` and `mcp_<server>_<tool>` naming are **both flagged UNCONFIRMED** in the research. (b) The repo deliberately favors small, auditable in-repo engines (`runner.ts` is a 339-line closed allowlist rather than a dependency). A thin bridge using `@modelcontextprotocol/sdk` gives us first-class named tools that fall under the existing hooks for free. Trade-off: we own ~150 lines and the SDK dep; acceptable for the composition guarantee.

**Install:** extend `install.sh` to symlink *every* `harness/pi/*/` dir that contains `index.ts` (not just `subagents`), so one installer serves all extensions:

```bash
for d in "$(dirname "${BASH_SOURCE[0]}")"/*/; do
  [[ -f "$d/index.ts" ]] || continue
  name="$(basename "$d")"
  link "$DEST_PARENT/$name" "$(cd "$d" && pwd)"   # link(): backup-or-rm then ln -s, factored from current body
done
```
This keeps the symlink-default / `--copy` / `--uninstall` modes. Each extension stays an independent symlink in `~/.pi/agent/extensions/<name>` per `install.sh:20-21`.

### 2. Registration code (real pi API + verified field names)

```ts
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default async function mcpBridge(pi: ExtensionAPI) {
  const cfg = loadMcpConfig(findRepoRoot(process.cwd())); // { mcpServers: {...} }
  const enabled = new Set<string>();
  const registered = new Map<string, string[]>(); // server -> tool ids

  async function connect(name: string, s: ServerSpec) {
    const transport = s.url
      ? new StreamableHTTPClientTransport(new URL(interp(s.url)), { requestInit: { headers: interpHeaders(s.headers) } })
      : new StdioClientTransport({ command: s.command!, args: s.args ?? [], env: interpEnv(s.env), cwd: s.cwd });
    const client = new Client({ name: "pi-mcp-bridge", version: "1" });
    await client.connect(transport);
    const ids: string[] = [];
    for (const t of (await client.listTools()).tools) {
      const id = `mcp_${name}_${t.name}`;                       // distinct, guard-visible name
      pi.registerTool({
        name: id, label: t.name, description: t.description ?? id,
        parameters: t.inputSchema as any,                        // server-supplied JSON Schema
        async execute(_id, params) {
          const r = await client.callTool({ name: t.name, arguments: params });
          return { content: r.content as any, isError: !!r.isError };
        },
      });
      ids.push(id);
    }
    registered.set(name, ids); enabled.add(name);
  }

  pi.registerCommand("mcp", {
    description: "MCP bridge: /mcp enable <server> | /mcp disable <server> | /mcp list",
    handler: async (args, ctx) => {
      const [verb, srv] = args.trim().split(/\s+/);
      if (verb === "enable" && cfg.mcpServers[srv]) {
        await connect(srv, cfg.mcpServers[srv]);
        ctx.ui.notify(`MCP ${srv}: ${registered.get(srv)?.length ?? 0} tools enabled`, "info");
      } else if (verb === "disable") {
        for (const id of registered.get(srv) ?? []) pi.unregisterTool?.(id); // FLAG: unregisterTool unverified — fallback: tool no-ops when !enabled
        registered.delete(srv); enabled.delete(srv);
        ctx.ui.notify(`MCP ${srv} disabled`, "info");
      } else ctx.ui.notify(`Servers: ${Object.keys(cfg.mcpServers).join(", ")}`, "info");
    },
  });
}
```

FLAG to verify against live pi: `pi.unregisterTool` is not in the verified API list — if absent, gate `execute` on `enabled.has(name)` and have it return `{ isError: true }` when disabled instead of unregistering.

### 3. Config / inputs

Reads `harness/mcp.json` (Claude-Code-compatible `mcpServers` wrapper — research flags the wrapper as probable; we standardize on it). `${VAR}` placeholders are interpolated from `process.env` at connect time. Defaults: nothing connects until `/mcp enable`; missing file → empty server map.

**Wire these two first.** GitHub (remote HTTP, lowest-ops, read-only-first via per-toolset `/readonly` URL):
```json
{ "mcpServers": {
  "github": { "transport": "http",
    "url": "https://api.githubcopilot.com/mcp/x/repos/readonly",
    "headers": { "Authorization": "Bearer ${GITHUB_MCP_PAT}" } },
  "playwright": { "transport": "stdio", "command": "npx",
    "args": ["@playwright/mcp@latest", "--headless", "--isolated"] }
}}
```
GitHub auth: fine-grained PAT in `GITHUB_MCP_PAT`, minimum scopes `repo` (or `public_repo`), `read:org`, `read:packages`. Day-to-day GitHub tools: `get_file_contents`, `search_code`, `list_issues`, `issue_read`, `list_pull_requests`, `pull_request_read`, `search_pull_requests` (all read). Playwright needs no auth; day-to-day tools: `browser_navigate`, `browser_snapshot` (a11y text, cheap — prefer over screenshot), `browser_click`, `browser_type`, `browser_network_requests`, `browser_console_messages`, `browser_evaluate`.

### 4. Build steps

1. `npm i @modelcontextprotocol/sdk` (add to the extension; SDK provides stdio + StreamableHTTP transports).
2. Write `harness/pi/mcp-bridge/index.ts` (skeleton above) + `findRepoRoot`/`loadMcpConfig`/`interp*` helpers (copy `findRepoRoot` from `subagents/index.ts:136`).
3. Add `mcp.example.json` and document `harness/mcp.json` in AGENTS.md "Stack & commands".
4. Extend `install.sh` to loop over `harness/pi/*/` (section 1).
5. `harness/pi/install.sh` then `/reload` in pi.
6. Verify `pi.unregisterTool` exists; if not, apply the `enabled`-gate fallback.

### 5. Testing (live pi)

- `/mcp list` → notify lists `github, playwright`.
- `/mcp enable github` → "github: N tools enabled". Type a task; the model can call `mcp_github_get_file_contents` and `mcp_github_search_code`; results appear. Confirm a write tool like `mcp_github_issue_write` is **absent** (because the `/readonly` URL filtered it).
- `/mcp enable playwright` → model calls `mcp_playwright_browser_navigate` then `mcp_playwright_browser_snapshot`; you see an a11y tree, not a screenshot.
- `/mcp disable github` → subsequent `mcp_github_*` call is refused / tool gone.
- With `command-guard` loaded, attempt `mcp_github_issue_write` from a non-readonly config → blocked with the AGENTS.md Boundaries reason.

### 6. Effort / deps / risks

**Effort: L** (SDK integration, transport branching, lifecycle). **Deps:** `@modelcontextprotocol/sdk`; Node ≥20.19 for Playwright/chrome-devtools; network/PAT for GitHub remote.

- **Secret in checked-in config** → only `${ENV}` placeholders in `harness/mcp.json`; interpolate at connect; secret-redaction scrubs `Authorization:`/`*_TOKEN` from any echoed output.
- **`unregisterTool` may not exist** → fallback gate on `enabled.has(name)` in `execute` (above).
- **Tool-name collision across servers** → namespace `mcp_<server>_<tool>` guarantees uniqueness; reject duplicate ids on register.
- **Write/network tools widen blast radius** → start each server read-only (GitHub `/readonly` URL or `GITHUB_READ_ONLY=1`; Playwright `--isolated`); enable write toolsets only on explicit `/mcp enable github-write`.

### 7. Composition with runner / sub-agents / other extensions

One consistent policy: **every MCP capability is just a named pi tool, so the same hooks apply.** Because each tool is `mcp_<server>_<tool>` (not a proxy), `command-guard` (#1) sees `event.toolName`/`event.input` and can block write/network MCP tools by name pattern (e.g. block `mcp_*_issue_write`, `mcp_*_merge_pull_request`, `mcp_*_push_files` unless the operator opted in), and `secret-redaction` (#5) scrubs MCP `event.content` exactly as it does `bash`/`run_check`. Sub-agents are unaffected and stay sealed: the Verifier runs `--no-extensions` + only `-e runner.ts` (`subagents/index.ts:267-269`), so MCP tools never leak into the isolated allowlist — MCP lives in the main session only, and the closed-allowlist `runner.ts` remains the sole tool surface for sub-agents. Net: read-only-first, name-addressable, and fully under the existing guard + redaction layer.