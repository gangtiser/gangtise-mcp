import { describe, it, expect, vi } from "vitest"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { registerInsightTools } from "../../../src/tools/insight.js"
import type { GangtiseClient } from "../../../src/core/client.js"

function makeClient() {
  const download = vi.fn(async () => ({ text: "ok", contentType: "text/plain" }))
  return { call: vi.fn(), download } as unknown as GangtiseClient
}

async function connect(client: GangtiseClient) {
  const server = new McpServer({ name: "test", version: "0.0.0" })
  registerInsightTools(server, client)
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  const mcp = new Client({ name: "test", version: "0.0.1" })
  await mcp.connect(clientTransport)
  return mcp
}

describe("insight download schemas", () => {
  it("rejects a blank reportId without downloading", async () => {
    const client = makeClient()
    const mcp = await connect(client)
    const result = await mcp.callTool({ name: "gangtise_research_download", arguments: { reportId: "" } })
    expect(result.isError).toBe(true)
    expect(client.download).not.toHaveBeenCalled()
  })

  it("rejects an out-of-set fileType without downloading", async () => {
    const client = makeClient()
    const mcp = await connect(client)
    const result = await mcp.callTool({ name: "gangtise_research_download", arguments: { reportId: "r1", fileType: 999 } })
    expect(result.isError).toBe(true)
    expect(client.download).not.toHaveBeenCalled()
  })

  it("accepts a valid reportId + fileType and downloads", async () => {
    const client = makeClient()
    const mcp = await connect(client)
    const result = await mcp.callTool({ name: "gangtise_research_download", arguments: { reportId: "r1", fileType: 2 } })
    expect(result.isError).toBeFalsy()
    expect(client.download).toHaveBeenCalledTimes(1)
  })
})
