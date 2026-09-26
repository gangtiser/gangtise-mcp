import { describe, it, expect, vi } from "vitest"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { createGangtiseMcpServer } from "../../../src/server.js"
import { ENDPOINTS } from "../../../src/core/endpoints.js"
import type { GangtiseClient } from "../../../src/core/client.js"
import { defineDownloadTool, defineJsonTool } from "../../../src/mcp/define.js"
import { createFamilies } from "../../../src/tools/index.js"

// 工具都声明在各族里（tools/index.ts 的 createFamilies），这里遍历它，不再手工汇总 spec 数组。
// 端点键写错、json/download 类型不符、分页声明与端点不一致，由 define* 工厂在定义时抛错
// （下面的 factory guards 钉住）；这里核对族与端点表、族与已注册工具之间的对应关系。

const FAMILIES = createFamilies({ asyncTimeoutMs: 5_000 })
const TOOLS = FAMILIES.flatMap((family) => family.tools)

describe("families ↔ ENDPOINTS consistency", () => {
  it("enumerates every tool (guards against a vacuous pass if an export breaks)", () => {
    expect(TOOLS).toHaveLength(103)
  })

  it("points every tool at an existing endpoint of its own family, or gives it its own label", () => {
    const problems = FAMILIES.flatMap((family) =>
      family.tools.flatMap((tool) => {
        if (tool.endpoint === undefined) return tool.billingLabel ? [] : [`${tool.name}: 既无 endpoint 也无 billingLabel`]
        if (!ENDPOINTS[tool.endpoint]) return [`${tool.name} → ${tool.endpoint}: 端点不存在`]
        if (!(tool.endpoint in family.endpoints)) return [`${tool.name} → ${tool.endpoint}: 不在 ${family.name} 族的端点表里`]
        return []
      }),
    )
    expect(problems).toEqual([])
  })

  it("assembles ENDPOINTS from exactly the families' tables (plus auth)", () => {
    const fromFamilies = FAMILIES.flatMap((family) => Object.keys(family.endpoints))
    expect(new Set(fromFamilies).size).toBe(fromFamilies.length)
    expect([...fromFamilies, "auth.login"].sort()).toEqual(Object.keys(ENDPOINTS).sort())
    for (const family of FAMILIES) {
      for (const [key, spec] of Object.entries(family.endpoints)) expect(ENDPOINTS[key]).toEqual({ key, ...spec })
    }
  })

  it("keeps tool names unique and gangtise_-prefixed", () => {
    const names = TOOLS.map((tool) => tool.name)
    expect(names.filter((name, i) => names.indexOf(name) !== i)).toEqual([])
    expect(names.filter((name) => !name.startsWith("gangtise_"))).toEqual([])
  })
})

describe("factory guards", () => {
  const base = { name: "gangtise_x", tier: "core" as const, description: "x", inputSchema: {} }

  it("rejects an unknown endpoint key", () => {
    expect(() => defineJsonTool({ ...base, endpointKey: "insight.nope.list" })).toThrow(/unknown endpoint/)
    expect(() => defineDownloadTool({ ...base, endpointKey: "insight.nope.download" })).toThrow(/unknown endpoint/)
  })

  it("rejects a json tool on a download endpoint and a download tool on a json endpoint", () => {
    expect(() => defineJsonTool({ ...base, endpointKey: "insight.research.download" })).toThrow(/download endpoint, not json/)
    expect(() => defineDownloadTool({ ...base, endpointKey: "insight.research.list" })).toThrow(/json endpoint, not download/)
  })

  // 双向：分页工具必须打分页端点（否则 requestPaginated 行为错乱），打分页端点的工具也必须
  // 声明分页（否则静默丢掉 from/size/fetchAll、永远只回默认一页）。
  it("rejects a paginated flag that disagrees with the endpoint, in both directions", () => {
    expect(() => defineJsonTool({ ...base, endpointKey: "insight.research.list" })).toThrow(/disagrees/)
    expect(() => defineJsonTool({ ...base, endpointKey: "ai.one-pager", paginated: true })).toThrow(/disagrees/)
    expect(() => defineJsonTool({ ...base, endpointKey: "insight.research.list", paginated: true })).not.toThrow()
  })
})

function makeStubClient() {
  // Registration never calls the client — handlers receive it per call — so a stub with
  // the right shape is enough to boot the whole server.
  return { call: vi.fn(), download: vi.fn() } as unknown as GangtiseClient
}

// The full-server boot + listTools smoke (tool count, annotations, key tool presence) lives in
// tests/integration/server.test.ts. This bridges the families to that live registration: the
// server must register exactly the declared tools, in declaration order.
describe("family tools are all live on the server", () => {
  it("registers every declared tool, in order", async () => {
    const server = createGangtiseMcpServer(makeStubClient(), { version: "0.0.0-test", asyncTimeoutMs: 5_000 })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await server.connect(serverTransport)
    const client = new Client({ name: "test", version: "0.0.1" })
    await client.connect(clientTransport)
    const { tools } = await client.listTools()

    expect(tools.map((tool) => tool.name)).toEqual(TOOLS.map((tool) => tool.name))
  })
})
