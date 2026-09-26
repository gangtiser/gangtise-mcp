import { describe, expect, it, vi } from "vitest"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { parseProfile } from "../../src/profile.js"
import { createGangtiseMcpServer } from "../../src/server.js"
import type { GangtiseClient } from "../../src/core/client.js"
import type { FamilyModule, ToolSpec } from "../../src/mcp/define.js"

const tool = (name: string, tier: ToolSpec["tier"]): ToolSpec => ({
  name,
  tier,
  access: "read",
  billingLabel: { kind: "free" },
  description: name,
  input: {},
  examples: [{ title: "t", args: {}, expect: { requests: [] } }],
  run: async () => ({ content: [] }),
})

// 真实工具目前都在 core 档，分档语义用合成族钉住。
const FAMILIES: FamilyModule[] = [
  { name: "alpha", endpoints: {}, tools: [tool("gangtise_a1", "core"), tool("gangtise_a2", "extended"), tool("gangtise_a3", "legacy")] },
  { name: "beta", endpoints: {}, tools: [tool("gangtise_b1", "core"), tool("gangtise_b2", "extended")] },
]
const ALL_TOOLS = FAMILIES.flatMap((family) => family.tools)
const pick = (raw: string | undefined) => {
  const profile = parseProfile(raw, FAMILIES)
  return ALL_TOOLS.filter((spec) => profile.advertised(spec)).map((spec) => spec.name)
}

describe("parseProfile", () => {
  it.each([
    [undefined, ["gangtise_a1", "gangtise_b1"]],
    ["", ["gangtise_a1", "gangtise_b1"]],
    ["core", ["gangtise_a1", "gangtise_b1"]],
    ["all", ["gangtise_a1", "gangtise_a2", "gangtise_b1", "gangtise_b2"]],
    ["legacy", ["gangtise_a3"]],
    ["core,legacy", ["gangtise_a1", "gangtise_a3", "gangtise_b1"]],
    // 族名 = 该族 core + extended，不含 legacy
    ["core,alpha", ["gangtise_a1", "gangtise_a2", "gangtise_b1"]],
    ["beta", ["gangtise_b1", "gangtise_b2"]],
    // 工具名单独点名，任何档都行
    ["core,gangtise_b2", ["gangtise_a1", "gangtise_b1", "gangtise_b2"]],
    ["gangtise_a3", ["gangtise_a3"]],
    // 禁用优先于选中；只写禁用项时以 core 为底
    ["all,-alpha", ["gangtise_b1", "gangtise_b2"]],
    ["all,-gangtise_a2", ["gangtise_a1", "gangtise_b1", "gangtise_b2"]],
    ["-gangtise_b1", ["gangtise_a1"]],
    [" core , gangtise_b2 ", ["gangtise_a1", "gangtise_b1", "gangtise_b2"]],
  ])("GANGTISE_MCP_TOOLS=%j", (raw, expected) => {
    expect(pick(raw)).toEqual(expected)
  })

  it("keeps advertised and enabled the same", () => {
    const profile = parseProfile("core,-gangtise_b1", FAMILIES)
    for (const spec of ALL_TOOLS) expect(profile.enabled(spec)).toBe(profile.advertised(spec))
  })

  it.each([["bogus"], ["core,gangtise_nope"], ["-core"], ["-all"]])("refuses an unknown item %j instead of falling back to the default", (raw) => {
    expect(() => parseProfile(raw, FAMILIES)).toThrow(/GANGTISE_MCP_TOOLS/)
  })
})

const stubClient = { call: vi.fn(), download: vi.fn() } as unknown as GangtiseClient

async function connect(tools?: string) {
  const server = createGangtiseMcpServer(stubClient, { version: "0.0.0-test", tools })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  const client = new Client({ name: "test", version: "0.0.1" })
  await client.connect(clientTransport)
  return client
}

describe("GANGTISE_MCP_TOOLS on the real server", () => {
  it("lists the same tools for core and all while every tool is in core", async () => {
    const core = (await (await connect(undefined)).listTools()).tools.map((t) => t.name)
    const all = (await (await connect("all")).listTools()).tools.map((t) => t.name)
    expect(core).toHaveLength(103)
    expect(all).toEqual(core)
  })

  it("drops a disabled tool from the listing and refuses to call it", async () => {
    const client = await connect("core,-gangtise_realtime,-context")
    const names = (await client.listTools()).tools.map((t) => t.name)
    expect(names).not.toContain("gangtise_realtime")
    expect(names).not.toContain("gangtise_current_date")
    expect(names).toHaveLength(101)
    const result = await client.callTool({ name: "gangtise_realtime", arguments: { security: "600519.SH" } }).catch((err: unknown) => ({ isError: true, err }))
    expect((result as { isError?: boolean }).isError).toBe(true)
    expect(stubClient.call).not.toHaveBeenCalled()
  })

  it("refuses to start on a misspelled item", () => {
    expect(() => createGangtiseMcpServer(stubClient, { tools: "core,gangtise_realtme" })).toThrow(/gangtise_realtme/)
  })
})
