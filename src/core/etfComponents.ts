import { PAGE_CONCURRENCY } from "./config.js"
import { today } from "./dateContext.js"
import { withNote } from "./lateStart.js"
import { normalizeRows } from "./normalize.js"
import { currentSignal } from "./requestContext.js"
import { runWithConcurrency } from "./transport.js"

/** `gangtise_fund_etf_pcf_components`：接口只返回成分名称、不返回代码，这里按名称补上 `componentCode`。
 *  接口自带代码的行原样保留，所以接口恢复返回代码后本模块即为空操作——届时连同调用点一起删掉。
 *
 *  名称先在全市场证券列表里找（每次调用取一次），找不到再走证券搜索；它可能对应的每只上市都拿该行的 `close`
 *  核对：这个价格就是该成分自己那只上市的某个近期日收盘价（14 只 ETF 实测：A 股、港股、美股、A+H、债券、黄金）。
 *  一条规则（`view`）说清一只上市在该行价格可能所属的那些天里已知什么：它的日 K 收盘价（按日期），日 K 之后是
 *  实时行情的最新价与昨收。排除一只要有证据：近期每个交易日都看得到、且没有一天收在该行的 close；有一天看不到，
 *  它就仍算可能。一处（`decide`）定一行，只定给一只上市：按价格——仍可能的上市只剩一只、且它在确定的某天收在
 *  该行 close（A+H ETF 里同名的 A 股与 H 股两行据此分开）；否则按该行自己的 `pctChange`——只有一只上市在某天
 *  同时对上收盘价与涨跌幅，其余仍可能的上市在该收盘价的日子涨跌幅都不同。证据分不开的两只上市是两只证券，该行
 *  留 null。一行定下后它的上市不再是别的行的候选，其余行重新核对，直到没有变化；两行同时选中的那只谁也不给，
 *  所以结果与行的顺序无关。
 *  没有价格可选时（债券、行情不认识的上市），在确知成分都在一个市场的 ETF 里才按完全同名取：取仍可能的那一只
 *  能核价的上市，或在不能核价的里取（同一只债券两个交易所都挂时取 ETF 自己的交易所）；能核价的上市仍可能的不止
 *  一只时，名称谁也不选。还有一行可能在两个市场（同名 A / H 股，或港股名称以该行名称开头）没定下来、或有名称
 *  查询失败时，ETF 的市场就不算确知；这时与成分跨市场的 ETF 一样，价格没定下的行都留 null。行情或日 K 请求
 *  失败什么都看不到：它要查的那些上市仍算可能。 */

interface Candidate { code: string; name: string; category: string; prefix: boolean }

/** 补代码需要的三种查询，测试可以不经 HTTP 驱动。 */
export interface CodeLookup {
  /** 按关键字找证券，行形同 securities-search。 */
  search(keyword: string): Promise<unknown[]>
  /** 实时行情知道的代码 → 昨收、最新价与最新价所属交易日。 */
  quotes(codes: string[]): Promise<Map<string, Quote>>
  /** 两个日期之间每只的日收盘价，旧在前，昨收已知时附当天涨跌幅（%）：给价格落后行情一天以上的清单、以及名称
   *  对应不止一只上市的行用。没有它就没有日 K：哪只上市都不排除，名称对应几只上市的行留 null。 */
  closes?(codes: string[], startDate: string, endDate: string): Promise<Map<string, Bar[]>>
}

type Row = Record<string, unknown>
type Bar = [date: string, close: number, change?: number]
/** `date`：YYYY-MM-DD，`latest` 所属的交易日。 */
export interface Quote { previous?: number; latest?: number; date?: string }

/** YYYY-MM-DD 前一个工作日。 */
function weekdayBefore(day: string): string {
  const d = new Date(`${day}T00:00:00Z`)
  do d.setUTCDate(d.getUTCDate() - 1)
  while (d.getUTCDay() === 0 || d.getUTCDay() === 6)
  return d.toISOString().slice(0, 10)
}

/** 成分的 close 就是行情价本身：14 只 ETF（2026-10-27）里每个确认的行都分毫不差，而同名在另一市场的
 *  上市最近只差 0.15%（同一公司的 A 股与 H 股，常见 0.3%）。容差远小于这个间距。 */
const PRICE_TOLERANCE = 0.0005
const agrees = (close: number, price: number) => price > 0 && Math.abs(close - price) / price <= PRICE_TOLERANCE
/** 一行的 `pctChange` 是它那只证券在该行 close 所属那天的涨跌幅——收盘价比昨收，清单保留四位小数（45 只 ETF
 *  实测，2026-11-07；美股一行差过一次，多半是除权除息日）。与收盘价合起来是第二个指纹：同名 A / H 股收盘价碰巧
 *  相同的那天，涨跌幅不会也相同。它只在价格留下的几个上市之间裁，从不排除价格已印证的那只。 */
const CHANGE_TOLERANCE = 0.005
/** 实时行情收的代码格式；别的一律不发（债券、其他市场的上市、搜索返回的占位代码）。 */
const QUOTABLE = /^(\d{6}\.(SH|SZ|BJ)|\d{5}\.HK|[A-Z][A-Z0-9.]*\.(O|N|A))$/
const QUOTE_BATCH = 500
/** 日 K 往回取这么多个自然日：清单价格落后于它的交易日（10-28 盘前发布的清单，A 股是 10-26 的收盘、
 *  港股是 10-27 的；当天晚些时候各前移一天），长假之后窗口里也要有 `SESSIONS` 个交易日。 */
const CLOSES_WINDOW_DAYS = 20
/** 日 K 的取数区间（北京时间日期）。 */
export function closesWindow(now = new Date()): { startDate: string; endDate: string } {
  return { startDate: today(new Date(now.getTime() - CLOSES_WINDOW_DAYS * 86_400_000)), endDate: today(now) }
}
/** 每次日 K 请求的代码数：窗口内交易日数 × 它不超过单次 10000 行。 */
const CLOSES_BATCH = 600

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
 *  （「比亚迪电」），港股的名称也可能比 A 股长（「中国石油」/「中国石油股份」）。前缀匹配从不单凭名称成立。
 *  模糊搜索漏掉的美股 ticker 带交易所后缀再搜一次。 */
async function candidatesFor(name: string, lookup: CodeLookup): Promise<Candidate[]> {
  const key = squash(name)
  const found = toCandidates(await lookup.search(key))
  const exact = found.filter((c) => base(c.name) === base(key) || ticker(c.code) === key)
  // 「TRI」按 ticker 搜到的是 TRI.LON，搜不到汤森路透的 TRI.O。
  if (/^[A-Z][A-Z0-9]{0,6}$/.test(key) && !exact.some((c) => market(c.code) === "US")) {
    const bySuffix = (await Promise.all(["O", "N"].map((suffix) => lookup.search(`${key}.${suffix}`))))
      .flatMap((rows) => toCandidates(rows))
      .filter((c) => ticker(c.code) === key)
    // 两次搜索可能搜到同一只：算一个候选，不算和自己并列。
    for (const c of bySuffix) if (!exact.some((e) => e.code === c.code)) exact.push(c)
  }
  const prefix = base(key).length >= 2 ? found.filter((c) => !exact.includes(c) && base(c.name).startsWith(base(key))) : []
  return [...exact, ...prefix.map((c) => ({ ...c, prefix: true }))]
}

/** 在 ETF 那一个市场的完全同名上市里取：只有一只就是它；两个交易所都挂的同一只债券取 ETF 自己的交易所。 */
function narrow(candidates: Candidate[], etf: EtfContext): string | null {
  const same = candidates.filter((c) => exchange(c.code) === etf.exchange)
  const left = candidates.length > 1 && same.length ? same : candidates
  return left.length === 1 ? left[0].code : null
}

/** `market`：已知的一切都指向成分只在一个市场时才设；成分跨市场（A+H ETF）或尚不知道时为 undefined。
 *  `contested`：最近一轮里被两行同时选中的上市（见 `placeAlone`）。 */
interface EtfContext { market?: string; exchange: string; used: Set<string>; contested: Set<string> }

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

export interface FilledComponents {
  rows: Row[]
  /** 没补上代码的行：现金行、商品、没有把握的名称。 */
  unresolved: Array<{ fundCode: unknown; serialNumber: unknown; componentName: unknown }>
}

/** 接口自己带了代码的行；`null` 或空串不算。 */
const carriesCode = (row: Row) => typeof row.componentCode === "string" && row.componentCode !== ""
const needsCode = (row: Row) => !carriesCode(row) && typeof row.componentName === "string"

/** 清单价格最多落后几个交易日：见过清单带着交易日前两个交易日的收盘价（2026-10-28 盘前）。排除一只上市要它的
 *  日 K 至少有这么多个交易日、没有一天收在该行 close，且行情看得到其后的日子。 */
const SESSIONS = 4

/** 这只上市收在该行 close 的一天，知道的话附当天涨跌幅。`sure`：确定的某一天——清单日，或行情的两个交易日
 *  之一——而不是它近期的任意一天。 */
interface Fit { change?: number; sure: boolean }
/** 一只上市对一行已知什么：它收在该行 close 的那些天，以及 `open`——该行价格可能所属、却什么都没覆盖到的一天。 */
interface View { fits: Fit[]; open: boolean }

export async function fillComponentCodes(rows: Row[], lookup: CodeLookup): Promise<FilledComponents> {
  const signal = currentSignal()
  const pending = rows.filter(needsCode)
  const names = [...new Set(pending.map((r) => r.componentName as string))]
  const candidates = new Map<string, Candidate[]>()
  // 查不到的名称没有候选——成分清单本身已经取到（并已计费），无论这里发生什么都照常返回——而含它的 ETF 在哪个
  // 市场也就不知道了：这个名称可能在其余各行都没显出的市场。
  const failed = new Set<string>()
  await runWithConcurrency(names, PAGE_CONCURRENCY, async (name) => {
    try {
      candidates.set(name, await candidatesFor(name, lookup))
    } catch {
      candidates.set(name, [])
      failed.add(name)
    }
  }, signal)
  const isQuotable = (c: Candidate) => ["stock", "dr"].includes(c.category) && QUOTABLE.test(c.code)
  const quotable = [...new Set([...candidates.values()].flat().filter(isQuotable).map((c) => c.code))]
  const quotes = new Map((await runWithConcurrency(inBatches(quotable, QUOTE_BATCH), PAGE_CONCURRENCY, (batch) => splitting(batch, (codes) => lookup.quotes(codes)), signal)).flatMap((quoted) => [...quoted]))
  const candidatesOf = (row: Row) => candidates.get(row.componentName as string) ?? []
  const marketsOf = (listed: Candidate[]) => new Set(listed.map((c) => market(c.code)))

  const codes = new Map<Row, string | null>()
  const etfs = new Map<unknown, { own: Row[]; etf: EtfContext }>()
  const place = (row: Row, code: string | null, etf: EtfContext) => {
    codes.set(row, code)
    if (code) etf.used.add(code)
  }
  /** 把各行选中的上市填上，但两行同时选中的那只谁也不给：它归谁不能取决于谁排在前面。返回有没有填上哪一行，
   *  并把两行同时选中的上市记进 `etf.contested`。 */
  const placeAlone = (picks: Map<Row, string>, etf: EtfContext) => {
    const taken = [...picks.values()]
    etf.contested = new Set(taken.filter((code) => taken.indexOf(code) !== taken.lastIndexOf(code)))
    let placed = false
    for (const [row, code] of picks) if (!etf.contested.has(code)) { place(row, code, etf); placed = true }
    return placed
  }
  const quoteFits = (close: number, c: Candidate) => {
    const q = quotes.get(c.code)
    return [q?.previous, q?.latest].some((p) => typeof p === "number" && agrees(close, p))
  }
  // 名称只对应一只上市的行，实时行情对得上就定：没有别的要排除。指总共只有一只——另一只被别的行占用后才剩
  // 一只的名称，和其余行一样核对（`decide`），否则结果取决于两行谁在前。
  for (const fundCode of new Set(pending.map((r) => r.fundCode))) {
    const own = pending.filter((r) => r.fundCode === fundCode)
    const etf: EtfContext = { exchange: exchange(String(fundCode)), used: new Set(), contested: new Set() }
    etfs.set(fundCode, { own, etf })
    const picks = new Map<Row, string>()
    for (const row of own) {
      if (typeof row.close !== "number") continue
      const listed = candidatesOf(row).filter(isQuotable)
      if (listed.length === 1 && quoteFits(row.close, listed[0])) picks.set(row, listed[0].code)
    }
    placeAlone(picks, etf)
  }
  const unsettled = (own: Row[]) => own.filter((r) => !codes.has(r) && typeof r.close === "number" && candidatesOf(r).some(isQuotable))
  const waiting = [...etfs.values()].filter(({ own }) => unsettled(own).length)
  const history = new Map<string, Bar[]>()
  if (waiting.length && lookup.closes) {
    const wanted = [...new Set(waiting.flatMap(({ own }) => own.flatMap((r) => candidatesOf(r).filter(isQuotable).map((c) => c.code))))]
    const { startDate, endDate } = closesWindow()
    for (const part of await runWithConcurrency(inBatches(wanted, CLOSES_BATCH), PAGE_CONCURRENCY, (batch) => splitting(batch, (codes) => lookup.closes!(codes, startDate, endDate)), signal)) {
      for (const [code, series] of part) history.set(code, series)
    }
  }

  /** 唯一的一条规则：上市 `c` 在该行价格可能所属的那些天里已知什么；填一行、排除一只的每一步都问它。交易日按
   *  日期分、不按价格（收盘价会重复）。日 K 覆盖它的第一天到最后一天的每个交易日：停牌的上市也每天有一根，收盘价
   *  不变。日 K 之后，行情给出它自己那天（`latest`）与前一个交易日（`previous`）；日 K 到了行情那天且之前还有一根，
   *  或日 K 止于行情那天的前一个工作日，才算日 K 看得到那个交易日。那个工作日若是假日就看不到：这只仍算可能。
   *  `fits` 是它收在该行 close 的每个交易日；近期交易日都看得到（`covered`）且没有一天收在 close，才排除它。清单日
   *  已知时只用来定哪一天是 `sure`：在近期别的交易日收在 close 的上市不因此排除——同一市场的各行不一定同一天，
   *  从少数几行推出的日子也可能错。 */
  const view = (row: Row, c: Candidate): View => {
    const close = row.close as number
    const bars = history.get(c.code) ?? []
    const { previous, latest, date } = quotes.get(c.code) ?? {}
    const onLatest = latest !== undefined && agrees(close, latest)
    const onPrevious = previous !== undefined && agrees(close, previous)
    const last = bars.at(-1)?.[0]
    const showsQuoteDay = date !== undefined && last !== undefined && last >= date
    const previousBar = date === undefined ? undefined : bars.filter(([d]) => d < date).at(-1)
    const showsPrevious = previousBar !== undefined && (showsQuoteDay || previousBar[0] >= weekdayBefore(date!))
    // 收在 close 的那天只有行情看得到：行情自己那天，或它的前一个交易日。
    const onQuoteDay = onLatest && !showsQuoteDay
    const onDayBefore = onPrevious && !showsPrevious
    // 近期交易日都看得到：日 K 够数，且行情接在日 K 之后。
    const covered = date !== undefined && (showsQuoteDay || showsPrevious) && bars.length >= SESSIONS
    const day = marketDays.get(row.fundCode)?.get(market(c.code))
    if (day === undefined) {
      const quoted = new Set<string>()
      if (onPrevious && showsPrevious) quoted.add(previousBar![0])
      if (onLatest && showsQuoteDay) quoted.add(date!)
      const fits: Fit[] = bars.filter(([, price]) => agrees(close, price)).map(([d, , change]) => ({ change, sure: quoted.has(d) }))
      if (onQuoteDay || onDayBefore) fits.push({ sure: true })
      return { fits, open: !covered }
    }
    // 清单日的收盘价：那天的日 K（那天没有就取之前最后一根），日 K 没跨到那天时取行情看得到的——行情自己那天或
    // 前一个交易日。清单日在第一根日 K 之前，就是一个看不到的交易日。
    const bar = last !== undefined && bars[0][0] <= day && day <= last ? bars.filter(([d]) => d <= day).at(-1) : undefined
    const fits: Fit[] = bars.filter(([, price]) => agrees(close, price)).map(([d, , change]) => (d === bar?.[0] ? { change: d === day ? change : undefined, sure: true } : { change, sure: false }))
    if (onQuoteDay) fits.push({ sure: bar === undefined && date === day })
    if (onDayBefore) fits.push({ sure: bar === undefined && date! > day && day >= weekdayBefore(date!) })
    return { fits, open: !covered || day < bars[0][0] }
  }
  /** 各 ETF 在各市场的清单日——同一份清单的 A 股可以是一天的收盘、H 股是另一天的：名称只对应一只上市的行里，
   *  收在那只收盘价上最多的那天——要超过这些行（对得上任何一天的）的一半、至少两行、没有并列。行情在日 K 看不到
   *  的交易日印证了该行价格的，也给那个交易日投一票；得票最多的是这样一个交易日时，该市场定不出日子。 */
  const marketDays = new Map<unknown, Map<string, string>>()
  for (const [fundCode, { own }] of etfs) {
    const tally = new Map<string, { voters: number; days: Map<string, number> }>()
    for (const row of own) {
      if (typeof row.close !== "number") continue
      const all = candidatesOf(row)
      if (all.length !== 1 || !isQuotable(all[0]) || !history.get(all[0].code)?.length) continue
      const days = new Set(history.get(all[0].code)!.filter(([, price]) => agrees(row.close as number, price)).map(([d]) => d))
      if (view(row, all[0]).fits.length > days.size) days.add("unseen")
      if (!days.size) continue
      const t = tally.get(market(all[0].code)) ?? { voters: 0, days: new Map<string, number>() }
      t.voters++
      for (const d of days) t.days.set(d, (t.days.get(d) ?? 0) + 1)
      tally.set(market(all[0].code), t)
    }
    const out = new Map<string, string>()
    for (const [where, { voters, days }] of tally) {
      const ranked = [...days].sort((x, y) => y[1] - x[1])
      if (ranked[0][0] !== "unseen" && ranked[0][1] >= 2 && ranked[0][1] * 2 > voters && ranked[1]?.[1] !== ranked[0][1]) out.set(where, ranked[0][0])
    }
    marketDays.set(fundCode, out)
  }

  /** 证据留给这一行的那只上市——留下一只时：分不开的两只是两只证券，该行留 null。 */
  const decide = (row: Row, etf: EtfContext): string | undefined => {
    const listed = candidatesOf(row).filter((c) => isQuotable(c) && !etf.used.has(c.code))
    const views = new Map(listed.map((c) => [c, view(row, c)]))
    const alive = listed.filter((c) => views.get(c)!.fits.length || views.get(c)!.open)
    // 仍可能的上市只剩一只，且它在确定的某天收在该行 close。
    if (alive.length === 1 && views.get(alive[0])!.fits.some((f) => f.sure)) return alive[0].code
    // 否则看该行自己的涨跌幅：只有一只上市在某天同时对上收盘价与涨跌幅，其余仍可能的上市只在涨跌幅不同的日子
    // 收在该 close。
    if (typeof row.pctChange !== "number") return undefined
    const change = row.pctChange
    const strong = alive.filter((c) => views.get(c)!.fits.some((f) => f.change !== undefined && Math.abs(f.change - change) <= CHANGE_TOLERANCE))
    const unknown = alive.some((c) => !strong.includes(c) && (views.get(c)!.open || views.get(c)!.fits.some((f) => f.change === undefined)))
    return strong.length === 1 && !unknown ? strong[0].code : undefined
  }
  for (const { own, etf } of etfs.values()) {
    // 有行被填上就再来一轮：一行占用的上市不再是别的行的候选。
    for (let moved = true; moved;) {
      const picks = new Map<Row, string>()
      for (const row of own) {
        const code = !codes.has(row) && typeof row.close === "number" && decide(row, etf)
        if (code) picks.set(row, code)
      }
      moved = placeAlone(picks, etf)
    }
  }
  for (const { own, etf } of etfs.values()) {
    const priced = (r: Row, c: Candidate) => typeof r.close === "number" && isQuotable(c)
    /** 还没代码的一行仍可能是哪些上市：没被占用、也没被排除的。 */
    const could = (r: Row) => candidatesOf(r).filter((c) => {
      if (etf.used.has(c.code)) return false
      if (!priced(r, c)) return true
      const v = view(r, c)
      return v.fits.length > 0 || v.open
    })
    // 本 ETF 持有哪些市场，就已知的而言：已填上的上市，以及没代码的行里、剩下的上市都在一个市场的。有一行可能
    // 在两个市场（同名的 A 股与 H 股，或港股名称以该行名称开头：「中国石油」/「中国石油股份」），或有名称查询
    // 失败，本 ETF 的市场就不知道。前缀候选在这里算数；填代码仍只认完全同名。
    const markets = new Set([...etf.used].map(market))
    let undecided = own.some((r) => failed.has(r.componentName as string))
    for (const r of own) {
      if (codes.get(r)) continue
      const held = marketsOf(could(r))
      if (held.size > 1) undecided = true
      else if (held.size === 1) markets.add([...held][0])
    }
    if (!undecided && markets.size === 1) etf.market = [...markets][0]
    const picks = new Map<Row, string>()
    // 价格留给两行同时选中的上市，不由第三行凭名称拿走。
    const contested = etf.contested
    for (const row of own) {
      if (codes.has(row)) continue
      // 名称只在没有价格可选时做主：完全同名、在本 ETF 唯一的市场、没被排除。能核价的上市仍可能的只有一只时
      // 只替它做主；不止一只——价格分不开它们——时谁也不选。
      const open = could(row)
      const pricedOpen = open.filter((c) => priced(row, c))
      const pool = (pricedOpen.length === 1 ? pricedOpen : pricedOpen.length ? [] : open).filter((c) => !c.prefix && market(c.code) === etf.market)
      const code = etf.market && pool.length && narrow(pool, etf)
      if (code && !contested.has(code)) picks.set(row, code)
    }
    placeAlone(picks, etf)
    for (const row of own) if (!codes.has(row)) place(row, null, etf)
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
      const out = new Map<string, Bar[]>()
      for (const k of listOf(await client.call("quote.day-kline", { securityList: codes, startDate, endDate, fieldList: ["securityCode", "tradeDate", "close", "preClose"], limit: 10_000 }))) {
        if (typeof k.securityCode !== "string" || typeof k.tradeDate !== "string" || typeof k.close !== "number") continue
        const series = out.get(k.securityCode) ?? []
        // 用两个收盘价算，不取日 K 自带的 pctChange：港股那一列只保留两位小数。
        series.push(typeof k.preClose === "number" && k.preClose > 0 ? [k.tradeDate, k.close, (k.close / k.preClose - 1) * 100] : [k.tradeDate, k.close])
        out.set(k.securityCode, series)
      }
      for (const series of out.values()) series.sort((a, b) => (a[0] < b[0] ? -1 : 1))
      return out
    },
    async quotes(codes) {
      const out = new Map<string, Quote>()
      const price = (value: unknown) => (typeof value === "number" ? value : undefined)
      for (const q of listOf(await client.call("quote.realtime", { securityList: codes }))) {
        const quote: Quote = { previous: price(q.preClose), latest: price(q.latestPrice), date: typeof q.tradeDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(q.tradeDate) ? q.tradeDate : undefined }
        if (typeof q.securityCode === "string" && (quote.previous !== undefined || quote.latest !== undefined)) out.set(q.securityCode, quote)
      }
      return out
    },
  }
}
