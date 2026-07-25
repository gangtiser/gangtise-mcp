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

// 实测 2026-07-26：valuation-analysis 传入不存在的字段名（如 securityCode，本接口
// 根本没有这一列）时，上游把相邻列的值复制进该槽位、字段数与行长仍然相等 ——
// 请求 ['securityCode','tradeDate','value'] 实际返回 ['2026-07-20','2026-07-20',20.06]，
// securityCode 拿到的是日期。normalize 的长度校验对这种等长错列拦不住，所以防线是
// schema：字段名收成 z.enum 闭集，非法值在发请求前就被拒。上面的行为用例钉「本地拒绝
// 且不调 API」，下面的描述用例钉那份字段清单本身，别再退回泛泛的「指定返回字段」。
describe("fieldList closed set (schema is the defence against equal-length mis-zip)", () => {
  async function schemaOf(name: string) {
    const mcp = await connect(makeClient())
    const tool = (await mcp.listTools()).tools.find((t) => t.name === name)
    return JSON.stringify(tool?.inputSchema)
  }

  // 描述只是建议，schema 才会拒 —— 这两条钉住「本地拒绝且不发请求」的实际行为。
  it("rejects an unknown valuation field locally, without calling the API", async () => {
    const client = makeClient()
    const mcp = await connect(client)
    const result = await mcp.callTool({
      name: "gangtise_valuation_analysis",
      arguments: { ...base, fieldList: ["securityCode", "tradeDate", "value"] },
    })
    expect(result.isError).toBe(true)
    expect(client.call).not.toHaveBeenCalled()
  })

  it("accepts the real valuation fields", async () => {
    const client = makeClient()
    const mcp = await connect(client)
    const result = await mcp.callTool({
      name: "gangtise_valuation_analysis",
      arguments: { ...base, fieldList: ["value", "percentileRank"] },
    })
    expect(result.isError).toBeFalsy()
    expect(client.call).toHaveBeenCalledTimes(1)
  })

  it("rejects an unknown main-business field locally, without calling the API", async () => {
    const client = makeClient()
    const mcp = await connect(client)
    const result = await mcp.callTool({
      name: "gangtise_main_business",
      arguments: { securityCode: "600519.SH", breakdown: "product", fieldList: ["categoryName", "revenue"] },
    })
    expect(result.isError).toBe(true)
    expect(client.call).not.toHaveBeenCalled()
  })

  it("offers the 6 selectable valuation fields and warns off tradeDate / securityCode", async () => {
    const schema = await schemaOf("gangtise_valuation_analysis")
    for (const f of ["value", "percentileRank", "average", "median", "upper1Std", "lower1Std"]) {
      expect(schema, `应列出可选字段 ${f}`).toContain(f)
    }
    expect(schema).toContain("没有 securityCode")
    expect(schema).toContain("不要传")
  })

  // tradeDate 总是自动前置到每一行：显式请求它会多出一个值而字段名不多
  // （请求 ['tradeDate','value'] 实到 2 名 3 值），反倒把长度校验撞红。
  it("rejects tradeDate in the valuation fieldList — it is always returned anyway", async () => {
    const client = makeClient()
    const mcp = await connect(client)
    const result = await mcp.callTool({
      name: "gangtise_valuation_analysis",
      arguments: { ...base, fieldList: ["tradeDate", "value"] },
    })
    expect(result.isError).toBe(true)
    expect(client.call).not.toHaveBeenCalled()
  })

  it("lists main-business's real field names, not the stale endDate/revenue ones", async () => {
    const schema = await schemaOf("gangtise_main_business")
    for (const f of ["periodName", "periodEndDate", "categoryName", "opRevenue", "grossProfit"]) {
      expect(schema, `应列出真实字段 ${f}`).toContain(f)
    }
  })
})

// 实测 2026-07-26（工行/茅台/中信证券一致）：A股累计口径的资产负债表与现金流量表，
// companyType 与 currency 两列的值互换（companyType='人民币'、currency='银行'）。
// A股利润表（累计）正确，故不该带这条注记 —— 一并钉住范围，避免注记被复制到全部报表。
describe("upstream companyType/currency swap note", () => {
  it("warns on the two swapped statements and stays off the correct one", async () => {
    const mcp = await connect(makeClient())
    const byName = new Map((await mcp.listTools()).tools.map((t) => [t.name, t.description ?? ""]))
    for (const n of ["gangtise_balance_sheet", "gangtise_cash_flow"]) {
      expect(byName.get(n), `${n} 应标注两列互换`).toContain("companyType 与 currency")
    }
    expect(byName.get("gangtise_income_statement")).not.toContain("companyType 与 currency")
  })
})
