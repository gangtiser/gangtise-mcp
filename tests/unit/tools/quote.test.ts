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

  it("still accepts 'all' on the HK day-kline tool", async () => {
    const client = makeMockClient()
    const mcp = await connect(client)
    const hk = await mcp.callTool({ name: "gangtise_day_kline_hk", arguments: { security: "all", startDate: "2026-04-01" } })
    expect(hk.isError).toBeFalsy()
  })

  // 指数端点对 'all' 返回 000000 + 空列表，读起来像「没有数据」——本地拒绝，一个请求都不发。
  it.each(["all", "ALL", "aShares"])("index_day_kline refuses the keyword %s before sending anything", async (keyword) => {
    const client = makeMockClient()
    const mcp = await connect(client)
    const result = await mcp.callTool({ name: "gangtise_index_day_kline", arguments: { security: keyword, startDate: "2026-04-01", endDate: "2026-04-30" } })
    expect(result.isError).toBe(true)
    expect((result.content as Array<{ text: string }>)[0].text).toMatch(/没有全市场关键字/)
    expect(client.call).not.toHaveBeenCalled()
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

  // 🔴 归一是必需的，但理由在**本地**：`resolveFullMarket` 按精确字符串查分片粒度表，
  // 没归一的 `ashares` 根本不会被认成全市场关键字——全市场资金流会因此走成一次不分片的
  // 请求（本工具直接报错，日 K 那边是静默按 6000 行封顶）。删掉 canonicalizeKeywords
  // 必须让本条变红。
  // ⚠️ 不是为了迁就服务端：该端点与同族一样折叠大小写，四种写法返回逐位相同的行；
  // `120001 非有效A股` 是**拼错**关键字（如 aSharez）才有的，不是大小写变体。
  it("canonicalises a lower-cased keyword so the local shard lookup still recognises it", async () => {
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

// 🔴 **这一组曾经把一条假事实钉了四版正则。**
//
// 旧断言要求三个客户可见面都声明「.CI 本接口不支持，传了会报证券代码无效」，并用越来越
// 精巧的正则防止有人把它改回「支持」。前提从头到尾没人复验过——2026-08-30 打真接口：
//   quote.day-kline  821026.CI / 821001.CI / 821011.CI  → 各 total=2，有完整 OHLC
//   quote.realtime   821026.CI / 821001.CI              → total=2，latestPrice 正常
//   .CI 与个股混传、与 .SWI 混传                          → 都正常返回
// 三个端点全都支持 .CI。**护栏越硬，越没人回头问那句话对不对**——这是本组留下的教训。
//
// 现在钉的是反向声明：**任何一个面都不许再说 .CI 不受支持**。写法与旧版对称——钉声明
// 不钉措辞：要把那句话放回去，必须写出一个「.CI + 否定」的断言，一写就红。
describe("industry index routing (.CI / .SWI)", () => {
  // 按**面**取，不要把 description 和 inputSchema 拼成一个串再断言：拼串只要求「两个面
  // 里至少一个干净」，于是「只改主描述、参数描述不动」这种局部编辑照样全绿。
  const surfaces = async (name: string) => {
    const mcp = await connect(makeMockClient())
    const tool = (await mcp.listTools()).tools.find((t) => t.name === name)!
    const schema = tool.inputSchema as { properties?: Record<string, { description?: string }> }
    return { description: tool.description ?? "", security: schema.properties?.security?.description ?? "" }
  }

  // 🔴 **只钉否定闭集是不够的** —— 复核方用「本接口无法查询中信行业指数 .CI」一句就穿过去了，
  // 11 条路由测试全绿。任何否定词表都是开放集合，这是第二次在同一处栽同一个跟头
  // （上一版是钉「必须说不支持」，这一版是钉「不许说不支持」，方向反了、性质一样）。
  //
  // 所以判据做成**两条并列**，缺一不可：
  //   ① 否定闭集扩到「不支持 / 不受支持 / 无法查询 / 不能传 / 会拒绝」，捞明显的回退；
  //   ② **正向声明必须在场** —— 每个面都得把 `.CI` 列进可传集合。要把它改回"不支持"，
  //      就必须先把这句正向声明删掉，一删 ② 就红。②才是真正钉住"声明"的那一条，
  //      ① 只是让常见回退早点红。
  const DENIES_CI =
    /\.CI(?:[）)]|[（(][^）)]{0,12}[）)])?\*{0,2}\s*(?:本接口)?\s*(?:暂|尚)?(?:不(?:支持|受支持|能传)|无法(?:查询|支持)|会被?拒绝)|(?:不(?:支持|受支持)|无法查询)[^，。；]{0,12}\.CI/
  /** 正向声明：`.CI` 出现在「可传/支持」的语境里。当前文案把它列进后缀集合。 */
  // 三种在用的正向写法各一条；新增写法要显式加进来（那是一次有意识的动作，正是判据要的）。
  const LISTS_CI_AS_USABLE = /\.CI（821xxx\.CI）|中信行业指数（\.CI）|支持[^。；]{0,20}\.CI\/\.SWI/

  it.each([
    ["gangtise_day_kline", "description"],
    ["gangtise_day_kline", "security"],
    ["gangtise_realtime", "security"],
    ["gangtise_index_day_kline", "description"],
  ] as Array<[string, "description" | "security"]>)(
    "%s.%s states .CI is usable and never denies it",
    async (name, face) => {
      const text = (await surfaces(name))[face]
      expect(DENIES_CI.test(text), `该面又把 .CI 说成不可用：${text.slice(0, 140)}`).toBe(false)
      expect(LISTS_CI_AS_USABLE.test(text), `该面没有把 .CI 列进可传集合（正向声明被删了？）：${text.slice(0, 140)}`).toBe(true)
    },
  )

  // 正则的对照表：回退必红 + 合法改写必绿，两个方向缺一不可（沿用旧组的方法，换了方向）。
  it.each([
    ["回退：绝对否定", "⚠️ **中信行业指数（.CI）本接口不支持**，传了会报「证券代码无效」", true],
    ["回退：否定提到句首", "⚠️ 本接口不支持中信行业指数 .CI，请改用 gangtise_index_day_kline", true],
    ["回退：暂不支持", "⚠️ 中信行业指数（.CI）本接口暂不支持", true],
    ["回退：不受支持", "⚠️ 中信行业指数 .CI 不受支持", true],
    // 复核方实测穿透的那句，必须红
    ["回退：无法查询", "⚠️ 本接口无法查询中信行业指数 .CI，请改用 gangtise_index_day_kline", true],
    ["回退：不能传", "⚠️ 中信行业指数 .CI 不能传", true],
    ["回退：会拒绝", "⚠️ 中信行业指数 .CI 会被拒绝", true],
    ["合法：说明字段差异", "本接口查指数只返代码、不返 securityName；.CI 与 .SWI 都可直接传", false],
    ["合法：列进支持集合", "交易所指数 .SH/.SZ/.BJ、概念指数 .GT、申万 .SWI、中信 .CI，可混传", false],
  ])("regex verdict — %s", (_l, text, expected) => {
    expect(DENIES_CI.test(text as string)).toBe(expected)
  })

  // 两个指数日 K 端点都不返回指数名称，本端点也不收 'all'（返空不报错）。所以描述必须把名称
  // 指到 securities_search，并声明没有全市场关键字——要改回「用本工具取名称 / 一次取回全部指数」，
  // 就得先删掉这两句声明。
  it("index kline surfaces send index names to securities_search and declare no whole-market keyword", async () => {
    const index = await surfaces("gangtise_index_day_kline")
    expect(index.description).toMatch(/名称[^。]{0,20}gangtise_securities_search/)
    expect(index.description).toMatch(/没有全市场关键字/)
    const day = await surfaces("gangtise_day_kline")
    expect(day.description).toMatch(/指数名称[^。]{0,20}gangtise_securities_search/)
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

// 行情类接口对不认识的字段名是**名和值一起丢**：长度对得上、不报错，结果里就是少一列。
// 缺列必须有信号，否则「字段名写错」与「这列没数据」分不开。
describe("quote missing-column guard", () => {
  const parse = (r: unknown) => JSON.parse((r as { content: Array<{ text: string }> }).content[0].text)

  it("flags a requested column the server never returned", async () => {
    const client = {
      call: vi.fn().mockResolvedValue({ fieldList: ["securityCode", "latestPrice"], list: [["600519.SH", 1500]] }),
      download: vi.fn(),
    } as unknown as GangtiseClient
    const mcp = await connect(client)
    const result = await mcp.callTool({
      name: "gangtise_realtime",
      arguments: { security: "600519.SH", fieldList: ["securityCode", "latestPrice", "turnoverRate"] },
    })
    const payload = parse(result)
    expect(payload._partial).toBe(true)
    expect(String(payload._partial_reason)).toContain("missing_fields")
    expect(payload.missingFields).toEqual(["turnoverRate"])
  })

  it("stays quiet when every requested column came back", async () => {
    const client = {
      call: vi.fn().mockResolvedValue({ fieldList: ["securityCode", "latestPrice"], list: [["600519.SH", 1500]] }),
      download: vi.fn(),
    } as unknown as GangtiseClient
    const mcp = await connect(client)
    const result = await mcp.callTool({
      name: "gangtise_realtime",
      arguments: { security: "600519.SH", fieldList: ["securityCode", "latestPrice"] },
    })
    expect(parse(result)._partial).toBeUndefined()
  })
})

// 显式多证券且单请求装不下时逐只拉：单请求会在窗口开头截断，只剩前几只的前几个月，
// 而结果只有一个 _partial、说不清缺了谁。
describe("explicit multi-security day kline splits per security when one request cannot hold it", () => {
  it("splits when securities × trading days exceeds the row cap", async () => {
    const seen: string[][] = []
    const client = {
      call: vi.fn().mockImplementation(async (_k: string, body: Record<string, unknown>) => {
        seen.push(body.securityList as string[])
        return { fieldList: ["securityCode"], list: [[(body.securityList as string[])[0]]] }
      }),
      download: vi.fn(),
    } as unknown as GangtiseClient
    const mcp = await connect(client)
    await mcp.callTool({
      name: "gangtise_day_kline",
      arguments: { security: ["600519.SH", "000858.SZ"], startDate: "2026-01-01", endDate: "2026-09-01", limit: 10 },
    })
    expect(seen).toEqual([["600519.SH"], ["000858.SZ"]])
  })

  it("keeps a single request when the estimate fits", async () => {
    const seen: string[][] = []
    const client = {
      call: vi.fn().mockImplementation(async (_k: string, body: Record<string, unknown>) => {
        seen.push(body.securityList as string[])
        return { list: [] }
      }),
      download: vi.fn(),
    } as unknown as GangtiseClient
    const mcp = await connect(client)
    await mcp.callTool({
      name: "gangtise_day_kline",
      arguments: { security: ["600519.SH", "000858.SZ"], startDate: "2026-08-31", endDate: "2026-09-01" },
    })
    expect(seen).toEqual([["600519.SH", "000858.SZ"]])
  })
})

// 分钟 K 接口一次只收一只（securityCode），多只在本地逐只请求再按传入顺序合并。
describe("gangtise_minute_kline multi-security", () => {
  it("issues one request per security and merges in order", async () => {
    const seen: string[] = []
    const client = {
      call: vi.fn().mockImplementation(async (_k: string, body: Record<string, unknown>) => {
        seen.push(body.securityCode as string)
        return { fieldList: ["securityCode"], list: [[body.securityCode]] }
      }),
      download: vi.fn(),
    } as unknown as GangtiseClient
    const mcp = await connect(client)
    const result = await mcp.callTool({
      name: "gangtise_minute_kline",
      arguments: { security: ["600519.SH", "512800.SH"] },
    })
    expect(seen).toEqual(["600519.SH", "512800.SH"])
    // 合并结果没有额外 meta，normalizeRows 按既有约定返回裸数组。
    const payload = JSON.parse((result as { content: Array<{ text: string }> }).content[0].text)
    expect(payload).toEqual([{ securityCode: "600519.SH" }, { securityCode: "512800.SH" }])
  })

  it("still sends a single request for one security", async () => {
    const client = {
      call: vi.fn().mockResolvedValue({ list: [] }),
      download: vi.fn(),
    } as unknown as GangtiseClient
    const mcp = await connect(client)
    await mcp.callTool({ name: "gangtise_minute_kline", arguments: { security: "600519.SH" } })
    expect((client.call as unknown as { mock: { calls: unknown[][] } }).mock.calls).toHaveLength(1)
  })
})

// 单请求收到一个没有 list 的载荷时，原样交出去的是一个既不是表、也不是错误的对象。
describe("quote single-request payload guard", () => {
  it("fails loudly when a day-kline response carries no list", async () => {
    const client = {
      call: vi.fn().mockResolvedValue({ message: "ok" }),
      download: vi.fn(),
    } as unknown as GangtiseClient
    const mcp = await connect(client)
    const result = await mcp.callTool({ name: "gangtise_day_kline", arguments: { security: "600519.SH" } })
    expect(result.isError).toBe(true)
    expect((result as { content: Array<{ text: string }> }).content[0].text).toContain("没有可读的 list")
  })

  it("accepts the {total:0, list:null} empty encoding", async () => {
    const client = {
      call: vi.fn().mockResolvedValue({ total: 0, list: null }),
      download: vi.fn(),
    } as unknown as GangtiseClient
    const mcp = await connect(client)
    const result = await mcp.callTool({ name: "gangtise_day_kline", arguments: { security: "600519.SH" } })
    expect(result.isError).toBeFalsy()
  })
})

// 0.38 起 realtime 的字段集变了：新增 tradeStatus，turnoverRate / volumeRatio 不再返回。
// 描述里的字段清单是模型唯一的依据，写错就会诱导它传一个会被丢掉的字段名。
describe("quote tool descriptions track the current field sets", () => {
  it("realtime names tradeStatus and warns off turnoverRate / volumeRatio", async () => {
    const mcp = await connect(makeMockClient())
    const byName = new Map((await mcp.listTools()).tools.map((t) => [t.name, t.description ?? ""]))
    const rt = byName.get("gangtise_realtime") ?? ""
    expect(rt).toContain("tradeStatus")
    expect(rt).toContain("turnoverRate")
    expect(rt).toContain("volumeRatio")
  })

  it("day kline and realtime name ETF and the global indices", async () => {
    const mcp = await connect(makeMockClient())
    const tools = (await mcp.listTools()).tools
    const byName = new Map(tools.map((t) => [t.name, t.description ?? ""]))
    for (const name of ["gangtise_day_kline", "gangtise_realtime", "gangtise_minute_kline"]) {
      expect(byName.get(name), `${name} 应覆盖 ETF / 全球指数`).toMatch(/ETF|全球指数/)
    }
    // 具体代码写在 security 参数说明里（模型照抄的就是那一面），不在主描述里。
    const securityDesc = (name: string) => {
      const schema = tools.find((t) => t.name === name)!.inputSchema as { properties?: Record<string, { description?: string }> }
      return schema.properties?.security?.description ?? ""
    }
    expect(securityDesc("gangtise_day_kline")).toContain("SPX.SPI")
    expect(securityDesc("gangtise_realtime")).toContain("SPX.SPI")
  })

  it("says the whole-market keywords do not cover ETF", async () => {
    const mcp = await connect(makeMockClient())
    const byName = new Map((await mcp.listTools()).tools.map((t) => [t.name, t.description ?? ""]))
    expect(byName.get("gangtise_day_kline")).toMatch(/aShares 不含 ETF|不含 ETF/)
  })
})

// 🔴 volume 的单位是「股」。A 股的习惯读法是「手」（100 股），按手换算会差 100 倍，
// 而算出来的数字看着仍像个成交量、不会报错。描述里不声明，模型只能按习惯猜。
describe("volume unit is stated on every tool that returns it", () => {
  it("says 股 (and 份 for ETF) on day kline, realtime and minute kline", async () => {
    const mcp = await connect(makeMockClient())
    const byName = new Map((await mcp.listTools()).tools.map((t) => [t.name, t.description ?? ""]))
    for (const name of ["gangtise_day_kline", "gangtise_realtime", "gangtise_minute_kline"]) {
      const description = byName.get(name) ?? ""
      expect(description, `${name} 未声明 volume 单位`).toContain("volume 的单位是「股」")
      expect(description, `${name} 未点出按手换算的后果`).toMatch(/100 倍/)
    }
    // 三个工具都覆盖 ETF，「份」这条例外要跟着一起出现，缺一个就是留了个 100 倍的坑。
    for (const name of ["gangtise_day_kline", "gangtise_realtime", "gangtise_minute_kline"]) {
      expect(byName.get(name), `${name} 缺 ETF 的「份」例外`).toContain("ETF 为「份」")
    }
  })
})
