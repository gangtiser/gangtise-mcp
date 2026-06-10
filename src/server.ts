import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import type { GangtiseClient } from "./core/client.js"
import { DEFAULT_ASYNC_TIMEOUT_MS } from "./core/config.js"
import { dateContextInstruction } from "./core/dateContext.js"
import { getPackageVersion } from "./core/version.js"
import { registerContextTools } from "./tools/context.js"
import { registerLookupTools } from "./tools/lookup.js"
import { registerReferenceTools } from "./tools/reference.js"
import { registerInsightTools } from "./tools/insight.js"
import { registerQuoteTools } from "./tools/quote.js"
import { registerFundamentalTools } from "./tools/fundamental.js"
import { registerAiTools } from "./tools/ai.js"
import { registerVaultTools } from "./tools/vault.js"
import { registerAlternativeTools } from "./tools/alternative.js"
import { registerResponseTools } from "./tools/response.js"

export interface McpServerOptions {
  asyncTimeoutMs?: number
  version?: string
}

export function createGangtiseMcpServer(
  client: GangtiseClient,
  options: McpServerOptions = {},
): McpServer {
  // Cross-cutting guidance lives here once instead of being repeated in every
  // tool/param description — keeps the tool listing lean for MCP clients.
  const server = new McpServer(
    { name: "gangtise-mcp", version: options.version ?? getPackageVersion() },
    {
      instructions:
        `${dateContextInstruction()}日期参数格式 YYYY-MM-DD，时间参数格式 YYYY-MM-DD HH:mm:ss。` +
        `工具响应包含 _truncated: true 时，用 gangtise_read_response 按 _saved_to 路径分页读取完整数据。`,
    },
  )
  const asyncTimeoutMs = options.asyncTimeoutMs ?? DEFAULT_ASYNC_TIMEOUT_MS

  registerContextTools(server, client)
  registerLookupTools(server, client)
  registerReferenceTools(server, client)
  registerInsightTools(server, client)
  registerQuoteTools(server, client)
  registerFundamentalTools(server, client)
  registerAiTools(server, client, { asyncTimeoutMs })
  registerVaultTools(server, client)
  registerAlternativeTools(server, client)
  registerResponseTools(server, client)

  return server
}
