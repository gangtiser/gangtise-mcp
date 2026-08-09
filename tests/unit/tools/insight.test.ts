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

  // 半开区间**不算强约束**（进不了 hasStrongBound、不能放开行数上限）——但它**确实在筛**：
  // 单 startDate 9946、单 endDate 119005，对比基线 128414。别把「不够强」写成「不生效」。
  it("requires both ends of the range, not just one", async () => {
    const client = rows(0, 0)
    const mcp = await connect(client)
    const result = await mcp.callTool({ name: "gangtise_performance_calendar_list", arguments: { fetchAll: true, startDate: "2026-07-20" } })
    expect(result.isError).toBe(true)
    expect(client.call).not.toHaveBeenCalled()
  })

  it("allows fetchAll with a full time range and imposes no row cap", async () => {
    const client = rows(3, 3)
    const mcp = await connect(client)
    const result = await mcp.callTool({
      name: "gangtise_performance_calendar_list",
      arguments: { fetchAll: true, startDate: "2026-07-20", endDate: "2026-07-25" },
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
      arguments: { size: 50000, startDate: "2026-07-20", endDate: "2026-07-25" },
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

// 上游对**非法枚举值**的处理和对未知字段一样：静默丢弃该条件、返回未过滤的全量、
// 不报错。最坏的一例是非法 searchType 会连带吞掉 keyword（CLI v0.32.0 实测：
// summary keyword=茅台 正常 135 条，配 searchType=99 返 196988 条全库），调用方
// 读到的是「搜索茅台的结果」、实得全库转储。所以 schema 层的闭集是唯一防线，
// 且必须在**发请求之前**拦下——否则那一次全库转储已经按条计费了。
describe("searchType / rankType closed sets", () => {
  for (const tool of ["gangtise_summary_list", "gangtise_research_list", "gangtise_official_account_list", "gangtise_pamirs_summary_list"]) {
    it(`rejects an out-of-set searchType on ${tool} without calling the API`, async () => {
      const client = makeClient()
      const mcp = await connect(client)
      const result = await mcp.callTool({ name: tool, arguments: { keyword: "茅台", searchType: 99 } })
      expect(result.isError).toBe(true)
      expect(client.call).not.toHaveBeenCalled()
    })
  }

  it("rejects an out-of-set rankType on a list that has no searchType", async () => {
    const client = makeClient()
    const mcp = await connect(client)
    const result = await mcp.callTool({ name: "gangtise_opinion_list", arguments: { rankType: 3 } })
    expect(result.isError).toBe(true)
    expect(client.call).not.toHaveBeenCalled()
  })

  it("still accepts the two legal values", async () => {
    const client = makeClient()
    ;(client.call as ReturnType<typeof vi.fn>).mockResolvedValue({ list: [], total: 0 })
    const mcp = await connect(client)
    const result = await mcp.callTool({ name: "gangtise_summary_list", arguments: { keyword: "茅台", searchType: 2, rankType: 2 } })
    expect(result.isError).toBeFalsy()
    expect(client.call).toHaveBeenCalledTimes(1)
  })
})

// 帕米尔是独立的专家纪要库，不是 summary 的筛选项，筛选项也是 summary 的真子集。
// 上游静默丢弃不认识的 body 字段，所以照搬 summary 的参数集会让调用方以为过滤
// 生效、实得全量——这里钉住那三个字段确实没被暴露出去。
describe("gangtise_pamirs_summary_list", () => {
  it("hits its own endpoint, not insight.summary.list", async () => {
    const client = makeClient()
    ;(client.call as ReturnType<typeof vi.fn>).mockResolvedValue({ list: [], total: 0 })
    const mcp = await connect(client)
    await mcp.callTool({
      name: "gangtise_pamirs_summary_list",
      arguments: { keyword: "PCB", categoryList: ["companyAnalysis"], marketList: ["aShares"] },
    })
    const [endpointKey, body] = (client.call as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(endpointKey).toBe("insight.pamirs-summary.list")
    expect(body).toMatchObject({ keyword: "PCB", categoryList: ["companyAnalysis"], marketList: ["aShares"] })
  })

  it("does not expose summary's extra filters, which the server would silently drop", async () => {
    const client = makeClient()
    const mcp = await connect(client)
    const { tools } = await mcp.listTools()
    const schema = tools.find((t) => t.name === "gangtise_pamirs_summary_list")?.inputSchema as { properties: Record<string, unknown> }
    for (const absent of ["sourceList", "institutionList", "participantRoleList"]) {
      expect(schema.properties).not.toHaveProperty(absent)
    }
    expect(schema.properties).toHaveProperty("researchAreaList")
  })

  it("rejects an out-of-set category before spending a call", async () => {
    const client = makeClient()
    const mcp = await connect(client)
    const result = await mcp.callTool({ name: "gangtise_pamirs_summary_list", arguments: { categoryList: ["earningsCall"] } })
    expect(result.isError).toBe(true)
    expect(client.call).not.toHaveBeenCalled()
  })

  it("downloads by summaryId", async () => {
    const client = makeClient()
    const mcp = await connect(client)
    const result = await mcp.callTool({ name: "gangtise_pamirs_summary_download", arguments: { summaryId: "5863831", fileType: 2 } })
    expect(result.isError).toBeFalsy()
    expect(client.download).toHaveBeenCalledTimes(1)
  })
})

// 🔴 财报日历的日期字段名是 startDate/endDate，不是 startTime/endTime。
// 传错名时上游**静默忽略并返回全库**（2026-08-08 实测：startTime/endTime 的 total
// 与无筛选基线同为 128414，逐位相同；startDate/endDate 同区间为 537）。危害被本工具
// 自己的闸门放大——hasDateRange 认为「给了日期区间就是有约束」于是放开行数上限，
// 于是「查一周日历」实际变成按 0.1/条无筛选翻 12 万行。
// 本工具的其他 list（qa/summary/research 等）用的确实是 startTime/endTime，只有
// 财报日历这一个端点不同，所以必须钉死，不能靠「和邻居一致」推断。
describe("gangtise_performance_calendar_list date field contract", () => {
  it("sends startDate/endDate, never startTime/endTime", async () => {
    const client = makeClient()
    ;(client.call as ReturnType<typeof vi.fn>).mockResolvedValue({ list: [], total: 0 })
    const mcp = await connect(client)
    await mcp.callTool({
      name: "gangtise_performance_calendar_list",
      arguments: { startDate: "2026-07-20", endDate: "2026-07-25" },
    })
    const body = (client.call as ReturnType<typeof vi.fn>).mock.calls[0][1]
    expect(body).toMatchObject({ startDate: "2026-07-20", endDate: "2026-07-25" })
    expect(body).not.toHaveProperty("startTime")
    expect(body).not.toHaveProperty("endTime")
  })

  // 闸门必须认 startDate/endDate；认错字段就等于「有区间也当无筛选」或反之。
  it("treats startDate+endDate as a real bound for the row-cap gate", async () => {
    const client = makeClient()
    ;(client.call as ReturnType<typeof vi.fn>).mockResolvedValue({ list: [], total: 0 })
    const mcp = await connect(client)
    const result = await mcp.callTool({
      name: "gangtise_performance_calendar_list",
      arguments: { size: 50000, startDate: "2026-07-20", endDate: "2026-07-25" },
    })
    expect(result.isError).toBeFalsy()
    expect((client.call as ReturnType<typeof vi.fn>).mock.calls[0][1].size).toBe(50000)
  })

  // ⚠️ 本用例写于加**根级 strict** 之前。加了 strict 之后，旧名在这条路径之前就被
  // 直接拒了（`Unrecognized key(s)`、不发请求，见 tests/integration/server.test.ts）。
  // 这里保留的是**第二层**保护：即便将来 strict 因故失效，行数闸门仍不把旧名当约束，
  // fetchAll / 超大 size 这些危险用法照样被拒。两层都要在。
  it("does not accept the stale startTime/endTime as a bound", async () => {
    const client = makeClient()
    const mcp = await connect(client)
    const result = await mcp.callTool({
      name: "gangtise_performance_calendar_list",
      arguments: { fetchAll: true, startTime: "2026-07-20", endTime: "2026-07-25" },
    })
    expect(result.isError).toBe(true)
    expect(client.call).not.toHaveBeenCalled()
  })
})

// 上游对 null payload 的处理：foreign-opinion / independent-opinion 传任何
// industryList 值都返回字面 null（2026-08-09 实测：合法中信码、合法申万码、乱码
// 三者一致，且 HTTP 200）。修前 MCP 把它原样渲染成字符串 "null" 且 isError=false，
// 调用方分不清「报错 / 无数据 / 坏了」。现在按空结果处理并给出提示。
describe("null payload rendering", () => {
  it("renders a null payload as an empty result with a hint, not the bare text null", async () => {
    const client = makeClient()
    ;(client.call as ReturnType<typeof vi.fn>).mockResolvedValue(null)
    const mcp = await connect(client)
    const result = await mcp.callTool({
      name: "gangtise_foreign_opinion_list",
      arguments: { industryList: ["100800119"] },
    })
    expect(result.isError).toBeFalsy()
    const text = (result.content as Array<{ text: string }>)[0].text
    expect(text).not.toBe("null")
    const payload = JSON.parse(text)
    expect(payload.list).toEqual([])
    expect(payload._hint).toBeTruthy()
  })
})

// 「够不够放开行数」（hasStrongBound）和「结果筛没筛过」（hasAnyEffectiveFilter）是
// 两件事，混用会两头出错。本组用例把两者分别钉住。
//
// 提示只在**一个筛选都没传**时出现。⚠️ 旧参数名 startTime/endTime 到不了这里——根级
// strict 会直接拒（见 tests/integration/server.test.ts），所以下面第二个用例传的是
// { from: 0 }（一个合法但不构成筛选的参数），不是旧参数名。
describe("gangtise_performance_calendar_list filter bounds", () => {
  const rows = (n: number) => ({
    call: vi.fn(async () => ({ total: 128414, list: Array.from({ length: n }, (_, i) => ({ performanceReportId: String(i) })) })),
    download: vi.fn(),
  } as unknown as GangtiseClient)

  // 「够不够放开行数」和「结果筛没筛过」是两件事，混用会两头出错。
  // 2026-08-09 实测（基线 128414）：单 startDate 9946、单 endDate 119005、
  // marketList=[aShares] 64419、categoryList=[performanceForecast] 11891 —— 全都真实过滤。
  // 把它们说成「未加任何筛选」是误报，会让调用方怀疑一份好数据。
  it.each([
    ["什么都没传", {}],
    ["只给了 from（合法但不构成筛选）", { from: 0 }],
  ] as Array<[string, Record<string, unknown>]>)("hints when nothing was filtered — %s", async (_l, args) => {
    const client = rows(20)
    const mcp = await connect(client)
    const result = await mcp.callTool({ name: "gangtise_performance_calendar_list", arguments: args })
    const payload = JSON.parse((result.content as Array<{ text: string }>)[0].text)
    expect(payload._hint).toContain("未加任何筛选条件")
    expect(payload._hint).toContain("startDate")
  })

  // 关键回归：这四种此前被误报成「无筛选」。
  it.each([
    ["仅 startDate", { startDate: "2026-07-20" }],
    ["仅 endDate", { endDate: "2026-07-25" }],
    ["marketList", { marketList: ["aShares"] }],
    ["categoryList", { categoryList: ["performanceForecast"] }],
    ["完整区间", { startDate: "2026-07-20", endDate: "2026-07-25" }],
    ["securityList", { securityList: ["600519.SH"] }],
  ] as Array<[string, Record<string, unknown>]>)("stays quiet when a real filter is present — %s", async (_l, args) => {
    const client = rows(20)
    const mcp = await connect(client)
    const result = await mcp.callTool({ name: "gangtise_performance_calendar_list", arguments: args })
    const payload = JSON.parse((result.content as Array<{ text: string }>)[0].text)
    expect(payload._hint ?? "").not.toContain("未加任何筛选条件")
  })

  // 但「有筛选」不等于「够强到可以放开行数」：marketList/categoryList 筛完仍是万级，
  // 按 0.1/条 放开上限依然是几千积分，所以闸门只认完整区间或 securityList。
  it.each([
    ["marketList 不足以放开行数", { fetchAll: true, marketList: ["aShares"] }],
    ["categoryList 不足以放开行数", { fetchAll: true, categoryList: ["performanceForecast"] }],
    ["单边日期不足以放开行数", { fetchAll: true, startDate: "2026-07-20" }],
  ] as Array<[string, Record<string, unknown>]>)("still gates the row cap without a strong bound — %s", async (_l, args) => {
    const client = rows(20)
    const mcp = await connect(client)
    const result = await mcp.callTool({ name: "gangtise_performance_calendar_list", arguments: args })
    expect(result.isError).toBe(true)
    expect((result.content as Array<{ text: string }>)[0].text).toContain("强约束")
    expect(client.call).not.toHaveBeenCalled()
  })

  it("零行不叠加提示（registry 已有空结果提示）", async () => {
    const client = rows(0)
    const mcp = await connect(client)
    const result = await mcp.callTool({ name: "gangtise_performance_calendar_list", arguments: {} })
    const payload = JSON.parse((result.content as Array<{ text: string }>)[0].text)
    expect(payload._hint ?? "").not.toContain("未加任何筛选条件")
  })
})

describe("opinion endpoints: empty-result hint names the real cause", () => {
  // 两个工具的提示**有意不同**：foreign-opinion 坏的是 **regionList + industryList 两个**
  // （⚠️ **brokerList 可正常使用**，本文件后面有反向断言钉住它不得被列为不可用）；
  // independent-opinion 只声明 industryList——提示里提它根本没有的参数会把调用方引偏，
  // 而且 strict 之下那些参数也传不进来。
  it.each([
    ["gangtise_foreign_opinion_list", "不代表该地区/行业没有观点", ["regionList"]],
    ["gangtise_independent_opinion_list", "不代表该行业没有独立观点", []],
  ] as Array<[string, string, string[]]>)(
    "%s names its own real cause, not a shared one",
    async (name, phrase, mustMention) => {
      const client = makeClient()
      ;(client.call as ReturnType<typeof vi.fn>).mockResolvedValue(null)
      const mcp = await connect(client)
      const result = await mcp.callTool({ name, arguments: { industryList: ["100800119"] } })
      const payload = JSON.parse((result.content as Array<{ text: string }>)[0].text)
      expect(payload.list).toEqual([])
      expect(payload._hint).toContain("industryList")
      expect(payload._hint).toContain(phrase)
      for (const p of mustMention) expect(payload._hint).toContain(p)
      // 独立观点没有 regionList / brokerList，提示里不能出现
      if (mustMention.length === 0) {
        expect(payload._hint).not.toContain("regionList")
        expect(payload._hint).not.toContain("brokerList")
      }
      // brokerList 在 foreign-opinion 上**是能用的**——绝不能把它列进「不可用」。
      // 我曾用编的 ID（"999"）和错码系 ID（domesticBroker 的 C1xxxxxxxx）测出 null
      // 就判它坏，那是没有正向对照的结论。真实 foreignOpinionInstitution ID 下，
      // 高盛/摩根士丹利各自返回互不相交、也与基线不相交的结果集。
      expect(payload._hint ?? "").not.toMatch(/brokerList[^。]*不可用/)
      // 通用文案那句说反了的开头不能出现
      expect(payload._hint).not.toContain("可能该条件下确无数据")
    },
  )

  // 其余 list 工具不受影响，仍用通用文案。
  it("leaves other list tools on the generic hint", async () => {
    const client = makeClient()
    ;(client.call as ReturnType<typeof vi.fn>).mockResolvedValue({ total: 0, list: [] })
    const mcp = await connect(client)
    const result = await mcp.callTool({ name: "gangtise_opinion_list", arguments: {} })
    const payload = JSON.parse((result.content as Array<{ text: string }>)[0].text)
    expect(payload._hint).toContain("可能该条件下确无数据")
  })
})

// 模型选工具时读的是**主描述**，它排在参数说明和空结果提示之前。主描述若仍宣传
// 「按行业筛选」，链路就是：选中 → 传 industryList → 拿到空结果 → 才读到真因。
// 好的情况浪费一次调用（foreign_opinion 30/条、单次约 600 积分），差的情况提示被
// 略过、得出「该行业没有外资观点」。三处文案必须同向。
describe("opinion endpoints: main description matches the param reality", () => {
  it.each(["gangtise_foreign_opinion_list", "gangtise_independent_opinion_list"])(
    "%s does not advertise industry filtering it cannot do",
    async (name) => {
      const mcp = await connect(makeClient())
      const { tools } = await mcp.listTools()
      const desc = tools.find((t) => t.name === name)!.description!
      // 主描述不得再把坏掉的筛选列进「支持按…筛选」
      expect(desc).not.toContain("、行业、")
      expect(desc).not.toContain("按证券、行业、")
      expect(desc).not.toContain("、地区、")
      expect(desc).toContain("当前不可用")
    },
  )
})

// 没开 nullMeansEmpty 的端点收到 null = 协议异常，必须响亮失败。
// 此前 buildToolContent 会把它 JSON.stringify 成字面量 "null" 原样返回、isError=false，
// 调用方分不清「报错 / 无数据 / 坏了」。opt-in 的两个观点列表另有真因提示（见上）。
describe("null payload on a non-opt-in tool fails loudly", () => {
  it("does not render the bare text null with isError=false", async () => {
    const client = makeClient()
    ;(client.call as ReturnType<typeof vi.fn>).mockResolvedValue(null)
    const mcp = await connect(client)
    const result = await mcp.callTool({ name: "gangtise_opinion_list", arguments: {} })
    expect(result.isError).toBe(true)
    const text = (result.content as Array<{ text: string }>)[0].text
    expect(text).not.toBe("null")
    expect(text).toContain("空响应体")
    // ⚠️ 不得要求调用方「带上 trace」——走到这条路径时信封已被剥掉，而
    // attachEnvelopeTraceId 挂不到 null 上，根本没有 traceId 可给。让人去找一个
    // 不存在的东西比不提示更糟。提示应改问工具名与入参（那两个调用方手里有）。
    expect(text).not.toContain("trace")
  })
})

// 本轮三处修正各配一条永久守卫。三处都不是「代码路径错了」，而是**入参边界**和
// **文案与实测行为不符**——这两类最容易在下一次改描述时被顺手改回去，而且改回去
// 之后没有任何测试会红。
describe("research_list page-count bounds reject negatives before upstream", () => {
  // 实测基线 3374262 条：minReportPages=-1 原样返回 3374262（负下限被忽略），
  // maxReportPages=-1 却返回 0（负上限当真了）。同一对参数两种行为，模型无从预期；
  // 传 -1 想表达「不限」的话，一个方向白花一次调用、另一个方向拿到空结果当结论。
  // 正向对照 minReportPages=10 → 1221220，证明参数本身是生效的。
  it.each(["minReportPages", "maxReportPages"])("%s rejects a negative value", async (key) => {
    const client = makeClient()
    const mcp = await connect(client)
    const result = await mcp
      .callTool({ name: "gangtise_research_list", arguments: { [key]: -1 } })
      .catch(() => ({ isError: true }))
    expect((result as { isError?: boolean }).isError).toBe(true)
    expect((client.call as ReturnType<typeof vi.fn>).mock.calls.length).toBe(0)
  })

  it("still accepts 0 and positive page counts", async () => {
    const client = makeClient()
    // makeClient 的 call 默认返回 undefined，会撞上「非 opt-in 的 null 必须响亮失败」，
    // 让这条对照因为无关原因变红。对照组要红就只能红在边界上，别的原因都得排掉。
    ;(client.call as ReturnType<typeof vi.fn>).mockResolvedValue({ list: [{ id: "x" }], total: 1 })
    const mcp = await connect(client)
    for (const args of [{ minReportPages: 0 }, { minReportPages: 10, maxReportPages: 50 }]) {
      const result = await mcp.callTool({ name: "gangtise_research_list", arguments: args })
      expect(result.isError).toBeFalsy()
    }
  })
})

// researchAreaList 收的是**行业 ID**。模型若把 122000xxx 方向码传进来，会拿到 0 条且不报错，
// 而这个端点上「0 条」跟「该行业真没有纪要」没法区分——所以描述必须**主动劝阻**，
// 光是「不提方向码」不够：不提等于把判断权交给模型的先验。
//
// ⚠️ 这条断言此前是空的：写成 `not.toMatch(/122000\d+/)`，而真实文案里是字面量
// 「122000xxx」（三个 x，不是数字），永远匹配不上、永远不会红。改成正向钉住劝阻语，
// 「行业 ID，也接受 122000xxx 方向码」这种反向改写会立刻红。
describe("pamirs_summary_list researchAreaList names the right code system", () => {
  it("actively warns against 方向码 instead of merely omitting them", async () => {
    const mcp = await connect(makeClient())
    const { tools } = await mcp.listTools()
    const schema = tools.find((t) => t.name === "gangtise_pamirs_summary_list")!.inputSchema as {
      properties: Record<string, { description?: string }>
    }
    const desc = schema.properties.researchAreaList?.description ?? ""
    expect(desc).toContain("行业 ID")
    // 劝阻语与码本身必须在同一句，否则「不要传 X。也接受 122000xxx」也能蒙混过关
    expect(desc).toMatch(/不要传[^。]*122000xxx/)
    // 后果必须写出来：不支持 + 静默返 0。少了后果，模型会把它当成软建议
    expect(desc).toContain("不支持")
    expect(desc).toMatch(/返回 0 条且不报错/)
  })
})

// regionList 在 foreign_opinion 上只有 gl 一个取值有效：cn/cnHk/cnTw/us/jp/uk 全部返 null，
// 而 gl 的结果与不传时**逐位相同**——即它并不筛选。描述必须说清「当前不可用」，
// 否则模型传 us 拿到 null 会读成「没有美国的外资观点」。
// 注意这条与 foreign_report 无关：同名参数在那个端点上是好的（基线 1760577 → us 561908）。
describe("foreign_opinion regionList is documented as non-functional", () => {
  it("pins the gl distinction, not just the word 不可用", async () => {
    const mcp = await connect(makeClient())
    const { tools } = await mcp.listTools()
    const get = (n: string) =>
      (tools.find((t) => t.name === n)!.inputSchema as { properties: Record<string, { description?: string }> })
        .properties
    const desc = get("gangtise_foreign_opinion_list").regionList?.description ?? ""
    expect(desc).toContain("当前不可用")
    // 只钉「当前不可用」不够：退回成「包括 gl 在内所有值都返空」照样能过，
    // 而那是错的——gl 有数据，只是不筛。三段缺一不可：
    expect(desc).toMatch(/cn[^。]*us[^。]*返回空结果/) // 具体地区值返空
    expect(desc).toMatch(/gl[^。]*返回数据/) // gl 有数据
    expect(desc).toContain("不收窄") // 但它不筛
    // 同名参数在 foreign_report 上是好的，不能被连坐
    expect(get("gangtise_foreign_report_list").regionList?.description ?? "").not.toContain("当前不可用")
  })
})
