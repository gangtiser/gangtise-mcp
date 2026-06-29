import { describe, it, expect, vi } from "vitest"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { registerIndicatorTools } from "../../../src/tools/indicator.js"
import type { GangtiseClient } from "../../../src/core/client.js"

function makeMockClient() {
  return {
    // inner { code, status, data } envelope — unwrapIndicatorData peels it
    call: vi.fn().mockResolvedValue({ code: "000000", status: true, data: { list: [] } }),
    download: vi.fn(),
  } as unknown as GangtiseClient
}

async function connect(client: GangtiseClient) {
  const server = new McpServer({ name: "test", version: "0.0.0" })
  registerIndicatorTools(server, client)
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  const mcp = new Client({ name: "test", version: "0.0.1" })
  await mcp.connect(clientTransport)
  return mcp
}

// Time-series flattening assumes exactly one dimension varies. With both >1 the
// matrix is ambiguous and flattenTimeSeries silently drops the indicator
// dimension. Reject the request before it reaches the API.
describe("gangtise_indicator_time_series dimension guard", () => {
  it("rejects multi-indicator × multi-security without calling the API", async () => {
    const client = makeMockClient()
    const mcp = await connect(client)
    const result = await mcp.callTool({
      name: "gangtise_indicator_time_series",
      arguments: {
        indicatorCodeList: ["qte_close", "qte_open"],
        securityCodeList: ["600519.SH", "000001.SZ"],
        startDate: "2026-06-01",
        endDate: "2026-06-30",
      },
    })
    expect(result.isError).toBe(true)
    expect(client.call).not.toHaveBeenCalled()
  })

  it("allows multi-indicator × single-security", async () => {
    const client = makeMockClient()
    const mcp = await connect(client)
    const result = await mcp.callTool({
      name: "gangtise_indicator_time_series",
      arguments: {
        indicatorCodeList: ["qte_close", "qte_open"],
        securityCodeList: ["600519.SH"],
        startDate: "2026-06-01",
        endDate: "2026-06-30",
      },
    })
    expect(result.isError).toBeFalsy()
    expect(client.call).toHaveBeenCalledTimes(1)
  })

  it("allows single-indicator × multi-security", async () => {
    const client = makeMockClient()
    const mcp = await connect(client)
    const result = await mcp.callTool({
      name: "gangtise_indicator_time_series",
      arguments: {
        indicatorCodeList: ["qte_close"],
        securityCodeList: ["600519.SH", "000001.SZ"],
        startDate: "2026-06-01",
        endDate: "2026-06-30",
      },
    })
    expect(result.isError).toBeFalsy()
    expect(client.call).toHaveBeenCalledTimes(1)
  })
})
