import { z } from "zod"
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import type { GangtiseClient } from "../core/client.js"
import { assertDateOrder, registerJsonTool, type JsonToolSpec } from "./registry.js"
import { buildToolContent } from "../core/present.js"
import { toolHandler, contentResult } from "./helpers.js"
import { normalizeRows } from "../core/normalize.js"
import { dateString } from "../core/dateContext.js"
import { nonEmptyString, nonEmptyList } from "./schemas.js"
import { withBilling } from "./billing.js"

/** 题材两档端点：full 缺省或为 true 走完整画像（v1），false 走不含催化事件 / 重点标记的低价端点。
 *  开关只决定打哪个端点，不进请求体。 */
function conceptResolve(fullKey: string, liteKey: string) {
  return ({ full, ...body }: Record<string, unknown>) => ({ endpointKey: full === false ? liteKey : fullKey, body })
}

export const specs: JsonToolSpec[] = [
  {
    name: "gangtise_edb_search",
    description: "按关键词搜索行业经济数据库（EDB）指标列表，返回指标 ID 和名称，用于后续查询时序数据。覆盖宏观/行业量价数据（产量、价格、PMI 等）；个股财务/行情/估值等证券级指标用 gangtise_indicator_search。",
    endpointKey: "alternative.edb-search",
    paginated: false,
    inputSchema: {
      keyword: nonEmptyString.describe("搜索关键词，如 '空调'、'PMI'（必填）"),
      limit: z.number().int().min(1).max(200).optional().describe("最大返回数量（默认 100，最大 200）"),
    },
  },
  {
    name: "gangtise_concept_info",
    description:
      "查询题材指数（概念/主题）基本信息：返回题材整体画像（定义 / 投资逻辑 / 行业空间 / 竞争格局；催化事件见 full）。仅返回最新截面数据，不支持历史回溯。conceptId 与主题跟踪 gangtise_theme_tracking 的 themeId 为同一套 ID 体系，可用 gangtise_concept_search 按名称查询（如 机器人 → 121000130）。",
    endpointKey: "alternative.concept-info-full",
    resolve: conceptResolve("alternative.concept-info-full", "alternative.concept-info"),
    paginated: false,
    inputSchema: {
      conceptId: nonEmptyString.describe("题材指数 ID，如 '121000130'（机器人）。来自 gangtise_concept_search（必填）"),
      full: z.boolean().optional().describe("默认 true 含催化事件 keyEvents（价见标签）；false 不含，50 积分/次"),
    },
  },
  {
    name: "gangtise_concept_securities",
    description:
      "查询题材指数（概念/主题）成分股（题材深度 F8）：按分组结构返回当前成分股（isKey / inclusionReason 见 full）。securityCount 是去重后的只数，逐组累加会多算。conceptId 与主题跟踪 gangtise_theme_tracking 的 themeId 为同一套 ID 体系，可用 gangtise_concept_search 按名称查询（如 机器人 → 121000130）。",
    endpointKey: "alternative.concept-securities-full",
    resolve: conceptResolve("alternative.concept-securities-full", "alternative.concept-securities"),
    paginated: false,
    inputSchema: {
      conceptId: nonEmptyString.describe("题材指数 ID，如 '121000130'（机器人）。来自 gangtise_concept_search（必填）"),
      full: z.boolean().optional().describe("默认 true 每只带 isKey（是否重点）与 inclusionReason（纳入理由），价见标签；false 不带，50 积分/次"),
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
      description: withBilling("按指标 ID 批量查询 EDB 行业指标时序数据（最多 10 个指标）。指标 ID 来自 gangtise_edb_search。", "alternative.edb-data"),
      inputSchema: {
        indicatorIdList: nonEmptyList().min(1).max(10).describe("指标 ID 列表（最多 10 个），来自 gangtise_edb_search"),
        startDate: dateString,
        endDate: dateString,
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    toolHandler(async (args: Record<string, unknown>) => {
      assertDateOrder(args)
      const raw = await client.call("alternative.edb-data", args) as Record<string, unknown>
      let normalized: unknown = raw
      if (raw && Array.isArray(raw.fieldList) && Array.isArray(raw.dataList)) {
        // 换名后交给 normalizeRows 走同一套按位置拍平 + 长度校验，不再自己 zip：
        // 本工具不暴露 fieldList 入参（字段名由服务端给），今天不会错列，但错列一旦
        // 发生就是静默的错值，不值得为省一次改名而留第二条未校验的拍平路径。
        const { fieldList, dataList, ...meta } = raw
        normalized = { ...meta, total: (dataList as unknown[]).length, fieldList, list: dataList }
      }
      return contentResult(await buildToolContent(normalizeRows(normalized)))
    }),
  )
}
