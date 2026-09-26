import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"

import { clearCalendarTypeCacheForTests } from "../../src/core/calendarType.js"
import { startHarness, type Harness } from "../helpers/harness.js"
import { edeInner, type RecordedRequest, type Responder, type UpstreamReply } from "../helpers/mockUpstream.js"
import { paged } from "./upstream.js"

/** 响应 fixture：代表性的服务端响应形状 → 工具最终交给模型的结果，逐字钉住。
 *
 *  覆盖三类：① 返回形状（列式、EDE 三种矩阵、`{total:0, list:null}`）；② 每一种 `_partial`
 *  原因各一条（重构 partial / present / shape 时它们最容易悄悄变形）；③ 0.3.0 会被合并的
 *  旧工具的返回字段（legacy 档必须原样保留它们）。
 *
 *  服务端载荷在 tests/fixtures/responses/*.json，期望输出在 tests/fixtures/responses/__outputs__/。
 *  输出里的临时目录路径替换成 `<TMP>`，其余逐字比较。 */

const here = path.dirname(fileURLToPath(import.meta.url))
const fixture = (name: string): unknown =>
  JSON.parse(fs.readFileSync(path.join(here, "../fixtures/responses", `${name}.json`), "utf8"))

const errorEnvelope = (code: string, msg: string): UpstreamReply => ({ json: { code, msg, data: null } })
const on = (endpoint: string, reply: (req: RecordedRequest) => UpstreamReply | undefined): Responder =>
  (req) => (req.endpoint === endpoint ? reply(req) : undefined)
const bodyOf = (req: RecordedRequest) => (req.body ?? {}) as Record<string, unknown>

/** 全市场分片：每片回一行，按片的起始日区分；`override` 让指定日期的那一片换一种应答。 */
function shardRows(endpoint: string, override: Record<string, UpstreamReply> = {}, fields = ["securityCode", "tradeDate", "close"]): Responder {
  return on(endpoint, (req) => {
    const day = String(bodyOf(req).startDate)
    return override[day] ?? { data: { total: 1, fieldList: fields, list: [["600519.SH", day, 1]] } }
  })
}

/** 逐只拆分：每只回一行；`override` 按证券代码换应答。 */
function perSecurityRows(endpoint: string, override: Record<string, UpstreamReply> = {}): Responder {
  return on(endpoint, (req) => {
    const code = (bodyOf(req).securityList as string[])[0]
    return override[code] ?? { data: { total: 1, fieldList: ["securityCode", "tradeDate", "close"], list: [[code, "2026-09-01", 1]] } }
  })
}

interface Scenario {
  name: string
  tool: string
  args: Record<string, unknown>
  upstream?: Responder
  /** 基于第一次调用的输出再调一次（回读落盘文件），快照的是第二次的输出。 */
  followUp?: (first: unknown) => { tool: string; args: Record<string, unknown> }
  /** 单个场景的超时（毫秒）。只给发大量请求的重载场景用，覆盖率插桩下它们会超过默认 5 秒。 */
  timeoutMs?: number
}

const LONG_TEXT = "研报正文段落。".repeat(40)

const SCENARIOS: Scenario[] = [
  // ─── 返回形状 ───
  { name: "shape-kline-columnar", tool: "gangtise_day_kline", args: { security: "600519.SH", startDate: "2026-09-01", endDate: "2026-09-03" }, upstream: on("quote.day-kline", () => ({ data: fixture("kline-columnar") })) },
  { name: "shape-ede-cross-section", tool: "gangtise_indicator_cross_section", args: { indicatorCodeList: ["qte_close", "qte_mkt_cptl"], securityCodeList: ["600519.SH", "00700.HK"], date: "2026-09-25" }, upstream: on("indicator.cross-section", () => ({ data: edeInner(fixture("ede-cross-section")) })) },
  { name: "shape-ede-time-series", tool: "gangtise_indicator_time_series", args: { indicatorCodeList: ["qte_close"], securityCodeList: ["600519.SH", "000858.SZ"], startDate: "2026-09-01", endDate: "2026-09-02", calendarType: "TD" }, upstream: on("indicator.time-series", () => ({ data: edeInner(fixture("ede-time-series")) })) },
  { name: "shape-ede-screener", tool: "gangtise_indicator_screener", args: { indicatorList: [{ field: "F1", indicatorCode: "qte_mkt_cptl", parameters: [{ paramKey: "scale", paramValue: "8" }] }, { field: "F2", indicatorCode: "scr_exchg_sctr", noQueryDate: true }], expression: "F1 >= 500 && F2 contains '创业板'", securityCodeList: ["2000000014"], date: "2026-09-25" }, upstream: on("indicator.screener", () => ({ data: edeInner(fixture("ede-screener")) })) },
  { name: "shape-ede-empty", tool: "gangtise_indicator_cross_section", args: { indicatorCodeList: ["qte_close"], securityCodeList: ["600519.SH"], date: "2026-09-25" } },
  { name: "shape-list-null-empty", tool: "gangtise_summary_list", args: { securityList: ["600519.SH"] }, upstream: on("insight.summary.list", () => ({ data: fixture("list-null-empty") })) },

  // ─── 每种 _partial 原因 ───
  { name: "partial-failed-pages", tool: "gangtise_research_list", args: { keyword: "AI", size: 120 }, upstream: (req) => (bodyOf(req).from === 50 ? errorEnvelope("100005", "参数错误") : paged(300)(req, 0)) },
  { name: "partial-short-page", tool: "gangtise_research_list", args: { keyword: "AI", size: 120 }, upstream: (req) => (bodyOf(req).from === 50 ? { data: { total: 300, list: [{ id: "row-50" }] } } : paged(300)(req, 0)) },
  { name: "partial-total-capped", tool: "gangtise_research_list", args: { keyword: "AI" }, upstream: (req) => (bodyOf(req).from === 7 ? { data: { total: 7, list: [{ id: "row-7" }] } } : paged(7)(req, 0)) },
  { name: "partial-total-drift", tool: "gangtise_research_list", args: { keyword: "AI" }, upstream: (req) => (bodyOf(req).from === 7 ? { data: { total: 8, list: [{ id: "row-7" }] } } : paged(7)(req, 0)) },
  // 1000 页 × 50 行的上限：fetchAll 面对 6 万行会停在第 1000 页。约 1000 个本机请求，结果落盘。
  { name: "partial-page-cap", tool: "gangtise_research_list", args: { keyword: "AI", fetchAll: true }, upstream: paged(60_000), timeoutMs: 30_000 },
  { name: "partial-unexpected-page-shape", tool: "gangtise_research_list", args: { keyword: "AI" }, upstream: on("insight.research.list", () => ({ data: [{ id: "row-0" }] })) },
  { name: "partial-limit-truncated", tool: "gangtise_day_kline", args: { security: "600519.SH", startDate: "2026-09-01", endDate: "2026-09-03", limit: 3 }, upstream: on("quote.day-kline", () => ({ data: fixture("kline-columnar") })) },
  { name: "partial-failed-shards", tool: "gangtise_day_kline", args: { security: "aShares", startDate: "2026-09-07", endDate: "2026-09-09" }, upstream: shardRows("quote.day-kline", { "2026-09-08": errorEnvelope("100005", "参数错误") }) },
  { name: "partial-malformed-shards", tool: "gangtise_day_kline", args: { security: "aShares", startDate: "2026-09-07", endDate: "2026-09-09" }, upstream: shardRows("quote.day-kline", { "2026-09-08": { data: { total: 5 } } }) },
  { name: "partial-truncated-shards", tool: "gangtise_day_kline", args: { security: "aShares", startDate: "2026-09-07", endDate: "2026-09-08", limit: 1 }, upstream: shardRows("quote.day-kline") },
  { name: "partial-dropped-columns", tool: "gangtise_day_kline", args: { security: "aShares", startDate: "2026-09-07", endDate: "2026-09-08" }, upstream: shardRows("quote.day-kline", { "2026-09-08": { data: { total: 1, fieldList: ["securityCode", "tradeDate", "close", "extraCol"], list: [["600519.SH", "2026-09-08", 2, "x"]] } } }) },
  { name: "partial-failed-securities", tool: "gangtise_day_kline", args: { security: ["600519.SH", "000858.SZ", "00700.HK", "AAPL.O"], startDate: "2020-01-01", endDate: "2026-06-30" }, upstream: perSecurityRows("quote.day-kline", { "00700.HK": errorEnvelope("120001", "证券代码无效") }) },
  { name: "partial-malformed-securities", tool: "gangtise_day_kline", args: { security: ["600519.SH", "000858.SZ", "00700.HK", "AAPL.O"], startDate: "2020-01-01", endDate: "2026-06-30" }, upstream: perSecurityRows("quote.day-kline", { "AAPL.O": { data: { total: 1 } } }) },
  { name: "partial-truncated-securities", tool: "gangtise_minute_kline", args: { security: ["600519.SH", "512800.SH"], startTime: "2026-09-01 09:30:00", endTime: "2026-09-01 15:00:00", limit: 1 }, upstream: on("quote.minute-kline", (req) => ({ data: { total: 1, fieldList: ["securityCode", "tradeTime", "close"], list: [[bodyOf(req).securityCode, "2026-09-01 09:31:00", 1]] } })) },
  { name: "partial-missing-fields", tool: "gangtise_realtime", args: { security: "600519.SH", fieldList: ["securityCode", "latestPrice", "turnoverRate"] }, upstream: on("quote.realtime", () => ({ data: { total: 1, fieldList: ["securityCode", "latestPrice"], list: [["600519.SH", 1510.2]] } })) },
  { name: "partial-failed-items", tool: "gangtise_stock_pool_add_stock", args: { poolId: "pool-1", securityCodeList: ["600519.SH", "600519.XX"] }, upstream: on("vault.stock-pool.add-stock", () => ({ data: fixture("stock-pool-item-failures") })) },
  { name: "partial-security-only-row-cap", tool: "gangtise_performance_calendar_list", args: { securityList: ["600519.SH"], fetchAll: true }, upstream: paged(1500) },
  { name: "partial-omitted-securities", tool: "gangtise_indicator_cross_section", args: { indicatorCodeList: ["qte_close", "qte_mkt_cptl"], securityCodeList: ["600519.SH", "00700.HK", "AAPL.O"], date: "2026-09-25" }, upstream: on("indicator.cross-section", () => ({ data: edeInner(fixture("ede-cross-section")) })) },
  { name: "partial-omitted-indicators", tool: "gangtise_indicator_cross_section", args: { indicatorCodeList: ["qte_close", "qte_mkt_cptl", "qte_pe_ttm"], securityCodeList: ["600519.SH", "00700.HK"], date: "2026-09-25" }, upstream: on("indicator.cross-section", () => ({ data: edeInner(fixture("ede-cross-section")) })) },

  // ─── 呈现：落盘指针、回读、下载 ───
  { name: "present-spill-list", tool: "gangtise_research_list", args: { keyword: "AI", size: 200 }, upstream: on("insight.research.list", (req) => {
    const { from = 0, size = 20 } = bodyOf(req) as { from?: number; size?: number }
    const n = Math.max(0, Math.min(size, 200 - from))
    return { data: { total: 200, list: Array.from({ length: n }, (_, i) => ({ id: `row-${from + i}`, title: `标题 ${from + i}`, brief: LONG_TEXT })) } }
  }) },
  { name: "present-read-response-page", tool: "gangtise_research_list", args: { keyword: "AI", size: 200 }, upstream: on("insight.research.list", (req) => {
    const { from = 0, size = 20 } = bodyOf(req) as { from?: number; size?: number }
    const n = Math.max(0, Math.min(size, 200 - from))
    return { data: { total: 200, list: Array.from({ length: n }, (_, i) => ({ id: `row-${from + i}`, title: `标题 ${from + i}`, brief: LONG_TEXT })) } }
  }), followUp: (first) => ({ tool: "gangtise_read_response", args: { saved_to: (first as { _saved_to: string })._saved_to, offset: 20, limit: 3, fields: ["id", "title"] } }) },
  { name: "present-spill-text", tool: "gangtise_one_pager", args: { securityCode: "600519.SH" }, upstream: on("ai.one-pager", () => ({ data: { content: `# 一页通\n\n${LONG_TEXT.repeat(120)}` } })) },
  { name: "present-download-text", tool: "gangtise_research_download", args: { reportId: "rep-1", fileType: 2 }, upstream: on("insight.research.download", () => ({ text: "# 研报\n\n正文", headers: { "content-type": "text/markdown; charset=utf-8" } })) },
  { name: "present-download-binary", tool: "gangtise_report_image_download", args: { chunkId: "chunk-1" }, upstream: on("insight.report-image.download", () => ({ bytes: new Uint8Array([0xff, 0xd8, 0xff, 0xe0]), headers: { "content-type": "image/jpeg", "content-disposition": 'attachment; filename="chart.jpg"' } })) },
  { name: "present-download-url", tool: "gangtise_drive_download", args: { fileId: "file-1" }, upstream: on("vault.drive.download", () => ({ data: { url: "https://files.example.com/signed/abc" } })) },
  { name: "present-async-timeout", tool: "gangtise_earnings_review", args: { securityCode: "600519.SH", period: "2025q3", waitSeconds: 0 } },
  { name: "present-valuation-skipnull", tool: "gangtise_valuation_analysis", args: { securityCode: "600519.SH", indicator: "peTtm", startDate: "2026-09-01", endDate: "2026-09-03", skipNull: true }, upstream: on("fundamental.valuation-analysis", () => ({ data: { total: 3, fieldList: ["tradeDate", "value", "percentileRank"], list: [["2026-09-01", 25.1, 0.31], ["2026-09-02", null, null], ["2026-09-03", 24.8, 0.29]] } })) },

  { name: "partial-valuation-limit-truncated", tool: "gangtise_valuation_analysis", args: { securityCode: "600519.SH", indicator: "peTtm", startDate: "2026-08-01", endDate: "2026-09-03", limit: 3 }, upstream: on("fundamental.valuation-analysis", () => ({ data: { total: 3, fieldList: ["tradeDate", "value", "percentileRank"], list: [["2026-09-01", 25.1, 0.31], ["2026-09-02", 25.0, 0.3], ["2026-09-03", 24.8, 0.29]] } })) },
  { name: "present-valuation-exact-range", tool: "gangtise_valuation_analysis", args: { securityCode: "600519.SH", indicator: "peTtm", startDate: "2026-09-01", endDate: "2026-09-03", limit: 3 }, upstream: on("fundamental.valuation-analysis", () => ({ data: { total: 3, fieldList: ["tradeDate", "value", "percentileRank"], list: [["2026-09-01", 25.1, 0.31], ["2026-09-02", 25.0, 0.3], ["2026-09-03", 24.8, 0.29]] } })) },
  { name: "present-valuation-late-start", tool: "gangtise_valuation_analysis", args: { securityCode: "600519.SH", indicator: "peTtm", startDate: "2016-01-01", endDate: "2026-09-03" }, upstream: on("fundamental.valuation-analysis", () => ({ data: { total: 2, fieldList: ["tradeDate", "value", "percentileRank"], list: [["2021-04-04", 25.1, 0.31], ["2021-04-05", 25.0, 0.3]] } })) },

  // ─── 0.3.0 会被合并的旧工具：legacy 档必须原样保留的返回 ───
  { name: "legacy-income-statement-hk", tool: "gangtise_income_statement_hk", args: { securityCode: "00700.HK", period: ["h1"] }, upstream: on("fundamental.income-statement-hk", () => ({ data: fixture("income-statement-hk") })) },
  { name: "legacy-announcement-hk-list", tool: "gangtise_announcement_hk_list", args: { securityList: ["00700.HK"] }, upstream: on("insight.announcement-hk.list", (req) => ({ data: bodyOf(req).from === 0 ? fixture("announcement-hk-list") : { total: 1, list: [] } })) },
  { name: "legacy-day-kline-hk", tool: "gangtise_day_kline_hk", args: { security: "00700.HK", startDate: "2026-09-01", endDate: "2026-09-03" }, upstream: on("quote.day-kline-hk", () => ({ data: { total: 1, fieldList: ["securityCode", "tradeDate", "close"], list: [["00700.HK", "2026-09-01", 480.4]] } })) },
  { name: "legacy-announcement-hk-download", tool: "gangtise_announcement_hk_download", args: { announcementId: "annhk-1", fileType: 2 }, upstream: on("insight.announcement-hk.download", () => ({ text: "# 公告\n\n正文", headers: { "content-type": "text/markdown; charset=utf-8" } })) },
]

/** 临时目录路径因机器与进程而异，换成占位符；macOS 上 tmpdir 与其 realpath 不同，两种都换。 */
function scrubTempPaths(text: string): string {
  const roots = new Set([os.tmpdir(), fs.realpathSync(os.tmpdir())])
  let out = text
  for (const root of roots) {
    const escaped = root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    out = out.replace(new RegExp(`${escaped}/gangtise-mcp-[A-Za-z0-9_-]+`, "g"), "<TMP>")
  }
  return out
}

function render(outcome: { isError: boolean; text: string }): string {
  const text = scrubTempPaths(outcome.text)
  let result: unknown = text
  try {
    result = JSON.parse(text)
  } catch {
    // 纯文本结果（Markdown、报错文案）原样保留。
  }
  return `${JSON.stringify({ isError: outcome.isError, result }, null, 2)}\n`
}

let harness: Harness

beforeAll(async () => {
  harness = await startHarness({ asyncTimeoutMs: 5_000 })
})

afterAll(async () => {
  await harness.close()
})

beforeEach(() => {
  harness.upstream.reset()
  clearCalendarTypeCacheForTests()
})

describe("response fixtures", () => {
  it("场景名唯一", () => {
    const names = SCENARIOS.map((s) => s.name)
    expect(names.filter((name, i) => names.indexOf(name) !== i)).toEqual([])
  })

  for (const scenario of SCENARIOS) {
    it(scenario.name, async () => {
      harness.upstream.setResponder(scenario.upstream)
      let outcome = await harness.call(scenario.tool, scenario.args)
      if (scenario.followUp) {
        const next = scenario.followUp(JSON.parse(outcome.text))
        outcome = await harness.call(next.tool, next.args)
      }
      await expect(render(outcome)).toMatchFileSnapshot(`../fixtures/responses/__outputs__/${scenario.name}.json`)
    }, scenario.timeoutMs)
  }
})
