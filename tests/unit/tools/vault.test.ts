import { describe, it, expect, vi } from "vitest"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { registerVaultTools } from "../../../src/tools/vault.js"
import type { GangtiseClient } from "../../../src/core/client.js"

// v0.23: the chatroom endpoint now returns `{ total, list }` and is a standard
// paginated endpoint — the tool delegates to client.call, which (in production)
// fans out pages via requestPaginated. The mock stands in for that already-merged
// result, so the tool issues a single call.
function makeChatroomClient(total: number) {
  const list = Array.from({ length: total }, (_, i) => ({ chatRoomId: String(i), roomName: `room${i}` }))
  const call = vi.fn(async () => ({ total, list }))
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
  return Array.isArray(parsed) ? parsed : ((parsed.list as unknown[]) ?? [])
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
  it("omits size so client.call fetches all groups, returning the merged list", async () => {
    const { client, call } = makeChatroomClient(80)
    const mcp = await connect(client)
    const result = await mcp.callTool({ name: "gangtise_wechat_chatroom_list", arguments: {} })
    expect(call).toHaveBeenCalledTimes(1)
    expect(call.mock.calls[0][0]).toBe("vault.wechat-chatroom.list")
    // No size in the body → requestPaginated fetches every group.
    expect(call.mock.calls[0][1]).not.toHaveProperty("size")
    expect(rooms(result)).toHaveLength(80)
  })

  it("passes an explicit size through to the paginated call", async () => {
    const { client, call } = makeChatroomClient(3)
    const mcp = await connect(client)
    await mcp.callTool({ name: "gangtise_wechat_chatroom_list", arguments: { from: 5, size: 2 } })
    expect(call.mock.calls[0][1]).toMatchObject({ from: 5, size: 2 })
  })

  it("joins roomName filters into the comma-separated scalar the server expects", async () => {
    const { client, call } = makeChatroomClient(0)
    const mcp = await connect(client)
    await mcp.callTool({ name: "gangtise_wechat_chatroom_list", arguments: { roomName: ["群A", "群B"] } })
    expect(call.mock.calls[0][1]).toMatchObject({ roomName: "群A,群B" })
  })

  it("surfaces isError when the API call fails", async () => {
    const call = vi.fn(async () => {
      throw new Error("auth expired")
    })
    const client = { call, download: vi.fn() } as unknown as GangtiseClient
    const mcp = await connect(client)
    const result = await mcp.callTool({ name: "gangtise_wechat_chatroom_list", arguments: {} })
    expect(result.isError).toBe(true)
  })
})

describe("gangtise_my_conference_list", () => {
  it("forwards the v0.23 sourceList filter to the my-conference endpoint", async () => {
    const call = vi.fn(async () => ({ total: 0, list: [] }))
    const client = { call, download: vi.fn() } as unknown as GangtiseClient
    const mcp = await connect(client)
    await mcp.callTool({ name: "gangtise_my_conference_list", arguments: { sourceList: [1, 2] } })
    expect(call).toHaveBeenCalledWith(
      "vault.my-conference.list",
      expect.objectContaining({ sourceList: [1, 2], size: 20 }),
    )
  })
})
