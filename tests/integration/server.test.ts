import fs from "node:fs"
import path from "node:path"

import { describe, it, expect, vi, beforeEach } from "vitest"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { createGangtiseMcpServer } from "../../src/server.js"
import { today } from "../../src/core/dateContext.js"
import type { GangtiseClient } from "../../src/core/client.js"

function makeMockClient() {
  return {
    call: vi.fn().mockImplementation(async (key: string) => {
      if (key.startsWith("lookup.")) return [{ id: "1", name: "Test" }]
      // EDE 走双层信封 + 矩阵，返回通用 list 会被 requireIndicatorMatrix 硬拒。
      // 闭集参数用例靠正向对照判断「这条红是不是枚举造成的」，mock 形状不对
      // 会让 currency/scale/calendarType 全部沦为跳过——测不到就是漏。
      if (key.startsWith("indicator.")) {
        return {
          code: "000000",
          status: true,
          data: {
            securityCodeList: ["600519.SH"], securityNameList: ["贵州茅台"],
            indicatorList: [{ code: "qte_close", name: "收盘价", dataType: "number" }],
            dates: ["2026-07-31"], values: [[1]],
          },
        }
      }
      return { list: [{ id: "test-id" }], total: 1 }
    }),
    download: vi.fn().mockResolvedValue({ text: "mock", contentType: "text/plain", filename: "mock.txt" }),
  } as unknown as GangtiseClient
}

async function makeTestClient(mockClient: GangtiseClient) {
  const server = createGangtiseMcpServer(mockClient, { asyncTimeoutMs: 5_000 })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  const client = new Client({ name: "test-client", version: "0.0.1" })
  await client.connect(clientTransport)
  return client
}

describe("MCP server integration", () => {
  let mockClient: GangtiseClient
  let mcpClient: Client

  beforeEach(async () => {
    mockClient = makeMockClient()
    mcpClient = await makeTestClient(mockClient)
  })

  it("reports the package.json version to clients", async () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(process.cwd(), "package.json"), "utf8"))
    expect(mcpClient.getServerVersion()?.version).toBe(pkg.version)
  })

  it("lists all registered tools", async () => {
    const { tools } = await mcpClient.listTools()
    const names = tools.map(t => t.name)

    expect(names).toContain("gangtise_current_date")
    expect(names).toContain("gangtise_lookup")
    expect(names).toContain("gangtise_securities_search")
    expect(names).toContain("gangtise_opinion_list")
    // schedule tools share one extracted schema — guard all four stay registered
    expect(names).toContain("gangtise_roadshow_list")
    expect(names).toContain("gangtise_site_visit_list")
    expect(names).toContain("gangtise_strategy_list")
    expect(names).toContain("gangtise_forum_list")
    expect(names).toContain("gangtise_research_list")
    expect(names).toContain("gangtise_research_download")
    expect(names).toContain("gangtise_official_account_list")
    expect(names).toContain("gangtise_official_account_download")
    expect(names).toContain("gangtise_day_kline")
    expect(names).toContain("gangtise_income_statement")
    expect(names).toContain("gangtise_one_pager")
    expect(names).toContain("gangtise_earnings_review")
    expect(names).toContain("gangtise_earnings_review_check")
    expect(names).toContain("gangtise_viewpoint_debate")
    expect(names).toContain("gangtise_drive_list")
    expect(names).toContain("gangtise_wechat_message_list")
    expect(names).toContain("gangtise_concept_info")
    expect(names).toContain("gangtise_concept_securities")
    expect(names).toContain("gangtise_constant_category")
    expect(names).toContain("gangtise_constant_list")
    expect(names).toContain("gangtise_concept_search")
    expect(names).toContain("gangtise_sector_search")
    expect(names).toContain("gangtise_sector_constituents")
    expect(names).toContain("gangtise_chiefs_search")
    expect(names).toContain("gangtise_institution_search")
    expect(names).toContain("gangtise_fund_flow")
    expect(names).toContain("gangtise_stock_summary")
    expect(names).toContain("gangtise_income_statement_us")
    expect(names).toContain("gangtise_balance_sheet_us")
    expect(names).toContain("gangtise_cash_flow_us")
    expect(names).toContain("gangtise_announcement_us_list")
    expect(names).toContain("gangtise_announcement_us_download")
    expect(names).toContain("gangtise_indicator_search")
    expect(names).toContain("gangtise_indicator_cross_section")
    expect(names).toContain("gangtise_indicator_time_series")

    // Should have a substantial number of tools
    expect(tools.length).toBeGreaterThan(40)
  })

  it("keeps date-sensitive tool metadata free of startup-date literals", async () => {
    const { tools } = await mcpClient.listTools()
    const metadata = JSON.stringify(tools)

    expect(metadata).toContain("gangtise_current_date")
    expect(metadata).not.toMatch(/当前日期\s+\d{4}-\d{2}-\d{2}/)
    expect(metadata).not.toMatch(/当前年份\s+\d{4}/)
  })

  it("marks tools read-only except the billed async submit tools", async () => {
    const { tools } = await mcpClient.listTools()
    const nonReadOnly = tools.filter(t => t.annotations?.readOnlyHint !== true).map(t => t.name).sort()
    // Async submit tools create a billed, non-idempotent task (endpoints carry
    // retry: "no-replay"), so they must NOT be read-only — clients shouldn't
    // auto-invoke them unconfirmed.
    // Their _check polling tools stay read-only.
    expect(nonReadOnly).toEqual(["gangtise_earnings_review", "gangtise_viewpoint_debate"])
    // Every tool hits a single closed-domain API (or local data), never the open
    // world — so all declare openWorldHint: false.
    expect(tools.every(t => t.annotations?.openWorldHint === false)).toBe(true)
  })

  it("declares date guidance once in server instructions, not per-tool descriptions", async () => {
    expect(mcpClient.getInstructions()).toContain("gangtise_current_date")

    const { tools } = await mcpClient.listTools()
    const metadata = JSON.stringify(tools)
    const copies = metadata.split("先调用 gangtise_current_date").length - 1
    expect(copies).toBe(0)
  })

  it("gangtise_current_date returns runtime Asia/Shanghai date context", async () => {
    const result = await mcpClient.callTool({ name: "gangtise_current_date", arguments: {} })
    expect(result.isError).toBeFalsy()

    const text = (result.content as Array<{ text: string }>)[0].text
    const parsed = JSON.parse(text)

    expect(parsed).toMatchObject({
      timezone: "Asia/Shanghai",
      currentDate: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
      currentYear: expect.stringMatching(/^\d{4}$/),
      currentDateTime: expect.stringMatching(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/),
    })
  })

  it("gangtise_lookup returns data for each type", async () => {
    const types = ["broker-orgs", "meeting-orgs"]
    for (const type of types) {
      const result = await mcpClient.callTool({ name: "gangtise_lookup", arguments: { type } })
      expect(result.isError).toBeFalsy()
      const text = (result.content as Array<{ text: string }>)[0].text
      const parsed = JSON.parse(text)
      expect(Array.isArray(parsed)).toBe(true)
    }
  })

  it("gangtise_lookup rejects unknown type", async () => {
    const result = await mcpClient.callTool({ name: "gangtise_lookup", arguments: { type: "nonexistent" } })
    // Schema validation should reject this — result will be an error
    expect(result.isError).toBe(true)
  })

  it("gangtise_lookup rejects types retired in favor of the constants API", async () => {
    for (const type of ["research-areas", "industries", "regions", "announcement-categories", "theme-ids", "industry-codes"]) {
      const result = await mcpClient.callTool({ name: "gangtise_lookup", arguments: { type } })
      expect(result.isError).toBe(true)
    }
  })

  it("gangtise_constant_list calls the constants endpoint with category", async () => {
    await mcpClient.callTool({ name: "gangtise_constant_list", arguments: { category: "citicIndustry" } })
    expect(mockClient.call).toHaveBeenCalledWith(
      "reference.constant-list",
      expect.objectContaining({ category: "citicIndustry" }),
    )
  })

  it("gangtise_concept_search calls the concepts endpoint with keyword", async () => {
    await mcpClient.callTool({ name: "gangtise_concept_search", arguments: { keyword: "机器人", top: 3 } })
    expect(mockClient.call).toHaveBeenCalledWith(
      "reference.concept-search",
      expect.objectContaining({ keyword: "机器人", top: 3 }),
    )
  })

  it("gangtise_sector_constituents calls the sectors endpoint with sectorId", async () => {
    await mcpClient.callTool({ name: "gangtise_sector_constituents", arguments: { sectorId: "1000001005" } })
    expect(mockClient.call).toHaveBeenCalledWith(
      "reference.sector-constituents",
      expect.objectContaining({ sectorId: "1000001005" }),
    )
  })

  it("gangtise_concept_search rejects an empty keyword before calling the API", async () => {
    const result = await mcpClient.callTool({ name: "gangtise_concept_search", arguments: { keyword: "" } })
    expect(result.isError).toBe(true)
    expect(mockClient.call).not.toHaveBeenCalled()
  })

  it("gangtise_concept_search rejects a whitespace-only keyword before calling the API", async () => {
    const result = await mcpClient.callTool({ name: "gangtise_concept_search", arguments: { keyword: "   " } })
    expect(result.isError).toBe(true)
    expect(mockClient.call).not.toHaveBeenCalled()
  })

  it("gangtise_securities_search rejects an empty keyword before calling the API", async () => {
    const result = await mcpClient.callTool({ name: "gangtise_securities_search", arguments: { keyword: "" } })
    expect(result.isError).toBe(true)
    expect(mockClient.call).not.toHaveBeenCalled()
  })

  it("gangtise_sector_constituents rejects an empty sectorId before calling the API", async () => {
    const result = await mcpClient.callTool({ name: "gangtise_sector_constituents", arguments: { sectorId: "" } })
    expect(result.isError).toBe(true)
    expect(mockClient.call).not.toHaveBeenCalled()
  })

  it("gangtise_constant_list rejects an unknown category before calling the API", async () => {
    const result = await mcpClient.callTool({ name: "gangtise_constant_list", arguments: { category: "foo" } })
    expect(result.isError).toBe(true)
    expect(mockClient.call).not.toHaveBeenCalled()
  })

  it("schedule list tools accept locationList", async () => {
    await mcpClient.callTool({ name: "gangtise_roadshow_list", arguments: { locationList: ["10001"] } })
    expect(mockClient.call).toHaveBeenCalledWith(
      "insight.roadshow.list",
      expect.objectContaining({ locationList: ["10001"] }),
    )
  })

  it("schedule list tools expose only API-spec-supported business fields", async () => {
    const { tools } = await mcpClient.listTools()
    const props = (name: string) => {
      const t = tools.find(x => x.name === name)
      return Object.keys((t?.inputSchema as { properties?: Record<string, unknown> })?.properties ?? {})
    }

    // strategy: only institution / location (+ shared paginated/time/keyword/from/size)
    expect(props("gangtise_strategy_list")).toEqual(expect.arrayContaining(["institutionList", "locationList"]))
    expect(props("gangtise_strategy_list")).not.toContain("researchAreaList")
    expect(props("gangtise_strategy_list")).not.toContain("securityList")
    expect(props("gangtise_strategy_list")).not.toContain("categoryList")
    expect(props("gangtise_strategy_list")).not.toContain("participantRoleList")

    // forum: only researchArea / location
    expect(props("gangtise_forum_list")).toEqual(expect.arrayContaining(["researchAreaList", "locationList"]))
    expect(props("gangtise_forum_list")).not.toContain("securityList")
    expect(props("gangtise_forum_list")).not.toContain("institutionList")

    // site-visit: has object, dropped participantRole / brokerType
    expect(props("gangtise_site_visit_list")).toEqual(expect.arrayContaining(["objectList"]))
    expect(props("gangtise_site_visit_list")).not.toContain("participantRoleList")
    expect(props("gangtise_site_visit_list")).not.toContain("brokerTypeList")

    // roadshow: full set, no object
    expect(props("gangtise_roadshow_list")).toEqual(
      expect.arrayContaining([
        "researchAreaList", "institutionList", "securityList", "categoryList",
        "marketList", "participantRoleList", "brokerTypeList", "permission", "locationList",
      ]),
    )
    expect(props("gangtise_roadshow_list")).not.toContain("objectList")
  })

  it("gangtise_announcement_list no longer exposes the server-ignored announcementTypeList", async () => {
    const { tools } = await mcpClient.listTools()
    const ann = tools.find(t => t.name === "gangtise_announcement_list")
    const keys = Object.keys((ann?.inputSchema as { properties?: Record<string, unknown> })?.properties ?? {})
    expect(keys).toContain("categoryList")
    expect(keys).not.toContain("announcementTypeList")
  })

  it("categoryList enums are locked to the API-verified sets and reject unknown values before the client", async () => {
    const { tools } = await mcpClient.listTools()
    const catEnum = (name: string): string[] | undefined => {
      const t = tools.find(x => x.name === name)
      const props = (t?.inputSchema as { properties?: Record<string, { items?: { enum?: string[] } }> })?.properties
      return props?.categoryList?.items?.enum
    }

    // Empirically verified against the live API + CLI insight.md — lock so a later
    // describe-text edit can't silently drop/rename a value (the old bogus
    // expertInterview / quantitative are exactly how this drifted before).
    expect(catEnum("gangtise_summary_list")).toEqual([
      "earningsCall", "strategyMeeting", "fundRoadshow", "shareholdersMeeting",
      "maMeeting", "specialMeeting", "companyAnalysis", "industryAnalysis", "other",
    ])
    const researchSet = [
      "macro", "strategy", "industry", "company", "bond", "quant", "morningNotes",
      "fund", "forex", "futures", "options", "warrants", "market", "wealthManagement", "other",
    ]
    expect(catEnum("gangtise_research_list")).toEqual(researchSet)
    expect(catEnum("gangtise_foreign_report_list")).toEqual(researchSet)

    // An unknown category must be rejected at the MCP schema boundary and never
    // forwarded upstream (where it silently no-ops and returns the full table).
    const res = await mcpClient.callTool({
      name: "gangtise_summary_list",
      arguments: { categoryList: ["expertInterview"] },
    })
    expect(res.isError).toBeTruthy()
    expect(mockClient.call).not.toHaveBeenCalled()
  })

  it("gangtise_official_account_list forwards documented filters with default size", async () => {
    await mcpClient.callTool({
      name: "gangtise_official_account_list",
      arguments: { categoryList: ["report"], searchType: 2, accountIdList: ["acc-1"] },
    })
    expect(mockClient.call).toHaveBeenCalledWith(
      "insight.official-account.list",
      expect.objectContaining({ categoryList: ["report"], searchType: 2, accountIdList: ["acc-1"], size: 20 }),
    )
  })

  it("gangtise_official_account_download downloads the article by articleId", async () => {
    ;(mockClient.download as ReturnType<typeof vi.fn>).mockResolvedValue({ text: "article body", contentType: "text/plain" })
    const result = await mcpClient.callTool({
      name: "gangtise_official_account_download",
      arguments: { articleId: "art-1", fileType: 1 },
    })
    expect(result.isError).toBeFalsy()
    const [endpointArg, queryArg] = (mockClient.download as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(endpointArg.key).toBe("insight.official-account.download")
    expect(queryArg).toMatchObject({ articleId: "art-1", fileType: 1 })
  })

  it("gangtise_opinion_list calls API with default size: 20", async () => {
    await mcpClient.callTool({ name: "gangtise_opinion_list", arguments: {} })
    expect(mockClient.call).toHaveBeenCalledWith(
      "insight.opinion.list",
      expect.objectContaining({ size: 20 }),
    )
  })

  it("gangtise_opinion_list respects explicit size", async () => {
    await mcpClient.callTool({ name: "gangtise_opinion_list", arguments: { size: 5 } })
    expect(mockClient.call).toHaveBeenCalledWith(
      "insight.opinion.list",
      expect.objectContaining({ size: 5 }),
    )
  })

  it("gangtise_income_statement does not add size", async () => {
    await mcpClient.callTool({ name: "gangtise_income_statement", arguments: { securityCode: "600519.SH" } })
    const callArg = (mockClient.call as ReturnType<typeof vi.fn>).mock.calls[0][1] as Record<string, unknown>
    expect(callArg).not.toHaveProperty("size")
  })

  it("gangtise_concept_info calls concept-info endpoint with conceptId", async () => {
    await mcpClient.callTool({ name: "gangtise_concept_info", arguments: { conceptId: "121000130" } })
    expect(mockClient.call).toHaveBeenCalledWith(
      "alternative.concept-info",
      expect.objectContaining({ conceptId: "121000130" }),
    )
  })

  it("gangtise_concept_securities calls concept-securities endpoint with conceptId", async () => {
    await mcpClient.callTool({ name: "gangtise_concept_securities", arguments: { conceptId: "121000130" } })
    expect(mockClient.call).toHaveBeenCalledWith(
      "alternative.concept-securities",
      expect.objectContaining({ conceptId: "121000130" }),
    )
  })

  it("gangtise_theme_tracking normalizes a single type to the backend array shape", async () => {
    await mcpClient.callTool({
      name: "gangtise_theme_tracking",
      arguments: { themeId: "121000130", date: today(), type: "morning" },
    })
    expect(mockClient.call).toHaveBeenCalledWith(
      "ai.theme-tracking",
      expect.objectContaining({ themeId: "121000130", date: today(), type: ["morning"] }),
    )
  })

  it("gangtise_theme_tracking rejects malformed dates before calling the API", async () => {
    const result = await mcpClient.callTool({
      name: "gangtise_theme_tracking",
      arguments: { themeId: "121000130", date: "2026-13-99" },
    })

    expect(result.isError).toBe(true)
    // Rejected at the zod schema boundary since the X5 tightening (previously a
    // runtime ValidationError inside the handler) — match either message shape.
    expect((result.content as Array<{ text: string }>)[0].text).toMatch(/无效日期|格式须为/)
    expect(mockClient.call).not.toHaveBeenCalled()
  })

  it("gangtise_day_kline rejects non-positive limits before calling the API", async () => {
    const result = await mcpClient.callTool({
      name: "gangtise_day_kline",
      arguments: { security: "600519.SH", limit: 0 },
    })

    expect(result.isError).toBe(true)
    expect(mockClient.call).not.toHaveBeenCalledWith("quote.day-kline", expect.anything())
  })

  it("gangtise_earnings_review submits then polls until content arrives", async () => {
    vi.mocked(mockClient.call).mockImplementation(async (key: string) => {
      if (key === "ai.earnings-review.get-id") return { dataId: "task-1" }
      if (key === "ai.earnings-review.get-content") return { content: "# 业绩点评" }
      throw new Error(`unexpected endpoint: ${key}`)
    })

    const result = await mcpClient.callTool({
      name: "gangtise_earnings_review",
      arguments: { securityCode: "600519.SH", period: "2026q1" },
    })

    expect(result.isError).toBeFalsy()
    expect((result.content as Array<{ text: string }>)[0].text).toBe("# 业绩点评")
    expect(mockClient.call).toHaveBeenCalledWith("ai.earnings-review.get-id", { securityCode: "600519.SH", period: "2026q1" })
    expect(mockClient.call).toHaveBeenCalledWith("ai.earnings-review.get-content", { dataId: "task-1" })
  })

  it("gangtise_earnings_review_check reports pending on 410110 instead of erroring", async () => {
    const { ApiError } = await import("../../src/core/errors.js")
    vi.mocked(mockClient.call).mockRejectedValue(new ApiError("processing", "410110"))

    const result = await mcpClient.callTool({
      name: "gangtise_earnings_review_check",
      arguments: { dataId: "task-1" },
    })

    expect(result.isError).toBeFalsy()
    expect(JSON.parse((result.content as Array<{ text: string }>)[0].text)).toEqual({ status: "pending", dataId: "task-1" })
  })

  it("tools return isError on API failure", async () => {
    vi.mocked(mockClient.call).mockRejectedValueOnce(new Error("network error"))
    const result = await mcpClient.callTool({ name: "gangtise_opinion_list", arguments: {} })
    expect(result.isError).toBe(true)
    expect((result.content as Array<{ text: string }>)[0].text).toContain("network error")
  })

  it("gangtise_stock_summary rejects an empty securityList before calling the API", async () => {
    const result = await mcpClient.callTool({ name: "gangtise_stock_summary", arguments: { securityList: [] } })
    expect(result.isError).toBe(true)
    expect(mockClient.call).not.toHaveBeenCalled()
  })

  it("gangtise_stock_summary rejects blank-string entries in securityList", async () => {
    const result = await mcpClient.callTool({ name: "gangtise_stock_summary", arguments: { securityList: ["   "] } })
    expect(result.isError).toBe(true)
    expect(mockClient.call).not.toHaveBeenCalled()
  })

  it("gangtise_stock_summary forwards securityList to the stock-summary endpoint", async () => {
    await mcpClient.callTool({ name: "gangtise_stock_summary", arguments: { securityList: ["600519.SH"] } })
    expect(mockClient.call).toHaveBeenCalledWith(
      "ai.stock-summary.list",
      expect.objectContaining({ securityList: ["600519.SH"] }),
    )
  })

  it("gangtise_chiefs_search forwards keyword to the chiefs endpoint", async () => {
    await mcpClient.callTool({ name: "gangtise_chiefs_search", arguments: { keyword: "张三", top: 5 } })
    expect(mockClient.call).toHaveBeenCalledWith(
      "reference.chiefs-search",
      expect.objectContaining({ keyword: "张三", top: 5 }),
    )
  })

  it("gangtise_institution_search forwards keyword and categoryList to the institutions endpoint", async () => {
    await mcpClient.callTool({
      name: "gangtise_institution_search",
      arguments: { keyword: "中金", categoryList: ["domesticBroker"], top: 5 },
    })
    expect(mockClient.call).toHaveBeenCalledWith(
      "reference.institution-search",
      expect.objectContaining({ keyword: "中金", categoryList: ["domesticBroker"], top: 5 }),
    )
  })

  it("gangtise_institution_search rejects an unknown category before calling the API", async () => {
    const result = await mcpClient.callTool({
      name: "gangtise_institution_search",
      arguments: { keyword: "中金", categoryList: ["bogusCategory"] },
    })
    expect(result.isError).toBe(true)
    expect(mockClient.call).not.toHaveBeenCalled()
  })

  it("gangtise_announcement_us_list forwards filters with default size: 20", async () => {
    await mcpClient.callTool({
      name: "gangtise_announcement_us_list",
      arguments: { securityList: ["TSLA.O"], categoryList: ["103980001"] },
    })
    expect(mockClient.call).toHaveBeenCalledWith(
      "insight.announcement-us.list",
      expect.objectContaining({ securityList: ["TSLA.O"], categoryList: ["103980001"], size: 20 }),
    )
  })

  it("gangtise_announcement_hk_download now accepts a fileType query param", async () => {
    ;(mockClient.download as ReturnType<typeof vi.fn>).mockResolvedValue({ text: "ann body", contentType: "text/plain" })
    const result = await mcpClient.callTool({
      name: "gangtise_announcement_hk_download",
      arguments: { announcementId: "ann-1", fileType: 2 },
    })
    expect(result.isError).toBeFalsy()
    const [endpointArg, queryArg] = (mockClient.download as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(endpointArg.key).toBe("insight.announcement-hk.download")
    expect(queryArg).toMatchObject({ announcementId: "ann-1", fileType: 2 })
  })

  it("gangtise_indicator_search rejects an empty keyword before calling the API", async () => {
    const result = await mcpClient.callTool({ name: "gangtise_indicator_search", arguments: { keyword: "" } })
    expect(result.isError).toBe(true)
    expect(mockClient.call).not.toHaveBeenCalled()
  })

  it("gangtise_indicator_cross_section unwraps the inner envelope and flattens to a wide table", async () => {
    vi.mocked(mockClient.call).mockResolvedValueOnce({
      code: "000000",
      status: true,
      data: {
        securityCodeList: ["600519.SH"],
        securityNameList: ["贵州茅台"],
        indicatorList: [{ code: "qte_close", name: "收盘价", dataType: "number" }],
        values: [[1800]],
      },
    })
    const result = await mcpClient.callTool({
      name: "gangtise_indicator_cross_section",
      arguments: { indicatorCodeList: ["qte_close"], securityCodeList: ["600519.SH"], date: "2026-06-26" },
    })
    expect(result.isError).toBeFalsy()
    // 2026-08-01 契约：securityCodeList → universe，根级 date → 每指标 tradeDate。
    expect(mockClient.call).toHaveBeenCalledWith(
      "indicator.cross-section",
      expect.objectContaining({
        indicatorCodeList: ["qte_close"],
        universe: ["600519.SH"],
        indicatorParamList: [{ indicatorCode: "qte_close", parameters: [{ paramKey: "tradeDate", paramValue: "2026-06-26" }] }],
      }),
    )
    const parsed = JSON.parse((result.content as Array<{ text: string }>)[0].text)
    expect(parsed.list[0]).toMatchObject({ security: "600519.SH", name: "贵州茅台", 收盘价: 1800 })
  })

  it("gangtise_indicator_cross_section rejects an empty indicatorCodeList before calling the API", async () => {
    const result = await mcpClient.callTool({
      name: "gangtise_indicator_cross_section",
      arguments: { indicatorCodeList: [], securityCodeList: ["600519.SH"], date: "2026-06-26" },
    })
    expect(result.isError).toBe(true)
    expect(mockClient.call).not.toHaveBeenCalled()
  })

  it("gangtise_indicator_time_series rejects an omitted securityCodeList before calling the API", async () => {
    const result = await mcpClient.callTool({
      name: "gangtise_indicator_time_series",
      arguments: { indicatorCodeList: ["qte_close"], startDate: "2026-06-25", endDate: "2026-06-26" },
    })
    expect(result.isError).toBe(true)
    expect(mockClient.call).not.toHaveBeenCalled()
  })

  it("gangtise_independent_opinion_download forwards independentOpinionId (not opinionId) to the API", async () => {
    ;(mockClient.download as ReturnType<typeof vi.fn>).mockResolvedValue({ text: "opinion html", contentType: "text/html" })
    const result = await mcpClient.callTool({
      name: "gangtise_independent_opinion_download",
      arguments: { independentOpinionId: "9959358", fileType: 1 },
    })
    expect(result.isError).toBeFalsy()
    const [endpointArg, queryArg] = (mockClient.download as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(endpointArg.key).toBe("insight.independent-opinion.download")
    expect(queryArg).toMatchObject({ independentOpinionId: "9959358", fileType: 1 })
  })

  it("gangtise_independent_opinion_download rejects the old opinionId param name", async () => {
    const result = await mcpClient.callTool({
      name: "gangtise_independent_opinion_download",
      arguments: { opinionId: "9959358", fileType: 1 },
    })
    expect(result.isError).toBe(true)
  })

  it("gangtise_one_pager returns a friendly note when the AI content is empty", async () => {
    ;(mockClient.call as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ content: "" })
    const result = await mcpClient.callTool({ name: "gangtise_one_pager", arguments: { securityCode: "600519.SH" } })
    expect(result.isError).toBeFalsy()
    expect((result.content as Array<{ text: string }>)[0].text).toContain("暂无")
  })

  it("keeps server instructions within the 1800-byte budget", () => {
    const instructions = mcpClient.getInstructions() ?? ""
    expect(Buffer.byteLength(instructions, "utf8")).toBeLessThanOrEqual(1_800)
  })

  it("routes with real tool prefixes, not src filenames", async () => {
    const instructions = mcpClient.getInstructions() ?? ""
    // vault / reference 是文件名不是工具名 —— 模型照此检索会扑空
    expect(instructions).not.toContain("vault_")
    expect(instructions).not.toContain("reference_")
    // 真实存在的前缀
    const names = (await mcpClient.listTools()).tools.map((t) => t.name)
    for (const stem of ["drive_", "record_", "my_conference_", "wechat_", "stock_pool_"]) {
      expect(instructions).toContain(stem)
      expect(names.some((n) => n.startsWith(`gangtise_${stem}`))).toBe(true)
    }
  })

  it("makes no unproven universal claims", () => {
    const instructions = mcpClient.getInstructions() ?? ""
    // 只有 theme-tracking 一个端点被证明会发 110003，edb_data 实测反证
    expect(instructions).not.toContain("110003")
    // resourceType=40 证明下载器接受观点资源，「不可下载」是错的
    expect(instructions).not.toContain("不可下载")
  })

  it("routes multi-security financial/valuation batches to EDE", () => {
    const instructions = mcpClient.getInstructions() ?? ""
    // 批量走 EDE 截面/时序（旧文案是「优先专用工具」，不含此完整串 —— 弱断言 "indicator_*(" 在旧码即通过）
    expect(instructions).toContain("indicator_*(EDE) 截面/时序")
    // 计费总则给出批量例外，避免与「优先免费/低价」自相矛盾
    expect(instructions).toContain("除①批量外，优先免费/低价")
  })

  it("declares the billing-label convention that lets free tools stay unlabelled", () => {
    expect(mcpClient.getInstructions() ?? "").toContain("未标注即免费")
  })
})

// 未知入参必须**报错**，不能被静默剥掉。
//
// 非 strict 时 SDK 在进 handler 之前就 strip 掉未声明的键，于是「传了个没人认识的
// 参数」变成一次**没有该筛选条件的正常调用**：isError=false、按条计费、返回全量。
// 而我们发布的 JSON Schema 写的是 additionalProperties:false —— 契约声明拒绝、行为
// 却静默接受。财报日历 2026-08-08 换日期字段名时，沿用旧名的调用方就是这样静默拿到
// 12.8 万行全库切片的。
//
// 这层保护挂在 createGangtiseMcpServer 上（server.ts 的 enforceStrictInput），所以
// **只有集成测试覆盖得到**——各单元测试自己 new McpServer，绕过它。别把这些用例挪走。
describe("strict input schemas", () => {
  const connect = async () => {
    const client = makeMockClient()
    const server = createGangtiseMcpServer(client)
    const [ct, st] = InMemoryTransport.createLinkedPair()
    await server.connect(st)
    const mcp = new Client({ name: "t", version: "0" })
    await mcp.connect(ct)
    return { mcp, client }
  }

  // 三条注册路径各取一个：registerJsonTool / registerDownloadTool / 直接 server.registerTool。
  it.each([
    ["registry-driven", "gangtise_research_list", { keyword: "茅台", bogusKey: "x" }],
    ["download", "gangtise_research_download", { reportId: "1", bogusKey: "x" }],
    ["direct", "gangtise_performance_calendar_list", { bogusKey: "x" }],
    ["direct", "gangtise_indicator_cross_section", { indicatorCodeList: ["qte_close"], securityCodeList: ["600519.SH"], date: "2026-08-07", bogusKey: "x" }],
  ] as Array<[string, string, Record<string, unknown>]>)(
    "%s tool %s rejects an unknown key without spending a call",
    async (_path, name, args) => {
      const { mcp, client } = await connect()
      const result = await mcp.callTool({ name, arguments: args }).catch(() => ({ isError: true }))
      expect((result as { isError?: boolean }).isError).toBe(true)
      expect(client.call).not.toHaveBeenCalled()
      expect(client.download).not.toHaveBeenCalled()
    },
  )

  // 财报日历的旧日期名是这条保护最现实的触发点（服务端 2026-08-08 换了接受的字段名）。
  it("rejects the calendar's superseded startTime/endTime by name", async () => {
    const { mcp, client } = await connect()
    const result = await mcp.callTool({
      name: "gangtise_performance_calendar_list",
      arguments: { startTime: "2026-07-20", endTime: "2026-07-25" },
    }).catch(() => ({ isError: true }))
    expect((result as { isError?: boolean }).isError).toBe(true)
    expect(client.call).not.toHaveBeenCalled()
  })

  // 合法入参必须照常通过——strict 不能误伤。
  it.each([
    ["gangtise_research_list", { keyword: "茅台" }],
    ["gangtise_performance_calendar_list", { startDate: "2026-07-20", endDate: "2026-07-25" }],
  ] as Array<[string, Record<string, unknown>]>)("%s still accepts its declared params", async (name, args) => {
    const { mcp, client } = await connect()
    const result = await mcp.callTool({ name, arguments: args })
    expect(result.isError).toBeFalsy()
    expect(client.call).toHaveBeenCalledTimes(1)
  })
})

// 根级 strict 只管最外层。嵌套对象（indicatorParamList 的元素、screener 的
// indicatorList 元素、parameters 的键值对）也必须拒未知键——把 `parameters` 误写成
// `parameterList` 是很常见的，非 strict 时它被静默剥掉、请求照发，body 里 adjustType
// 整个消失，客户要后复权价却拿到不复权价（与 adjustmentType 写错名同一类静默错数）。
describe("strict nested objects", () => {
  const connect = async () => {
    const client = makeMockClient()
    const server = createGangtiseMcpServer(client)
    const [ct, st] = InMemoryTransport.createLinkedPair()
    await server.connect(st)
    const mcp = new Client({ name: "t", version: "0" })
    await mcp.connect(ct)
    return { mcp, client }
  }
  const CS = { indicatorCodeList: ["qte_close"], securityCodeList: ["600519.SH"], date: "2026-08-07" }
  const SCR = { expression: "F1 > 0", securityCodeList: ["600519.SH"], date: "2026-08-07" }

  it.each([
    ["screener 元素误写 parameterList", "gangtise_indicator_screener", { ...SCR, indicatorList: [{ field: "F1", indicatorCode: "qte_close", parameterList: [{ paramKey: "adjustType", paramValue: "3" }] }] }],
    ["截面元素误写 paramList", "gangtise_indicator_cross_section", { ...CS, indicatorParamList: [{ indicatorCode: "qte_close", paramList: [{ paramKey: "adjustType", paramValue: "3" }] }] }],
    ["键值对多一个键", "gangtise_indicator_cross_section", { ...CS, indicatorParamList: [{ indicatorCode: "qte_close", parameters: [{ paramKey: "adjustType", paramValue: "3", bogus: 1 }] }] }],
  ] as Array<[string, string, Record<string, unknown>]>)("%s is rejected without calling upstream", async (_l, name, args) => {
    const { mcp, client } = await connect()
    const result = await mcp.callTool({ name, arguments: args }).catch(() => ({ isError: true }))
    expect((result as { isError?: boolean }).isError).toBe(true)
    expect(client.call).not.toHaveBeenCalled()
  })

  it("still accepts the correct nested spelling", async () => {
    const { mcp, client } = await connect()
    const result = await mcp.callTool({
      name: "gangtise_indicator_cross_section",
      arguments: { ...CS, indicatorParamList: [{ indicatorCode: "qte_close", parameters: [{ paramKey: "adjustType", paramValue: "3" }] }] },
    })
    expect(client.call).toHaveBeenCalledTimes(1)
    const body = (client.call as ReturnType<typeof vi.fn>).mock.calls[0][1] as Record<string, unknown>
    const groups = body.indicatorParamList as Array<{ parameters: Array<{ paramKey: string }> }>
    expect(groups[0].parameters.map((p) => p.paramKey)).toContain("adjustType")
    // 不断言 isError：mock 返回的不是合法 EDE 矩阵，requireIndicatorMatrix 会拒。
    // 这里要验的是「合法嵌套写法能通过 schema 并把 adjustType 带到 body 里」，上面两条已够。
    void result
  })
})

// 闭集参数的负向测试。上游对非法枚举**静默 no-op 返回未过滤的全量**（A2），
// 所以 schema 层是唯一防线——漏一个字段，客户 agent 就会以为过滤生效、实得全库，
// 且按条计费。
// 当前全部闭集参数（工具名去掉 gangtise_ 前缀）。遍历是自动的，这份快照只负责
// 挡「悄悄退回自由类型」——见文件末尾的集合断言。
const CLOSED_SET_SNAPSHOT = [
    "lookup.type",
    "securities_search.category",
    "institution_search.categoryList",
    "official_account_search.category",
    "constant_list.category",
    "opinion_list.rankType",
    "opinion_list.llmTagList",
    "opinion_list.sourceList",
    "summary_list.searchType",
    "summary_list.rankType",
    "summary_list.categoryList",
    "summary_list.marketList",
    "summary_list.participantRoleList",
    "summary_list.sourceList",
    "pamirs_summary_list.searchType",
    "pamirs_summary_list.rankType",
    "pamirs_summary_list.categoryList",
    "pamirs_summary_list.marketList",
    "roadshow_list.categoryList",
    "roadshow_list.marketList",
    "roadshow_list.participantRoleList",
    "roadshow_list.brokerTypeList",
    "roadshow_list.permission",
    "site_visit_list.objectList",
    "site_visit_list.categoryList",
    "site_visit_list.marketList",
    "site_visit_list.permission",
    "research_list.searchType",
    "research_list.rankType",
    "research_list.categoryList",
    "research_list.llmTagList",
    "research_list.ratingList",
    "research_list.ratingChangeList",
    "research_list.sourceList",
    "foreign_report_list.searchType",
    "foreign_report_list.rankType",
    "foreign_report_list.categoryList",
    "foreign_report_list.llmTagList",
    "foreign_report_list.ratingList",
    "foreign_report_list.ratingChangeList",
    "announcement_list.searchType",
    "announcement_list.rankType",
    "announcement_hk_list.searchType",
    "announcement_hk_list.rankType",
    "announcement_us_list.searchType",
    "announcement_us_list.rankType",
    "foreign_opinion_list.rankType",
    "foreign_opinion_list.ratingList",
    "foreign_opinion_list.ratingChangeList",
    "independent_opinion_list.rankType",
    "independent_opinion_list.ratingList",
    "independent_opinion_list.ratingChangeList",
    "official_account_list.searchType",
    "official_account_list.rankType",
    "official_account_list.categoryList",
    "qa_list.answerImportant",
    "summary_download.fileType",
    "pamirs_summary_download.fileType",
    "research_download.fileType",
    "foreign_report_download.fileType",
    "announcement_download.fileType",
    "announcement_hk_download.fileType",
    "announcement_us_download.fileType",
    "independent_opinion_download.fileType",
    "official_account_download.fileType",
    "performance_calendar_list.marketList",
    "performance_calendar_list.categoryList",
    "income_statement.period",
    "income_statement.reportType",
    "income_statement_quarterly.period",
    "income_statement_quarterly.reportType",
    "balance_sheet.period",
    "balance_sheet.reportType",
    "cash_flow.period",
    "cash_flow.reportType",
    "cash_flow_quarterly.period",
    "cash_flow_quarterly.reportType",
    "main_business.breakdown",
    "main_business.periodList",
    "main_business.fieldList",
    "top_holders.holderType",
    "top_holders.period",
    "earning_forecast.consensusList",
    "income_statement_hk.period",
    "income_statement_hk.reportType",
    "balance_sheet_hk.period",
    "balance_sheet_hk.reportType",
    "cash_flow_hk.period",
    "cash_flow_hk.reportType",
    "income_statement_us.period",
    "income_statement_us.reportType",
    "balance_sheet_us.period",
    "balance_sheet_us.reportType",
    "cash_flow_us.period",
    "cash_flow_us.reportType",
    "valuation_analysis.indicator",
    "valuation_analysis.fieldList",
    "knowledge_batch.resourceTypes",
    "knowledge_batch.knowledgeNames",
    "security_clue_list.queryMode",
    "security_clue_list.source",
    "hot_topic.categoryList",
    "management_discuss_announcement.discussionDimension",
    "management_discuss_earnings_call.discussionDimension",
    "knowledge_resource_download.resourceType",
    "drive_list.fileTypeList",
    "drive_list.spaceTypeList",
    "record_list.categoryList",
    "record_list.spaceTypeList",
    "my_conference_list.categoryList",
    "my_conference_list.sourceList",
    "wechat_message_list.categoryList",
    "wechat_message_list.tagList",
    "record_download.contentType",
    "my_conference_download.contentType",
    "indicator_cross_section.currency",
    "indicator_cross_section.scale",
    "indicator_time_series.calendarType",
    "indicator_time_series.currency",
    "indicator_time_series.scale",
]

describe("closed-set params reject illegal values before calling upstream", () => {
  // **用例由 live schema 自动生成；字段清单由 CLOSED_SET_SNAPSHOT 维护**——
  // 新增和消失都会响亮失败。两者分工不同，别把它当成「全自动、零维护」：
  // 快照仍要手工补行，只是补漏的代价从「悄悄没测」变成了「一条点名的红」。
  //
  // 之所以拆成这两层，是因为手工表连续三轮出现「又漏了 N 个」：先漏数字型闭集，
  // 再漏 helper 生成的字段（scheduleInputSchema 按 fields.* 拼出来的），再漏标量 enum。
  // 根因不是粗心，是「新增闭集参数时记得往表里加一行」这条规则**同时**决定了
  // 「测不测它」和「有没有人知道漏了」——忘一次，两件事一起没了。
  //
  // 拆开之后：遍历 listTools() 的每个闭集参数（数组元素 enum、标量 enum、字面量联合）
  // 逐个断言非法值在**发请求之前**被拒，所以新参数**当场就被测到**，不依赖谁记得；
  // 快照只管另一件事——某个参数从闭集退回自由类型时点名报出来。
  //
  // 每个用例都配**正向对照**（同一组入参、只把被测字段换成合法值 → 必须打通）。
  // 没有它，用例会因为缺必填参数而红、看着绿却根本没测到枚举——本轮之前就漏过两条。
  const enumValuesOf = (v: Record<string, unknown>): unknown[] | undefined => {
    const item = (v.items ?? v) as Record<string, unknown>
    if (Array.isArray(item.enum)) return item.enum
    if (Array.isArray(item.anyOf) && item.anyOf.every((x) => (x as Record<string, unknown>).const !== undefined)) {
      return (item.anyOf as Array<Record<string, unknown>>).map((x) => x.const)
    }
    return undefined
  }
  const isArrayParam = (v: Record<string, unknown>) => v.type === "array"

  // 用 schema 的 required 列表合成一组「除被测字段外完全合法」的入参。
  const fillRequired = (schema: Record<string, unknown>, skip: string) => {
    const props = (schema.properties ?? {}) as Record<string, Record<string, unknown>>
    const required = (schema.required ?? []) as string[]
    const args: Record<string, unknown> = {}
    for (const key of required) {
      if (key === skip) continue
      const v = props[key] ?? {}
      const vals = enumValuesOf(v)
      const one = vals ? vals[0] : /^(reportDate|period)$|报告期/i.test(key) ? "2026-06-30" : /Date$/i.test(key) ? "2026-08-07" : /Time$/i.test(key) ? "2026-08-07 00:00:00"
        : /securityCode|security$/i.test(key) ? "600519.SH" : v.type === "number" || v.type === "integer" ? 1
        : v.type === "boolean" ? false : "1"
      args[key] = isArrayParam(v) ? [one] : one
    }
    return args
  }

  it("rejects an illegal value for every closed-set param, and accepts the legal one", async () => {
    // 复用同一对连接、每例 mockClear。此前每个断言各建一个 server（120 个参数 = 240 个实例），
    // 单文件跑得过、全量并行下超 5s 默认超时——一个只在并行时红的用例比没有更糟。
    const client = makeMockClient()
    const probe = await makeTestClient(client)
    const calls = () =>
      (client.call as ReturnType<typeof vi.fn>).mock.calls.length +
      (client.download as ReturnType<typeof vi.fn>).mock.calls.length
    const reset = () => {
      ;(client.call as ReturnType<typeof vi.fn>).mockClear()
      ;(client.download as ReturnType<typeof vi.fn>).mockClear()
    }
    const invoke = async (name: string, args: Record<string, unknown>) => {
      reset()
      const r = await probe.callTool({ name, arguments: args }).catch(() => ({ isError: true, content: [] }))
      return {
        isError: (r as { isError?: boolean }).isError,
        called: calls(),
        why: String((r as { content?: Array<{ text?: string }> }).content?.[0]?.text ?? "").slice(0, 120),
      }
    }

    const checked: string[] = []
    const skipped: string[] = []
    for (const tool of (await probe.listTools()).tools) {
      const schema = tool.inputSchema as unknown as Record<string, unknown>
      const props = (schema.properties ?? {}) as Record<string, Record<string, unknown>>
      for (const [key, spec] of Object.entries(props)) {
        const vals = enumValuesOf(spec)
        if (!vals || vals.length === 0) continue
        const base = fillRequired(schema, key)
        const wrap = (v: unknown) => (isArrayParam(spec) ? [v] : v)

        // ② 正向对照先跑：换成合法值必须打通。打不通说明这条用例的「红」另有原因
        //    （多半是必填参数没合成对），那它就证明不了枚举——记为 skipped 而不是假绿。
        const good = await invoke(tool.name, { ...base, [key]: wrap(vals[0]) })
        if (good.isError) { skipped.push(`${tool.name}.${key} :: ${good.why}`); continue }

        // ① 非法值必须在发请求之前被拒
        const bad = await invoke(tool.name, { ...base, [key]: wrap(typeof vals[0] === "number" ? 987654 : "__bogus__") })
        expect(bad.isError, `${tool.name}.${key}：非法值应被拒`).toBe(true)
        expect(bad.called, `${tool.name}.${key}：非法值不得调用上游`).toBe(0)
        checked.push(`${tool.name}.${key}`)
      }
    }

    // 一个都不许跳过。跳过 = 正向对照没打通 = 这条用例的「红」另有原因，证明不了枚举。
    // 故意做成硬失败而不是 warn：新工具带来合成不了的必填参数时，要么补合成规则、
    // 要么补 mock 形状，不能让覆盖率悄悄掉下去——本条断言存在的全部理由就是这个。
    expect(skipped, "正向对照未通过（补 fillRequired 规则或 makeMockClient 形状）").toEqual([])
    // 另一个方向：某个参数从闭集退回自由类型（z.enum → z.string）后会直接从遍历结果里
    // **消失**，skipped 仍是空、用例照绿。计数下限挡不住这个——退一个同时加一个，数还是平的。
    // 所以钉的是集合本身：少了哪个、多了哪个，diff 直接把名字报出来。
    // 新增闭集参数要往 CLOSED_SET_SNAPSHOT 补一行——但那是**响亮的红**，
    // 跟手工表时代「忘了加 = 悄悄没测」是两回事。
    const now = checked.map((x) => x.replace(/^gangtise_/, ""))
    expect(
      CLOSED_SET_SNAPSHOT.filter((x) => !now.includes(x)),
      "闭集参数消失了——多半是 z.enum 退回了 z.string，非法值将被原样透传给上游",
    ).toEqual([])
    expect(
      now.filter((x) => !CLOSED_SET_SNAPSHOT.includes(x)),
      "新增了闭集参数（已自动测到），补进 CLOSED_SET_SNAPSHOT 即可",
    ).toEqual([])
  })
})
