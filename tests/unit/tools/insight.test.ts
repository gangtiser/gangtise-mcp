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

describe("gangtise_qa_list", () => {
  it("passes filters through to insight.qa.list", async () => {
    const client = makeClient()
    ;(client.call as ReturnType<typeof vi.fn>).mockResolvedValue({ list: [], total: 0 })
    const mcp = await connect(client)
    const result = await mcp.callTool({
      name: "gangtise_qa_list",
      arguments: {
        securityCode: "601012.SH",
        source: ["conference", "interactive"],
        questionCategory: ["financialData"],
        answerImportant: [1],
        startTime: "2026-06-01",
        endTime: "2026-07-01 23:59:59",
      },
    })
    expect(result.isError).toBeFalsy()
    expect(client.call).toHaveBeenCalledWith("insight.qa.list", expect.objectContaining({
      securityCode: "601012.SH",
      source: ["conference", "interactive"],
      questionCategory: ["financialData"],
      answerImportant: [1],
      startTime: "2026-06-01",
      endTime: "2026-07-01 23:59:59",
    }))
  })

  it("rejects a blank securityCode without calling the API", async () => {
    const client = makeClient()
    const mcp = await connect(client)
    const result = await mcp.callTool({ name: "gangtise_qa_list", arguments: { securityCode: "  " } })
    expect(result.isError).toBe(true)
    expect(client.call).not.toHaveBeenCalled()
  })

  it("rejects an out-of-set answerImportant flag without calling the API", async () => {
    const client = makeClient()
    const mcp = await connect(client)
    const result = await mcp.callTool({ name: "gangtise_qa_list", arguments: { securityCode: "601012.SH", answerImportant: [2] } })
    expect(result.isError).toBe(true)
    expect(client.call).not.toHaveBeenCalled()
  })
})

describe("gangtise_report_image_list", () => {
  it("passes search args through to insight.report-image.list", async () => {
    const client = makeClient()
    ;(client.call as ReturnType<typeof vi.fn>).mockResolvedValue({ list: [] })
    const mcp = await connect(client)
    const result = await mcp.callTool({ name: "gangtise_report_image_list", arguments: { keyword: "AI", top: 20 } })
    expect(result.isError).toBeFalsy()
    expect(client.call).toHaveBeenCalledWith("insight.report-image.list", expect.objectContaining({ keyword: "AI", top: 20 }))
  })

  it("rejects top above the server cap of 20 (silently truncated upstream)", async () => {
    const client = makeClient()
    const mcp = await connect(client)
    const result = await mcp.callTool({ name: "gangtise_report_image_list", arguments: { keyword: "AI", top: 21 } })
    expect(result.isError).toBe(true)
    expect(client.call).not.toHaveBeenCalled()
  })
})

describe("gangtise_report_image_download", () => {
  it("rejects a blank chunkId without downloading", async () => {
    const client = makeClient()
    const mcp = await connect(client)
    const result = await mcp.callTool({ name: "gangtise_report_image_download", arguments: { chunkId: " " } })
    expect(result.isError).toBe(true)
    expect(client.download).not.toHaveBeenCalled()
  })

  it("downloads by chunkId", async () => {
    const client = makeClient()
    const mcp = await connect(client)
    const result = await mcp.callTool({ name: "gangtise_report_image_download", arguments: { chunkId: "c1" } })
    expect(result.isError).toBeFalsy()
    expect(client.download).toHaveBeenCalledTimes(1)
  })
})

describe("gangtise_report_image_list sourceId", () => {
  it("rejects a blank sourceId without calling the API", async () => {
    const client = makeClient()
    const mcp = await connect(client)
    const result = await mcp.callTool({ name: "gangtise_report_image_list", arguments: { keyword: "AI", sourceId: " " } })
    expect(result.isError).toBe(true)
    expect(client.call).not.toHaveBeenCalled()
  })
})
