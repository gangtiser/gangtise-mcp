import { z } from "zod"
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import type { GangtiseClient } from "../core/client.js"
import { normalizeRows } from "../core/normalize.js"
import { ValidationError } from "../core/errors.js"
import { callKlineWithSharding, flagLimitTruncated, type KlineBody } from "../core/quoteSharding.js"
import { dateString, dateTimeString } from "../core/dateContext.js"
import { assertDateOrder, buildToolContent } from "./registry.js"
import { toolHandler, contentResult } from "./helpers.js"
import { MARKET_KEYWORDS, matchesKeyword, nonEmptyString, nonEmptyList, uniqueFieldList } from "./schemas.js"


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

/** 🔴 有意**不含** `security`——每个 K 线工具必须自己声明，用本市场真正收的代码做示例。
 * 放一个通用的进来就等于给下一个市场工具准备好了一个别的市场的示例，而那是静默错误
 * （港股/美股工具本地拒收、指数工具静默返空）。少了它，忘写的人第一次调用就会发现。 */
const commonKlineSchema = {
  startDate: dateString.optional(),
  endDate: dateString.optional(),
  limit: z.number().int().min(1).max(10_000).optional().describe("单次请求最大返回行数（默认 6000，最大 10000）。截取从查询窗口开头开始——取「最近 N 条」须传日期区间而非只传 limit；全市场分片查询时该值作用于每个分片"),
  fieldList: uniqueFieldList("指定返回字段，如 ['open','close','pctChange']"),
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
 * 🔴 Comparing lower-cased (via `matchesKeyword`) is load-bearing, not tidiness: the
 * endpoints disagree on case. `gangtise_fund_flow` accepts only the literal `aShares`
 * (`ashares` → `120001 非有效A股`) while the others fold case, so canonicalising is the
 * only reason a lower-cased keyword works there at all — and on the others it keeps the
 * shard lookup in step with the server, without which a case variant silently degrades
 * to one unsharded 6000-row request. Both halves are pinned in quote.test.ts. */
function assertMarketKeywords(securityList: readonly unknown[] | undefined, accepted: readonly string[], tool: string): void {
  if (!securityList) return
  const codes = securityList.filter((s): s is string => typeof s === "string")
  const used = codes.filter((s) => MARKET_KEYWORDS.has(s.toLowerCase()))
  if (used.length === 0) return
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

/** Which whole-market keyword (if any) this body asks for, and at what shard size.
 * Each market shards at its own granularity — a whole-market HK pull tolerates 2-day
 * windows where A-share and US pulls need one day each. */
function resolveFullMarket(securityList: string[] | undefined, markets: Record<string, number>): { keyword: string; shardDays: number } | undefined {
  if (!securityList || securityList.length !== 1) return undefined
  const keyword = Object.keys(markets).find((k) => securityList[0] === k)
  return keyword ? { keyword, shardDays: markets[keyword] } : undefined
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

const SUFFIX_MARKET: Record<string, "cn" | "hk" | "us"> = {
  SH: "cn", SZ: "cn", BJ: "cn", HK: "hk", O: "us", N: "us", A: "us",
}
const MARKET_LABEL: Record<"cn" | "hk" | "us", string> = { cn: "A股", hk: "港股", us: "美股" }

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
  market: "cn" | "hk" | "us",
  opts: { message?: (code: string, codeMarket: "cn" | "hk" | "us") => string } = {},
): void {
  if (!securityList) return
  for (const code of securityList) {
    if (typeof code !== "string" || MARKET_KEYWORDS.has(code.toLowerCase())) continue
    const codeMarket = SUFFIX_MARKET[code.split(".").pop()?.toUpperCase() ?? ""]
    if (codeMarket && codeMarket !== market) {
      throw new ValidationError(
        opts.message?.(code, codeMarket) ?? `'${code}' 是${MARKET_LABEL[codeMarket]}代码，请改用 gangtise_day_kline（单接口覆盖 A股/港股/美股与指数）。`,
      )
    }
  }
}

function klineHandler(
  client: GangtiseClient,
  endpointKey: string,
  tool: string,
  markets: Record<string, number>,
  market?: "cn" | "hk" | "us",
) {
  return toolHandler(async (args: Record<string, unknown>) => {
    assertDateOrder(args)
    const body = buildKlineBody(args)
    const accepted = Object.keys(markets)
    assertMarketKeywords(body.securityList, accepted, tool)
    body.securityList = canonicalizeKeywords(body.securityList, accepted)
    if (market) assertMarketMatch(body.securityList, market)
    const fullMarket = resolveFullMarket(body.securityList, markets)
    if (fullMarket) {
      // All-market goes through the sharding helper: it lifts the cap to 10K, shards
      // the range, and carries its own per-shard failure/truncation markers.
      const result = await callKlineWithSharding(client, endpointKey, body, {
        shardDays: fullMarket.shardDays,
        fullMarketValue: fullMarket.keyword,
      })
      return contentResult(await buildToolContent(normalizeRows(result)))
    }
    // Explicit-security request: pin the effective row cap in the body so the
    // limit-truncation check is exact regardless of any server-default drift
    // (mirrors the CLI, which sends `limit ?? DEFAULT_QUOTE_LIMIT`).
    const limit = body.limit ?? DEFAULT_QUOTE_LIMIT
    const result = flagLimitTruncated(await client.call(endpointKey, { ...body, limit }), limit)
    return contentResult(await buildToolContent(normalizeRows(result)))
  })
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

/** Shard granularity per whole-market keyword on the unified day K-line endpoint.
 * Sized from the per-trading-day row counts (A股 ~5.5K, 美股 ~5.9K, 港股 ~2.8K) so a
 * single shard stays under the 10000-row API cap: A/US one day each, HK two. */
const KLINE_MARKETS: Record<string, number> = { aShares: 1, hkStocks: 2, usStocks: 1 }
/** The market-specific day K-line tools still take the historical `all` keyword. */
const LEGACY_ALL = (shardDays: number): Record<string, number> => ({ all: shardDays })
/** Realtime takes the same keywords as the unified day K-line but returns one snapshot
 * per security, so there is nothing to shard — the map exists only to declare which
 * keywords are accepted. */
const REALTIME_MARKETS = ["aShares", "hkStocks", "usStocks"]
/** Fund flow is A-share only, so `aShares` is its sole whole-market keyword. */
const FUND_FLOW_MARKETS = ["aShares"]

export function registerQuoteTools(server: McpServer, client: GangtiseClient): void {
  server.registerTool(
    "gangtise_day_kline",
    {
      description: "查询历史日 K 线数据，单接口覆盖 A股/港股/美股个股 + 交易所指数（沪深京）+ 概念指数（.GT）+ 申万行业指数（.SWI）+ 中信行业指数（.CI），可在一次请求里混着传（仅历史；盘中实时请用 gangtise_realtime）。security 传市场关键字 'aShares' / 'hkStocks' / 'usStocks' 配合 startDate/endDate 可拉取该市场全部个股（自动分片）。⚠️ **港股部分标的有人民币柜台**：代码首位换成 8、名字带 -R 或 -WR（中国移动港币 00941.HK / 人民币 80941.HK；阿里 09988.HK / 89988.HK）。两者**后缀相同、exchange 字段也相同、返回里没有币种字段**，价差约等于汇率、看着完全正常——要港币报价就别用 8 开头的那只（不是每只港股都有柜台）。⚠️ **本接口查指数只返代码、不返 securityName**；要指数名称、或要一次取回全部沪深京交易所指数，请用 gangtise_index_day_kline。返回字段含 adjustFactor 复权因子（指数为 null）。" + CODE_IDENTITY_WARNING,
      inputSchema: {
        ...commonKlineSchema,
        // 统一工具的全市场关键字是三个市场名，不是 `all`，所以走 securityDesc 的双参形式
        // 而不是 marketSecurity（后者固定给「传 'all'」）。
        security: z.union([nonEmptyString, nonEmptyList()]).optional().describe(securityDesc(
          "证券代码 — A股 .SH/.SZ/.BJ、港股 .HK、美股 .O/.N/.A、交易所指数 .SH/.SZ/.BJ、概念指数 .GT、申万行业指数 .SWI（801xxx.SWI）、中信行业指数 .CI（821xxx.CI），可混传，如 ['600519.SH','00700.HK','AAPL.O','000001.SH']；查指数若需要名称请用 gangtise_index_day_kline",
          "或传市场关键字 'aShares'（A股全市场）/ 'hkStocks'（港股全市场）/ 'usStocks'（美股全市场）",
        )),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (args) => klineHandler(client, "quote.day-kline", "gangtise_day_kline", KLINE_MARKETS)(args as Record<string, unknown>),
  )

  server.registerTool(
    "gangtise_day_kline_hk",
    {
      description: "【已被 gangtise_day_kline 覆盖，改用它】港股历史日 K 线。gangtise_day_kline 的 'hkStocks' 等价于本工具的 'all'，行数、字段与代码集合完全相同，且能与其他市场混查并对不合法后缀明确报错——没有必须用本工具的场景。",
      inputSchema: { ...commonKlineSchema, security: marketSecurity("港股代码，如 '00700.HK' 或 ['00700.HK','09988.HK']（5 位数字前补零）") },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (args) => klineHandler(client, "quote.day-kline-hk", "gangtise_day_kline_hk", LEGACY_ALL(2), "hk")(args as Record<string, unknown>),
  )

  server.registerTool(
    "gangtise_day_kline_us",
    {
      description: "【已被 gangtise_day_kline 覆盖，改用它】美股历史日 K 线（NYSE/NASDAQ/AMEX）。gangtise_day_kline 的 'usStocks' 等价于本工具的 'all'，行数、字段与代码集合完全相同，且能与其他市场混查并对不合法后缀明确报错——没有必须用本工具的场景。",
      inputSchema: { ...commonKlineSchema, security: marketSecurity("美股代码，如 'AAPL.O' 或 ['AAPL.O','BRK_B.N']（.O=NASDAQ / .N=NYSE / .A=AMEX）。⚠️ **多股份类别的写法不统一，别自己拼**：有的把类别字母并进 ticker（福克斯 = FOXA.O / FOX.O），有的用下划线（伯克希尔 = BRK_A.N / BRK_B.N），**还有的 A 类根本不带标记**（Bio-Rad A = BIO.N、B = BIO_B.N）。拼错**不一定返空**——也可能命中同一家公司的另一个类别（哈弗蒂 HVT.N 与 HVT_A.N 都真实存在、价格不同），拿到一个完全合理的错数。按公司名查确切代码见下") },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (args) => klineHandler(client, "quote.day-kline-us", "gangtise_day_kline_us", LEGACY_ALL(1), "us")(args as Record<string, unknown>),
  )

  server.registerTool(
    "gangtise_index_day_kline",
    {
      description: "查询指数日 K 线数据（沪深京交易所指数如 000001.SH 上证指数、399001.SZ 深成指，也支持概念指数 .GT 与行业指数 .CI/.SWI）。个股日 K 线请用 gangtise_day_kline；下面两种情况用本工具：**一次取回全部交易所指数**（security='all'，自动分片）、**需要指数名称 securityName**（gangtise_day_kline 查指数只返代码，其余字段两个工具一致）。⚠️ 本工具只收指数代码：传个股代码（哪怕是有效的，如 600519.SH）返回空列表而不报错，别把它读成「这只票没数据」；无效代码同样返空。核对代码请用 gangtise_securities_search 按公司名/简称查，并同时核对返回的 gtsName 与 gtsCode 后缀（A+H 两地上市名字逐字相同，只有后缀能区分）。",
      inputSchema: { ...commonKlineSchema, security: marketSecurity("指数代码，如 '000001.SH'（上证指数）/ '399001.SZ'（深成指）/ '821026.CI'（中信行业）/ '801780.SWI'（申万银行）") },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    // 15 天/片，不是 30：全部交易所指数每个交易日约 531 行，30 天窗口约 22 个交易日
    // ≈ 11.7K 行，必然撞 10000 行上限并被截断（有 _truncated_shards 兜底，但分片本就
    // 不该切出必然超限的窗口）；15 天窗口约 5.8K 行，留足余量。
    async (args) => klineHandler(client, "quote.index-day-kline", "gangtise_index_day_kline", LEGACY_ALL(15))(args as Record<string, unknown>),
  )

  server.registerTool(
    "gangtise_minute_kline",
    {
      description: "查询 A 股分钟级 K 线数据，需指定单只证券代码。",
      inputSchema: {
        security: nonEmptyString.describe("单只证券代码，如 '600519.SH'"),
        startTime: dateTimeString.optional(),
        endTime: dateTimeString.optional(),
        limit: z.number().int().min(1).max(10_000).optional().describe("最大返回行数（默认 6000，最大 10000）。返回行数撞上限时结果标 _partial（可能被截断）"),
        fieldList: commonKlineSchema.fieldList,
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    toolHandler(async ({ security, startTime, endTime, limit, fieldList }: Record<string, unknown>) => {
      assertDateOrder({ startTime, endTime })
      const body: Record<string, unknown> = { securityCode: security }
      if (startTime) body.startTime = startTime
      if (endTime) body.endTime = endTime
      // Pin the row cap so limit-truncation detection is exact regardless of any
      // server-default drift (mirrors CLI DEFAULT_QUOTE_LIMIT).
      const effLimit = (limit as number | undefined) ?? DEFAULT_QUOTE_LIMIT
      body.limit = effLimit
      if (fieldList) body.fieldList = fieldList
      const result = flagLimitTruncated(await client.call("quote.minute-kline", body), effLimit)
      return contentResult(await buildToolContent(normalizeRows(result)))
    }),
  )

  server.registerTool(
    "gangtise_realtime",
    {
      description: "查询实时行情快照，单接口覆盖 A 股 / 港股 / 美股，可代码混合传入。非交易时间返回最近一个交易日的收盘快照；停牌证券返回停牌前最后一个有效快照。日 K 线接口（day-kline*）不含盘中数据，问\"现在/此刻\"请走本工具。**全部字段仅：securityCode/exchange/tradeDate/tradeTime/open/high/low/latestPrice(最新价)/preClose(昨收)/change/pctChange/volume/amount/turnoverRate/amplitude/volumeRatio——没有 close，也没有市值**；总市值请用 gangtise_indicator_cross_section 的 qte_mkt_cptl（A/港/美股均有数，默认返「元」，用 scale 缩放）。" + CODE_IDENTITY_WARNING,
      inputSchema: {
        security: z.union([nonEmptyString, nonEmptyList()]).optional().describe("证券代码或全市场关键字：单/多只代码（'600519.SH' / ['600519.SH','00700.HK','AAPL.O']，交易所指数 .SH/.SZ/.BJ、概念指数 .GT、申万行业指数 .SWI（801xxx.SWI）、中信行业指数 .CI（821xxx.CI）也可传），或市场关键字 'aShares' / 'hkStocks' / 'usStocks' 拉取全市场（关键字须单独传，不能与证券代码或另一个关键字混传；指数没有全市场关键字）。"),
        fieldList: uniqueFieldList("【默认不传 = 返回全量字段，最稳】仅当用户明确要精简、或查全市场（aShares/hkStocks/usStocks）想省 token 时才传。一旦传入必须显式包含识别字段 securityCode/tradeDate/tradeTime（exchange 可省略），否则多只查询无法对齐行与代码。示例：['securityCode','tradeDate','tradeTime','latestPrice','pctChange','volume']。**只传本工具真实存在的字段名**（见上方字段清单；注意没有 close）：传了不存在的字段，接口只返回有效字段的值、字段名却按请求原样回显，按位置拍平就会**整行错位**（如传 ['securityCode','close','turnoverRate'] 会把换手率的值贴到 close 上）——本工具已在拍平时检测长度不匹配并直接报错拒绝，但仍应从源头避免。"),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    toolHandler(async ({ security, fieldList }: Record<string, unknown>) => {
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
      return contentResult(await buildToolContent(normalizeRows(result)))
    }),
  )

  server.registerTool(
    "gangtise_fund_flow",
    {
      description: "查询 A 股个股日资金流向（沪深北），含小/中/大/特大单流入流出金额及占比、主力净流入等字段。security='aShares' 配合 startDate/endDate 拉取全市场（自动按 1 天/片分片）。",
      inputSchema: {
        security: z.union([nonEmptyString, nonEmptyList()]).optional().describe("A 股证券代码（沪深北），如 '600519.SH' 或 ['600519.SH','000858.SZ']；传 'aShares' 拉取全市场（关键字须单独传，不能与证券代码混传——混传时本接口会丢掉关键字只返那几只，不报错；须同时提供 startDate 和 endDate，自动按日分片）"),
        startDate: dateString.optional(),
        endDate: dateString.optional(),
        limit: z.number().int().min(1).max(10_000).optional().describe("单次请求最大返回行数（默认 6000，最大 10000）。截取从查询窗口开头开始——取「最近 N 条」须传日期区间；返回行数撞上限时结果标 _partial（可能被截断）；全市场分片时该值作用于每个分片"),
        fieldList: uniqueFieldList("指定返回字段，如 ['mainNetInflow','largeInflow','xlargeOutflow']；省略返回全部"),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    toolHandler(async (args: Record<string, unknown>) => {
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
        const result = await callKlineWithSharding(client, "quote.fund-flow", body, { shardDays: 1, fullMarketValue: "aShares" })
        return contentResult(await buildToolContent(normalizeRows(result)))
      }
      // Pin the row cap so limit-truncation detection is exact (mirrors CLI DEFAULT_QUOTE_LIMIT).
      const limit = body.limit ?? DEFAULT_QUOTE_LIMIT
      const flagged = flagLimitTruncated(await client.call("quote.fund-flow", { ...body, limit }), limit)
      return contentResult(await buildToolContent(normalizeRows(flagged)))
    }),
  )
}
