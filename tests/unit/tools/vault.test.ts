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

// ─── 股票池写操作 ───
// 本服务仅有的五个写工具。三条线各自钉住：请求体形状、逐条失败的可见性、不可逆操作的闸门。
describe("stock-pool writes", () => {
  function writeClient(response: unknown = { successList: [], failList: [] }) {
    const call = vi.fn(async () => response)
    return { client: { call, download: vi.fn() } as unknown as GangtiseClient, call }
  }

  const bodyOf = (call: ReturnType<typeof vi.fn>) => call.mock.calls[0][1] as Record<string, unknown>
  const payload = (r: { content: unknown }) => JSON.parse((r.content as Array<{ text: string }>)[0].text) as Record<string, unknown>

  it("sends the documented request body for each write", async () => {
    const cases: Array<[string, Record<string, unknown>, string, Record<string, unknown>]> = [
      ["gangtise_stock_pool_create", { poolName: "测试池" }, "vault.stock-pool.create", { poolName: "测试池" }],
      ["gangtise_stock_pool_rename", { poolId: "1", poolName: "新名" }, "vault.stock-pool.rename", { poolId: "1", poolName: "新名" }],
      ["gangtise_stock_pool_add_stock", { poolId: "1", securityCodeList: ["600519.SH"] }, "vault.stock-pool.add-stock", { poolId: "1", securityCodeList: ["600519.SH"] }],
      ["gangtise_stock_pool_remove_stock", { poolId: "1", securityCodeList: ["600519.SH"] }, "vault.stock-pool.remove-stock", { poolId: "1", securityCodeList: ["600519.SH"] }],
      ["gangtise_stock_pool_delete", { poolIdList: ["1"], confirm: true }, "vault.stock-pool.delete", { poolIdList: ["1"] }],
    ]
    for (const [name, args, endpoint, expected] of cases) {
      const { client, call } = writeClient()
      const mcp = await connect(client)
      const r = await mcp.callTool({ name, arguments: args })
      expect(r.isError, `${name} 报错了`).toBeFalsy()
      expect(call.mock.calls[0][0]).toBe(endpoint)
      // confirm 是本地闸门用的，不能泄进请求体。
      expect(bodyOf(call)).toEqual(expected)
    }
  })

  // 逐条失败的标记已下沉到 client（按端点上的 itemFailures 执行），覆盖在
  // client.test.ts 与 endpoints.test.ts。这里只验工具**透传**那份已标注的结果。
  it("passes an already-flagged partial result through untouched", async () => {
    const { client } = writeClient({
      successList: ["600519.SH"],
      failList: [{ securityCode: "999999.XX", failReason: "证券不存在" }],
      _partial: true,
      _partial_reason: "failed_items",
      failedItems: ["999999.XX（证券不存在）"],
    })
    const mcp = await connect(client)
    const r = await mcp.callTool({ name: "gangtise_stock_pool_add_stock", arguments: { poolId: "1", securityCodeList: ["600519.SH"] } })
    const p = payload(r)
    expect(p._partial).toBe(true)
    expect(p.failedItems).toEqual(["999999.XX（证券不存在）"])
  })

  it("leaves a fully successful write unmarked", async () => {
    const { client } = writeClient({ successList: ["600519.SH"], failList: [] })
    const mcp = await connect(client)
    const r = await mcp.callTool({ name: "gangtise_stock_pool_add_stock", arguments: { poolId: "1", securityCodeList: ["600519.SH"] } })
    expect(payload(r)._partial).toBeUndefined()
  })

  // 删池不可恢复，所以闸门必须在**取得任何网络资源之前**拦下——被拒时一个请求都不发。
  it("refuses an unconfirmed delete without issuing a request", async () => {
    const { client, call } = writeClient()
    const mcp = await connect(client)
    const r = await mcp.callTool({ name: "gangtise_stock_pool_delete", arguments: { poolIdList: ["1"], confirm: false } })
    expect(r.isError).toBe(true)
    expect((r.content as Array<{ text: string }>)[0].text).toContain("不可恢复")
    expect(call, "未确认的删除请求被发出去了").not.toHaveBeenCalled()
  })

  it("refuses a delete with confirm omitted entirely", async () => {
    const { client, call } = writeClient()
    const mcp = await connect(client)
    const r = await mcp.callTool({ name: "gangtise_stock_pool_delete", arguments: { poolIdList: ["1"] } })
    expect(r.isError).toBe(true)
    expect(call).not.toHaveBeenCalled()
  })

  // 闸门文案与端点标记是同一份事实：删掉标记而忘了改文案，这条会红。
  it("sources the refusal wording from the endpoint marker", async () => {
    const { ENDPOINTS } = await import("../../../src/core/endpoints.js")
    const { client } = writeClient()
    const mcp = await connect(client)
    const r = await mcp.callTool({ name: "gangtise_stock_pool_delete", arguments: { poolIdList: ["1"], confirm: false } })
    expect((r.content as Array<{ text: string }>)[0].text).toContain(ENDPOINTS["vault.stock-pool.delete"].destructive!.warning)
  })

  // 🔴 池名判重是整串精确比较（首尾空格不 trim），所以本地替调用方 trim 既改掉了用户
  // 指定的名字，又可能让一个本来不冲突的名字撞上已有池。
  it("forwards a pool name byte-for-byte, including leading and trailing spaces", async () => {
    for (const [tool, args] of [
      ["gangtise_stock_pool_create", { poolName: " 观察 " }],
      ["gangtise_stock_pool_rename", { poolId: "1", poolName: " 观察 " }],
    ] as Array<[string, Record<string, unknown>]>) {
      const { client, call } = writeClient({ poolId: "1", poolName: "x" })
      const mcp = await connect(client)
      const r = await mcp.callTool({ name: tool, arguments: args })
      expect(r.isError, `${tool} 报错了`).toBeFalsy()
      expect((bodyOf(call) as { poolName: string }).poolName, `${tool} 改掉了调用方给的池名`).toBe(" 观察 ")
    }
  })

  it("counts length on the raw string, not a trimmed one", async () => {
    // 「一二三四五六七八九十」是 10 个字符，两侧各加一个空格就是 12 —— 超长。
    const { client, call } = writeClient()
    const mcp = await connect(client)
    const r = await mcp.callTool({ name: "gangtise_stock_pool_create", arguments: { poolName: " 一二三四五六七八九十 " } })
    expect(r.isError).toBe(true)
    expect(call).not.toHaveBeenCalled()
  })

  it("rejects an all-whitespace pool name", async () => {
    const { client, call } = writeClient()
    const mcp = await connect(client)
    const r = await mcp.callTool({ name: "gangtise_stock_pool_create", arguments: { poolName: "   " } })
    expect(r.isError).toBe(true)
    expect(call).not.toHaveBeenCalled()
  })

  // 大响应会落盘，首条回复只剩一个指针 —— 而工具说明让调用方「先看有没有 _partial」。
  // 标记要是跟着正文一起沉进文件，一次部分失败就会被读成全部成功。
  it("keeps the failure marker on the pointer when the result spills to a file", async () => {
    const { client } = writeClient({
      successList: Array.from({ length: 6000 }, (_, i) => `${600000 + i}.SH`),
      failList: [{ securityCode: "999999.XX", failReason: "证券代码不存在" }],
      _partial: true,
      _partial_reason: "failed_items",
      failedItems: ["999999.XX（证券代码不存在）"],
    })
    const mcp = await connect(client)
    const r = await mcp.callTool({ name: "gangtise_stock_pool_add_stock", arguments: { poolId: "1", securityCodeList: ["600519.SH"] } })
    const p = payload(r)
    expect(p._truncated, "这条用例要的是落盘路径，载荷没到阈值就白测了").toBe(true)
    expect(p._partial, "落盘后首条回复丢了失败标记").toBe(true)
    expect(p._partial_reason).toContain("failed_items")
    expect(p.failedItems).toEqual(["999999.XX（证券代码不存在）"])
  })

  it("rejects an over-long pool name before sending", async () => {
    const { client, call } = writeClient()
    const mcp = await connect(client)
    const r = await mcp.callTool({ name: "gangtise_stock_pool_create", arguments: { poolName: "一二三四五六七八九十一" } })
    expect(r.isError).toBe(true)
    expect(call).not.toHaveBeenCalled()
  })
})
