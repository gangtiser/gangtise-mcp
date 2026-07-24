import { z } from "zod"
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import type { GangtiseClient } from "../core/client.js"
import { buildToolContent } from "./registry.js"
import { toolHandler, contentResult } from "./helpers.js"
import { normalizeRows } from "../core/normalize.js"
import { unwrapIndicatorData, flattenCrossSection, flattenTimeSeries } from "../core/indicatorMatrix.js"
import { dateDesc, dateString } from "../core/dateContext.js"
import { ApiError, ValidationError } from "../core/errors.js"
import { withBilling } from "./billing.js"

// The EDE FETCH endpoints (cross-section/time-series) answer a no-data query
// (holiday / future date / uncovered security / wrong period) with HTTP 500 +
// 999999 — the generic "稍后重试" hint would send the caller retrying a query that
// can never have data, so swap in a fetch-specific hint (date by indicator period /
// scope / required params). indicator.search shares the no-999999 retry policy but
// takes just a keyword; its 999999 is a real error (a zero-match search returns [] —
// exit 0), so it keeps the generic hint. Mirrors gangtise-openapi-cli 0.28.2 (client.js).
//
// The inner envelope is peeled INSIDE this try on purpose: EDE double-wraps, and a
// 999999 raised while peeling the inner envelope (success outer / failure inner)
// would otherwise bypass the override.
async function callIndicator(client: GangtiseClient, endpointKey: string, args: Record<string, unknown>): Promise<unknown> {
  try {
    return unwrapIndicatorData(await client.call(endpointKey, args))
  } catch (error) {
    const isFetch = endpointKey === "indicator.cross-section" || endpointKey === "indicator.time-series"
    if (isFetch && error instanceof ApiError && error.code === "999999") {
      throw new ApiError(
        error.message,
        error.code,
        error.statusCode,
        error.details,
        error.retryAfterMs,
        "EDE 的 999999 多为查询无数据——先核对：日期匹配指标周期（财务/MRQ 用报告期末如 2025-12-31、日频估值用交易日）、标的在 scopeList 覆盖内、parameterList 中 required 参数已补；确认应有数据再重试。",
      )
    }
    throw error
  }
}

const indicatorCodeList = z
  .array(z.string())
  .min(1, "indicatorCodeList 至少 1 个")
  .describe("指标代码列表（至少 1 个），如 ['qte_close']，来自 gangtise_indicator_search 的 indicatorCode")
const securityCodeList = z
  .array(z.string())
  .min(1, "securityCodeList 至少 1 个")
  .describe("证券代码列表（至少 1 个），支持 A 股/港股/美股，如 ['600519.SH','00700.HK','AAPL.O']；美股用交易所后缀 .O(NASDAQ) / .N(NYSE)，不是 .US（.US 查不到数据）")
const currency = z
  .enum(["DFT", "CNY", "HKD", "USD", "EUR", "GBP", "JPY", "TWD", "MOP", "AUD"])
  .optional()
  .describe("货币：DFT=默认 | CNY | HKD | USD | EUR | GBP | JPY | TWD | MOP | AUD")
const scale = z.enum(["0", "3", "4", "6", "8", "9"]).optional().describe("数量级：0=个（默认）| 3=千 | 4=万 | 6=百万 | 8=亿 | 9=十亿")
const indicatorParamList = z
  .array(
    z.object({
      indicatorCode: z.string().min(1).describe("指标代码，如 qte_close"),
      parameters: z
        .array(z.object({ paramKey: z.string().min(1), paramValue: z.string() }))
        .min(1)
        .describe("参数键值对，如 [{ paramKey: 'adjustmentType', paramValue: '2' }]"),
    }),
  )
  .optional()
  .describe(
    "分指标专属参数。parameterList 标 required 的必须补否则报错：qte 周期变体→startDate(整数YYYYMMDD)、N期统计→periodNum(如4)、分红/预测→fiscalYear(年份)。可选参数：行情复权 adjustmentType(1=不复权|2=前复权|3=后复权)；reportType 勿传——截至 2026-07-24 EDE 该枚举与实际不符(2/4 常报错，省略即合并口径)，要指定合并/母公司口径改用 fundamental 三大报表。其余键值以 gangtise_indicator_search 的 parameterList 为准",
  )

export function registerIndicatorTools(server: McpServer, client: GangtiseClient): void {
  server.registerTool(
    "gangtise_indicator_search",
    {
      description:
        "按名称搜索证券级数据指标（EDE），返回 indicatorCode、scopeList（覆盖市场）及 parameterList（含 required 必填标记与枚举）。取数前必先用本工具拿 code，并核对 indicatorName/description 语义、scopeList 是否覆盖目标市场、parameterList 取值——任一不符即回退专用工具。基础行情（开高低收/成交量额/换手/涨跌幅）虽可搜到仍优先 realtime/day_kline，但**总市值 qte_mkt_cptl 这两个专用工具都没有、单票也走 EDE**（仅 A 股，默认「元」，用 scale 缩放）；单票完整报表、盈利预测(一致预期)、估值历史分位仍用专用工具（当前 EDE 搜索未覆盖后两类）；EDE 批量优先仅针对多证券取一批已实现财务/估值指标。宏观/行业数据（产量、价格、PMI 等）请改用 gangtise_edb_search，不要猜编码。",
      inputSchema: {
        keyword: z
          .string()
          .trim()
          .min(1, "搜索词不能为空")
          .describe("搜索词，如 '收盘价' '成交量' '营业收入'（用具体指标名，非整句白话）"),
        limit: z.number().int().min(1).max(100).optional().describe("最大返回条数（默认 50，上限 100）"),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    toolHandler(async (args: Record<string, unknown>) => {
      const data = await callIndicator(client, "indicator.search", args)
      return contentResult(await buildToolContent(normalizeRows(data)))
    }),
  )

  server.registerTool(
    "gangtise_indicator_cross_section",
    {
      description: withBilling(
        "gangtise_indicator_cross_section",
        "查询指标截面数据（多指标 × 多证券，单日快照）。返回宽表：每证券一行、每指标一列。指标代码来自 gangtise_indicator_search。多证券取同一批已实现财务/估值指标的首选（一次拉取，免去逐只调用专用工具）。财务科目分公司类型，公司类型不匹配时返 null（≠指标坏）；整批无数据报 999999 时改用 gangtise_indicator_time_series（对缺值返 null 不报错）。",
      ),
      inputSchema: {
        indicatorCodeList,
        securityCodeList,
        date: dateString.describe(dateDesc() + "（必填）。财务指标填报告期末季末（现金流附注/N期统计填年报如 2025-12-31），行情填交易日；日期语义不符会整批报 999999"),
        currency,
        scale,
        indicatorParamList,
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    toolHandler(async (args: Record<string, unknown>) => {
      const data = await callIndicator(client, "indicator.cross-section", args)
      return contentResult(await buildToolContent(flattenCrossSection(data)))
    }),
  )

  server.registerTool(
    "gangtise_indicator_time_series",
    {
      description: withBilling(
        "gangtise_indicator_time_series",
        "查询指标时间序列（多指标 × 单证券 或 单指标 × 多证券，按区间）。返回宽表：每日期一行。指标代码来自 gangtise_indicator_search。单指标 × 多证券即批量取财务/估值历史序列的首选；多指标 × 多证券不支持，需拆分。财务指标区间需覆盖报告期末；对缺值返 null，是截面遇 999999（整批无数据）时的稳健替代。",
      ),
      inputSchema: {
        indicatorCodeList,
        securityCodeList,
        startDate: dateString.describe(dateDesc() + "（必填）"),
        endDate: dateString.describe(dateDesc() + "（必填）"),
        calendarType: z.enum(["ND", "TD", "WD"]).optional().describe("日历类型：ND=自然日 | TD=交易日（默认）| WD=工作日"),
        currency,
        scale,
        indicatorParamList,
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    toolHandler(async (args: Record<string, unknown>) => {
      // Time-series flattens along exactly one varying dimension. With both >1
      // the [series][date] matrix is ambiguous and flattenTimeSeries would
      // silently drop the indicator dimension — reject before hitting the API.
      const indicators = (args.indicatorCodeList as string[] | undefined) ?? []
      const securities = (args.securityCodeList as string[] | undefined) ?? []
      if (indicators.length > 1 && securities.length > 1) {
        throw new ValidationError(
          "时间序列仅支持「多指标 × 单证券」或「单指标 × 多证券」，indicatorCodeList 与 securityCodeList 不能同时多于 1 个；请拆分为多次查询，或改用 gangtise_indicator_cross_section（单日多指标 × 多证券）。",
        )
      }
      const data = await callIndicator(client, "indicator.time-series", args)
      return contentResult(await buildToolContent(flattenTimeSeries(data)))
    }),
  )
}
