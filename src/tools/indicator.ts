import { z } from "zod"
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import type { GangtiseClient } from "../core/client.js"
import { buildToolContent } from "./registry.js"
import { toolHandler, contentResult } from "./helpers.js"
import { normalizeRows } from "../core/normalize.js"
import {
  unwrapIndicatorData,
  requireIndicatorMatrix,
  isEmptyMatrix,
  droppedFromMatrix,
  checkScreenerBindings,
  flattenCrossSection,
  flattenTimeSeries,
} from "../core/indicatorMatrix.js"
import { screenerExpressionFields, SCREENER_FIELD } from "../core/screenerExpression.js"
import { dateDesc, dateString } from "../core/dateContext.js"
import { ApiError, ValidationError } from "../core/errors.js"
import { withBilling } from "./billing.js"

// The EDE FETCH endpoints (cross-section/time-series/screener) used to answer a
// no-data query with HTTP 500 + 999999; since the 2026-08-01 revision a no-data
// query returns an EMPTY TABLE instead, so this code is now almost always a real
// fault. The hint keeps the parameter checklist anyway — writing a parameter name
// or date semantic wrong ALSO surfaces as an empty table, so the checklist is
// what the caller needs either way. indicator.search shares the no-999999 retry
// policy but takes just a keyword; its 999999 is a real error (a zero-match
// search returns []), so it keeps the generic hint.
//
// The inner envelope is peeled INSIDE this try on purpose: EDE double-wraps, and a
// 999999 raised while peeling the inner envelope (success outer / failure inner)
// would otherwise bypass the override.
const FETCH_KEYS = new Set(["indicator.cross-section", "indicator.time-series", "indicator.screener"])

async function callIndicator(client: GangtiseClient, endpointKey: string, body: Record<string, unknown>): Promise<unknown> {
  try {
    return unwrapIndicatorData(await client.call(endpointKey, body))
  } catch (error) {
    if (FETCH_KEYS.has(endpointKey) && error instanceof ApiError && error.code === "999999") {
      throw new ApiError(
        error.message,
        error.code,
        error.statusCode,
        error.details,
        error.retryAfterMs,
        "EDE 的 999999 现在基本只剩真故障（自 2026-08-01 起查询无数据返回空表而不是此码）。仍先核对：指标参数名以 gangtise_indicator_search 的 parameterList 为准、日期匹配指标周期、标的在 scopeList 覆盖内、required 参数已补——参数写错同样表现为空表；确认应有数据再重试。",
      )
    }
    throw error
  }
}

/** Raw matrix call: keep the envelope until requireIndicatorMatrix has validated
 * the shape, because a `data: null` cannot carry the non-enumerable traceId. */
async function callMatrix(client: GangtiseClient, endpointKey: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
  try {
    return requireIndicatorMatrix(await client.call(endpointKey, body))
  } catch (error) {
    if (FETCH_KEYS.has(endpointKey) && error instanceof ApiError && error.code === "999999") {
      throw new ApiError(
        error.message,
        error.code,
        error.statusCode,
        error.details,
        error.retryAfterMs,
        "EDE 的 999999 现在基本只剩真故障（自 2026-08-01 起查询无数据返回空表而不是此码）。仍先核对：指标参数名以 gangtise_indicator_search 的 parameterList 为准、日期匹配指标周期、标的在 scopeList 覆盖内、required 参数已补——参数写错同样表现为空表；确认应有数据再重试。",
      )
    }
    throw error
  }
}

/** The server does not pad a wholly-absent indicator or security with `null` —
 * it drops the row/column outright, at HTTP 200 with nothing in the payload
 * saying so. A batch pull then silently returns less than was asked for, so mark
 * it with the same loud-partial contract the pagination and sharding layers use.
 *
 * A legitimately empty result is deliberately NOT flagged: when the whole query
 * resolved to nothing, the request-vs-response diff is total by construction and
 * listing every requested code as "omitted" would be false metadata. */
function flagOmitted(result: unknown, dropped: { securities: string[]; indicators: string[] }): unknown {
  if (dropped.securities.length === 0 && dropped.indicators.length === 0) return result
  if (!result || typeof result !== "object") return result
  const out = result as Record<string, unknown>
  const reasons: string[] = []
  if (dropped.indicators.length > 0) {
    out.omittedIndicators = dropped.indicators
    reasons.push("omitted_indicators")
  }
  if (dropped.securities.length > 0) {
    out.omittedSecurities = dropped.securities
    reasons.push("omitted_securities")
  }
  out._partial = true
  out._partial_reason = reasons.join(",")
  return out
}

// The query date rides on each indicator's own parameters now that the root-level
// `date` is gone. An indicator that already declares its own tradeDate/reportDate
// keeps it. `sDate` is deliberately NOT in this set: it is an interval START while
// `tradeDate` is the required interval END, so treating it as a substitute would
// drop the end date and silently move the window (茅台 qte_vol_intvl with only
// sDate=2024-01-02 returned 2,265,873,849 vs 65,687,435 with the end date — both
// at HTTP 200).
const DATE_PARAM_KEYS = new Set(["tradeDate", "reportDate"])

type ParamGroup = { indicatorCode: string; parameters: { paramKey: string; paramValue: string }[] }

/** Collapse repeated `indicatorCode` entries into one, concatenating their
 * parameters.
 *
 * Two entries for the same code must MERGE, and every matrix endpoint needs this
 * — the loss is silent on both, by two different mechanisms:
 *  - keying with a bare `Map.set()` drops the earlier entry locally;
 *  - passing both through lets the SERVER keep only the last one (probed
 *    2026-08-03 on time-series: `[{qte_close, adjustType:3}, {qte_close,
 *    currency:USD}]` returned 238.0967 = the USD group alone, while the merged
 *    form returned 1923.0771 = post-adjusted in USD).
 * Either way a caller asking for post-adjusted prices gets unadjusted ones at
 * HTTP 200 with no warning.
 *
 * This is an MCP-only hazard: the CLI's `--indicator-param` syntax cannot express
 * two groups for one code (parseParamSpecs accumulates into a single group), so
 * there is no CLI behaviour to match here — merging is simply the only reading
 * that does not throw away a requested parameter. */
function mergeParamGroups(groups: ParamGroup[] | undefined): ParamGroup[] {
  const merged = new Map<string, ParamGroup>()
  for (const group of groups ?? []) {
    const existing = merged.get(group.indicatorCode)
    if (existing) existing.parameters.push(...group.parameters)
    else merged.set(group.indicatorCode, { indicatorCode: group.indicatorCode, parameters: [...group.parameters] })
  }
  return [...merged.values()]
}

function withQueryDate(groups: ParamGroup[] | undefined, codes: string[], date: string): ParamGroup[] {
  const merged = new Map(mergeParamGroups(groups).map((group) => [group.indicatorCode, group]))
  for (const code of codes) {
    const group = merged.get(code)
    if (!group) {
      merged.set(code, { indicatorCode: code, parameters: [{ paramKey: "tradeDate", paramValue: date }] })
    } else if (!group.parameters.some((param) => DATE_PARAM_KEYS.has(param.paramKey))) {
      group.parameters.push({ paramKey: "tradeDate", paramValue: date })
    }
  }
  return [...merged.values()]
}

const indicatorCodeList = z
  .array(z.string())
  .min(1, "indicatorCodeList 至少 1 个")
  .describe("指标代码列表（至少 1 个），如 ['qte_close']，来自 gangtise_indicator_search 的 indicatorCode")
const securityCodeList = z
  .array(z.string())
  .min(1, "securityCodeList 至少 1 个")
  .describe(
    "证券代码列表（至少 1 个），支持 A 股/港股/美股，如 ['600519.SH','00700.HK','AAPL.O']；美股用交易所后缀 .O(NASDAQ) / .N(NYSE)，不是 .US（.US 查不到数据）。也接受 gangtise_sector_search 返回的 10 位 sectorId（板块，服务端展开为全部成分股，可与证券代码混传取并集）；中信行业码那类 9 位 ID 不是 sectorId，传了返 0 只",
  )
const currency = z
  .enum(["DFT", "CNY", "HKD", "USD", "EUR", "GBP", "JPY", "TWD", "MOP", "AUD"])
  .optional()
  .describe(
    "货币：DFT=默认(原始币种) | CNY | HKD | USD | EUR | GBP | JPY | TWD | MOP | AUD。同一只港股行情类原始币种是 HKD、财务类可能是 CNY（如泡泡玛特财报以人民币计），跨市场比财务数据须显式指定",
  )
const scale = z
  .enum(["0", "3", "4", "6", "8", "9"])
  .optional()
  .describe(
    "数量级：0=个（默认）| 3=千 | 4=万 | 6=百万 | 8=亿 | 9=十亿。⚠️ 这是根级参数，会污染不声明 scale 的指标——实测 qte_close 的 parameterList 没有 scale，根级 scale=8 把收盘价 1350.6 缩成 0。价格与金额混查时别用根级，改在 indicatorParamList 里按指标传 scale",
  )

const paramPair = z.object({ paramKey: z.string().min(1), paramValue: z.string() })

// 非日期类的参数说明，三个取数工具共用。日期类的说明**必须分开**：截面/选股是单日快照
// （工具有 date，会注入 tradeDate），时序是区间（服务端明确禁止 parameters 里出现单日期
// 参数）——两套语义相反，共用一段就必然对其中一个是错的。
const PARAM_GUIDANCE_COMMON =
  "可选参数：行情复权 adjustType(1=不复权|2=前复权|3=后复权)——⚠️ 参数名就是 adjustType，写成 adjustmentType 会被服务端静默忽略并退回不复权（实测茅台 2024-01-02：adjustmentType=3 返 1685.01 即不复权，adjustType=3 才是 13609.6168 真后复权）；财务报表口径 reportType（1=合并(默认) | 2=合并(调整) | 3=母公司 | 4=母公司(调整)，服务端 enum label 已于 2026-08-01 改正、按 label 传即可，但同一响应的 paramDescription 仍留着相反的旧文字，别读它）。区间类指标（qte_*_intvl / 区间均值等）的起始日是 sDate(yyyy-MM-dd)——**没有 startDate 这个参数**（实测 2026-08-03 全部区间指标只声明 sDate/changePeriod/tradeDate），写 startDate 会被静默忽略。其余键值一律以 gangtise_indicator_search 的 parameterList 为准，不要照抄任何文档示例——服务端会改参数名且传错是静默失效。同一指标的多个参数请放进同一条的 parameters 数组"

/** 截面 / 选股（单日快照，工具有 `date`）。 */
const PARAM_GUIDANCE_DATED =
  "parameterList 标 required 的日期参数由本工具的 date 自动下发为 tradeDate；吃 reportDate 的指标要在这里显式传 reportDate（否则收到 tradeDate 会静默返回空结果）。其他 required：N期统计→periodNum(如4)+reportDate、分红/预测→fiscalYear(年份)。区间类指标的区间终点就是注入的 tradeDate，sDate 只是起点。" +
  PARAM_GUIDANCE_COMMON

/** 时序（区间，工具有 startDate/endDate）。 */
const PARAM_GUIDANCE_RANGE =
  "⚠️ **本端点禁止在 parameters 里传单日期参数**：`tradeDate` 与 `reportDate` 都会被服务端硬拒（实测 2026-08-03 报 100003「parameters不得传入单日期参数，时间范围由startDate与endDate控制」），时间范围一律由本工具的 startDate/endDate 决定。因此：N期统计只传 periodNum(如4)、**不要**传 reportDate；区间类指标只传 sDate 作为区间起点，区间终点是每行自己的日期。" +
  PARAM_GUIDANCE_COMMON

/** 按端点的日期语义生成 `indicatorParamList`——截面/选股与时序的日期规则相反，
 * 说明不能共用（见 PARAM_GUIDANCE_DATED / _RANGE）。 */
const indicatorParamListWith = (guidance: string) =>
  z
    .array(
      z.object({
        indicatorCode: z.string().min(1).describe("指标代码，如 qte_close"),
        parameters: z.array(paramPair).min(1).describe("参数键值对，如 [{ paramKey: 'adjustType', paramValue: '2' }]"),
      }),
    )
    .optional()
    .describe("分指标专属参数。" + guidance)

export function registerIndicatorTools(server: McpServer, client: GangtiseClient): void {
  server.registerTool(
    "gangtise_indicator_search",
    {
      description:
        "按名称搜索证券级数据指标（EDE），返回 indicatorCode、scopeList（覆盖市场，附 usageRestriction）及 parameterList（含 required 必填标记与枚举）。取数前必先用本工具拿 code，并核对 indicatorName/description 语义、scopeList 是否覆盖目标市场、parameterList 取值——任一不符即回退专用工具。scopeList 是声明不是保证，usageRestriction（如「不支持指标时间序列接口」）也不是硬约束、按「口径可能不对」理解，均以实际抽查为准。基础行情（开高低收/成交量额/换手/涨跌幅）虽可搜到仍优先 realtime/day_kline，但**总市值 qte_mkt_cptl 这两个专用工具都没有、单票也走 EDE**（A/港/美股均已有数，默认「元」，用 scale 缩放）；单票完整报表、盈利预测(一致预期)、估值历史分位仍用专用工具（当前 EDE 搜索未覆盖后两类）；EDE 批量优先仅针对多证券取一批已实现财务/估值指标。宏观/行业数据（产量、价格、PMI 等）请改用 gangtise_edb_search，不要猜编码。",
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
        "查询指标截面数据（多指标 × 多证券，单日快照）。返回宽表：每证券一行、每指标一列（无 date 列——查询日期挂在每个指标自己的参数上，各列可以是不同日期）。指标代码来自 gangtise_indicator_search。多证券取同一批已实现财务/估值指标的首选（一次拉取，免去逐只调用专用工具）。财务科目分公司类型，公司类型不匹配时返 null（≠指标坏）。缺数据分四档：某证券某指标缺→该单元格 null；某指标对全部证券无数据→整列消失；某证券对全部指标无数据→整行消失（后两档会标 _partial + omittedIndicators/omittedSecurities）；整批无数据→空表（不是报错，先核对参数名与日期语义再断定真没数据）。要把「整行消失」降级成 null 单元格，得在批里加一个覆盖面广的指标（如 qte_close），加证券没用。",
      ),
      inputSchema: {
        indicatorCodeList,
        securityCodeList,
        date: dateString.describe(
          dateDesc() +
            "（必填）。下发为每个指标各自的 tradeDate。财务指标填报告期末季末（现金流附注/N期统计填年报如 2025-12-31），行情与日频估值（PE TTM、PB MRQ 现均为日频、逐日变动）填交易日；吃 reportDate 的指标须在 indicatorParamList 里显式传 reportDate，否则收到 tradeDate 会静默返回空结果",
        ),
        currency,
        scale,
        indicatorParamList: indicatorParamListWith(PARAM_GUIDANCE_DATED),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    toolHandler(async (args: Record<string, unknown>) => {
      const indicators = args.indicatorCodeList as string[]
      const securities = args.securityCodeList as string[]
      const body = {
        indicatorCodeList: indicators,
        // The 2026-08-01 revision renamed this field; the old securityCodeList is
        // a hard 100001 now.
        universe: securities,
        currency: args.currency,
        scale: args.scale,
        indicatorParamList: withQueryDate(args.indicatorParamList as ParamGroup[] | undefined, indicators, args.date as string),
      }
      const data = await callMatrix(client, "indicator.cross-section", body)
      if (isEmptyMatrix(data)) return contentResult(await buildToolContent({ list: [], total: 0 }))
      const flattened = flattenCrossSection(data)
      return contentResult(await buildToolContent(flagOmitted(flattened, droppedFromMatrix(data, securities, indicators))))
    }),
  )

  server.registerTool(
    "gangtise_indicator_time_series",
    {
      description: withBilling(
        "gangtise_indicator_time_series",
        "查询指标时间序列（多指标 × 单证券 或 单指标 × 多证券，按区间）。返回宽表：每日期一行。指标代码来自 gangtise_indicator_search。单指标 × 多证券即批量取财务/估值历史序列的首选；多指标 × 多证券不支持，需拆分——注意传 1 个 sectorId（板块）算多证券（服务端展开成 N 只成分股），所以板块只能配单指标。财务指标区间需覆盖报告期末。缺数据分档同截面（单元格 null / 整列消失 / 整行消失 / 空表），后两档标 _partial。",
      ),
      inputSchema: {
        indicatorCodeList,
        securityCodeList,
        startDate: dateString.describe(dateDesc() + "（必填）"),
        endDate: dateString.describe(dateDesc() + "（必填）"),
        calendarType: z.enum(["ND", "TD", "WD"]).optional().describe("日历类型：ND=自然日 | TD=交易日（默认）| WD=工作日"),
        currency,
        scale,
        indicatorParamList: indicatorParamListWith(PARAM_GUIDANCE_RANGE),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    toolHandler(async (args: Record<string, unknown>) => {
      // Time-series flattens along exactly one varying dimension. With both >1
      // the [series][date] matrix is ambiguous and one of the two identities
      // would be silently dropped — reject before hitting the API (the server
      // rejects it too, with 100003, but only after a billed round trip).
      const indicators = args.indicatorCodeList as string[]
      const securities = args.securityCodeList as string[]
      if (indicators.length > 1 && securities.length > 1) {
        throw new ValidationError(
          "时间序列仅支持「多指标 × 单证券」或「单指标 × 多证券」，indicatorCodeList 与 securityCodeList 不能同时多于 1 个；请拆分为多次查询，或改用 gangtise_indicator_cross_section（单日多指标 × 多证券）。",
        )
      }
      // A sector ID expands server-side into N constituents, so it is a
      // multi-security request no matter that it is one entry — and the endpoint
      // does not support that alongside multiple indicators.
      if (indicators.length > 1 && securities.some((entry) => !entry.includes("."))) {
        throw new ValidationError(
          "securityCodeList 里含板块 ID（sectorId）时只能配单个指标：板块由服务端展开成全部成分股，即「多证券」，与多指标同时使用不被支持。请改为单指标，或把板块换成具体证券代码。",
        )
      }
      const body = {
        indicatorCodeList: indicators,
        universe: securities,
        startDate: args.startDate,
        endDate: args.endDate,
        calendarType: args.calendarType,
        currency: args.currency,
        scale: args.scale,
        // Merge repeated codes (see mergeParamGroups) but do NOT inject a
        // tradeDate the way cross-section does: here the window is governed by
        // startDate/endDate, so an injected per-indicator date would fight it.
        // The endpoint requires the key even with nothing to configure.
        indicatorParamList: mergeParamGroups(args.indicatorParamList as ParamGroup[] | undefined),
      }
      const data = await callMatrix(client, "indicator.time-series", body)
      // `dates` is a required axis here, so an answer that dropped it is broken
      // rather than empty — require it so such a payload reaches flattenTimeSeries
      // and fails loudly instead of returning a clean empty table.
      if (isEmptyMatrix(data, { requireDates: true })) return contentResult(await buildToolContent({ list: [], total: 0 }))
      const flattened = flattenTimeSeries(data, securities)
      return contentResult(await buildToolContent(flagOmitted(flattened, droppedFromMatrix(data, securities, indicators))))
    }),
  )

  server.registerTool(
    "gangtise_indicator_screener",
    {
      description: withBilling(
        "gangtise_indicator_screener",
        "条件选股：把变量绑到指标（F1=某指标、F2=另一指标），再用 expression 组合筛选，从证券/板块范围里筛出命中的股票。返回宽表：每命中证券一行、每绑定指标一列（无 date 列）。指标代码来自 gangtise_indicator_search。这是唯一能按指标数值筛股的工具（专用工具都不支持），典型用法：给 securityCodeList 传一个板块 sectorId（服务端展开为全部成分股）再按市值/PE 筛。支持数值比较（>= <= > < == !=）与文本匹配 contains/notcontains（仅 dataType: string 的指标）。零命中返回空表，不是报错——先核对指标参数名与日期语义再断定「真没有符合条件的」。",
      ),
      inputSchema: {
        indicatorList: z
          .array(
            z.object({
              field: z
                .string()
                .regex(SCREENER_FIELD, "变量名须是 F 加正整数，如 F1")
                .describe("变量名，F 加正整数（F1/F2/...），在 expression 里引用"),
              indicatorCode: z.string().min(1).describe("该变量绑定的指标代码，如 qte_mkt_cptl"),
              parameters: z
                .array(paramPair)
                .optional()
                .describe(
                  "该变量专属参数（按变量索引，不是按指标）。⚠️ **本端点没有根级 currency/scale——量纲与币种只能在这里按变量传**：实测 2026-08-03 根级写法被服务端完全忽略（茅台 qte_mkt_cptl 加根级 scale=8 仍返 1688360210310.6，与不传逐位相同），而表达式是拿这个原始值去比的，于是「市值≥500亿」写成根级 scale 就变成「≥500 元」恒真、白酒板块从 5 只筛成 14 只且不报错。按变量传 scale=8 才得到 16883.6021。"
                    + PARAM_GUIDANCE_DATED,
                ),
            }),
          )
          .min(1, "indicatorList 至少 1 个")
          .describe("变量到指标的绑定（至少 1 个）。每个变量绑定恰好一个指标，变量名不可重复；同一指标也不能绑到多个变量（服务端当前会错值，本工具直接拒绝，需要同指标不同参数请拆成多次调用）"),
        expression: z
          .string()
          .trim()
          .min(1, "expression 不能为空")
          .describe(
            "筛选表达式，用 && || 和括号组合各变量的比较，如 \"F1 >= 500 && F2 <= 30\" 或 \"F1 > 0 || F2 > 0\"；文本匹配写成 \"F3 contains '酒'\"。只能引用 indicatorList 绑定过的变量。⚠️ **比较值的量纲 = 该变量的原始单位**，不是你心里的单位：市值/金额类指标默认返「元」，所以「市值≥500亿」必须给 F1 按变量传 scale=8 后再写 F1 >= 500，否则就是在比「≥500 元」——恒真、筛不掉任何股票，且不会报错（实测白酒板块因此从 5 只变 14 只、含市盈率为负的票）。拿不准就先用 gangtise_indicator_cross_section 看一眼该指标返回的量级",
          ),
        securityCodeList,
        date: dateString.describe(
          dateDesc() +
            "（必填）。无条件下发为每个变量的 tradeDate（已在 parameters 里声明 tradeDate/reportDate 的变量保留自己的）。日期语义不符会筛不出股票而不是报错",
        ),
        // 有意不提供根级 currency/scale：实测服务端在本端点完全忽略它们（见 parameters
        // 描述），而表达式拿原始值比较 → 筛选条件静默失效。也不能改成「把根级值塞进每个
        // 绑定」——那会复刻截面那个根级 scale 把 qte_close 缩成 0 的污染语义。
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    toolHandler(async (args: Record<string, unknown>) => {
      const bindings = args.indicatorList as { field: string; indicatorCode: string; parameters?: { paramKey: string; paramValue: string }[] }[]
      const expression = args.expression as string
      const securities = args.securityCodeList as string[]

      const seen = new Set<string>()
      for (const binding of bindings) {
        if (seen.has(binding.field)) {
          throw new ValidationError(`indicatorList 里变量 ${binding.field} 重复绑定：每个变量只能绑定一个指标。`)
        }
        seen.add(binding.field)
      }
      // The server accepts a variable the expression never uses while still
      // billing its column, and rejects the reverse (100003) only after a round
      // trip — so catch the reverse locally.
      for (const ref of screenerExpressionFields(expression)) {
        if (!seen.has(ref)) {
          throw new ValidationError(`expression 引用了变量 ${ref}，但 indicatorList 没有绑定它。`)
        }
      }
      // One indicatorCode under two variables is allowed by the API spec (same
      // indicator, different parameters — e.g. the same price on two dates) but
      // the server currently mis-resolves it: probed 2026-08-03, ALL such
      // bindings are answered from the EARLIEST date among them, that single
      // value lands in the first of their columns and the rest come back null.
      // The surviving number therefore need not belong to the variable it is
      // labelled with, the matched set is equally untrustworthy, and the same
      // request returns an empty set roughly a third of the time. The CLI only
      // warns (it has a stderr channel and the capability is intended), but a
      // plausible-looking table with values attributed to the wrong variable is
      // exactly the silent-corruption class this server rejects before spending
      // credits — so reject locally until the server is fixed.
      const codeCount = new Map<string, string[]>()
      for (const binding of bindings) {
        codeCount.set(binding.indicatorCode, [...(codeCount.get(binding.indicatorCode) ?? []), binding.field])
      }
      const duplicated = [...codeCount.entries()].filter(([, fields]) => fields.length > 1)
      if (duplicated.length > 0) {
        const detail = duplicated.map(([code, fields]) => `${code}（${fields.join(" / ")}）`).join("、")
        throw new ValidationError(
          `indicatorList 把同一指标绑到了多个变量：${detail}。API 规格允许这样用（同指标不同参数），但服务端当前会把这些绑定全部按其中最早的日期取数、值落在第一列、其余列返 null——活下来的数字未必属于它标注的变量，命中的证券集合同样不可信，且约 1/3 概率整体返空（实测 2026-08-03，服务端缺陷已报后台）。请拆成多次调用，每次每个指标只绑一个变量。`,
        )
      }

      const body = {
        universe: securities,
        expression,
        // Every variable gets a date, including ones whose parameterList is empty
        // — harmless for a parameterless indicator, and one rule for the whole
        // list beats a per-indicator exception.
        indicatorList: bindings.map((binding) => {
          const parameters = binding.parameters ?? []
          return parameters.some((param) => DATE_PARAM_KEYS.has(param.paramKey))
            ? { field: binding.field, indicatorCode: binding.indicatorCode, parameters }
            : {
                field: binding.field,
                indicatorCode: binding.indicatorCode,
                parameters: [...parameters, { paramKey: "tradeDate", paramValue: args.date as string }],
              }
        }),
      }
      const data = await callMatrix(client, "indicator.screener", body)
      // Gate on the STRUCTURAL emptiness, not on `securityCodeList.length`: the
      // latter counts a missing or non-array axis as "zero matched", which would
      // hand back a clean empty table for a malformed payload and bypass every
      // shape guard below. A genuine zero-match answers with four empty arrays
      // (probed 2026-08-03), so this is strictly tighter and loses nothing. A
      // response with zero securities but a populated indicatorList falls through
      // and flattens to an empty list anyway — same output, shape still checked.
      if (isEmptyMatrix(data)) return contentResult(await buildToolContent({ list: [], total: 0 }))
      // Validate the bindings BEFORE flattening: the `field` each column came
      // back under is the only thing tying it to the filter it came from, and a
      // swapped one renders as a perfectly ordinary table.
      const missing = checkScreenerBindings(data, bindings, expression)
      const flattened = flattenCrossSection(data)
      return contentResult(
        await buildToolContent(
          flagOmitted(flattened, {
            // A security missing from a SCREENER result is one the filter
            // excluded — that is the point of screening, not a data gap. Only a
            // missing indicator COLUMN is a real omission here.
            securities: [],
            // Report the missing bindings by their indicator code, matching what
            // the caller asked for.
            indicators: missing.map((field) => bindings.find((binding) => binding.field === field)?.indicatorCode ?? field),
          }),
        ),
      )
    }),
  )
}
