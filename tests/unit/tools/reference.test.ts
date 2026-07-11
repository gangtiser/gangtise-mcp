import { describe, it, expect, vi } from "vitest"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { registerReferenceTools } from "../../../src/tools/reference.js"
import type { GangtiseClient } from "../../../src/core/client.js"

function makeClient() {
  return { call: vi.fn().mockResolvedValue({ list: [] }), download: vi.fn() } as unknown as GangtiseClient
}

async function connect(client: GangtiseClient) {
  const server = new McpServer({ name: "test", version: "0.0.0" })
  registerReferenceTools(server, client)
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  const mcp = new Client({ name: "test", version: "0.0.1" })
  await mcp.connect(clientTransport)
  return mcp
}

describe("gangtise_official_account_search", () => {
  it("passes keyword/category/top through to reference.official-account-search", async () => {
    const client = makeClient()
    const mcp = await connect(client)
    const result = await mcp.callTool({
      name: "gangtise_official_account_search",
      arguments: { keyword: "中信证券", category: ["broker", "media"], top: 10 },
    })
    expect(result.isError).toBeFalsy()
    expect(client.call).toHaveBeenCalledWith("reference.official-account-search", expect.objectContaining({
      keyword: "中信证券",
      category: ["broker", "media"],
      top: 10,
    }))
  })

  // The server silently ignores or empty-returns on a typo'd category — reject
  // locally so a spelling mistake can't masquerade as "no results".
  it("rejects an unknown category locally without calling the API", async () => {
    const client = makeClient()
    const mcp = await connect(client)
    const result = await mcp.callTool({
      name: "gangtise_official_account_search",
      arguments: { keyword: "中信证券", category: ["Broker"] },
    })
    expect(result.isError).toBe(true)
    expect(client.call).not.toHaveBeenCalled()
  })

  it("rejects top above the server cap of 10 (silently truncated upstream)", async () => {
    const client = makeClient()
    const mcp = await connect(client)
    const result = await mcp.callTool({
      name: "gangtise_official_account_search",
      arguments: { keyword: "中信证券", top: 11 },
    })
    expect(result.isError).toBe(true)
    expect(client.call).not.toHaveBeenCalled()
  })
})
