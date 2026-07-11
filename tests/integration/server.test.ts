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
      return { list: [{ id: "test-id" }], total: 1 }
    }),
    download: vi.fn(),
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
        date: "2026-06-26",
        securityCodeList: ["600519.SH"],
        securityNameList: ["贵州茅台"],
        indicatorCodeList: ["qte_close"],
        indicatorNameList: ["收盘价"],
        values: [[1800]],
      },
    })
    const result = await mcpClient.callTool({
      name: "gangtise_indicator_cross_section",
      arguments: { indicatorCodeList: ["qte_close"], securityCodeList: ["600519.SH"], date: "2026-06-26" },
    })
    expect(result.isError).toBeFalsy()
    expect(mockClient.call).toHaveBeenCalledWith(
      "indicator.cross-section",
      expect.objectContaining({ indicatorCodeList: ["qte_close"], securityCodeList: ["600519.SH"], date: "2026-06-26" }),
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
})
