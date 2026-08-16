import { describe, it, expect, vi } from "vitest"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { registerQuoteTools } from "../../../src/tools/quote.js"
import type { GangtiseClient } from "../../../src/core/client.js"

function makeMockClient() {
  return {
    call: vi.fn().mockResolvedValue({ list: [] }),
    download: vi.fn(),
  } as unknown as GangtiseClient
}

async function connect(client: GangtiseClient) {
  const server = new McpServer({ name: "test", version: "0.0.0" })
  registerQuoteTools(server, client)
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  const mcp = new Client({ name: "test", version: "0.0.1" })
  await mcp.connect(clientTransport)
  return mcp
}

// A malformed date used to slip past the bare z.string() schema, then fail
// parseDate() inside quoteSharding, which silently fell back to a single capped
// request for security='all' — losing market rows with no _partial marker.
describe("gangtise_day_kline date validation", () => {
  it("rejects a non-zero-padded date for security='all' without calling the API", async () => {
    const client = makeMockClient()
    const mcp = await connect(client)
    const result = await mcp.callTool({
      name: "gangtise_day_kline",
      arguments: { security: "aShares", startDate: "2026-4-1", endDate: "2026-04-30" },
    })
    expect(result.isError).toBe(true)
    expect(client.call).not.toHaveBeenCalled()
  })

  it("rejects a regex-passing but invalid calendar date (month 13) without calling the API", async () => {
    const client = makeMockClient()
    const mcp = await connect(client)
    const result = await mcp.callTool({
      name: "gangtise_day_kline",
      arguments: { security: "aShares", startDate: "2026-13-45", endDate: "2026-12-31" },
    })
    expect(result.isError).toBe(true)
    expect(client.call).not.toHaveBeenCalled()
  })

  // JS Date silently rolls these over (2026-02-30 -> 2026-03-02), so a bare
  // !isNaN check passes them and security='all' sharding queries the wrong date.
  it("rejects a calendar-impossible day (Feb 30) that JS Date would roll over", async () => {
    const client = makeMockClient()
    const mcp = await connect(client)
    const result = await mcp.callTool({
      name: "gangtise_day_kline",
      arguments: { security: "aShares", startDate: "2026-02-30", endDate: "2026-12-31" },
    })
    expect(result.isError).toBe(true)
    expect(client.call).not.toHaveBeenCalled()
  })

  it("rejects the 31st of a 30-day month (Apr 31)", async () => {
    const client = makeMockClient()
    const mcp = await connect(client)
    const result = await mcp.callTool({
      name: "gangtise_day_kline",
      arguments: { security: "aShares", startDate: "2026-04-31", endDate: "2026-12-31" },
    })
    expect(result.isError).toBe(true)
    expect(client.call).not.toHaveBeenCalled()
  })

  // A whole-market keyword with only one date can't shard, but must still go through
  // the sharding helper so the 10000-row limit lift applies — otherwise the
  // raw body is sent and upstream silently truncates at its 6000 default.
  it("lifts the limit for a whole-market keyword when endDate is omitted", async () => {
    const client = makeMockClient()
    const mcp = await connect(client)
    const result = await mcp.callTool({
      name: "gangtise_day_kline",
      arguments: { security: "aShares", startDate: "2026-04-01" },
    })
    expect(result.isError).toBeFalsy()
    expect(client.call).toHaveBeenCalledTimes(1)
    const body = (client.call as ReturnType<typeof vi.fn>).mock.calls[0][1] as Record<string, unknown>
    expect(body.limit).toBe(10_000)
  })

  it("accepts a leap-day (2024-02-29) and calls the API", async () => {
    const client = makeMockClient()
    const mcp = await connect(client)
    const result = await mcp.callTool({
      name: "gangtise_day_kline",
      arguments: { security: "600519.SH", startDate: "2024-02-29", endDate: "2024-03-31" },
    })
    expect(result.isError).toBeFalsy()
    expect(client.call).toHaveBeenCalledTimes(1)
  })

  it("accepts a well-formed date and calls the API", async () => {
    const client = makeMockClient()
    const mcp = await connect(client)
    const result = await mcp.callTool({
      name: "gangtise_day_kline",
      arguments: { security: "600519.SH", startDate: "2026-04-01", endDate: "2026-04-30" },
    })
    expect(result.isError).toBeFalsy()
    expect(client.call).toHaveBeenCalledTimes(1)
  })
})

// An .HK code sent to a US-only tool used to reach upstream and return a silent
// empty list — indistinguishable from "no data". The precheck rejects the clear
// mismatch and names the tool that does cover it, without spending an API call.
// gangtise_day_kline itself is exempt: it covers all three markets plus indices,
// so a suffix check there would reject valid queries.
describe("gangtise_day_kline market-mismatch precheck", () => {
  it("passes an HK code straight through on the unified tool (no suffix check)", async () => {
    const client = makeMockClient()
    const mcp = await connect(client)
    const result = await mcp.callTool({
      name: "gangtise_day_kline",
      arguments: { security: "00700.HK", startDate: "2026-04-01", endDate: "2026-04-30" },
    })
    expect(result.isError).toBeFalsy()
    expect(client.call).toHaveBeenCalledTimes(1)
  })

  it("passes a mixed A-share / HK / US / index list through in one request", async () => {
    const client = makeMockClient()
    const mcp = await connect(client)
    const result = await mcp.callTool({
      name: "gangtise_day_kline",
      arguments: { security: ["600519.SH", "00700.HK", "AAPL.O", "000001.SH"], startDate: "2026-04-01", endDate: "2026-04-30" },
    })
    expect(result.isError).toBeFalsy()
    const body = (client.call as ReturnType<typeof vi.fn>).mock.calls[0][1] as Record<string, unknown>
    expect(body.securityList).toEqual(["600519.SH", "00700.HK", "AAPL.O", "000001.SH"])
  })

  it("rejects an A-share code on the US tool and points at the unified tool, no API call", async () => {
    const client = makeMockClient()
    const mcp = await connect(client)
    const result = await mcp.callTool({
      name: "gangtise_day_kline_us",
      arguments: { security: "600519.SH", startDate: "2026-04-01", endDate: "2026-04-30" },
    })
    expect(result.isError).toBe(true)
    expect((result.content as Array<{ text: string }>)[0].text).toContain("gangtise_day_kline")
    expect(client.call).not.toHaveBeenCalled()
  })

  it("passes a matching code and an unknown suffix through to the API", async () => {
    const client = makeMockClient()
    const mcp = await connect(client)
    const ok = await mcp.callTool({
      name: "gangtise_day_kline_hk",
      arguments: { security: "00700.HK", startDate: "2026-04-01", endDate: "2026-04-30" },
    })
    const unknown = await mcp.callTool({
      name: "gangtise_day_kline",
      arguments: { security: "600519.XYZ", startDate: "2026-04-01", endDate: "2026-04-30" },
    })
    expect(ok.isError).toBeFalsy()
    expect(unknown.isError).toBeFalsy()
    expect(client.call).toHaveBeenCalledTimes(2)
  })
})

// The whole-market keyword layer. Which keyword a tool takes differs, and both wrong
// forms are invisible upstream: the unified day K-line / realtime / fund-flow answer a
// bare 120001 that points at the codes, and fund-flow silently drops a keyword mixed
// with codes and returns only the codes.
describe("quote market keywords", () => {
  it("rejects the retired 'all' on the unified day-kline and names the replacements", async () => {
    const client = makeMockClient()
    const mcp = await connect(client)
    const result = await mcp.callTool({
      name: "gangtise_day_kline",
      arguments: { security: "all", startDate: "2026-04-01", endDate: "2026-04-30" },
    })
    expect(result.isError).toBe(true)
    const text = (result.content as Array<{ text: string }>)[0].text
    expect(text).toContain("aShares")
    expect(text).toContain("hkStocks")
    expect(text).toContain("usStocks")
    expect(client.call).not.toHaveBeenCalled()
  })

  it("still accepts 'all' on the market-specific day-kline tools", async () => {
    const client = makeMockClient()
    const mcp = await connect(client)
    const hk = await mcp.callTool({ name: "gangtise_day_kline_hk", arguments: { security: "all", startDate: "2026-04-01" } })
    const idx = await mcp.callTool({ name: "gangtise_index_day_kline", arguments: { security: "all", startDate: "2026-04-01" } })
    expect(hk.isError).toBeFalsy()
    expect(idx.isError).toBeFalsy()
  })

  it.each([
    ["gangtise_day_kline", ["aShares", "600519.SH"]],
    ["gangtise_day_kline", ["aShares", "hkStocks"]],
    ["gangtise_fund_flow", ["aShares", "600519.SH"]],
    ["gangtise_realtime", ["aShares", "600519.SH"]],
  ])("rejects a keyword mixed with other securities on %s", async (tool, security) => {
    const client = makeMockClient()
    const mcp = await connect(client)
    const result = await mcp.callTool({ name: tool, arguments: { security, startDate: "2026-04-01", endDate: "2026-04-30" } })
    expect(result.isError).toBe(true)
    expect((result.content as Array<{ text: string }>)[0].text).toContain("单独传")
    expect(client.call).not.toHaveBeenCalled()
  })

  it("rejects a market keyword on gangtise_realtime that this API does not take", async () => {
    const client = makeMockClient()
    const mcp = await connect(client)
    const result = await mcp.callTool({ name: "gangtise_realtime", arguments: { security: "all" } })
    expect(result.isError).toBe(true)
    expect(client.call).not.toHaveBeenCalled()
  })

  // 🔴 Canonicalisation is load-bearing on fund-flow specifically: that endpoint takes
  // only the literal `aShares` and answers `ashares` with 120001, so folding the case is
  // the difference between a working query and a hard error. Deleting
  // canonicalizeKeywords must turn this red.
  it("canonicalises a lower-cased keyword before sending it (fund-flow is case-sensitive upstream)", async () => {
    const client = {
      call: vi.fn().mockResolvedValue({ list: [{ x: 1 }], total: 1 }),
      download: vi.fn(),
    } as unknown as GangtiseClient
    const mcp = await connect(client)
    const result = await mcp.callTool({
      name: "gangtise_fund_flow",
      arguments: { security: "ashares", startDate: "2026-04-01", endDate: "2026-04-01" },
    })
    expect(result.isError).toBeFalsy()
    const body = (client.call as ReturnType<typeof vi.fn>).mock.calls[0][1] as Record<string, unknown>
    expect(body.securityList).toEqual(["aShares"])
  })

  // On the K-line tools the same folding keeps the shard lookup in step: an
  // un-canonicalised variant falls through to ONE unsharded request instead of N shards.
  it("shards a lower-cased keyword instead of degrading to a single request", async () => {
    const client = {
      call: vi.fn().mockResolvedValue({ list: [{ x: 1 }], total: 1 }),
      download: vi.fn(),
    } as unknown as GangtiseClient
    const mcp = await connect(client)
    await mcp.callTool({
      name: "gangtise_day_kline",
      arguments: { security: "ASHARES", startDate: "2026-04-01", endDate: "2026-04-03" },
    })
    expect(client.call).toHaveBeenCalledTimes(3)
  })
})

// 🔴 The unified day K-line and realtime endpoints answer a 中信行业指数 (.CI) code with
// 120001「证券代码无效」 even though the code is valid and gangtise_securities_search hands
// it out as category:"index". Only gangtise_index_day_kline serves .CI. Descriptions that
// list .CI alongside .SWI as "supported" send the caller to an error whose text blames the
// code — the exact failure mode the keyword guards exist to prevent.
describe("industry index routing (.CI vs .SWI)", () => {
  // 按**面**取，不要把 description 和 inputSchema 拼成一个串再断言：拼串只要求「两个面
  // 里至少一个还带着这句声明」，于是「只翻转主描述、参数描述不动」这种局部编辑照样全绿，
  // 留下一份自相矛盾的描述（主描述说可传、参数描述说不支持）。
  const surfaces = async (name: string) => {
    const mcp = await connect(makeMockClient())
    const tool = (await mcp.listTools()).tools.find((t) => t.name === name)!
    const schema = tool.inputSchema as { properties?: Record<string, { description?: string }> }
    return { description: tool.description ?? "", security: schema.properties?.security?.description ?? "" }
  }
  // 🔴 钉的是**绝对否定**，不是「.CI 附近出现『不支持』」。这条断言被绕过两次，每次都更窄：
  //   v1 共现（40 字内有「不支持」）→ 「支持 .CI，不支持 B 股」全绿
  //   v2 紧邻（.CI 后面就是「不支持」）→ 「.CI 不支持**与个股混传**」全绿
  // 两次的整句都在告诉模型「.CI 可以传」，而它无条件返 120001。
  //
  // 抓形态而不是抓关键词（不去猜「混传」「与个股」这类词）：
  //   **绝对否定后面是句读，部分否定后面是宾语。**
  // 所以要求那个「不支持」处在小句末尾——允许 markdown 标记与右括号，后面必须是标点或行尾。
  // 否定词做成**小闭集**（不支持 / 暂不支持 / 尚不支持），而不是放宽 .CI 与否定之间的间隙——
  // 放宽间隙会把「此前不支持」这类时间状语一起放进来，一条真回退就此漏网：那是**用一次假红
  // 换一个真洞**，亏的。「不再支持」有意不进闭集：它字面意思是「曾经支持过」，与「从来不支持」
  // 是两件事，红一下让人回来看一眼反而是对的。
  const SAYS_UNSUPPORTED = /\.CI(?:[）)]|[（(][^）)]{0,12}[）)])?\*{0,2}\s*(?:本接口)?\s*(?:暂|尚)?不支持\*{0,2}\s*(?=[，。；、]|$)|不支持[^，。；]{0,12}\.CI\s*[）)]?\s*(?=[，。；、]|$)/m
  // 否定后顾不可少：「不支持中信行业指数 .CI」里的「支持」不是肯定式，
  // 漏了它会把合法的改写（把否定提到句首）误判成回退。
  const SAYS_SUPPORTED = /(?<!不)支持[^，。；不]{0,12}\.CI/

  // 🔴 这两条正则改到第四版了，每一版都是在「假绿」和「假红」之间挪，而挪的方向对不对
  // **只能靠一张对照表判**——下面就是那张表。没有它的时候，一次「泛化以修掉误判」的改动
  // 当场就把一条真回退放了进来，而全套测试照样绿。
  // 改这两条正则时先跑这一段：**回退必红 + 合法改写必绿**，两个方向缺一不可。
  const says = (text: string) => SAYS_UNSUPPORTED.test(text) && !SAYS_SUPPORTED.test(text)
  it.each([
    // —— 合法改写：意思不变、说法不同，必须放行 ——
    // （「现行」那两条不写在这张表里，见下面单独一条——手打的样本会与线上文案脱节）
    ["否定提到句首", "⚠️ 本接口不支持中信行业指数 .CI，传了会报「证券代码无效」", true],
    ["暂不支持", "⚠️ 中信行业指数（.CI）本接口暂不支持，传了会报…", true],
    ["尚不支持", "⚠️ 中信行业指数（.CI）本接口尚不支持，传了会报…", true],
    ["括注放在代码后", "⚠️ **.CI（中信行业指数）**本接口不支持，传了会报…", true],
    ["括注 + 暂不支持", "⚠️ **.CI（中信行业指数）**本接口暂不支持，传了会报…", true],
    // —— 语义回退：整句在告诉模型「.CI 可以传」，必须拦下 ——
    ["回退：说成支持", "⚠️ 本接口支持中信行业指数 .CI，不支持 B 股（如 900938.SH）——请用…", false],
    ["回退：只否定某种用法", "⚠️ 中信行业指数 .CI 不支持与个股混传，单独一批查询即可；", false],
    ["回退：时间状语翻转", "⚠️ 中信行业指数 .CI 此前不支持，现已可以直接传。", false],
    ["回退：限制已取消", "⚠️ 中信行业指数 .CI 的限制已取消，可直接传。", false],
    ["回退：整句删掉", "⚠️ 查全部沪深京交易所指数请用 gangtise_index_day_kline。", false],
  ])("regex verdict — %s", (_label, text, expected) => {
    expect(says(text as string)).toBe(expected)
  })

  // 🔴 规则在上面那张表的注释里：**手打的近似真串不进这张表。**
  // 2026-08-16 就是这么栽的——表里混进一条去掉了粗体的「现行文案」
  // （`.CI（中信行业指数）本接口不支持`，而线上那句是 `**.CI（…）**本接口不支持`），
  // 于是在简化过的串上验出「全部符合预期」，真串仍然被误判。
  //
  // ⚠️ 这条用例本身**不提供额外覆盖**：它是下面 `BOTH surfaces` / realtime 两条的严格子集
  // （那两条一直就是运行时读真实 description / inputSchema 的，还多断言了替代路由）。
  // 实测：删掉本条再做语义回退变异，`BOTH surfaces` 照样红。留着它只是让「现行文案自己
  // 必须判 GREEN」这个意图独立可见，**别把「运行时取真串」这个保证记在它头上**——那个
  // 保证在它之前就有了，真正修掉问题的是把手打样本从表里删除。
  it("the live wording itself is judged GREEN on both surfaces", async () => {
    const { description, security } = await surfaces("gangtise_day_kline")
    expect(says(description)).toBe(true)
    expect(says(security)).toBe(true)
    const rt = await surfaces("gangtise_realtime")
    expect(says(rt.security)).toBe(true)
  })

  // known-gap：绝对否定小句完整保留、下一小句翻转，能穿过去。挡它要看整句而不是小句，
  // 代价远大于收益，而这种写法本身很别扭。记在这里，别当成没发现。
  it("known gap: a following clause can reverse it", () => {
    expect(says("⚠️ 中信行业指数 .CI 不支持，这条限制已解除，现在可以直接传。")).toBe(true)
  })

  // 🔴 断言必须是**正向**的（「说了 .CI 不支持」），不能写成否定当前措辞
  // （`not.toContain(".CI/.SWI")` 之类）。否定措辞只挡得住「把旧字符串抄回来」，挡不住
  // 有人换个自然说法把 .CI 说回支持——实测那样改动全套测试照样绿。正向断言反过来：
  // 要重新声明支持，就必须先删掉这句话，一删就红。钉的是**声明**，不是措辞。
  // day-kline 两个面都带着这句声明，所以两个面各钉一条：翻转任意一个都必红。
  it("gangtise_day_kline states .CI is unsupported on BOTH surfaces", async () => {
    const { description, security } = await surfaces("gangtise_day_kline")
    expect(description).toMatch(SAYS_UNSUPPORTED)
    expect(security).toMatch(SAYS_UNSUPPORTED)
    expect(description).not.toMatch(SAYS_SUPPORTED)
    expect(security).not.toMatch(SAYS_SUPPORTED)
    // 光说「不支持」不够——必须点名替代路由，否则模型只知道此路不通、不知道去哪查。
    expect(description).toContain("gangtise_index_day_kline")
  })

  // realtime 的声明只住在 security 参数描述里（模型正是在那里读该传什么代码），
  // 所以只钉那一个面——对着 description 断言会要求它重复一遍同样的话。
  it("gangtise_realtime states .CI is unsupported on its security param", async () => {
    const { security } = await surfaces("gangtise_realtime")
    expect(security).toMatch(SAYS_UNSUPPORTED)
    expect(security).not.toMatch(SAYS_SUPPORTED)
    expect(security).toContain("gangtise_index_day_kline")
  })

  it("gangtise_index_day_kline claims .CI as a reason it is kept", async () => {
    const { description } = await surfaces("gangtise_index_day_kline")
    expect(description).toContain(".CI")
  })
})

// Shard sizes are a numeric choice with no other guard: revert one and every other
// test still passes while whole-market pulls silently truncate at the 10000-row cap.
// Windows are chosen to contain no weekend, so the shard count is exactly ceil(days/n).
describe("quote shard granularity", () => {
  const shardCount = async (tool: string, security: string, startDate: string, endDate: string) => {
    const client = {
      call: vi.fn().mockResolvedValue({ list: [{ x: 1 }], total: 1 }),
      download: vi.fn(),
    } as unknown as GangtiseClient
    const mcp = await connect(client)
    const result = await mcp.callTool({ name: tool, arguments: { security, startDate, endDate } })
    expect(result.isError).toBeFalsy()
    return (client.call as ReturnType<typeof vi.fn>).mock.calls.length
  }

  // 2026-04-01 (Wed) .. 2026-04-30 (Thu): 30 calendar days, 22 of them weekdays.
  it("shards aShares one day at a time", async () => {
    expect(await shardCount("gangtise_day_kline", "aShares", "2026-04-01", "2026-04-30")).toBe(22)
  })

  it("shards usStocks one day at a time", async () => {
    expect(await shardCount("gangtise_day_kline", "usStocks", "2026-04-01", "2026-04-30")).toBe(22)
  })

  // hkStocks tolerates 2-day windows (~2.8K rows/day), and multi-day shards are not
  // weekend-filtered: 30 calendar days / 2 = 15.
  it("shards hkStocks two days at a time", async () => {
    expect(await shardCount("gangtise_day_kline", "hkStocks", "2026-04-01", "2026-04-30")).toBe(15)
  })

  // 15 days, not the historical 30: all exchange indices run ~531 rows per trading day,
  // so a 30-day window (~22 trading days ≈ 11.7K) maxes out the 10000-row cap on every
  // shard. 30 calendar days / 15 = 2.
  it("shards the whole-market index kline 15 days at a time", async () => {
    expect(await shardCount("gangtise_index_day_kline", "all", "2026-04-01", "2026-04-30")).toBe(2)
  })
})

// The K-line/realtime param is fieldList (aligned with the fundamental tools and
// the upstream body key). It used to be `field`, so a caller passing `fieldList`
// (the natural habit) had it silently dropped by zod strip → unfiltered data.
describe("gangtise_day_kline fieldList param", () => {
  it("forwards fieldList to the API body", async () => {
    const client = makeMockClient()
    const mcp = await connect(client)
    await mcp.callTool({
      name: "gangtise_day_kline",
      arguments: { security: "600519.SH", startDate: "2026-04-01", endDate: "2026-04-30", fieldList: ["open", "close"] },
    })
    const body = (client.call as ReturnType<typeof vi.fn>).mock.calls[0][1] as Record<string, unknown>
    expect(body.fieldList).toEqual(["open", "close"])
  })
})

// fund-flow (v0.23): A-share daily fund flow. Single/explicit securities are a
// plain request; the 'aShares' full-market sentinel day-shards like security='all'
// but requires an explicit date range (upstream errors rather than truncating).
describe("gangtise_fund_flow", () => {
  it("forwards a single security to quote.fund-flow without sharding", async () => {
    const client = makeMockClient()
    const mcp = await connect(client)
    await mcp.callTool({
      name: "gangtise_fund_flow",
      arguments: { security: "600519.SH", startDate: "2026-04-01", endDate: "2026-04-30", fieldList: ["mainNetInflow"] },
    })
    expect(client.call).toHaveBeenCalledTimes(1)
    const [key, body] = (client.call as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(key).toBe("quote.fund-flow")
    expect(body).toMatchObject({ securityList: ["600519.SH"], startDate: "2026-04-01", endDate: "2026-04-30", fieldList: ["mainNetInflow"] })
  })

  it("rejects aShares full-market without both dates, no API call", async () => {
    const client = makeMockClient()
    const mcp = await connect(client)
    const result = await mcp.callTool({
      name: "gangtise_fund_flow",
      arguments: { security: "aShares", startDate: "2026-04-01" },
    })
    expect(result.isError).toBe(true)
    expect(client.call).not.toHaveBeenCalled()
  })

  it("rejects a non-A-share code (fund flow is 沪深北 only), no API call", async () => {
    const client = makeMockClient()
    const mcp = await connect(client)
    const result = await mcp.callTool({
      name: "gangtise_fund_flow",
      arguments: { security: "00700.HK", startDate: "2026-04-01", endDate: "2026-04-30" },
    })
    expect(result.isError).toBe(true)
    expect((result.content as Array<{ text: string }>)[0].text).toContain("A 股")
    expect(client.call).not.toHaveBeenCalled()
  })

  it("pins the default 6000 limit in the request body (exact truncation detection)", async () => {
    const client = makeMockClient()
    const mcp = await connect(client)
    await mcp.callTool({ name: "gangtise_fund_flow", arguments: { security: "600519.SH" } })
    const body = (client.call as ReturnType<typeof vi.fn>).mock.calls[0][1] as Record<string, unknown>
    expect(body.limit).toBe(6000)
  })

  it("rejects mixing 'aShares' with a specific code before calling the API", async () => {
    const client = makeMockClient()
    const mcp = await connect(client)
    const result = await mcp.callTool({
      name: "gangtise_fund_flow",
      arguments: { security: ["aShares", "600519.SH"], startDate: "2026-04-01", endDate: "2026-04-30" },
    })
    expect(result.isError).toBe(true)
    expect(client.call).not.toHaveBeenCalled()
  })

  it("day-shards a multi-day aShares full-market range", async () => {
    const client = {
      call: vi.fn().mockResolvedValue({ list: [{ x: 1 }], total: 1 }),
      download: vi.fn(),
    } as unknown as GangtiseClient
    const mcp = await connect(client)
    const result = await mcp.callTool({
      name: "gangtise_fund_flow",
      arguments: { security: "aShares", startDate: "2026-04-01", endDate: "2026-04-03" },
    })
    expect(result.isError).toBeFalsy()
    expect(client.call).toHaveBeenCalledTimes(3) // 3 one-day shards
    const parsed = JSON.parse((result.content as Array<{ text: string }>)[0].text)
    expect((parsed.list as unknown[]).length).toBe(3)
  })

  it("flags _partial when a single request returns rows up to the limit", async () => {
    const rows = Array.from({ length: 10 }, (_, i) => ({ i }))
    const client = { call: vi.fn().mockResolvedValue({ list: rows }), download: vi.fn() } as unknown as GangtiseClient
    const mcp = await connect(client)
    const result = await mcp.callTool({
      name: "gangtise_fund_flow",
      arguments: { security: "600519.SH", limit: 10 },
    })
    const parsed = JSON.parse((result.content as Array<{ text: string }>)[0].text)
    expect(parsed._partial).toBe(true)
    expect(parsed._partial_reason).toBe("limit_truncated")
  })
})

// v0.23: single-request (non-sharded) quote endpoints flag _partial when the row
// count reaches the per-request limit, so a silent head-of-window truncation
// (default cap 6000) can't read as a complete result. The security='all' sharded
// path carries its own per-shard markers and is unaffected.
describe("gangtise quote limit-truncation marker", () => {
  it("flags _partial when day-kline returns rows up to the explicit limit", async () => {
    const rows = Array.from({ length: 3 }, (_, i) => ({ i }))
    const client = { call: vi.fn().mockResolvedValue({ list: rows }), download: vi.fn() } as unknown as GangtiseClient
    const mcp = await connect(client)
    const result = await mcp.callTool({
      name: "gangtise_day_kline",
      arguments: { security: "600519.SH", startDate: "2026-04-01", endDate: "2026-04-30", limit: 3 },
    })
    const parsed = JSON.parse((result.content as Array<{ text: string }>)[0].text)
    expect(parsed._partial).toBe(true)
    expect(parsed._partial_reason).toBe("limit_truncated")
  })

  it("does not flag when day-kline returns fewer rows than the default 6000 cap", async () => {
    const rows = Array.from({ length: 5 }, (_, i) => ({ i }))
    const client = { call: vi.fn().mockResolvedValue({ list: rows }), download: vi.fn() } as unknown as GangtiseClient
    const mcp = await connect(client)
    const result = await mcp.callTool({
      name: "gangtise_day_kline",
      arguments: { security: "600519.SH", startDate: "2026-04-01", endDate: "2026-04-30" },
    })
    const parsed = JSON.parse((result.content as Array<{ text: string }>)[0].text)
    expect(parsed._partial).toBeUndefined()
  })

  it("pins the default 6000 limit in the explicit-security day-kline body", async () => {
    const client = { call: vi.fn().mockResolvedValue({ list: [] }), download: vi.fn() } as unknown as GangtiseClient
    const mcp = await connect(client)
    await mcp.callTool({
      name: "gangtise_day_kline",
      arguments: { security: "600519.SH", startDate: "2026-04-01", endDate: "2026-04-30" },
    })
    const body = (client.call as ReturnType<typeof vi.fn>).mock.calls[0][1] as Record<string, unknown>
    expect(body.limit).toBe(6000)
  })

  it("flags _partial when minute-kline returns rows up to the explicit limit", async () => {
    const rows = Array.from({ length: 2 }, (_, i) => ({ i }))
    const client = { call: vi.fn().mockResolvedValue({ list: rows }), download: vi.fn() } as unknown as GangtiseClient
    const mcp = await connect(client)
    const result = await mcp.callTool({
      name: "gangtise_minute_kline",
      arguments: { security: "600519.SH", limit: 2 },
    })
    const parsed = JSON.parse((result.content as Array<{ text: string }>)[0].text)
    expect(parsed._partial).toBe(true)
    expect(parsed._partial_reason).toBe("limit_truncated")
  })
})
