import { describe, it, expect, vi } from "vitest"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { registerVaultTools } from "../../../src/tools/vault.js"
import type { GangtiseClient } from "../../../src/core/client.js"

// Emulates the chatroom endpoint: slices a fixed dataset by from/size and caps
// each page at 50 like the server (so >50 rows require serial paging). The
// endpoint returns no `total`.
function makeChatroomClient(total: number) {
  const dataset = Array.from({ length: total }, (_, i) => ({ chatRoomId: String(i), roomName: `room${i}` }))
  const call = vi.fn(async (_key: string, body: Record<string, unknown>) => {
    const from = typeof body.from === "number" ? body.from : 0
    const size = Math.min(typeof body.size === "number" ? body.size : 50, 50)
    return { chatRoomList: dataset.slice(from, from + size) }
  })
  const client = { call, download: vi.fn() } as unknown as GangtiseClient
  return { client, call }
}

async function connect(client: GangtiseClient) {
  const server = new McpServer({ name: "test", version: "0.0.0" })
  registerVaultTools(server, client)
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  const mcp = new Client({ name: "test", version: "0.0.1" })
  await mcp.connect(clientTransport)
  return mcp
}

function rooms(result: { content: unknown }): unknown[] {
  const parsed = JSON.parse((result.content as Array<{ text: string }>)[0].text)
  return Array.isArray(parsed) ? parsed : ((parsed.list as unknown[]) ?? (parsed.chatRoomList as unknown[]) ?? [])
}

describe("schema validation (X5 tightening)", () => {
  // Live-tested: upstream returns [] for poolIdList: [] instead of the
  // documented "all pools" default — reject it locally so the model omits the
  // param (or passes real IDs) instead of silently getting an empty answer.
  it("rejects an empty poolIdList without calling the API", async () => {
    const { client, call } = makeChatroomClient(0)
    const mcp = await connect(client)
    const result = await mcp.callTool({ name: "gangtise_stock_pool_stocks", arguments: { poolIdList: [] } })
    expect(result.isError).toBe(true)
    expect(call).not.toHaveBeenCalled()
  })

  it("rejects a malformed drive-list startTime without calling the API", async () => {
    const { client, call } = makeChatroomClient(0)
    const mcp = await connect(client)
    const result = await mcp.callTool({
      name: "gangtise_drive_list",
      arguments: { startTime: "2026-6-1 09:00:00" },
    })
    expect(result.isError).toBe(true)
    expect(call).not.toHaveBeenCalled()
  })
})

describe("gangtise_wechat_chatroom_list", () => {
  it("serial-paginates past the 50-row server cap when size is omitted", async () => {
    const { client, call } = makeChatroomClient(80)
    const mcp = await connect(client)
    const result = await mcp.callTool({ name: "gangtise_wechat_chatroom_list", arguments: {} })
    expect(rooms(result)).toHaveLength(80)
    expect(call).toHaveBeenCalledTimes(2) // 50 + 30
  })

  it("caps at a requested size that spans more than one page", async () => {
    const { client, call } = makeChatroomClient(80)
    const mcp = await connect(client)
    const result = await mcp.callTool({ name: "gangtise_wechat_chatroom_list", arguments: { size: 70 } })
    expect(rooms(result)).toHaveLength(70)
    expect(call).toHaveBeenCalledTimes(2) // 50 + 20
  })

  it("fetches a single page for a size under the cap", async () => {
    const { client, call } = makeChatroomClient(80)
    const mcp = await connect(client)
    const result = await mcp.callTool({ name: "gangtise_wechat_chatroom_list", arguments: { size: 20 } })
    expect(rooms(result)).toHaveLength(20)
    expect(call).toHaveBeenCalledTimes(1)
  })

  it("fail-softs on a later-page failure, keeping the rows already fetched", async () => {
    const dataset = Array.from({ length: 80 }, (_, i) => ({ chatRoomId: String(i) }))
    const call = vi.fn(async (_key: string, body: Record<string, unknown>) => {
      const from = typeof body.from === "number" ? body.from : 0
      if (from > 0) throw new Error("903301 rate limited")
      return { chatRoomList: dataset.slice(0, 50) }
    })
    const client = { call, download: vi.fn() } as unknown as GangtiseClient
    const mcp = await connect(client)
    const result = await mcp.callTool({ name: "gangtise_wechat_chatroom_list", arguments: {} })
    expect(result.isError).toBeFalsy()
    const parsed = JSON.parse((result.content as Array<{ text: string }>)[0].text)
    expect(parsed.list).toHaveLength(50)
    expect(parsed._partial).toBe(true)
    expect(parsed._partial_reason).toContain("failed_pages")
    expect(parsed._failed_pages[0]).toMatchObject({ from: 50 })
  })

  it("fails fast when the first page errors (nothing fetched yet)", async () => {
    const call = vi.fn(async () => {
      throw new Error("auth expired")
    })
    const client = { call, download: vi.fn() } as unknown as GangtiseClient
    const mcp = await connect(client)
    const result = await mcp.callTool({ name: "gangtise_wechat_chatroom_list", arguments: {} })
    expect(result.isError).toBe(true)
  })
})
