import { describe, it, expect, vi, beforeEach } from "vitest"
import { z } from "zod"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { registerJsonTool, registerDownloadTool, sanitizeArgs } from "../../../src/tools/registry.js"
import type { GangtiseClient } from "../../../src/core/client.js"

function makeMockClient(responseData: unknown = { list: [{ id: "1" }], total: 1 }) {
  return {
    call: vi.fn().mockResolvedValue(responseData),
    download: vi.fn(),
  } as unknown as GangtiseClient
}

async function makeConnectedPair(server: McpServer) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  const client = new Client({ name: "test", version: "0.0.1" })
  await client.connect(clientTransport)
  return client
}

describe("sanitizeArgs", () => {
  it("removes fetchAll from body", () => {
    const result = sanitizeArgs({ fetchAll: true, keyword: "test" }, { paginated: true, fetchAll: true })
    expect(result).not.toHaveProperty("fetchAll")
    expect(result).toHaveProperty("keyword", "test")
  })

  it("adds size: 20 for paginated endpoints when size omitted", () => {
    const result = sanitizeArgs({ keyword: "test" }, { paginated: true, fetchAll: false })
    expect(result).toHaveProperty("size", 20)
  })

  it("does not add size for non-paginated endpoints", () => {
    const result = sanitizeArgs({ securityCode: "600519.SH" }, { paginated: false })
    expect(result).not.toHaveProperty("size")
  })

  it("removes size when fetchAll is true", () => {
    const result = sanitizeArgs({ size: 50 }, { paginated: true, fetchAll: true })
    expect(result).not.toHaveProperty("size")
  })

  it("respects explicit size when not fetchAll", () => {
    const result = sanitizeArgs({ size: 100 }, { paginated: true, fetchAll: false })
    expect(result).toHaveProperty("size", 100)
  })
})

describe("registerJsonTool", () => {
  it("returns normalized JSON for list response", async () => {
    const mockClient = makeMockClient({ list: [{ id: "abc", name: "test" }], total: 1 })
    const server = new McpServer({ name: "test", version: "0.0.0" })
    registerJsonTool(server, mockClient, {
      name: "test_tool",
      description: "Test tool",
      endpointKey: "insight.opinion.list",
      paginated: true,
      inputSchema: { keyword: z.string().optional() },
    })
    const mcpClient = await makeConnectedPair(server)
    const result = await mcpClient.callTool({ name: "test_tool", arguments: { keyword: "foo" } })
    expect(result.isError).toBeFalsy()
    const parsed = JSON.parse((result.content as Array<{ text: string }>)[0].text)
    expect(parsed).toHaveProperty("list")
    expect(parsed).toHaveProperty("total", 1)
  })

  it("passes size: 20 default for paginated endpoint", async () => {
    const mockClient = makeMockClient()
    const server = new McpServer({ name: "test", version: "0.0.0" })
    registerJsonTool(server, mockClient, {
      name: "test_paginated",
      description: "Test",
      endpointKey: "insight.opinion.list",
      paginated: true,
      inputSchema: {},
    })
    const mcpClient = await makeConnectedPair(server)
    await mcpClient.callTool({ name: "test_paginated", arguments: {} })
    expect(mockClient.call).toHaveBeenCalledWith(
      "insight.opinion.list",
      expect.objectContaining({ size: 20 }),
    )
  })

  it("does not pass size for non-paginated endpoint", async () => {
    const mockClient = makeMockClient({ securityCode: "600519.SH" })
    const server = new McpServer({ name: "test", version: "0.0.0" })
    registerJsonTool(server, mockClient, {
      name: "test_nonpaginated",
      description: "Test",
      endpointKey: "ai.one-pager",
      paginated: false,
      inputSchema: { securityCode: z.string() },
    })
    const mcpClient = await makeConnectedPair(server)
    await mcpClient.callTool({ name: "test_nonpaginated", arguments: { securityCode: "600519.SH" } })
    const callArg = (mockClient.call as ReturnType<typeof vi.fn>).mock.calls[0][1] as Record<string, unknown>
    expect(callArg).not.toHaveProperty("size")
  })

  it("returns isError: true on API failure", async () => {
    const mockClient = {
      call: vi.fn().mockRejectedValue(new Error("API down")),
    } as unknown as GangtiseClient
    const server = new McpServer({ name: "test", version: "0.0.0" })
    registerJsonTool(server, mockClient, {
      name: "test_error",
      description: "Test",
      endpointKey: "insight.opinion.list",
      paginated: false,
      inputSchema: {},
    })
    const mcpClient = await makeConnectedPair(server)
    const result = await mcpClient.callTool({ name: "test_error", arguments: {} })
    expect(result.isError).toBe(true)
    expect((result.content as Array<{ text: string }>)[0].text).toContain("API down")
  })
})
