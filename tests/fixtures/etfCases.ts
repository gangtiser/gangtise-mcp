// Component lists, quotes and daily bars for `fillComponentCodes` (src/core/etfComponents.ts):
// forms that must leave a row null, and forms with full evidence that must fill every row.
// Names, codes and prices follow the live answers of 2026-10-27 / 2026-11-13; the stories are
// built around them. Local data only.
import type { CodeLookup } from "../../src/core/etfComponents.js"

export type Bar = [date: string, close: number, change?: number]
type Listing = [code: string, name: string, category?: string]

export interface EtfCase {
  name: string
  fund: string
  search: Record<string, Listing[]>
  /** [previous close, latest, date]; the date defaults to `quoteDate`, null is a quote without one. */
  quotes: Record<string, [number, number, (string | null)?]>
  quoteDate?: string
  /** Absent: a lookup without daily closes. */
  bars?: Record<string, Bar[]>
  rows: Array<[name: string, close: number, pctChange?: number]>
}

const QUOTE_DATE = "2026-10-28"

export function caseLookup(c: EtfCase): CodeLookup {
  const date = c.quoteDate ?? QUOTE_DATE
  return {
    async search(keyword) { return (c.search[keyword] ?? []).map(([gtsCode, gtsName, category = "stock"]) => ({ gtsCode, gtsName, category })) },
    async quotes(codes) {
      return new Map(codes.filter((code) => c.quotes[code]).map((code) => {
        const [previous, latest, day] = c.quotes[code]
        return [code, { previous, latest, date: day === null ? undefined : day ?? date }]
      }))
    },
    ...(c.bars ? { async closes(codes: string[]) { return new Map(codes.filter((code) => c.bars![code]).map((code) => [code, c.bars![code]])) } } : {}),
  }
}

export const caseRows = (c: EtfCase) => c.rows.map(([componentName, close, pctChange], i) => ({ fundCode: c.fund, serialNumber: i + 1, componentName, close, ...(pctChange === undefined ? {} : { pctChange }) }))

/** Each leaves the row at `at` null: the evidence does not tell its listing, and the code a looser
 * rule would fill there is another component's. */
export const UNDECIDABLE: Array<EtfCase & { at: number; truth: string }> = [
  {
    name: "a same-market prefix listing whose previous close equals a lagging row",
    // Hong Kong ETF, list a day behind: 网易 is 09999.HK at its 10-26 close; 09899.HK (网易云音乐) closed there on 10-27.
    fund: "513180.SH",
    search: { 腾讯控股: [["00700.HK", "腾讯控股"]], 网易: [["09999.HK", "网易-S"], ["09899.HK", "网易云音乐"]] },
    quotes: { "00700.HK": [390, 392], "09999.HK": [155.0, 156.2], "09899.HK": [152.3, 150.1] },
    bars: { "00700.HK": [["2026-10-26", 388], ["2026-10-27", 390]], "09999.HK": [["2026-10-26", 152.3], ["2026-10-27", 155.0]], "09899.HK": [["2026-10-26", 149.0], ["2026-10-27", 152.3]] },
    rows: [["腾讯控股", 390], ["网易", 152.3]],
    at: 1, truth: "09999.HK",
  },
  {
    name: "the other counter of one name, at a lagging row's close the day after",
    // Hong Kong ETF, list a day behind: 腾讯控股 is 00700.HK at its 10-26 close; the RMB counter closed there on 10-27.
    fund: "513180.SH",
    search: { 华润啤酒: [["00291.HK", "华润啤酒"]], 腾讯控股: [["00700.HK", "腾讯控股"], ["80700.HK", "腾讯控股-R"]] },
    quotes: { "00291.HK": [19.48, 19.6], "00700.HK": [386.4, 390], "80700.HK": [380, 383] },
    bars: { "00291.HK": [["2026-10-26", 19.3], ["2026-10-27", 19.48]], "00700.HK": [["2026-10-26", 380], ["2026-10-27", 386.4]], "80700.HK": [["2026-10-26", 374], ["2026-10-27", 380]] },
    rows: [["华润啤酒", 19.48], ["腾讯控股", 380]],
    at: 1, truth: "00700.HK",
  },
  {
    name: "list days voted on prices that did not move into a day the bars do not reach",
    // A+H list of the quote's day (10-28); bars end 10-27. 招商银行 is the A share's 10-28 close (its
    // latest price); the H share closed at 42.5 on 10-27. Unchanged closes vote both markets to 10-27.
    fund: "517180.SH",
    search: { 中国石油: [["601857.SH", "中国石油"]], 中国神华: [["601088.SH", "中国神华"]], 华润啤酒: [["00291.HK", "华润啤酒"]], 腾讯控股: [["00700.HK", "腾讯控股"]], 招商银行: [["600036.SH", "招商银行"], ["03968.HK", "招商银行"]] },
    quotes: { "601857.SH": [13.2, 13.2], "601088.SH": [38.4, 38.4], "00291.HK": [19.48, 19.48], "00700.HK": [390, 390], "600036.SH": [42.3, 42.5], "03968.HK": [42.5, 44.2] },
    bars: {
      "601857.SH": [["2026-10-26", 13.38], ["2026-10-27", 13.2]], "601088.SH": [["2026-10-26", 38.6], ["2026-10-27", 38.4]],
      "00291.HK": [["2026-10-26", 19.3], ["2026-10-27", 19.48]], "00700.HK": [["2026-10-26", 388], ["2026-10-27", 390]],
      "600036.SH": [["2026-10-26", 42.43], ["2026-10-27", 42.3]], "03968.HK": [["2026-10-26", 43.9], ["2026-10-27", 42.5]],
    },
    rows: [["中国石油", 13.2], ["中国神华", 38.4], ["华润啤酒", 19.48], ["腾讯控股", 390], ["招商银行", 42.5]],
    at: 4, truth: "600036.SH",
  },
  {
    name: "a market's list day known, the listing's bars ending before it",
    // A day 11-11, H day 11-12; the A share's bars stop at 11-10 and its previous close (11-12) is
    // 42.5; the H share closed at 42.5 on 11-12.
    fund: "517180.SH", quoteDate: "2026-11-13",
    search: { 贵州茅台: [["600519.SH", "贵州茅台"]], 中国石油: [["601857.SH", "中国石油"]], 华润啤酒: [["00291.HK", "华润啤酒"]], 腾讯控股: [["00700.HK", "腾讯控股"]], 招商银行: [["600036.SH", "招商银行"], ["03968.HK", "招商银行"]] },
    quotes: { "600519.SH": [1360, 1362], "601857.SH": [13.5, 13.6], "00291.HK": [19.6, 19.7], "00700.HK": [392, 393], "600036.SH": [42.5, 43.1], "03968.HK": [42.5, 42.9] },
    bars: {
      "600519.SH": [["2026-11-11", 1349.98], ["2026-11-12", 1360]], "601857.SH": [["2026-11-11", 13.38], ["2026-11-12", 13.5]],
      "00291.HK": [["2026-11-11", 19.3], ["2026-11-12", 19.48]], "00700.HK": [["2026-11-11", 388], ["2026-11-12", 390]],
      "600036.SH": [["2026-11-10", 42.3]], "03968.HK": [["2026-11-10", 42.3], ["2026-11-11", 42.8], ["2026-11-12", 42.5]],
    },
    rows: [["贵州茅台", 1349.98], ["中国石油", 13.38], ["华润啤酒", 19.48], ["腾讯控股", 390], ["招商银行", 42.5]],
    at: 4, truth: "600036.SH",
  },
  {
    name: "bars ending before the row's day, the quote showing neither of its sessions at the close",
    // 招商银行 is the A share's 11-11 close; its bars stop at 11-10 and its quote (11-13) is 43.1 / 43.4.
    fund: "517180.SH", quoteDate: "2026-11-13",
    search: { 华润啤酒: [["00291.HK", "华润啤酒"]], 腾讯控股: [["00700.HK", "腾讯控股"]], 招商银行: [["600036.SH", "招商银行"], ["03968.HK", "招商银行"]] },
    quotes: { "00291.HK": [19.48, 19.6], "00700.HK": [390, 392], "600036.SH": [43.1, 43.4], "03968.HK": [42.5, 42.9] },
    bars: { "600036.SH": [["2026-11-10", 42.3]], "03968.HK": [["2026-11-10", 42.3], ["2026-11-11", 42.8], ["2026-11-12", 42.5]] },
    rows: [["腾讯控股", 390], ["华润啤酒", 19.48], ["招商银行", 42.5]],
    at: 2, truth: "600036.SH",
  },
  {
    name: "bars beginning on the quote's day, so the previous session is not in them",
    // 招商银行 is the A share's 11-12 close (its previous close); its bars begin 11-13; the H share's
    // latest price (11-13) is 42.5.
    fund: "517180.SH", quoteDate: "2026-11-13",
    search: { 华润啤酒: [["00291.HK", "华润啤酒"]], 腾讯控股: [["00700.HK", "腾讯控股"]], 招商银行: [["600036.SH", "招商银行"], ["03968.HK", "招商银行"]] },
    quotes: { "00291.HK": [19.3, 19.48], "00700.HK": [388, 390], "600036.SH": [42.5, 42.7], "03968.HK": [42.3, 42.5] },
    bars: { "00291.HK": [["2026-11-13", 19.48]], "00700.HK": [["2026-11-13", 390]], "600036.SH": [["2026-11-13", 42.7, 0.4706]], "03968.HK": [["2026-11-12", 42.3], ["2026-11-13", 42.5]] },
    rows: [["腾讯控股", 390], ["华润啤酒", 19.48], ["招商银行", 42.5]],
    at: 2, truth: "600036.SH",
  },
  {
    name: "an exact listing at the close on the list day beside a prefix listing in another market",
    // 比亚迪 is the H share 01211.HK (比亚迪股份, a prefix match) at its 10-27 close; the A share closed
    // at the same price on the A list day, 10-26.
    fund: "517180.SH",
    search: { 贵州茅台: [["600519.SH", "贵州茅台"]], 中国神华: [["601088.SH", "中国神华"]], 华润啤酒: [["00291.HK", "华润啤酒"]], 腾讯控股: [["00700.HK", "腾讯控股"]], 比亚迪: [["002594.SZ", "比亚迪"], ["01211.HK", "比亚迪股份"]] },
    quotes: { "600519.SH": [1360, 1362], "601088.SH": [38.9, 39.0], "00291.HK": [19.48, 19.6], "00700.HK": [390, 392], "002594.SZ": [101.5, 102.0], "01211.HK": [100.0, 103.0] },
    bars: {
      "600519.SH": [["2026-10-26", 1349.98], ["2026-10-27", 1360]], "601088.SH": [["2026-10-26", 38.6], ["2026-10-27", 38.9]],
      "00291.HK": [["2026-10-26", 19.3], ["2026-10-27", 19.48]], "00700.HK": [["2026-10-26", 388], ["2026-10-27", 390]],
      "002594.SZ": [["2026-10-26", 100.0], ["2026-10-27", 101.5]], "01211.HK": [["2026-10-26", 98.0], ["2026-10-27", 100.0]],
    },
    rows: [["贵州茅台", 1349.98], ["中国神华", 38.6], ["华润啤酒", 19.48], ["腾讯控股", 390], ["比亚迪", 100.0]],
    at: 4, truth: "01211.HK",
  },
  {
    name: "bars beginning after the row's day, no list day known",
    // One single-listing row per market: no list day. 招商银行 is the A share's 10-26 close; its bars
    // begin 10-27; the H share's previous close (10-27) is 42.5.
    fund: "517180.SH",
    search: { 贵州茅台: [["600519.SH", "贵州茅台"]], 华润啤酒: [["00291.HK", "华润啤酒"]], 招商银行: [["600036.SH", "招商银行"], ["03968.HK", "招商银行"]] },
    quotes: { "600519.SH": [1349.98, 1352], "00291.HK": [19.48, 19.6], "600036.SH": [43.0, 43.2], "03968.HK": [42.5, 42.8] },
    bars: { "600036.SH": [["2026-10-27", 43.0, 0.7026]], "03968.HK": [["2026-10-23", 42.1, 0.1], ["2026-10-26", 42.3, 0.4751], ["2026-10-27", 42.5, 0.4728]] },
    rows: [["贵州茅台", 1349.98], ["华润啤酒", 19.48], ["招商银行", 42.5]],
    at: 2, truth: "600036.SH",
  },
  {
    name: "a name whose one listing its quote and bars contradict",
    // An ETF of A shares otherwise: 中国石化 4.64 is the H share (listed as 中国石油化工股份, not a candidate).
    fund: "510300.SH",
    search: { 贵州茅台: [["600519.SH", "贵州茅台"]], 中国石化: [["600028.SH", "中国石化"]] },
    quotes: { "600519.SH": [1349.98, 1352], "600028.SH": [5.56, 5.51] },
    bars: { "600519.SH": [["2026-10-23", 1335], ["2026-10-26", 1340], ["2026-10-27", 1349.98]], "600028.SH": [["2026-10-21", 5.5], ["2026-10-22", 5.52], ["2026-10-23", 5.55], ["2026-10-26", 5.58], ["2026-10-27", 5.56]] },
    rows: [["贵州茅台", 1349.98], ["中国石化", 4.64]],
    at: 1, truth: "(none: 00386.HK is not a candidate)",
  },
  {
    name: "the quote down, the listing's bars behind",
    // No quote at all; Hong Kong rows otherwise. 招商银行 is the A share's 10-27 close; its bars stop at 10-24.
    fund: "517180.SH",
    search: { 腾讯控股: [["00700.HK", "腾讯控股"]], 华润啤酒: [["00291.HK", "华润啤酒"]], 招商银行: [["600036.SH", "招商银行"], ["03968.HK", "招商银行"]] },
    quotes: {},
    bars: { "00700.HK": [["2026-10-27", 390]], "00291.HK": [["2026-10-27", 19.48]], "600036.SH": [["2026-10-23", 42.9], ["2026-10-24", 43.1]], "03968.HK": [["2026-10-24", 52.1], ["2026-10-27", 52.6]] },
    rows: [["腾讯控股", 390], ["华润啤酒", 19.48], ["招商银行", 42.5]],
    at: 2, truth: "600036.SH",
  },
]

const D5 = ["2026-10-21", "2026-10-22", "2026-10-23", "2026-10-26", "2026-10-27"]
const five = (...closes: number[]): Bar[] => closes.map((close, i) => [D5[i], close])
const earlier5 = (...closes: number[]): Bar[] => closes.map((close, i) => [["2026-10-19", "2026-10-20", "2026-10-21", "2026-10-22", "2026-10-23"][i], close])
const AH: Record<string, Listing[]> = { 华润啤酒: [["00291.HK", "华润啤酒"]], 腾讯控股: [["00700.HK", "腾讯控股"]], 贵州茅台: [["600519.SH", "贵州茅台"]], 招商银行: [["600036.SH", "招商银行"], ["03968.HK", "招商银行"]] }
const HK5 = { "00291.HK": five(19.1, 19.2, 19.3, 19.4, 19.48), "00700.HK": five(380, 383, 385, 388, 390), "03968.HK": five(43.5, 43.2, 43.0, 42.8, 42.5) }
const HKQ: EtfCase["quotes"] = { "00291.HK": [19.48, 19.6], "00700.HK": [390, 392], "03968.HK": [42.5, 42.9] }
// 招商银行 is the A share's 10-26 close: five bars that end 10-23, and a quote on neither 10-26 nor 10-27.
const TAIL = { fund: "517180.SH", search: AH, rows: [["腾讯控股", 390], ["华润啤酒", 19.48], ["贵州茅台", 1355.9], ["招商银行", 42.5]] as EtfCase["rows"], at: 3, truth: "600036.SH",
  bars: { ...HK5, "600519.SH": five(1320, 1335, 1340, 1349.98, 1355.9), "600036.SH": earlier5(41.8, 42.0, 42.2, 42.3, 42.4) } }
UNDECIDABLE.push(
  { ...TAIL, name: "five bars ending two weekdays before the quote's day", quotes: { ...HKQ, "600519.SH": [1355.9, 1360], "600036.SH": [43.1, 43.4] } },
  { ...TAIL, name: "five bars ending two weekdays before, the quote without its date", quotes: { ...HKQ, "600519.SH": [1355.9, 1360], "600036.SH": [43.1, 43.4, null] } },
  { ...TAIL, name: "five bars ending two weekdays before, no quote for the listing", quotes: { ...HKQ, "600519.SH": [1355.9, 1360] } },
  {
    name: "a plurality of single-listing rows at one day's close, short of a majority",
    // Two of five A rows sit at a 10-27 close; 招商银行 is the A share's 10-23 close, the H share closed
    // there on the Hong Kong list day (10-27).
    fund: "517180.SH",
    search: { ...AH, 中国石油: [["601857.SH", "中国石油"]], 中国神华: [["601088.SH", "中国神华"]], 五粮液: [["000858.SZ", "五粮液"]], 美的集团: [["000333.SZ", "美的集团"]] },
    quotes: { "00291.HK": [19.48, 19.6], "00700.HK": [390, 392], "03968.HK": [42.2, 42.9], "600519.SH": [1355.9, 1360], "601857.SH": [13.2, 13.3], "601088.SH": [38.4, 38.5], "000858.SZ": [75.1, 75.3], "000333.SZ": [85.5, 85.9], "600036.SH": [42.5, 42.7] },
    bars: { "00291.HK": five(19.1, 19.2, 19.3, 19.4, 19.48), "00700.HK": five(380, 383, 385, 388, 390), "03968.HK": five(43.5, 43.2, 43.0, 42.8, 42.2),
      "600519.SH": five(1320, 1335, 1340, 1349.98, 1355.9), "601857.SH": five(12.6, 12.75, 12.9, 13.38, 13.2), "601088.SH": five(38.0, 38.1, 38.3, 38.6, 38.4), "000858.SZ": five(74, 74.5, 75.63, 75.3, 75.1), "000333.SZ": five(84, 84.5, 85, 85.2, 85.5), "600036.SH": five(42.0, 42.1, 42.2, 42.3, 42.5) },
    rows: [["腾讯控股", 390], ["华润啤酒", 19.48], ["贵州茅台", 1355.9], ["中国石油", 13.2], ["中国神华", 38.6], ["五粮液", 75.63], ["美的集团", 84.5], ["招商银行", 42.2]],
    at: 7, truth: "600036.SH",
  },
)

// Five sessions of bars per listing (10-21 … 10-27), each with its change, and a quote of 10-28
// whose previous close is the last bar's.
const series = (...closes: number[]): Bar[] => closes.map((close, i) => [D5[D5.length - closes.length + i], close, i ? (close / closes[i - 1] - 1) * 100 : undefined])
const S = {
  moutai: series(1320, 1335, 1340, 1349.98, 1355.9), petro: series(12.6, 12.75, 12.9, 13.38, 13.2), shenhua: series(38.0, 38.1, 38.3, 38.6, 38.4),
  beer: series(19.1, 19.2, 19.3, 19.4, 19.48), tencent: series(380, 383, 385, 388, 390),
  mobileA: series(98.5, 99.14, 100.2, 101.3, 100.7), mobileH: series(76.5, 77.1, 77.0, 77.3, 78.1), cmbA: series(42.0, 42.2, 42.43, 42.3, 42.5), cmbH: series(51.0, 51.5, 52.0, 52.15, 52.6),
}
const BASE: Record<string, Listing[]> = { 贵州茅台: [["600519.SH", "贵州茅台"]], 中国石油: [["601857.SH", "中国石油"]], 中国神华: [["601088.SH", "中国神华"]], 华润啤酒: [["00291.HK", "华润啤酒"]], 腾讯控股: [["00700.HK", "腾讯控股"]] }
const BASE_BARS = { "600519.SH": S.moutai, "601857.SH": S.petro, "601088.SH": S.shenhua, "00291.HK": S.beer, "00700.HK": S.tencent }
const BASE_LATEST = { "600519.SH": 1360, "601857.SH": 13.3, "601088.SH": 38.5, "00291.HK": 19.6, "00700.HK": 392 }
const change = (bars: Bar[], i: number) => bars.at(i)![2]!
/** Quotes for every listing with bars and a latest price: the previous close is the last bar's. */
const quotesOf = (bars: Record<string, Bar[]>, latest: Record<string, number>, override: EtfCase["quotes"] = {}, unquoted: string[] = []): EtfCase["quotes"] => ({
  ...Object.fromEntries(Object.entries(latest).filter(([code]) => bars[code] && !unquoted.includes(code)).map(([code, price]) => [code, [bars[code].at(-1)![1], price]])),
  ...override,
})

/** Full evidence: every row filled with `want`. */
export const DECIDABLE: Array<EtfCase & { want: Array<string | null> }> = [
  (() => {
    const bars = { ...BASE_BARS, "600941.SH": S.mobileA, "00941.HK": S.mobileH }
    return { name: "an A/H pair whose list is yesterday's closes (the quote's previous)", fund: "517180.SH", search: { ...BASE, 中国移动: [["600941.SH", "中国移动"], ["00941.HK", "中国移动"]] as Listing[] }, bars,
      quotes: quotesOf(bars, { ...BASE_LATEST, "600941.SH": 101, "00941.HK": 78.5 }),
      rows: [["贵州茅台", 1355.9], ["华润啤酒", 19.48], ["中国移动", 100.7], ["中国移动", 78.1]] as EtfCase["rows"], want: ["600519.SH", "00291.HK", "600941.SH", "00941.HK"] }
  })(),
  (() => {
    const bars = { ...BASE_BARS, "600941.SH": S.mobileA, "00941.HK": S.mobileH }
    return { name: "a lagging list: A rows two sessions back, Hong Kong rows one", fund: "517180.SH", search: { ...BASE, 中国移动: [["600941.SH", "中国移动"], ["00941.HK", "中国移动"]] as Listing[] }, bars,
      quotes: quotesOf(bars, { ...BASE_LATEST, "600941.SH": 101, "00941.HK": 78.5 }),
      rows: [["中国石油", 13.38], ["中国神华", 38.6], ["华润啤酒", 19.48], ["腾讯控股", 390], ["中国移动", 101.3], ["中国移动", 78.1]] as EtfCase["rows"], want: ["601857.SH", "601088.SH", "00291.HK", "00700.HK", "600941.SH", "00941.HK"] }
  })(),
  (() => {
    const bars = { ...BASE_BARS, "600036.SH": S.cmbA, "03968.HK": series(42.9, 42.7, 42.6, 42.55, 42.5) }
    return { name: "one close in both markets on the list day, told apart by the row's change", fund: "517180.SH", search: { ...BASE, 招商银行: [["600036.SH", "招商银行"], ["03968.HK", "招商银行"]] as Listing[] }, bars,
      quotes: quotesOf(bars, { ...BASE_LATEST, "600036.SH": 42.7, "03968.HK": 42.6 }),
      rows: [["贵州茅台", 1355.9], ["华润啤酒", 19.48], ["招商银行", 42.5, change(S.cmbA, -1)], ["招商银行", 42.5, (42.5 / 42.55 - 1) * 100]] as EtfCase["rows"], want: ["600519.SH", "00291.HK", "600036.SH", "03968.HK"] }
  })(),
  (() => {
    // A suspended listing carries a bar on every session, its close repeated, and a quote without a price.
    const bars = { ...BASE_BARS, "601186.SH": series(6.0, 6.05, 6.11, 6.11, 6.11), "01186.HK": series(4.3, 4.35, 4.4, 4.5, 4.6) }
    return { name: "an A share suspended since 10-23 (its close repeated in the bars, its quote without a price), its H share trading", fund: "517180.SH", search: { ...BASE, 中国铁建: [["601186.SH", "中国铁建"], ["01186.HK", "中国铁建"]] as Listing[] }, bars,
      quotes: quotesOf(bars, { ...BASE_LATEST, "01186.HK": 4.65 }, { "601186.SH": [0, 0] }),
      rows: [["中国石油", 13.2], ["中国神华", 38.4], ["华润啤酒", 19.48], ["腾讯控股", 390], ["中国铁建", 6.11]] as EtfCase["rows"], want: ["601857.SH", "601088.SH", "00291.HK", "00700.HK", "601186.SH"] }
  })(),
  (() => {
    const bars = { ...BASE_BARS, "601229.SH": series(9.4, 9.45, 9.5, 9.52, 9.55) }
    return { name: "an ex-dividend day in an A-share ETF: the quote's previous close adjusted, the bars keeping the close", fund: "510300.SH", search: { ...BASE, 上海银行: [["601229.SH", "上海银行"]] as Listing[] }, bars,
      quotes: quotesOf(bars, { ...BASE_LATEST, "601229.SH": 9.45 }, { "601229.SH": [9.25, 9.45] }),
      rows: [["贵州茅台", 1355.9], ["中国石油", 13.2], ["上海银行", 9.55]] as EtfCase["rows"], want: ["600519.SH", "601857.SH", "601229.SH"] }
  })(),
  (() => {
    const bars = { ...BASE_BARS, "002594.SZ": series(81, 81.5, 82, 82.4, 82.01), "01211.HK": series(69, 69.5, 70, 70.8, 70.05), "00285.HK": series(22, 22.2, 22.4, 22.58, 22.3) }
    return { name: "a Hong Kong ETF: a longer H name by prefix, the name's A share ruled out by its bars", fund: "159920.SZ", search: { ...BASE, 比亚迪: [["002594.SZ", "比亚迪"], ["01211.HK", "比亚迪股份"], ["00285.HK", "比亚迪电子"]] as Listing[] }, bars,
      quotes: quotesOf(bars, { ...BASE_LATEST, "002594.SZ": 82.3, "01211.HK": 70.4, "00285.HK": 22.5 }),
      rows: [["腾讯控股", 390], ["华润啤酒", 19.48], ["比亚迪", 70.05]] as EtfCase["rows"], want: ["00700.HK", "00291.HK", "01211.HK"] }
  })(),
  (() => {
    const bars = { "00291.HK": S.beer, "00700.HK": S.tencent, "80700.HK": series(350, 352, 354, 357, 359) }
    return { name: "Hong Kong twin counters (HKD / RMB) told apart by their own bars", fund: "513180.SH", search: { 华润啤酒: BASE.华润啤酒, 腾讯控股: [["00700.HK", "腾讯控股"], ["80700.HK", "腾讯控股-R"]] as Listing[] }, bars,
      quotes: quotesOf(bars, { "00291.HK": 19.6, "00700.HK": 392, "80700.HK": 361 }),
      rows: [["华润啤酒", 19.48], ["腾讯控股", 390]] as EtfCase["rows"], want: ["00291.HK", "00700.HK"] }
  })(),
  (() => {
    const bars = { ...BASE_BARS, "600036.SH": S.cmbA, "03968.HK": S.cmbH, "600941.SH": S.mobileA, "00941.HK": S.mobileH }
    return { name: "an A-share ETF: every A/H name filled once the H listing's bars and quote cover the days", fund: "510300.SH",
      search: { ...BASE, 招商银行: [["600036.SH", "招商银行"], ["03968.HK", "招商银行"]] as Listing[], 中国移动: [["600941.SH", "中国移动"], ["00941.HK", "中国移动"]] as Listing[] }, bars,
      quotes: quotesOf(bars, { ...BASE_LATEST, "600036.SH": 42.7, "03968.HK": 52.9, "600941.SH": 101, "00941.HK": 78.5 }),
      rows: [["贵州茅台", 1355.9], ["招商银行", 42.5], ["中国移动", 100.7]] as EtfCase["rows"], want: ["600519.SH", "600036.SH", "600941.SH"] }
  })(),
  (() => {
    const bars = { "NVDA.O": series(210, 212, 214, 215, 216), "TXN.O": series(290, 292, 295, 297, 298.12), "TXNM.N": series(55, 55.2, 55.4, 55.6, 55.8) }
    return { name: "a US ticker beside a longer name of another company (TXN / TXNM)", fund: "513100.SH", search: { NVDA: [["NVDA.O", "英伟达"]] as Listing[], TXN: [["TXN.O", "Texas Instruments"], ["TXNM.N", "TXNM Energy"]] as Listing[] }, bars,
      quotes: quotesOf(bars, { "NVDA.O": 216, "TXN.O": 298.12, "TXNM.N": 55.8 }),
      rows: [["NVDA", 216], ["TXN", 298.12]] as EtfCase["rows"], want: ["NVDA.O", "TXN.O"] }
  })(),
]
