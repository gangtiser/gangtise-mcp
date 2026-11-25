import { describe, expect, it } from "vitest"

import { addComponentCodes, clientLookup, fillComponentCodes, loadSecurityTable, tableSearch, type CodeLookup } from "../../../src/core/etfComponents.js"
import { caseLookup, caseRows, DECIDABLE, UNDECIDABLE } from "../../fixtures/etfCases.js"

// Names, codes and prices are taken from the live answers of 2026-10-27 (14 ETFs).
type Listing = [code: string, name: string, category?: string]

// Quotes are of the trading day after the fixtures' last daily bars (10-27): [previous close, latest].
const QUOTE_DATE = "2026-10-28"

function lookup(search: Record<string, Listing[]>, prices: Record<string, number[]>, fail: { search?: string; quote?: string } = {}, quoteDate: string | null = QUOTE_DATE) {
  const searched: string[] = []
  const quoted: string[][] = []
  const api: CodeLookup = {
    async search(keyword) {
      searched.push(keyword)
      if (keyword === fail.search) throw new Error("search failed")
      return (search[keyword] ?? []).map(([gtsCode, gtsName, category = "stock"]) => ({ gtsCode, gtsName, category }))
    },
    async quotes(codes) {
      quoted.push(codes)
      // The quote answers 120001 for the whole batch when one code is unknown.
      if (fail.quote && codes.includes(fail.quote)) throw Object.assign(new Error("证券代码无效"), { code: "120001" })
      return new Map(codes.filter((c) => prices[c]).map((c) => [c, { previous: prices[c][0], latest: prices[c][1], date: quoteDate ?? undefined }]))
    },
  }
  return { api, searched, quoted }
}

const row = (fundCode: string, serialNumber: number, componentName: string, close: number | null) => ({ fundCode, serialNumber, componentName, close })
const withCloses = (api: CodeLookup, history: Record<string, Array<[string, number, number?]>>): CodeLookup => ({ ...api, async closes(codes) { return new Map(codes.filter((c) => history[c]).map((c) => [c, history[c]])) } })
const codesOf = (rows: Array<Record<string, unknown>>) => rows.map((r) => r.componentCode)
type Bar = [string, number, number?]
/** `bars` with earlier sessions in front, at closes no row here has, up to `n` sessions: where no
 * list day is known for its market, a listing is ruled out only when its bars hold four. */
const PAD_DAYS = ["2026-10-13", "2026-10-14", "2026-10-15", "2026-10-16"]
const sessions = (bars: Bar[], n = 4): Bar[] => [...PAD_DAYS.slice(0, Math.max(0, n - bars.length)).map((day, i): Bar => [day, Number((bars[0][1] * (0.9 - i * 0.01)).toFixed(2))]), ...bars]

const nextWeekday = (day: string) => {
  const d = new Date(`${day}T00:00:00Z`)
  do d.setUTCDate(d.getUTCDate() + 1)
  while (d.getUTCDay() % 6 === 0)
  return d.toISOString().slice(0, 10)
}
/** A listing's closes as a lookup brings them on QUOTE_DATE: four sessions at least, running up
 * to the session before that day — the sessions added, in front and behind, at closes no row
 * has — each with its change, and a quote of that day: the previous close the last bar's, the
 * latest price one no row has. */
const shown = (history: Iterable<[string, Bar[]]>) => {
  const bars: Record<string, Bar[]> = {}
  const quotes = new Map<string, { previous: number; latest: number; date: string }>()
  for (const [code, series] of history) {
    const full = sessions(series)
    for (let day = nextWeekday(full.at(-1)![0]), k = 1; day < QUOTE_DATE; day = nextWeekday(day), k++) full.push([day, Number((series.at(-1)![1] * (1 + 0.0137 * k)).toFixed(3))])
    bars[code] = full.map(([day, close, change], n): Bar => [day, close, change ?? (n ? (close / full[n - 1][1] - 1) * 100 : undefined)])
    const close = full.at(-1)![1]
    quotes.set(code, { previous: close, latest: Number((close * 1.0123).toFixed(3)), date: QUOTE_DATE })
  }
  return { bars, quotes }
}
/** `api` with those closes, and those quotes for the listings it does not quote itself. */
const showing = (api: CodeLookup, history: Iterable<[string, Bar[]]>): CodeLookup => {
  const { bars, quotes } = shown(history)
  return { ...withCloses(api, bars), async quotes(codes) { return new Map([...codes.flatMap((c) => (quotes.has(c) ? [[c, quotes.get(c)!] as const] : [])), ...await api.quotes(codes)]) } }
}
/** A four-session bar series for each quoted listing, ending at the quote's previous close. */
const barred = (api: CodeLookup, prices: Record<string, number[]>) => withCloses(api, Object.fromEntries(Object.entries(prices).filter(([, p]) => p[0] > 0).map(([code, p]) => [code, sessions([["2026-10-27", p[0]]])])))

const AH_MOBILE: Listing[] = [["600941.SH", "中国移动"], ["00941.HK", "中国移动"]]
const MOBILE_PRICES = { "600941.SH": [101.3, 100.7], "00941.HK": [77.3, 78.1] }

describe("fillComponentCodes", () => {
  it("tells the A and H rows of one name apart by price, whichever comes first", async () => {
    for (const order of [[77.3, 101.3], [101.3, 77.3]]) {
      const { api } = lookup({ 中国移动: AH_MOBILE }, MOBILE_PRICES)
      const { rows, unresolved } = await fillComponentCodes(order.map((close, i) => row("517180.SH", i + 1, "中国移动", close)), barred(api, MOBILE_PRICES))
      expect(codesOf(rows)).toEqual(order.map((close) => (close === 77.3 ? "00941.HK" : "600941.SH")))
      expect(unresolved).toEqual([])
    }
  })

  it("takes the listing the price confirms, and puts componentCode right after serialNumber", async () => {
    const prices = { "00939.HK": [9.92, 9.95], "601939.SH": [9.1, 9.2], "01810.HK": [26.9, 27.1], "81810.HK": [24.6, 24.8] }
    const { api } = lookup({ 建设银行: [["00939.HK", "建设银行"], ["601939.SH", "建设银行"]], 小米集团: [["01810.HK", "小米集团-W"], ["81810.HK", "小米集团-WR"], ["XC180001.SH", "小米集团-D", "dr"]] }, prices)
    const { rows } = await fillComponentCodes([row("159920.SZ", 4, "建设银行", 9.92), row("159920.SZ", 5, "小米集团", 26.9)], barred(api, prices))
    expect(codesOf(rows)).toEqual(["00939.HK", "01810.HK"])
    expect(Object.keys(rows[0])).toEqual(["fundCode", "serialNumber", "componentCode", "componentName", "close"])
  })

  it("searches a padded name without its spaces", async () => {
    const { api, searched } = lookup({ 五粮液: [["000858.SZ", "五粮液"]] }, { "000858.SZ": [75.63, 75.1] })
    const { rows } = await fillComponentCodes([row("510300.SH", 9, "五 粮 液", 75.63)], api)
    expect(searched).toEqual(["五粮液"])
    expect(codesOf(rows)).toEqual(["000858.SZ"])
  })

  it("lets an exact name in the ETF's market stand when no price agrees, and never a prefix guess", async () => {
    // Ex-dividend day: the previous close is adjusted (9.25), the component list keeps 9.55.
    const { api } = lookup(
      {
        上海银行: [["601229.SH", "上海银行"], ["212480009.IB", "24上海银行债01", "bond"]],
        贵州茅台: [["600519.SH", "贵州茅台"]],
        中海油: [["601808.SH", "中海油服"], ["02883.HK", "中海油田服务"]],
      },
      { "601229.SH": [9.25, 9.45], "600519.SH": [1335, 1349.98], "601808.SH": [14.6, 14.7], "02883.HK": [7.5, 7.6] },
    )
    const rows3 = [row("510300.SH", 1, "贵州茅台", 1349.98), row("510300.SH", 2, "上海银行", 9.55), row("510300.SH", 3, "中海油", 20.1)]
    // 中海油's prefix candidates trade in two markets; their recent closes rule both out.
    const { rows, unresolved } = await fillComponentCodes(rows3, withCloses(api, { "601808.SH": sessions([["2026-10-27", 14.6]]), "02883.HK": sessions([["2026-10-27", 7.5]]) }))
    expect(codesOf(rows)).toEqual(["600519.SH", "601229.SH", null])
    expect(unresolved).toEqual([{ fundCode: "510300.SH", serialNumber: 3, componentName: "中海油" }])
    // Without daily closes 中海油's listings are not ruled out: the ETF could hold both markets,
    // and no name stands.
    expect(codesOf((await fillComponentCodes(rows3, api)).rows)).toEqual(["600519.SH", null, null])
  })

  it("does not let a name match outside the ETF's market stand on the name alone", async () => {
    // A Hong Kong ETF's 中国石化 row is the H share, which the search lists as 中国石油化工股份.
    const { api } = lookup(
      { 中国石化: [["600028.SH", "中国石化"]], 腾讯控股: [["00700.HK", "腾讯控股"]], 汇丰控股: [["00005.HK", "汇丰控股"]] },
      { "600028.SH": [5.56, 5.51], "00700.HK": [386.4, 390], "00005.HK": [120, 121] },
    )
    const { rows } = await fillComponentCodes([row("159920.SZ", 1, "腾讯控股", 386.4), row("159920.SZ", 2, "汇丰控股", 120), row("159920.SZ", 3, "中国石化", 4.64)], api)
    expect(codesOf(rows)).toEqual(["00700.HK", "00005.HK", null])
  })

  it("gives a listing to the row its price confirms before another row of the same name can take it by name", async () => {
    // The H row (中国建筑国际, 8.44) is not found under this name; the A row's price confirms 601668.SH.
    const { api } = lookup({ 中国建筑: [["601668.SH", "中国建筑"]] }, { "601668.SH": [4.58, 4.6] })
    const { rows } = await fillComponentCodes([row("517180.SH", 1, "中国建筑", 8.44), row("517180.SH", 2, "中国建筑", 4.58)], api)
    expect(codesOf(rows)).toEqual([null, "601668.SH"])
  })

  it("matches a longer Hong Kong name by prefix when the price confirms it", async () => {
    const prices = { "002594.SZ": [82.4, 82.01], "00285.HK": [22.58, 22.3], "01211.HK": [70.8, 70.05], "00700.HK": [386.4, 390] }
    const { api } = lookup({ 比亚迪: [["002594.SZ", "比亚迪"], ["00285.HK", "比亚迪电子"], ["01211.HK", "比亚迪股份"]], 腾讯控股: [["00700.HK", "腾讯控股"]] }, prices)
    const { rows } = await fillComponentCodes([row("159920.SZ", 1, "腾讯控股", 386.4), row("159920.SZ", 2, "比亚迪", 70.8)], barred(api, prices))
    expect(codesOf(rows)).toEqual(["00700.HK", "01211.HK"])
  })

  it("asks for a US ticker with its exchange suffix when the search only finds it elsewhere", async () => {
    const { api, searched } = lookup(
      { TRI: [["TRI.LON", "Trifast"]], "TRI.O": [["TRI.O", "汤森路透"], ["ITRI.O", "埃创"]], NVDA: [["NVDA.O", "英伟达"]] },
      { "TRI.O": [122.08, 121], "NVDA.O": [216, 218] },
    )
    const { rows } = await fillComponentCodes([row("513100.SH", 1, "NVDA", 216), row("513100.SH", 2, "TRI", 122.08)], api)
    expect(codesOf(rows)).toEqual(["NVDA.O", "TRI.O"])
    expect(searched.sort()).toEqual(["NVDA", "TRI", "TRI.N", "TRI.O"])
  })

  it("quotes no bond, and takes the bond listed on the ETF's own exchange", async () => {
    // 26国债08 has one listing, which shows the ETF holds Shanghai/Shenzhen/Beijing bonds only.
    const { api, quoted } = lookup({ "26国债15": [["802615.BJ", "26国债15", "bond"], ["019848.SH", "26国债15", "bond"]], "26国债08": [["019834.SH", "26国债08", "bond"]] }, {})
    const { rows } = await fillComponentCodes([row("511010.SH", 1, "26国债15", 100.264), row("511010.SH", 2, "26国债08", 100.746)], api)
    expect(codesOf(rows)).toEqual(["019848.SH", "019834.SH"])
    expect(quoted).toEqual([])
  })

  it("leaves cash lines and names without a match null, and a row that carries a code untouched", async () => {
    const { api, searched } = lookup({ 申赎现金: [], 黄金9999: [] }, {})
    const carried = { fundCode: "510300.SH", serialNumber: 1, componentCode: "600519", componentName: "贵州茅台", close: 1 }
    const { rows, unresolved } = await fillComponentCodes([carried, row("510300.SH", 2, "申赎现金", null), row("518880.SH", 1, "黄金9999", null)], api)
    expect(rows[0]).toBe(carried)
    expect(codesOf(rows)).toEqual(["600519", null, null])
    expect(unresolved.map((u) => u.componentName)).toEqual(["申赎现金", "黄金9999"])
    expect(searched.sort()).toEqual(["申赎现金", "黄金9999"])
  })

  it("isolates a code the quote rejects instead of losing every price in its batch", async () => {
    const { api, quoted } = lookup({ 中国移动: AH_MOBILE, 某某控股: [["00001.HK", "某某控股"]] }, MOBILE_PRICES, { quote: "00001.HK" })
    const { rows } = await fillComponentCodes([row("517180.SH", 1, "某某控股", 5), row("517180.SH", 2, "中国移动", 77.3), row("517180.SH", 3, "中国移动", 101.3)], barred(api, MOBILE_PRICES))
    // The pair still gets its prices; the rejected code has none, and in an A+H ETF a row its
    // price cannot place stays null.
    expect(codesOf(rows)).toEqual([null, "00941.HK", "600941.SH"])
    expect(quoted.length).toBeGreaterThan(1)
  })

  it("leaves an A/H name null when no price can decide, unless the other listing's closes rule it out in a single-market ETF", async () => {
    const search: Record<string, Listing[]> = {
      龙源电力: [["001289.SZ", "龙源电力"], ["00916.HK", "龙源电力"]],
      招商银行: [["600036.SH", "招商银行"], ["03968.HK", "招商银行"]],
      中国石油: [["601857.SH", "中国石油"]],
      华润啤酒: [["00291.HK", "华润啤酒"]],
      贵州茅台: [["600519.SH", "贵州茅台"]],
    }
    const failing: CodeLookup = { ...lookup(search, {}).api, quotes: async () => { throw Object.assign(new Error("服务故障"), { code: "999999" }) } }
    const mixed = await fillComponentCodes([row("517180.SH", 1, "中国石油", 13.38), row("517180.SH", 2, "华润啤酒", 19.48), row("517180.SH", 70, "龙源电力", 5.065)], failing)
    expect(codesOf(mixed.rows)).toEqual([null, null, null])
    // 招商银行 could be the H share: 贵州茅台 alone does not make the ETF an A-share one.
    const pureRows = [row("510300.SH", 1, "贵州茅台", 1349.98), row("510300.SH", 5, "招商银行", 42.5)]
    expect(codesOf((await fillComponentCodes(pureRows, failing)).rows)).toEqual([null, null])
    // With the quote down no day after the bars is covered: no listing is ruled out.
    const quoteDown = await fillComponentCodes(pureRows, withCloses(failing, { "03968.HK": sessions([["2026-10-27", 39.0]]) }))
    expect(codesOf(quoteDown.rows)).toEqual([null, null])
    // Quoted: the H share's bars and quote cover its recent sessions, none at 42.5. The A share
    // is ex-dividend (its previous close adjusted) and has no bars, so no price confirms it, and
    // the name stands in what is now an A-share ETF.
    const quoted = lookup(search, { "600519.SH": [1335, 1349.98], "600036.SH": [42.0, 42.2], "03968.HK": [39.0, 39.2] }).api
    const ruledOut = await fillComponentCodes(pureRows, withCloses(quoted, { "03968.HK": sessions([["2026-10-26", 38.8], ["2026-10-27", 39.0]]) }))
    expect(codesOf(ruledOut.rows)).toEqual(["600519.SH", "600036.SH"])
  })

  it("in an ETF holding both markets, leaves a row null when its price decides nothing, quoted or not", async () => {
    // 中国移动 is the A row: suspended (quote 0) or ex-dividend (quote off the list), and the H
    // quote is missing. Neither says which listing the row is; the unquoted H share must not win.
    const search: Record<string, Listing[]> = { 中国移动: AH_MOBILE, 中国石油: [["601857.SH", "中国石油"]], 华润啤酒: [["00291.HK", "华润啤酒"]] }
    for (const mobileA of [[0, 0], [99.9, 100.7]]) {
      const { api } = lookup(search, { "600941.SH": mobileA, "601857.SH": [13.38, 13.2], "00291.HK": [19.48, 19.6] })
      const { rows, unresolved } = await fillComponentCodes([row("517180.SH", 1, "中国石油", 13.38), row("517180.SH", 2, "华润啤酒", 19.48), row("517180.SH", 3, "中国移动", 101.3)], api)
      expect(codesOf(rows), JSON.stringify(mobileA)).toEqual(["601857.SH", "00291.HK", null])
      expect(unresolved.map((u) => u.componentName)).toEqual(["中国移动"])
    }
  })

  it("does not take a listing in a market the ETF's prices never confirmed on the name alone", async () => {
    // The search found only London's TRI (Trifast); the Nasdaq ETF's other rows are US.
    const { api } = lookup({ NVDA: [["NVDA.O", "英伟达"]], TRI: [["TRI.LON", "Trifast"]] }, { "NVDA.O": [216, 218] })
    const { rows } = await fillComponentCodes([row("513100.SH", 1, "NVDA", 216), row("513100.SH", 2, "TRI", 122.08)], api)
    expect(codesOf(rows)).toEqual(["NVDA.O", null])
  })

  it("counts a price only when it is the row's own: an A share 0.4% off an H row's close confirms nothing", async () => {
    // The H quote is missing; 紫金矿业's A share (27.85) is close to the H row (27.74) by chance.
    // Not confirmed by it, the row falls to the name once the A share's recent closes rule it
    // out — in a Hong Kong ETF the H share. With too few of them, or none (a lookup without daily
    // closes), the row could be either and stays null.
    const { api } = lookup({ 紫金矿业: [["02899.HK", "紫金矿业"], ["601899.SH", "紫金矿业"]], 腾讯控股: [["00700.HK", "腾讯控股"]] }, { "00700.HK": [386.4, 390], "601899.SH": [27.47, 27.85] })
    const rows2 = [row("159920.SZ", 1, "腾讯控股", 386.4), row("159920.SZ", 2, "紫金矿业", 27.74)]
    const { rows } = await fillComponentCodes(rows2, withCloses(api, { "601899.SH": sessions([["2026-10-26", 27.47], ["2026-10-27", 27.85]]) }))
    expect(codesOf(rows)).toEqual(["00700.HK", "02899.HK"])
    const few = await fillComponentCodes(rows2, withCloses(api, { "601899.SH": [["2026-10-26", 27.47], ["2026-10-27", 27.85]] }))
    expect(codesOf(few.rows)).toEqual(["00700.HK", null])
    expect(codesOf((await fillComponentCodes(rows2, api)).rows)).toEqual(["00700.HK", null])
  })

  it("splits a failed quote batch only on 120001, one half at a time, and sends any other failure once", async () => {
    const names = Array.from({ length: 16 }, (_, i) => `名称${i}`)
    const search = Object.fromEntries(names.map((n, i) => [n, [[`${600000 + i}.SH`, n]] as Listing[]]))
    const rows16 = names.map((n, i) => row("510300.SH", i, n, 1))
    for (const [code, expectCalls] of [["999999", 1], ["429", 1]] as const) {
      let calls = 0
      const api: CodeLookup = { ...lookup(search, {}).api, quotes: async () => { calls++; throw Object.assign(new Error("x"), { code }) } }
      await fillComponentCodes(rows16, api)
      expect(calls, code).toBe(expectCalls)
    }
    let inflight = 0
    let peak = 0
    const splitting: CodeLookup = {
      ...lookup(search, {}).api,
      async quotes(codes) {
        inflight++
        peak = Math.max(peak, inflight)
        await new Promise((resolve) => setTimeout(resolve, 2))
        inflight--
        if (codes.includes("600003.SH")) throw Object.assign(new Error("证券代码无效"), { code: "120001" })
        return new Map(codes.map((c) => [c, { previous: 1 }]))
      },
    }
    const { rows } = await fillComponentCodes(rows16, splitting)
    expect(peak).toBe(1)
    expect(codesOf(rows).filter(Boolean)).toHaveLength(16)
  })

  it("fills a row the API answered with componentCode null or empty, once, right after serialNumber", async () => {
    const { api } = lookup({ 贵州茅台: [["600519.SH", "贵州茅台"]] }, { "600519.SH": [1335, 1349.98] })
    for (const given of [null, ""]) {
      const { rows, unresolved } = await fillComponentCodes([{ fundCode: "510300.SH", serialNumber: 1, componentCode: given, componentName: "贵州茅台", close: 1349.98 }], api)
      expect(rows[0]).toEqual({ fundCode: "510300.SH", serialNumber: 1, componentCode: "600519.SH", componentName: "贵州茅台", close: 1349.98 })
      expect(Object.keys(rows[0])).toEqual(["fundCode", "serialNumber", "componentCode", "componentName", "close"])
      expect(unresolved).toEqual([])
    }
  })

  it("checks a list whose prices lag the quote against the closes of the day they belong to", async () => {
    // 517180.SH's 10-28 list carried 10-26 closes for its A shares (its H shares were current);
    // the quote has moved on to 10-27.
    // 中国铁建's A share has not traded since 10-23 (suspended): its bars repeat that close and
    // its quote carries no price; its H share trades on.
    const search: Record<string, Listing[]> = { 中国移动: AH_MOBILE, 中国石油: [["601857.SH", "中国石油"]], 中国神华: [["601088.SH", "中国神华"]], 华润啤酒: [["00291.HK", "华润啤酒"]], 中国铁建: [["601186.SH", "中国铁建"], ["01186.HK", "中国铁建"]] }
    const history = new Map<string, Bar[]>(([
      ["601186.SH", [["2026-10-23", 6.11], ["2026-10-26", 6.11], ["2026-10-27", 6.11]]],
      ["01186.HK", [["2026-10-22", 4.3], ["2026-10-23", 4.4], ["2026-10-26", 4.5], ["2026-10-27", 4.6]]],
      ["600941.SH", [["2026-10-23", 99.14], ["2026-10-26", 101.3], ["2026-10-27", 100.7]]],
      ["00941.HK", [["2026-10-23", 77.1], ["2026-10-26", 77.3], ["2026-10-27", 78.1]]],
      ["601857.SH", [["2026-10-23", 12.75], ["2026-10-26", 13.38], ["2026-10-27", 13.2]]],
      ["601088.SH", [["2026-10-23", 38.1], ["2026-10-26", 38.6], ["2026-10-27", 38.4]]],
      ["00291.HK", [["2026-10-26", 19.3], ["2026-10-27", 19.48]]],
    ] as Array<[string, Bar[]]>).map(([code, bars]) => [code, sessions(bars)]))
    const asked: string[][] = []
    const base = lookup(search, { "600941.SH": [100.7, 100.7], "00941.HK": [78.1, 78.1], "601857.SH": [13.2, 13.2], "601088.SH": [38.4, 38.4], "00291.HK": [19.48, 19.48], "01186.HK": [4.6, 4.62], "601186.SH": [0, 0] }).api
    const api: CodeLookup = { ...base, async closes(codes) { asked.push(codes); return new Map(codes.filter((c) => history.has(c)).map((c) => [c, history.get(c)!])) } }
    const rows = [row("517180.SH", 1, "中国石油", 13.38), row("517180.SH", 2, "中国神华", 38.6), row("517180.SH", 3, "中国移动", 101.3), row("517180.SH", 4, "中国移动", 78.1), row("517180.SH", 5, "华润啤酒", 19.48), row("517180.SH", 6, "中国铁建", 6.11)]
    const { rows: out } = await fillComponentCodes(rows, api)
    expect(codesOf(out)).toEqual(["601857.SH", "601088.SH", "600941.SH", "00941.HK", "00291.HK", "601186.SH"])
    expect(asked).toHaveLength(1)
    // The H share's bars must hold four sessions to rule it out.
    const shortH = new Map([...history, ["01186.HK", [["2026-10-26", 4.5], ["2026-10-27", 4.6]] as Bar[]]])
    const { rows: unsure } = await fillComponentCodes(rows, { ...base, async closes(codes) { return new Map(codes.filter((c) => shortH.has(c)).map((c) => [c, shortH.get(c)!])) } })
    expect(codesOf(unsure)[5]).toBeNull()
    // Two Hong Kong rows showing that market's list day (10-27) do not change that: the day says
    // which close is the sure one, and ruling a listing out takes the same sessions either way.
    const withTencent = { ...search, 腾讯控股: [["00700.HK", "腾讯控股"]] as Listing[] }
    const hkDay = new Map([...shortH, ["00700.HK", [["2026-10-26", 388], ["2026-10-27", 390]] as Bar[]]])
    const quoted = lookup(withTencent, { "600941.SH": [100.7, 100.7], "00941.HK": [78.1, 78.1], "601857.SH": [13.2, 13.2], "601088.SH": [38.4, 38.4], "00291.HK": [19.48, 19.48], "00700.HK": [390, 391], "01186.HK": [4.6, 4.62], "601186.SH": [0, 0] }).api
    const { rows: known } = await fillComponentCodes([...rows, row("517180.SH", 7, "腾讯控股", 390)], { ...quoted, async closes(codes) { return new Map(codes.filter((c) => hkDay.has(c)).map((c) => [c, hkDay.get(c)!])) } })
    expect(codesOf(known)[5]).toBeNull()
    // Without the daily closes nothing is ruled out, and the lagging rows are left to the name:
    // an A+H ETF places only the row with one listing to its name that its quote confirms.
    const { rows: unaided } = await fillComponentCodes(rows, base)
    expect(codesOf(unaided)).toEqual([null, null, null, null, "00291.HK", null])
  })

  // An A+H ETF (华润啤酒 is Hong Kong only and current) whose A rows lag: the quote has moved on.
  const lagging = (history: Array<[string, Bar[]]>, extra: Record<string, Listing[]> = {}) => {
    const search: Record<string, Listing[]> = { 中国移动: AH_MOBILE, 中国石油: [["601857.SH", "中国石油"]], 中国神华: [["601088.SH", "中国神华"]], 华润啤酒: [["00291.HK", "华润啤酒"]], ...extra }
    return showing(lookup(search, { "00291.HK": [19.48, 19.48] }).api, history)
  }
  const MOBILE_A = row("517180.SH", 3, "中国移动", 101.3)
  const BEER = row("517180.SH", 2, "华润啤酒", 19.48)

  it("does not settle a list's date on a single row", async () => {
    // Only 中国石油 has a single listing with daily closes: one row says 10-26, nothing else votes.
    const api = lagging([["600941.SH", [["2026-10-26", 101.3]]], ["00941.HK", [["2026-10-26", 77.3]]], ["601857.SH", [["2026-10-26", 13.38]]]])
    const { rows } = await fillComponentCodes([row("517180.SH", 1, "中国石油", 13.38), BEER, MOBILE_A], api)
    expect(codesOf(rows)).toEqual([null, "00291.HK", null])
  })

  it("does not settle a market's date on a tie between two days", async () => {
    // 中国石油 and 中国神华 say the A shares are 10-26; 贵州茅台 and 五粮液 say 10-27.
    const api = lagging([
      ["600941.SH", [["2026-10-26", 101.3]]], ["00941.HK", [["2026-10-26", 77.3]]],
      ["601857.SH", [["2026-10-26", 13.38]]], ["601088.SH", [["2026-10-26", 38.6]]],
      ["600519.SH", [["2026-10-27", 1349.98]]], ["000858.SZ", [["2026-10-27", 75.63]]],
    ], { 贵州茅台: [["600519.SH", "贵州茅台"]], 五粮液: [["000858.SZ", "五粮液"]] })
    const { rows } = await fillComponentCodes([row("517180.SH", 1, "中国石油", 13.38), row("517180.SH", 4, "中国神华", 38.6), row("517180.SH", 5, "贵州茅台", 1349.98), row("517180.SH", 6, "五粮液", 75.63), BEER, MOBILE_A], api)
    // 贵州茅台 and 五粮液 sit at the quote's previous close, which settles a name with one listing.
    expect(codesOf(rows)).toEqual([null, null, "600519.SH", "000858.SZ", "00291.HK", null])
  })

  it("does not rule out a listing at the row's close on another session by the list day alone; the row's change does", async () => {
    // On 10-23 the H share closed at 101.3 HKD — the A row's 10-26 price, by chance. The H
    // shares' day is 10-27, and its 10-27 close is another: that makes the A share the sure one,
    // not the H share impossible — the rows of one market are not known to share a day.
    const api = lagging([
      ["600941.SH", [["2026-10-23", 99.14], ["2026-10-26", 101.3]]], ["00941.HK", [["2026-10-23", 101.3], ["2026-10-26", 77.3], ["2026-10-27", 78.1]]],
      ["601857.SH", [["2026-10-26", 13.38]]], ["601088.SH", [["2026-10-26", 38.6]]],
      ["00291.HK", [["2026-10-27", 19.48]]], ["00700.HK", [["2026-10-27", 385.2]]],
    ], { 腾讯控股: [["00700.HK", "腾讯控股"]] })
    const others = [row("517180.SH", 1, "中国石油", 13.38), row("517180.SH", 4, "中国神华", 38.6), BEER, row("517180.SH", 5, "腾讯控股", 385.2)]
    expect(codesOf((await fillComponentCodes([...others, MOBILE_A], api)).rows)).toEqual(["601857.SH", "601088.SH", "00291.HK", "00700.HK", null])
    // The row's change is the A share's on 10-26 (99.14 → 101.3), not the H share's on 10-23.
    expect(codesOf((await fillComponentCodes([...others, { ...MOBILE_A, pctChange: 2.1787 }], api)).rows)).toEqual(["601857.SH", "601088.SH", "00291.HK", "00700.HK", "600941.SH"])
  })

  it("does not rule out a listing its quote does not show, list day known or not", async () => {
    const history: Array<[string, Bar[]]> = [
      ["600941.SH", [["2026-10-23", 99.14], ["2026-10-26", 101.3]]], ["00941.HK", [["2026-10-23", 77.1], ["2026-10-26", 77.3], ["2026-10-27", 78.1]]],
      ["601857.SH", [["2026-10-26", 13.38]]], ["601088.SH", [["2026-10-26", 38.6]]], ["00291.HK", [["2026-10-27", 19.48]]], ["00700.HK", [["2026-10-27", 385.2]]],
    ]
    const api = lagging(history, { 腾讯控股: [["00700.HK", "腾讯控股"]] })
    const unquoted: CodeLookup = { ...api, async quotes(codes) { return new Map([...await api.quotes(codes)].filter(([code]) => code !== "00941.HK")) } }
    // With 腾讯控股 the Hong Kong rows show their list day (10-27); without it they show none.
    for (const hkRows of [[BEER], [BEER, row("517180.SH", 5, "腾讯控股", 385.2)]]) {
      const rows = [row("517180.SH", 1, "中国石油", 13.38), row("517180.SH", 4, "中国神华", 38.6), ...hkRows, MOBILE_A]
      expect(codesOf((await fillComponentCodes(rows, api)).rows).at(-1), `${hkRows.length}`).toBe("600941.SH")
      expect(codesOf((await fillComponentCodes(rows, unquoted)).rows).at(-1), `${hkRows.length}`).toBeNull()
    }
  })

  // An A+H list whose A rows carry 10-20 closes and whose H rows 10-22's: the quote has moved on.
  // 恒瑞医药's H row (47.44 HKD on 10-22) is within 0.05% of the A share's 10-20 close (47.45).
  const SPLIT_DATES = new Map<string, Array<[string, number]>>([
    ["601857.SH", [["2026-10-20", 13.38], ["2026-10-22", 13.0]]], ["601088.SH", [["2026-10-20", 38.6], ["2026-10-22", 38.0]]],
    ["600519.SH", [["2026-10-20", 1400], ["2026-10-22", 1420]]], ["600941.SH", [["2026-10-20", 101.3], ["2026-10-22", 100.2]]],
    ["00941.HK", [["2026-10-20", 77.0], ["2026-10-22", 77.3]]], ["00291.HK", [["2026-10-20", 19.0], ["2026-10-22", 19.48]]],
    ["00700.HK", [["2026-10-20", 380], ["2026-10-22", 385.2]]], ["00005.HK", [["2026-10-20", 118], ["2026-10-22", 120]]],
    ["600276.SH", [["2026-10-20", 47.45], ["2026-10-22", 48.3]]], ["01276.HK", [["2026-10-20", 46.1], ["2026-10-22", 47.44]]],
    ["001289.SZ", [["2026-10-20", 5.065], ["2026-10-22", 5.1]]],
  ])
  const splitDates = (history: Iterable<[string, Bar[]]> = SPLIT_DATES) => {
    const search: Record<string, Listing[]> = {
      中国石油: [["601857.SH", "中国石油"]], 中国神华: [["601088.SH", "中国神华"]], 贵州茅台: [["600519.SH", "贵州茅台"]], 中国移动: AH_MOBILE,
      华润啤酒: [["00291.HK", "华润啤酒"]], 腾讯控股: [["00700.HK", "腾讯控股"]], 汇丰控股: [["00005.HK", "汇丰控股"]], 恒瑞医药: [["600276.SH", "恒瑞医药"], ["01276.HK", "恒瑞医药"]],
      龙源电力: [["001289.SZ", "龙源电力"], ["00916.HK", "龙源电力"]],
    }
    return showing(lookup(search, {}).api, history)
  }
  const etf517 = (...rows: Array<[string, number]>) => rows.map(([name, close], i) => row("517180.SH", i + 1, name, close))

  it("dates each market's prices on their own, so the market with fewer rows is not checked against the other's day", async () => {
    const { rows } = await fillComponentCodes(etf517(["中国石油", 13.38], ["中国神华", 38.6], ["华润啤酒", 19.48], ["腾讯控股", 385.2], ["汇丰控股", 120], ["中国移动", 101.3]), splitDates())
    expect(codesOf(rows)).toEqual(["601857.SH", "601088.SH", "00291.HK", "00700.HK", "00005.HK", "600941.SH"])
  })

  it("leaves a row null when a listing it could be trades in a market whose day is unknown, or agrees as well", async () => {
    // Two H rows date the H shares to 10-22: both of 恒瑞医药's listings agree with the H row.
    const dated = await fillComponentCodes(etf517(["中国石油", 13.38], ["中国神华", 38.6], ["贵州茅台", 1400], ["华润啤酒", 19.48], ["腾讯控股", 385.2], ["恒瑞医药", 47.44]), splitDates())
    expect(codesOf(dated.rows)).toEqual(["601857.SH", "601088.SH", "600519.SH", "00291.HK", "00700.HK", null])
    // One H row dates nothing: the H share can be neither confirmed nor ruled out — by an
    // agreeing close (恒瑞医药), or by none at all (龙源电力's H share has no daily closes).
    const undated = await fillComponentCodes(etf517(["中国石油", 13.38], ["中国神华", 38.6], ["贵州茅台", 1400], ["华润啤酒", 19.48], ["恒瑞医药", 47.44], ["龙源电力", 5.065]), splitDates())
    expect(codesOf(undated.rows)).toEqual(["601857.SH", "601088.SH", "600519.SH", null, null, null])
  })

  it("leaves a row null when a listing it could be has no close on its market's day", async () => {
    // Both markets are dated; 恒瑞医药's H share alone has no daily closes, and its A share's
    // 10-20 close agrees with the H row.
    const api = splitDates()
    const { rows } = await fillComponentCodes(etf517(["中国石油", 13.38], ["中国神华", 38.6], ["贵州茅台", 1400], ["华润啤酒", 19.48], ["腾讯控股", 385.2], ["恒瑞医药", 47.44]), {
      ...api,
      async closes(codes) { return new Map([...await api.closes!(codes, "", "")].filter(([code]) => code !== "01276.HK")) },
    })
    expect(codesOf(rows)).toEqual(["601857.SH", "601088.SH", "600519.SH", "00291.HK", "00700.HK", null])
  })

  it("does not take a quoted listing when another the row could be has no quote, or quotes 0", async () => {
    // 恒瑞医药's H row; the A share's latest price happens to agree with it.
    const search: Record<string, Listing[]> = { 中国石油: [["601857.SH", "中国石油"]], 华润啤酒: [["00291.HK", "华润啤酒"]], 恒瑞医药: [["600276.SH", "恒瑞医药"], ["01276.HK", "恒瑞医药"]] }
    for (const quoteH of [undefined, [0, 0]]) {
      const prices: Record<string, number[]> = { "601857.SH": [13.38, 13.2], "00291.HK": [19.48, 19.6], "600276.SH": [47.1, 47.45], ...(quoteH ? { "01276.HK": quoteH } : {}) }
      const { rows } = await fillComponentCodes(etf517(["中国石油", 13.38], ["华润啤酒", 19.48], ["恒瑞医药", 47.44]), lookup(search, prices).api)
      expect(codesOf(rows), JSON.stringify(quoteH)).toEqual(["601857.SH", "00291.HK", null])
    }
  })

  it("does not take an exact listing its price confirms while a longer name the row could be has no price", async () => {
    // 中国石油股份 (the H share's name) starts with the A row's name and quotes 0 (suspended):
    // an exact name does not outrank it, and nothing rules it out.
    const search: Record<string, Listing[]> = { 中国石油: [["601857.SH", "中国石油"], ["00857.HK", "中国石油股份"]], 华润啤酒: [["00291.HK", "华润啤酒"]] }
    const { api } = lookup(search, { "601857.SH": [13.38, 13.2], "00857.HK": [0, 0], "00291.HK": [19.48, 19.6] })
    const { rows } = await fillComponentCodes(etf517(["中国石油", 13.38], ["华润啤酒", 19.48]), api)
    expect(codesOf(rows)).toEqual([null, "00291.HK"])
    // Trading, with its recent sessions in the bars and none at 13.38, it is ruled out.
    const trading = lookup(search, { "601857.SH": [13.38, 13.2], "00857.HK": [7.2, 7.25], "00291.HK": [19.48, 19.6] }).api
    const ruledOut = await fillComponentCodes(etf517(["中国石油", 13.38], ["华润啤酒", 19.48]), withCloses(trading, { "00857.HK": sessions([["2026-10-26", 7.1], ["2026-10-27", 7.2]]) }))
    expect(codesOf(ruledOut.rows)).toEqual(["601857.SH", "00291.HK"])
  })

  it("does not hold a row back for a listing another row's price has taken", async () => {
    // The H row of 中国移动 is current (the quote's previous close, 10-27) and takes 00941.HK; the
    // H shares have no day of their own, and 00941.HK's 10-20 close happens to equal the A row's
    // price.
    const history = new Map<string, Bar[]>([...SPLIT_DATES, ["600941.SH", [["2026-10-20", 101.3], ["2026-10-22", 100.2], ["2026-10-27", 100.7]]], ["00941.HK", [["2026-10-20", 101.3], ["2026-10-22", 77.3], ["2026-10-27", 78.1]]]])
    const { rows } = await fillComponentCodes(etf517(["中国石油", 13.38], ["中国神华", 38.6], ["中国移动", 78.1], ["中国移动", 101.3]), splitDates(history))
    expect(codesOf(rows)).toEqual(["601857.SH", "601088.SH", "00941.HK", "600941.SH"])
  })

  it("takes a name whose exact listings all trade in one market as a sign of that market", async () => {
    // 腾讯控股 has two Hong Kong listings (the HKD and the RMB counter): the ETF holds Hong Kong
    // stocks too, so with no price to decide, the 中国移动 row is not taken for the A share.
    const search: Record<string, Listing[]> = { 贵州茅台: [["600519.SH", "贵州茅台"]], 腾讯控股: [["00700.HK", "腾讯控股"], ["80700.HK", "腾讯控股-R"]], 中国移动: AH_MOBILE }
    const failing: CodeLookup = { ...lookup(search, {}).api, quotes: async () => { throw Object.assign(new Error("服务故障"), { code: "999999" }) } }
    const { rows } = await fillComponentCodes([row("517180.SH", 1, "贵州茅台", 1349.98), row("517180.SH", 2, "腾讯控股", 386.4), row("517180.SH", 3, "中国移动", 78.1)], failing)
    expect(codesOf(rows)).toEqual([null, null, null])
  })

  // An A/H name no price settles leaves the ETF's market unknown, whatever the other rows
  // show: an A+H ETF can hold the H share of a dual-listed company beside A-only names.
  const down = async () => { throw Object.assign(new Error("服务故障"), { code: "999999" }) }
  it("does not fill an A/H name from the other rows' market when no price decides it, whichever row comes first", async () => {
    const search: Record<string, Listing[]> = { 贵州茅台: [["600519.SH", "贵州茅台"]], 中国移动: AH_MOBILE }
    for (const order of [[77.3, 101.3], [101.3, 77.3]]) {
      const { rows } = await fillComponentCodes([row("517180.SH", 1, "贵州茅台", 1349.98), ...order.map((close, i) => row("517180.SH", i + 2, "中国移动", close))], { ...lookup(search, {}).api, quotes: down })
      expect(codesOf(rows).slice(1), JSON.stringify(order)).toEqual([null, null])
    }
  })

  it("counts a longer Hong Kong name as a market the row could be in, though it never fills the row", async () => {
    // The H share is listed as 中国石油股份; quote and daily closes both fail.
    const search: Record<string, Listing[]> = { 中国石油: [["601857.SH", "中国石油"], ["00857.HK", "中国石油股份"]] }
    for (const order of [[7.2, 13.38], [13.38, 7.2]]) {
      const { rows } = await fillComponentCodes(order.map((close, i) => row("517180.SH", i + 1, "中国石油", close)), { ...lookup(search, {}).api, quotes: down, closes: down })
      expect(codesOf(rows), JSON.stringify(order)).toEqual([null, null])
    }
  })

  it("takes neither listing while one is at the row's close on its list day and the other on a session only its quote shows", async () => {
    // The list carries A shares at 10-20 closes and H shares at 10-22's. 恒瑞医药 is the H row
    // (47.44 on 10-22); the A share's latest price is 47.44 by chance, on a day its bars do not
    // show: the quote is not taken for the A share, and the A share is not ruled out either.
    const search: Record<string, Listing[]> = { 中国石油: [["601857.SH", "中国石油"]], 中国神华: [["601088.SH", "中国神华"]], 华润啤酒: [["00291.HK", "华润啤酒"]], 腾讯控股: [["00700.HK", "腾讯控股"]], 恒瑞医药: [["600276.SH", "恒瑞医药"], ["01276.HK", "恒瑞医药"]] }
    const prices = { "601857.SH": [13.0, 13.1], "601088.SH": [38.0, 38.1], "00291.HK": [19.6, 19.7], "00700.HK": [390, 392], "600276.SH": [47.1, 47.44], "01276.HK": [48.3, 48.5] }
    const history: Record<string, Array<[string, number]>> = {
      "601857.SH": [["2026-10-20", 13.38], ["2026-10-22", 13.0]], "601088.SH": [["2026-10-20", 38.6], ["2026-10-22", 38.0]],
      "00291.HK": [["2026-10-20", 19.0], ["2026-10-22", 19.48]], "00700.HK": [["2026-10-20", 380], ["2026-10-22", 385.2]],
      "600276.SH": [["2026-10-20", 46.9], ["2026-10-22", 47.6]], "01276.HK": [["2026-10-20", 46.1], ["2026-10-22", 47.44]],
    }
    const rows5 = etf517(["中国石油", 13.38], ["中国神华", 38.6], ["华润啤酒", 19.48], ["腾讯控股", 385.2], ["恒瑞医药", 47.44])
    const { rows } = await fillComponentCodes(rows5, showing(lookup(search, prices).api, Object.entries(history)))
    expect(codesOf(rows)).toEqual(["601857.SH", "601088.SH", "00291.HK", "00700.HK", null])
    // The A share quoted at another price: its sessions are all shown, none at 47.44.
    const moved = lookup(search, { ...prices, "600276.SH": [47.1, 47.3] }).api
    expect(codesOf((await fillComponentCodes(rows5, showing(moved, Object.entries(history)))).rows)[4]).toBe("01276.HK")
    // Without the H share's closes nothing shows it at the row's price.
    const { "01276.HK": _, ...noH } = history
    expect(codesOf((await fillComponentCodes(rows5, showing(moved, Object.entries(noH)))).rows)[4]).toBeNull()
  })

  it("leaves the market unknown when a name's lookup failed", async () => {
    const { api } = lookup({ 贵州茅台: [["600519.SH", "贵州茅台"]], 中国移动: AH_MOBILE }, {}, { search: "腾讯控股" })
    const { rows, unresolved } = await fillComponentCodes([row("517180.SH", 1, "贵州茅台", 1349.98), row("517180.SH", 2, "腾讯控股", 386.4), row("517180.SH", 3, "中国移动", 78.1)], { ...api, quotes: down })
    expect(codesOf(rows)).toEqual([null, null, null])
    expect(unresolved).toHaveLength(3)
    // What it guards when every row has a price: 腾讯控股 would have shown the ETF holds Hong
    // Kong stocks, so 招商银行's A/H price tie is not settled for the A share.
    const tie = lookup({ 贵州茅台: [["600519.SH", "贵州茅台"]], 招商银行: [["600036.SH", "招商银行"], ["03968.HK", "招商银行"]] }, { "600519.SH": [1335, 1349.98], "600036.SH": [42.5, 42.3], "03968.HK": [42.5, 42.6] }, { search: "腾讯控股" }).api
    const tied = await fillComponentCodes([row("517180.SH", 1, "贵州茅台", 1349.98), row("517180.SH", 2, "腾讯控股", 386.4), row("517180.SH", 3, "招商银行", 42.5)], tie)
    expect(codesOf(tied.rows)).toEqual(["600519.SH", null, null])
    // A name that merely finds nothing (a cash line) hides nothing.
    const cash = await fillComponentCodes([row("510300.SH", 1, "贵州茅台", 1349.98), row("510300.SH", 2, "申赎现金", null)], { ...lookup({ 贵州茅台: [["600519.SH", "贵州茅台"]], 申赎现金: [] }, {}).api, quotes: down })
    expect(codesOf(cash.rows)).toEqual(["600519.SH", null])
  })

  it("counts a listing that both suffix searches find once", async () => {
    const { api } = lookup({ TRI: [["TRI.LON", "Trifast"]], "TRI.O": [["TRI.O", "汤森路透"]], "TRI.N": [["TRI.O", "汤森路透"]], NVDA: [["NVDA.O", "英伟达"]] }, { "TRI.O": [122.08, 121], "NVDA.O": [216, 218] })
    const { rows } = await fillComponentCodes([row("513100.SH", 1, "NVDA", 216), row("513100.SH", 2, "TRI", 122.08)], api)
    expect(codesOf(rows)).toEqual(["NVDA.O", "TRI.O"])
  })

  it("settles a price tie across markets by the ETF's one market once the other listing's recent closes rule it out, and leaves it null otherwise", async () => {
    // 招商银行's A share (42.5 CNY) and H share (42.5 HKD) both agree with the row.
    const search: Record<string, Listing[]> = { 贵州茅台: [["600519.SH", "贵州茅台"]], 招商银行: [["600036.SH", "招商银行"], ["03968.HK", "招商银行"]], 华润啤酒: [["00291.HK", "华润啤酒"]] }
    const prices = { "600519.SH": [1335, 1349.98], "600036.SH": [42.5, 42.3], "03968.HK": [42.5, 42.6], "00291.HK": [19.48, 19.6] }
    // The H share's quote ties by its previous close (adjusted: an ex-dividend day), but its bars
    // show its 10-27 close and the sessions before, none at 42.5: the row is not it.
    const ruledOut = withCloses(lookup(search, prices).api, { "03968.HK": sessions([["2026-10-26", 44.1], ["2026-10-27", 44.3]]) })
    const one = await fillComponentCodes([row("510300.SH", 1, "贵州茅台", 1349.98), row("510300.SH", 5, "招商银行", 42.5)], ruledOut)
    expect(codesOf(one.rows)).toEqual(["600519.SH", "600036.SH"])
    // Without its closes the H share cannot be ruled out, and 贵州茅台 alone does not show the ETF holds A shares only.
    const open = await fillComponentCodes([row("510300.SH", 1, "贵州茅台", 1349.98), row("510300.SH", 5, "招商银行", 42.5)], withCloses(lookup(search, prices).api, {}))
    expect(codesOf(open.rows)).toEqual(["600519.SH", null])
    // The H share ruled out, the row is the A share in an ETF holding both markets too.
    const both = await fillComponentCodes([row("517180.SH", 1, "贵州茅台", 1349.98), row("517180.SH", 2, "华润啤酒", 19.48), row("517180.SH", 3, "招商银行", 42.5)], ruledOut)
    expect(codesOf(both.rows)).toEqual(["600519.SH", "00291.HK", "600036.SH"])
  })

  it("does not fill a quote the other market's recent closes leave contested from the other rows' market", async () => {
    // 恒瑞医药's list price equals its A share's quote and an H share close: the row could be
    // either, and two A-share rows do not show which.
    const search: Record<string, Listing[]> = { 中国石油: [["601857.SH", "中国石油"]], 中国神华: [["601088.SH", "中国神华"]], 恒瑞医药: [["600276.SH", "恒瑞医药"], ["01276.HK", "恒瑞医药"]] }
    const prices = { "601857.SH": [13.38, 13.2], "601088.SH": [38.5, 38.1], "600276.SH": [47.44, 47.0], "01276.HK": [52.1, 51.8] }
    const api = withCloses(lookup(search, prices).api, { "01276.HK": [["2026-10-27", 47.44]] })
    const { rows, unresolved } = await fillComponentCodes([row("510300.SH", 1, "中国石油", 13.38), row("510300.SH", 2, "中国神华", 38.5), row("510300.SH", 3, "恒瑞医药", 47.44)], api)
    expect(codesOf(rows)).toEqual(["601857.SH", "601088.SH", null])
    expect(unresolved.map((u) => u.componentName)).toEqual(["恒瑞医药"])
  })

  describe("a row's own change decides between listings its price leaves open", () => {
    // 招商银行's A share (CNY) and H share (HKD) both closed at 42.5 on 10-27, moving +0.47% and -0.23%.
    const search: Record<string, Listing[]> = { 贵州茅台: [["600519.SH", "贵州茅台"]], 招商银行: [["600036.SH", "招商银行"], ["03968.HK", "招商银行"]], 华润啤酒: [["00291.HK", "华润啤酒"]] }
    const prices = { "600519.SH": [1335, 1349.98], "600036.SH": [42.5, 42.3], "03968.HK": [42.5, 42.6], "00291.HK": [19.48, 19.6] }
    const bars: Record<string, Array<[string, number, number?]>> = { "600036.SH": sessions([["2026-10-27", 42.5, 0.4728]]), "03968.HK": sessions([["2026-10-27", 42.5, -0.2347]]) }
    const withChange = (fundCode: string, serialNumber: number, name: string, close: number, pctChange: number) => ({ ...row(fundCode, serialNumber, name, close), pctChange })

    it("settles a tie across markets, also in an ETF holding both", async () => {
      const api = withCloses(lookup(search, prices).api, bars)
      const aOnly = await fillComponentCodes([withChange("510300.SH", 1, "贵州茅台", 1349.98, 1.12), withChange("510300.SH", 5, "招商银行", 42.5, 0.4728)], api)
      expect(codesOf(aOnly.rows)).toEqual(["600519.SH", "600036.SH"])
      const both = await fillComponentCodes([withChange("517180.SH", 1, "贵州茅台", 1349.98, 1.12), withChange("517180.SH", 2, "华润啤酒", 19.48, -0.61), withChange("517180.SH", 3, "招商银行", 42.5, -0.2347)], api)
      expect(codesOf(both.rows)).toEqual(["600519.SH", "00291.HK", "03968.HK"])
    })

    it("settles a quote the other market's close contested, either way", async () => {
      // 恒瑞医药's A share quotes 47.44; its H share closed at 47.44 on 10-27, on another change.
      const hengrui: Record<string, Listing[]> = { 中国石油: [["601857.SH", "中国石油"]], 中国神华: [["601088.SH", "中国神华"]], 恒瑞医药: [["600276.SH", "恒瑞医药"], ["01276.HK", "恒瑞医药"]] }
      const quoted = { "601857.SH": [13.38, 13.2], "601088.SH": [38.5, 38.1], "600276.SH": [47.44, 47.0], "01276.HK": [52.1, 51.8] }
      const history: Record<string, Array<[string, number, number?]>> = { "600276.SH": sessions([["2026-10-27", 47.44, 0.9362]]), "01276.HK": sessions([["2026-10-27", 47.44, 2.5065]]) }
      const api = withCloses(lookup(hengrui, quoted).api, history)
      const rows = (change: number) => [withChange("510300.SH", 1, "中国石油", 13.38, 1.36), withChange("510300.SH", 2, "中国神华", 38.5, 1.05), withChange("510300.SH", 3, "恒瑞医药", 47.44, change)]
      expect(codesOf((await fillComponentCodes(rows(0.9362), api)).rows)).toEqual(["601857.SH", "601088.SH", "600276.SH"])
      expect(codesOf((await fillComponentCodes(rows(2.5065), api)).rows)).toEqual(["601857.SH", "601088.SH", "01276.HK"])
    })

    it("decides nothing when a listing it could be has no daily bars, or the change fits neither", async () => {
      const partial = withCloses(lookup(search, prices).api, { "600036.SH": bars["600036.SH"] })
      expect(codesOf((await fillComponentCodes([withChange("517180.SH", 1, "贵州茅台", 1349.98, 1.12), withChange("517180.SH", 2, "华润啤酒", 19.48, -0.61), withChange("517180.SH", 3, "招商银行", 42.5, 0.4728)], partial)).rows)).toEqual(["600519.SH", "00291.HK", null])
      const api = withCloses(lookup(search, prices).api, bars)
      expect(codesOf((await fillComponentCodes([withChange("517180.SH", 1, "贵州茅台", 1349.98, 1.12), withChange("517180.SH", 2, "华润啤酒", 19.48, -0.61), withChange("517180.SH", 3, "招商银行", 42.5, 3.1)], api)).rows)).toEqual(["600519.SH", "00291.HK", null])
    })

    it("does not rule out a listing whose day at the row's close has no change to compare", async () => {
      // The H share closed at 42.5 too, but without a previous close its change is unknown.
      const api = withCloses(lookup(search, prices).api, { "600036.SH": bars["600036.SH"], "03968.HK": sessions([["2026-10-27", 42.5]]) })
      expect(codesOf((await fillComponentCodes([withChange("510300.SH", 1, "贵州茅台", 1349.98, 1.12), withChange("510300.SH", 5, "招商银行", 42.5, 0.4728)], api)).rows)).toEqual(["600519.SH", null])
      expect(codesOf((await fillComponentCodes([withChange("517180.SH", 1, "贵州茅台", 1349.98, 1.12), withChange("517180.SH", 2, "华润啤酒", 19.48, -0.61), withChange("517180.SH", 3, "招商银行", 42.5, 0.4728)], api)).rows)).toEqual(["600519.SH", "00291.HK", null])
      // A day at another close without a change rules nothing out either way: the bar that fits still decides.
      const elsewhere = withCloses(lookup(search, prices).api, { "600036.SH": bars["600036.SH"], "03968.HK": sessions([["2026-10-24", 41.9], ["2026-10-27", 42.5, -0.2347]]) })
      expect(codesOf((await fillComponentCodes([withChange("510300.SH", 1, "贵州茅台", 1349.98, 1.12), withChange("510300.SH", 5, "招商银行", 42.5, 0.4728)], elsewhere)).rows)).toEqual(["600519.SH", "600036.SH"])
    })

    it("does not rule out a listing whose bars do not reach the day in question", async () => {
      const others = [withChange("517180.SH", 1, "贵州茅台", 1349.98, 1.12), withChange("517180.SH", 2, "华润啤酒", 19.48, -0.61)]
      // The quote runs a day ahead of the daily bars: the A share closed at 42.5 today (+0.4728%),
      // its bars reach back but end the day before, and the H share happened to close at 42.5 on that change earlier.
      const ahead = withCloses(lookup(search, { ...prices, "600036.SH": [42.3, 42.5], "03968.HK": [42.6, 42.9] }).api, { "600036.SH": [["2026-10-24", 42.43, 0.2], ["2026-10-27", 42.3, -0.3064]], "03968.HK": [["2026-10-24", 42.5, 0.4728], ["2026-10-27", 42.6, 0.2353]] })
      expect(codesOf((await fillComponentCodes([...others, withChange("517180.SH", 3, "招商银行", 42.5, 0.4728)], ahead)).rows)).toEqual(["600519.SH", "00291.HK", null])
      // The A share's bars begin after the day the H share fits: what it closed at then is not known.
      const late = withCloses(lookup(search, { ...prices, "600036.SH": [43.1, 43.4], "03968.HK": [42.6, 42.9] }).api, { "600036.SH": [["2026-10-28", 43.1, 0.6]], "03968.HK": [["2026-10-24", 42.5, 0.4728], ["2026-10-27", 42.6, 0.2353]] })
      expect(codesOf((await fillComponentCodes([...others, withChange("517180.SH", 3, "招商银行", 42.5, 0.4728)], late)).rows)).toEqual(["600519.SH", "00291.HK", null])
      // Bars that reach back to that day and show another close do rule it out.
      const covered = withCloses(lookup(search, { ...prices, "600036.SH": [43.1, 43.4], "03968.HK": [42.6, 42.9] }).api, { "600036.SH": sessions([["2026-10-24", 42.9, 0.1], ["2026-10-27", 43.1, 0.4662]]), "03968.HK": [["2026-10-24", 42.5, 0.4728], ["2026-10-27", 42.6, 0.2353]] })
      expect(codesOf((await fillComponentCodes([...others, withChange("517180.SH", 3, "招商银行", 42.5, 0.4728)], covered)).rows)).toEqual(["600519.SH", "00291.HK", "03968.HK"])
    })

    it("keeps a listing whose bars do not reach its quote's day out of the ETF's market too, when both listings quote the row's close", async () => {
      // A Hong Kong ETF: 招商银行's A and H shares both closed at 42.5 on 10-27, the day before the quote.
      const hk: Record<string, Listing[]> = { 腾讯控股: [["00700.HK", "腾讯控股"]], 华润啤酒: [["00291.HK", "华润啤酒"]], 招商银行: [["600036.SH", "招商银行"], ["03968.HK", "招商银行"]] }
      const quoted = { "00700.HK": [390, 392], "00291.HK": [19.48, 19.6], "600036.SH": [42.5, 42.7], "03968.HK": [42.5, 42.6] }
      const hShare: Array<[string, number, number?]> = [["2026-10-24", 42.3, 0.2], ["2026-10-27", 42.5, 0.4728]]
      const fill = async (aShare: Array<[string, number, number?]>, change?: number) => codesOf((await fillComponentCodes([
        withChange("513180.SH", 1, "腾讯控股", 390, 0.5), withChange("513180.SH", 2, "华润啤酒", 19.48, -0.61),
        change === undefined ? row("513180.SH", 3, "招商银行", 42.5) : withChange("513180.SH", 3, "招商银行", 42.5, change),
      ], withCloses(lookup(hk, quoted).api, { "600036.SH": aShare, "03968.HK": hShare }))).rows)
      // The A share's bars stop at 10-23, none at 42.5: its 10-27 close is not in them, so the
      // other rows' market (Hong Kong) does not settle the row — with its change or without.
      const short: Array<[string, number, number?]> = [["2026-10-22", 42.43, 0.2], ["2026-10-23", 42.0, -1.0141]]
      expect(await fill(short, 0.4728)).toEqual(["00700.HK", "00291.HK", null])
      expect(await fill(short)).toEqual(["00700.HK", "00291.HK", null])
      // Bars that reach 10-27 show the A share's change there, and it is another.
      expect(await fill(sessions([["2026-10-23", 42.0, -1.0141], ["2026-10-27", 42.5, 1.1905]]), 0.4728)).toEqual(["00700.HK", "00291.HK", "03968.HK"])
    })

    it("does not rule out a listing whose bars begin after the day the other listing shows at the row's close, at any later step", async () => {
      // A Hong Kong ETF; its other rows show no list day. The H share closed at 42.5 (+0.4728%) on 10-26.
      const hk: Record<string, Listing[]> = { 腾讯控股: [["00700.HK", "腾讯控股"]], 华润啤酒: [["00291.HK", "华润啤酒"]], 招商银行: [["600036.SH", "招商银行"], ["03968.HK", "招商银行"]] }
      const fill = async (hQuote: number[], aShare: Array<[string, number, number?]>, hkListDay = false) => {
        const hShare: Array<[string, number, number?]> = [["2026-10-23", 42.3, 0.24], ["2026-10-26", 42.5, 0.4728], ["2026-10-27", hQuote[0], 0]]
        // With these the rows show the Hong Kong list day (10-27) — and nothing of the A shares'.
        const hkRows: Record<string, Array<[string, number, number?]>> = hkListDay ? { "00700.HK": [["2026-10-27", 390, 0.26]], "00291.HK": [["2026-10-27", 19.48, -0.1]] } : {}
        const api = withCloses(lookup(hk, { "00700.HK": [390, 392], "00291.HK": [19.48, 19.6], "600036.SH": [43.0, 43.2], "03968.HK": hQuote }).api, { "600036.SH": aShare, "03968.HK": hShare, ...hkRows })
        return codesOf((await fillComponentCodes([withChange("513180.SH", 1, "腾讯控股", 390, 0.5), withChange("513180.SH", 2, "华润啤酒", 19.48, -0.61), withChange("513180.SH", 3, "招商银行", 42.5, 0.4728)], api)).rows)
      }
      // The A share's bars begin on 10-27: what it closed at on 10-26 is not known — neither the
      // change, nor the other rows' market (Hong Kong) by name, nor the H share's quote settles the row.
      const late: Array<[string, number, number?]> = [["2026-10-27", 43.0, 0.7026]]
      expect(await fill([42.8, 42.9], late)).toEqual(["00700.HK", "00291.HK", null])
      expect(await fill([42.5, 42.8], late)).toEqual(["00700.HK", "00291.HK", null])
      expect(await fill([42.8, 42.9], [])).toEqual(["00700.HK", "00291.HK", null])
      // The Hong Kong list day says nothing of the A share's: still unsettled.
      expect(await fill([42.8, 42.9], late, true)).toEqual(["00700.HK", "00291.HK", null])
      expect(await fill([42.5, 42.8], late, true)).toEqual(["00700.HK", "00291.HK", null])
      // Bars that reach back to 10-26 and show another close do rule it out.
      const early: Array<[string, number, number?]> = sessions([["2026-10-23", 42.9, 0.1], ["2026-10-26", 42.7, -0.4662], ["2026-10-27", 43.0, 0.7026]])
      expect(await fill([42.8, 42.9], early)).toEqual(["00700.HK", "00291.HK", "03968.HK"])
      expect(await fill([42.5, 42.8], early)).toEqual(["00700.HK", "00291.HK", "03968.HK"])
    })

    it("does not rule out a listing whose bars begin after its own market's list day, whatever the other listing shows", async () => {
      // 中国石油 and 中国神华 show the A-share list day (10-26). The H share's quote puts it at 42.5;
      // the A share's bars begin on 10-27, after that day — so the quote does not settle the row.
      const search: Record<string, Listing[]> = { 中国石油: [["601857.SH", "中国石油"]], 中国神华: [["601088.SH", "中国神华"]], 招商银行: [["600036.SH", "招商银行"], ["03968.HK", "招商银行"]] }
      const quoted = { "601857.SH": [13.2, 13.5], "601088.SH": [38.4, 38.7], "600036.SH": [43.0, 43.2], "03968.HK": [42.5, 42.8] }
      const fill = async (aShare: Array<[string, number, number?]>) => codesOf((await fillComponentCodes([row("517180.SH", 1, "中国石油", 13.38), row("517180.SH", 2, "中国神华", 38.6), row("517180.SH", 3, "招商银行", 42.5)],
        withCloses(lookup(search, quoted).api, { "601857.SH": [["2026-10-23", 12.9], ["2026-10-26", 13.38], ["2026-10-27", 13.2]], "601088.SH": [["2026-10-23", 38.1], ["2026-10-26", 38.6], ["2026-10-27", 38.4]], "600036.SH": aShare, "03968.HK": [["2026-10-27", 42.5]] }))).rows)
      expect(await fill([["2026-10-27", 43.0, 0.7026]])).toEqual(["601857.SH", "601088.SH", null])
      // Bars that reach 10-26 and show another close rule it out: the H share's quote stands.
      expect(await fill(sessions([["2026-10-26", 42.7], ["2026-10-27", 43.0, 0.7026]]))).toEqual(["601857.SH", "601088.SH", "03968.HK"])
    })

    it("does not rule out a listing its quote puts at the row's close on a day its bars do not reach, judged by the quote's date", async () => {
      const others = [withChange("517180.SH", 1, "贵州茅台", 1349.98, 1.12), withChange("517180.SH", 2, "华润啤酒", 19.48, -0.61)]
      const hShare: Array<[string, number, number?]> = [["2026-10-24", 42.5, 0.4728], ["2026-10-27", 42.6, 0.2353]]
      const fill = async (quote: number[], aShare: Array<[string, number, number?]>, quoteDate: string | null = QUOTE_DATE) => codesOf((await fillComponentCodes([...others, withChange("517180.SH", 3, "招商银行", 42.5, 0.4728)], withCloses(lookup(search, { ...prices, "600036.SH": quote, "03968.HK": [42.6, 42.9] }, {}, quoteDate).api, { "600036.SH": aShare, "03968.HK": hShare }))).rows)
      // The A share's latest price (10-28) is 42.5, a day its bars do not reach; 10-22 at 42.5 on another change says nothing about it.
      expect(await fill([42.3, 42.5], [["2026-10-22", 42.5, 1.2], ["2026-10-24", 42.43, 0.2], ["2026-10-27", 42.3, -0.3064]])).toEqual(["600519.SH", "00291.HK", null])
      // Its previous close (10-27) is 42.5, and its bars end days before, on a close that happens to equal it.
      expect(await fill([42.5, 42.7], [["2026-10-22", 42.43, 0.2], ["2026-10-23", 42.5, 1.2]])).toEqual(["600519.SH", "00291.HK", null])
      // A quote that did not move: the latest price's day is not reached.
      expect(await fill([42.5, 42.5], [["2026-10-24", 42.5, 0.9], ["2026-10-27", 42.5, 0]])).toEqual(["600519.SH", "00291.HK", null])
      // A quote without its date shows no day, whatever the bars reach.
      expect(await fill([42.5, 42.7], [["2026-10-24", 42.43, 0.2], ["2026-10-27", 42.5, 1.2]], null)).toEqual(["600519.SH", "00291.HK", null])
      // The bars reach the previous close's day (the weekday before the quote's) and show another change there.
      expect(await fill([42.5, 42.7], sessions([["2026-10-24", 42.43, 0.2], ["2026-10-27", 42.5, 1.2]]))).toEqual(["600519.SH", "00291.HK", "03968.HK"])
      // A Monday quote: the weekday before is the Friday.
      expect(await fill([42.5, 42.7], sessions([["2026-10-24", 42.43, 0.2], ["2026-10-30", 42.5, 1.2]]), "2026-11-02")).toEqual(["600519.SH", "00291.HK", "03968.HK"])
      // Bars that reach the quote's day reach the previous close's too, even past a weekday without a bar (a holiday).
      expect(await fill([42.5, 42.7], sessions([["2026-10-23", 42.43, 0.2], ["2026-10-26", 42.5, 1.2], ["2026-10-28", 42.7, 0.4706]]))).toEqual(["600519.SH", "00291.HK", "03968.HK"])
      // Bars that reach the quote's day show that day's change, and it is another.
      expect(await fill([42.0, 42.5], sessions([["2026-10-24", 42.43, 0.2], ["2026-10-27", 42.0, -1.0141], ["2026-10-28", 42.5, 1.1905]]))).toEqual(["600519.SH", "00291.HK", "03968.HK"])
    })
  })

  it("leaves only the name whose search failed null", async () => {
    const { api } = lookup({ 中国移动: AH_MOBILE }, MOBILE_PRICES, { search: "腾讯控股" })
    const { rows } = await fillComponentCodes([row("517180.SH", 1, "腾讯控股", 386.4), row("517180.SH", 2, "中国移动", 101.3)], barred(api, MOBILE_PRICES))
    expect(codesOf(rows)).toEqual([null, "600941.SH"])
  })
})

describe("fillComponentCodes: what the evidence settles", () => {
  for (const c of UNDECIDABLE) {
    it(`leaves a row null: ${c.name}`, async () => {
      const { rows, unresolved } = await fillComponentCodes(caseRows(c), caseLookup(c))
      expect(rows[c.at].componentCode, `the row is ${c.truth}`).toBeNull()
      expect(unresolved.map((u) => u.serialNumber)).toContain(c.at + 1)
    })
  }

  for (const c of DECIDABLE) {
    it(`fills every row: ${c.name}`, async () => {
      const lookup = caseLookup(c)
      for (const order of [c.rows.map((_, i) => i), c.rows.map((_, i) => c.rows.length - 1 - i)]) {
        const rows = caseRows(c)
        const { rows: out } = await fillComponentCodes(order.map((i) => rows[i]), lookup)
        expect(out.map((r) => r.componentCode), JSON.stringify(order)).toEqual(order.map((i) => c.want[i]))
      }
    })
  }

  // 招商银行 twice in an A+H ETF: 42.6 is only the H share's (its previous close), 42.5 both
  // listings' (the A share's previous close, the H share's latest price).
  const cmb = { 贵州茅台: [["600519.SH", "贵州茅台"]], 腾讯控股: [["00700.HK", "腾讯控股"]], 招商银行: [["600036.SH", "招商银行"], ["03968.HK", "招商银行"]] } as Record<string, Array<[string, string]>>
  const cmbQuotes: Record<string, number[]> = { "600519.SH": [1349.98, 1355.9], "00700.HK": [390, 392], "600036.SH": [42.5, 42.3], "03968.HK": [42.6, 42.5] }
  const cmbBars: Record<string, Bar[]> = {
    "600519.SH": [["2026-10-22", 1320], ["2026-10-23", 1335, 1.136], ["2026-10-26", 1340, 0.375], ["2026-10-27", 1349.98, 0.745]],
    "00700.HK": [["2026-10-22", 385], ["2026-10-23", 386, 0.26], ["2026-10-26", 388, 0.52], ["2026-10-27", 390, 0.52]],
    "600036.SH": [["2026-10-22", 42.0], ["2026-10-23", 42.2, 0.476], ["2026-10-26", 42.3, 0.237], ["2026-10-27", 42.5, 0.473]],
    "03968.HK": [["2026-10-22", 43.0], ["2026-10-23", 42.9, -0.233], ["2026-10-26", 42.8, -0.233], ["2026-10-27", 42.6, -0.467]],
  }
  const cmbLookup = (closes?: Record<string, Bar[]>) => {
    const { api } = lookup(cmb, cmbQuotes)
    return closes ? withCloses(api, closes) : api
  }

  it("takes a listing another row has taken out of a row's reach, whichever row comes first", async () => {
    const lines: Array<[string, number]> = [["贵州茅台", 1349.98], ["招商银行", 42.5], ["招商银行", 42.6]]
    for (const order of [[0, 1, 2], [0, 2, 1], [2, 1, 0]]) {
      const rows = order.map((i, n) => row("517180.SH", n + 1, ...lines[i]))
      const byClose = async (api: CodeLookup) => {
        const { rows: out } = await fillComponentCodes(rows, api)
        return [42.5, 42.6].map((close) => out.find((r) => r.close === close)!.componentCode)
      }
      // The 42.6 row takes 03968.HK; the 42.5 row is left the A share.
      expect(await byClose(cmbLookup(cmbBars)), JSON.stringify(order)).toEqual(["600036.SH", "03968.HK"])
      // No daily closes — a lookup without them, or asked for and none came: nothing is ruled out.
      expect(await byClose(cmbLookup()), JSON.stringify(order)).toEqual([null, null])
      expect(await byClose(cmbLookup({})), JSON.stringify(order)).toEqual([null, null])
    }
  })

  it("does not fill the listing left over when nothing shows it at the row's close", async () => {
    // The other 招商银行 row takes 03968.HK; the 41.0 row agrees with nothing the A share shows.
    for (const fundCode of ["517180.SH", "159920.SZ"]) {
      const first = fundCode === "517180.SH" ? row(fundCode, 1, "贵州茅台", 1349.98) : row(fundCode, 1, "腾讯控股", 390)
      for (const closes of [cmbBars, undefined, {}]) {
        const { rows } = await fillComponentCodes([first, row(fundCode, 2, "招商银行", 42.6), row(fundCode, 3, "招商银行", 41.0)], cmbLookup(closes))
        expect(rows[2].componentCode, `${fundCode} ${closes ? Object.keys(closes).length : "no closes"}`).toBeNull()
      }
    }
  })

  it("weighs a row with two listings to its name the same way wherever the row taking the other one stands", async () => {
    // 中国石油 could be 601857.SH or 00857.HK (中国石油股份), which the 中国石油股份 row takes. The A
    // share's quote shows 13.38 as its previous close; its bars reach that session and show
    // another close there, as on the sessions before: the quote alone settles only a name with
    // one listing.
    const search: Record<string, Listing[]> = { 中国石油: [["601857.SH", "中国石油"], ["00857.HK", "中国石油股份"]], 中国石油股份: [["00857.HK", "中国石油股份"]] }
    const api = withCloses(lookup(search, { "601857.SH": [13.38, 13.2], "00857.HK": [7.2, 7.25] }).api, { "601857.SH": sessions([["2026-10-26", 13.3], ["2026-10-27", 13.5]]), "00857.HK": sessions([["2026-10-26", 7.15], ["2026-10-27", 7.2]]) })
    const lines: Array<[string, number]> = [["中国石油", 13.38], ["中国石油股份", 7.2]]
    for (const order of [[0, 1], [1, 0]]) {
      const { rows } = await fillComponentCodes(order.map((i, n) => row("517180.SH", n + 1, ...lines[i])), api)
      expect(order.map((i, n) => [i, rows[n].componentCode]), JSON.stringify(order)).toEqual(order.map((i) => [i, i === 1 ? "00857.HK" : null]))
    }
  })

  it("gives a listing two rows could each be to neither, whichever comes first", async () => {
    // Two rows under a name with one listing, each at a price its quote shows (and its bars).
    const { api } = lookup({ 腾讯控股: [["00700.HK", "腾讯控股"]] }, { "00700.HK": [386.4, 390] })
    const bars = withCloses(api, { "00700.HK": sessions([["2026-10-26", 385], ["2026-10-27", 386.4]]) })
    // Two rows without a price under one exact name, in what is a Hong Kong ETF.
    const named = lookup({ 腾讯控股: [["00700.HK", "腾讯控股"]], 小米集团: [["01810.HK", "小米集团"]] }, { "00700.HK": [386.4, 390] }).api
    for (const order of [[0, 1], [1, 0]]) {
      const rows = order.map((i, n) => row("159920.SZ", n + 1, "腾讯控股", [390, 386.4][i]))
      expect(codesOf((await fillComponentCodes(rows, api)).rows), JSON.stringify(order)).toEqual([null, null])
      expect(codesOf((await fillComponentCodes(rows, bars)).rows), JSON.stringify(order)).toEqual([null, null])
      const unpriced = [row("159920.SZ", 1, "腾讯控股", 390), ...order.map((i) => row("159920.SZ", i + 2, "小米集团", null))]
      expect(codesOf((await fillComponentCodes(unpriced, named)).rows), JSON.stringify(order)).toEqual(["00700.HK", null, null])
    }
    // One row under the name: it is taken, on the quote and on the name alone.
    expect(codesOf((await fillComponentCodes([row("159920.SZ", 1, "腾讯控股", 390)], bars)).rows)).toEqual(["00700.HK"])
    expect(codesOf((await fillComponentCodes([row("159920.SZ", 1, "腾讯控股", 390), row("159920.SZ", 2, "小米集团", null)], named)).rows)).toEqual(["00700.HK", "01810.HK"])
  })

  it("does not give a listing two priced rows both pick to a third row on its name", async () => {
    // 腾讯控股 three times in a Hong Kong ETF: two rows at prices its quote shows, one without a price.
    const { api } = lookup({ 腾讯控股: [["00700.HK", "腾讯控股"]] }, { "00700.HK": [386.4, 390] })
    const closes = [390, 386.4, null]
    for (const order of [[0, 1, 2], [2, 1, 0], [1, 2, 0]]) {
      const rows = order.map((i, n) => row("159920.SZ", n + 1, "腾讯控股", closes[i]))
      expect(codesOf((await fillComponentCodes(rows, api)).rows), JSON.stringify(order)).toEqual([null, null, null])
    }
    // One priced row has nothing to fight over: it takes the listing, and none is left for the name.
    expect(codesOf((await fillComponentCodes([row("159920.SZ", 1, "腾讯控股", 390), row("159920.SZ", 2, "腾讯控股", null)], api)).rows)).toEqual(["00700.HK", null])
  })

  it("gives a listing the evidence leaves two rows with two listings to their name to neither", async () => {
    // The 招商银行 rows sit at the A share's previous close and latest price, the two sessions its
    // quote shows, where the H share's bars show other closes: the A share is the one answer for each.
    const { api } = lookup({ 招商银行: [["600036.SH", "招商银行"], ["03968.HK", "招商银行"]] }, { "600036.SH": [42.5, 42.3], "03968.HK": [52.6, 52.4] })
    const bars = withCloses(api, { "600036.SH": sessions([["2026-10-26", 42.2], ["2026-10-27", 42.5]]), "03968.HK": sessions([["2026-10-26", 52.1], ["2026-10-27", 52.6]]) })
    for (const closes of [[42.3, 42.5], [42.5, 42.3]]) {
      const rows = closes.map((close, n) => row("510300.SH", n + 1, "招商银行", close))
      expect(codesOf((await fillComponentCodes(rows, bars)).rows), JSON.stringify(closes)).toEqual([null, null])
    }
    expect(codesOf((await fillComponentCodes([row("510300.SH", 1, "招商银行", 42.3)], bars)).rows)).toEqual(["600036.SH"])
  })

  it("never fills a listing that only starts with the row's name on the name alone", async () => {
    // 比亚迪电 (a name the exchange cut short) finds 比亚迪电子 only as a longer name, and no price of it.
    const { api } = lookup({ 腾讯控股: [["00700.HK", "腾讯控股"]], 比亚迪电: [["00285.HK", "比亚迪电子"]] }, { "00700.HK": [386.4, 390] })
    const rows = [row("159920.SZ", 1, "腾讯控股", 390), row("159920.SZ", 2, "比亚迪电", 30.2)]
    expect(codesOf((await fillComponentCodes(rows, api)).rows)).toEqual(["00700.HK", null])
    expect(codesOf((await fillComponentCodes(rows, withCloses(api, {}))).rows)).toEqual(["00700.HK", null])
    // Under its full name the same listing stands, in what is a Hong Kong ETF.
    const exact = lookup({ 腾讯控股: [["00700.HK", "腾讯控股"]], 比亚迪电子: [["00285.HK", "比亚迪电子"]] }, { "00700.HK": [386.4, 390] }).api
    expect(codesOf((await fillComponentCodes([rows[0], row("159920.SZ", 2, "比亚迪电子", 30.2)], exact)).rows)).toEqual(["00700.HK", "00285.HK"])
  })

  it("does not let a name stand in an ETF where another name's lookup failed", async () => {
    // 上海银行 is ex-dividend (previous close adjusted, the list keeps 9.55): only its name tells
    // it. 腾讯控股's lookup failed; found, it would have shown the ETF holds Hong Kong stocks too.
    const search: Record<string, Listing[]> = { 贵州茅台: [["600519.SH", "贵州茅台"]], 上海银行: [["601229.SH", "上海银行"]], 腾讯控股: [] }
    const prices = { "600519.SH": [1335, 1349.98], "601229.SH": [9.25, 9.45] }
    const rows = [row("510300.SH", 1, "贵州茅台", 1349.98), row("510300.SH", 2, "腾讯控股", 386.4), row("510300.SH", 3, "上海银行", 9.55)]
    expect(codesOf((await fillComponentCodes(rows, withCloses(lookup(search, prices, { search: "腾讯控股" }).api, {}))).rows)).toEqual(["600519.SH", null, null])
    // A name that merely finds nothing hides nothing.
    expect(codesOf((await fillComponentCodes(rows, withCloses(lookup(search, prices).api, {}))).rows)).toEqual(["600519.SH", null, "601229.SH"])
  })

  // 丙丙 has an exact listing in Shenzhen and a longer name (another company) in Shanghai.
  const TWO_IN_ONE_MARKET: Record<string, Listing[]> = { 甲甲: [["600001.SH", "甲甲"]], 乙乙: [["600002.SH", "乙乙"]], 丙丙: [["000003.SZ", "丙丙"], ["600003.SH", "丙丙丁"]] }
  const threeRows = [row("510300.SH", 1, "甲甲", 10), row("510300.SH", 2, "乙乙", 20), row("510300.SH", 3, "丙丙", 30)]

  it("takes neither of two listings in one market that both sit at the row's close, whatever the ETF's exchange", async () => {
    const fill = async (longer: number) => {
      const prices = { "600001.SH": [10, 10.1], "600002.SH": [20, 20.2], "000003.SZ": [30, 30.3], "600003.SH": [longer, longer + 0.2] }
      return codesOf((await fillComponentCodes(threeRows, barred(lookup(TWO_IN_ONE_MARKET, prices).api, prices))).rows)
    }
    expect(await fill(30.01)).toEqual(["600001.SH", "600002.SH", null])
    expect(await fill(31.5)).toEqual(["600001.SH", "600002.SH", "000003.SZ"])
    // Both at the close with the row's change that day as well: still two securities.
    const changing = (longer: number) => showing(lookup(TWO_IN_ONE_MARKET, {}).api, [["600001.SH", [["2026-10-27", 10]]], ["600002.SH", [["2026-10-27", 20]]], ["000003.SZ", [["2026-10-27", 30, 1.5]]], ["600003.SH", [["2026-10-27", 30.01, longer]]]])
    const changed = [...threeRows.slice(0, 2), { ...threeRows[2], pctChange: 1.5 }]
    expect(codesOf((await fillComponentCodes(changed, changing(1.5))).rows)).toEqual(["600001.SH", "600002.SH", null])
    // On another change that day, the longer name is not the row's.
    expect(codesOf((await fillComponentCodes(changed, changing(-0.7))).rows)).toEqual(["600001.SH", "600002.SH", "000003.SZ"])
  })

  it("does not count a listing's last close as the list day's when its bars end before that day", async () => {
    // The list day is 10-27, and the exact listing closed elsewhere. The longer name's bars stop
    // at 10-23 on the row's price, and its quote has moved since: its 10-27 close is not shown.
    const fill = async (longer: Bar[], quote: number[]) => {
      const prices = { "600001.SH": [10, 10.1], "600002.SH": [20, 20.2], "000003.SZ": [28, 28.3], "600003.SH": quote }
      const api = barred(lookup(TWO_IN_ONE_MARKET, prices).api, { "600001.SH": [10], "600002.SH": [20], "000003.SZ": [28] })
      return codesOf((await fillComponentCodes(threeRows, { ...api, async closes(codes, start, end) { return new Map([...await api.closes!(codes, start, end), ["600003.SH", longer] as [string, Bar[]]]) } })).rows)
    }
    expect(await fill(sessions([["2026-10-22", 29.5], ["2026-10-23", 30.01]]), [31.5, 31.6])).toEqual(["600001.SH", "600002.SH", null])
    // Its bars reaching the list day, at that close: the one listing left.
    expect(await fill(sessions([["2026-10-23", 29.5], ["2026-10-26", 30.4], ["2026-10-27", 30.01]]), [30.01, 30.3])).toEqual(["600001.SH", "600002.SH", "600003.SH"])
  })

  it("lets a name stand for the one priced listing still open, and for none of several", async () => {
    // No daily closes came, and no quote is at the row's price: nothing is ruled out.
    const prices = { "600001.SH": [10, 10.1], "600002.SH": [20, 20.2], "000003.SZ": [28, 28.3], "600003.SH": [31.5, 31.6] }
    expect(codesOf((await fillComponentCodes(threeRows, withCloses(lookup(TWO_IN_ONE_MARKET, prices).api, {}))).rows)).toEqual(["600001.SH", "600002.SH", null])
    const alone = { ...TWO_IN_ONE_MARKET, 丙丙: [["000003.SZ", "丙丙"]] as Listing[] }
    expect(codesOf((await fillComponentCodes(threeRows, withCloses(lookup(alone, prices).api, {}))).rows)).toEqual(["600001.SH", "600002.SH", "000003.SZ"])
    // The longer name alone never stands on the name.
    const longerOnly = { ...TWO_IN_ONE_MARKET, 丙丙: [["600003.SH", "丙丙丁"]] as Listing[] }
    expect(codesOf((await fillComponentCodes(threeRows, withCloses(lookup(longerOnly, prices).api, {}))).rows)).toEqual(["600001.SH", "600002.SH", null])
  })

  it("asks for daily closes far enough back that a long holiday still leaves the sessions it takes to rule a listing out", async () => {
    let window: string[] = []
    const { api } = lookup({ 中国移动: AH_MOBILE }, MOBILE_PRICES)
    await fillComponentCodes([row("517180.SH", 1, "中国移动", 101.3)], { ...api, async closes(_codes, start, end) { window = [start, end]; return new Map() } })
    let weekdays = 0
    for (let day = window[0]; day <= window[1]; day = nextWeekday(day)) weekdays++
    // A week of closed sessions and a weekday the bars have not reached yet, and four sessions are left.
    expect(weekdays - 6 - 1).toBeGreaterThanOrEqual(4)
  })

  describe("a listing whose bars end before its market's list day", () => {
    // 517180.SH's A rows carry 10-20 closes, its H rows 10-22's. 恒瑞医药 is the H row (47.44 on 10-22).
    const search: Record<string, Array<[string, string]>> = {
      中国石油: [["601857.SH", "中国石油"]], 中国神华: [["601088.SH", "中国神华"]], 贵州茅台: [["600519.SH", "贵州茅台"]],
      华润啤酒: [["00291.HK", "华润啤酒"]], 腾讯控股: [["00700.HK", "腾讯控股"]], 恒瑞医药: [["600276.SH", "恒瑞医药"], ["01276.HK", "恒瑞医药"]],
    }
    const bars: Record<string, Bar[]> = {
      "601857.SH": [["2026-10-20", 13.38], ["2026-10-22", 13.0]], "601088.SH": [["2026-10-20", 38.6], ["2026-10-22", 38.0]], "600519.SH": [["2026-10-20", 1400], ["2026-10-22", 1420]],
      "00291.HK": [["2026-10-20", 19.0], ["2026-10-22", 19.48]], "00700.HK": [["2026-10-20", 380], ["2026-10-22", 385.2]],
      "600276.SH": [["2026-10-19", 46.9]], "01276.HK": [["2026-10-20", 46.1], ["2026-10-22", 47.44]],
    }
    const rows = [["中国石油", 13.38], ["中国神华", 38.6], ["贵州茅台", 1400], ["华润啤酒", 19.48], ["腾讯控股", 385.2], ["恒瑞医药", 47.44]].map(([name, close], i) => row("517180.SH", i + 1, name as string, close as number))
    // The other listings as a lookup brings them; the A share's bars as given.
    const fill = async (aQuote: number[], aBars: Bar[] = bars["600276.SH"], quoteDate = QUOTE_DATE) => {
      const { "600276.SH": _, ...rest } = bars
      const api = showing(lookup(search, { "600276.SH": aQuote, "01276.HK": [47.6, 47.8] }, {}, quoteDate).api, Object.entries(rest))
      return fillComponentCodes(rows, { ...api, async closes(codes, start, end) { return new Map([...await api.closes!(codes, start, end), ...(codes.includes("600276.SH") ? [["600276.SH", aBars] as [string, Bar[]]] : [])]) } })
    }

    it("is not ruled out by its last close when the quote shows it traded since", async () => {
      // The A share's bars stop at 10-19 (not suspended: its previous close is 47.44, its latest 48.3);
      // its 10-20 close is not known.
      const { rows: out, unresolved } = await fill([47.44, 48.3])
      expect(out[5].componentCode).toBeNull()
      expect(unresolved.map((u) => u.componentName)).toEqual(["恒瑞医药"])
    })

    it("is checked on the list day once its bars reach it; a quote still at its last close does not stand in for them", async () => {
      expect((await fill([47.6, 48.3], sessions([["2026-10-19", 46.9], ["2026-10-20", 46.95], ["2026-10-22", 47.6]]), "2026-10-23")).rows[5].componentCode).toBe("01276.HK")
      // Previous close at the last bar's, latest at it too or none: a suspended listing would
      // have a bar on the list day all the same, so this shows nothing of that day.
      expect((await fill([46.9, 46.9])).rows[5].componentCode).toBeNull()
      expect((await fill([46.9, 0])).rows[5].componentCode).toBeNull()
      expect((await fill([46.9, 47.5])).rows[5].componentCode).toBeNull()
      // A quote of a day before the list day says nothing of the list day.
      expect((await fill([46.9, 46.9], bars["600276.SH"], "2026-10-19")).rows[5].componentCode).toBeNull()
    })
  })
})

// The three whole-market lists (全部A股 / 全部港股 / 全部美股), a few rows each.
const SECTORS: Record<string, Array<{ gtsCode: string; gtsName: string }>> = {
  "1000000002": [{ gtsCode: "600941.SH", gtsName: "中国移动" }, { gtsCode: "002594.SZ", gtsName: "比亚迪" }, { gtsCode: "000858.SZ", gtsName: "五粮液" }],
  "1000002615": [{ gtsCode: "00941.HK", gtsName: "中国移动" }, { gtsCode: "01211.HK", gtsName: "比亚迪股份" }, { gtsCode: "00285.HK", gtsName: "比亚迪电子" }, { gtsCode: "01810.HK", gtsName: "小米集团-W" }, { gtsCode: "81810.HK", gtsName: "小米集团-WR" }],
  "1000002618": [{ gtsCode: "TRI.O", gtsName: "Thomson Reuters" }, { gtsCode: "BESS.A", gtsName: "Bimergen Energy" }],
}

describe("securities table", () => {
  const fetchedFrom = (sectors: Record<string, unknown>) => {
    const asked: string[] = []
    return { asked, fetch: async (id: string) => { asked.push(id); return sectors[id] instanceof Error ? Promise.reject(sectors[id]) : { total: 0, list: sectors[id] } } }
  }

  it("is the three markets' listings together", async () => {
    const fetched = fetchedFrom(SECTORS)
    expect(await loadSecurityTable(fetched.fetch)).toHaveLength(10)
    expect(fetched.asked.sort()).toEqual(["1000000002", "1000002615", "1000002618"])
  })

  it("is not used when a market fails or lists nothing, so the lookup searches instead", async () => {
    for (const broken of [new Error("120001"), []]) {
      expect(await loadSecurityTable(fetchedFrom({ ...SECTORS, "1000002615": broken }).fetch)).toBeUndefined()
    }
  })

  it("finds a name exactly (share-class suffixes and spaces aside), by ticker or by code, with the names that start with it", () => {
    const search = tableSearch(Object.values(SECTORS).flat().map((r) => [r.gtsCode, r.gtsName] as [string, string]))
    const codes = (keyword: string) => search(keyword)?.map((r) => (r as { gtsCode: string }).gtsCode)
    expect(codes("中国移动")).toEqual(["600941.SH", "00941.HK"])
    expect(codes("比亚迪")).toEqual(["002594.SZ", "01211.HK", "00285.HK"])
    expect(codes("小米集团")).toEqual(["01810.HK", "81810.HK"])
    expect(codes("五 粮 液")).toEqual(["000858.SZ"])
    expect(codes("TRI")).toEqual(["TRI.O"])
    expect(codes("TRI.O")).toEqual(["TRI.O"])
    // Nothing carries these exactly: a truncated name, a bond, a cash line — left to the search.
    for (const keyword of ["比亚迪电", "26国债15", "申赎现金"]) expect(search(keyword)).toBeUndefined()
  })

  it("reads the daily closes of a day-kline answer, oldest first, per code, with each day's change from the two closes", async () => {
    const calls: Array<[string, unknown]> = []
    const client = {
      async call(endpoint: string, body: unknown) {
        calls.push([endpoint, body])
        return { total: 3, fieldList: ["securityCode", "tradeDate", "close", "preClose"], list: [["00941.HK", "2026-10-27", 78.1, 77.3], ["00941.HK", "2026-10-26", 77.3, null], ["600941.SH", "2026-10-26", 101.3, 100]] }
      },
    }
    const closes = await clientLookup(client).closes!(["00941.HK", "600941.SH"], "2026-10-18", "2026-10-28")
    expect([...closes].map(([code, bars]) => [code, bars.map(([d, c, change]) => [d, c, change === undefined ? undefined : Number(change.toFixed(4))])])).toEqual([
      ["00941.HK", [["2026-10-26", 77.3, undefined], ["2026-10-27", 78.1, 1.0349]]],
      ["600941.SH", [["2026-10-26", 101.3, 1.3]]],
    ])
    expect(calls).toEqual([["quote.day-kline", { securityList: ["00941.HK", "600941.SH"], startDate: "2026-10-18", endDate: "2026-10-28", fieldList: ["securityCode", "tradeDate", "close", "preClose"], limit: 10_000 }]])
  })

  it("reads a realtime answer's previous close, latest price and trading day per code", async () => {
    const client = {
      async call() {
        return { list: [
          { securityCode: "600036.SH", tradeDate: "2026-11-13", preClose: 42.63, latestPrice: 42.93 },
          { securityCode: "03968.HK", tradeDate: "20261113", preClose: 54, latestPrice: null },
          { securityCode: "00941.HK", tradeDate: "2026-11-13", preClose: null, latestPrice: null },
        ] }
      },
    }
    expect([...await clientLookup(client).quotes(["600036.SH", "03968.HK", "00941.HK"])]).toEqual([
      ["600036.SH", { previous: 42.63, latest: 42.93, date: "2026-11-13" }],
      // A date in another form is not compared with the daily bars' days.
      ["03968.HK", { previous: 54, latest: undefined, date: undefined }],
    ])
  })

  it("is fetched once per lookup, and only the names it does not carry are searched", async () => {
    const calls: Array<[string, unknown]> = []
    const client = {
      async call(endpoint: string, body: unknown) {
        calls.push([endpoint, body])
        if (endpoint === "reference.sector-constituents") return { list: SECTORS[(body as { sectorId: string }).sectorId] }
        if (endpoint === "reference.securities-search") return { list: [{ gtsCode: "00285.HK", gtsName: "比亚迪电子", category: "stock" }] }
        throw new Error(`unexpected ${endpoint}`)
      },
    }
    const lookup = clientLookup(client)
    const found = await Promise.all(["中国移动", "小米集团", "比亚迪电"].map((k) => lookup.search(k)))
    expect(found.map((rows) => rows.length)).toEqual([2, 2, 1])
    expect(calls.filter(([e]) => e === "reference.sector-constituents")).toHaveLength(3)
    expect(calls.filter(([e]) => e === "reference.securities-search")).toEqual([["reference.securities-search", { keyword: "比亚迪电", top: 10 }]])
  })
})


describe("addComponentCodes", () => {
  it("fills the codes and says in _note that they are matched by name, naming the rows left null", async () => {
    const { api } = lookup({ 贵州茅台: [["600519.SH", "贵州茅台"]], 申赎现金: [] }, { "600519.SH": [1349.98, 1355.9] })
    const out = await addComponentCodes({ list: [row("510300.SH", 1, "贵州茅台", 1355.9), row("510300.SH", 2, "申赎现金", null)] }, api) as { list: Array<Record<string, unknown>>; _note: string }
    expect(codesOf(out.list)).toEqual(["600519.SH", null])
    expect(out._note).toContain("2 行中补上 1 行")
    expect(out._note).toContain("510300.SH 申赎现金")
  })

  it("leaves an answer with nothing to fill as it is", async () => {
    const { api, searched } = lookup({}, {})
    const carried = { list: [{ fundCode: "510300.SH", serialNumber: 1, componentCode: "600519.SH", componentName: "贵州茅台" }] }
    expect(await addComponentCodes(carried, api)).toBe(carried)
    expect(await addComponentCodes({ list: [] }, api)).toEqual({ list: [] })
    expect(searched).toEqual([])
  })
})

describe("fillComponentCodes, cross-market rows", () => {
  it("does not take an ETF for single-market from part of its rows: an A/H name nothing placed keeps every name-only guess out, whatever the row order", async () => {
    const failing: CodeLookup = { ...lookup({ 贵州茅台: [["600519.SH", "贵州茅台"]], 中国移动: AH_MOBILE }, {}).api, quotes: async () => { throw Object.assign(new Error("服务故障"), { code: "999999" }) } }
    for (const order of [[77.3, 101.3], [101.3, 77.3], [77.3]]) {
      const rows = [row("517180.SH", 1, "贵州茅台", 1349.98), ...order.map((close, i) => row("517180.SH", i + 2, "中国移动", close))]
      const { rows: out } = await fillComponentCodes(rows, failing)
      expect(codesOf(out), JSON.stringify(order)).toEqual(rows.map(() => null))
    }
  })

  it("counts a longer name in another market as a listing the row could be when deciding the ETF's market, without filling a code from it", async () => {
    // The H row of 中国石油 is 中国石油股份 (00857.HK) to the search: a prefix match only.
    const down = { quotes: async () => { throw Object.assign(new Error("服务故障"), { code: "999999" }) }, closes: async () => { throw Object.assign(new Error("服务故障"), { code: "999999" }) } }
    const api: CodeLookup = { ...lookup({ 中国石油: [["601857.SH", "中国石油"], ["00857.HK", "中国石油股份"]] }, {}).api, ...down }
    for (const order of [[7.2, 13.38], [13.38, 7.2]]) {
      const { rows } = await fillComponentCodes(order.map((close, i) => row("517180.SH", i + 1, "中国石油", close)), api)
      expect(codesOf(rows), JSON.stringify(order)).toEqual([null, null])
    }
  })

  // 517180.SH 的清单：A 股是 10-20 的收盘、H 股是 10-22 的；实时行情都已往后走。恒瑞医药是 H 股那一行（47.44），
  // A 股的实时价碰巧也是 47.44。
  const LAGGING_QUOTES: Record<string, number[]> = {
    "601857.SH": [13.0, 13.1], "601088.SH": [38.0, 38.1], "00291.HK": [19.6, 19.7], "00700.HK": [390, 392],
    "600276.SH": [47.1, 47.44], "01276.HK": [48.3, 48.5],
  }
  const LAGGING_CLOSES = new Map<string, Array<[string, number]>>([
    ["601857.SH", [["2026-10-20", 13.38], ["2026-10-22", 13.0]]], ["601088.SH", [["2026-10-20", 38.6], ["2026-10-22", 38.0]]],
    ["00291.HK", [["2026-10-20", 19.0], ["2026-10-22", 19.48]]], ["00700.HK", [["2026-10-20", 380], ["2026-10-22", 385.2]]],
    ["600276.SH", [["2026-10-20", 46.9], ["2026-10-22", 47.6]]], ["01276.HK", [["2026-10-20", 46.1], ["2026-10-22", 47.44]]],
  ])
  const LAGGING_SEARCH: Record<string, Listing[]> = {
    中国石油: [["601857.SH", "中国石油"]], 中国神华: [["601088.SH", "中国神华"]], 华润啤酒: [["00291.HK", "华润啤酒"]], 腾讯控股: [["00700.HK", "腾讯控股"]],
    恒瑞医药: [["600276.SH", "恒瑞医药"], ["01276.HK", "恒瑞医药"]],
  }
  const laggingRows = () => [row("517180.SH", 1, "中国石油", 13.38), row("517180.SH", 2, "中国神华", 38.6), row("517180.SH", 3, "华润啤酒", 19.48), row("517180.SH", 4, "腾讯控股", 385.2), row("517180.SH", 5, "恒瑞医药", 47.44)]

  it("does not let another market's quote that happens to equal a lagging row's close settle it, nor rule that listing out: the row stays null", async () => {
    const asked: string[][] = []
    const api: CodeLookup = { ...lookup(LAGGING_SEARCH, LAGGING_QUOTES).api, async closes(codes) { asked.push(codes); return new Map(codes.filter((c) => LAGGING_CLOSES.has(c)).map((c) => [c, LAGGING_CLOSES.get(c)!])) } }
    const { rows } = await fillComponentCodes(laggingRows(), api)
    expect(codesOf(rows)).toEqual(["601857.SH", "601088.SH", "00291.HK", "00700.HK", null])
    expect(asked).toHaveLength(1)
  })

  it("leaves such a row null when the daily closes cannot be had", async () => {
    const api: CodeLookup = { ...lookup(LAGGING_SEARCH, LAGGING_QUOTES).api, closes: async () => { throw Object.assign(new Error("服务故障"), { code: "999999" }) } }
    const { rows } = await fillComponentCodes(laggingRows(), api)
    expect(codesOf(rows)[4]).toBeNull()
  })
})
