import { describe, it, expect, vi } from "vitest"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { registerFundamentalTools } from "../../../src/tools/fundamental.js"
import type { GangtiseClient } from "../../../src/core/client.js"

function makeClient() {
  const call = vi.fn(async () => ({ list: [], total: 0 }))
  return { call, download: vi.fn() } as unknown as GangtiseClient
}

async function connect(client: GangtiseClient) {
  const server = new McpServer({ name: "test", version: "0.0.0" })
  registerFundamentalTools(server, client)
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  const mcp = new Client({ name: "test", version: "0.0.1" })
  await mcp.connect(clientTransport)
  return mcp
}

const base = { securityCode: "600519.SH", indicator: "peTtm" }

describe("gangtise_valuation_analysis schema", () => {
  it("rejects a non-positive limit without calling the API", async () => {
    const client = makeClient()
    const mcp = await connect(client)
    const result = await mcp.callTool({ name: "gangtise_valuation_analysis", arguments: { ...base, limit: 0 } })
    expect(result.isError).toBe(true)
    expect(client.call).not.toHaveBeenCalled()
  })

  it("accepts a positive limit and calls the API", async () => {
    const client = makeClient()
    const mcp = await connect(client)
    const result = await mcp.callTool({ name: "gangtise_valuation_analysis", arguments: { ...base, limit: 100 } })
    expect(result.isError).toBeFalsy()
    expect(client.call).toHaveBeenCalledTimes(1)
  })
})
