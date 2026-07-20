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

// The EDE endpoints answer a no-data query (holiday / future date / uncovered
// security) with HTTP 500 + code 999999 — the generic "系统错误，请稍后重试"
// hint would send the caller into a retry loop that can never succeed. Reword
// to point at the query conditions; code left unset so the generic hint isn't
// re-attached.
async function callIndicator(client: GangtiseClient, endpointKey: string, args: Record<string, unknown>): Promise<unknown> {
  try {
    return await client.call(endpointKey, args)
  } catch (error) {
    if (error instanceof ApiError && error.code === "999999") {
      throw new ApiError(
        "指标查询无数据（错误码 999999）：请检查查询条件——日期是否为交易日（节假日/未来日期无数据）、证券与指标是否在覆盖范围内、参数取值是否有效。",
        undefined,
        error.statusCode,
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
    "分指标专属参数。行情复权键 adjustmentType：1=不复权 | 2=前复权 | 3=后复权；其余指标的参数键与取值以 gangtise_indicator_search 返回的 parameterList 为准",
  )

export function registerIndicatorTools(server: McpServer, client: GangtiseClient): void {
  server.registerTool(
    "gangtise_indicator_search",
    {
      description:
        "按名称搜索证券级数据指标（EDE），返回 indicatorCode 及可传参数 parameterList（含 required 必填标记与枚举）。覆盖 A 股/港股/美股。取数前必先用本工具拿 code，不要猜编码。宏观/行业数据（产量、价格、PMI 等）请改用 gangtise_edb_search。",
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
      const raw = await callIndicator(client, "indicator.search", args)
      return contentResult(await buildToolContent(normalizeRows(unwrapIndicatorData(raw))))
    }),
  )

  server.registerTool(
    "gangtise_indicator_cross_section",
    {
      description: withBilling(
        "gangtise_indicator_cross_section",
        "查询指标截面数据（多指标 × 多证券，单日快照）。返回宽表：每证券一行、每指标一列。指标代码来自 gangtise_indicator_search。",
      ),
      inputSchema: {
        indicatorCodeList,
        securityCodeList,
        date: dateString.describe(dateDesc() + "（必填）"),
        currency,
        scale,
        indicatorParamList,
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    toolHandler(async (args: Record<string, unknown>) => {
      const raw = await callIndicator(client, "indicator.cross-section", args)
      return contentResult(await buildToolContent(flattenCrossSection(unwrapIndicatorData(raw))))
    }),
  )

  server.registerTool(
    "gangtise_indicator_time_series",
    {
      description: withBilling(
        "gangtise_indicator_time_series",
        "查询指标时间序列（多指标 × 单证券 或 单指标 × 多证券，按区间）。返回宽表：每日期一行。指标代码来自 gangtise_indicator_search。",
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
      const raw = await callIndicator(client, "indicator.time-series", args)
      return contentResult(await buildToolContent(flattenTimeSeries(unwrapIndicatorData(raw))))
    }),
  )
}
