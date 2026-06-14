# MCP research: arXiv (kept) + web-search engines (reference only — NOT in this build)

> ⚠ **SCOPE (plan verification R5 #4):** The build keeps **exactly ONE MCP — arXiv** (`blazickjp/arxiv-mcp-server`, via `pi-mcp-adapter`). **Web search is via the `pi-web-access` extension, NOT an MCP** (it's what `/research` uses and covers interactive search; see IMPLEMENTATION-PLAN.md §2e). The "WEB-SEARCH" section below is **reference only** — *optional alternatives* if you ever want a dedicated engine MCP with provider control. None of these (Exa, Tavily, Brave, DuckDuckGo, Fetch) are part of this build; the recommendation text predates the final decision. **Skip to the ARXIV section for what's actually wired.**

## WEB-SEARCH  *(reference only — optional alternatives to the `pi-web-access` extension; not built)*

**Recommendation:** Best overall pick: Exa MCP (npx -y exa-mcp-server) as the primary search server, paired with the zero-key reference Fetch server (uvx mcp-server-fetch) for URL->markdown extraction. Rationale: for this user's LLM-inference / KV-cache / GPU-optimization work, Exa's semantic search plus its code/docs-oriented tools are the strongest on technical and documentation queries, it has a genuine free tier (~1,000 req/mo, no card per pricing aggregators), and exposes both web_search_exa and web_fetch_exa. Tavily is the close #2 and a better choice if you want answer-style synthesis plus crawl/map over a whole docs site (also free ~1,000 credits/mo, no card) — pick Tavily over Exa when you need site crawling/extraction more than semantic/code search. 

On no-key friction: if you must have ZERO signup/key, use the DuckDuckGo MCP (uvx duckduckgo-mcp-server) — it's the only true zero-key search option, at the cost of result depth and scrape rate-limits. Avoid Brave's MCP as a default now: it's a good engine but its free tier was removed in 2026 (metered, card required), and the old Anthropic @modelcontextprotocol/server-brave-search reference is archived/unmaintained — only @brave/brave-search-mcp-server is current. Kagi and Perplexity are quality but paid-only (no free tier), so reserve them for when you already pay for them. 

When pi-web-access (the pi extension) beats an MCP for the same job: prefer the pi-web-access extension over any of these MCP servers when you want the lowest-friction, zero-config setup inside the pi agent specifically — it gives web_search + fetch_content + code_search working immediately with NO API key (zero-config Exa via a fallback chain), it's token-aware (trims pages to avoid context bloat), and it's a native pi extension so it needs no separate MCP process/transport. In short: use pi-web-access when 'just works, no keys, native to pi' matters most; switch to a dedicated MCP (Exa or Tavily with your own key) when you want explicit control over the provider, higher rate limits/quality tiers, or features like Tavily crawl/map and Exa advanced search that the extension's default chain doesn't expose.

### Servers

#### Exa MCP Server  [official/verified-quoted]
- source: npm: exa-mcp-server (exa-labs/exa-mcp-server)
- transport: stdio (local npx) or HTTP (hosted at https://mcp.exa.ai/mcp) | auth: API key required (EXA_API_KEY from dashboard.exa.ai). Free tier: ~1,000 requests/month, no credit card (per pricing aggregators). Paid ~$7/1k searches.
- run: npx -y exa-mcp-server
- tools: web_search_exa (default on), web_fetch_exa (default on), web_search_advanced_exa (off by default)
- piConfig: { "mcpServers": { "exa": { "command": "npx", "args": ["-y", "exa-mcp-server"], "env": { "EXA_API_KEY": "your_api_key" } } } }
- src: https://github.com/exa-labs/exa-mcp-server

#### Tavily MCP  [official/verified-quoted]
- source: npm: tavily-mcp (tavily-ai/tavily-mcp)
- transport: stdio (local npx) or remote HTTP (https://mcp.tavily.com/mcp/?tavilyApiKey=<key>, supports OAuth) | auth: API key required (TAVILY_API_KEY from tavily.com). Free 'Researcher' tier: ~1,000 API credits/month, no credit card (per pricing aggregators). Basic search = 1 credit, advanced = 2.
- run: npx -y tavily-mcp@latest
- tools: search, extract, map, crawl
- piConfig: { "mcpServers": { "tavily-mcp": { "command": "npx", "args": ["-y", "tavily-mcp@latest"], "env": { "TAVILY_API_KEY": "your-api-key-here" } } } }
- src: https://github.com/tavily-ai/tavily-mcp

#### Brave Search MCP Server (Brave's official)  [official/verified-quoted]
- source: npm: @brave/brave-search-mcp-server (brave/brave-search-mcp-server). NOTE: the older Anthropic reference @modelcontextprotocol/server-brave-search is ARCHIVED (servers-archived) — do not use it.
- transport: stdio (default) or HTTP | auth: API key required (BRAVE_API_KEY). Free tier REMOVED in 2026 for new users — now metered/credit-based (~$5 per 1,000 requests), credit card required (per pricing aggregators). Existing legacy free-plan subscribers retain ~2,000 queries/month.
- run: npx -y @brave/brave-search-mcp-server
- tools: brave_web_search, brave_local_search, brave_news_search, brave_image_search, brave_video_search, brave_summarizer
- piConfig: { "mcpServers": { "brave-search": { "command": "npx", "args": ["-y", "@brave/brave-search-mcp-server", "--transport", "http"], "env": { "BRAVE_API_KEY": "YOUR_API_KEY_HERE" } } } }
- src: https://github.com/brave/brave-search-mcp-server

#### Perplexity (official MCP)  [official/verified-quoted]
- source: npm: @perplexity-ai/mcp-server (perplexityai/modelcontextprotocol)
- transport: stdio (default) or HTTP server mode | auth: API key required (PERPLEXITY_API_KEY / Sonar API). No free tier documented in the README; Sonar API is paid per-token/per-request.
- run: npx -y @perplexity-ai/mcp-server
- tools: perplexity_search, perplexity_ask (sonar-pro), perplexity_research (sonar-deep-research), perplexity_reason (sonar-reasoning-pro)
- piConfig: { "mcpServers": { "perplexity": { "command": "npx", "args": ["-y", "@perplexity-ai/mcp-server"], "env": { "PERPLEXITY_API_KEY": "your_key_here" } } } }
- src: https://github.com/perplexityai/modelcontextprotocol

#### DuckDuckGo MCP Server  [community/verified-quoted]
- source: PyPI: duckduckgo-mcp-server (nickclyde/duckduckgo-mcp-server)
- transport: stdio (default); also sse and streamable-http | auth: ZERO-KEY. No API key, no signup, no billing — README mentions no API keys anywhere. (Trade-off: scrapes DuckDuckGo, subject to rate limiting / lower result depth.)
- run: uvx duckduckgo-mcp-server
- tools: search, fetch_content
- piConfig: { "mcpServers": { "ddg-search": { "command": "uvx", "args": ["duckduckgo-mcp-server"] } } }
- src: https://github.com/nickclyde/duckduckgo-mcp-server

#### Kagi MCP (official)  [official/verified-quoted]
- source: PyPI/uvx: kagimcp (kagisearch/kagimcp)
- transport: stdio | auth: API key required (KAGI_API_KEY). No free tier — pay-per-query (~$12 per 1,000 search queries per Kagi docs); you fund an API balance.
- run: uvx kagimcp
- tools: kagi_search_fetch (web/news/video/podcast/image search with extracts, filters, lenses), kagi_extract (page -> markdown)
- piConfig: { "mcpServers": { "kagi": { "command": "uvx", "args": ["kagimcp"], "env": { "KAGI_API_KEY": "YOUR_API_KEY_HERE" } } } }
- src: https://github.com/kagisearch/kagimcp

#### Fetch (reference MCP server)  [official/verified-quoted]
- source: PyPI: mcp-server-fetch (modelcontextprotocol/servers, src/fetch)
- transport: stdio | auth: ZERO-KEY. No API key. Fetches a URL and converts HTML -> markdown; supports chunked reading via start_index. This is a fetch/extract companion, NOT a search engine.
- run: uvx mcp-server-fetch
- tools: fetch
- piConfig: { "mcpServers": { "fetch": { "command": "uvx", "args": ["mcp-server-fetch"] } } }
- src: https://github.com/modelcontextprotocol/servers/tree/main/src/fetch

#### pi-web-access (pi extension, NOT an MCP)  [community/verified-quoted]
- source: npm: pi-web-access (nicobailon/pi-web-access) — installed as a pi extension, not via mcpServers
- transport: n/a (native pi extension; in-process tools, not an MCP transport) | auth: Works with NO API keys out of the box (zero-config Exa search via MCP fallback chain). Optional keys (Exa/Perplexity/Gemini) in ~/.pi/web-search.json for direct access.
- run: pi install npm:pi-web-access
- tools: web_search (synthesized cited answers), fetch_content (URLs, GitHub repos, YouTube, local files), code_search, get_search_content
- piConfig: Not an mcp.json entry — install via: pi install npm:pi-web-access  (config in ~/.pi/web-search.json)
- src: https://github.com/nicobailon/pi-web-access

## ARXIV — ACTIVE server: `blazickjp/arxiv-mcp-server` ONLY (the one kept MCP)

**Recommendation:** Single best pick: blazickjp/arxiv-mcp-server. It is the most mature dedicated arXiv MCP, needs ZERO API key (arXiv is open), and is the only option that cleanly covers the full loop the agent needs: search_papers (filter by category/date — ideal for cs.LG / cs.DC / cs.AR ML-systems work on KV-cache, attention, GPU serving), download_paper (HTML-first, PDF fallback), and read_paper which returns the paper as MARKDOWN. Critically, it STORES DOWNLOADED PAPERS LOCALLY at a --storage-path directory, so list_papers + read_paper let the agent re-read cached papers later with no re-fetch — exactly what you want for working through a reading list of inference/serving papers. Setup: `uv tool install 'arxiv-mcp-server[pdf]'` and point --storage-path at a persistent folder. **⚠ SCOPE (verifier R11 #2): the build wires ONLY `blazickjp/arxiv-mcp-server`.** The other servers listed below (prashalruchiranga, openags/paper-search-mcp, zongmin-yu Semantic Scholar) are **reference-only — NOT built**; adopt one *instead* only if you deliberately widen scope (e.g. you want PubMed/Semantic-Scholar coverage). Confidence note: tool names, configs, and the no-key/local-storage facts are verified-quoted from each project's README/PyPI.

### Servers

#### blazickjp/arxiv-mcp-server  [official/verified-quoted]
- source: PyPI: arxiv-mcp-server (latest 0.2.9)
- transport: stdio (default); optional HTTP transport via env vars | auth: None — no API key required (arXiv is open). PDF support for older PDF-only papers needs the optional [pdf] extra.
- run: uv tool install 'arxiv-mcp-server[pdf]'  then  uv tool run arxiv-mcp-server --storage-path /path/to/paper/storage
- tools: search_papers, download_paper, list_papers, read_paper
- piConfig: {
  "mcpServers": {
    "arxiv-mcp-server": {
      "command": "uv",
      "args": ["tool", "run", "arxiv-mcp-server", "--storage-path", "/path/to/paper/storage"]
    }
  }
}
- src: https://github.com/blazickjp/arxiv-mcp-server

### Reference-only — NOT part of this build (alternatives if you change scope)

#### prashalruchiranga/arxiv-mcp-server  [community/verified-quoted]
- source: GitHub source (clone + uv sync); also on Smithery
- transport: stdio (standard FastMCP/MCP stdio; not explicitly documented) | auth: None — no API key required (arXiv API is open).
- run: git clone https://github.com/prashalruchiranga/arxiv-mcp-server && uv sync  then  uv --directory <repo>/src/arxiv_server run server.py
- tools: search_arxiv, get_article_url, get_details, download_article, load_article_to_context
- piConfig: {
  "mcpServers": {
    "arxiv-server": {
      "command": "uv",
      "args": ["--directory", "/ABSOLUTE/PATH/TO/arxiv-mcp-server/src/arxiv_server", "run", "server.py"],
      "env": { "DOWNLOAD_PATH": "/ABSOLUTE/PATH/TO/DOWNLOADS/FOLDER" }
    }
  }
}
- src: https://github.com/prashalruchiranga/arxiv-mcp-server

#### openags/paper-search-mcp  [community/verified-quoted]
- source: PyPI: paper-search-mcp (latest 0.1.3); also via Smithery
- transport: stdio | auth: None for arXiv/PubMed/bioRxiv/Semantic Scholar core search. Optional/required keys only for some sources: Unpaywall needs PAPER_SEARCH_MCP_UNPAYWALL_EMAIL; CORE / Semantic Scholar / IEEE / ACM keys optional or required to activate those connectors.
- run: uv add paper-search-mcp  then  uv run --directory /path/to/paper-search-mcp -m paper_search_mcp.server   (or: npx -y @smithery/cli install @openags/paper-search-mcp --client claude)
- tools: search_arxiv, download_arxiv, read_arxiv_paper, search_pubmed, search_semantic
- piConfig: {
  "mcpServers": {
    "paper-search-mcp": {
      "command": "uv",
      "args": ["run", "--directory", "/path/to/paper-search-mcp", "-m", "paper_search_mcp.server"]
    }
  }
}
- src: https://github.com/openags/paper-search-mcp

#### zongmin-yu/semantic-scholar-fastmcp-mcp-server (Semantic Scholar MCP)  [community/verified-quoted]
- source: uvx package: semantic-scholar-fastmcp; also via Smithery
- transport: stdio (FastMCP); optional built-in HTTP bridge on port 8000 | auth: Optional free Semantic Scholar API key. Works unauthenticated at lower rate limits (~100 req/5 min); with key ~1 req/sec for search. No paid tier required.
- run: uvx semantic-scholar-fastmcp
- tools: paper_relevance_search, paper_batch_details, author_details, get_paper_recommendations_single
- piConfig: {
  "mcpServers": {
    "semantic-scholar": {
      "command": "uvx",
      "args": ["semantic-scholar-fastmcp"],
      "env": { "SEMANTIC_SCHOLAR_API_KEY": "your-api-key-here" }
    }
  }
}
- src: https://github.com/zongmin-yu/semantic-scholar-fastmcp-mcp-server