import { z } from "zod"
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import type { GangtiseClient } from "../core/client.js"
import { registerJsonTool, buildToolContent, type JsonToolSpec } from "./registry.js"
import { normalizeRows } from "../core/normalize.js"
import { errorMessage } from "../core/errors.js"
import { dateDesc, dateContextPrefix } from "../core/dateContext.js"

const specs: JsonToolSpec[] = [
  {
    name: "gangtise_edb_search",
    description: "按关键词搜索行业经济数据库（EDB）指标列表，返回指标 ID 和名称，用于后续查询时序数据。",
    endpointKey: "alternative.edb-search",
    paginated: false,
    inputSchema: {
      keyword: z.string().describe("搜索关键词，如 '空调'、'PMI'（必填）"),
      limit: z.number().int().min(1).max(200).optional().describe("最大返回数量（默认 100，最大 200）"),
    },
  },
]

export function registerAlternativeTools(server: McpServer, client: GangtiseClient): void {
  for (const spec of specs) {
    registerJsonTool(server, client, spec)
  }

  // edb-data returns { fieldList, dataList } — needs custom normalization before passing to buildToolContent
  server.registerTool(
    "gangtise_edb_data",
    {
      description: dateContextPrefix() + "按指标 ID 批量查询 EDB 行业指标时序数据（最多 10 个指标）。指标 ID 来自 gangtise_edb_search。",
      inputSchema: {
        indicatorIdList: z.array(z.string()).min(1).max(10).describe("指标 ID 列表（最多 10 个），来自 gangtise_edb_search"),
        startDate: z.string().describe(dateDesc() + "（必填）"),
        endDate: z.string().describe(dateDesc() + "（必填）"),
      },
    },
    async (args) => {
      try {
        const raw = await client.call("alternative.edb-data", args as Record<string, unknown>) as Record<string, unknown>
        let normalized: unknown = raw
        if (raw && Array.isArray(raw.fieldList) && Array.isArray(raw.dataList)) {
          const fields = raw.fieldList as string[]
          const list = (raw.dataList as unknown[][]).map((row) =>
            fields.reduce<Record<string, unknown>>((acc, field, i) => {
              acc[field] = row[i]
              return acc
            }, {}),
          )
          normalized = { list, total: list.length }
        }
        return { content: await buildToolContent(normalizeRows(normalized)) }
      } catch (err) {
        return { content: [{ type: "text" as const, text: errorMessage(err) }], isError: true }
      }
    },
  )
}
