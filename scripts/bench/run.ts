/**
 * 性能基线（不进 CI）：在本机假服务端下跑固定负载，量请求数、耗时分位、峰值内存、估计计费单位。
 *
 *   npx tsx scripts/bench/run.ts                     # 全部场景，每个 5 轮，服务端每请求 20ms 延迟
 *   npx tsx scripts/bench/run.ts --runs 10 --latency 50 --only kline
 *   node --expose-gc --import tsx scripts/bench/run.ts --json /tmp/bench.json
 *
 * 用途是**同一台机器上的前后对比**（重构前后、改并发参数前后），不是绝对性能数字：假服务端与
 * 被测代码在同一个进程里，内存峰值包含生成假数据的开销；延迟是人为注入的固定值。
 * 取 GANGTISE_PAGE_CONCURRENCY 等环境变量的默认值，不在这里改。
 * 任一场景出错时退出码为 1；但数字本身没有阈值判定，退出码 0 不代表「没有退化」，结果仍要人读。
 */
import http from "node:http"
import type { AddressInfo } from "node:net"
import { once } from "node:events"
import { ENDPOINTS, type Billing } from "../../src/core/endpoints.js"
import { startHarness, type Harness } from "../../tests/helpers/harness.js"
import type { RecordedRequest, Responder, UpstreamReply } from "../../tests/helpers/mockUpstream.js"

interface Counter {
  rows: number
}

interface Scenario {
  name: string
  description: string
  /** 返回本轮要执行的调用；可在其中多次调用（回读、并发）。 */
  /** `metricMs`：只计场景里那一次关键调用的耗时（混合负载里被测的那个查询），缺省计整轮。 */
  run: (harness: Harness, counter: Counter, signal?: AbortSignal) => Promise<{ isError: boolean; bytes: number; tool: string; metricMs?: number }>
  /** 取消场景：在这么多毫秒后中止调用。 */
  cancelAfterMs?: number
  /** 覆盖全局延迟。 */
  latencyMs?: number
}

const args = process.argv.slice(2)
const option = (name: string, fallback?: string) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 ? args[i + 1] : fallback
}
const RUNS = Number(option("runs", "5"))
const LATENCY = Number(option("latency", "20"))
const ONLY = option("only")
const JSON_OUT = option("json")

const bodyOf = (req: RecordedRequest) => (req.body ?? {}) as Record<string, unknown>
const KLINE_FIELDS = ["securityCode", "tradeDate", "open", "high", "low", "close", "volume", "amount"]

function klineRows(code: string, startDate: string, count: number): unknown[][] {
  const start = Date.parse(`${startDate}T00:00:00Z`)
  return Array.from({ length: count }, (_, i) => {
    const date = new Date(start + i * 86_400_000).toISOString().slice(0, 10)
    const px = 100 + (i % 50)
    return [code, date, px, px + 1, px - 1, px + 0.5, 1_000_000 + i, 1.2e8 + i]
  })
}

/** 分页数据集：按 from/size 切；`fail` 决定哪些页返回错误。 */
function pagedDataset(total: number, counter: Counter, rowBytes = 120, fail?: (from: number, attempt: number) => UpstreamReply | undefined): Responder {
  const attempts = new Map<number, number>()
  const filler = "x".repeat(rowBytes)
  return (req) => {
    const { from = 0, size = 20 } = bodyOf(req) as { from?: number; size?: number }
    const attempt = (attempts.get(from) ?? 0) + 1
    attempts.set(from, attempt)
    const failure = fail?.(from, attempt)
    if (failure) return failure
    const n = Math.max(0, Math.min(size, total - from))
    counter.rows += n
    return { data: { total, list: Array.from({ length: n }, (_, i) => ({ id: `row-${from + i}`, title: `标题 ${from + i}`, brief: filler })) } }
  }
}

const textBytes = (s: string) => Buffer.byteLength(s, "utf8")

async function single(harness: Harness, tool: string, toolArgs: Record<string, unknown>, signal?: AbortSignal) {
  const out = await harness.call(tool, toolArgs, { signal, timeoutMs: 120_000 })
  return { isError: out.isError, bytes: textBytes(out.text), tool }
}

const SECURITIES_20 = Array.from({ length: 20 }, (_, i) => `${String(600000 + i * 7).padStart(6, "0")}.SH`)

const SCENARIOS: Scenario[] = [
  {
    name: "kline-multi-security-long",
    description: "20 只 × 2020-01-01..2026-06-30 日 K（逐只拆分，每只约 1695 行）",
    run: async (h, counter, signal) => {
      h.upstream.setResponder((req) => {
        const code = (bodyOf(req).securityList as string[])[0]
        counter.rows += 1695
        return { data: { total: 1695, fieldList: KLINE_FIELDS, list: klineRows(code, "2020-01-01", 1695) } }
      })
      return single(h, "gangtise_day_kline", { security: SECURITIES_20, startDate: "2020-01-01", endDate: "2026-06-30" }, signal)
    },
  },
  {
    name: "kline-full-market-shards",
    description: "aShares 全市场 2026-08-03..2026-08-28（20 个工作日分片，每片 5500 行）",
    run: async (h, counter, signal) => {
      h.upstream.setResponder((req) => {
        const day = String(bodyOf(req).startDate)
        counter.rows += 5500
        return { data: { total: 5500, fieldList: KLINE_FIELDS, list: Array.from({ length: 5500 }, (_, i) => klineRows(`${String(i).padStart(6, "0")}.SZ`, day, 1)[0]) } }
      })
      return single(h, "gangtise_day_kline", { security: "aShares", startDate: "2026-08-03", endDate: "2026-08-28" }, signal)
    },
  },
  {
    name: "paid-pagination-fetchall",
    description: "按条计费列表 fetchAll：opinion_list total=2000（40 页）",
    run: async (h, counter, signal) => {
      h.upstream.setResponder(pagedDataset(2000, counter, 400))
      return single(h, "gangtise_opinion_list", { keyword: "机器人", fetchAll: true }, signal)
    },
  },
  {
    name: "partial-failure-pages",
    description: "research_list size=1000（20 页），每 5 页有 1 页返回错误信封",
    run: async (h, counter, signal) => {
      h.upstream.setResponder(pagedDataset(5000, counter, 120, (from) => (from > 0 && (from / 50) % 5 === 0 ? { json: { code: "100005", msg: "参数错误", data: null } } : undefined)))
      return single(h, "gangtise_research_list", { keyword: "AI", size: 1000 }, signal)
    },
  },
  {
    name: "concurrent-calls",
    description: "8 个并发调用，每个 research_list size=500（10 页）",
    run: async (h, counter, signal) => {
      h.upstream.setResponder(pagedDataset(5000, counter))
      const outs = await Promise.all(Array.from({ length: 8 }, (_, i) => h.call("gangtise_research_list", { keyword: `AI-${i}`, size: 500 }, { signal, timeoutMs: 120_000 })))
      return { isError: outs.some((o) => o.isError), bytes: outs.reduce((n, o) => n + textBytes(o.text), 0), tool: "gangtise_research_list" }
    },
  },
  {
    name: "cancel-mid-shards",
    description: "aShares 全市场 3 个月（约 66 片），服务端 100ms/请求，250ms 后取消",
    latencyMs: 100,
    cancelAfterMs: 250,
    run: async (h, counter, signal) => {
      h.upstream.setResponder((req) => {
        counter.rows += 10
        return { data: { total: 10, fieldList: KLINE_FIELDS, list: klineRows("600519.SH", String(bodyOf(req).startDate), 10) } }
      })
      return single(h, "gangtise_day_kline", { security: "aShares", startDate: "2026-06-01", endDate: "2026-08-31" }, signal)
    },
  },
  {
    name: "spill-readback",
    description: "research_list size=2000（约 1MB 落盘）后用 read_response 回读 10 页 × 100 行",
    run: async (h, counter, signal) => {
      h.upstream.setResponder(pagedDataset(2000, counter, 400))
      const first = await h.call("gangtise_research_list", { keyword: "AI", size: 2000 }, { signal, timeoutMs: 120_000 })
      const savedTo = (JSON.parse(first.text) as { _saved_to?: string })._saved_to
      if (!savedTo) throw new Error("spill-readback：结果没有落盘，场景前提不成立")
      let bytes = textBytes(first.text)
      for (let page = 0; page < 10; page++) {
        const out = await h.call("gangtise_read_response", { saved_to: savedTo, offset: page * 100, limit: 100 }, { signal })
        bytes += textBytes(out.text)
      }
      return { isError: first.isError, bytes, tool: "gangtise_research_list" }
    },
  },
  {
    name: "fault-5xx-retry",
    description: "research_list size=200（4 页），第 2 页首次 503、重试成功",
    run: async (h, counter, signal) => {
      h.upstream.setResponder(pagedDataset(1000, counter, 120, (from, attempt) => (from === 50 && attempt === 1 ? { status: 503, json: { code: "999999", msg: "服务暂不可用", data: null } } : undefined)))
      return single(h, "gangtise_research_list", { keyword: "AI", size: 200 }, signal)
    },
  },
  {
    name: "fault-shapes",
    description: "四种错误形态各一次：500+999999（默认重试）、502 HTML、200 非 JSON、连接被重置",
    run: async (h, _counter, signal) => {
      const faults: UpstreamReply[] = [
        { status: 500, json: { code: "999999", msg: "系统错误", data: null } },
        { status: 502, text: "<html>Bad Gateway</html>", headers: { "content-type": "text/html" } },
        { status: 200, text: "{not json", headers: { "content-type": "application/json" } },
        { destroy: true },
      ]
      let bytes = 0
      let allErrored = true
      for (const fault of faults) {
        h.upstream.setResponder(() => fault)
        const out = await h.call("gangtise_securities_search", { keyword: "茅台" }, { signal, timeoutMs: 120_000 })
        bytes += textBytes(out.text)
        allErrored &&= out.isError
      }
      return { isError: !allErrored, bytes, tool: "gangtise_securities_search" }
    },
  },
  {
    name: "paged-repeated-id",
    description: "research_list fetchAll 1 万行，每行同一个 reportId、内容各不相同（去重的最坏情况）",
    run: async (h, counter, signal) => {
      h.upstream.setResponder((req) => {
        const { from = 0, size = 20 } = bodyOf(req) as { from?: number; size?: number }
        const n = Math.max(0, Math.min(size, 10_000 - from))
        counter.rows += n
        return { data: { total: 10_000, list: Array.from({ length: n }, (_, i) => ({ reportId: "same", title: `标题 ${from + i}` })) } }
      })
      return single(h, "gangtise_research_list", { keyword: "AI", fetchAll: true }, signal)
    },
  },
  {
    name: "mixed-download-query",
    description: "16 个研报下载经 302 跳到另一个源、各传 400ms，传输期间发一次证券搜索；耗时列只计这次搜索",
    run: async (h, _counter, signal) => {
      let started = 0
      let allStarted = () => {}
      const ready = new Promise<void>((resolve) => { allStarted = resolve })
      const storage = http.createServer((_req, res) => {
        if (++started === 16) allStarted()
        setTimeout(() => res.writeHead(200, { "content-type": "text/plain" }).end("download content"), 400)
      })
      storage.listen(0, "127.0.0.1")
      await once(storage, "listening")
      const location = `http://127.0.0.1:${(storage.address() as AddressInfo).port}/file`
      h.upstream.setResponder((req) => (req.endpoint === "insight.research.download" ? { status: 302, headers: { location }, json: {} } : undefined))
      const downloads = Promise.all(Array.from({ length: 16 }, (_, i) => h.call("gangtise_research_download", { reportId: `r-${i}` }, { signal, timeoutMs: 120_000 })))
      await ready
      const t0 = performance.now()
      const out = await h.call("gangtise_securities_search", { keyword: "茅台" }, { signal, timeoutMs: 120_000 })
      const metricMs = performance.now() - t0
      const done = await downloads
      storage.closeAllConnections()
      await new Promise((resolve) => storage.close(resolve))
      return { isError: out.isError || done.some((d) => d.isError), bytes: textBytes(out.text), tool: "gangtise_securities_search", metricMs }
    },
  },
]

/** 场景用到的工具 → 默认档端点（价格在端点上）。 */
const TOOL_ENDPOINT: Record<string, string> = {
  gangtise_day_kline: "quote.day-kline",
  gangtise_opinion_list: "insight.opinion.list-with-content",
  gangtise_research_list: "insight.research.list",
  gangtise_securities_search: "reference.securities-search",
}

function estimateCredits(tool: string, rows: number, requests: number): string {
  // 直接读端点表（而不是计费渲染模块），同一份脚本也能拿去跑旧版本做前后对比。
  const spec = TOOL_ENDPOINT[tool] ? (ENDPOINTS[TOOL_ENDPOINT[tool]] as { billing?: Billing } | undefined)?.billing : undefined
  if (!spec || spec.kind === "free" || spec.kind === "local") return "0"
  if (spec.kind !== "fixed") return "n/a"
  const units = spec.per === "call" || spec.per === "page" ? requests : rows
  return String(Math.round(units * spec.price * 10) / 10)
}

const pct = (sorted: number[], p: number) => sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]

interface Result {
  scenario: string
  description: string
  runs: number
  p50Ms: number
  p95Ms: number
  maxMs: number
  requests: number
  maxInFlight: number
  rowsServed: number
  outputBytes: number
  peakHeapMB: number
  peakRssMB: number
  estCredits: string
  errors: number
  requestsAfterCancel?: number
}

async function main(): Promise<void> {
  const harness = await startHarness({ asyncTimeoutMs: 5_000, timeoutMs: 30_000 })
  const results: Result[] = []
  const gc = (globalThis as { gc?: () => void }).gc
  for (const scenario of SCENARIOS) {
    if (ONLY && !scenario.name.includes(ONLY)) continue
    const times: number[] = []
    let last: Omit<Result, "scenario" | "description" | "runs" | "p50Ms" | "p95Ms" | "maxMs"> | undefined
    let errors = 0
    for (let run = 0; run < RUNS; run++) {
      harness.upstream.reset()
      harness.upstream.setDelay(scenario.latencyMs ?? LATENCY)
      gc?.()
      const baseHeap = process.memoryUsage().heapUsed
      const baseRss = process.memoryUsage().rss
      let peakHeap = baseHeap
      let peakRss = baseRss
      const sampler = setInterval(() => {
        const m = process.memoryUsage()
        peakHeap = Math.max(peakHeap, m.heapUsed)
        peakRss = Math.max(peakRss, m.rss)
      }, 2)
      const counter: Counter = { rows: 0 }
      const controller = scenario.cancelAfterMs ? new AbortController() : undefined
      let requestsAtCancel: number | undefined
      const timer = controller
        ? setTimeout(() => {
            requestsAtCancel = harness.upstream.requests.length
            controller.abort()
          }, scenario.cancelAfterMs)
        : undefined
      const t0 = performance.now()
      let outcome: { isError: boolean; bytes: number; tool: string; metricMs?: number }
      try {
        outcome = await scenario.run(harness, counter, controller?.signal)
      } catch (err) {
        outcome = { isError: true, bytes: 0, tool: "" }
        if (!controller) console.error(`[${scenario.name}] ${String(err)}`)
      }
      const elapsed = performance.now() - t0
      clearTimeout(timer)
      // 取消后再等一会儿，看是否还有请求陆续发出。
      if (controller) await new Promise((r) => setTimeout(r, 500))
      clearInterval(sampler)
      const m = process.memoryUsage()
      peakHeap = Math.max(peakHeap, m.heapUsed)
      peakRss = Math.max(peakRss, m.rss)
      times.push(outcome.metricMs ?? elapsed)
      if (outcome.isError && !controller) errors++
      const requests = harness.upstream.requests.length
      last = {
        requests,
        maxInFlight: harness.upstream.maxInFlight(),
        rowsServed: counter.rows,
        outputBytes: outcome.bytes,
        peakHeapMB: Math.round(((peakHeap - baseHeap) / 1048576) * 10) / 10,
        peakRssMB: Math.round(((peakRss - baseRss) / 1048576) * 10) / 10,
        estCredits: estimateCredits(outcome.tool, counter.rows, requests),
        errors: 0,
        ...(requestsAtCancel !== undefined ? { requestsAfterCancel: requests - requestsAtCancel } : {}),
      }
    }
    times.sort((a, b) => a - b)
    results.push({
      scenario: scenario.name,
      description: scenario.description,
      runs: RUNS,
      p50Ms: Math.round(pct(times, 50)),
      p95Ms: Math.round(pct(times, 95)),
      maxMs: Math.round(times[times.length - 1]),
      ...last!,
      errors,
    })
  }
  await harness.close()

  const cols: (keyof Result)[] = ["scenario", "p50Ms", "p95Ms", "maxMs", "requests", "maxInFlight", "rowsServed", "outputBytes", "peakHeapMB", "peakRssMB", "estCredits", "errors", "requestsAfterCancel"]
  console.log(`runs=${RUNS} latency=${LATENCY}ms node=${process.version} gc=${gc ? "on" : "off"}`)
  console.log(cols.join("\t"))
  for (const r of results) console.log(cols.map((c) => r[c] ?? "").join("\t"))
  if (JSON_OUT) {
    const fs = await import("node:fs")
    fs.writeFileSync(JSON_OUT, JSON.stringify({ runs: RUNS, latencyMs: LATENCY, node: process.version, results }, null, 2))
  }
  // 场景出错时表里那一行的数字不可信（可能只跑了一半）：退出码置 1，别让它被当成一次正常的基线。
  const failed = results.filter((r) => r.errors > 0).map((r) => r.scenario)
  if (failed.length > 0) console.error(`场景出错：${failed.join(", ")}——对应行的数字不可作为基线`)
  process.exit(failed.length > 0 ? 1 : 0)
}

await main()
