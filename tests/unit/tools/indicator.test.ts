import { describe, it, expect, vi } from "vitest"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { registerIndicatorTools } from "../../../src/tools/indicator.js"
import type { GangtiseClient } from "../../../src/core/client.js"
import { ApiError } from "../../../src/core/errors.js"
import { unwrapEnvelope } from "../../../src/core/envelope.js"

function makeMockClient() {
  return {
    // inner { code, status, data } envelope — unwrapIndicatorData peels it
    call: vi.fn().mockResolvedValue({ code: "000000", status: true, data: { list: [] } }),
    download: vi.fn(),
  } as unknown as GangtiseClient
}

async function connect(client: GangtiseClient) {
  const server = new McpServer({ name: "test", version: "0.0.0" })
  registerIndicatorTools(server, client)
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  const mcp = new Client({ name: "test", version: "0.0.1" })
  await mcp.connect(clientTransport)
  return mcp
}

// The EDE inner envelope ({ code, status, data }) can carry a failure even when
// the outer envelope succeeded. Every indicator tool must surface it as isError
// — regressing to registerJsonTool (or dropping unwrapIndicatorData) would
// render it as "successful null data" with all tests green.
describe("indicator inner-envelope failure surfacing", () => {
  function failingClient() {
    return {
      call: vi.fn().mockResolvedValue({ code: "410004", status: false, msg: "指标无权限" }),
      download: vi.fn(),
    } as unknown as GangtiseClient
  }

  it.each([
    ["gangtise_indicator_search", { keyword: "收盘价" }],
    ["gangtise_indicator_cross_section", { indicatorCodeList: ["qte_close"], securityCodeList: ["600519.SH"], date: "2026-06-30" }],
    ["gangtise_indicator_time_series", { indicatorCodeList: ["qte_close"], securityCodeList: ["600519.SH"], startDate: "2026-06-01", endDate: "2026-06-30" }],
  ] as Array<[string, Record<string, unknown>]>)("%s surfaces the inner error as isError", async (name, args) => {
    const client = failingClient()
    const mcp = await connect(client)
    const result = await mcp.callTool({ name, arguments: args })
    expect(result.isError).toBe(true)
    expect(client.call).toHaveBeenCalledTimes(1)
  })
})

// Time-series flattening assumes exactly one dimension varies. With both >1 the
// matrix is ambiguous and flattenTimeSeries silently drops the indicator
// dimension. Reject the request before it reaches the API.
describe("gangtise_indicator_time_series dimension guard", () => {
  it("rejects multi-indicator × multi-security without calling the API", async () => {
    const client = makeMockClient()
    const mcp = await connect(client)
    const result = await mcp.callTool({
      name: "gangtise_indicator_time_series",
      arguments: {
        indicatorCodeList: ["qte_close", "qte_open"],
        securityCodeList: ["600519.SH", "000001.SZ"],
        startDate: "2026-06-01",
        endDate: "2026-06-30",
      },
    })
    expect(result.isError).toBe(true)
    expect(client.call).not.toHaveBeenCalled()
  })

  it("allows multi-indicator × single-security", async () => {
    const client = makeMockClient()
    const mcp = await connect(client)
    const result = await mcp.callTool({
      name: "gangtise_indicator_time_series",
      arguments: {
        indicatorCodeList: ["qte_close", "qte_open"],
        securityCodeList: ["600519.SH"],
        startDate: "2026-06-01",
        endDate: "2026-06-30",
      },
    })
    expect(result.isError).toBeFalsy()
    expect(client.call).toHaveBeenCalledTimes(1)
  })

  it("allows single-indicator × multi-security", async () => {
    const client = makeMockClient()
    const mcp = await connect(client)
    const result = await mcp.callTool({
      name: "gangtise_indicator_time_series",
      arguments: {
        indicatorCodeList: ["qte_close"],
        securityCodeList: ["600519.SH", "000001.SZ"],
        startDate: "2026-06-01",
        endDate: "2026-06-30",
      },
    })
    expect(result.isError).toBeFalsy()
    expect(client.call).toHaveBeenCalledTimes(1)
  })
})

// 999999 on the EDE FETCH endpoints (cross-section/time-series) is the server's
// "no data" answer — reword it toward the query conditions (date by indicator
// period / scope / required params), not "retry later". indicator.search keeps the
// generic hint: it shares the no-999999 policy but its 999999 is a real error (a
// zero-match search returns [] with exit 0), so date/scope/param guidance would be
// nonsensical. Mirrors gangtise-openapi-cli 0.28.2 (client.js).
const FETCH_CASES = [
  ["gangtise_indicator_cross_section", { indicatorCodeList: ["qte_close"], securityCodeList: ["600519.SH"], date: "2026-07-04" }],
  ["gangtise_indicator_time_series", { indicatorCodeList: ["qte_close"], securityCodeList: ["600519.SH"], startDate: "2026-06-01", endDate: "2026-06-30" }],
] as Array<[string, Record<string, unknown>]>

describe("indicator 999999 no-data hint (fetch endpoints)", () => {
  it.each(FETCH_CASES)("%s rewords 999999 by indicator period, not retry-later", async (name, args) => {
    const client = {
      call: vi.fn().mockRejectedValue(new ApiError("system error", "999999", 500)),
      download: vi.fn(),
    } as unknown as GangtiseClient
    const mcp = await connect(client)
    const result = await mcp.callTool({ name, arguments: args })
    expect(result.isError).toBe(true)
    const text = (result.content as Array<{ text: string }>)[0].text
    expect(text).toContain("多为查询无数据")
    expect(text).toContain("报告期末") // 修正后按指标周期路由（旧文案「日期是否为交易日」与 finc_pb_mrq 矛盾）
    expect(text).not.toContain("日期是否为交易日")
    expect(text).toContain("scopeList")
    expect(text).toContain("required")
    expect(text).not.toContain("稍后重试")
  })

  // EDE 双层信封：外层成功、内层失败的 999999 在解内层时才抛出；hintOverride 与
  // 外层 traceId 都必须在这条路径上生效。
  it.each(FETCH_CASES)("%s keeps the no-data hint when 999999 is raised peeling the inner envelope (with traceId)", async (name, args) => {
    const client = {
      call: vi.fn().mockImplementation(async () =>
        unwrapEnvelope({ code: "0", data: { code: "999999", status: false, msg: "system error" }, traceId: "77" })),
      download: vi.fn(),
    } as unknown as GangtiseClient
    const mcp = await connect(client)
    const result = await mcp.callTool({ name, arguments: args })
    expect(result.isError).toBe(true)
    const text = (result.content as Array<{ text: string }>)[0].text
    expect(text).toContain("多为查询无数据")
    expect(text).toContain("trace 77")
  })
})

// search 的 999999 是真系统错误（零命中返 []、exit 0），不套取数端点的 date/scope/param
// 提示——回落通用提示。与 CLI 0.28.2 一致。
describe("indicator.search keeps the generic 999999 hint", () => {
  it("does not get the fetch endpoints' date/scope/param hint", async () => {
    const client = { call: vi.fn().mockRejectedValue(new ApiError("system error", "999999", 500)), download: vi.fn() } as unknown as GangtiseClient
    const mcp = await connect(client)
    const result = await mcp.callTool({ name: "gangtise_indicator_search", arguments: { keyword: "x" } })
    expect(result.isError).toBe(true)
    const text = (result.content as Array<{ text: string }>)[0].text
    expect(text).not.toContain("报告期末")
    expect(text).not.toContain("scopeList")
    expect(text).not.toContain("required")
    // 正向钉住通用回落提示——search 的 999999 走 errors.ts 默认表（非取数端点的无数据提示）
    expect(text).toContain("稍后重试")
  })
})
