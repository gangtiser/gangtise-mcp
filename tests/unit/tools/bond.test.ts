import { describe, it, expect, vi } from "vitest"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { bondFamily } from "../../../src/tools/bond.js"
import { registerFamilies } from "../../../src/mcp/register.js"
import type { GangtiseClient } from "../../../src/core/client.js"

async function connect(client: GangtiseClient) {
  const server = new McpServer({ name: "test", version: "0.0.0" })
  registerFamilies(server, client, [bondFamily])
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  const mcp = new Client({ name: "test", version: "0.0.1" })
  await mcp.connect(clientTransport)
  return mcp
}

// 跨过数据起点时从有数据的那天起返回、不报错：首行比起点晚两周以上才提示，多只逐只判。
describe("bond late first row note", () => {
  const clientWith = (list: Array<Record<string, unknown>>) => ({ call: vi.fn().mockResolvedValue({ list }), download: vi.fn() }) as unknown as GangtiseClient
  const noteOf = async (name: string, client: GangtiseClient, args: Record<string, unknown>) => {
    const result = await (await connect(client)).callTool({ name, arguments: args })
    return (JSON.parse((result.content as Array<{ text: string }>)[0].text) as { _note?: string })._note
  }

  for (const name of ["gangtise_bond_daily_quote", "gangtise_bond_valuation"]) {
    it(`${name}: notes a late first row with the bond cause, and stays quiet within two weeks`, async () => {
      const late = await noteOf(name, clientWith([{ securityCode: "113636.SH", tradeDate: "2021-03-01" }]), { securityList: ["113636.SH"], startDate: "2021-01-04", endDate: "2021-06-30" })
      expect(late).toMatch(/最早一行是 2021-03-01，比请求的起点 2021-01-04 晚 56 天：可能债券上市晚于起点，或数据起点晚于所查区间/)
      expect(late).not.toMatch(/可查窗口/)
      expect(await noteOf(name, clientWith([{ securityCode: "113636.SH", tradeDate: "2021-01-11" }]), { securityList: ["113636.SH"], startDate: "2021-01-04", endDate: "2021-06-30" })).toBeUndefined()
    })
  }

  // 一只数据够早会掩盖另一只晚到：逐只判，并点出一行都没回的代码。
  it("judges each bond on its own when several were asked for", async () => {
    const client = clientWith([
      { securityCode: "019742.SH", tradeDate: "2021-01-04" },
      { securityCode: "113636.SH", tradeDate: "2021-03-01" },
    ])
    const note = await noteOf("gangtise_bond_daily_quote", client, { securityList: ["019742.SH", "113636.SH", "220205.IB"], startDate: "2021-01-04", endDate: "2021-06-30" })
    expect(note).toMatch(/以下证券的最早一行比请求的起点 2021-01-04 晚 14 天以上：113636\.SH（2021-03-01）；以下证券没有返回任何行：220205\.IB。可能债券上市晚于起点/)
    expect(note).not.toMatch(/019742/)
  })
})
