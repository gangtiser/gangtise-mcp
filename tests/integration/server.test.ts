import fs from "node:fs"
import path from "node:path"

import { describe, it, expect, vi, beforeEach } from "vitest"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { createGangtiseMcpServer } from "../../src/server.js"
import { today } from "../../src/core/dateContext.js"
import type { GangtiseClient } from "../../src/core/client.js"

function makeMockClient() {
  return {
    call: vi.fn().mockImplementation(async (key: string) => {
      if (key.startsWith("lookup.")) return [{ id: "1", name: "Test" }]
      // EDE 走双层信封 + 矩阵，返回通用 list 会被 requireIndicatorMatrix 硬拒。
      // 闭集参数用例靠正向对照判断「这条红是不是枚举造成的」，mock 形状不对
      // 会让 currency/scale/calendarType 全部沦为跳过——测不到就是漏。
      if (key.startsWith("indicator.")) {
        return {
          code: "000000",
          status: true,
          data: {
            securityCodeList: ["600519.SH"], securityNameList: ["贵州茅台"],
            indicatorList: [{ code: "qte_close", name: "收盘价", dataType: "number" }],
            dates: ["2026-07-31"], values: [[1]],
          },
        }
      }
      return { list: [{ id: "test-id" }], total: 1 }
    }),
    download: vi.fn().mockResolvedValue({ text: "mock", contentType: "text/plain", filename: "mock.txt" }),
  } as unknown as GangtiseClient
}

async function makeTestClient(mockClient: GangtiseClient) {
  const server = createGangtiseMcpServer(mockClient, { asyncTimeoutMs: 5_000 })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  const client = new Client({ name: "test-client", version: "0.0.1" })
  await client.connect(clientTransport)
  return client
}

describe("MCP server integration", () => {
  let mockClient: GangtiseClient
  let mcpClient: Client

  beforeEach(async () => {
    mockClient = makeMockClient()
    mcpClient = await makeTestClient(mockClient)
  })

  it("reports the package.json version to clients", async () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(process.cwd(), "package.json"), "utf8"))
    expect(mcpClient.getServerVersion()?.version).toBe(pkg.version)
  })

  it("lists all registered tools", async () => {
    const { tools } = await mcpClient.listTools()
    const names = tools.map(t => t.name)

    expect(names).toContain("gangtise_current_date")
    expect(names).toContain("gangtise_lookup")
    expect(names).toContain("gangtise_securities_search")
    expect(names).toContain("gangtise_opinion_list")
    // schedule tools share one extracted schema — guard all four stay registered
    expect(names).toContain("gangtise_roadshow_list")
    expect(names).toContain("gangtise_site_visit_list")
    expect(names).toContain("gangtise_strategy_list")
    expect(names).toContain("gangtise_forum_list")
    expect(names).toContain("gangtise_research_list")
    expect(names).toContain("gangtise_research_download")
    expect(names).toContain("gangtise_official_account_list")
    expect(names).toContain("gangtise_official_account_download")
    expect(names).toContain("gangtise_day_kline")
    expect(names).toContain("gangtise_income_statement")
    expect(names).toContain("gangtise_one_pager")
    expect(names).toContain("gangtise_earnings_review")
    expect(names).toContain("gangtise_earnings_review_check")
    expect(names).toContain("gangtise_viewpoint_debate")
    expect(names).toContain("gangtise_drive_list")
    expect(names).toContain("gangtise_wechat_message_list")
    expect(names).toContain("gangtise_concept_info")
    expect(names).toContain("gangtise_concept_securities")
    expect(names).toContain("gangtise_constant_category")
    expect(names).toContain("gangtise_constant_list")
    expect(names).toContain("gangtise_concept_search")
    expect(names).toContain("gangtise_sector_search")
    expect(names).toContain("gangtise_sector_constituents")
    expect(names).toContain("gangtise_chiefs_search")
    expect(names).toContain("gangtise_institution_search")
    expect(names).toContain("gangtise_fund_flow")
    expect(names).toContain("gangtise_stock_summary")
    expect(names).toContain("gangtise_income_statement_us")
    expect(names).toContain("gangtise_balance_sheet_us")
    expect(names).toContain("gangtise_cash_flow_us")
    expect(names).toContain("gangtise_announcement_us_list")
    expect(names).toContain("gangtise_announcement_us_download")
    expect(names).toContain("gangtise_indicator_search")
    expect(names).toContain("gangtise_indicator_cross_section")
    expect(names).toContain("gangtise_indicator_time_series")

    // Should have a substantial number of tools
    expect(tools.length).toBeGreaterThan(40)
  })

  it("keeps date-sensitive tool metadata free of startup-date literals", async () => {
    const { tools } = await mcpClient.listTools()
    const metadata = JSON.stringify(tools)

    expect(metadata).toContain("gangtise_current_date")
    expect(metadata).not.toMatch(/当前日期\s+\d{4}-\d{2}-\d{2}/)
    expect(metadata).not.toMatch(/当前年份\s+\d{4}/)
  })

  it("marks tools read-only except the billed async submit tools", async () => {
    const { tools } = await mcpClient.listTools()
    const nonReadOnly = tools.filter(t => t.annotations?.readOnlyHint !== true).map(t => t.name).sort()
    // Async submit tools create a billed, non-idempotent task (endpoints carry
    // retry: "no-replay"), so they must NOT be read-only — clients shouldn't
    // auto-invoke them unconfirmed.
    // Their _check polling tools stay read-only.
    expect(nonReadOnly).toEqual(["gangtise_earnings_review", "gangtise_viewpoint_debate"])
    // Every tool hits a single closed-domain API (or local data), never the open
    // world — so all declare openWorldHint: false.
    expect(tools.every(t => t.annotations?.openWorldHint === false)).toBe(true)
  })

  it("declares date guidance once in server instructions, not per-tool descriptions", async () => {
    expect(mcpClient.getInstructions()).toContain("gangtise_current_date")

    const { tools } = await mcpClient.listTools()
    const metadata = JSON.stringify(tools)
    const copies = metadata.split("先调用 gangtise_current_date").length - 1
    expect(copies).toBe(0)
  })

  // tools/list 是**每次请求都进客户模型上下文**的一段字节，且没有任何协议机制去重：
  // 每个工具的 inputSchema 是独立 JSON 文档，客户端不会跨工具解析 $ref。所以一句话写在
  // N 个参数描述上就付 N 遍，而 instructions 是唯一只付一遍的通道。
  //
  // 下面三条守的是这个结构，不是审美：
  //   ① 搬进 instructions 的话不得在工具侧复现（复现 = 白付 N-1 遍）
  //   ② $schema 方言声明必须被剥掉（97 × 47B，客户端不读它）
  //   ③ 总量有天花板，撞了要有人**主动**决定抬，而不是悄悄涨
  // 🔴 发布出去的每个 inputSchema 必须自包含：不带 $ref，客户端无需解引用就能读全。
  // zod-to-json-schema 按**实例同一性**去重，schemas.ts 的 nonEmptyString 是共享单例，
  // 于是同一工具里后续用到它的参数被折成指向「它第一次出现的位置」的指针 —— 落点由属性
  // 声明顺序决定，语义完全不相干（securityCodeList.items 曾指向 paramKey）。
  // 🔴 生成式：遍历**发布出去的** schema，断言「允许空数组的位置」恰好是下面这四条，
  // 不多不少。
  //
  // 为什么不能靠人工扫描：上一轮改 `minItems` 时靠人工扫源码，跨行写法（`z\n  .array(...)`）
  // 整批漏网，`qa_list` 的 `source: []` 因此照样下发。判据必须落在 tools/list 的实际产物上。
  //
  // 为什么按**完整路径**而不是属性名：按名字放行会顺带放过将来任何工具里的同名数组 ——
  // 而且 `time_series` 的 `parameters` 其实是有 `minItems: 1` 的（它走 `.min(1)` 那个分支），
  // 按名字白名单会把它一起豁免，那一天它丢了下限也没人知道。
  //
  // 为什么判据是 `minItems >= 1` 而不是 `!== undefined`：`minItems: 0` 同样接受空数组。
  //
  // 这四条都是 EDE 的**嵌套**参数数组：那里 `[]` 与省略同为「没有分指标参数」，而调用方
  // 常是程序化拼出来的。顶层筛选不一样，`[]` 会静默放开筛选并按条计费。
  const EMPTY_ARRAY_ALLOWED = [
    "gangtise_indicator_cross_section.properties.indicatorParamList",
    "gangtise_indicator_cross_section.properties.indicatorParamList.items.properties.parameters",
    "gangtise_indicator_time_series.properties.indicatorParamList",
    "gangtise_indicator_screener.properties.indicatorList.items.properties.parameters",
  ]

  it("allows empty arrays at exactly the four declared nested-parameter paths", async () => {
    const { tools } = await mcpClient.listTools()
    const unbounded: string[] = []

    const walk = (node: unknown, tool: string, path: string) => {
      if (node === null || typeof node !== "object") return
      if (Array.isArray(node)) return node.forEach((n, i) => walk(n, tool, `${path}[${i}]`))
      const obj = node as Record<string, unknown>
      if (obj.type === "array" && !(typeof obj.minItems === "number" && obj.minItems >= 1)) {
        unbounded.push(`${tool}${path}`)
      }
      for (const [k, v] of Object.entries(obj)) walk(v, tool, `${path}.${k}`)
    }
    for (const t of tools) walk(t.inputSchema, t.name, "")

    // 集合相等，两个方向都钉：多出来的是「新增了一个接受 [] 的筛选数组」（空列表下发
    // 等于没加该筛选，返回未经筛选的全量并按条计费）；少掉的是「某条例外被收紧了」，
    // 那多半是好事，但要求同步改这份名单，免得它慢慢变成一张没人看的过期白名单。
    expect(unbounded.sort()).toEqual([...EMPTY_ARRAY_ALLOWED].sort())
  })

  it("publishes self-contained schemas: no $ref, no $schema dialect", async () => {
    const { tools } = await mcpClient.listTools()
    const wire = JSON.stringify(tools)
    expect(wire.split('"$ref"').length - 1, "inputSchema 里残留了 $ref").toBe(0)
    expect(wire.split('"$schema"').length - 1).toBe(0)

    // 展开后的落点必须是真正的类型，而不是原来那个语义无关的指针目标。
    const byName = new Map(tools.map((t) => [t.name, t.inputSchema as Record<string, any>]))
    expect(byName.get("gangtise_indicator_screener")!.properties.securityCodeList.items)
      .toEqual({ type: "string", minLength: 1 })
    expect(byName.get("gangtise_day_kline")!.properties.security.anyOf[0])
      .toEqual({ type: "string", minLength: 1 })
    // 展开不能吃掉同级的 description（$ref 旁边的兄弟键优先）
    expect(byName.get("gangtise_opinion_list")!.properties.endTime.pattern).toMatch(/^\^\(/)
  })

  // 识别指引挂在**路由推荐的**工具上，而不是标着「建议改用」的两个 legacy 工具。
  it("puts the code-identity warning on the tools routing actually recommends", async () => {
    const byName = new Map((await mcpClient.listTools()).tools.map((t) => [t.name, t.description ?? ""]))
    for (const n of ["gangtise_day_kline", "gangtise_realtime"]) {
      expect(byName.get(n), `${n} 缺少 A+H 同名识别指引`).toContain("A+H")
    }
    for (const n of ["gangtise_day_kline_hk", "gangtise_day_kline_us"]) {
      expect(byName.get(n)!.length, `${n} 是 legacy 工具，不该再背长警示`).toBeLessThan(200)
    }
  })

  it("keeps instruction-level guidance out of per-tool metadata", async () => {
    const instructions = mcpClient.getInstructions() ?? ""
    const { tools } = await mcpClient.listTools()
    const metadata = JSON.stringify(tools)

    // 每条：[曾经逐工具重复的原文, instructions 里现在承载它的锚点]
    const moved: [string, string][] = [
      ["0-based 起始偏移，默认 0", "from=0-based 偏移"],
      ["总行数上限，默认 20", "size=总行数上限"],
      ["拉取全部页并忽略 size，可能较慢或产生大响应", "fetchAll=true 拉全部页"],
      ["1=综合排序", "rankType=1 综合排序"],
      ["consolidated=合并 |", "reportType(三表口径,数组)=consolidated 合并"],
      // 分页付费列表的按条计费声明：曾逐字挂在 19 个工具描述上。
      ["按全部实际返回条目计费", "按实际返回条目计费"],
    ]
    for (const [perTool, inInstructions] of moved) {
      expect(instructions).toContain(inInstructions)
      expect(metadata.split(perTool).length - 1).toBe(0)
    }

    // 日期格式：instructions 按 *Date / *Time 命名统一声明，参数上不再复述。
    // 只钉「整条描述就是格式串」的那种；indicator 的 date 参数把格式当前缀、后面还接
    // 端点独有的下发规则，那是单端点细节，本就该留在参数上。
    expect(instructions).toContain("*Date=YYYY-MM-DD")
    expect(metadata.split(`"description":"YYYY-MM-DD"`).length - 1).toBe(0)
    expect(metadata.split(`"description":"YYYY-MM-DD HH:mm:ss"`).length - 1).toBe(0)
  })

  it("strips the $schema dialect declaration from every published inputSchema", async () => {
    const { tools } = await mcpClient.listTools()

    // 剥的是方言声明，不是 schema 本身 —— properties/type/additionalProperties 必须都还在，
    // 否则就不是省字节而是发了个空契约。
    for (const tool of tools) {
      expect(tool.inputSchema).toBeDefined()
      expect(tool.inputSchema).not.toHaveProperty("$schema")
      expect(tool.inputSchema.type).toBe("object")
    }
    const withParams = tools.filter(t => Object.keys(t.inputSchema.properties ?? {}).length > 0)
    expect(withParams.length).toBeGreaterThan(80)
    expect(withParams.every(t => t.inputSchema.additionalProperties === false)).toBe(true)
  })

  it("keeps the tools/list payload under its context budget", async () => {
    const { tools } = await mcpClient.listTools()
    const bytes = Buffer.byteLength(JSON.stringify(tools), "utf8")

    // 天花板不是「当前值 + 1」——留了增长余量，新增工具不该动它。撞上了说明该先看
    // 重复度（scripts/prerelease-check.mjs 的 ⑤ 会列出最大的几个工具），确认省无可省之后
    // 再**主动**抬这个数字并说明为什么。悄悄涨回去才是要拦的事。
    expect(bytes).toBeLessThan(150_000)
  })

  it("gangtise_current_date returns runtime Asia/Shanghai date context", async () => {
    const result = await mcpClient.callTool({ name: "gangtise_current_date", arguments: {} })
    expect(result.isError).toBeFalsy()

    const text = (result.content as Array<{ text: string }>)[0].text
    const parsed = JSON.parse(text)

    expect(parsed).toMatchObject({
      timezone: "Asia/Shanghai",
      currentDate: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
      currentYear: expect.stringMatching(/^\d{4}$/),
      currentDateTime: expect.stringMatching(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/),
    })
  })

  it("gangtise_lookup returns data for each type", async () => {
    const types = ["broker-orgs", "meeting-orgs"]
    for (const type of types) {
      const result = await mcpClient.callTool({ name: "gangtise_lookup", arguments: { type } })
      expect(result.isError).toBeFalsy()
      const text = (result.content as Array<{ text: string }>)[0].text
      const parsed = JSON.parse(text)
      expect(Array.isArray(parsed)).toBe(true)
    }
  })

  it("gangtise_lookup rejects unknown type", async () => {
    const result = await mcpClient.callTool({ name: "gangtise_lookup", arguments: { type: "nonexistent" } })
    // Schema validation should reject this — result will be an error
    expect(result.isError).toBe(true)
  })

  it("gangtise_lookup rejects types retired in favor of the constants API", async () => {
    for (const type of ["research-areas", "industries", "regions", "announcement-categories", "theme-ids", "industry-codes"]) {
      const result = await mcpClient.callTool({ name: "gangtise_lookup", arguments: { type } })
      expect(result.isError).toBe(true)
    }
  })

  it("gangtise_constant_list calls the constants endpoint with category", async () => {
    await mcpClient.callTool({ name: "gangtise_constant_list", arguments: { category: "citicIndustry" } })
    expect(mockClient.call).toHaveBeenCalledWith(
      "reference.constant-list",
      expect.objectContaining({ category: "citicIndustry" }),
    )
  })

  it("gangtise_concept_search calls the concepts endpoint with keyword", async () => {
    await mcpClient.callTool({ name: "gangtise_concept_search", arguments: { keyword: "机器人", top: 3 } })
    expect(mockClient.call).toHaveBeenCalledWith(
      "reference.concept-search",
      expect.objectContaining({ keyword: "机器人", top: 3 }),
    )
  })

  it("gangtise_sector_constituents calls the sectors endpoint with sectorId", async () => {
    await mcpClient.callTool({ name: "gangtise_sector_constituents", arguments: { sectorId: "1000001005" } })
    expect(mockClient.call).toHaveBeenCalledWith(
      "reference.sector-constituents",
      expect.objectContaining({ sectorId: "1000001005" }),
    )
  })

  it("gangtise_concept_search rejects an empty keyword before calling the API", async () => {
    const result = await mcpClient.callTool({ name: "gangtise_concept_search", arguments: { keyword: "" } })
    expect(result.isError).toBe(true)
    expect(mockClient.call).not.toHaveBeenCalled()
  })

  it("gangtise_concept_search rejects a whitespace-only keyword before calling the API", async () => {
    const result = await mcpClient.callTool({ name: "gangtise_concept_search", arguments: { keyword: "   " } })
    expect(result.isError).toBe(true)
    expect(mockClient.call).not.toHaveBeenCalled()
  })

  it("gangtise_securities_search rejects an empty keyword before calling the API", async () => {
    const result = await mcpClient.callTool({ name: "gangtise_securities_search", arguments: { keyword: "" } })
    expect(result.isError).toBe(true)
    expect(mockClient.call).not.toHaveBeenCalled()
  })

  it("gangtise_sector_constituents rejects an empty sectorId before calling the API", async () => {
    const result = await mcpClient.callTool({ name: "gangtise_sector_constituents", arguments: { sectorId: "" } })
    expect(result.isError).toBe(true)
    expect(mockClient.call).not.toHaveBeenCalled()
  })

  it("gangtise_constant_list rejects an unknown category before calling the API", async () => {
    const result = await mcpClient.callTool({ name: "gangtise_constant_list", arguments: { category: "foo" } })
    expect(result.isError).toBe(true)
    expect(mockClient.call).not.toHaveBeenCalled()
  })

  it("schedule list tools accept locationList", async () => {
    await mcpClient.callTool({ name: "gangtise_roadshow_list", arguments: { locationList: ["10001"] } })
    expect(mockClient.call).toHaveBeenCalledWith(
      "insight.roadshow.list",
      expect.objectContaining({ locationList: ["10001"] }),
    )
  })

  it("schedule list tools expose only API-spec-supported business fields", async () => {
    const { tools } = await mcpClient.listTools()
    const props = (name: string) => {
      const t = tools.find(x => x.name === name)
      return Object.keys((t?.inputSchema as { properties?: Record<string, unknown> })?.properties ?? {})
    }

    // strategy: only institution / location (+ shared paginated/time/keyword/from/size)
    expect(props("gangtise_strategy_list")).toEqual(expect.arrayContaining(["institutionList", "locationList"]))
    expect(props("gangtise_strategy_list")).not.toContain("researchAreaList")
    expect(props("gangtise_strategy_list")).not.toContain("securityList")
    expect(props("gangtise_strategy_list")).not.toContain("categoryList")
    expect(props("gangtise_strategy_list")).not.toContain("participantRoleList")

    // forum: only researchArea / location
    expect(props("gangtise_forum_list")).toEqual(expect.arrayContaining(["researchAreaList", "locationList"]))
    expect(props("gangtise_forum_list")).not.toContain("securityList")
    expect(props("gangtise_forum_list")).not.toContain("institutionList")

    // site-visit: has object, dropped participantRole / brokerType
    expect(props("gangtise_site_visit_list")).toEqual(expect.arrayContaining(["objectList"]))
    expect(props("gangtise_site_visit_list")).not.toContain("participantRoleList")
    expect(props("gangtise_site_visit_list")).not.toContain("brokerTypeList")

    // roadshow: full set, no object
    expect(props("gangtise_roadshow_list")).toEqual(
      expect.arrayContaining([
        "researchAreaList", "institutionList", "securityList", "categoryList",
        "marketList", "participantRoleList", "brokerTypeList", "permission", "locationList",
      ]),
    )
    expect(props("gangtise_roadshow_list")).not.toContain("objectList")
  })

  it("gangtise_announcement_list no longer exposes the server-ignored announcementTypeList", async () => {
    const { tools } = await mcpClient.listTools()
    const ann = tools.find(t => t.name === "gangtise_announcement_list")
    const keys = Object.keys((ann?.inputSchema as { properties?: Record<string, unknown> })?.properties ?? {})
    expect(keys).toContain("categoryList")
    expect(keys).not.toContain("announcementTypeList")
  })

  it("categoryList enums are locked to the API-verified sets and reject unknown values before the client", async () => {
    const { tools } = await mcpClient.listTools()
    const catEnum = (name: string): string[] | undefined => {
      const t = tools.find(x => x.name === name)
      const props = (t?.inputSchema as { properties?: Record<string, { items?: { enum?: string[] } }> })?.properties
      return props?.categoryList?.items?.enum
    }

    // Empirically verified against the live API + CLI insight.md — lock so a later
    // describe-text edit can't silently drop/rename a value (the old bogus
    // expertInterview / quantitative are exactly how this drifted before).
    expect(catEnum("gangtise_summary_list")).toEqual([
      "earningsCall", "strategyMeeting", "fundRoadshow", "shareholdersMeeting",
      "maMeeting", "specialMeeting", "companyAnalysis", "industryAnalysis", "other",
    ])
    const researchSet = [
      "macro", "strategy", "industry", "company", "bond", "quant", "morningNotes",
      "fund", "forex", "futures", "options", "warrants", "market", "wealthManagement", "other",
    ]
    expect(catEnum("gangtise_research_list")).toEqual(researchSet)
    expect(catEnum("gangtise_foreign_report_list")).toEqual(researchSet)

    // An unknown category must be rejected at the MCP schema boundary and never
    // forwarded upstream (where it silently no-ops and returns the full table).
    const res = await mcpClient.callTool({
      name: "gangtise_summary_list",
      arguments: { categoryList: ["expertInterview"] },
    })
    expect(res.isError).toBeTruthy()
    expect(mockClient.call).not.toHaveBeenCalled()
  })

  it("gangtise_official_account_list forwards documented filters with default size", async () => {
    await mcpClient.callTool({
      name: "gangtise_official_account_list",
      arguments: { categoryList: ["report"], searchType: 2, accountIdList: ["acc-1"] },
    })
    expect(mockClient.call).toHaveBeenCalledWith(
      "insight.official-account.list",
      expect.objectContaining({ categoryList: ["report"], searchType: 2, accountIdList: ["acc-1"], size: 20 }),
    )
  })

  it("gangtise_official_account_download downloads the article by articleId", async () => {
    ;(mockClient.download as ReturnType<typeof vi.fn>).mockResolvedValue({ text: "article body", contentType: "text/plain" })
    const result = await mcpClient.callTool({
      name: "gangtise_official_account_download",
      arguments: { articleId: "art-1", fileType: 1 },
    })
    expect(result.isError).toBeFalsy()
    const [endpointArg, queryArg] = (mockClient.download as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(endpointArg.key).toBe("insight.official-account.download")
    expect(queryArg).toMatchObject({ articleId: "art-1", fileType: 1 })
  })

  it("gangtise_opinion_list calls API with default size: 20", async () => {
    await mcpClient.callTool({ name: "gangtise_opinion_list", arguments: {} })
    expect(mockClient.call).toHaveBeenCalledWith(
      "insight.opinion.list",
      expect.objectContaining({ size: 20 }),
    )
  })

  it("gangtise_opinion_list respects explicit size", async () => {
    await mcpClient.callTool({ name: "gangtise_opinion_list", arguments: { size: 5 } })
    expect(mockClient.call).toHaveBeenCalledWith(
      "insight.opinion.list",
      expect.objectContaining({ size: 5 }),
    )
  })

  it("gangtise_income_statement does not add size", async () => {
    await mcpClient.callTool({ name: "gangtise_income_statement", arguments: { securityCode: "600519.SH" } })
    const callArg = (mockClient.call as ReturnType<typeof vi.fn>).mock.calls[0][1] as Record<string, unknown>
    expect(callArg).not.toHaveProperty("size")
  })

  it("gangtise_concept_info calls concept-info endpoint with conceptId", async () => {
    await mcpClient.callTool({ name: "gangtise_concept_info", arguments: { conceptId: "121000130" } })
    expect(mockClient.call).toHaveBeenCalledWith(
      "alternative.concept-info",
      expect.objectContaining({ conceptId: "121000130" }),
    )
  })

  it("gangtise_concept_securities calls concept-securities endpoint with conceptId", async () => {
    await mcpClient.callTool({ name: "gangtise_concept_securities", arguments: { conceptId: "121000130" } })
    expect(mockClient.call).toHaveBeenCalledWith(
      "alternative.concept-securities",
      expect.objectContaining({ conceptId: "121000130" }),
    )
  })

  it("gangtise_theme_tracking normalizes a single type to the backend array shape", async () => {
    await mcpClient.callTool({
      name: "gangtise_theme_tracking",
      arguments: { themeId: "121000130", date: today(), type: "morning" },
    })
    expect(mockClient.call).toHaveBeenCalledWith(
      "ai.theme-tracking",
      expect.objectContaining({ themeId: "121000130", date: today(), type: ["morning"] }),
    )
  })

  it("gangtise_theme_tracking rejects malformed dates before calling the API", async () => {
    const result = await mcpClient.callTool({
      name: "gangtise_theme_tracking",
      arguments: { themeId: "121000130", date: "2026-13-99" },
    })

    expect(result.isError).toBe(true)
    // Rejected at the zod schema boundary since the X5 tightening (previously a
    // runtime ValidationError inside the handler) — match either message shape.
    expect((result.content as Array<{ text: string }>)[0].text).toMatch(/无效日期|格式须为/)
    expect(mockClient.call).not.toHaveBeenCalled()
  })

  it("gangtise_day_kline rejects non-positive limits before calling the API", async () => {
    const result = await mcpClient.callTool({
      name: "gangtise_day_kline",
      arguments: { security: "600519.SH", limit: 0 },
    })

    expect(result.isError).toBe(true)
    expect(mockClient.call).not.toHaveBeenCalledWith("quote.day-kline", expect.anything())
  })

  it("gangtise_earnings_review submits then polls until content arrives", async () => {
    vi.mocked(mockClient.call).mockImplementation(async (key: string) => {
      if (key === "ai.earnings-review.get-id") return { dataId: "task-1" }
      if (key === "ai.earnings-review.get-content") return { content: "# 业绩点评" }
      throw new Error(`unexpected endpoint: ${key}`)
    })

    const result = await mcpClient.callTool({
      name: "gangtise_earnings_review",
      arguments: { securityCode: "600519.SH", period: "2026q1" },
    })

    expect(result.isError).toBeFalsy()
    expect((result.content as Array<{ text: string }>)[0].text).toBe("# 业绩点评")
    expect(mockClient.call).toHaveBeenCalledWith("ai.earnings-review.get-id", { securityCode: "600519.SH", period: "2026q1" })
    expect(mockClient.call).toHaveBeenCalledWith("ai.earnings-review.get-content", { dataId: "task-1" })
  })

  it("gangtise_earnings_review_check reports pending on 410110 instead of erroring", async () => {
    const { ApiError } = await import("../../src/core/errors.js")
    vi.mocked(mockClient.call).mockRejectedValue(new ApiError("processing", "410110"))

    const result = await mcpClient.callTool({
      name: "gangtise_earnings_review_check",
      arguments: { dataId: "task-1" },
    })

    expect(result.isError).toBeFalsy()
    expect(JSON.parse((result.content as Array<{ text: string }>)[0].text)).toEqual({ status: "pending", dataId: "task-1" })
  })

  it("tools return isError on API failure", async () => {
    vi.mocked(mockClient.call).mockRejectedValueOnce(new Error("network error"))
    const result = await mcpClient.callTool({ name: "gangtise_opinion_list", arguments: {} })
    expect(result.isError).toBe(true)
    expect((result.content as Array<{ text: string }>)[0].text).toContain("network error")
  })

  it("gangtise_stock_summary rejects an empty securityList before calling the API", async () => {
    const result = await mcpClient.callTool({ name: "gangtise_stock_summary", arguments: { securityList: [] } })
    expect(result.isError).toBe(true)
    expect(mockClient.call).not.toHaveBeenCalled()
  })

  it("gangtise_stock_summary rejects blank-string entries in securityList", async () => {
    const result = await mcpClient.callTool({ name: "gangtise_stock_summary", arguments: { securityList: ["   "] } })
    expect(result.isError).toBe(true)
    expect(mockClient.call).not.toHaveBeenCalled()
  })

  it("gangtise_stock_summary forwards securityList to the stock-summary endpoint", async () => {
    await mcpClient.callTool({ name: "gangtise_stock_summary", arguments: { securityList: ["600519.SH"] } })
    expect(mockClient.call).toHaveBeenCalledWith(
      "ai.stock-summary.list",
      expect.objectContaining({ securityList: ["600519.SH"] }),
    )
  })

  it("gangtise_chiefs_search forwards keyword to the chiefs endpoint", async () => {
    await mcpClient.callTool({ name: "gangtise_chiefs_search", arguments: { keyword: "张三", top: 5 } })
    expect(mockClient.call).toHaveBeenCalledWith(
      "reference.chiefs-search",
      expect.objectContaining({ keyword: "张三", top: 5 }),
    )
  })

  it("gangtise_institution_search forwards keyword and categoryList to the institutions endpoint", async () => {
    await mcpClient.callTool({
      name: "gangtise_institution_search",
      arguments: { keyword: "中金", categoryList: ["domesticBroker"], top: 5 },
    })
    expect(mockClient.call).toHaveBeenCalledWith(
      "reference.institution-search",
      expect.objectContaining({ keyword: "中金", categoryList: ["domesticBroker"], top: 5 }),
    )
  })

  it("gangtise_institution_search rejects an unknown category before calling the API", async () => {
    const result = await mcpClient.callTool({
      name: "gangtise_institution_search",
      arguments: { keyword: "中金", categoryList: ["bogusCategory"] },
    })
    expect(result.isError).toBe(true)
    expect(mockClient.call).not.toHaveBeenCalled()
  })

  it("gangtise_announcement_us_list forwards filters with default size: 20", async () => {
    await mcpClient.callTool({
      name: "gangtise_announcement_us_list",
      arguments: { securityList: ["TSLA.O"], categoryList: ["103980001"] },
    })
    expect(mockClient.call).toHaveBeenCalledWith(
      "insight.announcement-us.list",
      expect.objectContaining({ securityList: ["TSLA.O"], categoryList: ["103980001"], size: 20 }),
    )
  })

  it("gangtise_announcement_hk_download now accepts a fileType query param", async () => {
    ;(mockClient.download as ReturnType<typeof vi.fn>).mockResolvedValue({ text: "ann body", contentType: "text/plain" })
    const result = await mcpClient.callTool({
      name: "gangtise_announcement_hk_download",
      arguments: { announcementId: "ann-1", fileType: 2 },
    })
    expect(result.isError).toBeFalsy()
    const [endpointArg, queryArg] = (mockClient.download as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(endpointArg.key).toBe("insight.announcement-hk.download")
    expect(queryArg).toMatchObject({ announcementId: "ann-1", fileType: 2 })
  })

  it("gangtise_indicator_search rejects an empty keyword before calling the API", async () => {
    const result = await mcpClient.callTool({ name: "gangtise_indicator_search", arguments: { keyword: "" } })
    expect(result.isError).toBe(true)
    expect(mockClient.call).not.toHaveBeenCalled()
  })

  it("gangtise_indicator_cross_section unwraps the inner envelope and flattens to a wide table", async () => {
    vi.mocked(mockClient.call).mockResolvedValueOnce({
      code: "000000",
      status: true,
      data: {
        securityCodeList: ["600519.SH"],
        securityNameList: ["贵州茅台"],
        indicatorList: [{ code: "qte_close", name: "收盘价", dataType: "number" }],
        values: [[1800]],
      },
    })
    const result = await mcpClient.callTool({
      name: "gangtise_indicator_cross_section",
      arguments: { indicatorCodeList: ["qte_close"], securityCodeList: ["600519.SH"], date: "2026-06-26" },
    })
    expect(result.isError).toBeFalsy()
    // 2026-08-01 契约：securityCodeList → universe，根级 date → 每指标 tradeDate。
    expect(mockClient.call).toHaveBeenCalledWith(
      "indicator.cross-section",
      expect.objectContaining({
        indicatorCodeList: ["qte_close"],
        universe: ["600519.SH"],
        indicatorParamList: [{ indicatorCode: "qte_close", parameters: [{ paramKey: "tradeDate", paramValue: "2026-06-26" }] }],
      }),
    )
    const parsed = JSON.parse((result.content as Array<{ text: string }>)[0].text)
    expect(parsed.list[0]).toMatchObject({ security: "600519.SH", name: "贵州茅台", 收盘价: 1800 })
  })

  it("gangtise_indicator_cross_section rejects an empty indicatorCodeList before calling the API", async () => {
    const result = await mcpClient.callTool({
      name: "gangtise_indicator_cross_section",
      arguments: { indicatorCodeList: [], securityCodeList: ["600519.SH"], date: "2026-06-26" },
    })
    expect(result.isError).toBe(true)
    expect(mockClient.call).not.toHaveBeenCalled()
  })

  it("gangtise_indicator_time_series rejects an omitted securityCodeList before calling the API", async () => {
    const result = await mcpClient.callTool({
      name: "gangtise_indicator_time_series",
      arguments: { indicatorCodeList: ["qte_close"], startDate: "2026-06-25", endDate: "2026-06-26" },
    })
    expect(result.isError).toBe(true)
    expect(mockClient.call).not.toHaveBeenCalled()
  })

  it("gangtise_independent_opinion_download forwards independentOpinionId (not opinionId) to the API", async () => {
    ;(mockClient.download as ReturnType<typeof vi.fn>).mockResolvedValue({ text: "opinion html", contentType: "text/html" })
    const result = await mcpClient.callTool({
      name: "gangtise_independent_opinion_download",
      arguments: { independentOpinionId: "9959358", fileType: 1 },
    })
    expect(result.isError).toBeFalsy()
    const [endpointArg, queryArg] = (mockClient.download as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(endpointArg.key).toBe("insight.independent-opinion.download")
    expect(queryArg).toMatchObject({ independentOpinionId: "9959358", fileType: 1 })
  })

  it("gangtise_independent_opinion_download rejects the old opinionId param name", async () => {
    const result = await mcpClient.callTool({
      name: "gangtise_independent_opinion_download",
      arguments: { opinionId: "9959358", fileType: 1 },
    })
    expect(result.isError).toBe(true)
  })

  it("gangtise_one_pager returns a friendly note when the AI content is empty", async () => {
    ;(mockClient.call as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ content: "" })
    const result = await mcpClient.callTool({ name: "gangtise_one_pager", arguments: { securityCode: "600519.SH" } })
    expect(result.isError).toBeFalsy()
    expect((result.content as Array<{ text: string }>)[0].text).toContain("暂无")
  })

  // 🔴 预算钉的是 **instructions + tools/list 的合计**，不是单钉 instructions。
  //
  // 单钉 instructions 会奖励一个错误的动作：把一句话从 instructions 挪回 22 个工具的参数
  // 描述里，instructions 的数字变好看了，而模型实际读到的字节**多了 21 倍**。
  // 2026-08-30 的那次调整正是反方向：instructions +587B，换来 tools/list −11,668B，
  // 净省 11,081B —— 合计预算能如实反映这笔交易，单项预算会把它误判成回退。
  //
  // 两个数字都记下来，便于下次判断增量落在哪一侧；合计是硬闸门。
  it("keeps the model-facing context within budget (instructions + tools/list)", async () => {
    const instructions = mcpClient.getInstructions() ?? ""
    const { tools } = await mcpClient.listTools()
    const instrBytes = Buffer.byteLength(instructions, "utf8")
    const listBytes = Buffer.byteLength(JSON.stringify(tools), "utf8")

    // instructions 单项仍有上界：它是**每次会话都全量注入**的，不该无限长。
    expect(instrBytes, "instructions 超出单项上界").toBeLessThanOrEqual(2_600)
    // 合计才是模型真正付的钱。当前 147,142B，留约 3% 余量。
    expect(instrBytes + listBytes, `合计上下文 ${instrBytes + listBytes}B（instructions ${instrBytes} + tools/list ${listBytes}）超出预算`)
      .toBeLessThanOrEqual(152_000)
  })

  it("routes with real tool prefixes, not src filenames", async () => {
    const instructions = mcpClient.getInstructions() ?? ""
    // vault / reference 是文件名不是工具名 —— 模型照此检索会扑空
    expect(instructions).not.toContain("vault_")
    expect(instructions).not.toContain("reference_")
    // 真实存在的前缀
    const names = (await mcpClient.listTools()).tools.map((t) => t.name)
    for (const stem of ["drive_", "record_", "my_conference_", "wechat_", "stock_pool_"]) {
      expect(instructions).toContain(stem)
      expect(names.some((n) => n.startsWith(`gangtise_${stem}`))).toBe(true)
    }
  })

  it("makes no unproven universal claims", () => {
    const instructions = mcpClient.getInstructions() ?? ""
    // 只有 theme-tracking 一个端点被证明会发 110003，edb_data 实测反证
    expect(instructions).not.toContain("110003")
    // resourceType=40 证明下载器接受观点资源，「不可下载」是错的
    expect(instructions).not.toContain("不可下载")
  })

  it("routes multi-security financial/valuation batches to EDE", () => {
    const instructions = mcpClient.getInstructions() ?? ""
    // 批量走 EDE 截面/时序（旧文案是「优先专用工具」，不含此完整串 —— 弱断言 "indicator_*(" 在旧码即通过）
    expect(instructions).toContain("indicator_*(EDE) 截面/时序")
    // 计费总则给出批量例外，避免与「优先免费/低价」自相矛盾
    expect(instructions).toContain("除①批量外，优先免费/低价")
  })

  it("declares the billing-label convention that lets free tools stay unlabelled", () => {
    expect(mcpClient.getInstructions() ?? "").toContain("未标注即免费")
  })
})

// 未知入参必须**报错**，不能被静默剥掉。
//
// 非 strict 时 SDK 在进 handler 之前就 strip 掉未声明的键，于是「传了个没人认识的
// 参数」变成一次**没有该筛选条件的正常调用**：isError=false、按条计费、返回全量。
// 而我们发布的 JSON Schema 写的是 additionalProperties:false —— 契约声明拒绝、行为
// 却静默接受。财报日历 2026-08-08 换日期字段名时，沿用旧名的调用方就是这样静默拿到
// 12.8 万行全库切片的。
//
// 这层保护挂在 createGangtiseMcpServer 上（server.ts 的 enforceStrictInput），所以
// **只有集成测试覆盖得到**——各单元测试自己 new McpServer，绕过它。别把这些用例挪走。
describe("strict input schemas", () => {
  const connect = async () => {
    const client = makeMockClient()
    const server = createGangtiseMcpServer(client)
    const [ct, st] = InMemoryTransport.createLinkedPair()
    await server.connect(st)
    const mcp = new Client({ name: "t", version: "0" })
    await mcp.connect(ct)
    return { mcp, client }
  }

  // 三条注册路径各取一个：registerJsonTool / registerDownloadTool / 直接 server.registerTool。
  it.each([
    ["registry-driven", "gangtise_research_list", { keyword: "茅台", bogusKey: "x" }],
    ["download", "gangtise_research_download", { reportId: "1", bogusKey: "x" }],
    ["direct", "gangtise_performance_calendar_list", { bogusKey: "x" }],
    ["direct", "gangtise_indicator_cross_section", { indicatorCodeList: ["qte_close"], securityCodeList: ["600519.SH"], date: "2026-08-07", bogusKey: "x" }],
  ] as Array<[string, string, Record<string, unknown>]>)(
    "%s tool %s rejects an unknown key without spending a call",
    async (_path, name, args) => {
      const { mcp, client } = await connect()
      const result = await mcp.callTool({ name, arguments: args }).catch(() => ({ isError: true }))
      expect((result as { isError?: boolean }).isError).toBe(true)
      expect(client.call).not.toHaveBeenCalled()
      expect(client.download).not.toHaveBeenCalled()
    },
  )

  // 财报日历的旧日期名是这条保护最现实的触发点（服务端 2026-08-08 换了接受的字段名）。
  it("rejects the calendar's superseded startTime/endTime by name", async () => {
    const { mcp, client } = await connect()
    const result = await mcp.callTool({
      name: "gangtise_performance_calendar_list",
      arguments: { startTime: "2026-07-20", endTime: "2026-07-25" },
    }).catch(() => ({ isError: true }))
    expect((result as { isError?: boolean }).isError).toBe(true)
    expect(client.call).not.toHaveBeenCalled()
  })

  // 合法入参必须照常通过——strict 不能误伤。
  it.each([
    ["gangtise_research_list", { keyword: "茅台" }],
    ["gangtise_performance_calendar_list", { startDate: "2026-07-20", endDate: "2026-07-25" }],
  ] as Array<[string, Record<string, unknown>]>)("%s still accepts its declared params", async (name, args) => {
    const { mcp, client } = await connect()
    const result = await mcp.callTool({ name, arguments: args })
    expect(result.isError).toBeFalsy()
    expect(client.call).toHaveBeenCalledTimes(1)
  })
})

// 根级 strict 只管最外层。嵌套对象（indicatorParamList 的元素、screener 的
// indicatorList 元素、parameters 的键值对）也必须拒未知键——把 `parameters` 误写成
// `parameterList` 是很常见的，非 strict 时它被静默剥掉、请求照发，body 里 adjustType
// 整个消失，客户要后复权价却拿到不复权价（与 adjustmentType 写错名同一类静默错数）。
describe("strict nested objects", () => {
  const connect = async () => {
    const client = makeMockClient()
    const server = createGangtiseMcpServer(client)
    const [ct, st] = InMemoryTransport.createLinkedPair()
    await server.connect(st)
    const mcp = new Client({ name: "t", version: "0" })
    await mcp.connect(ct)
    return { mcp, client }
  }
  const CS = { indicatorCodeList: ["qte_close"], securityCodeList: ["600519.SH"], date: "2026-08-07" }
  const SCR = { expression: "F1 > 0", securityCodeList: ["600519.SH"], date: "2026-08-07" }

  it.each([
    ["screener 元素误写 parameterList", "gangtise_indicator_screener", { ...SCR, indicatorList: [{ field: "F1", indicatorCode: "qte_close", parameterList: [{ paramKey: "adjustType", paramValue: "3" }] }] }],
    ["截面元素误写 paramList", "gangtise_indicator_cross_section", { ...CS, indicatorParamList: [{ indicatorCode: "qte_close", paramList: [{ paramKey: "adjustType", paramValue: "3" }] }] }],
    ["键值对多一个键", "gangtise_indicator_cross_section", { ...CS, indicatorParamList: [{ indicatorCode: "qte_close", parameters: [{ paramKey: "adjustType", paramValue: "3", bogus: 1 }] }] }],
  ] as Array<[string, string, Record<string, unknown>]>)("%s is rejected without calling upstream", async (_l, name, args) => {
    const { mcp, client } = await connect()
    const result = await mcp.callTool({ name, arguments: args }).catch(() => ({ isError: true }))
    expect((result as { isError?: boolean }).isError).toBe(true)
    expect(client.call).not.toHaveBeenCalled()
  })

  it("still accepts the correct nested spelling", async () => {
    const { mcp, client } = await connect()
    const result = await mcp.callTool({
      name: "gangtise_indicator_cross_section",
      arguments: { ...CS, indicatorParamList: [{ indicatorCode: "qte_close", parameters: [{ paramKey: "adjustType", paramValue: "3" }] }] },
    })
    expect(client.call).toHaveBeenCalledTimes(1)
    const body = (client.call as ReturnType<typeof vi.fn>).mock.calls[0][1] as Record<string, unknown>
    const groups = body.indicatorParamList as Array<{ parameters: Array<{ paramKey: string }> }>
    expect(groups[0].parameters.map((p) => p.paramKey)).toContain("adjustType")
    // 不断言 isError：mock 返回的不是合法 EDE 矩阵，requireIndicatorMatrix 会拒。
    // 这里要验的是「合法嵌套写法能通过 schema 并把 adjustType 带到 body 里」，上面两条已够。
    void result
  })
})

// 闭集参数的负向测试。上游对非法枚举**静默 no-op 返回未过滤的全量**（A2），
// 所以 schema 层是唯一防线——漏一个字段，客户 agent 就会以为过滤生效、实得全库，
// 且按条计费。
// 当前全部闭集参数（工具名去掉 gangtise_ 前缀）。遍历是自动的，这份快照只负责
// 挡「悄悄退回自由类型」——见文件末尾的集合断言。
const CLOSED_SET_SNAPSHOT = [
    "lookup.type",
    "securities_search.category",
    "institution_search.categoryList",
    "official_account_search.category",
    "constant_list.category",
    "opinion_list.rankType",
    "opinion_list.llmTagList",
    "opinion_list.sourceList",
    "summary_list.searchType",
    "summary_list.rankType",
    "summary_list.categoryList",
    "summary_list.marketList",
    "summary_list.participantRoleList",
    "summary_list.sourceList",
    "pamirs_summary_list.searchType",
    "pamirs_summary_list.rankType",
    "pamirs_summary_list.categoryList",
    "pamirs_summary_list.marketList",
    "roadshow_list.categoryList",
    "roadshow_list.marketList",
    "roadshow_list.participantRoleList",
    "roadshow_list.brokerTypeList",
    "roadshow_list.permission",
    "site_visit_list.objectList",
    "site_visit_list.categoryList",
    "site_visit_list.marketList",
    "site_visit_list.permission",
    "research_list.searchType",
    "research_list.rankType",
    "research_list.categoryList",
    "research_list.llmTagList",
    "research_list.ratingList",
    "research_list.ratingChangeList",
    "research_list.sourceList",
    "foreign_report_list.searchType",
    "foreign_report_list.rankType",
    "foreign_report_list.categoryList",
    "foreign_report_list.regionList",
    "foreign_report_list.llmTagList",
    "foreign_report_list.ratingList",
    "foreign_report_list.ratingChangeList",
    "announcement_list.searchType",
    "announcement_list.rankType",
    "announcement_hk_list.searchType",
    "announcement_hk_list.rankType",
    "announcement_us_list.searchType",
    "announcement_us_list.rankType",
    "foreign_opinion_list.rankType",
    "foreign_opinion_list.regionList",
    "foreign_opinion_list.ratingList",
    "foreign_opinion_list.ratingChangeList",
    "independent_opinion_list.rankType",
    "independent_opinion_list.ratingList",
    "independent_opinion_list.ratingChangeList",
    "official_account_list.searchType",
    "official_account_list.rankType",
    "official_account_list.categoryList",
    "qa_list.answerImportant",
    "summary_download.fileType",
    "pamirs_summary_download.fileType",
    "research_download.fileType",
    "foreign_report_download.fileType",
    "announcement_download.fileType",
    "announcement_hk_download.fileType",
    "announcement_us_download.fileType",
    "independent_opinion_download.fileType",
    "official_account_download.fileType",
    "performance_calendar_list.marketList",
    "performance_calendar_list.categoryList",
    "income_statement.period",
    "income_statement.reportType",
    "income_statement_quarterly.period",
    "income_statement_quarterly.reportType",
    "balance_sheet.period",
    "balance_sheet.reportType",
    "cash_flow.period",
    "cash_flow.reportType",
    "cash_flow_quarterly.period",
    "cash_flow_quarterly.reportType",
    "main_business.breakdown",
    "main_business.periodList",
    "main_business.fieldList",
    "top_holders.holderType",
    "top_holders.period",
    "earning_forecast.consensusList",
    "income_statement_hk.period",
    "income_statement_hk.reportType",
    "balance_sheet_hk.period",
    "balance_sheet_hk.reportType",
    "cash_flow_hk.period",
    "cash_flow_hk.reportType",
    "income_statement_us.period",
    "income_statement_us.reportType",
    "balance_sheet_us.period",
    "balance_sheet_us.reportType",
    "cash_flow_us.period",
    "cash_flow_us.reportType",
    "valuation_analysis.indicator",
    "valuation_analysis.fieldList",
    "knowledge_batch.resourceTypes",
    "knowledge_batch.knowledgeNames",
    "security_clue_list.queryMode",
    "security_clue_list.source",
    "hot_topic.categoryList",
    "management_discuss_announcement.discussionDimension",
    "management_discuss_earnings_call.discussionDimension",
    "knowledge_resource_download.resourceType",
    "drive_list.fileTypeList",
    "drive_list.spaceTypeList",
    "record_list.categoryList",
    "record_list.spaceTypeList",
    "my_conference_list.categoryList",
    "my_conference_list.sourceList",
    "wechat_message_list.categoryList",
    "wechat_message_list.tagList",
    "record_download.contentType",
    "my_conference_download.contentType",
    "indicator_cross_section.currency",
    "indicator_cross_section.scale",
    "indicator_time_series.calendarType",
    "indicator_time_series.currency",
    "indicator_time_series.scale",
]

describe("closed-set params reject illegal values before calling upstream", () => {
  // **用例由 live schema 自动生成；字段清单由 CLOSED_SET_SNAPSHOT 维护**——
  // 新增和消失都会响亮失败。两者分工不同，别把它当成「全自动、零维护」：
  // 快照仍要手工补行，只是补漏的代价从「悄悄没测」变成了「一条点名的红」。
  //
  // 之所以拆成这两层，是因为手工表连续三轮出现「又漏了 N 个」：先漏数字型闭集，
  // 再漏 helper 生成的字段（scheduleInputSchema 按 fields.* 拼出来的），再漏标量 enum。
  // 根因不是粗心，是「新增闭集参数时记得往表里加一行」这条规则**同时**决定了
  // 「测不测它」和「有没有人知道漏了」——忘一次，两件事一起没了。
  //
  // 拆开之后：遍历 listTools() 的每个闭集参数（数组元素 enum、标量 enum、字面量联合）
  // 逐个断言非法值在**发请求之前**被拒，所以新参数**当场就被测到**，不依赖谁记得；
  // 快照只管另一件事——某个参数从闭集退回自由类型时点名报出来。
  //
  // 每个用例都配**正向对照**（同一组入参、只把被测字段换成合法值 → 必须打通）。
  // 没有它，用例会因为缺必填参数而红、看着绿却根本没测到枚举——本轮之前就漏过两条。
  const enumValuesOf = (v: Record<string, unknown>): unknown[] | undefined => {
    const item = (v.items ?? v) as Record<string, unknown>
    if (Array.isArray(item.enum)) return item.enum
    if (Array.isArray(item.anyOf) && item.anyOf.every((x) => (x as Record<string, unknown>).const !== undefined)) {
      return (item.anyOf as Array<Record<string, unknown>>).map((x) => x.const)
    }
    return undefined
  }
  const isArrayParam = (v: Record<string, unknown>) => v.type === "array"

  // 用 schema 的 required 列表合成一组「除被测字段外完全合法」的入参。
  const fillRequired = (schema: Record<string, unknown>, skip: string) => {
    const props = (schema.properties ?? {}) as Record<string, Record<string, unknown>>
    const required = (schema.required ?? []) as string[]
    const args: Record<string, unknown> = {}
    for (const key of required) {
      if (key === skip) continue
      const v = props[key] ?? {}
      const vals = enumValuesOf(v)
      const one = vals ? vals[0] : /^(reportDate|period)$|报告期/i.test(key) ? "2026-06-30" : /Date$/i.test(key) ? "2026-08-07" : /Time$/i.test(key) ? "2026-08-07 00:00:00"
        : /securityCode|security$/i.test(key) ? "600519.SH" : v.type === "number" || v.type === "integer" ? 1
        : v.type === "boolean" ? false : "1"
      args[key] = isArrayParam(v) ? [one] : one
    }
    return args
  }

  it("rejects an illegal value for every closed-set param, and accepts the legal one", async () => {
    // 复用同一对连接、每例 mockClear。此前每个断言各建一个 server（120 个参数 = 240 个实例），
    // 单文件跑得过、全量并行下超 5s 默认超时——一个只在并行时红的用例比没有更糟。
    const client = makeMockClient()
    const probe = await makeTestClient(client)
    const calls = () =>
      (client.call as ReturnType<typeof vi.fn>).mock.calls.length +
      (client.download as ReturnType<typeof vi.fn>).mock.calls.length
    const reset = () => {
      ;(client.call as ReturnType<typeof vi.fn>).mockClear()
      ;(client.download as ReturnType<typeof vi.fn>).mockClear()
    }
    const invoke = async (name: string, args: Record<string, unknown>) => {
      reset()
      const r = await probe.callTool({ name, arguments: args }).catch(() => ({ isError: true, content: [] }))
      return {
        isError: (r as { isError?: boolean }).isError,
        called: calls(),
        why: String((r as { content?: Array<{ text?: string }> }).content?.[0]?.text ?? "").slice(0, 120),
      }
    }

    const checked: string[] = []
    const skipped: string[] = []
    for (const tool of (await probe.listTools()).tools) {
      const schema = tool.inputSchema as unknown as Record<string, unknown>
      const props = (schema.properties ?? {}) as Record<string, Record<string, unknown>>
      for (const [key, spec] of Object.entries(props)) {
        const vals = enumValuesOf(spec)
        if (!vals || vals.length === 0) continue
        const base = fillRequired(schema, key)
        const wrap = (v: unknown) => (isArrayParam(spec) ? [v] : v)

        // ② 正向对照先跑：换成合法值必须打通。打不通说明这条用例的「红」另有原因
        //    （多半是必填参数没合成对），那它就证明不了枚举——记为 skipped 而不是假绿。
        const good = await invoke(tool.name, { ...base, [key]: wrap(vals[0]) })
        if (good.isError) { skipped.push(`${tool.name}.${key} :: ${good.why}`); continue }

        // ① 非法值必须在发请求之前被拒
        const bad = await invoke(tool.name, { ...base, [key]: wrap(typeof vals[0] === "number" ? 987654 : "__bogus__") })
        expect(bad.isError, `${tool.name}.${key}：非法值应被拒`).toBe(true)
        expect(bad.called, `${tool.name}.${key}：非法值不得调用上游`).toBe(0)
        checked.push(`${tool.name}.${key}`)
      }
    }

    // 一个都不许跳过。跳过 = 正向对照没打通 = 这条用例的「红」另有原因，证明不了枚举。
    // 故意做成硬失败而不是 warn：新工具带来合成不了的必填参数时，要么补合成规则、
    // 要么补 mock 形状，不能让覆盖率悄悄掉下去——本条断言存在的全部理由就是这个。
    expect(skipped, "正向对照未通过（补 fillRequired 规则或 makeMockClient 形状）").toEqual([])
    // 另一个方向：某个参数从闭集退回自由类型（z.enum → z.string）后会直接从遍历结果里
    // **消失**，skipped 仍是空、用例照绿。计数下限挡不住这个——退一个同时加一个，数还是平的。
    // 所以钉的是集合本身：少了哪个、多了哪个，diff 直接把名字报出来。
    // 新增闭集参数要往 CLOSED_SET_SNAPSHOT 补一行——但那是**响亮的红**，
    // 跟手工表时代「忘了加 = 悄悄没测」是两回事。
    const now = checked.map((x) => x.replace(/^gangtise_/, ""))
    expect(
      CLOSED_SET_SNAPSHOT.filter((x) => !now.includes(x)),
      "闭集参数消失了——多半是 z.enum 退回了 z.string，非法值将被原样透传给上游",
    ).toEqual([])
    expect(
      now.filter((x) => !CLOSED_SET_SNAPSHOT.includes(x)),
      "新增了闭集参数（已自动测到），补进 CLOSED_SET_SNAPSHOT 即可",
    ).toEqual([])
  })
})


// 🔴 **从 tools/list 自动枚举**，不手选样本。
//
// 手选样本只能证明它自己：上一版手写了 10 个空白串用例，跨 session 复核当场找出 6 个漏网
// （`sector_search.keyword`、`sector_constituents.sectorId`、`qa.source` /
// `qa.questionCategory`、`pamirs.researchAreaList`、EDE 的 `paramKey` / 选股
// `indicatorCode`）。要钉住「全部收紧了」这条**声明**，判据必须自己去枚举。
//
// ⚠️ 枚举必须**递归进嵌套对象**：`paramKey` 住在 `indicatorParamList[].parameters[]` 里，
// 只扫顶层的版本对它是瞎的（实测：把 paramKey 退回 `z.string().min(1)`，只扫顶层的判据
// 照样全绿）。
describe("no blank string reaches upstream (enumerated from tools/list)", () => {
  type Node = Record<string, any>
  const deref = (schema: Node, root: Node): Node => {
    if (!schema?.$ref) return schema ?? {}
    const path = String(schema.$ref).replace(/^#\//, "").split("/")
    let cur: any = root
    for (const seg of path) cur = cur?.[seg]
    return cur ?? {}
  }

  /** 造一份最小合法值；把 `blankAt` 指向的那个叶子换成纯空白。 */
  const build = (schema: Node, root: Node, path: string, blankAt: string | null): any => {
    const s = deref(schema, root)
    for (const key of ["anyOf", "oneOf", "allOf"]) {
      // union 取第一个分支造样本；空白负例由 blankAt 命中叶子时替换
      if (Array.isArray(s[key]) && s[key].length > 0) return build(s[key][0] as Node, root, path, blankAt)
    }
    if (s.type === "array") return [build(s.items ?? {}, root, path, blankAt)]
    if (s.type === "object" || s.properties) {
      const out: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(s.properties ?? {})) {
        const child = `${path}.${k}`
        if ((s.required ?? []).includes(k) || blankAt?.startsWith(child)) {
          out[k] = build(v as Node, root, child, blankAt)
        }
      }
      return out
    }
    if (s.type === "number" || s.type === "integer") return s.minimum ?? 1
    if (s.type === "boolean") return false
    if (s.enum) return s.enum[0]
    if (path === blankAt) return "   "
    if (s.pattern) return "2026-08-07"
    return "x"
  }

  /** 递归收集所有「自由字符串」叶子路径（排除 enum / pattern / 有意开放的 paramValue）。 */
  const leaves = (schema: Node, root: Node, path: string, acc: string[]): void => {
    const s = deref(schema, root)
    // 🔴 union（`anyOf`/`oneOf`）必须递归进去。第一版没进，于是 `security` 这种
    // 「字符串或字符串数组」的参数完全没被扫到 —— 复核方把它两个分支都退回普通
    // `z.string()`，判据照样全绿，而 `{security:["   "]}` 真的把空白发到了上游。
    for (const key of ["anyOf", "oneOf", "allOf"]) {
      if (Array.isArray(s[key])) {
        for (const branch of s[key]) leaves(branch as Node, root, path, acc)
        return
      }
    }
    if (s.type === "array") return leaves(s.items ?? {}, root, path, acc)
    if (s.type === "object" || s.properties) {
      for (const [k, v] of Object.entries(s.properties ?? {})) leaves(v as Node, root, `${path}.${k}`, acc)
      return
    }
    if (s.type === "string" && !s.enum && !s.pattern && !path.endsWith(".paramValue")) acc.push(path)
  }

  it("rejects a whitespace-only value in every free-string parameter, nested ones included", async () => {
    const probe = await makeTestClient(makeMockClient())
    const { tools } = await probe.listTools()
    const leaked: string[] = []
    let checked = 0

    for (const tool of tools) {
      const root = tool.inputSchema as Node
      const props: Record<string, Node> = root?.properties ?? {}
      const required: string[] = root?.required ?? []
      const paths: string[] = []
      for (const [k, v] of Object.entries(props)) leaves(v, root, k, paths)

      for (const target of paths) {
        checked += 1
        const client = makeMockClient()
        const mcp = await makeTestClient(client)
        const args: Record<string, unknown> = {}
        const top = target.split(".")[0]
        for (const r of new Set([...required, top])) args[r] = build(props[r], root, r, target)

        const r = await mcp.callTool({ name: tool.name, arguments: args })
        const reached = (client.call as any).mock.calls.length > 0 || (client.download as any).mock.calls.length > 0
        if (reached && !r.isError) leaked.push(`${tool.name}.${target}`)
      }
    }

    expect(checked, "没有枚举到足够的自由字符串入参，判据自身失效了").toBeGreaterThan(70)
    expect(leaked, `这些入参把纯空白原样下发了：\n  ${leaked.join("\n  ")}`).toEqual([])
  })

  // fieldList 重名会在按位置拍平时相互覆盖：长度校验对得上，结果里静默少一列。
  it("rejects a duplicated fieldList entry", async () => {
    const client = await makeTestClient(makeMockClient())
    const r = await client.callTool({
      name: "gangtise_day_kline",
      arguments: { security: "600519.SH", fieldList: ["close", "close"] },
    })
    expect(r.isError).toBe(true)
    expect((r.content as Array<{ text: string }>)[0].text).toMatch(/fieldList 不能重复/)
  })
})

// 起始晚于结束此前只有 knowledge_batch 一处校验，其余带区间的工具直接下发。服务端有
// 110002，但不是每个端点都用它——有的把倒置区间当成空条件返回未筛结果，按条计费。
//
// ⚠️ 同样**枚举**而不是手写名单：上一版手写了 4 个，其中 `gangtise_research_list` 收的是
// `startTime/endTime` 而我传的是 `startDate/endDate`，被 strict schema 挡下 —— 测试因为
// **错误的原因**变绿，把日期校验整个删掉都不红。
describe("inverted date ranges are rejected before the request goes out", () => {
  const PAIRS = [["startDate", "endDate", "2026-08-10", "2026-08-01"], ["startTime", "endTime", "2026-08-10 00:00:00", "2026-08-01 00:00:00"]] as const

  it("covers every tool exposing a start/end pair", async () => {
    const probe = await makeTestClient(makeMockClient())
    const { tools } = await probe.listTools()
    const missed: string[] = []
    let checked = 0

    for (const tool of tools) {
      const root = tool.inputSchema as Record<string, any>
      const props: Record<string, any> = root?.properties ?? {}
      const required: string[] = root?.required ?? []
      for (const [sk, ek, sv, ev] of PAIRS) {
        if (!props[sk] || !props[ek]) continue
        checked += 1
        const client = makeMockClient()
        const mcp = await makeTestClient(client)
        const args: Record<string, unknown> = { [sk]: sv, [ek]: ev }
        for (const r of required) {
          if (r === sk || r === ek) continue
          const p = props[r]
          args[r] = p.type === "array" ? ["600519.SH"] : p.enum ? p.enum[0] : p.type === "number" || p.type === "integer" ? 1 : p.pattern ? "2026-08-07" : "600519.SH"
        }
        const r = await mcp.callTool({ name: tool.name, arguments: args })
        if (!r.isError || (client.call as any).mock.calls.length > 0) missed.push(`${tool.name}[${sk}/${ek}]`)
      }
    }

    expect(checked, "没有枚举到带区间的工具，判据自身失效了").toBeGreaterThan(40)
    expect(missed, `这些工具接受了倒置区间：\n  ${missed.join("\n  ")}`).toEqual([])
  })
})

// 🔴 **示例即断言。** 申万代码全 31 个都是 801xxx.SWI（sectorId=2000000014 实测 2026-08-30），
// 821xxx 是**中信**(.CI) 的前缀。此前四处文案把 SWI 讲成 821xxx，两处给的例子
// `821035.SWI` 在 securities-search 里根本查不到——照抄它拿到的是 total:0 的**静默空表**，
// 比本地拒绝隐蔽得多（day-kline 与 index-day-kline 都返 0 行且不报错）。
//
// ⚠️ 这条必须放在**注册了全部工具**的 integration 层。第一版写在 quote.test.ts 里，那里
// 只注册行情工具，于是把 ai.ts 的同款错误示例写回去，判据照样全绿（实测）。
// 判据扫哪些工具，取决于那个 describe 连的是哪个 server —— 别想当然。
describe("SWI example codes are real", () => {
  // 🔴 **`README.md` / `CHANGELOG.md` 也在 npm tarball 里**（`package.json#files` 列了它们），
  // 客户会从功能覆盖表里直接复制代码。复核方就是在这两个文件里又找出两处 `821xxx.SWI`
  // ——我只扫了工具元数据。守卫的覆盖面要跟着「客户能读到哪些字」走，不是「我改了哪些文件」。
  //
  // ⚠️ 例外：**对照说明**（同一行里既写 801 又写 821，在讲「821 是错的」）必须放行，
  // 否则修复记录本身会把守卫打红。判据是「这一行有没有同时出现 801xxx」，是个启发式：
  // 若将来有人写出一行既对照又发码的文案，它会漏。真要发码请另起一行。
  it.each(["README.md", "CHANGELOG.md"])("%s hands out no non-801 申万 code", async (file) => {
    const text = fs.readFileSync(path.join(process.cwd(), file), "utf8")
    const offenders = text.split("\n")
      .map((line, i) => ({ line, no: i + 1 }))
      .filter(({ line }) => !line.includes("801xxx"))
      .flatMap(({ line, no }) => (line.match(/\b(?!801)\d{6}\.SWI|\b(?!801)\d{3}xxx\.SWI/g) ?? []).map((m) => `${file}:${no} ${m}`))
    expect(offenders, `文档里给出了不存在的申万代码：\n  ${offenders.join("\n  ")}`).toEqual([])
  })

  it("never hands out a non-801 申万 code (821xxx belongs to .CI)", async () => {
    const client = await makeTestClient(makeMockClient())
    const { tools } = await client.listTools()
    expect(tools.length).toBeGreaterThan(90)
    for (const tool of tools) {
      const blob = `${tool.description ?? ""}${JSON.stringify(tool.inputSchema)}`
      const bad = blob.match(/\b(?!801)\d{6}\.SWI|\b(?!801)\d{3}xxx\.SWI/g) ?? []
      expect(bad, `${tool.name} 给出了不存在的申万代码：${bad.join(" ")}`).toEqual([])
    }
  })
})
