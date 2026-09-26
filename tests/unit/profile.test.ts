import { describe, expect, it, vi } from "vitest"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { parseProfile } from "../../src/profile.js"
import { createGangtiseMcpServer, routingInstructions } from "../../src/server.js"
import { createFamilies } from "../../src/tools/index.js"
import { missingToolRefs } from "../helpers/instructionRefs.js"
import type { GangtiseClient } from "../../src/core/client.js"
import type { FamilyModule, ToolSpec } from "../../src/mcp/define.js"

const tool = (name: string, tier: ToolSpec["tier"]): ToolSpec => ({
  name,
  tier,
  access: "read",
  billingLabel: { kind: "free" },
  description: name,
  input: {},
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
    // 禁用一整组时，组里的基础工具保留（context 组只有 gangtise_current_date）。
    const client = await connect("core,-gangtise_realtime,-context")
    const names = (await client.listTools()).tools.map((t) => t.name)
    expect(names).not.toContain("gangtise_realtime")
    expect(names).toContain("gangtise_current_date")
    expect(names).toHaveLength(102)
    const result = await client.callTool({ name: "gangtise_realtime", arguments: { security: "600519.SH" } }).catch((err: unknown) => ({ isError: true, err }))
    expect((result as { isError?: boolean }).isError).toBe(true)
    expect(stubClient.call).not.toHaveBeenCalled()
  })

  it("refuses to start on a misspelled item", () => {
    expect(() => createGangtiseMcpServer(stubClient, { tools: "core,gangtise_realtme" })).toThrow(/gangtise_realtme/)
  })
})

describe("routingInstructions", () => {
  const withHints: FamilyModule[] = [
    { ...FAMILIES[0], routingHint: "⑤alpha：alpha 族的路由。" },
    { ...FAMILIES[1], routingHint: "⑥beta：beta 族的路由。" },
  ]

  it("adds a family's hint only while one of its tools is listed, before the billing line", () => {
    const text = routingInstructions(withHints, parseProfile("core,-beta", withHints))
    expect(text).toContain("⑤alpha：alpha 族的路由。\n计费见各工具")
    expect(text).not.toContain("⑥beta")
    expect(routingInstructions(withHints, parseProfile("core", withHints))).toContain("⑤alpha：alpha 族的路由。\n⑥beta：beta 族的路由。\n计费见各工具")
  })

  it("is unchanged by families without a hint", () => {
    expect(routingInstructions(FAMILIES, parseProfile(undefined, FAMILIES))).toBe(routingInstructions([], parseProfile(undefined, [])))
  })

  // 完整名、简称（qa_list）、通配（indicator_*）、与工具同名的单词（realtime）都算点名。
  const ALL_NAMES = createFamilies({ asyncTimeoutMs: 5_000 }).flatMap((family) => family.tools).map((tool) => tool.name)
  it.each([
    [undefined], ["all"], ["quote"], ["insight"], ["ai"], ["vault"], ["reference"], ["lookup"], ["fundamental"], ["indicator"], ["alternative"],
    ["gangtise_one_pager"], ["gangtise_earnings_review"], ["gangtise_research_list"], ["gangtise_realtime"], ["core,-insight"], ["core,-quote,-indicator,-alternative"],
  ])("names only enabled tools under GANGTISE_MCP_TOOLS=%j", async (tools) => {
    const client = await connect(tools)
    const listed = (await client.listTools()).tools.map((t) => t.name)
    const text = client.getInstructions() ?? ""
    expect(text).toContain("gangtise_read_response")
    expect(missingToolRefs(text, listed, ALL_NAMES)).toEqual([])
  })

  it("keeps only the clauses whose tools are enabled", async () => {
    const text = (await connect("quote")).getInstructions() ?? ""
    expect(text).toContain("①行情/财务：日K/realtime 各一个工具覆盖三市场+指数；资金流仅 A 股。\n")
    for (const gone of ["indicator_*", "edb_*", "三表按市场", "②内容", "③AI", "④其他", "除①批量外"]) expect(text).not.toContain(gone)
    // 一行里只剩「；」结尾的分句时改成句号
    expect((await connect("fundamental")).getInstructions()).toContain("①行情/财务：三表按市场用 _hk/_us；单票财务/估值/盈利预测/股东/主营用专用工具。\n")
  })
})

describe("tool dependencies", () => {
  const families = createFamilies({ asyncTimeoutMs: 5_000 })
  const enabledNames = (raw: string) => {
    const profile = parseProfile(raw, families)
    return families.flatMap((family) => family.tools).filter((spec) => profile.enabled(spec)).map((spec) => spec.name)
  }

  it("always keeps the foundation tools and refuses to disable them", () => {
    expect(enabledNames("quote")).toEqual(expect.arrayContaining(["gangtise_current_date", "gangtise_read_response", "gangtise_securities_search"]))
    expect(enabledNames("quote")).toHaveLength(7 + 3)
    for (const name of ["gangtise_read_response", "gangtise_current_date", "gangtise_securities_search"]) {
      expect(() => parseProfile(`core,-${name}`, families)).toThrow(/基础工具/)
    }
  })

  it("enables the _check tool together with its async submit tool", () => {
    expect(enabledNames("gangtise_earnings_review")).toEqual(expect.arrayContaining(["gangtise_earnings_review", "gangtise_earnings_review_check"]))
    expect(() => parseProfile("gangtise_viewpoint_debate,-gangtise_viewpoint_debate_check", families)).toThrow(/gangtise_viewpoint_debate_check/)
    // 只禁用续查、不选提交工具时不冲突
    expect(enabledNames("core,-ai")).not.toContain("gangtise_earnings_review_check")
  })

  it("lets a quote-only setup read the rest of a truncated result", async () => {
    const rows = Array.from({ length: 1_000 }, (_, i) => ({ securityCode: `${String(i).padStart(6, "0")}.SH`, latestPrice: i, note: "x".repeat(150) }))
    const client = { call: vi.fn(async () => ({ total: rows.length, list: rows })), download: vi.fn() } as unknown as GangtiseClient
    const server = createGangtiseMcpServer(client, { version: "0.0.0-test", tools: "quote" })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await server.connect(serverTransport)
    const mcp = new Client({ name: "test", version: "0.0.1" })
    await mcp.connect(clientTransport)

    const first = await mcp.callTool({ name: "gangtise_realtime", arguments: { security: "aShares" } })
    const pointer = JSON.parse((first.content as Array<{ text: string }>)[0].text) as { _truncated?: boolean; _saved_to: string; _read_with: string }
    expect(pointer._truncated).toBe(true)
    const next = await mcp.callTool({ name: pointer._read_with, arguments: { saved_to: pointer._saved_to, offset: 500, limit: 10 } })
    expect(next.isError).toBeFalsy()
    expect(JSON.parse((next.content as Array<{ text: string }>)[0].text).list[0].securityCode).toBe("000500.SH")
  })
})
