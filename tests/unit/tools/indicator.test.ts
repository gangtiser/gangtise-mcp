import { describe, it, expect, vi } from "vitest"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { registerIndicatorTools } from "../../../src/tools/indicator.js"
import type { GangtiseClient } from "../../../src/core/client.js"
import { ApiError } from "../../../src/core/errors.js"
import { unwrapEnvelope } from "../../../src/core/envelope.js"

const meta = (code: string, name: string) => ({ code, name, dataType: "number" })

/** The EDE no-data answer: every structural array empty, inside the inner
 * { code, status, data } envelope the endpoints double-wrap with. */
function emptyMatrix(withDates = true) {
  const data: Record<string, unknown> = { securityCodeList: [], securityNameList: [], indicatorList: [], values: [] }
  if (withDates) data.dates = []
  return { code: "000000", status: true, data }
}

function matrix(data: Record<string, unknown>) {
  return { code: "000000", status: true, data }
}

function makeMockClient(response: unknown = emptyMatrix()) {
  return {
    call: vi.fn().mockResolvedValue(response),
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

function bodyOf(client: GangtiseClient): Record<string, unknown> {
  return (client.call as unknown as { mock: { calls: unknown[][] } }).mock.calls[0][1] as Record<string, unknown>
}

function payloadOf(result: { content: unknown }): Record<string, unknown> {
  return JSON.parse((result.content as Array<{ text: string }>)[0].text) as Record<string, unknown>
}

const CS_ARGS = { indicatorCodeList: ["qte_close"], securityCodeList: ["600519.SH"], date: "2026-07-31" }
const TS_ARGS = { indicatorCodeList: ["qte_close"], securityCodeList: ["600519.SH"], startDate: "2026-06-01", endDate: "2026-06-30" }
const SCREENER_ARGS = {
  indicatorList: [{ field: "F1", indicatorCode: "qte_mkt_cptl" }],
  expression: "F1 >= 500",
  securityCodeList: ["600519.SH"],
  date: "2026-07-31",
}

// 服务端 2026-08-01 重构了 EDE 取数接口：请求体 `securityCodeList` 改名 `universe`。
// 不改就是 100001 硬报错——三个取数工具全线不可用。这是本轮最关键的回归守卫。
describe("EDE request body uses the post-2026-08-01 contract", () => {
  it.each([
    ["gangtise_indicator_cross_section", CS_ARGS],
    ["gangtise_indicator_time_series", TS_ARGS],
    ["gangtise_indicator_screener", SCREENER_ARGS],
  ] as Array<[string, Record<string, unknown>]>)("%s sends `universe`, never `securityCodeList`", async (name, args) => {
    const client = makeMockClient()
    const mcp = await connect(client)
    await mcp.callTool({ name, arguments: args })
    const body = bodyOf(client)
    expect(body.universe).toEqual(["600519.SH"])
    expect(body).not.toHaveProperty("securityCodeList")
  })

  // 根级 date 已废弃：CLI/MCP 现在把它下发为每个指标各自的 tradeDate。
  it("cross-section pushes the query date down as each indicator's own tradeDate", async () => {
    const client = makeMockClient()
    const mcp = await connect(client)
    await mcp.callTool({
      name: "gangtise_indicator_cross_section",
      arguments: { indicatorCodeList: ["qte_close", "qte_volume"], securityCodeList: ["600519.SH"], date: "2026-07-31" },
    })
    const body = bodyOf(client)
    expect(body).not.toHaveProperty("date")
    expect(body.indicatorParamList).toEqual([
      { indicatorCode: "qte_close", parameters: [{ paramKey: "tradeDate", paramValue: "2026-07-31" }] },
      { indicatorCode: "qte_volume", parameters: [{ paramKey: "tradeDate", paramValue: "2026-07-31" }] },
    ])
  })

  // 吃 reportDate 的指标收到 tradeDate 会静默返回空结果，所以已声明的日期参数必须保留。
  it("leaves an indicator that already declares reportDate alone", async () => {
    const client = makeMockClient()
    const mcp = await connect(client)
    await mcp.callTool({
      name: "gangtise_indicator_cross_section",
      arguments: {
        indicatorCodeList: ["is_op_rev_mom"],
        securityCodeList: ["600519.SH"],
        date: "2026-07-31",
        indicatorParamList: [{ indicatorCode: "is_op_rev_mom", parameters: [{ paramKey: "reportDate", paramValue: "2024-12-31" }] }],
      },
    })
    expect(bodyOf(client).indicatorParamList).toEqual([
      { indicatorCode: "is_op_rev_mom", parameters: [{ paramKey: "reportDate", paramValue: "2024-12-31" }] },
    ])
  })

  // sDate 是区间**起点**、tradeDate 是 required 的区间**终点**。把 sDate 当成日期参数
  // 的替代会吞掉终点、让区间静默漂移（实测茅台 qte_vol_intvl：2,265,873,849 vs 正确的
  // 65,687,435，两次都是 HTTP 200）。所以 sDate 存在时 tradeDate 仍须注入。
  it("still injects tradeDate when only sDate is declared", async () => {
    const client = makeMockClient()
    const mcp = await connect(client)
    await mcp.callTool({
      name: "gangtise_indicator_cross_section",
      arguments: {
        indicatorCodeList: ["qte_vol_intvl"],
        securityCodeList: ["600519.SH"],
        date: "2026-07-31",
        indicatorParamList: [{ indicatorCode: "qte_vol_intvl", parameters: [{ paramKey: "sDate", paramValue: "2024-01-02" }] }],
      },
    })
    expect(bodyOf(client).indicatorParamList).toEqual([
      {
        indicatorCode: "qte_vol_intvl",
        parameters: [
          { paramKey: "sDate", paramValue: "2024-01-02" },
          { paramKey: "tradeDate", paramValue: "2026-07-31" },
        ],
      },
    ])
  })

  // 同一 indicatorCode 的两条参数组必须**合并**，且**每个矩阵端点都要**——两条路径的丢参
  // 机制不同但后果一样，且都静默：截面是裸 Map.set() 在本地丢掉前一条；时序是把两条原样
  // 发出去、由**服务端**只取最后一条（实测 2026-08-03：`adjustType=3` + `currency=USD`
  // 两组 → 238.0967（只有汇率生效），合并成一组 → 1923.0771（后复权美元））。两种情形下
  // 要后复权的调用方都拿到不复权数据、HTTP 200、无报错。
  // 这是 MCP 独有的坑：CLI 的 --indicator-param 语法产生不出同 code 两组
  // （parseParamSpecs 累加进同一组），所以这里没有「CLI 也这样」可援引。
  it.each([
    ["gangtise_indicator_cross_section", { date: "2026-07-31" }, true],
    ["gangtise_indicator_time_series", { startDate: "2024-01-02", endDate: "2024-01-02" }, false],
  ] as Array<[string, Record<string, unknown>, boolean]>)(
    "%s merges two parameter groups for the same indicatorCode instead of dropping one",
    async (name, dateArgs, expectInjectedTradeDate) => {
      const client = makeMockClient()
      const mcp = await connect(client)
      await mcp.callTool({
        name,
        arguments: {
          indicatorCodeList: ["qte_close"],
          securityCodeList: ["600519.SH"],
          ...dateArgs,
          indicatorParamList: [
            { indicatorCode: "qte_close", parameters: [{ paramKey: "adjustType", paramValue: "3" }] },
            { indicatorCode: "qte_close", parameters: [{ paramKey: "currency", paramValue: "USD" }] },
          ],
        },
      })
      const groups = bodyOf(client).indicatorParamList as Array<{ indicatorCode: string; parameters: Array<{ paramKey: string }> }>
      expect(groups).toHaveLength(1)
      const keys = groups[0].parameters.map((p) => p.paramKey)
      expect(keys).toContain("adjustType")
      expect(keys).toContain("currency")
      // 时序的区间由 startDate/endDate 统管，不该注入每指标 tradeDate；截面必须注入。
      expect(keys.includes("tradeDate")).toBe(expectInjectedTradeDate)
    },
  )

  // 时序端点即使无参也要求这个键在场。
  it("time-series always sends indicatorParamList, defaulting to an empty array", async () => {
    const client = makeMockClient()
    const mcp = await connect(client)
    await mcp.callTool({ name: "gangtise_indicator_time_series", arguments: TS_ARGS })
    expect(bodyOf(client).indicatorParamList).toEqual([])
  })
})

// 截面/选股是单日快照（工具有 date，会注入 tradeDate），时序是区间——服务端**明确禁止**
// 时序的 parameters 里出现单日期参数：实测 2026-08-03 传 tradeDate 或 reportDate 都报
// 100003「parameters不得传入单日期参数，时间范围由startDate与endDate控制」。两套语义相反，
// 共用一段 guidance 就必然对其中一个是错的（时序曾继承截面那句「由本工具的 date 下发」，
// 而时序根本没有 date 参数，且照它传 reportDate 会被硬拒）。
describe("date guidance is per-endpoint, not shared", () => {
  it("time-series never claims a `date` param and warns off single-date params", async () => {
    const mcp = await connect(makeMockClient())
    const { tools } = await mcp.listTools()
    const ts = tools.find((t) => t.name === "gangtise_indicator_time_series")
    const schema = JSON.stringify(ts?.inputSchema)
    // 时序没有 date 入参，也不该声称有
    expect(Object.keys(JSON.parse(schema).properties)).not.toContain("date")
    expect(schema).not.toContain("由本工具的 date 下发")
    // 必须正面警告：单日期参数会被服务端硬拒
    expect(schema).toContain("禁止在 parameters 里传单日期参数")
    expect(schema).toContain("startDate/endDate")
    // 且不得再教「N期统计要配 reportDate」——那在时序上是硬失败
    expect(schema).toContain("不要**传 reportDate")
  })

  it("cross-section and screener keep the injected-tradeDate guidance", async () => {
    const mcp = await connect(makeMockClient())
    const { tools } = await mcp.listTools()
    for (const name of ["gangtise_indicator_cross_section", "gangtise_indicator_screener"]) {
      const schema = JSON.stringify(tools.find((t) => t.name === name)?.inputSchema)
      expect(schema, `${name} 应保留注入 tradeDate 的说明`).toContain("由本工具的 date 自动下发为 tradeDate")
      expect(schema, `${name} 不该带时序的禁令`).not.toContain("禁止在 parameters 里传单日期参数")
    }
  })
})

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
    ["gangtise_indicator_cross_section", CS_ARGS],
    ["gangtise_indicator_time_series", TS_ARGS],
    ["gangtise_indicator_screener", SCREENER_ARGS],
  ] as Array<[string, Record<string, unknown>]>)("%s surfaces the inner error as isError", async (name, args) => {
    const client = failingClient()
    const mcp = await connect(client)
    const result = await mcp.callTool({ name, arguments: args })
    expect(result.isError).toBe(true)
    expect(client.call).toHaveBeenCalledTimes(1)
  })
})

// Time-series flattening assumes exactly one dimension varies. With both >1 the
// matrix is ambiguous and one of the two identities would be silently dropped.
// Reject the request before it reaches the (billed) API.
describe("gangtise_indicator_time_series dimension guard", () => {
  it("rejects multi-indicator × multi-security without calling the API", async () => {
    const client = makeMockClient()
    const mcp = await connect(client)
    const result = await mcp.callTool({
      name: "gangtise_indicator_time_series",
      arguments: { ...TS_ARGS, indicatorCodeList: ["qte_close", "qte_open"], securityCodeList: ["600519.SH", "000001.SZ"] },
    })
    expect(result.isError).toBe(true)
    expect(client.call).not.toHaveBeenCalled()
  })

  // 板块 ID 由服务端展开成 N 只成分股，即「多证券」——请求里只有 1 条，看不出来。
  it("rejects a sector ID alongside multiple indicators without calling the API", async () => {
    const client = makeMockClient()
    const mcp = await connect(client)
    const result = await mcp.callTool({
      name: "gangtise_indicator_time_series",
      arguments: { ...TS_ARGS, indicatorCodeList: ["qte_close", "qte_open"], securityCodeList: ["1000012345"] },
    })
    expect(result.isError).toBe(true)
    expect(client.call).not.toHaveBeenCalled()
  })

  it("allows multi-indicator × single-security", async () => {
    const client = makeMockClient()
    const mcp = await connect(client)
    const result = await mcp.callTool({
      name: "gangtise_indicator_time_series",
      arguments: { ...TS_ARGS, indicatorCodeList: ["qte_close", "qte_open"] },
    })
    expect(result.isError).toBeFalsy()
    expect(client.call).toHaveBeenCalledTimes(1)
  })

  it("allows single-indicator × multi-security", async () => {
    const client = makeMockClient()
    const mcp = await connect(client)
    const result = await mcp.callTool({
      name: "gangtise_indicator_time_series",
      arguments: { ...TS_ARGS, securityCodeList: ["600519.SH", "000001.SZ"] },
    })
    expect(result.isError).toBeFalsy()
    expect(client.call).toHaveBeenCalledTimes(1)
  })

  // 单个板块 ID 配单指标是板块在时序接口上唯一合法的用法，不能被上面那条守卫误杀。
  it("allows a single sector ID with a single indicator", async () => {
    const client = makeMockClient()
    const mcp = await connect(client)
    const result = await mcp.callTool({ name: "gangtise_indicator_time_series", arguments: { ...TS_ARGS, securityCodeList: ["1000012345"] } })
    expect(result.isError).toBeFalsy()
    expect(client.call).toHaveBeenCalledTimes(1)
  })
})

// 服务端不给缺失数据补 null：整指标无数据就整列消失、整证券无数据就整行消失，
// 都是 HTTP 200 的短结果、载荷里没有任何东西说明这件事。自动化调用方会把一份短结果
// 当完整结果用，所以要走本仓既有的「响亮的部分结果」契约。
describe("dropped rows / columns are flagged partial", () => {
  it("marks a vanished indicator column with omittedIndicators", async () => {
    const client = makeMockClient(
      matrix({ securityCodeList: ["09992.HK"], securityNameList: ["泡泡玛特"], indicatorList: [meta("qte_close", "收盘价")], values: [[100]] }),
    )
    const mcp = await connect(client)
    const result = await mcp.callTool({
      name: "gangtise_indicator_cross_section",
      arguments: { indicatorCodeList: ["qte_close", "finc_pb_mrq"], securityCodeList: ["09992.HK"], date: "2026-07-31" },
    })
    const payload = payloadOf(result as { content: unknown })
    expect(payload._partial).toBe(true)
    expect(payload._partial_reason).toBe("omitted_indicators")
    expect(payload.omittedIndicators).toEqual(["finc_pb_mrq"])
  })

  it("marks a vanished security row with omittedSecurities", async () => {
    const client = makeMockClient(
      matrix({ securityCodeList: ["600519.SH"], securityNameList: ["贵州茅台"], indicatorList: [meta("finc_pb_mrq", "市净率")], values: [[6.2]] }),
    )
    const mcp = await connect(client)
    const result = await mcp.callTool({
      name: "gangtise_indicator_cross_section",
      arguments: { indicatorCodeList: ["finc_pb_mrq"], securityCodeList: ["600519.SH", "09992.HK"], date: "2026-07-31" },
    })
    const payload = payloadOf(result as { content: unknown })
    expect(payload._partial).toBe(true)
    expect(payload._partial_reason).toBe("omitted_securities")
    expect(payload.omittedSecurities).toEqual(["09992.HK"])
  })

  // 合法的全空结果不能标 partial：整个查询无数据时「请求 vs 响应」的差集按构造就是
  // 全部，把每个请求的 code 都列进 omitted 是假元数据。
  it("does not flag a legitimately empty result", async () => {
    const client = makeMockClient(emptyMatrix(false))
    const mcp = await connect(client)
    const result = await mcp.callTool({
      name: "gangtise_indicator_cross_section",
      arguments: { indicatorCodeList: ["finc_pb_mrq"], securityCodeList: ["09992.HK"], date: "2026-07-31" },
    })
    const payload = payloadOf(result as { content: unknown })
    expect(payload.list).toEqual([])
    expect(payload.total).toBe(0)
    expect(payload._partial).toBeUndefined()
    expect(payload).not.toHaveProperty("omittedIndicators")
    expect(payload).not.toHaveProperty("omittedSecurities")
  })

  // `dates` 是时序的必需轴，丢了它的应答是**畸形**而不是空结果。若按「dates 缺省也算合法
  // 空结果」放行，这种载荷会拿到干净空表并跳过 flattenTimeSeries 的轴校验。
  it("hard-fails a time-series answer that lost its dates axis", async () => {
    const client = makeMockClient(matrix({ securityCodeList: [], securityNameList: [], indicatorList: [], values: [] }))
    const mcp = await connect(client)
    const result = await mcp.callTool({ name: "gangtise_indicator_time_series", arguments: TS_ARGS })
    expect(result.isError).toBe(true)
  })

  // 反面：真实的时序无数据应答是五个空数组（含 dates: []），必须干净返回空表。
  it("accepts the real time-series no-data answer (five empty arrays)", async () => {
    const client = makeMockClient(emptyMatrix(true))
    const mcp = await connect(client)
    const result = await mcp.callTool({ name: "gangtise_indicator_time_series", arguments: TS_ARGS })
    expect(result.isError).toBeFalsy()
    const payload = payloadOf(result as { content: unknown })
    expect(payload.list).toEqual([])
    expect(payload._partial).toBeUndefined()
  })

  it("does not flag a complete result", async () => {
    const client = makeMockClient(
      matrix({ securityCodeList: ["600519.SH"], securityNameList: ["贵州茅台"], indicatorList: [meta("qte_close", "收盘价")], values: [[1350.6]] }),
    )
    const mcp = await connect(client)
    const result = await mcp.callTool({ name: "gangtise_indicator_cross_section", arguments: CS_ARGS })
    const payload = payloadOf(result as { content: unknown })
    expect(payload._partial).toBeUndefined()
    expect(payload.list).toEqual([{ security: "600519.SH", name: "贵州茅台", 收盘价: 1350.6 }])
  })
})

describe("gangtise_indicator_screener", () => {
  it("binds variables to indicators and injects the date per variable", async () => {
    const client = makeMockClient()
    const mcp = await connect(client)
    await mcp.callTool({
      name: "gangtise_indicator_screener",
      arguments: {
        indicatorList: [
          { field: "F1", indicatorCode: "qte_mkt_cptl", parameters: [{ paramKey: "scale", paramValue: "8" }] },
          { field: "F2", indicatorCode: "finc_pe_ttm" },
        ],
        expression: "F1 >= 500 && F2 <= 30",
        securityCodeList: ["1000012345"],
        date: "2026-07-31",
      },
    })
    const body = bodyOf(client)
    expect(body.expression).toBe("F1 >= 500 && F2 <= 30")
    expect(body.indicatorList).toEqual([
      {
        field: "F1",
        indicatorCode: "qte_mkt_cptl",
        parameters: [
          { paramKey: "scale", paramValue: "8" },
          { paramKey: "tradeDate", paramValue: "2026-07-31" },
        ],
      },
      { field: "F2", indicatorCode: "finc_pe_ttm", parameters: [{ paramKey: "tradeDate", paramValue: "2026-07-31" }] },
    ])
  })

  it("flattens matched securities into a wide table", async () => {
    const client = makeMockClient(
      matrix({
        securityCodeList: ["600519.SH"],
        securityNameList: ["贵州茅台"],
        indicatorList: [
          { field: "F1", code: "qte_mkt_cptl", name: "总市值" },
          { field: "F2", code: "finc_pe_ttm", name: "市盈率(TTM)" },
        ],
        values: [[16883.6021, 20.4118]],
      }),
    )
    const mcp = await connect(client)
    const result = await mcp.callTool({
      name: "gangtise_indicator_screener",
      arguments: {
        indicatorList: [
          { field: "F1", indicatorCode: "qte_mkt_cptl" },
          { field: "F2", indicatorCode: "finc_pe_ttm" },
        ],
        expression: "F1 >= 500 && F2 <= 30",
        securityCodeList: ["600519.SH"],
        date: "2026-07-31",
      },
    })
    expect(payloadOf(result as { content: unknown }).list).toEqual([
      { security: "600519.SH", name: "贵州茅台", 总市值: 16883.6021, "市盈率(TTM)": 20.4118 },
    ])
  })

  // 零命中是正常答案，不是报错——而且它不绑定任何东西，所以也不该触发绑定校验。
  it("returns an empty table for zero matches, without flagging partial", async () => {
    const client = makeMockClient(matrix({ securityCodeList: [], securityNameList: [], indicatorList: [], values: [] }))
    const mcp = await connect(client)
    const result = await mcp.callTool({ name: "gangtise_indicator_screener", arguments: SCREENER_ARGS })
    expect(result.isError).toBeFalsy()
    const payload = payloadOf(result as { content: unknown })
    expect(payload.list).toEqual([])
    expect(payload.total).toBe(0)
    expect(payload._partial).toBeUndefined()
  })

  // 筛掉的证券是选股的**目的**，不是数据缺口——绝不能标成 omittedSecurities。
  it("never reports filtered-out securities as omitted", async () => {
    const client = makeMockClient(
      matrix({
        securityCodeList: ["600519.SH"],
        securityNameList: ["贵州茅台"],
        indicatorList: [{ field: "F1", code: "qte_mkt_cptl", name: "总市值" }],
        values: [[16883.6021]],
      }),
    )
    const mcp = await connect(client)
    const result = await mcp.callTool({
      name: "gangtise_indicator_screener",
      arguments: { ...SCREENER_ARGS, securityCodeList: ["600519.SH", "000001.SZ", "09992.HK"] },
    })
    const payload = payloadOf(result as { content: unknown })
    expect(payload._partial).toBeUndefined()
    expect(payload).not.toHaveProperty("omittedSecurities")
  })

  // 🔴 服务端在本端点**完全忽略**根级 currency/scale（实测 2026-08-03：茅台
  // qte_mkt_cptl 加根级 scale=8 仍返 1688360210310.6，与不传逐位相同），而表达式是拿这个
  // 原始值去比的——暴露它们等于让「市值≥500亿」静默变成「≥500 元」恒真（白酒板块 5 只 → 14
  // 只，含 PE 为负的票），HTTP 200、无 _partial、照常计费。CLI 的 body 也没有这两个字段。
  // 也**不能**改成「把根级值塞进每个绑定」——那会复刻截面根级 scale 把 qte_close 缩成 0 的
  // 污染语义。
  it("neither exposes nor sends root-level currency / scale", async () => {
    const client = makeMockClient()
    const mcp = await connect(client)
    const { tools } = await mcp.listTools()
    const schema = JSON.stringify(tools.find((t) => t.name === "gangtise_indicator_screener")?.inputSchema)
    const props = JSON.parse(schema).properties as Record<string, unknown>
    expect(Object.keys(props)).not.toContain("currency")
    expect(Object.keys(props)).not.toContain("scale")
    // 描述里要明写「只能按变量传」，否则模型仍会去猜根级写法
    expect(schema).toContain("没有根级 currency/scale")
    // expression 的示例本身是 `F1 >= 500`（隐含「亿」）——必须就地写清量纲，否则模型照抄
    // 就是在比「≥500 元」恒真。这是根级 scale 被删后剩下的那半个坑。
    expect(schema).toContain("量纲")

    await mcp.callTool({ name: "gangtise_indicator_screener", arguments: { ...SCREENER_ARGS, currency: "USD", scale: "8" } })
    const body = bodyOf(client)
    expect(body).not.toHaveProperty("currency")
    expect(body).not.toHaveProperty("scale")
  })

  // 零命中的判据必须是「结构性全空」而不是 securityCodeList.length：后者把缺失/非数组的
  // 身份轴也算成零命中，于是畸形载荷会拿到一张干净空表、绕过全部形状守卫。
  it("hard-fails on a malformed securityCodeList instead of calling it zero matches", async () => {
    const client = makeMockClient(matrix({ securityCodeList: null, indicatorList: [], values: [] }))
    const mcp = await connect(client)
    const result = await mcp.callTool({ name: "gangtise_indicator_screener", arguments: SCREENER_ARGS })
    expect(result.isError).toBe(true)
  })

  it("rejects a duplicate variable without calling the API", async () => {
    const client = makeMockClient()
    const mcp = await connect(client)
    const result = await mcp.callTool({
      name: "gangtise_indicator_screener",
      arguments: {
        ...SCREENER_ARGS,
        indicatorList: [
          { field: "F1", indicatorCode: "qte_mkt_cptl" },
          { field: "F1", indicatorCode: "finc_pe_ttm" },
        ],
      },
    })
    expect(result.isError).toBe(true)
    expect(client.call).not.toHaveBeenCalled()
  })

  it("rejects an expression referencing an unbound variable without calling the API", async () => {
    const client = makeMockClient()
    const mcp = await connect(client)
    const result = await mcp.callTool({
      name: "gangtise_indicator_screener",
      arguments: { ...SCREENER_ARGS, expression: "F1 >= 500 && F2 <= 30" },
    })
    expect(result.isError).toBe(true)
    expect(client.call).not.toHaveBeenCalled()
  })

  // 字符串字面量里的 F2 不是变量引用，不能误判。
  it("does not mistake an F-ref inside a string literal for a variable", async () => {
    const client = makeMockClient()
    const mcp = await connect(client)
    const result = await mcp.callTool({
      name: "gangtise_indicator_screener",
      arguments: { ...SCREENER_ARGS, indicatorList: [{ field: "F1", indicatorCode: "pty_op_scope" }], expression: "F1 contains 'F2 酒'" },
    })
    expect(result.isError).toBeFalsy()
    expect(client.call).toHaveBeenCalledTimes(1)
  })

  // 同一 code 绑到两个变量（同指标不同参数）是 API 规格支持的用法。服务端曾把这些
  // 绑定全部按其中最早的日期取数，本工具因此在本地拒绝；实测 2026-08-08 已修复
  // （F1@08-07 + F2@08-06 各自返回 1309.22 / 1308.55，连跑稳定），拦截已撤除。
  // 这条钉住「不再本地拒绝」，防止哪天又把它当成非法输入加回来。
  it("allows binding one indicator to two variables and labels the columns by field", async () => {
    const client = makeMockClient(
      matrix({
        securityCodeList: ["600519.SH"],
        securityNameList: ["贵州茅台"],
        indicatorList: [
          { field: "F1", code: "qte_close", name: "日收盘价" },
          { field: "F2", code: "qte_close", name: "日收盘价" },
        ],
        values: [[1309.22, 1308.55]],
      }),
    )
    const mcp = await connect(client)
    const result = await mcp.callTool({
      name: "gangtise_indicator_screener",
      arguments: {
        ...SCREENER_ARGS,
        indicatorList: [
          { field: "F1", indicatorCode: "qte_close", parameters: [{ paramKey: "tradeDate", paramValue: "2026-08-07" }] },
          { field: "F2", indicatorCode: "qte_close", parameters: [{ paramKey: "tradeDate", paramValue: "2026-08-06" }] },
        ],
        expression: "F1 > F2",
      },
    })
    expect(result.isError).toBeFalsy()
    expect(client.call).toHaveBeenCalledTimes(1)
    // 同名两列必须靠 field 区分，否则后一列会覆盖前一列。
    const text = (result.content as Array<{ text: string }>)[0].text
    expect(text).toContain("日收盘价 (F1)")
    expect(text).toContain("日收盘价 (F2)")
    expect(text).toContain("1308.55")
  })

  // 响应里每列带的 field 是唯一能把这一列追溯回它来自哪个筛选条件的东西。
  it("rejects a response whose column is bound to a variable that was never requested", async () => {
    const client = makeMockClient(
      matrix({
        securityCodeList: ["600519.SH"],
        indicatorList: [{ field: "F9", code: "qte_mkt_cptl", name: "总市值" }],
        values: [[16883]],
      }),
    )
    const mcp = await connect(client)
    const result = await mcp.callTool({ name: "gangtise_indicator_screener", arguments: SCREENER_ARGS })
    expect(result.isError).toBe(true)
  })

  // 缺列的致命判定按表达式的布尔结构走：合取项缺列 → 这些行无法被证明满足条件。
  it("rejects a result whose conjunct has no column", async () => {
    const client = makeMockClient(
      matrix({
        securityCodeList: ["600519.SH"],
        indicatorList: [{ field: "F1", code: "qte_mkt_cptl", name: "总市值" }],
        values: [[16883]],
      }),
    )
    const mcp = await connect(client)
    const result = await mcp.callTool({
      name: "gangtise_indicator_screener",
      arguments: {
        ...SCREENER_ARGS,
        indicatorList: [
          { field: "F1", indicatorCode: "qte_mkt_cptl" },
          { field: "F2", indicatorCode: "finc_pe_ttm" },
        ],
        expression: "F1 >= 500 && F2 <= 30",
      },
    })
    expect(result.isError).toBe(true)
  })

  // 析取项缺列时仍有分支可求值，服务端给的是一份正确完整的答案——只是少了一列输出，
  // 降级为 partial 而不是整份丢弃。
  it("degrades to partial when a disjunct is missing but another branch holds", async () => {
    const client = makeMockClient(
      matrix({
        securityCodeList: ["09992.HK"],
        securityNameList: ["泡泡玛特"],
        indicatorList: [{ field: "F2", code: "finc_pe_ttm", name: "市盈率(TTM)" }],
        values: [[14.93]],
      }),
    )
    const mcp = await connect(client)
    const result = await mcp.callTool({
      name: "gangtise_indicator_screener",
      arguments: {
        ...SCREENER_ARGS,
        indicatorList: [
          { field: "F1", indicatorCode: "finc_pb_mrq" },
          { field: "F2", indicatorCode: "finc_pe_ttm" },
        ],
        expression: "F1 > 0 || F2 > 0",
        securityCodeList: ["09992.HK"],
      },
    })
    expect(result.isError).toBeFalsy()
    const payload = payloadOf(result as { content: unknown })
    expect(payload._partial).toBe(true)
    expect(payload.omittedIndicators).toEqual(["finc_pb_mrq"])
  })
})

// 自 2026-08-01 起 EDE 无数据不再返回 999999，所以此码基本只剩真故障。
// 参数排查清单仍要保留——参数名/日期语义写错**同样不报错**（表现为 null/0 占位、
// 或区间指标的默认区间错数；**不是**空表），那才是调用方需要的。
const FETCH_CASES = [
  ["gangtise_indicator_cross_section", CS_ARGS],
  ["gangtise_indicator_time_series", TS_ARGS],
  ["gangtise_indicator_screener", SCREENER_ARGS],
] as Array<[string, Record<string, unknown>]>

describe("indicator 999999 hint (fetch endpoints)", () => {
  it.each(FETCH_CASES)("%s points at the parameter checklist, not retry-later", async (name, args) => {
    const client = {
      call: vi.fn().mockRejectedValue(new ApiError("system error", "999999", 500)),
      download: vi.fn(),
    } as unknown as GangtiseClient
    const mcp = await connect(client)
    const result = await mcp.callTool({ name, arguments: args })
    expect(result.isError).toBe(true)
    const text = (result.content as Array<{ text: string }>)[0].text
    expect(text).toContain("parameterList")
    expect(text).toContain("指标周期")
    expect(text).toContain("scopeList")
    expect(text).toContain("required")
    expect(text).not.toContain("稍后重试")
    // 「多为查询无数据」已作废——无数据现在返回保留行列的占位单元格，这么写会把真故障误导成无数据
    expect(text).not.toContain("多为查询无数据")
  })

  // EDE 双层信封：外层成功、内层失败的 999999 在解内层时才抛出；hintOverride 与
  // 外层 traceId 都必须在这条路径上生效。
  it.each(FETCH_CASES)("%s keeps the hint when 999999 is raised peeling the inner envelope (with traceId)", async (name, args) => {
    const client = {
      call: vi.fn().mockImplementation(async () => unwrapEnvelope({ code: "0", data: { code: "999999", status: false, msg: "system error" }, traceId: "77" })),
      download: vi.fn(),
    } as unknown as GangtiseClient
    const mcp = await connect(client)
    const result = await mcp.callTool({ name, arguments: args })
    expect(result.isError).toBe(true)
    const text = (result.content as Array<{ text: string }>)[0].text
    expect(text).toContain("parameterList")
    expect(text).toContain("trace 77")
  })
})

// search 的 999999 是真系统错误（零命中返 []、exit 0），不套取数端点的
// date/scope/param 提示——回落通用提示。
describe("indicator.search keeps the generic 999999 hint", () => {
  it("does not get the fetch endpoints' parameter checklist", async () => {
    const client = { call: vi.fn().mockRejectedValue(new ApiError("system error", "999999", 500)), download: vi.fn() } as unknown as GangtiseClient
    const mcp = await connect(client)
    const result = await mcp.callTool({ name: "gangtise_indicator_search", arguments: { keyword: "x" } })
    expect(result.isError).toBe(true)
    const text = (result.content as Array<{ text: string }>)[0].text
    expect(text).not.toContain("指标周期")
    expect(text).not.toContain("scopeList")
    // 正向钉住通用回落提示——search 的 999999 走 errors.ts 默认表
    expect(text).toContain("稍后重试")
  })
})

// EDE 的空表提示是 runtime 行为（不进 schema，对外口径自查脚本也扫不到），
// 回归时最容易被静默改掉。这里钉住两件事：截面/时序用 EDE 专属提示（空表几乎
// 只剩「code 没被识别」，而不是通用提示说的「可能确无数据」——自 2026-08-07 起
// 能识别的 code 无数据返回的是保留行列的 null 单元格）；screener **不挂**该提示，
// 它零命中是选股的合法结果。
describe("EDE empty-table hint", () => {
  it.each([
    ["gangtise_indicator_cross_section", { indicatorCodeList: ["qte_close"], securityCodeList: ["600519.SH"], date: "2026-08-07" }],
    ["gangtise_indicator_time_series", { indicatorCodeList: ["qte_close"], securityCodeList: ["600519.SH"], startDate: "2026-08-01", endDate: "2026-08-07" }],
  ])("%s tells the caller the codes were probably unrecognised", async (name, args) => {
    const client = makeMockClient(emptyMatrix())
    const mcp = await connect(client)
    const result = await mcp.callTool({ name, arguments: args })
    const payload = JSON.parse((result.content as Array<{ text: string }>)[0].text)
    expect(payload.list).toEqual([])
    expect(payload._hint).toContain("没被服务端解析")
    // 通用提示以「可能该条件下确无数据」开头，对 EDE 说反了，不能落到这两个端点上。
    // （EDE 提示里也有「确无数据」四个字，但那是否定句，所以要匹配通用提示的完整开头。）
    expect(payload._hint).not.toContain("可能该条件下确无数据")
    // 日期用错不会产生空表（返的是 null 单元格，行列俱在），提示里不该把人引去查日期。
    expect(payload._hint).not.toContain("日期")
  })

  it("screener keeps the generic hint — a zero-row screen is a legitimate result", async () => {
    const client = makeMockClient(emptyMatrix(false))
    const mcp = await connect(client)
    const result = await mcp.callTool({ name: "gangtise_indicator_screener", arguments: SCREENER_ARGS })
    const payload = JSON.parse((result.content as Array<{ text: string }>)[0].text)
    expect(payload._hint).not.toContain("没被服务端解析")
  })
})

// 占位形态由**指标**决定，不由场景决定（2026-08-09 判别性实测：同一报告期末日期下
// is_dnrpnp × AAPL.O/MSFT.O/TSLA.O/NVDA.O 全为 0，而同批的 600519.SH=45390247623.82、
// 09992.HK=4574368000 是真值；同一批美股换 is_op_rev / finc_pb_mrq 则全为 null）。
// 所以「缺数据一律补 null」是错的，而且最危险的形态是**日期完全正确**时拿到一个
// 看着像真值的 0。这条钉住描述里不再出现那个绝对断言，且必须点名 0。
describe("cross-section description: placeholder is indicator-bound", () => {
  it("never promises that missing data is always null, and names the 0 case", async () => {
    const mcp = await connect(makeMockClient())
    const { tools } = await mcp.listTools()
    const desc = tools.find((t) => t.name === "gangtise_indicator_cross_section")!.description!
    // 被证伪的绝对断言——尤其「跨市场不覆盖…都是 null」正好是它自己的反例。
    expect(desc).not.toContain("一律补 null")
    expect(desc).not.toContain("跨市场不覆盖都是 null")
    // 必须点名 0 这一档，并说明它取决于指标而不是查法。
    expect(desc).toContain("is_dnrpnp")
    expect(desc).toContain("取决于指标")
  })
})

// 区间类指标写错参数名的后果是**错数**，不是 null——错名与臆造名都等同于「没传起点」，
// 服务端静默套默认区间返回一个完全合理的数（2026-08-09：茅台 qte_amp_intvl 终点
// 2026-08-07，sDate=2026-07-01 → 16.6193，写成 startDate → 23.1634 = 不传时的默认值；
// 换 qte_vol_intvl 同形态 1.33 亿 vs 3.99 亿）。两个数都正常，从结果看不出用错了，
// 比 0 占位更难发现。描述必须点明这一层，只说「会被静默忽略」不够。
describe("interval-indicator parameter guidance", () => {
  it.each(["gangtise_indicator_cross_section", "gangtise_indicator_time_series"])(
    "%s warns that a wrong interval key yields a wrong number, not null",
    async (name) => {
      const mcp = await connect(makeMockClient())
      const { tools } = await mcp.listTools()
      const schema = tools.find((t) => t.name === name)!.inputSchema as {
        properties: Record<string, { description?: string }>
      }
      const guidance = schema.properties.indicatorParamList?.description ?? ""
      expect(guidance).toContain("sDate")
      // 后果必须写明：默认区间 + 拿到的是数不是 null
      expect(guidance).toContain("默认区间")
      expect(guidance).not.toContain("写 startDate 会被静默忽略")
    },
  )
})
