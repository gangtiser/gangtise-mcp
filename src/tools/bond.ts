import { z } from "zod"
import { callPerSecurity } from "../core/batch.js"
import { ValidationError } from "../core/errors.js"
import { dateString } from "../core/dateContext.js"
import { requestUntilEmptyPage } from "../core/paginate.js"
import { CALL_LIMITS } from "../core/scheduler.js"
import { defineJsonTool, type FamilyModule, type JsonToolSpec } from "../mcp/define.js"
import { nonEmptyList, uniqueFieldList } from "../mcp/schemas.js"
import { bondEndpoints } from "./bond.endpoints.js"

// 代码格式与 fieldList 写错名的报错在 routingHint 里说一遍（本族每个工具都适用）；这里只写各工具
// 自己的：默认列、日期筛的是什么、没有数据时是占一行还是不出行。

const fieldList = (lead?: string) => uniqueFieldList(lead ? `指定返回字段，省略返回全部；${lead} 恒在最前` : "指定返回字段，省略返回全部")
const codes = (max?: number) => nonEmptyList().describe(max ? `债券代码，去重后最多 ${max} 只` : "债券代码")
const issuerNames = nonEmptyList().describe("发行人全称或简称，模糊匹配，每个名称只取最匹配的一家")
const RATING_SUFFIX = "评级值可能紧跟小写后缀 sf / pi（如 AAApi），按档位比较或统计前先识别"
const WINDOW_START = "startDate 早于账号可回溯的下界时整批报 110003（不会只返回窗口内那段），把起点往后挪再查"
/** 行情与估值的数据起点可能晚于账号窗口：跨过它不报错，只是序列从有数据的那天开始。 */
const DATA_START = "数据起点可能晚于账号窗口：区间整段早于数据起点返回 0 行，跨过时从有数据的那天起返回、不报错——取长序列时核对首行日期"
/** 零行的真因与股票工具不同，通用提示里的股票代码示例会把排查引错方向。 */
const EMPTY_HINT = "0 行结果：该条件下没有数据（如区间内全是非交易日、区间早于数据起点、没有发行计划，或品种本身没有这类数据——国债没有评级与行权数据）；代码须是带后缀的标准代码（019742.SH / 220205.IB）。"

/** 评级两个端点每次最多 10 只：超过时按 10 只一批并发请求（计费按条 / 按只，与手动分批相同），
 *  一次调用最多拆成单次调用上限那么多批。 */
const RATING_BATCH = 10
const RATING_MAX = RATING_BATCH * CALL_LIMITS.maxShards

/** 超过一批时拆开请求、按传入顺序合并。合并靠 securityCode 还原顺序：评级一览没有恒在最前的列，
 *  fieldList 没点它时补在最前；评级变动的 securityCode 恒在最前，不用补。 */
function inRatingBatches(addCode: boolean): NonNullable<JsonToolSpec["call"]> {
  return (client, endpointKey, body) => {
    const codes = body.securityList as string[]
    if (codes.length <= RATING_BATCH) return client.call(endpointKey, body)
    const fields = body.fieldList as string[] | undefined
    const base = addCode && fields && !fields.includes("securityCode") ? { ...body, fieldList: ["securityCode", ...fields] } : body
    return callPerSecurity(client, endpointKey, codes, (group) => ({ ...base, securityList: group }), Number.POSITIVE_INFINITY, RATING_BATCH)
  }
}

/** 服务端按去重后的只数计上限，重复的代码去掉再发。 */
function uniqueCodes(body: Record<string, unknown>, max?: number): Record<string, unknown> {
  const unique = [...new Set(body.securityList as string[])]
  if (max && unique.length > max) throw new ValidationError(`去重后 ${unique.length} 只债券，本工具每次最多 ${max} 只：请分批查询。`)
  return { ...body, securityList: unique }
}

/** securityList（按债券找主体）与 issuerNameList（按名称）二选一；两个都传服务端报 100003。 */
function issuerSelector(body: Record<string, unknown>): Record<string, unknown> {
  const bySecurity = body.securityList !== undefined
  const byName = body.issuerNameList !== undefined
  if (bySecurity === byName) throw new ValidationError(bySecurity ? "securityList 与 issuerNameList 只能传一个：按债券代码或按发行人名称查。" : "请传 securityList（债券代码）或 issuerNameList（发行人名称）其中一个。")
  return bySecurity ? uniqueCodes(body) : body
}

const rangeSpec = (name: string, tier: JsonToolSpec["tier"], endpointKey: string, description: string, lead: string, max?: number): JsonToolSpec => ({
  name,
  tier,
  description,
  endpointKey,
  inputSchema: { securityList: codes(max), startDate: dateString.optional(), endDate: dateString.optional(), fieldList: fieldList(lead) },
  transformBody: (body) => uniqueCodes(body, max),
})
const BATCHED = `超过 ${RATING_BATCH} 只时按 ${RATING_BATCH} 只一批请求、按传入顺序合并`

const specs: JsonToolSpec[] = [
  {
    name: "gangtise_bond_basic_info",
    tier: "core",
    description: "查询债券基本资料（静态档案，无历史快照）：发行、期限、票息、评级、担保、特殊条款，ABS / 可转债另有专项字段。每个代码固定一行，库中没有的除代码外全为 null。parValue、issuePriceOrReferenceYield 是「/」分隔的展示值，要数值用 latestParValue；剩余期限按 actualMaturityDate（含提前赎回 / 回售 / 转股）算。",
    endpointKey: "bond.basic-info",
    inputSchema: { securityList: codes(10_000), fieldList: fieldList("securityCode") },
    transformBody: (body) => uniqueCodes(body, 10_000),
  },
  {
    name: "gangtise_bond_daily_quote",
    tier: "core",
    description: `查询债券日收盘行情（交易所 + 银行间）：全价、净价、到期收益率、成交、久期、凸性。没有数据的代码不产生行。${WINDOW_START}；${DATA_START}。`,
    endpointKey: "bond.daily-quote",
    inputSchema: { securityList: codes(), startDate: dateString, endDate: dateString, fieldList: fieldList("securityCode / tradeDate") },
    transformBody: (body) => uniqueCodes(body),
  },
  {
    name: "gangtise_bond_valuation",
    tier: "core",
    description: `查询上清所债券估值：估值价格、收益率、久期、凸性、基点价值（利率与利差各一套）。confidenceLevel 省略时只返回「推荐」的估值，要「不推荐」的另传一次。没有数据的代码不产生行。${WINDOW_START}；${DATA_START}。`,
    endpointKey: "bond.valuation",
    inputSchema: {
      securityList: codes(),
      startDate: dateString,
      endDate: dateString,
      confidenceLevel: z.enum(["推荐", "不推荐"]).optional(),
      fieldList: fieldList("securityCode / tradeDate / confidenceLevel"),
    },
    transformBody: (body) => uniqueCodes(body),
  },
  rangeSpec("gangtise_bond_cash_flow", "core", "bond.cash-flow", "查询债券付息与兑付计划。startDate / endDate 筛兑付日，省略返回全部。没有数据的代码不产生行。", "securityCode / paymentDate"),
  {
    name: "gangtise_bond_rating_overview",
    tier: "core",
    description: `并列查询债项、发行人、担保人三套评级（${BATCHED}，fieldList 自动补 securityCode）。每个代码固定一行，没有数据的除代码外全为 null、不计费；国债本身没有评级。${RATING_SUFFIX}，否则 AAA 与 AAApi 会被当成两档。`,
    endpointKey: "bond.rating-overview",
    inputSchema: { securityList: codes(RATING_MAX), fieldList: fieldList() },
    transformBody: (body) => uniqueCodes(body, RATING_MAX),
    call: inRatingBatches(true),
  },
  {
    name: "gangtise_bond_announcement_list",
    tier: "core",
    description: "查询债券公告。没有 total：fetchAll=true 从 pageNo 起自动翻到空页（pageSize 缺省 200，末尾可能多计几个空页）；手动翻页时 pageNo 递增到空页为止，批量传 pageSize=200。每页按次计费。securityList 与日期区间二选一。按日期查时，不对应已上市证券的公告与部分新发行债券的发行文件 securityCode 为空。",
    endpointKey: "bond.announcement",
    inputSchema: {
      securityList: codes().optional(),
      startDate: dateString.optional(),
      endDate: dateString.optional(),
      pageNo: z.number().int().min(1).optional().describe("默认 1"),
      pageSize: z.number().int().min(1).max(200).optional().describe("默认 50"),
      fetchAll: z.boolean().optional(),
      fieldList: fieldList("announcementDate / securityCode"),
    },
    transformBody: (body) => {
      const byDate = body.startDate !== undefined || body.endDate !== undefined
      if (body.securityList !== undefined && byDate) throw new ValidationError("securityList 与 startDate / endDate 只能传一种：按债券代码或按公告日期区间查。")
      if (body.securityList === undefined && !byDate) throw new ValidationError("请传 securityList（债券代码）或 startDate / endDate（公告日期区间）其中一种。")
      return { pageNo: 1, pageSize: 50, ...(body.securityList === undefined ? body : uniqueCodes(body)) }
    },
    call: (client, endpointKey, body, args) =>
      args.fetchAll === true ? requestUntilEmptyPage(client, endpointKey, args.pageSize === undefined ? { ...body, pageSize: 200 } : body) : client.call(endpointKey, body),
  },
  {
    name: "gangtise_bond_issuer_info",
    tier: "core",
    description: "查询发债主体资料：企业性质、行业、注册信息、主体评级、存续债券。securityList（按债券找主体）与 issuerNameList 二选一；按 securityList 查时每个代码固定一行、没有的除代码外全为 null，按名称匹配不到则不产生行。行业有 swIndustry（申万）与 nationalIndustry（国民经济行业）两套。latestIssuerRating 形如「AAA(维持,2026-08-11)」但括号可能缺省；⚠️ 这一列混合境内外评级口径、不可直接比较，排序或筛选前一并取 ratingAgency。outstandingBondList 是存续债简称串，要代码用 gangtise_securities_search 换。",
    endpointKey: "bond.issuer-info",
    inputSchema: { securityList: codes().optional(), issuerNameList: issuerNames.optional(), fieldList: fieldList("issuerName") },
    transformBody: issuerSelector,
  },
  {
    ...rangeSpec("gangtise_bond_rating_change", "core", "bond.rating-change", `查询债项评级变动：本次 / 上次评级、方向、展望、评级类型与机构（${BATCHED}）。startDate / endDate 筛公告日，省略返回全部。每次变动一行，首次评级的 previousRating 为 null；没有数据的代码不产生行、不计费，国债没有评级。${RATING_SUFFIX}。`, "securityCode / announcementDate", RATING_MAX),
    call: inRatingBatches(false),
  },
  {
    name: "gangtise_bond_issuer_rating_change",
    tier: "core",
    description: `查询发债主体评级变动。securityList 与 issuerNameList 二选一；一次命中的发行人超过 10 个报 100006，缩小名单再查。startDate / endDate 筛公告日，省略返回全部。${RATING_SUFFIX}。`,
    endpointKey: "bond.issuer-rating-change",
    inputSchema: { securityList: codes().optional(), issuerNameList: issuerNames.optional(), startDate: dateString.optional(), endDate: dateString.optional(), fieldList: fieldList("issuerName / announcementDate") },
    transformBody: issuerSelector,
  },
  rangeSpec("gangtise_bond_issuance_detail", "extended", "bond.issuance-detail", "查询债券发行与续发记录：招投标、定价、认购倍数。startDate / endDate 筛发行公告日，省略返回全部。没有数据的代码不产生行。", "securityCode / issueBatchNo"),
  {
    name: "gangtise_bond_issuance_plan",
    tier: "extended",
    description: `查询利率债发行计划：发行人、品种、期限、计划发行量、利率类型、付息频率。只按日期区间查，不收债券码。${WINDOW_START}。`,
    endpointKey: "bond.issuance-plan",
    inputSchema: { startDate: dateString, endDate: dateString, fieldList: fieldList("issueDate") },
  },
  rangeSpec("gangtise_bond_exercise_notice", "extended", "bond.exercise-notice", "查询含权债的回售 / 赎回行权安排与结果。startDate / endDate 筛行权日，省略返回全部。没有数据的代码不产生行，国债没有行权数据。", "securityCode / exerciseDate"),
]

export const bondFamily: FamilyModule = {
  name: "bond",
  routingHint: "债券：bond_* 只收标准代码（019742.SH / 220205.IB），简称先 gangtise_securities_search 换；fieldList 写错名整批报 100003。",
  endpoints: bondEndpoints,
  tools: specs.map((spec) => defineJsonTool({ ...spec, emptyHint: EMPTY_HINT })),
}
