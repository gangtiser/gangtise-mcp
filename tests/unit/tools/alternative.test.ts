import { describe, it, expect, vi } from "vitest"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { registerAlternativeTools } from "../../../src/tools/alternative.js"
import type { GangtiseClient } from "../../../src/core/client.js"

async function connect(call: () => Promise<unknown>) {
  const client = { call: vi.fn(call), download: vi.fn() } as unknown as GangtiseClient
  const server = new McpServer({ name: "test", version: "0.0.0" })
  registerAlternativeTools(server, client)
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  const mcp = new Client({ name: "test", version: "0.0.1" })
  await mcp.connect(clientTransport)
  return mcp
}

const args = { indicatorIdList: ["1"], startDate: "2026-01-01", endDate: "2026-01-31" }

// edb-data 返回的是 { fieldList, dataList }，和三大报表的 { fieldList, list } 同一种
// 列式拍平。此前它自己 zip、绕过了 normalizeRows 的长度校验，等于留了第二条未校验的
// 拍平路径。本工具不暴露 fieldList 入参（字段名由服务端给），今天不会错列 —— 但错列
// 一旦发生就是静默的错值，所以两条路径必须共用同一道闸。
describe("gangtise_edb_data column flattening", () => {
  it("zips fieldList against dataList rows", async () => {
    const mcp = await connect(async () => ({
      fieldList: ["date", "value"],
      dataList: [["2026-01-01", 1.5], ["2026-01-02", 1.6]],
    }))
    const result = await mcp.callTool({ name: "gangtise_edb_data", arguments: args })
    const payload = JSON.parse((result.content as Array<{ text: string }>)[0].text)
    expect(payload.list).toEqual([
      { date: "2026-01-01", value: 1.5 },
      { date: "2026-01-02", value: 1.6 },
    ])
    expect(payload.total).toBe(2)
  })

  it("rejects a row whose length does not match fieldList instead of mis-zipping", async () => {
    const mcp = await connect(async () => ({
      fieldList: ["date", "value", "extra"],
      dataList: [["2026-01-01", 1.5]],
    }))
    const result = await mcp.callTool({ name: "gangtise_edb_data", arguments: args })
    expect(result.isError).toBe(true)
    expect((result.content as Array<{ text: string }>)[0].text).toContain("响应字段数与请求 fieldList 不匹配")
  })
})
