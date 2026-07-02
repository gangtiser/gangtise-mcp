import { describe, it, expect, vi } from "vitest"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { registerQuoteTools } from "../../../src/tools/quote.js"
import type { GangtiseClient } from "../../../src/core/client.js"

function makeMockClient() {
  return {
    call: vi.fn().mockResolvedValue({ list: [] }),
    download: vi.fn(),
  } as unknown as GangtiseClient
}

async function connect(client: GangtiseClient) {
  const server = new McpServer({ name: "test", version: "0.0.0" })
  registerQuoteTools(server, client)
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  const mcp = new Client({ name: "test", version: "0.0.1" })
  await mcp.connect(clientTransport)
  return mcp
}

// A malformed date used to slip past the bare z.string() schema, then fail
// parseDate() inside quoteSharding, which silently fell back to a single capped
// request for security='all' — losing market rows with no _partial marker.
describe("gangtise_day_kline date validation", () => {
  it("rejects a non-zero-padded date for security='all' without calling the API", async () => {
    const client = makeMockClient()
    const mcp = await connect(client)
    const result = await mcp.callTool({
      name: "gangtise_day_kline",
      arguments: { security: "all", startDate: "2026-4-1", endDate: "2026-04-30" },
    })
    expect(result.isError).toBe(true)
    expect(client.call).not.toHaveBeenCalled()
  })

  it("rejects a regex-passing but invalid calendar date (month 13) without calling the API", async () => {
    const client = makeMockClient()
    const mcp = await connect(client)
    const result = await mcp.callTool({
      name: "gangtise_day_kline",
      arguments: { security: "all", startDate: "2026-13-45", endDate: "2026-12-31" },
    })
    expect(result.isError).toBe(true)
    expect(client.call).not.toHaveBeenCalled()
  })

  // JS Date silently rolls these over (2026-02-30 -> 2026-03-02), so a bare
  // !isNaN check passes them and security='all' sharding queries the wrong date.
  it("rejects a calendar-impossible day (Feb 30) that JS Date would roll over", async () => {
    const client = makeMockClient()
    const mcp = await connect(client)
    const result = await mcp.callTool({
      name: "gangtise_day_kline",
      arguments: { security: "all", startDate: "2026-02-30", endDate: "2026-12-31" },
    })
    expect(result.isError).toBe(true)
    expect(client.call).not.toHaveBeenCalled()
  })

  it("rejects the 31st of a 30-day month (Apr 31)", async () => {
    const client = makeMockClient()
    const mcp = await connect(client)
    const result = await mcp.callTool({
      name: "gangtise_day_kline",
      arguments: { security: "all", startDate: "2026-04-31", endDate: "2026-12-31" },
    })
    expect(result.isError).toBe(true)
    expect(client.call).not.toHaveBeenCalled()
  })

  // security='all' with only one date can't shard, but must still go through
  // the sharding helper so the 10000-row limit lift applies — otherwise the
  // raw body is sent and upstream silently truncates at its 6000 default.
  it("lifts the limit for security='all' when endDate is omitted", async () => {
    const client = makeMockClient()
    const mcp = await connect(client)
    const result = await mcp.callTool({
      name: "gangtise_day_kline",
      arguments: { security: "all", startDate: "2026-04-01" },
    })
    expect(result.isError).toBeFalsy()
    expect(client.call).toHaveBeenCalledTimes(1)
    const body = (client.call as ReturnType<typeof vi.fn>).mock.calls[0][1] as Record<string, unknown>
    expect(body.limit).toBe(10_000)
  })

  it("accepts a leap-day (2024-02-29) and calls the API", async () => {
    const client = makeMockClient()
    const mcp = await connect(client)
    const result = await mcp.callTool({
      name: "gangtise_day_kline",
      arguments: { security: "600519.SH", startDate: "2024-02-29", endDate: "2024-03-31" },
    })
    expect(result.isError).toBeFalsy()
    expect(client.call).toHaveBeenCalledTimes(1)
  })

  it("accepts a well-formed date and calls the API", async () => {
    const client = makeMockClient()
    const mcp = await connect(client)
    const result = await mcp.callTool({
      name: "gangtise_day_kline",
      arguments: { security: "600519.SH", startDate: "2026-04-01", endDate: "2026-04-30" },
    })
    expect(result.isError).toBeFalsy()
    expect(client.call).toHaveBeenCalledTimes(1)
  })
})
