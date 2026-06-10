import { z } from "zod"
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import type { GangtiseClient } from "../core/client.js"
import { normalizeRows } from "../core/normalize.js"
import { buildToolContent } from "./registry.js"
import { toolHandler, contentResult } from "./helpers.js"

export function registerReferenceTools(server: McpServer, client: GangtiseClient): void {
  server.registerTool(
    "gangtise_securities_search",
    {
      description: "按关键词搜索证券，支持股票名称、代码（如 600519）、拼音或英文名。返回匹配证券及其 GTS 代码。",
      inputSchema: {
        keyword: z.string().describe("搜索词：股票名称、代码（如 600519）、拼音或英文名"),
        category: z.array(z.string()).optional().describe("按类别筛选，如 ['stock', 'fund', 'index']"),
        top: z.number().int().min(1).optional().describe("最大返回条数"),
      },
      annotations: { readOnlyHint: true },
    },
    toolHandler(async (args: Record<string, unknown>) => {
      const result = await client.call("reference.securities-search", args)
      return contentResult(await buildToolContent(normalizeRows(result)))
    }),
  )
}
