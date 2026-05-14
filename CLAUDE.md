# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run build    # tsc — compiles src/ → dist/
npm run dev      # tsx src/index.ts — run server without building
npm test         # vitest run — all tests
```

Run a single test file:
```bash
npx vitest run tests/unit/tools/registry.test.ts
```

## Architecture

**Entry flow:** `src/index.ts` loads config from env → creates `GangtiseClient` → creates MCP server via `createGangtiseMcpServer` → connects to stdio transport.

### Core layer (`src/core/`)

| File | Role |
|---|---|
| `config.ts` | Reads env vars into `CliConfig`; all env var names are here |
| `endpoints.ts` | `ENDPOINTS` registry — every API call is a named `EndpointDefinition` with `kind: "json" | "download"` and optional `pagination` |
| `client.ts` | `GangtiseClient` — handles auth, JSON requests, paginated fan-out, and binary downloads |
| `auth.ts` | Token cache at `~/.config/gangtise/token.json`; reads/writes with 300s expiry buffer |
| `asyncContent.ts` | Polling loop for async AI endpoints (exponential backoff: 5s→30s) |
| `transport.ts` | `undici` dispatcher, retry logic, concurrency helper `runWithConcurrency` |
| `normalize.ts` | Normalizes API response shapes before returning to MCP |
| `download.ts` | Converts `DownloadResponse` into MCP content blocks |
| `lookupData/` | Static bundled lookup tables (industries, broker orgs, themes, etc.) — served locally, never fetched via HTTP |

### Tools layer (`src/tools/`)

Each file calls `registerJsonTool` / `registerDownloadTool` from `registry.ts` for spec-driven tools, and calls `server.registerTool` directly for complex cases.

| File | MCP tools registered |
|---|---|
| `lookup.ts` | `gangtise_lookup` (single tool, dispatches by `type` param) |
| `reference.ts` | `gangtise_securities_search` |
| `insight.ts` | opinions, summaries, roadshows, broker research, announcements, etc. |
| `quote.ts` | kline data (daily, minute, index, HK) |
| `fundamental.ts` | income statement, balance sheet, cash flow, valuation, holders, forecasts |
| `ai.ts` | knowledge search, hot topics, one-pager, investment logic, peer comparison, earnings review (async), viewpoint debate (async) |
| `vault.ts` | drive files, voice recordings, conferences, WeChat messages |

### Key patterns

**Adding a new endpoint:** Add it to `ENDPOINTS` in `endpoints.ts`, then add a `JsonToolSpec` or `DownloadToolSpec` in the appropriate tool file and pass it to `registerJsonTool`/`registerDownloadTool`.

**Paginated endpoints:** Set `paginated: true` in the tool spec and `pagination.enabled: true` in the endpoint definition. `client.requestPaginated` fans out concurrent page requests (default concurrency: `GANGTISE_PAGE_CONCURRENCY`, default 5). Tools automatically gain `size` and `fetchAll` params.

**Async AI tools (submit → poll):** Use `makeAsyncToolPair` in `ai.ts`. Creates two tools: a submit+poll tool (waits up to `waitSeconds`) and a `_check` tool for manual polling. API code `410110` = still pending, `410111` = failed.

**Auth priority:** `GANGTISE_TOKEN` env var → cached token file → `GANGTISE_ACCESS_KEY` + `GANGTISE_SECRET_KEY` (auto-refresh). Auth error codes `8000014`/`8000015` trigger one automatic token refresh.

### Environment variables

| Variable | Default |
|---|---|
| `GANGTISE_BASE_URL` | `https://open.gangtise.com` |
| `GANGTISE_ACCESS_KEY` / `GANGTISE_SECRET_KEY` | — |
| `GANGTISE_TOKEN` | — (skips key-based auth) |
| `GANGTISE_TOKEN_CACHE_PATH` | `~/.config/gangtise/token.json` |
| `GANGTISE_TIMEOUT_MS` | `30000` |
| `GANGTISE_MCP_ASYNC_TIMEOUT_MS` | `60000` |
| `GANGTISE_PAGE_CONCURRENCY` | `5` |

Set `GANGTISE_VERBOSE=1` to enable request timing and retry logs to stderr.
