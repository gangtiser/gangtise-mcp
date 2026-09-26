import { z } from "zod"
import { assertDateOrder, defineJsonTool, defineTool, type FamilyModule, type JsonToolSpec } from "../mcp/define.js"
import { buildToolContent } from "../core/present.js"
import { contentResult } from "../mcp/handler.js"
import { normalizeRows } from "../core/normalize.js"
import { markPartial } from "../core/partial.js"
import { dateString } from "../core/dateContext.js"
import { nonEmptyString, uniqueFieldList, enumList } from "../mcp/schemas.js"
import { fundamentalEndpoints } from "./fundamental.endpoints.js"

const periodEnum = enumList(z.enum(["q1", "interim", "q3", "annual", "latest"])).optional().describe("q1=一季报 | interim=中报 | q3=三季报 | annual=年报 | latest=最新")
const quarterlyPeriodEnum = enumList(z.enum(["q1", "q2", "q3", "q4", "latest"])).optional().describe("q1 | q2 | q3 | q4 | latest")
const hkPeriodEnum = enumList(z.enum(["q1", "h1", "q3", "h2", "nsd", "annual", "latest"])).optional().describe("q1 | h1=中报 | q3 | h2=下半年报 | nsd=不规则跨度 | annual=年报 | latest")
const usPeriodEnum = enumList(z.enum(["q1", "h1", "q3", "nsd", "annual", "latest"])).optional().describe("q1 | h1=中报 | q3 | nsd=不规则跨度 | annual=年报 | latest")
// 口径表由 server.instructions 的「通用参数」行统一声明（11 处共用）。别在这里加回描述。
const reportTypeEnum = enumList(z.enum(["consolidated", "consolidatedRestated", "standalone", "standaloneRestated"])).optional()
const securityCode = nonEmptyString.describe("证券代码，如 '600519.SH'")
const securityCodeHk = nonEmptyString.describe("证券代码，如 '00700.HK'（5 位数字前补零）")
const securityCodeUs = nonEmptyString.describe("证券代码，如 'TSLA.O'（.O=NASDAQ / .N=NYSE / .A=AMEX）")
const dateRange = {
  startDate: dateString.optional(),
  endDate: dateString.optional(),
}
const fiscalYear = enumList(z.number().int()).optional().describe("财年列表，如 [2023, 2024]")
const fieldList = uniqueFieldList("指定返回字段")
// 实测 2026-07-26：valuation-analysis 全表就 7 列，且**没有 securityCode**。
// 两个坑，都只能在 schema 层挡：
//  1. 传不存在的字段名（如 securityCode），上游把相邻列的值复制进该槽位、**字段数与
//     行长仍然相等**——请求 ['securityCode','tradeDate','value'] 实到
//     ['2026-07-20','2026-07-20',20.06]，securityCode 拿到的是日期。等长错列
//     normalize 的长度校验发现不了，静默返错值。
//  2. tradeDate **总是自动前置**到每一行：显式请求它会让值多一个而字段名不多
//     （请求 ['tradeDate','value'] → 2 名 3 值），反而把长度校验撞红。
// 所以可选字段是**除 tradeDate 外的 6 个**；tradeDate 无论传不传都会返回。
// 收 z.enum 而不是只写进 describe：描述只是建议，schema 才会拒（同 0.1.38 对
// categoryList 收 z.enum 的理由，且这里后果更重——那边静默返全量，这边静默返错值）。
const VALUATION_FIELD_NAMES = ["value", "percentileRank", "average", "median", "upper1Std", "lower1Std"] as const
const valuationFieldList = z
  .array(z.enum(VALUATION_FIELD_NAMES))
  .min(1, "fieldList 不能为空数组：要投影字段就至少给一个，要全量就省略该参数")
  .refine((v) => new Set(v).size === v.length, "fieldList 不能重复：同名字段在按位置拍平时会相互覆盖，导致静默少一列")
  .optional()
  .describe(`指定返回字段，只认这 6 个：${VALUATION_FIELD_NAMES.join(" / ")}。tradeDate 总是自动返回、**不要传**（传了会让响应长度对不上而报错）；本接口也没有 securityCode。不确定就不传（=返回全部 7 列，最稳）`)
// 实测 2026-07-26：主营接口固定前置 periodName/periodEndDate，传错字段名会导致
// 字段数比行长多 1（回显 5 个名、只给 4 个值），normalize 会直接报错拒绝 —— 不会
// 静默错列，但错的字段名等于白跑一次，同样收成闭集在本地就拒。
const MAIN_BUSINESS_FIELD_NAMES = [
  "periodName", "periodEndDate", "categoryName",
  "opRevenue", "opRevenueYoy", "opRevenueRatio",
  "opCost", "opCostYoy", "opCostRatio",
  "grossProfit", "grossProfitYoy", "grossProfitRatio",
  "grossMargin", "grossMarginYoy", "grossMarginRatio",
] as const
const mainBusinessFieldList = z
  .array(z.enum(MAIN_BUSINESS_FIELD_NAMES))
  .min(1, "fieldList 不能为空数组：要投影字段就至少给一个，要全量就省略该参数")
  .refine((v) => new Set(v).size === v.length, "fieldList 不能重复：同名字段在按位置拍平时会相互覆盖，导致静默少一列")
  .optional()
  .describe(`指定返回字段，只认这 15 个主营字段：${MAIN_BUSINESS_FIELD_NAMES.join(" / ")}。不确定就不传`)
/** 估值序列每个自然日一行（含周末）、升序。limit 显式下发：省略时服务端按同一个默认值截断，
 *  且保留的是**最近**的行——十年区间会静默只剩最后 2000 天，看起来像一份完整序列。 */
const VALUATION_DEFAULT_LIMIT = 2000

/** 估值序列的完整性判定。
 *
 *  - 行数撞满 limit 且首行不是 startDate → 区间开头被截掉了，标 `limit_truncated`。首行恰好是
 *    startDate 时说明一行没少（区间正好 limit 天），不标。
 *  - 没撞满、首行却晚于 startDate → 服务端自己晚开始：之后才上市，或区间超出了账号的历史窗口
 *    （本接口对窗口外的部分直接不返回、不报错）。不是截断，只加一句说明。 */
function flagValuationRange(normalized: unknown, limit: number, startDate: unknown): unknown {
  const rec = Array.isArray(normalized) ? { list: normalized } : normalized
  if (!rec || typeof rec !== "object") return normalized
  const list = (rec as { list?: unknown }).list
  if (!Array.isArray(list)) return normalized
  const first = list[0] as Record<string, unknown> | undefined
  const firstDate = typeof first?.tradeDate === "string" ? first.tradeDate : undefined
  const start = typeof startDate === "string" ? startDate : undefined
  if (list.length >= limit && !(start && firstDate === start)) {
    return markPartial(rec as Record<string, unknown>, "limit_truncated", {
      _hint: `返回行数撞满 limit（${limit}）：本接口每个自然日一行（含周末），超出时保留最近的行，缺的是区间开头${firstDate ? `（本次从 ${firstDate} 开始）` : ""}。把 limit 调到区间天数以上（一年约 366 行），或把 startDate 往后挪。`,
    })
  }
  if (start && firstDate && firstDate > start) {
    return { ...rec, _note: `序列从 ${firstDate} 开始，晚于 startDate ${start}：可能是之后才上市，或区间超出了账号可取的历史窗口——本接口只返回窗口内的部分，不报错。` }
  }
  return rec
}

// 报表里有两个披露日字段，取值可能不同，而选错的后果是 point-in-time 校验得出相反结论
// （拿一个晚得多的日期去回溯，等于把未来信息当成当时可见）。这不是普遍现象、是个股级的，
// 所以只能靠字段选择规避，没法靠「换只票验一下」发现——茅台两个字段一致，用它当探针
// 什么也测不出来。
const PIT_NOTE = "做 point-in-time / 时点对齐时，announcementDate 是当前返回报表版本的公告日，earliestAnncDate 是接口记录的首次公告日。consolidated 也可能返回后来重述的数值，不能把它配上 earliestAnncDate 就当成首次披露值；category 仍可能是一季报/半年报告/三季报，不能靠它排除重述。应按返回版本的公告日控制数值可见时间；需要首次披露的原始数值时，请核对当时公告。"

export const specs: JsonToolSpec[] = [
  {
    name: "gangtise_income_statement",
    tier: "core",
    description: `查询A股利润表（累计口径），支持期间、财年、报告类型筛选。${PIT_NOTE}`,
    endpointKey: "fundamental.income-statement",
    paginated: false,
    inputSchema: {
      securityCode,
      ...dateRange,
      fiscalYear,
      period: periodEnum,
      reportType: reportTypeEnum,
      fieldList,
    },
    examples: [
      { title: "A 股累计", args: { securityCode: "600519.SH", fiscalYear: [2024, 2025], period: ["annual"], reportType: ["consolidated"], fieldList: ["announcementDate", "opRevenue"] }, expect: { requests: [{ method: "POST", path: "/application/open-fundamental/financial-report/income-statement/accumulated", body: { securityCode: "600519.SH", fiscalYear: [2024, 2025], period: ["annual"], reportType: ["consolidated"], fieldList: ["announcementDate", "opRevenue"] } }] } },
      { title: "港股期间 h1 本地拒绝", args: { securityCode: "600519.SH", period: ["h1"] }, expect: { rejects: /at period/ } },
    ],
  },
  {
    name: "gangtise_income_statement_quarterly",
    tier: "core",
    description: `查询A股单季利润表。${PIT_NOTE}本工具的 companyType 返回的是未映射的数字码，要读公司类型请取累计口径报表的同名字段。`,
    endpointKey: "fundamental.income-statement-quarterly",
    paginated: false,
    inputSchema: {
      securityCode,
      ...dateRange,
      fiscalYear,
      period: quarterlyPeriodEnum,
      reportType: reportTypeEnum,
      fieldList,
    },
    examples: [
      { title: "A 股单季", args: { securityCode: "600519.SH", period: ["q2"], startDate: "2024-01-01", endDate: "2025-12-31" }, expect: { requests: [{ method: "POST", path: "/application/open-fundamental/financial-report/income-statement/quarterly", body: { securityCode: "600519.SH", startDate: "2024-01-01", endDate: "2025-12-31", period: ["q2"] } }] } },
    ],
  },
  {
    name: "gangtise_balance_sheet",
    tier: "core",
    description: `查询A股资产负债表，支持期间、财年、报告类型筛选。${PIT_NOTE}`,
    endpointKey: "fundamental.balance-sheet",
    paginated: false,
    inputSchema: {
      securityCode,
      ...dateRange,
      fiscalYear,
      period: periodEnum,
      reportType: reportTypeEnum,
      fieldList,
    },
    examples: [
      { title: "A 股", args: { securityCode: "600519.SH", period: ["interim"], reportType: ["standalone"] }, expect: { requests: [{ method: "POST", path: "/application/open-fundamental/financial-report/balance-sheet/accumulated", body: { securityCode: "600519.SH", period: ["interim"], reportType: ["standalone"] } }] } },
    ],
  },
  {
    name: "gangtise_cash_flow",
    tier: "core",
    description: `查询A股现金流量表（累计口径），支持期间、财年、报告类型筛选。${PIT_NOTE}`,
    endpointKey: "fundamental.cash-flow",
    paginated: false,
    inputSchema: {
      securityCode,
      ...dateRange,
      fiscalYear,
      period: periodEnum,
      reportType: reportTypeEnum,
      fieldList,
    },
    examples: [
      { title: "A 股累计", args: { securityCode: "600519.SH", fiscalYear: [2025], period: ["q3"] }, expect: { requests: [{ method: "POST", path: "/application/open-fundamental/financial-report/cash-flow-statement/accumulated", body: { securityCode: "600519.SH", fiscalYear: [2025], period: ["q3"] } }] } },
    ],
  },
  {
    name: "gangtise_cash_flow_quarterly",
    tier: "core",
    description: `查询A股单季现金流量表。${PIT_NOTE}本工具的 companyType 返回的是未映射的数字码，要读公司类型请取累计口径报表的同名字段。`,
    endpointKey: "fundamental.cash-flow-quarterly",
    paginated: false,
    inputSchema: {
      securityCode,
      ...dateRange,
      fiscalYear,
      period: quarterlyPeriodEnum,
      reportType: reportTypeEnum,
      fieldList,
    },
    examples: [
      { title: "A 股单季", args: { securityCode: "600519.SH", period: ["q4", "latest"] }, expect: { requests: [{ method: "POST", path: "/application/open-fundamental/financial-report/cash-flow-statement/quarterly", body: { securityCode: "600519.SH", period: ["q4", "latest"] } }] } },
    ],
  },
  {
    name: "gangtise_main_business",
    tier: "core",
    description: "查询主营业务构成（按产品、行业或地区拆分）。",
    endpointKey: "fundamental.main-business",
    paginated: false,
    inputSchema: {
      securityCode,
      breakdown: z.enum(["product", "industry", "region"]).describe("product=产品 | industry=行业 | region=地区（必填）"),
      ...dateRange,
      periodList: enumList(z.enum(["interim", "annual"])).optional().describe("interim=中报 | annual=年报"),
      fieldList: mainBusinessFieldList,
    },
    examples: [
      { title: "按产品", args: { securityCode: "600519.SH", breakdown: "product", periodList: ["annual"], fieldList: ["periodName", "opRevenue"] }, expect: { requests: [{ method: "POST", path: "/application/open-fundamental/main-business", body: { securityCode: "600519.SH", breakdown: "product", periodList: ["annual"], fieldList: ["periodName", "opRevenue"] } }] } },
    ],
  },
  {
    name: "gangtise_top_holders",
    tier: "core",
    description: "查询前十大股东或前十大流通股东。",
    endpointKey: "fundamental.top-holders",
    paginated: false,
    inputSchema: {
      securityCode,
      holderType: z.enum(["top10", "top10Float"]).describe("top10=前十大股东 | top10Float=前十大流通股东（必填）"),
      ...dateRange,
      fiscalYear,
      period: periodEnum,
    },
    examples: [
      { title: "前十大股东", args: { securityCode: "600519.SH", holderType: "top10", fiscalYear: [2025], period: ["interim"] }, expect: { requests: [{ method: "POST", path: "/application/open-fundamental/capital-structure/top-holders", body: { securityCode: "600519.SH", holderType: "top10", fiscalYear: [2025], period: ["interim"] } }] } },
    ],
  },
  {
    name: "gangtise_earning_forecast",
    tier: "core",
    description: "查询盈利预测一致预期（EPS、PE、净利润、ROE 等）。roe 的单位是百分比（35.6 即 35.6%），不要再做 ÷100 换算——换算后的数字看着仍像个 ROE，不会报错。",
    endpointKey: "fundamental.earning-forecast",
    paginated: false,
    inputSchema: {
      securityCode,
      ...dateRange,
      consensusList: enumList(z.enum(["netIncome", "netIncomeYoy", "eps", "pe", "bps", "pb", "peg", "roe", "ps"])).optional().describe("netIncome=净利润 | netIncomeYoy=净利润增速 | eps | pe | bps | pb | peg | roe | ps"),
    },
    examples: [
      { title: "一致预期", args: { securityCode: "600519.SH", consensusList: ["eps", "pe"], startDate: "2026-01-01", endDate: "2026-09-01" }, expect: { requests: [{ method: "POST", path: "/application/open-fundamental/earning-forecast", body: { securityCode: "600519.SH", startDate: "2026-01-01", endDate: "2026-09-01", consensusList: ["eps", "pe"] } }] } },
    ],
  },
  {
    name: "gangtise_income_statement_hk",
    tier: "core",
    description: "查询港股利润表（中国会计准则），支持期间、财年、报告类型筛选。",
    endpointKey: "fundamental.income-statement-hk",
    paginated: false,
    inputSchema: {
      securityCode: securityCodeHk,
      ...dateRange,
      fiscalYear,
      period: hkPeriodEnum,
      reportType: reportTypeEnum,
      fieldList,
    },
    examples: [
      { title: "港股：reportType 照常下发", args: { securityCode: "00700.HK", period: ["h1"], reportType: ["consolidatedRestated"] }, expect: { requests: [{ method: "POST", path: "/application/open-fundamental/financial-report/income-statement/hk", body: { securityCode: "00700.HK", period: ["h1"], reportType: ["consolidatedRestated"] } }] } },
    ],
  },
  {
    name: "gangtise_balance_sheet_hk",
    tier: "core",
    description: "查询港股资产负债表（中国会计准则），支持期间、财年、报告类型筛选。",
    endpointKey: "fundamental.balance-sheet-hk",
    paginated: false,
    inputSchema: {
      securityCode: securityCodeHk,
      ...dateRange,
      fiscalYear,
      period: hkPeriodEnum,
      reportType: reportTypeEnum,
      fieldList,
    },
    examples: [
      { title: "港股", args: { securityCode: "00700.HK", period: ["annual"], reportType: ["consolidated"] }, expect: { requests: [{ method: "POST", path: "/application/open-fundamental/financial-report/balance-sheet/hk", body: { securityCode: "00700.HK", period: ["annual"], reportType: ["consolidated"] } }] } },
    ],
  },
  {
    name: "gangtise_cash_flow_hk",
    tier: "core",
    description: "查询港股现金流量表（中国会计准则），支持期间、财年、报告类型筛选。",
    endpointKey: "fundamental.cash-flow-hk",
    paginated: false,
    inputSchema: {
      securityCode: securityCodeHk,
      ...dateRange,
      fiscalYear,
      period: hkPeriodEnum,
      reportType: reportTypeEnum,
      fieldList,
    },
    examples: [
      { title: "港股", args: { securityCode: "00700.HK", period: ["h2"], fiscalYear: [2025] }, expect: { requests: [{ method: "POST", path: "/application/open-fundamental/financial-report/cash-flow-statement/hk", body: { securityCode: "00700.HK", fiscalYear: [2025], period: ["h2"] } }] } },
    ],
  },
  {
    name: "gangtise_income_statement_us",
    tier: "core",
    description: "查询美股利润表，支持期间、财年、报告类型筛选。证券代码如 'TSLA.O'。",
    endpointKey: "fundamental.income-statement-us",
    paginated: false,
    inputSchema: {
      securityCode: securityCodeUs,
      ...dateRange,
      fiscalYear,
      period: usPeriodEnum,
      reportType: reportTypeEnum,
      fieldList,
    },
    examples: [
      { title: "美股：reportType 照常下发", args: { securityCode: "TSLA.O", period: ["nsd"], reportType: ["standaloneRestated"] }, expect: { requests: [{ method: "POST", path: "/application/open-fundamental/financial-report/income-statement/us", body: { securityCode: "TSLA.O", period: ["nsd"], reportType: ["standaloneRestated"] } }] } },
    ],
  },
  {
    name: "gangtise_balance_sheet_us",
    tier: "core",
    description: "查询美股资产负债表，支持期间、财年、报告类型筛选。证券代码如 'TSLA.O'。",
    endpointKey: "fundamental.balance-sheet-us",
    paginated: false,
    inputSchema: {
      securityCode: securityCodeUs,
      ...dateRange,
      fiscalYear,
      period: usPeriodEnum,
      reportType: reportTypeEnum,
      fieldList,
    },
    examples: [
      { title: "美股", args: { securityCode: "TSLA.O", period: ["annual"], reportType: ["consolidated"] }, expect: { requests: [{ method: "POST", path: "/application/open-fundamental/financial-report/balance-sheet/us", body: { securityCode: "TSLA.O", period: ["annual"], reportType: ["consolidated"] } }] } },
    ],
  },
  {
    name: "gangtise_cash_flow_us",
    tier: "core",
    description: "查询美股现金流量表，支持期间、财年、报告类型筛选。证券代码如 'TSLA.O'。",
    endpointKey: "fundamental.cash-flow-us",
    paginated: false,
    inputSchema: {
      securityCode: securityCodeUs,
      ...dateRange,
      fiscalYear,
      period: usPeriodEnum,
      reportType: reportTypeEnum,
      fieldList,
    },
    examples: [
      { title: "美股", args: { securityCode: "TSLA.O", period: ["q1"], fieldList: ["announcementDate"] }, expect: { requests: [{ method: "POST", path: "/application/open-fundamental/financial-report/cash-flow-statement/us", body: { securityCode: "TSLA.O", period: ["q1"], fieldList: ["announcementDate"] } }] } },
    ],
  },
]

export const fundamentalFamily: FamilyModule = {
  name: "fundamental",
  endpoints: fundamentalEndpoints,
  tools: [
    ...specs.map(defineJsonTool),
    defineTool({
      name: "gangtise_valuation_analysis",
      tier: "core",
      access: "read",
      endpoint: "fundamental.valuation-analysis",
      description: "查询估值指标及历史分位数，支持 PE、PB、PEG、PS、PCF、EM。",
      input: {
        securityCode,
        indicator: z.enum(["peTtm", "pbMrq", "peg", "psTtm", "pcfTtm", "em"]).describe("peTtm | pbMrq | peg | psTtm | pcfTtm | em（必填）"),
        ...dateRange,
        limit: z.number().int().min(1).optional().describe("最大返回行数（默认 2000）。每个自然日一行（含周末），超出时保留最近的行、丢掉区间开头，撞满标 _partial"),
        skipNull: z.boolean().optional().describe("过滤掉 value 或 percentileRank 为空的行（客户端后处理；传了 fieldList 时只按其中请求到的那几列判空）"),
        fieldList: valuationFieldList,
      },
      run: async ({ client }, args) => {
        assertDateOrder(args)
        const { skipNull, ...rest } = args
        const limit = (rest.limit as number | undefined) ?? VALUATION_DEFAULT_LIMIT
        const body: Record<string, unknown> = { ...rest, limit }
        const raw = await client.call("fundamental.valuation-analysis", body)
        // 截断判定在 skipNull 之前：过滤掉空值行之后行数就不再能说明撞没撞满。
        const normalized = flagValuationRange(normalizeRows(raw), limit, rest.startDate)
        let result: unknown = normalized
        // 只按**请求到的**列判空。fieldList 投影掉 percentileRank 时那一列在行里根本不存在，
        // 把「没查」当「为空」会把一份正常数据整个过滤成零行且不报错。
        const requested = Array.isArray(body.fieldList) ? new Set(body.fieldList as string[]) : undefined
        const nullKeys = ["value", "percentileRank"].filter((key) => !requested || requested.has(key))
        if (skipNull && nullKeys.length > 0 && normalized && typeof normalized === "object" && !Array.isArray(normalized)) {
          const rec = normalized as Record<string, unknown>
          if (Array.isArray(rec.list)) {
            const filtered = rec.list.filter((row): row is Record<string, unknown> => {
              if (!row || typeof row !== "object") return false
              const r = row as Record<string, unknown>
              return nullKeys.every((key) => r[key] != null)
            })
            result = { ...rec, list: filtered, total: filtered.length }
          }
        }
        return contentResult(await buildToolContent(result))
      },
      examples: [
        { title: "skipNull 不进 body；limit 缺省时显式发 2000", args: { securityCode: "600519.SH", indicator: "peTtm", startDate: "2021-01-01", endDate: "2026-09-01", skipNull: true }, expect: { requests: [{ method: "POST", path: "/application/open-fundamental/valuation-analysis", body: { securityCode: "600519.SH", indicator: "peTtm", startDate: "2021-01-01", endDate: "2026-09-01", limit: 2000 } }] } },
        { title: "显式 limit 原样下发", args: { securityCode: "600519.SH", indicator: "pbMrq", startDate: "2016-01-01", endDate: "2026-09-01", limit: 3900 }, expect: { requests: [{ method: "POST", path: "/application/open-fundamental/valuation-analysis", body: { securityCode: "600519.SH", indicator: "pbMrq", startDate: "2016-01-01", endDate: "2026-09-01", limit: 3900 } }] } },
        { title: "fieldList 不收 tradeDate", args: { securityCode: "600519.SH", indicator: "pbMrq", fieldList: ["tradeDate", "value"] }, expect: { rejects: /at fieldList/ } },
      ],
    }),
  ],
}
