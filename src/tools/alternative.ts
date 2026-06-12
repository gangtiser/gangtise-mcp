import { z } from "zod"
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import type { GangtiseClient } from "../core/client.js"
import { registerJsonTool, buildToolContent, type JsonToolSpec } from "./registry.js"
import { toolHandler, contentResult } from "./helpers.js"
import { normalizeRows } from "../core/normalize.js"
import { dateDesc } from "../core/dateContext.js"

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
  {
    name: "gangtise_concept_info",
    description:
      "查询题材指数（概念/主题）基本信息：返回题材整体画像（定义 / 投资逻辑 / 行业空间 / 竞争格局 / 催化事件）。仅返回最新截面数据，不支持历史回溯。conceptId 与主题跟踪 gangtise_theme_tracking 的 themeId 为同一套 ID 体系，可用 gangtise_concept_search 按名称查询（如 机器人 → 121000130）。",
    endpointKey: "alternative.concept-info",
    paginated: false,
    inputSchema: {
      conceptId: z.string().describe("题材指数 ID，如 '121000130'（机器人）。来自 gangtise_concept_search（必填）"),
    },
  },
  {
    name: "gangtise_concept_securities",
    description:
      "查询题材指数（概念/主题）成分股（题材深度 F8）：按分组结构返回当前成分股，每只含是否重点个股 isKey 与纳入理由 inclusionReason。conceptId 与主题跟踪 gangtise_theme_tracking 的 themeId 为同一套 ID 体系，可用 gangtise_concept_search 按名称查询（如 机器人 → 121000130）。",
    endpointKey: "alternative.concept-securities",
    paginated: false,
    inputSchema: {
      conceptId: z.string().describe("题材指数 ID，如 '121000130'（机器人）。来自 gangtise_concept_search（必填）"),
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
      description: "按指标 ID 批量查询 EDB 行业指标时序数据（最多 10 个指标）。指标 ID 来自 gangtise_edb_search。",
      inputSchema: {
        indicatorIdList: z.array(z.string()).min(1).max(10).describe("指标 ID 列表（最多 10 个），来自 gangtise_edb_search"),
        startDate: z.string().describe(dateDesc() + "（必填）"),
        endDate: z.string().describe(dateDesc() + "（必填）"),
      },
      annotations: { readOnlyHint: true },
    },
    toolHandler(async (args: Record<string, unknown>) => {
      const raw = await client.call("alternative.edb-data", args) as Record<string, unknown>
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
      return contentResult(await buildToolContent(normalizeRows(normalized)))
    }),
  )
}
