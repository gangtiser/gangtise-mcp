import { PAGE_CONCURRENCY } from "./config.js"
import { today } from "./dateContext.js"
import { withNote } from "./lateStart.js"
import { normalizeRows } from "./normalize.js"
import { currentSignal } from "./requestContext.js"
import { runWithConcurrency } from "./transport.js"

/** `gangtise_fund_etf_pcf_components`：接口只返回成分名称、不返回代码，这里按名称补上 `componentCode`。
 *  接口自带代码的行原样保留，所以接口恢复返回代码后本模块即为空操作——届时连同调用点一起删掉。
 *
 *  名称先在全市场证券列表里找（每次调用取一次），找不到再走证券搜索；候选再用该行的 `close` 核对：
 *  这个价格就是该成分所在市场的某个近期收盘价（14 只 ETF 实测：A 股、港股、美股、A+H、债券、黄金）。
 *  先比实时行情的最新价与昨收，比不上的再按清单价格所属的那天（`listDates`，A 股与港股各自定日）比日 K
 *  收盘价。同一公司的 A 股与 H 股在 A+H ETF 里是同名两行，只能靠价格分开；候选跨市场时，实时价相符还要
 *  另一市场那只的近期收盘价都对不上才算数（清单价格落后于行情时，它的实时价可能碰巧等于该行）。价格定不了时
 *  （除权除息当天、停牌、没有行情的债券），只有确知成分都在一个市场的 ETF 才按完全同名取该市场的那只（同市场
 *  多只取 ETF 自己的交易所）；成分跨市场、或有一行可能在两个市场又没定下来时，这些行都留 null。 */

interface Candidate { code: string; name: string; category: string; prefix: boolean }

/** 补代码需要的三种查询，测试可以不经 HTTP 驱动。 */
export interface CodeLookup {
  /** 按关键字找证券，行形同 securities-search。 */
  search(keyword: string): Promise<unknown[]>
  /** 实时行情知道的代码 → [昨收, 最新价]。 */
  quotes(codes: string[]): Promise<Map<string, number[]>>
  /** 两个日期之间每只的日收盘价，旧在前：给价格落后行情一天以上的清单用。没有它时这类行交给名称判。 */
  closes?(codes: string[], startDate: string, endDate: string): Promise<Map<string, Array<[date: string, close: number]>>>
}

type Row = Record<string, unknown>

/** 成分的 close 就是行情价本身：14 只 ETF（2026-10-27）里每个确认的行都分毫不差，而同名在另一市场的
 *  上市最近只差 0.15%（同一公司的 A 股与 H 股，常见 0.3%）。容差远小于这个间距。 */
const PRICE_TOLERANCE = 0.0005
const agrees = (close: number, price: number) => price > 0 && Math.abs(close - price) / price <= PRICE_TOLERANCE
/** 实时行情收的代码格式；别的一律不发（债券、其他市场的上市、搜索返回的占位代码）。 */
const QUOTABLE = /^(\d{6}\.(SH|SZ|BJ)|\d{5}\.HK|[A-Z][A-Z0-9.]*\.(O|N|A))$/
const QUOTE_BATCH = 500
/** 日 K 往回取这么多个自然日：清单价格落后于它的交易日（10-28 盘前发布的清单，A 股是 10-26 的收盘、
 *  港股是 10-27 的；当天晚些时候各前移一天），还要跨过长周末。 */
const CLOSES_WINDOW_DAYS = 10
/** 日 K 的取数区间（北京时间日期）。 */
export function closesWindow(now = new Date()): { startDate: string; endDate: string } {
  return { startDate: today(new Date(now.getTime() - CLOSES_WINDOW_DAYS * 86_400_000)), endDate: today(now) }
}
/** 每次日 K 请求的代码数：窗口内交易日数 × 它不超过单次 10000 行。 */
const CLOSES_BATCH = 1000

const squash = (name: string) => name.replace(/\s+/g, "")
/** 交易所简称不带搜索结果里的份额后缀（「小米集团-W」）。 */
const base = (name: string) => squash(name).replace(/-[A-Z]+$/, "")
const ticker = (code: string) => code.slice(0, code.lastIndexOf("."))
const exchange = (code: string) => code.slice(code.lastIndexOf(".") + 1)
const market = (code: string) => {
  const suffix = exchange(code)
  return ["SH", "SZ", "BJ"].includes(suffix) ? "CN" : ["O", "N", "A"].includes(suffix) ? "US" : suffix
}

function toCandidates(rows: unknown[]): Candidate[] {
  return rows.flatMap((row) => {
    const r = row as Row
    return typeof r.gtsCode === "string" && typeof r.gtsName === "string" && r.category !== "index"
      ? [{ code: r.gtsCode, name: r.gtsName, category: String(r.category), prefix: false }]
      : []
  })
}

/** 一个成分名称可能对应的上市：名称（或 ticker）完全一致的，以及只是以它开头的——交易所会截断长名称
 *  （「比亚迪电」），港股的名称也可能比 A 股长（「中国石油」/「中国石油股份」）。前缀匹配必须有价格印证
 *  （见 `byPrice` / `byName`）。模糊搜索漏掉的美股 ticker 带交易所后缀再搜一次。 */
async function candidatesFor(name: string, lookup: CodeLookup): Promise<Candidate[]> {
  const key = squash(name)
  const found = toCandidates(await lookup.search(key))
  const exact = found.filter((c) => base(c.name) === base(key) || ticker(c.code) === key)
  // 「TRI」按 ticker 搜到的是 TRI.LON，搜不到汤森路透的 TRI.O。
  if (/^[A-Z][A-Z0-9]{0,6}$/.test(key) && !exact.some((c) => market(c.code) === "US")) {
    const bySuffix = (await Promise.all(["O", "N"].map((suffix) => lookup.search(`${key}.${suffix}`))))
      .flatMap((rows) => toCandidates(rows))
      .filter((c) => ticker(c.code) === key)
    exact.push(...bySuffix)
  }
  const prefix = base(key).length >= 2 ? found.filter((c) => !exact.includes(c) && base(c.name).startsWith(base(key))) : []
  return [...exact, ...prefix.map((c) => ({ ...c, prefix: true }))]
}

/** 几个候选同样符合时。跨市场的并列（同名的 A 股与 H 股）只在成分都在一个市场的 ETF 里才裁：跨市场的
 *  ETF 里名称说明不了是哪个上市，该行留 null。同市场内的并列（两个交易所都挂的债券）取 ETF 自己的交易所。 */
function narrow(candidates: Candidate[], etf: EtfContext): string | null {
  let left = candidates
  if (new Set(left.map((c) => market(c.code))).size > 1) {
    if (!etf.market) return null
    left = left.filter((c) => market(c.code) === etf.market)
  }
  if (left.length > 1) {
    const same = left.filter((c) => exchange(c.code) === etf.exchange)
    if (same.length) left = same
  }
  return left.length === 1 ? left[0].code : null
}

/** `market`：已知的一切都指向成分只在一个市场时才设；成分跨市场（A+H ETF）或尚不知道时为 undefined。 */
interface EtfContext { market?: string; exchange: string; used: Set<string> }

/** 价格与该行 close 相符的上市：先完全同名的，再前缀匹配的。没有相符的返回 undefined；同一层里有上市
 *  没价格可核（没有，或停牌报 0）而 `unchecked` 说它仍可能是这一行时也返回 undefined——旁边的相符说明不了什么。 */
function byPrice(row: Row, candidates: Candidate[], prices: Map<string, number[]>, etf: EtfContext, unchecked: (c: Candidate) => boolean): string | null | undefined {
  const close = typeof row.close === "number" ? row.close : undefined
  if (close === undefined) return undefined
  const open = candidates.filter((c) => !etf.used.has(c.code))
  for (const tier of [open.filter((c) => !c.prefix), open.filter((c) => c.prefix)]) {
    if (tier.some((c) => !prices.get(c.code)?.some((p) => p > 0) && unchecked(c))) return undefined
    const matched = tier.filter((c) => prices.get(c.code)?.some((p) => agrees(close, p)))
    if (matched.length) return narrow(matched, etf)
  }
  return undefined
}

/** 没有价格相符：除权除息日的昨收偏离清单价、停牌报 0、债券没有行情、行情请求失败。成分都在一个市场的
 *  ETF 里，该市场完全同名的那只成立；跨市场的 ETF 里都不成立——行情对不上排除不了一个上市（除权、停牌），
 *  没有行情也认定不了，名称说明不了这一行是哪个上市。前缀匹配从不单凭名称成立。 */
function byName(candidates: Candidate[], etf: EtfContext): string | null {
  if (!etf.market) return null
  const pool = candidates.filter((c) => !c.prefix && !etf.used.has(c.code) && market(c.code) === etf.market)
  return pool.length ? narrow(pool, etf) : null
}

/** 一批里有一个行情不认识的代码，整批报 120001：对半拆、一半一半地发，直到出错的代码单独成批，不给它
 *  价格。其他失败（限流、鉴权、故障）整批不给价格：拆开只会成倍地发请求。 */
async function splitting<T>(codes: string[], fetch: (codes: string[]) => Promise<Map<string, T>>): Promise<Map<string, T>> {
  try {
    return await fetch(codes)
  } catch (error) {
    if (codes.length === 1 || (error as { code?: unknown })?.code !== "120001") return new Map()
    const half = Math.ceil(codes.length / 2)
    const first = await splitting(codes.slice(0, half), fetch)
    return new Map([...first, ...await splitting(codes.slice(half), fetch)])
  }
}

const inBatches = (codes: string[], size: number) => Array.from({ length: Math.ceil(codes.length / size) }, (_, i) => codes.slice(i * size, (i + 1) * size))

/** 本 ETF 清单价格按市场各属哪个交易日——同一份清单的 A 股可以是一天的收盘、H 股是另一天的：在该市场里
 *  只有一个完全同名上市的行中，与那只收盘价相符最多的那天。至少两行同指一天、且没有别的日子并列，才定得下。 */
function listDates(rows: Row[], candidates: Map<string, Candidate[]>, history: Map<string, Array<[string, number]>>): Map<string, string> {
  const votes = new Map<string, Map<string, number>>()
  for (const row of rows) {
    if (typeof row.close !== "number") continue
    const exact = (candidates.get(row.componentName as string) ?? []).filter((c) => !c.prefix)
    if (exact.length !== 1) continue
    const tally = votes.get(market(exact[0].code)) ?? new Map<string, number>()
    for (const [date, close] of history.get(exact[0].code) ?? []) {
      if (agrees(row.close, close)) tally.set(date, (tally.get(date) ?? 0) + 1)
    }
    votes.set(market(exact[0].code), tally)
  }
  const dates = new Map<string, string>()
  for (const [where, tally] of votes) {
    const ranked = [...tally].sort((a, b) => b[1] - a[1])
    if (ranked.length && ranked[0][1] >= 2 && ranked[1]?.[1] !== ranked[0][1]) dates.set(where, ranked[0][0])
  }
  return dates
}

/** 每只在其市场那天的收盘价，那天没有（市场休市、停牌）就取之前最近的一个。 */
function closesOn(dates: Map<string, string>, history: Map<string, Array<[string, number]>>): Map<string, number[]> {
  const out = new Map<string, number[]>()
  for (const [code, series] of history) {
    const date = dates.get(market(code))
    if (!date) continue
    const last = series.filter(([d]) => d <= date).at(-1)
    if (last) out.set(code, [last[1]])
  }
  return out
}

export interface FilledComponents {
  rows: Row[]
  /** 没补上代码的行：现金行、商品、没有把握的名称。 */
  unresolved: Array<{ fundCode: unknown; serialNumber: unknown; componentName: unknown }>
}

/** 接口自己带了代码的行；`null` 或空串不算。 */
const carriesCode = (row: Row) => typeof row.componentCode === "string" && row.componentCode !== ""
const needsCode = (row: Row) => !carriesCode(row) && typeof row.componentName === "string"

export async function fillComponentCodes(rows: Row[], lookup: CodeLookup): Promise<FilledComponents> {
  const signal = currentSignal()
  const pending = rows.filter(needsCode)
  const names = [...new Set(pending.map((r) => r.componentName as string))]
  const candidates = new Map<string, Candidate[]>()
  // 查不到的名称没有候选即可：成分清单本身已经取到（并已计费），无论这里发生什么都照常返回。
  await runWithConcurrency(names, PAGE_CONCURRENCY, async (name) => {
    candidates.set(name, await candidatesFor(name, lookup).catch(() => []))
  }, signal)
  const isQuotable = (c: Candidate) => ["stock", "dr"].includes(c.category) && QUOTABLE.test(c.code)
  const quotable = [...new Set([...candidates.values()].flat().filter(isQuotable).map((c) => c.code))]
  const prices = new Map((await runWithConcurrency(inBatches(quotable, QUOTE_BATCH), PAGE_CONCURRENCY, (batch) => splitting(batch, (codes) => lookup.quotes(codes)), signal)).flatMap((quoted) => [...quoted]))

  const codes = new Map<Row, string | null>()
  const etfs = new Map<unknown, { own: Row[]; etf: EtfContext }>()
  const place = (row: Row, code: string | null, etf: EtfContext) => {
    codes.set(row, code)
    if (code) etf.used.add(code)
  }
  const candidatesOf = (row: Row) => candidates.get(row.componentName as string) ?? []
  // 实时价相符、但另一市场还有可报价的候选：清单价格落后于行情时，该行自己那只的实时价对不上，另一市场那只的
  // 实时价却可能碰巧等于它。这类行先不定，取到日 K 再看另一市场的候选有没有近期收盘价也与它相符。
  const unverified = new Map<Row, string>()
  // 先用价格过一遍全部行：价格印证了的上市先给它的行，同名的另一行（A+H 的另一类股份）不能凭名称抢走。
  for (const fundCode of new Set(pending.map((r) => r.fundCode))) {
    const own = pending.filter((r) => r.fundCode === fundCode)
    const etf: EtfContext = { exchange: exchange(String(fundCode)), used: new Set() }
    etfs.set(fundCode, { own, etf })
    for (const row of own) {
      // 行情没覆盖到的上市在下面按日 K 核对。
      const code = byPrice(row, candidatesOf(row), prices, etf, isQuotable)
      if (code === undefined) continue
      if (code && candidatesOf(row).some((c) => isQuotable(c) && market(c.code) !== market(code))) unverified.set(row, code)
      else place(row, code, etf)
    }
  }
  // 清单价格落后行情一天以上时这些行没定下来，停牌与除权除息日也是：按清单价格在各市场所属那天的日 K 核对。
  const open = (own: Row[]) => own.filter((r) => !codes.has(r) && typeof r.close === "number" && candidatesOf(r).some(isQuotable))
  const lagging = [...etfs.values()].filter(({ own }) => open(own).length)
  const history = new Map<string, Array<[string, number]>>()
  if (lagging.length && lookup.closes) {
    const wanted = [...new Set(lagging.flatMap(({ own }) => own.flatMap((r) => candidatesOf(r).filter(isQuotable).map((c) => c.code))))]
    const { startDate, endDate } = closesWindow()
    for (const part of await runWithConcurrency(inBatches(wanted, CLOSES_BATCH), PAGE_CONCURRENCY, (batch) => splitting(batch, (codes) => lookup.closes!(codes, startDate, endDate)), signal)) {
      for (const [code, series] of part) history.set(code, series)
    }
  }
  for (const { own, etf } of etfs.values()) {
    for (const row of own) {
      const code = unverified.get(row)
      if (code === undefined) continue
      // 另一市场的候选（未被别的行占用）近期有收盘价与该行相符，或取不到它的日 K：它也可能就是这一行，实时价的相符不作数，
      // 留给下面按清单所属那天核对。没有日 K 可查时（lookup 不带 closes）按实时价定。这只已被别的行占用时同样不定。
      const contested = lookup.closes !== undefined && candidatesOf(row).some((c) => isQuotable(c) && !etf.used.has(c.code) && market(c.code) !== market(code)
        && (history.get(c.code)?.some(([, close]) => agrees(row.close as number, close)) ?? true))
      if (!contested && !etf.used.has(code)) place(row, code, etf)
    }
  }
  if (lagging.length && lookup.closes) {
    for (const { own, etf } of lagging) {
      const dates = listDates(own, candidates, history)
      const onDate = closesOn(dates, history)
      for (const row of open(own)) {
        // 在其市场那天没有收盘价的上市（那个市场没定下日子，或这只没有日 K），只有近期收盘价没一个相符才排除。
        const unchecked = (c: Candidate) => isQuotable(c) && (history.get(c.code)?.some(([, close]) => agrees(row.close as number, close)) ?? true)
        const code = byPrice(row, candidatesOf(row), onDate, etf, unchecked)
        if (code !== undefined) place(row, code, etf)
      }
    }
  }
  for (const { own, etf } of etfs.values()) {
    // 本 ETF 持有哪些市场，就已知的而言：价格印证过的上市，以及没定下代码的行里、未被占用的候选都在一个市场的名称。
    // 没定下的行里有一个名称的候选跨市场（同名的 A 股与 H 股，或港股名称更长的同一公司：「中国石油」/「中国石油股份」），
    // 那一行在哪个市场就不知道，本 ETF 是否只在一个市场也就判断不了——不凭其余几行定整只 ETF 的市场，名称兜底一行都
    // 不做。前缀候选只在这里算作「可能是它」，填代码仍只认完全同名（byName）。
    const markets = new Set([...etf.used].map(market))
    let undecided = false
    for (const r of own) {
      if (codes.get(r)) continue
      const held = new Set(candidatesOf(r).filter((c) => !etf.used.has(c.code)).map((c) => market(c.code)))
      if (held.size > 1) undecided = true
      else if (held.size === 1) markets.add([...held][0])
    }
    if (!undecided && markets.size === 1) etf.market = [...markets][0]
    for (const row of own) if (!codes.has(row)) place(row, byName(candidatesOf(row), etf), etf)
  }

  const unresolved: FilledComponents["unresolved"] = []
  const filled = rows.map((row) => {
    if (!codes.has(row)) return row
    const code = codes.get(row) ?? null
    if (!code) unresolved.push({ fundCode: row.fundCode, serialNumber: row.serialNumber, componentName: row.componentName })
    // 放在接口原先放它的位置（serialNumber 之后）。
    const out: Row = {}
    for (const [key, value] of Object.entries(row)) {
      if (key === "componentCode") continue
      out[key] = value
      if (key === "serialNumber") out.componentCode = code
    }
    if (!("componentCode" in out)) out.componentCode = code
    return out
  })
  return { rows: filled, unresolved }
}

/** 补上 `componentCode` 的成分清单（没有把握的为 null），`_note` 说明代码是按名称匹配的、列出留 null 的行。
 *  返回形状不变。 */
export async function addComponentCodes(data: unknown, lookup: CodeLookup): Promise<unknown> {
  const list = (data as { list?: unknown })?.list
  if (!Array.isArray(list)) return data
  const rows = list as Row[]
  const pending = rows.filter(needsCode).length
  if (!pending) return data
  const filled = await fillComponentCodes(rows, lookup)
  const left = filled.unresolved.map((u) => `${String(u.fundCode)} ${String(u.componentName)}`)
  const shown = left.length > 20 ? `${left.slice(0, 20).join("、")} 等 ${left.length} 行` : left.join("、")
  return withNote(
    { ...(data as object), list: filled.rows },
    `componentCode 由本工具按成分名称匹配补上（查证券列表，能取到行情的再用该行 close 核对价格）：${pending} 行中补上 ${pending - left.length} 行${left.length ? `；为 null 的（现金行、商品、没有把握的名称）：${shown}` : ""}`,
  )
}

/** 全部上市股票的代码与名称：板块成分里的三个全市场板块——全部A股、全部港股、全部美股。每个一次请求，
 *  省掉逐个名称搜索。不跨调用缓存：三个一起取不到一秒。 */
const MARKET_SECTORS = ["1000000002", "1000002615", "1000002618"]

type Listing = [code: string, name: string]

/** 三个市场的上市。任一市场失败或为空时为 undefined——缺一个市场的表会把 A+H 名称的 H 股行放进 A 股——
 *  此时改走搜索。 */
export async function loadSecurityTable(fetchSector: (sectorId: string) => Promise<unknown>): Promise<Listing[] | undefined> {
  try {
    const markets = await Promise.all(MARKET_SECTORS.map(async (sectorId) => {
      const data = await fetchSector(sectorId) as { list?: unknown }
      const list = (Array.isArray(data?.list) ? data.list : []).flatMap((row): Listing[] => {
        const r = row as Row
        return typeof r.gtsCode === "string" && typeof r.gtsName === "string" ? [[r.gtsCode, r.gtsName]] : []
      })
      if (!list.length) throw new Error(`sector ${sectorId} listed nothing`)
      return list
    }))
    return markets.flat()
  } catch {
    return undefined
  }
}

/** 在表上搜，行形同 securities-search：名称（或 ticker、代码）完全一致的上市，加上名称以它开头的。没有
 *  完全一致的时为 undefined——债券、被交易所截断的名称、现金行——交给知道的不止股票的搜索服务。 */
export function tableSearch(list: Listing[]): (keyword: string) => unknown[] | undefined {
  const byBase = new Map<string, Listing[]>()
  const byTicker = new Map<string, Listing[]>()
  const byCode = new Map<string, Listing>()
  const add = (index: Map<string, Listing[]>, key: string, listing: Listing) => {
    const listed = index.get(key)
    if (listed) listed.push(listing)
    else index.set(key, [listing])
  }
  for (const listing of list) {
    add(byBase, base(listing[1]), listing)
    add(byTicker, ticker(listing[0]), listing)
    byCode.set(listing[0], listing)
  }
  const bases = [...byBase.keys()]
  return (keyword) => {
    const key = squash(keyword)
    const name = base(key)
    const coded = byCode.get(key)
    const exact = [...(byBase.get(name) ?? []), ...(byTicker.get(key) ?? []), ...(coded ? [coded] : [])]
    if (!exact.length) return undefined
    const prefix = name.length >= 2 ? bases.filter((b) => b !== name && b.startsWith(name)).flatMap((b) => byBase.get(b)!) : []
    return [...new Set([...exact, ...prefix])].map(([gtsCode, gtsName]) => ({ gtsCode, gtsName, category: "stock" }))
  }
}

/** 接真实 client 的查询：名称先查证券表（每个 lookup 取一次），表里没有的再走证券搜索；实时行情取昨收与最新价。 */
export function clientLookup(client: { call(endpointKey: string, body?: unknown): Promise<unknown> }): CodeLookup {
  let table: Promise<((keyword: string) => unknown[] | undefined) | undefined> | undefined
  const local = () => (table ??= loadSecurityTable((sectorId) => client.call("reference.sector-constituents", { sectorId })).then((list) => list && tableSearch(list)))
  const listOf = (data: unknown) => {
    const rows = normalizeRows(data)
    return (Array.isArray(rows) ? rows : ((rows as { list?: unknown[] })?.list ?? [])) as Row[]
  }
  return {
    async search(keyword) {
      const hits = (await local())?.(keyword)
      if (hits) return hits
      const data = await client.call("reference.securities-search", { keyword, top: 10 }) as { list?: unknown }
      return Array.isArray(data?.list) ? data.list : []
    },
    async closes(codes, startDate, endDate) {
      const out = new Map<string, Array<[string, number]>>()
      for (const k of listOf(await client.call("quote.day-kline", { securityList: codes, startDate, endDate, fieldList: ["securityCode", "tradeDate", "close"], limit: 10_000 }))) {
        if (typeof k.securityCode !== "string" || typeof k.tradeDate !== "string" || typeof k.close !== "number") continue
        const series = out.get(k.securityCode) ?? []
        series.push([k.tradeDate, k.close])
        out.set(k.securityCode, series)
      }
      for (const series of out.values()) series.sort((a, b) => (a[0] < b[0] ? -1 : 1))
      return out
    },
    async quotes(codes) {
      const out = new Map<string, number[]>()
      for (const q of listOf(await client.call("quote.realtime", { securityList: codes }))) {
        const prices = [q.preClose, q.latestPrice].filter((p): p is number => typeof p === "number")
        if (typeof q.securityCode === "string" && prices.length) out.set(q.securityCode, prices)
      }
      return out
    },
  }
}
