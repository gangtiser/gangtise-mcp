import { z } from "zod"
import { flagMissingFields, normalizeRows } from "../core/normalize.js"
import { ValidationError } from "../core/errors.js"
import { callKlinePerSecurity, callKlineWithSharding, estimateTradingDays, flagLimitTruncated, fullMarketOf, type BatchStrategy, type KlineBody } from "../core/batch.js"
import { dateString, dateTimeString } from "../core/dateContext.js"
import { parseSecurityCode, type Market } from "../core/securityCode.js"
import { assertDateOrder, defineTool, type FamilyModule, type ToolSpec } from "../mcp/define.js"
import { buildToolContent } from "../core/present.js"
import { contentResult } from "../mcp/handler.js"
import { oneQuoteRow } from "../mcp/examples.js"
import { MARKET_KEYWORDS, matchesKeyword, nonEmptyString, nonEmptyList, uniqueFieldList } from "../mcp/schemas.js"
import { quoteEndpoints } from "./quote.endpoints.js"


/** Upstream default per-request row cap on the limit-capped quote endpoints
 * (explicit-security day/index/minute kline + fund-flow). Used to flag
 * single-request truncation — mirrors CLI DEFAULT_QUOTE_LIMIT. */
const DEFAULT_QUOTE_LIMIT = 6000

const securityDesc = (codeHelp: string, keywordHelp: string) =>
  `${codeHelp}；${keywordHelp}拉取全市场（关键字须单独传，不能与证券代码或另一个关键字混传；须同时提供 startDate 和 endDate——只给一个日期时，全市场查询会因规模过大而报错或被截断，按接口而异）`

/** 市场专用工具各自的 security 说明。示例必须用**本工具真正收的代码**——它们带市场校验，
 * 共用一套 A 股示例时，照着参数说明写会被本地直接拒掉。 */
const marketSecurity = (codeHelp: string) =>
  z.union([nonEmptyString, nonEmptyList()]).optional().describe(securityDesc(codeHelp, "传 'all' "))

/** 两个已被 `gangtise_day_kline` 覆盖的旧工具用它。字段行为与 day_kline 逐字相同，
 *  在这里再写一遍只是把同一段话在 tools/list 里多付两遍——它们的描述本来就写着「改用
 *  gangtise_day_kline」，指过去即可。 */
const legacyFieldList = uniqueFieldList("指定返回字段；行为与 gangtise_day_kline 的同名参数一致，说明见该工具")

/** 行情类接口对不认识的字段名是名和值一起丢，且 `fieldList` 只回点名的列。两件事都要说：
 *  身份列不会自动附带（多只查询的行否则无法归属），写错的列名不报错（去看 `missingFields`）。
 *  ⚠️ 写得**紧**是有原因的：这段会随 `commonKlineSchema` 复制到 6 个工具的 schema 里，
 *  每多一句就在 tools/list 里付 6 遍（发版门禁 ⑤ 的句级重复上限盯着这一项）。 */
const FIELD_LIST_NOTE = (identity: string) =>
  `只回点名的列，身份列（${identity}）要自己写进来；名字写错不报错、只少一列并标 missingFields，不确定就不传（=全量最稳）`

/** 🔴 有意**不含** `security`——每个 K 线工具必须自己声明，用本市场真正收的代码做示例。
 * 放一个通用的进来就等于给下一个市场工具准备好了一个别的市场的示例，而那是静默错误
 * （港股/美股工具本地拒收、指数工具静默返空）。少了它，忘写的人第一次调用就会发现。 */
const commonKlineSchema = {
  startDate: dateString.optional(),
  endDate: dateString.optional(),
  limit: z.number().int().min(1).max(10_000).optional().describe("单次请求最大返回行数（默认 6000，最大 10000）。截取从查询窗口开头开始——取「最近 N 条」须传日期区间而非只传 limit；分片 / 逐只拉取时作用于每一份，撞上限的会标 _partial"),
  fieldList: uniqueFieldList(`指定返回字段，如 ['securityCode','tradeDate','open','close','pctChange']。${FIELD_LIST_NOTE("securityCode / tradeDate")}`),
}

/** Reject a whole-market keyword this tool does not take, or one sent alongside other
 * securities, before the request goes out. Report the unsupported keyword first: when
 * both rules are broken, the keyword itself is what the caller has to change.
 *
 * Both failure modes are worth catching locally because neither is legible upstream:
 * the unified day K-line / realtime / fund-flow answer `120001「证券代码无效」`, which
 * sends the caller hunting for a typo in a code that is fine, while the market-specific
 * day K-line endpoints answer `total: 0` — an empty result indistinguishable from "no
 * data". On fund flow the mixed case is worse than a rejection: the keyword is silently
 * dropped and only the explicit codes come back.
 *
 * 🔴 Comparing lower-cased (via `matchesKeyword`) is load-bearing, not tidiness — but
 * the reason is **local**, not server-side. `resolveFullMarket` matches the keyword by
 * EXACT string against the shard-size table, so an un-canonicalised `ashares` is not
 * recognised as whole-market at all: the request degrades to one unsharded call
 * (silently capped for day K-line, a hard error for fund flow) instead of a day-by-day
 * fan-out. Canonicalising keeps that lookup in step with what the caller typed.
 *
 * ⚠️ It is NOT needed to satisfy the server: fund flow folds case like its siblings —
 * `aShares` / `ashares` / `ASHARES` / `AShares` return byte-identical rows, while a
 * keyword that is merely misspelt (`aSharez`) is rejected with `120001 非有效A股`. Do
 * not restate the old claim that this endpoint takes only the literal `aShares`; that
 * error code belongs to a wrong keyword, not to a case variant. Pinned in quote.test.ts. */
function assertMarketKeywords(securityList: readonly unknown[] | undefined, accepted: readonly string[], tool: string, noKeywordReason?: string): void {
  if (!securityList) return
  const codes = securityList.filter((s): s is string => typeof s === "string")
  const used = codes.filter((s) => MARKET_KEYWORDS.has(s.toLowerCase()))
  if (used.length === 0) return
  if (accepted.length === 0) {
    throw new ValidationError(`${tool} 没有全市场关键字（传了 '${used[0]}'）：${noKeywordReason ?? "请逐个传证券代码。"}`)
  }
  const unsupported = used.filter((k) => !accepted.some((a) => matchesKeyword(k, a)))
  if (unsupported.length > 0) {
    throw new ValidationError(`'${unsupported[0]}' 不是 ${tool} 的全市场关键字，请改用 ${accepted.join(" / ")}。`)
  }
  if (securityList.length > 1) {
    throw new ValidationError(`全市场关键字必须单独传，当前传了 '${codes.join(", ")}'：查全市场只传关键字，否则只传具体代码。`)
  }
}

/** Fold a caller-typed keyword back to the spelling the endpoint and the shard lookup
 * expect. Non-keywords pass through untouched. */
function canonicalizeKeywords(securityList: string[] | undefined, accepted: readonly string[]): string[] | undefined {
  if (!securityList) return securityList
  return securityList.map((s) => (typeof s === "string" ? accepted.find((a) => matchesKeyword(s, a)) ?? s : s))
}

function buildKlineBody(args: Record<string, unknown>): KlineBody {
  const body: KlineBody = {}
  if (args.security) {
    body.securityList = Array.isArray(args.security) ? args.security : [args.security as string]
  }
  if (args.startDate) body.startDate = args.startDate as string
  if (args.endDate) body.endDate = args.endDate as string
  if (args.limit !== undefined) body.limit = args.limit as number
  if (args.fieldList) body.fieldList = args.fieldList as string[]
  return body
}

const MARKET_LABEL: Record<Market, string> = { cn: "A股", hk: "港股", us: "美股" }

/** Reject an obvious market/tool mismatch (e.g. an .HK code sent to a US-only tool)
 * before it hits upstream and returns a silent empty list that reads as "no data" —
 * the costliest silent error here. Skips whole-market keywords and unknown suffixes
 * so only a clear cross-market mismatch throws. Pass opts.message for a tool-specific
 * hint — fund-flow has no HK/US variant to redirect to, so it overrides the default
 * "请改用 …" message.
 *
 * Not applied to `gangtise_day_kline`: that endpoint covers all three markets plus
 * indices in one call, so a suffix check there would reject valid queries. */
function assertMarketMatch(
  securityList: readonly unknown[] | undefined,
  market: Market,
  opts: { message?: (code: string, codeMarket: Market) => string } = {},
): void {
  if (!securityList) return
  for (const code of securityList) {
    if (typeof code !== "string" || MARKET_KEYWORDS.has(code.toLowerCase())) continue
    const codeMarket = parseSecurityCode(code).market
    if (codeMarket && codeMarket !== market) {
      throw new ValidationError(
        opts.message?.(code, codeMarket) ?? `'${code}' 是${MARKET_LABEL[codeMarket]}代码，请改用 gangtise_day_kline（单接口覆盖 A股/港股/美股与指数）。`,
      )
    }
  }
}

function klineRun(
  endpointKey: string,
  tool: string,
  strategy: BatchStrategy,
  market?: Market,
  noKeywordReason?: string,
): ToolSpec["run"] {
  return async ({ client }, args) => {
    assertDateOrder(args)
    const body = buildKlineBody(args)
    const accepted = Object.keys(strategy.fullMarketKeywords)
    assertMarketKeywords(body.securityList, accepted, tool, noKeywordReason)
    body.securityList = canonicalizeKeywords(body.securityList, accepted)
    if (market) assertMarketMatch(body.securityList, market)
    const fullMarket = fullMarketOf(body.securityList, strategy)
    if (fullMarket) {
      // All-market goes through the sharding helper: it lifts the cap to 10K, shards
      // the range, and carries its own per-shard failure/truncation markers.
      const result = await callKlineWithSharding(client, endpointKey, body, {
        shardDays: fullMarket.shardDays,
        fullMarketValue: fullMarket.keyword,
        tool,
        calendar: strategy.calendar,
        cap: strategy.cap,
      })
      return contentResult(await buildToolContent(normalizeRows(flagMissingFields(result, body.fieldList))))
    }
    // Explicit-security request: pin the effective row cap in the body so the
    // limit-truncation check is exact regardless of any server-default drift
    // (mirrors the CLI, which sends `limit ?? DEFAULT_QUOTE_LIMIT`).
    const limit = body.limit ?? DEFAULT_QUOTE_LIMIT
    const securities = body.securityList ?? []
    // 显式多证券且单请求装不下（证券数 × 交易日数 > limit）时逐只请求再合并：单请求会在
    // 窗口开头截断，只剩前几只的前几个月，且只有一个 _partial 说不清缺了谁。
    if (securities.length > 1 && securities.length * estimateTradingDays(body.startDate, body.endDate) > limit) {
      const result = await callKlinePerSecurity(client, endpointKey, securities, (code) => ({ ...body, securityList: [code], limit }), limit)
      return contentResult(await buildToolContent(normalizeRows(flagMissingFields(result, body.fieldList))))
    }
    const result = flagLimitTruncated(await client.call(endpointKey, { ...body, limit }), limit)
    return contentResult(await buildToolContent(normalizeRows(flagMissingFields(result, body.fieldList))))
  }
}

/** 「拿到的是不是你要的那只票」——四条会直接导致错数据的识别指引。
 *
 * 挂在 `gangtise_day_kline` 与 `gangtise_realtime` 上，因为这两个是路由推荐的入口。
 * 🔴 别再搬回 `_hk` / `_us`：那两个工具的描述里写着「建议改用 day_kline」，警示留在
 * 那里等于只讲给不会被调用的工具听。也别搬进 server.instructions —— 只有 2 处用到，
 * 而贴着参数写模型更可能真的读到。 */
const CODE_IDENTITY_WARNING =
  "⚠️ **确认拿到的是你要的那只票**：后缀合法但标的不存在时返空列表而不报错（空 ≠ 没数据）；" +
  "核对请用 gangtise_securities_search **按公司名查**，再核对返回的 gtsName 与 gtsCode 后缀。" +
  "三类会拿到「合理但错误」的数：① A+H 两地上市名字**逐字相同**（中国移动 600941.SH / 00941.HK，招商银行 600036.SH / 03968.HK），" +
  "返回里没有市场字段、只有后缀能区分，拿错一边就是错币种错价格（招行两地价差方向还相反）；" +
  "② 美股写错代码可能命中另一只名字相近的**真实**证券（BRK.N 实为 RBRK.N，另一家公司）；" +
  "③ 搜得到 ≠ 查得到（B 股 900938.SH 搜索有、行情报「证券代码无效」），判据是行情接口返不返数据。"

/** 行情族的拆分策略：交易所周六日休市（calendar: workday），全市场请求抬到 10000 行上限。
 *  每片天数按单个交易日的行数定（A股 ~5.5K、美股 ~5.9K、港股 ~2.8K），保证单片不超上限：
 *  A/US 一天一片，HK 两天。 */
const quoteStrategy = (fullMarketKeywords: Record<string, number>): BatchStrategy => ({ fullMarketKeywords, calendar: "workday", cap: 10_000 })
const DAY_KLINE = quoteStrategy({ aShares: 1, hkStocks: 2, usStocks: 1 })
/** The market-specific day K-line tools still take the historical `all` keyword. */
const LEGACY_ALL = (shardDays: number) => quoteStrategy({ all: shardDays })
/** 指数日 K 没有全市场关键字。 */
const NO_FULL_MARKET = quoteStrategy({})
/** Realtime takes the same keywords as the unified day K-line but returns one snapshot
 * per security, so there is nothing to shard — the map exists only to declare which
 * keywords are accepted. */
const REALTIME_MARKETS = ["aShares", "hkStocks", "usStocks"]
/** Fund flow is A-share only, so `aShares` is its sole whole-market keyword. */
const FUND_FLOW = quoteStrategy({ aShares: 1 })
const FUND_FLOW_MARKETS = Object.keys(FUND_FLOW.fullMarketKeywords)

export const quoteFamily: FamilyModule = {
  name: "quote",
  endpoints: quoteEndpoints,
  tools: [
    defineTool({
      name: "gangtise_day_kline",
      tier: "core",
      access: "read",
      endpoint: "quote.day-kline",
      description: "查询历史日 K 线数据，单接口覆盖 A股/港股/美股个股 + 沪深 ETF + 交易所指数（沪深京）+ 概念指数（.GT）+ 申万行业指数（.SWI）+ 中信行业指数（.CI）+ 20 个全球指数，可在一次请求里混着传（仅历史；盘中实时请用 gangtise_realtime）。security 传市场关键字 'aShares' / 'hkStocks' / 'usStocks' 配合 startDate/endDate 可拉取该市场全部个股（自动分片）；关键字只覆盖个股——**aShares 不含 ETF**，ETF 与各类指数都要逐个传代码。⚠️ **港股部分标的有人民币柜台**：代码首位换成 8、名字带 -R 或 -WR（中国移动港币 00941.HK / 人民币 80941.HK；阿里 09988.HK / 89988.HK）。两者**后缀相同、exchange 字段也相同、返回里没有币种字段**，价差约等于汇率、看着完全正常——要港币报价就别用 8 开头的那只（不是每只港股都有柜台）。⚠️ **本接口查指数只返代码、不返 securityName**；指数名称用 gangtise_securities_search（category=['index']）查 gtsName。返回字段含 adjustFactor 复权因子（个股与 ETF 有，指数为 null）。⚠️ **volume 的单位是「股」**（ETF 为「份」），不是「手」——按手换算会差 100 倍，而数字看着仍像个成交量、不会报错。全球指数：amount 为 null、volume 正常，tradeDate 是交易所当地日期。" + CODE_IDENTITY_WARNING,
      input: {
        ...commonKlineSchema,
        // 统一工具的全市场关键字是三个市场名，不是 `all`，所以走 securityDesc 的双参形式
        // 而不是 marketSecurity（后者固定给「传 'all'」）。
        security: z.union([nonEmptyString, nonEmptyList()]).optional().describe(securityDesc(
          "证券代码 — A股 .SH/.SZ/.BJ、港股 .HK、美股 .O/.N/.A、沪深 ETF .SH/.SZ（512800.SH）、交易所指数 .SH/.SZ/.BJ、概念指数 .GT、申万行业指数 .SWI（801xxx.SWI）、中信行业指数 .CI（821xxx.CI）、全球指数按数据源后缀照抄（SPX.SPI 标普500 / DJI.SPI 道琼斯 / IXIC.O 纳指 / N225.NKI 日经225 / HSI.HI 恒生 / FTSE.FI 富时100 / GDAXI.FRA 德国DAX / KS11.KRX 韩国KOSPI 等 20 个），可混传，如 ['600519.SH','00700.HK','AAPL.O','000001.SH','SPX.SPI']",
          "或传市场关键字 'aShares'（A股全市场）/ 'hkStocks'（港股全市场）/ 'usStocks'（美股全市场）",
        )),
      },
      run: klineRun("quote.day-kline", "gangtise_day_kline", DAY_KLINE),
      examples: [
        { title: "单只：钉住 limit=6000", args: { security: "600519.SH", startDate: "2026-09-01", endDate: "2026-09-05", fieldList: ["securityCode", "tradeDate", "close"] }, expect: { requests: [{ method: "POST", path: "/application/open-quote/kline/daily", body: { securityList: ["600519.SH"], startDate: "2026-09-01", endDate: "2026-09-05", fieldList: ["securityCode", "tradeDate", "close"], limit: 6000 } }] } },
        { title: "多只且单请求装不下（4 只 × 约 1695 个交易日 > 6000）：逐只请求", args: { security: ["600519.SH", "000858.SZ", "00700.HK", "AAPL.O"], startDate: "2020-01-01", endDate: "2026-06-30" }, upstream: oneQuoteRow(), expect: { requests: [
            { method: "POST", path: "/application/open-quote/kline/daily", body: { securityList: ["000858.SZ"], startDate: "2020-01-01", endDate: "2026-06-30", limit: 6000 } },
            { method: "POST", path: "/application/open-quote/kline/daily", body: { securityList: ["00700.HK"], startDate: "2020-01-01", endDate: "2026-06-30", limit: 6000 } },
            { method: "POST", path: "/application/open-quote/kline/daily", body: { securityList: ["600519.SH"], startDate: "2020-01-01", endDate: "2026-06-30", limit: 6000 } },
            { method: "POST", path: "/application/open-quote/kline/daily", body: { securityList: ["AAPL.O"], startDate: "2020-01-01", endDate: "2026-06-30", limit: 6000 } },
          ] } },
        { title: "多只但装得下：一个请求", args: { security: ["600519.SH", "00700.HK"], startDate: "2026-09-01", endDate: "2026-09-30" }, expect: { requests: [{ method: "POST", path: "/application/open-quote/kline/daily", body: { securityList: ["600519.SH", "00700.HK"], startDate: "2026-09-01", endDate: "2026-09-30", limit: 6000 } }] } },
        { title: "aShares 全市场：1 天/片、跳周末、limit=10000", args: { security: "aShares", startDate: "2026-09-04", endDate: "2026-09-08" }, upstream: oneQuoteRow(), expect: { requests: [
            { method: "POST", path: "/application/open-quote/kline/daily", body: { securityList: ["aShares"], startDate: "2026-09-04", endDate: "2026-09-04", limit: 10000 } },
            { method: "POST", path: "/application/open-quote/kline/daily", body: { securityList: ["aShares"], startDate: "2026-09-07", endDate: "2026-09-07", limit: 10000 } },
            { method: "POST", path: "/application/open-quote/kline/daily", body: { securityList: ["aShares"], startDate: "2026-09-08", endDate: "2026-09-08", limit: 10000 } },
          ] } },
        { title: "hkStocks 全市场：2 天/片，关键字大小写归一", args: { security: "HKSTOCKS", startDate: "2026-09-07", endDate: "2026-09-10" }, upstream: oneQuoteRow(), expect: { requests: [
            { method: "POST", path: "/application/open-quote/kline/daily", body: { securityList: ["hkStocks"], startDate: "2026-09-07", endDate: "2026-09-08", limit: 10000 } },
            { method: "POST", path: "/application/open-quote/kline/daily", body: { securityList: ["hkStocks"], startDate: "2026-09-09", endDate: "2026-09-10", limit: 10000 } },
          ] } },
        { title: "全市场关键字与代码混传本地拒绝", args: { security: ["aShares", "600519.SH"], startDate: "2026-09-01", endDate: "2026-09-02" }, expect: { rejects: /全市场关键字必须单独传/ } },
        { title: "all 不是本工具的关键字", args: { security: "all", startDate: "2026-09-01", endDate: "2026-09-02" }, expect: { rejects: /'all' 不是 gangtise_day_kline 的全市场关键字/ } },
      ],
    }),
    defineTool({
      name: "gangtise_day_kline_hk",
      tier: "core",
      access: "read",
      endpoint: "quote.day-kline-hk",
      description: "【已被 gangtise_day_kline 覆盖，改用它】港股历史日 K 线。gangtise_day_kline 的 'hkStocks' 等价于本工具的 'all'，行数、字段与代码集合完全相同，且能与其他市场混查并对不合法后缀明确报错——没有必须用本工具的场景。",
      input: { ...commonKlineSchema, fieldList: legacyFieldList, security: marketSecurity("港股代码，如 '00700.HK' 或 ['00700.HK','09988.HK']（5 位数字前补零）") },
      run: klineRun("quote.day-kline-hk", "gangtise_day_kline_hk", LEGACY_ALL(2), "hk"),
      examples: [
        { title: "港股代码", args: { security: "00700.HK", startDate: "2026-09-01", endDate: "2026-09-05" }, expect: { requests: [{ method: "POST", path: "/application/open-quote/kline-hk/daily", body: { securityList: ["00700.HK"], startDate: "2026-09-01", endDate: "2026-09-05", limit: 6000 } }] } },
        { title: "all：2 天/片", args: { security: "all", startDate: "2026-09-07", endDate: "2026-09-10" }, upstream: oneQuoteRow(), expect: { requests: [
            { method: "POST", path: "/application/open-quote/kline-hk/daily", body: { securityList: ["all"], startDate: "2026-09-07", endDate: "2026-09-08", limit: 10000 } },
            { method: "POST", path: "/application/open-quote/kline-hk/daily", body: { securityList: ["all"], startDate: "2026-09-09", endDate: "2026-09-10", limit: 10000 } },
          ] } },
        { title: "美股代码本地拒绝", args: { security: "AAPL.O" }, expect: { rejects: /是美股代码/ } },
      ],
    }),
    defineTool({
      name: "gangtise_day_kline_us",
      tier: "core",
      access: "read",
      endpoint: "quote.day-kline-us",
      description: "【已被 gangtise_day_kline 覆盖，改用它】美股历史日 K 线（NYSE/NASDAQ/AMEX）。gangtise_day_kline 的 'usStocks' 等价于本工具的 'all'，行数、字段与代码集合完全相同，且能与其他市场混查并对不合法后缀明确报错——没有必须用本工具的场景。",
      input: { ...commonKlineSchema, fieldList: legacyFieldList, security: marketSecurity("美股代码，如 'AAPL.O' 或 ['AAPL.O','BRK_B.N']（.O=NASDAQ / .N=NYSE / .A=AMEX）。⚠️ **多股份类别的写法不统一，别自己拼**：有的把类别字母并进 ticker（福克斯 = FOXA.O / FOX.O），有的用下划线（伯克希尔 = BRK_A.N / BRK_B.N），**还有的 A 类根本不带标记**（Bio-Rad A = BIO.N、B = BIO_B.N）。拼错**不一定返空**——也可能命中同一家公司的另一个类别（哈弗蒂 HVT.N 与 HVT_A.N 都真实存在、价格不同），拿到一个完全合理的错数。按公司名查确切代码见下") },
      run: klineRun("quote.day-kline-us", "gangtise_day_kline_us", LEGACY_ALL(1), "us"),
      examples: [
        { title: "美股代码", args: { security: "AAPL.O", startDate: "2026-09-01", endDate: "2026-09-05", limit: 100 }, expect: { requests: [{ method: "POST", path: "/application/open-quote/kline-us/daily", body: { securityList: ["AAPL.O"], startDate: "2026-09-01", endDate: "2026-09-05", limit: 100 } }] } },
        { title: "港股代码本地拒绝", args: { security: "00700.HK" }, expect: { rejects: /是港股代码/ } },
      ],
    }),
    defineTool({
      name: "gangtise_index_day_kline",
      tier: "core",
      access: "read",
      endpoint: "quote.index-day-kline",
      description: "查询指数日 K 线数据（沪深京交易所指数如 000001.SH 上证指数、399001.SZ 深成指，也支持概念指数 .GT 与行业指数 .CI/.SWI）。gangtise_day_kline 收同样的指数代码、还能与个股混查。返回不含指数名称，名称用 gangtise_securities_search（category=['index']）查 gtsName。本工具没有全市场关键字，多个指数逐个列出代码。⚠️ 本工具只收指数代码：传个股代码（哪怕是有效的，如 600519.SH）返回空列表而不报错，别把它读成「这只票没数据」；无效代码同样返空。核对代码请用 gangtise_securities_search 按公司名/简称查，并同时核对返回的 gtsName 与 gtsCode 后缀（A+H 两地上市名字逐字相同，只有后缀能区分）。",
      input: { ...commonKlineSchema, security: z.union([nonEmptyString, nonEmptyList()]).optional().describe("指数代码，单个或多个，如 '000001.SH'（上证指数）/ '399001.SZ'（深成指）/ '821026.CI'（中信行业）/ '801780.SWI'（申万银行）") },
      // 不收任何全市场关键字：本端点对 'all' 返回 000000 + 空列表（不报错），读起来像「没有数据」。
      run: klineRun("quote.index-day-kline", "gangtise_index_day_kline", NO_FULL_MARKET, undefined, "本接口对 'all' 返回空结果而不报错。请逐个传指数代码。"),
      examples: [
        { title: "单个指数", args: { security: "000001.SH", startDate: "2026-09-01", endDate: "2026-09-05" }, expect: { requests: [{ method: "POST", path: "/application/open-quote/index/kline/daily", body: { securityList: ["000001.SH"], startDate: "2026-09-01", endDate: "2026-09-05", limit: 6000 } }] } },
        { title: "all 本地拒绝（本端点对 all 返回空结果）", args: { security: "all", startDate: "2026-08-01", endDate: "2026-08-31" }, expect: { rejects: /没有全市场关键字/ } },
      ],
    }),
    defineTool({
      name: "gangtise_minute_kline",
      tier: "core",
      access: "read",
      endpoint: "quote.minute-kline",
      description: "查询分钟级 K 线数据：A 股个股、沪深 ETF、各类指数（含 20 个全球指数，其 volume / amount 为 null、tradeTime 是交易所当地时间）。security 可传多只（逐只请求后按传入顺序合并，每只各自受 limit 约束，撞上限的证券标 _partial + _truncated_securities）。⚠️ **volume 的单位是「股」**（ETF 为「份」），不是「手」——按手换算会差 100 倍且不报错。",
      input: {
        security: z.union([nonEmptyString, nonEmptyList()]).describe("证券代码，单只（'600519.SH'）或多只（['600519.SH','512800.SH','SPX.SPI']）"),
        startTime: dateTimeString.optional(),
        endTime: dateTimeString.optional(),
        limit: z.number().int().min(1).max(10_000).optional().describe("最大返回行数（默认 6000，最大 10000）。返回行数撞上限时结果标 _partial（可能被截断）；多只时作用于每一只"),
        fieldList: uniqueFieldList(`指定返回字段，如 ['securityCode','tradeTime','open','close','volume']。${FIELD_LIST_NOTE("securityCode / tradeTime")}`),
      },
      run: async ({ client }, { security, startTime, endTime, limit, fieldList }) => {
        assertDateOrder({ startTime, endTime })
        const body: Record<string, unknown> = {}
        if (startTime) body.startTime = startTime
        if (endTime) body.endTime = endTime
        // Pin the row cap so limit-truncation detection is exact regardless of any
        // server-default drift (mirrors CLI DEFAULT_QUOTE_LIMIT).
        const effLimit = (limit as number | undefined) ?? DEFAULT_QUOTE_LIMIT
        body.limit = effLimit
        if (fieldList) body.fieldList = fieldList
        const securities = Array.isArray(security) ? (security as string[]) : [security as string]
        // 接口一次只收一只（securityCode），多只在本地逐只请求再合并。
        const result = securities.length > 1
          ? await callKlinePerSecurity(client, "quote.minute-kline", securities, (code) => ({ ...body, securityCode: code }), effLimit)
          : flagLimitTruncated(await client.call("quote.minute-kline", { ...body, securityCode: securities[0] }), effLimit)
        return contentResult(await buildToolContent(normalizeRows(flagMissingFields(result, fieldList))))
      },
      examples: [
        { title: "单只：securityCode 标量", args: { security: "600519.SH", startTime: "2026-09-01 09:30:00", endTime: "2026-09-01 15:00:00" }, expect: { requests: [{ method: "POST", path: "/application/open-quote/kline/minute", body: { startTime: "2026-09-01 09:30:00", endTime: "2026-09-01 15:00:00", limit: 6000, securityCode: "600519.SH" } }] } },
        { title: "多只：逐只请求", args: { security: ["600519.SH", "512800.SH"], startTime: "2026-09-01 09:30:00", endTime: "2026-09-01 15:00:00", limit: 500 }, upstream: oneQuoteRow(), expect: { requests: [
            { method: "POST", path: "/application/open-quote/kline/minute", body: { startTime: "2026-09-01 09:30:00", endTime: "2026-09-01 15:00:00", limit: 500, securityCode: "512800.SH" } },
            { method: "POST", path: "/application/open-quote/kline/minute", body: { startTime: "2026-09-01 09:30:00", endTime: "2026-09-01 15:00:00", limit: 500, securityCode: "600519.SH" } },
          ] } },
      ],
    }),
    defineTool({
      name: "gangtise_realtime",
      tier: "core",
      access: "read",
      endpoint: "quote.realtime",
      description: "查询实时行情快照，单接口覆盖 A 股 / 港股 / 美股个股 + 沪深 ETF + 各类指数（含 20 个全球指数），可代码混合传入。非交易时间返回最近一个交易日的收盘快照；停牌证券返回停牌前最后一个有效快照。日 K 线接口（day-kline*）不含盘中数据，问\"现在/此刻\"请走本工具。⚠️ **volume 的单位是「股」**（ETF 为「份」），不是「手」——按手换算会差 100 倍且不报错。**全部字段仅这 15 个：securityCode/exchange/tradeDate/tradeTime/tradeStatus/open/high/low/latestPrice(最新价)/preClose(昨收)/change/pctChange/volume/amount/amplitude——没有 close、没有市值，也没有 turnoverRate / volumeRatio**（传了会连字段名一起被静默丢掉；换手率走 gangtise_indicator_cross_section 的 qte_turn，A 股）；总市值请用 gangtise_indicator_cross_section 的 qte_mkt_cptl（A/港/美股均有数，默认返「元」，用 scale 缩放）。tradeStatus（未开市/连续竞价/收盘/停牌…）仅 A 股 / 港股个股有值，其余为 null。为 null 的字段：美股 amount（要美股成交额用 gangtise_day_kline 或 EDE qte_amt）；全球指数 volume / amount / amplitude。tradeDate / tradeTime：A 股 / 港股 / ETF / 沪深各类指数为北京时间，**美股与全球指数是交易所当地时间**（美股收盘快照的 tradeTime 是 16:00）。" + CODE_IDENTITY_WARNING,
      input: {
        security: z.union([nonEmptyString, nonEmptyList()]).optional().describe("证券代码或全市场关键字：单/多只代码（'600519.SH' / ['600519.SH','00700.HK','AAPL.O','512800.SH','SPX.SPI']，沪深 ETF .SH/.SZ、交易所指数 .SH/.SZ/.BJ、概念指数 .GT、申万行业指数 .SWI（801xxx.SWI）、中信行业指数 .CI（821xxx.CI）、全球指数按数据源后缀照抄（SPX.SPI / DJI.SPI / IXIC.O / N225.NKI / HSI.HI / FTSE.FI / GDAXI.FRA 等 20 个）也可传），或市场关键字 'aShares' / 'hkStocks' / 'usStocks' 拉取全市场（关键字须单独传，不能与证券代码或另一个关键字混传；关键字只覆盖个股——指数没有全市场关键字，aShares 也不含 ETF）。"),
        fieldList: uniqueFieldList(`【默认不传 = 返回全量字段，最稳】仅当用户明确要精简、或查全市场（aShares/hkStocks/usStocks）想省 token 时才传。示例：['securityCode','tradeDate','tradeTime','latestPrice','pctChange','volume']。**只传本工具真实存在的 15 个字段名**（见描述；注意没有 close、turnoverRate、volumeRatio）。${FIELD_LIST_NOTE("securityCode（需要时点再加 tradeDate / tradeTime）")}`),
      },
      run: async ({ client }, { security, fieldList }) => {
        const body: Record<string, unknown> = {}
        if (security) {
          const list = Array.isArray(security) ? security as string[] : [security as string]
          // Realtime rejects a keyword sent alongside codes with a bare 120001 that points
          // at the codes rather than at the combination — catch it here instead.
          assertMarketKeywords(list, REALTIME_MARKETS, "gangtise_realtime")
          body.securityList = canonicalizeKeywords(list, REALTIME_MARKETS)
        }
        if (fieldList) body.fieldList = fieldList
        const result = await client.call("quote.realtime", body)
        return contentResult(await buildToolContent(normalizeRows(flagMissingFields(result, fieldList))))
      },
      examples: [
        { title: "混合市场 + fieldList", args: { security: ["600519.SH", "00700.HK", "AAPL.O"], fieldList: ["securityCode", "latestPrice"] }, expect: { requests: [{ method: "POST", path: "/application/open-quote/quote/realtime", body: { securityList: ["600519.SH", "00700.HK", "AAPL.O"], fieldList: ["securityCode", "latestPrice"] } }] } },
        { title: "全市场关键字大小写归一", args: { security: "usstocks" }, expect: { requests: [{ method: "POST", path: "/application/open-quote/quote/realtime", body: { securityList: ["usStocks"] } }] } },
      ],
    }),
    defineTool({
      name: "gangtise_fund_flow",
      tier: "core",
      access: "read",
      endpoint: "quote.fund-flow",
      description: "查询 A 股个股日资金流向（沪深北），含小/中/大/特大单流入流出金额及占比、主力净流入等字段。security='aShares' 配合 startDate/endDate 拉取全市场（自动按 1 天/片分片）。",
      input: {
        security: z.union([nonEmptyString, nonEmptyList()]).optional().describe("A 股证券代码（沪深北），如 '600519.SH' 或 ['600519.SH','000858.SZ']；传 'aShares' 拉取全市场（关键字须单独传，不能与证券代码混传——混传时本接口会丢掉关键字只返那几只，不报错；须同时提供 startDate 和 endDate，自动按日分片）"),
        startDate: dateString.optional(),
        endDate: dateString.optional(),
        limit: z.number().int().min(1).max(10_000).optional().describe("单次请求最大返回行数（默认 6000，最大 10000）。截取从查询窗口开头开始——取「最近 N 条」须传日期区间；返回行数撞上限时结果标 _partial（可能被截断）；全市场分片时该值作用于每个分片"),
        fieldList: uniqueFieldList("指定返回字段，如 ['mainNetInflow','largeInflow','xlargeOutflow']；省略返回全部。本接口会自动附带 securityCode / tradeDate；名字写错不报错、只少一列并标 missingFields"),
      },
      run: async ({ client }, args) => {
        assertDateOrder(args)
        const body = buildKlineBody(args)
        // This guard matters MORE here than on the K-line tools, not less: mixing the
        // keyword with codes does not even fail upstream — the keyword is silently
        // dropped and only the explicit codes come back, so "whole market plus this one"
        // quietly becomes "only this one".
        assertMarketKeywords(body.securityList, FUND_FLOW_MARKETS, "gangtise_fund_flow")
        body.securityList = canonicalizeKeywords(body.securityList, FUND_FLOW_MARKETS)
        const isFullMarket = body.securityList?.length === 1 && body.securityList[0] === "aShares"
        // fund-flow is A-share only (沪深北). Reject an obvious HK/US code before it
        // reaches the A-share endpoint and returns a silent empty list that reads as
        // "no data" — the costliest silent error here. Distinct hint: there is no HK/US
        // fund-flow tool to redirect to.
        assertMarketMatch(body.securityList, "cn", {
          message: (code, codeMarket) => `资金流向仅支持 A 股（沪深北）代码，'${code}' 是${MARKET_LABEL[codeMarket]}代码。`,
        })
        if (isFullMarket) {
          // Full-market fund-flow: upstream errors instead of truncating when a
          // single request exceeds the row cap, so it must day-shard — which needs
          // an explicit range. Without both dates, reject up front (mirrors CLI).
          if (!body.startDate || !body.endDate) {
            throw new ValidationError("security='aShares' 全市场资金流向须同时提供 startDate 和 endDate（按日分片拉取）")
          }
          const result = await callKlineWithSharding(client, "quote.fund-flow", body, { shardDays: FUND_FLOW.fullMarketKeywords.aShares, fullMarketValue: "aShares", tool: "gangtise_fund_flow", calendar: FUND_FLOW.calendar, cap: FUND_FLOW.cap })
          return contentResult(await buildToolContent(normalizeRows(flagMissingFields(result, body.fieldList))))
        }
        // Pin the row cap so limit-truncation detection is exact (mirrors CLI DEFAULT_QUOTE_LIMIT).
        const limit = body.limit ?? DEFAULT_QUOTE_LIMIT
        const flagged = flagLimitTruncated(await client.call("quote.fund-flow", { ...body, limit }), limit)
        return contentResult(await buildToolContent(normalizeRows(flagMissingFields(flagged, body.fieldList))))
      },
      examples: [
        { title: "单只", args: { security: "600519.SH", startDate: "2026-09-01", endDate: "2026-09-05" }, expect: { requests: [{ method: "POST", path: "/application/open-quote/fund-flow/daily", body: { securityList: ["600519.SH"], startDate: "2026-09-01", endDate: "2026-09-05", limit: 6000 } }] } },
        { title: "aShares 全市场：1 天/片", args: { security: "aShares", startDate: "2026-09-04", endDate: "2026-09-07" }, upstream: oneQuoteRow(), expect: { requests: [
            { method: "POST", path: "/application/open-quote/fund-flow/daily", body: { securityList: ["aShares"], startDate: "2026-09-04", endDate: "2026-09-04", limit: 10000 } },
            { method: "POST", path: "/application/open-quote/fund-flow/daily", body: { securityList: ["aShares"], startDate: "2026-09-07", endDate: "2026-09-07", limit: 10000 } },
          ] } },
        { title: "全市场缺日期本地拒绝", args: { security: "aShares", startDate: "2026-09-04" }, expect: { rejects: /须同时提供 startDate 和 endDate/ } },
        { title: "港股代码本地拒绝", args: { security: "00700.HK" }, expect: { rejects: /仅支持 A 股/ } },
      ],
    }),
  ],
}
