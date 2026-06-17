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

  it("marks every tool read-only via MCP annotations", async () => {
    const { tools } = await mcpClient.listTools()
    const missing = tools.filter(t => t.annotations?.readOnlyHint !== true).map(t => t.name)
    expect(missing).toEqual([])
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
    expect((result.content as Array<{ text: string }>)[0].text).toContain("格式无效")
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
})
