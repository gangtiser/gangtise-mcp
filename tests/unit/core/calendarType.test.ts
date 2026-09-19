import { describe, it, expect, vi, beforeEach } from "vitest"
import { clearCalendarTypeCacheForTests, resolveCalendarType } from "../../../src/core/calendarType.js"
import type { GangtiseClient } from "../../../src/core/client.js"

/** indicator.search 的返回：外层被 client 剥掉信封后，仍带 EDE 的内层 { code, status, data }。 */
function searchClient(byCode: Record<string, unknown[]>) {
  const call = vi.fn(async (_key: string, body: Record<string, unknown>) => ({
    code: "000000",
    status: true,
    data: byCode[String(body.keyword)] ?? [],
  }))
  return { client: { call, download: vi.fn() } as unknown as GangtiseClient, call }
}

const params = (...keys: string[]) => keys.map((paramKey) => ({ paramKey }))

// 不对称是这条逻辑的全部要点：判错 ND 只多花单元格，判错 TD 是静默丢数——报告期末常
// 落在非交易日（2024-03-31、06-30 都是周日），TD 的日期轴里根本没有那一列，请求照样
// 200，回来是一整片 null。所以「拿不准就 ND」。
describe("resolveCalendarType", () => {
  // 判定缓存是模块级的，不清会让用例之间互相喂答案。
  beforeEach(() => clearCalendarTypeCacheForTests())

  it("asks for TD when every indicator is trading-day typed", async () => {
    const { client } = searchClient({
      qte_close: [{ indicatorCode: "qte_close", parameterList: params("tradeDate") }],
      qte_open: [{ indicatorCode: "qte_open", parameterList: params("tradeDate") }],
    })
    expect(await resolveCalendarType(client, ["qte_close", "qte_open"])).toBe("TD")
  })

  it("stays on the server default for a report-period indicator", async () => {
    const { client } = searchClient({
      is_op_rev: [{ indicatorCode: "is_op_rev", parameterList: params("reportDate") }],
    })
    expect(await resolveCalendarType(client, ["is_op_rev"])).toBeUndefined()
  })

  it("stays on the server default when a fiscalYear indicator is mixed in", async () => {
    const { client } = searchClient({
      qte_close: [{ indicatorCode: "qte_close", parameterList: params("tradeDate") }],
      div_cash_yr: [{ indicatorCode: "div_cash_yr", parameterList: params("fiscalYear") }],
    })
    // calendarType 是请求级的，管不到单个指标——一个报告期指标就足以让整条序列必须留在 ND。
    expect(await resolveCalendarType(client, ["qte_close", "div_cash_yr"])).toBeUndefined()
  })

  it("stays on the server default when an indicator declares both tradeDate and reportDate", async () => {
    const { client } = searchClient({
      div_cash_yld: [{ indicatorCode: "div_cash_yld", parameterList: params("reportDate", "tradeDate") }],
    })
    expect(await resolveCalendarType(client, ["div_cash_yld"])).toBeUndefined()
  })

  it("treats an empty parameterList as no evidence, not as trading-day", async () => {
    // 静态属性族（pty_* / scr_*）报空表，cdr_conv_ratio 也报空表却照样吃日期。
    const { client } = searchClient({
      pty_op_scope: [{ indicatorCode: "pty_op_scope", parameterList: [] }],
    })
    expect(await resolveCalendarType(client, ["pty_op_scope"])).toBeUndefined()
  })

  it("stays on the server default when the code cannot be found", async () => {
    // 关键词搜索会连近似项一起返回，所以必须按 code 精确挑；挑不到就不是证据。
    const { client } = searchClient({
      qte_close: [{ indicatorCode: "qte_close_adj", parameterList: params("tradeDate") }],
    })
    expect(await resolveCalendarType(client, ["qte_close"])).toBeUndefined()
  })

  it("stays on the server default when the probe itself fails", async () => {
    // search 挂了不该改变一条时序请求要的东西。
    const client = { call: vi.fn(async () => { throw new Error("boom") }), download: vi.fn() } as unknown as GangtiseClient
    expect(await resolveCalendarType(client, ["qte_close"])).toBeUndefined()
  })

  it("probes each distinct code once", async () => {
    const { client, call } = searchClient({
      qte_close: [{ indicatorCode: "qte_close", parameterList: params("tradeDate") }],
    })
    await resolveCalendarType(client, ["qte_close", "qte_close", "qte_close"])
    expect(call).toHaveBeenCalledTimes(1)
  })

  it("sends nothing when there is no code to probe", async () => {
    const { client, call } = searchClient({})
    expect(await resolveCalendarType(client, [])).toBeUndefined()
    expect(call).not.toHaveBeenCalled()
  })
})

// 指标的 parameterList 不随查询变化，同一个 code 没必要每次调工具都探一遍。
describe("resolveCalendarType 的判定缓存", () => {
  beforeEach(() => clearCalendarTypeCacheForTests())

  it("probes a repeated code only once across calls", async () => {
    const { client, call } = searchClient({
      qte_close: [{ indicatorCode: "qte_close", parameterList: params("tradeDate") }],
    })
    expect(await resolveCalendarType(client, ["qte_close"])).toBe("TD")
    expect(await resolveCalendarType(client, ["qte_close"])).toBe("TD")
    expect(call).toHaveBeenCalledTimes(1)
  })

  it("caches a negative verdict too", async () => {
    const { client, call } = searchClient({
      is_op_rev: [{ indicatorCode: "is_op_rev", parameterList: params("reportDate") }],
    })
    expect(await resolveCalendarType(client, ["is_op_rev"])).toBeUndefined()
    expect(await resolveCalendarType(client, ["is_op_rev"])).toBeUndefined()
    expect(call).toHaveBeenCalledTimes(1)
  })

  // 🔴 一次网络抖动不能把整个进程的判定钉死在 ND —— 这个进程是长驻的。
  it("does not cache a failed probe", async () => {
    let fail = true
    const client = {
      call: vi.fn(async () => {
        if (fail) throw new Error("boom")
        return { code: "000000", status: true, data: [{ indicatorCode: "qte_close", parameterList: params("tradeDate") }] }
      }),
      download: vi.fn(),
    } as unknown as GangtiseClient
    expect(await resolveCalendarType(client, ["qte_close"])).toBeUndefined()
    fail = false
    expect(await resolveCalendarType(client, ["qte_close"]), "探针失败被缓存了").toBe("TD")
  })

  // 搜不到也可能是搜索侧的临时空结果，同样不该钉死。
  it("does not cache a code that could not be found", async () => {
    const hits: Record<string, unknown[]> = { qte_close: [] }
    const client = {
      call: vi.fn(async (_k: string, b: Record<string, unknown>) => ({ code: "000000", status: true, data: hits[String(b.keyword)] ?? [] })),
      download: vi.fn(),
    } as unknown as GangtiseClient
    expect(await resolveCalendarType(client, ["qte_close"])).toBeUndefined()
    hits.qte_close = [{ indicatorCode: "qte_close", parameterList: params("tradeDate") }]
    expect(await resolveCalendarType(client, ["qte_close"]), "「搜不到」被缓存了").toBe("TD")
  })
})
