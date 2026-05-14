import { describe, it, expect, vi, beforeEach } from "vitest"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { createGangtiseMcpServer } from "../../src/server.js"
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

  it("lists all registered tools", async () => {
    const { tools } = await mcpClient.listTools()
    const names = tools.map(t => t.name)

    expect(names).toContain("gangtise_lookup")
    expect(names).toContain("gangtise_securities_search")
    expect(names).toContain("gangtise_opinion_list")
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

    // Should have a substantial number of tools
    expect(tools.length).toBeGreaterThan(40)
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

  it("tools return isError on API failure", async () => {
    vi.mocked(mockClient.call).mockRejectedValueOnce(new Error("network error"))
    const result = await mcpClient.callTool({ name: "gangtise_opinion_list", arguments: {} })
    expect(result.isError).toBe(true)
    expect((result.content as Array<{ text: string }>)[0].text).toContain("network error")
  })
})
