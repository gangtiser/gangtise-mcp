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

// An .HK code sent to the A-share tool used to reach upstream and return a silent
// empty list — indistinguishable from "no data". The precheck rejects the clear
// mismatch and names the right tool, without spending an API call.
describe("gangtise_day_kline market-mismatch precheck", () => {
  it("rejects an HK code on the A-share tool, points at the right tool, no API call", async () => {
    const client = makeMockClient()
    const mcp = await connect(client)
    const result = await mcp.callTool({
      name: "gangtise_day_kline",
      arguments: { security: "00700.HK", startDate: "2026-04-01", endDate: "2026-04-30" },
    })
    expect(result.isError).toBe(true)
    expect((result.content as Array<{ text: string }>)[0].text).toContain("gangtise_day_kline_hk")
    expect(client.call).not.toHaveBeenCalled()
  })

  it("rejects an A-share code on the US tool, no API call", async () => {
    const client = makeMockClient()
    const mcp = await connect(client)
    const result = await mcp.callTool({
      name: "gangtise_day_kline_us",
      arguments: { security: "600519.SH", startDate: "2026-04-01", endDate: "2026-04-30" },
    })
    expect(result.isError).toBe(true)
    expect(client.call).not.toHaveBeenCalled()
  })

  it("passes a matching code and an unknown suffix through to the API", async () => {
    const client = makeMockClient()
    const mcp = await connect(client)
    const ok = await mcp.callTool({
      name: "gangtise_day_kline_hk",
      arguments: { security: "00700.HK", startDate: "2026-04-01", endDate: "2026-04-30" },
    })
    const unknown = await mcp.callTool({
      name: "gangtise_day_kline",
      arguments: { security: "600519.XYZ", startDate: "2026-04-01", endDate: "2026-04-30" },
    })
    expect(ok.isError).toBeFalsy()
    expect(unknown.isError).toBeFalsy()
    expect(client.call).toHaveBeenCalledTimes(2)
  })

  it("rejects mixing 'all' with a specific code before calling the API", async () => {
    const client = makeMockClient()
    const mcp = await connect(client)
    const result = await mcp.callTool({
      name: "gangtise_day_kline",
      arguments: { security: ["all", "600519.SH"], startDate: "2026-04-01", endDate: "2026-04-30" },
    })
    expect(result.isError).toBe(true)
    expect((result.content as Array<{ text: string }>)[0].text).toContain("不能混用")
    expect(client.call).not.toHaveBeenCalled()
  })

  it("skips the check for security='all' and for the index tool", async () => {
    const client = makeMockClient()
    const mcp = await connect(client)
    const all = await mcp.callTool({
      name: "gangtise_day_kline",
      arguments: { security: "all", startDate: "2026-04-01" },
    })
    const idx = await mcp.callTool({
      name: "gangtise_index_day_kline",
      arguments: { security: "000001.SH", startDate: "2026-04-01", endDate: "2026-04-30" },
    })
    expect(all.isError).toBeFalsy()
    expect(idx.isError).toBeFalsy()
  })
})

// The K-line/realtime param is fieldList (aligned with the fundamental tools and
// the upstream body key). It used to be `field`, so a caller passing `fieldList`
// (the natural habit) had it silently dropped by zod strip → unfiltered data.
describe("gangtise_day_kline fieldList param", () => {
  it("forwards fieldList to the API body", async () => {
    const client = makeMockClient()
    const mcp = await connect(client)
    await mcp.callTool({
      name: "gangtise_day_kline",
      arguments: { security: "600519.SH", startDate: "2026-04-01", endDate: "2026-04-30", fieldList: ["open", "close"] },
    })
    const body = (client.call as ReturnType<typeof vi.fn>).mock.calls[0][1] as Record<string, unknown>
    expect(body.fieldList).toEqual(["open", "close"])
  })
})

// fund-flow (v0.23): A-share daily fund flow. Single/explicit securities are a
// plain request; the 'aShares' full-market sentinel day-shards like security='all'
// but requires an explicit date range (upstream errors rather than truncating).
describe("gangtise_fund_flow", () => {
  it("forwards a single security to quote.fund-flow without sharding", async () => {
    const client = makeMockClient()
    const mcp = await connect(client)
    await mcp.callTool({
      name: "gangtise_fund_flow",
      arguments: { security: "600519.SH", startDate: "2026-04-01", endDate: "2026-04-30", fieldList: ["mainNetInflow"] },
    })
    expect(client.call).toHaveBeenCalledTimes(1)
    const [key, body] = (client.call as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(key).toBe("quote.fund-flow")
    expect(body).toMatchObject({ securityList: ["600519.SH"], startDate: "2026-04-01", endDate: "2026-04-30", fieldList: ["mainNetInflow"] })
  })

  it("rejects aShares full-market without both dates, no API call", async () => {
    const client = makeMockClient()
    const mcp = await connect(client)
    const result = await mcp.callTool({
      name: "gangtise_fund_flow",
      arguments: { security: "aShares", startDate: "2026-04-01" },
    })
    expect(result.isError).toBe(true)
    expect(client.call).not.toHaveBeenCalled()
  })

  it("rejects a non-A-share code (fund flow is 沪深北 only), no API call", async () => {
    const client = makeMockClient()
    const mcp = await connect(client)
    const result = await mcp.callTool({
      name: "gangtise_fund_flow",
      arguments: { security: "00700.HK", startDate: "2026-04-01", endDate: "2026-04-30" },
    })
    expect(result.isError).toBe(true)
    expect((result.content as Array<{ text: string }>)[0].text).toContain("A 股")
    expect(client.call).not.toHaveBeenCalled()
  })

  it("pins the default 6000 limit in the request body (exact truncation detection)", async () => {
    const client = makeMockClient()
    const mcp = await connect(client)
    await mcp.callTool({ name: "gangtise_fund_flow", arguments: { security: "600519.SH" } })
    const body = (client.call as ReturnType<typeof vi.fn>).mock.calls[0][1] as Record<string, unknown>
    expect(body.limit).toBe(6000)
  })

  it("rejects mixing 'aShares' with a specific code before calling the API", async () => {
    const client = makeMockClient()
    const mcp = await connect(client)
    const result = await mcp.callTool({
      name: "gangtise_fund_flow",
      arguments: { security: ["aShares", "600519.SH"], startDate: "2026-04-01", endDate: "2026-04-30" },
    })
    expect(result.isError).toBe(true)
    expect(client.call).not.toHaveBeenCalled()
  })

  it("day-shards a multi-day aShares full-market range", async () => {
    const client = {
      call: vi.fn().mockResolvedValue({ list: [{ x: 1 }], total: 1 }),
      download: vi.fn(),
    } as unknown as GangtiseClient
    const mcp = await connect(client)
    const result = await mcp.callTool({
      name: "gangtise_fund_flow",
      arguments: { security: "aShares", startDate: "2026-04-01", endDate: "2026-04-03" },
    })
    expect(result.isError).toBeFalsy()
    expect(client.call).toHaveBeenCalledTimes(3) // 3 one-day shards
    const parsed = JSON.parse((result.content as Array<{ text: string }>)[0].text)
    expect((parsed.list as unknown[]).length).toBe(3)
  })

  it("flags _partial when a single request returns rows up to the limit", async () => {
    const rows = Array.from({ length: 10 }, (_, i) => ({ i }))
    const client = { call: vi.fn().mockResolvedValue({ list: rows }), download: vi.fn() } as unknown as GangtiseClient
    const mcp = await connect(client)
    const result = await mcp.callTool({
      name: "gangtise_fund_flow",
      arguments: { security: "600519.SH", limit: 10 },
    })
    const parsed = JSON.parse((result.content as Array<{ text: string }>)[0].text)
    expect(parsed._partial).toBe(true)
    expect(parsed._partial_reason).toBe("limit_truncated")
  })
})

// v0.23: single-request (non-sharded) quote endpoints flag _partial when the row
// count reaches the per-request limit, so a silent head-of-window truncation
// (default cap 6000) can't read as a complete result. The security='all' sharded
// path carries its own per-shard markers and is unaffected.
describe("gangtise quote limit-truncation marker", () => {
  it("flags _partial when day-kline returns rows up to the explicit limit", async () => {
    const rows = Array.from({ length: 3 }, (_, i) => ({ i }))
    const client = { call: vi.fn().mockResolvedValue({ list: rows }), download: vi.fn() } as unknown as GangtiseClient
    const mcp = await connect(client)
    const result = await mcp.callTool({
      name: "gangtise_day_kline",
      arguments: { security: "600519.SH", startDate: "2026-04-01", endDate: "2026-04-30", limit: 3 },
    })
    const parsed = JSON.parse((result.content as Array<{ text: string }>)[0].text)
    expect(parsed._partial).toBe(true)
    expect(parsed._partial_reason).toBe("limit_truncated")
  })

  it("does not flag when day-kline returns fewer rows than the default 6000 cap", async () => {
    const rows = Array.from({ length: 5 }, (_, i) => ({ i }))
    const client = { call: vi.fn().mockResolvedValue({ list: rows }), download: vi.fn() } as unknown as GangtiseClient
    const mcp = await connect(client)
    const result = await mcp.callTool({
      name: "gangtise_day_kline",
      arguments: { security: "600519.SH", startDate: "2026-04-01", endDate: "2026-04-30" },
    })
    const parsed = JSON.parse((result.content as Array<{ text: string }>)[0].text)
    expect(parsed._partial).toBeUndefined()
  })

  it("pins the default 6000 limit in the explicit-security day-kline body", async () => {
    const client = { call: vi.fn().mockResolvedValue({ list: [] }), download: vi.fn() } as unknown as GangtiseClient
    const mcp = await connect(client)
    await mcp.callTool({
      name: "gangtise_day_kline",
      arguments: { security: "600519.SH", startDate: "2026-04-01", endDate: "2026-04-30" },
    })
    const body = (client.call as ReturnType<typeof vi.fn>).mock.calls[0][1] as Record<string, unknown>
    expect(body.limit).toBe(6000)
  })

  it("flags _partial when minute-kline returns rows up to the explicit limit", async () => {
    const rows = Array.from({ length: 2 }, (_, i) => ({ i }))
    const client = { call: vi.fn().mockResolvedValue({ list: rows }), download: vi.fn() } as unknown as GangtiseClient
    const mcp = await connect(client)
    const result = await mcp.callTool({
      name: "gangtise_minute_kline",
      arguments: { security: "600519.SH", limit: 2 },
    })
    const parsed = JSON.parse((result.content as Array<{ text: string }>)[0].text)
    expect(parsed._partial).toBe(true)
    expect(parsed._partial_reason).toBe("limit_truncated")
  })
})
