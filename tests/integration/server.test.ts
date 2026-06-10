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
    const types = [
      "research-areas", "broker-orgs", "meeting-orgs", "industries",
      "regions", "announcement-categories", "industry-codes", "theme-ids",
    ]
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

  it("tools return isError on API failure", async () => {
    vi.mocked(mockClient.call).mockRejectedValueOnce(new Error("network error"))
    const result = await mcpClient.callTool({ name: "gangtise_opinion_list", arguments: {} })
    expect(result.isError).toBe(true)
    expect((result.content as Array<{ text: string }>)[0].text).toContain("network error")
  })
})
