import { describe, it, expect, vi } from "vitest"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { registerInsightTools } from "../../../src/tools/insight.js"
import type { GangtiseClient } from "../../../src/core/client.js"

function makeClient() {
  const download = vi.fn(async () => ({ text: "ok", contentType: "text/plain" }))
  return { call: vi.fn(), download } as unknown as GangtiseClient
}

async function connect(client: GangtiseClient) {
  const server = new McpServer({ name: "test", version: "0.0.0" })
  registerInsightTools(server, client)
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  const mcp = new Client({ name: "test", version: "0.0.1" })
  await mcp.connect(clientTransport)
  return mcp
}

describe("insight download schemas", () => {
  it("rejects a blank reportId without downloading", async () => {
    const client = makeClient()
    const mcp = await connect(client)
    const result = await mcp.callTool({ name: "gangtise_research_download", arguments: { reportId: "" } })
    expect(result.isError).toBe(true)
    expect(client.download).not.toHaveBeenCalled()
  })

  it("rejects an out-of-set fileType without downloading", async () => {
    const client = makeClient()
    const mcp = await connect(client)
    const result = await mcp.callTool({ name: "gangtise_research_download", arguments: { reportId: "r1", fileType: 999 } })
    expect(result.isError).toBe(true)
    expect(client.download).not.toHaveBeenCalled()
  })

  it("accepts a valid reportId + fileType and downloads", async () => {
    const client = makeClient()
    const mcp = await connect(client)
    const result = await mcp.callTool({ name: "gangtise_research_download", arguments: { reportId: "r1", fileType: 2 } })
    expect(result.isError).toBeFalsy()
    expect(client.download).toHaveBeenCalledTimes(1)
  })
})

describe("gangtise_qa_list", () => {
  it("passes filters through to insight.qa.list", async () => {
    const client = makeClient()
    ;(client.call as ReturnType<typeof vi.fn>).mockResolvedValue({ list: [], total: 0 })
    const mcp = await connect(client)
    const result = await mcp.callTool({
      name: "gangtise_qa_list",
      arguments: {
        securityCode: "601012.SH",
        source: ["conference", "interactive"],
        questionCategory: ["financialData"],
        answerImportant: [1],
        startTime: "2026-06-01",
        endTime: "2026-07-01 23:59:59",
      },
    })
    expect(result.isError).toBeFalsy()
    expect(client.call).toHaveBeenCalledWith("insight.qa.list", expect.objectContaining({
      securityCode: "601012.SH",
      source: ["conference", "interactive"],
      questionCategory: ["financialData"],
      answerImportant: [1],
      startTime: "2026-06-01",
      endTime: "2026-07-01 23:59:59",
    }))
  })

  it("rejects a blank securityCode without calling the API", async () => {
    const client = makeClient()
    const mcp = await connect(client)
    const result = await mcp.callTool({ name: "gangtise_qa_list", arguments: { securityCode: "  " } })
    expect(result.isError).toBe(true)
    expect(client.call).not.toHaveBeenCalled()
  })

  it("rejects an out-of-set answerImportant flag without calling the API", async () => {
    const client = makeClient()
    const mcp = await connect(client)
    const result = await mcp.callTool({ name: "gangtise_qa_list", arguments: { securityCode: "601012.SH", answerImportant: [2] } })
    expect(result.isError).toBe(true)
    expect(client.call).not.toHaveBeenCalled()
  })
})

describe("gangtise_report_image_list", () => {
  it("passes search args through to insight.report-image.list", async () => {
    const client = makeClient()
    ;(client.call as ReturnType<typeof vi.fn>).mockResolvedValue({ list: [] })
    const mcp = await connect(client)
    const result = await mcp.callTool({ name: "gangtise_report_image_list", arguments: { keyword: "AI", top: 20 } })
    expect(result.isError).toBeFalsy()
    expect(client.call).toHaveBeenCalledWith("insight.report-image.list", expect.objectContaining({ keyword: "AI", top: 20 }))
  })

  it("rejects top above the server cap of 20 (silently truncated upstream)", async () => {
    const client = makeClient()
    const mcp = await connect(client)
    const result = await mcp.callTool({ name: "gangtise_report_image_list", arguments: { keyword: "AI", top: 21 } })
    expect(result.isError).toBe(true)
    expect(client.call).not.toHaveBeenCalled()
  })
})

describe("gangtise_report_image_download", () => {
  it("rejects a blank chunkId without downloading", async () => {
    const client = makeClient()
    const mcp = await connect(client)
    const result = await mcp.callTool({ name: "gangtise_report_image_download", arguments: { chunkId: " " } })
    expect(result.isError).toBe(true)
    expect(client.download).not.toHaveBeenCalled()
  })

  it("downloads by chunkId", async () => {
    const client = makeClient()
    const mcp = await connect(client)
    const result = await mcp.callTool({ name: "gangtise_report_image_download", arguments: { chunkId: "c1" } })
    expect(result.isError).toBeFalsy()
    expect(client.download).toHaveBeenCalledTimes(1)
  })
})

describe("gangtise_report_image_list sourceId", () => {
  it("rejects a blank sourceId without calling the API", async () => {
    const client = makeClient()
    const mcp = await connect(client)
    const result = await mcp.callTool({ name: "gangtise_report_image_list", arguments: { keyword: "AI", sourceId: " " } })
    expect(result.isError).toBe(true)
    expect(client.call).not.toHaveBeenCalled()
  })
})

// 财报日历不加筛选时 total 是十万量级（实测 2026-07-26 为 126683，含未来排期），
// 拉满是 MAX_PAGES × 50 = 5 万行 ≈ 5000 积分。闸门按**实际请求行数**判，fetchAll 只是
// 其中一种到达方式（超大 size 等价，见下面的 oversized-size 那组）。本组钉 fetchAll
// 这条路径：什么算真实约束、以及 securityList 单约束下的封顶与 _partial 判据。
describe("gangtise_performance_calendar_list fetchAll guardrail", () => {
  function rows(n: number, total: number, extra: Record<string, unknown> = {}) {
    return {
      call: vi.fn(async () => ({ total, list: Array.from({ length: n }, (_, i) => ({ performanceReportId: String(i) })), ...extra })),
      download: vi.fn(),
    } as unknown as GangtiseClient
  }

  function bodyOf(client: GangtiseClient) {
    return (client.call as unknown as { mock: { calls: unknown[][] } }).mock.calls[0][1] as Record<string, unknown>
  }

  it("rejects fetchAll with no real bound, without calling the API", async () => {
    const client = rows(0, 0)
    const mcp = await connect(client)
    const result = await mcp.callTool({ name: "gangtise_performance_calendar_list", arguments: { fetchAll: true } })
    expect(result.isError).toBe(true)
    expect(client.call).not.toHaveBeenCalled()
  })

  // marketList / categoryList 都不是约束：实测单个 aShares 仍有 64327 条。
  it("does not accept marketList or categoryList as a bound", async () => {
    const client = rows(0, 0)
    const mcp = await connect(client)
    const result = await mcp.callTool({
      name: "gangtise_performance_calendar_list",
      arguments: { fetchAll: true, marketList: ["aShares"], categoryList: ["performanceForecast"] },
    })
    expect(result.isError).toBe(true)
    expect(client.call).not.toHaveBeenCalled()
  })

  // 半开区间不算约束 —— 实测只给 startDate 或只给 endDate 服务端一律忽略。
  it("requires both ends of the range, not just one", async () => {
    const client = rows(0, 0)
    const mcp = await connect(client)
    const result = await mcp.callTool({ name: "gangtise_performance_calendar_list", arguments: { fetchAll: true, startTime: "2026-07-20" } })
    expect(result.isError).toBe(true)
    expect(client.call).not.toHaveBeenCalled()
  })

  it("allows fetchAll with a full time range and imposes no row cap", async () => {
    const client = rows(3, 3)
    const mcp = await connect(client)
    const result = await mcp.callTool({
      name: "gangtise_performance_calendar_list",
      arguments: { fetchAll: true, startTime: "2026-07-20", endTime: "2026-07-25" },
    })
    expect(result.isError).toBeFalsy()
    const body = bodyOf(client)
    expect(body.size).toBeUndefined()
  })

  it("caps a securityList-only fetchAll at 1000 rows", async () => {
    const client = rows(3, 3)
    const mcp = await connect(client)
    await mcp.callTool({ name: "gangtise_performance_calendar_list", arguments: { fetchAll: true, securityList: ["600519.SH"] } })
    const body = bodyOf(client)
    expect(body.size).toBe(1000)
  })

  // 取满上限且 total 还有剩余 = securityList 过滤可能已失效，屏上是整本日历的切片。
  it("flags _partial when the security-only cap is hit with rows remaining", async () => {
    const client = rows(1000, 126683)
    const mcp = await connect(client)
    const result = await mcp.callTool({ name: "gangtise_performance_calendar_list", arguments: { fetchAll: true, securityList: ["600519.SH"] } })
    const text = (result.content as Array<{ text: string }>)[0].text
    expect(text).toContain("_partial")
    expect(text).toContain("security_only_row_cap")
  })

  // 判据是 total 而非行数：恰好取满 1000 行、但 total 就是 1000，那是完整结果。
  it("leaves an exactly-full but complete result unflagged", async () => {
    const client = rows(1000, 1000)
    const mcp = await connect(client)
    const result = await mcp.callTool({ name: "gangtise_performance_calendar_list", arguments: { fetchAll: true, securityList: ["600519.SH"] } })
    const text = (result.content as Array<{ text: string }>)[0].text
    expect(text).not.toContain("security_only_row_cap")
  })

  // 上游对错枚举是静默返全量（实测 categoryList:["bogus"] 与不传筛选同为 126683）
  // 且照常按 0.1/条 计费 —— schema 的 z.enum 是唯一防线。
  it("rejects a misspelled category enum locally", async () => {
    const client = rows(0, 0)
    const mcp = await connect(client)
    const result = await mcp.callTool({ name: "gangtise_performance_calendar_list", arguments: { categoryList: ["bogusCategory"] } })
    expect(result.isError).toBe(true)
    expect(client.call).not.toHaveBeenCalled()
  })

  it("defaults to size 20 without fetchAll", async () => {
    const client = rows(3, 999)
    const mcp = await connect(client)
    await mcp.callTool({ name: "gangtise_performance_calendar_list", arguments: {} })
    const body = bodyOf(client)
    expect(body.size).toBe(20)
  })
})

// size 与 fetchAll 是同一件事：client.requestPaginated 把 size 当作总目标行数按
// total 自动翻页，所以只拦 fetchAll 等于没拦——size:50000 照样能拉满 5 万行。
// 这组钉住「闸门按实际请求行数判」，而不是按 fetchAll 这个布尔判。
describe("gangtise_performance_calendar_list oversized-size bypass", () => {
  function rows(n: number, total: number) {
    return {
      call: vi.fn(async () => ({ total, list: Array.from({ length: n }, (_, i) => ({ performanceReportId: String(i) })) })),
      download: vi.fn(),
    } as unknown as GangtiseClient
  }
  const bodyOf = (c: GangtiseClient) => (c.call as unknown as { mock: { calls: unknown[][] } }).mock.calls[0][1] as Record<string, unknown>

  it("rejects an oversized size with no bound, without calling the API", async () => {
    const client = rows(0, 0)
    const mcp = await connect(client)
    const result = await mcp.callTool({ name: "gangtise_performance_calendar_list", arguments: { size: 50000 } })
    expect(result.isError).toBe(true)
    expect(client.call).not.toHaveBeenCalled()
  })

  it("still allows a modest unfiltered size", async () => {
    const client = rows(50, 126683)
    const mcp = await connect(client)
    const result = await mcp.callTool({ name: "gangtise_performance_calendar_list", arguments: { size: 50 } })
    expect(result.isError).toBeFalsy()
    expect(bodyOf(client).size).toBe(50)
  })

  // 光有 securityList 时，显式大 size 和 fetchAll 必须一视同仁地封顶。
  it("caps an oversized size the same as fetchAll when securityList is the only bound", async () => {
    const client = rows(3, 3)
    const mcp = await connect(client)
    await mcp.callTool({ name: "gangtise_performance_calendar_list", arguments: { size: 50000, securityList: ["600519.SH"] } })
    expect(bodyOf(client).size).toBe(1000)
  })

  // 有真实日期区间时不封顶：区间本身就是约束，调用方明确表达了范围。
  it("leaves an oversized size alone when a full time range bounds it", async () => {
    const client = rows(3, 3)
    const mcp = await connect(client)
    await mcp.callTool({
      name: "gangtise_performance_calendar_list",
      arguments: { size: 50000, startTime: "2026-07-20", endTime: "2026-07-25" },
    })
    expect(bodyOf(client).size).toBe(50000)
  })

  // _partial_reason 是逗号拼接的多原因列表（client.requestPaginated 会写入
  // page_cap / total_drift / failed_pages）。本工具追加自己的原因，不能覆盖掉那些。
  it("appends its cap reason instead of overwriting the pagination layer's", async () => {
    const client = {
      call: vi.fn(async () => ({
        total: 126683,
        list: Array.from({ length: 1000 }, (_, i) => ({ performanceReportId: String(i) })),
        _partial: true,
        _partial_reason: "total_drift,failed_pages",
      })),
      download: vi.fn(),
    } as unknown as GangtiseClient
    const mcp = await connect(client)
    const result = await mcp.callTool({ name: "gangtise_performance_calendar_list", arguments: { fetchAll: true, securityList: ["600519.SH"] } })
    const payload = JSON.parse((result.content as Array<{ text: string }>)[0].text)
    expect(payload._partial_reason).toBe("total_drift,failed_pages,security_only_row_cap")
  })
})
