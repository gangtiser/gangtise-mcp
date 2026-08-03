import { describe, it, expect } from "vitest"
import {
  unwrapIndicatorData,
  requireIndicatorMatrix,
  isEmptyMatrix,
  droppedFromMatrix,
  checkScreenerBindings,
  flattenCrossSection,
  flattenTimeSeries,
} from "../../../src/core/indicatorMatrix.js"
import { ApiError } from "../../../src/core/errors.js"
import { unwrapEnvelope } from "../../../src/core/envelope.js"

// Shapes below are the EDE response as of the 2026-08-01 revision: structured
// `indicatorList: [{code, name}]` replaced the parallel code/name arrays, and the
// cross-section `values` matrix was TRANSPOSED to [security][indicator].
const meta = (code: string, name: string) => ({ code, name, dataType: "number" })

describe("unwrapIndicatorData", () => {
  it("peels the inner { code, status, data } envelope on success", () => {
    const raw = { code: "000000", status: true, data: { list: [{ a: 1 }] } }
    expect(unwrapIndicatorData(raw)).toEqual({ list: [{ a: 1 }] })
  })

  it("throws ApiError when the inner envelope carries a failure code", () => {
    const raw = { code: "999999", status: false, msg: "boom", data: null }
    expect(() => unwrapIndicatorData(raw)).toThrowError(ApiError)
  })

  it("returns a non-enveloped payload unchanged", () => {
    const raw = { list: [{ a: 1 }] }
    expect(unwrapIndicatorData(raw)).toBe(raw)
  })
})

describe("flattenCrossSection", () => {
  it("reads the [security][indicator] matrix as one row per security", () => {
    const data = {
      securityCodeList: ["600519.SH", "000001.SZ"],
      securityNameList: ["贵州茅台", "平安银行"],
      indicatorList: [meta("qte_close", "收盘价"), meta("qte_volume", "成交量")],
      // security-major: row i is security i, cell j is indicator j
      values: [
        [1800, 5000],
        [11, 9000],
      ],
    }
    const result = flattenCrossSection(data) as { list: Array<Record<string, unknown>>; total: number }
    expect(result.total).toBe(2)
    expect(result.list[0]).toEqual({ security: "600519.SH", name: "贵州茅台", 收盘价: 1800, 成交量: 5000 })
    expect(result.list[1]).toEqual({ security: "000001.SZ", name: "平安银行", 收盘价: 11, 成交量: 9000 })
  })

  // 2026-08-01 起查询日期挂在每个指标自己的参数上，各列可以是不同日期，
  // 所以行级单一 date 会误导——必须没有这个键。
  it("emits no date column", () => {
    const data = {
      securityCodeList: ["600519.SH"],
      securityNameList: ["贵州茅台"],
      indicatorList: [meta("qte_close", "收盘价")],
      values: [[1800]],
    }
    const row = (flattenCrossSection(data) as { list: Array<Record<string, unknown>> }).list[0]
    expect(row).not.toHaveProperty("date")
  })

  // 服务端会重排返回列序；flatten 按响应数组的共同索引绑定 indicatorList[j]↔values[i][j]，
  // 故不会贴错值。同显示名的指标（如 cf_finc_exp / _qtr 都叫「财务费用」）以 code 后缀
  // 区分、互不覆盖。
  it("aligns by response index and keeps same-named indicators (dup name → code suffix, no overwrite)", () => {
    const data = {
      securityCodeList: ["600519.SH"],
      securityNameList: ["贵州茅台"],
      indicatorList: [meta("cf_finc_exp", "财务费用"), meta("is_op_rev", "营业收入(利润表,累计)"), meta("cf_finc_exp_qtr", "财务费用")],
      values: [[100, 1688, 40]],
    }
    const row = (flattenCrossSection(data) as { list: Array<Record<string, unknown>> }).list[0]
    expect(row["财务费用"]).toBe(100) // 第一个「财务费用」= cf_finc_exp
    expect(row["营业收入(利润表,累计)"]).toBe(1688)
    expect(row["财务费用 (cf_finc_exp_qtr)"]).toBe(40) // 同名第二个加 code 后缀，值不丢
  })

  // `name: undefined` 在 JSON 里看不见，但在表格里是实打实的一列空值。
  it("omits the name key entirely when the response carries no names", () => {
    const data = {
      securityCodeList: ["600519.SH"],
      indicatorList: [meta("qte_close", "收盘价")],
      values: [[1800]],
    }
    const row = (flattenCrossSection(data) as { list: Array<Record<string, unknown>> }).list[0]
    expect(row).not.toHaveProperty("name")
    expect(row).toEqual({ security: "600519.SH", 收盘价: 1800 })
  })
})

describe("flattenTimeSeries", () => {
  it("uses indicators as columns for a single security", () => {
    const data = {
      dates: ["2026-06-25", "2026-06-26"],
      securityCodeList: ["600519.SH"],
      indicatorList: [meta("qte_close", "收盘价"), meta("qte_open", "开盘价")],
      values: [
        [1790, 1800],
        [1780, 1795],
      ],
    }
    const result = flattenTimeSeries(data) as { list: Array<Record<string, unknown>>; total: number }
    expect(result.total).toBe(2)
    expect(result.list[0]).toEqual({ date: "2026-06-25", 收盘价: 1790, 开盘价: 1780 })
    expect(result.list[1]).toEqual({ date: "2026-06-26", 收盘价: 1800, 开盘价: 1795 })
  })

  it("uses securities as columns when one indicator spans multiple securities", () => {
    const data = {
      dates: ["2026-06-26"],
      securityCodeList: ["600519.SH", "000001.SZ"],
      securityNameList: ["贵州茅台", "平安银行"],
      indicatorList: [meta("qte_close", "收盘价")],
      values: [[1800], [11]],
    }
    const result = flattenTimeSeries(data) as { list: Array<Record<string, unknown>> }
    expect(result.list[0]).toEqual({ date: "2026-06-26", 贵州茅台: 1800, 平安银行: 11 })
  })

  // 服务端会丢掉完全无数据的证券，于是「单指标 × 2 证券」在一只无覆盖时缩成 1 只。
  // 若据此翻转成指标轴，输出就是一个裸的指标名列，看不出是哪只证券的序列。
  it("still labels by security when the server dropped the other requested security", () => {
    const data = {
      dates: ["2026-06-26"],
      securityCodeList: ["600519.SH"],
      securityNameList: ["贵州茅台"],
      indicatorList: [meta("finc_pe_ttm", "市盈率(TTM)")],
      values: [[20.4]],
    }
    const result = flattenTimeSeries(data, ["600519.SH", "09992.HK"]) as { list: Array<Record<string, unknown>> }
    expect(result.list[0]).toEqual({ date: "2026-06-26", 贵州茅台: 20.4 })
  })

  // 板块 ID 是服务端展开的：请求 1 条、响应 N 只。按请求条数判轴会判成指标轴，
  // 而这恰是板块在时序接口上唯一合法的用法。
  it("takes the security axis for a sector ID that expanded to one constituent", () => {
    const data = {
      dates: ["2026-06-26"],
      securityCodeList: ["600519.SH"],
      securityNameList: ["贵州茅台"],
      indicatorList: [meta("qte_close", "收盘价")],
      values: [[1800]],
    }
    const result = flattenTimeSeries(data, ["1000012345"]) as { list: Array<Record<string, unknown>> }
    expect(result.list[0]).toEqual({ date: "2026-06-26", 贵州茅台: 1800 })
  })

  // 同一证券传两次此前会被当成双证券请求，列名从指标名退化成证券代码。
  it("dedupes the requested universe before falling back to its entry count", () => {
    const data = {
      dates: ["2026-06-26"],
      securityCodeList: ["600519.SH"],
      indicatorList: [meta("qte_close", "收盘价")],
      values: [[1800]],
    }
    const result = flattenTimeSeries(data, ["600519.SH", "600519.SH"]) as { list: Array<Record<string, unknown>> }
    expect(result.list[0]).toEqual({ date: "2026-06-26", 收盘价: 1800 })
  })
})

// An indicator whose display name collides with a metadata column (date /
// security / name) must be suffixed, not silently overwrite the metadata.
describe("reserved metadata column collision", () => {
  it("suffixes indicators named 'security' / 'name' in cross-section rows", () => {
    const data = {
      securityCodeList: ["600519.SH"],
      securityNameList: ["贵州茅台"],
      indicatorList: [meta("ind_a", "security"), meta("ind_b", "name")],
      values: [[1, 2]],
    }
    const result = flattenCrossSection(data) as { list: Array<Record<string, unknown>> }
    expect(result.list[0].security).toBe("600519.SH")
    expect(result.list[0].name).toBe("贵州茅台")
    expect(result.list[0]["security (ind_a)"]).toBe(1)
    expect(result.list[0]["name (ind_b)"]).toBe(2)
  })

  it("suffixes a series named 'date' in time-series rows", () => {
    const data = {
      dates: ["2026-07-09"],
      securityCodeList: ["600519.SH"],
      indicatorList: [meta("ind_a", "date")],
      values: [[42]],
    }
    const result = flattenTimeSeries(data) as { list: Array<Record<string, unknown>> }
    expect(result.list[0].date).toBe("2026-07-09")
    expect(result.list[0]["date (ind_a)"]).toBe(42)
  })
})

// 2026-08-01 的转置是无版本标记发生的，再转一次必须炸出来而不是静默错位贴值。
// 注意只能抓非方阵的变化：2×2 转置后维度不变，载荷里没有任何东西能区分。
describe("matrix shape validation", () => {
  it("rejects a re-transposed non-square cross-section matrix", () => {
    const data = {
      securityCodeList: ["600519.SH", "000001.SZ"],
      indicatorList: [meta("qte_close", "收盘价")],
      values: [[1800, 11]], // [indicator][security] —— 旧布局
    }
    expect(() => flattenCrossSection(data)).toThrowError(/shape mismatch/)
  })

  it("rejects a row whose cell count does not match the column axis", () => {
    const data = {
      securityCodeList: ["600519.SH"],
      indicatorList: [meta("qte_close", "收盘价"), meta("qte_volume", "成交量")],
      values: [[1800]], // 2 指标只给了 1 个单元格
    }
    expect(() => flattenCrossSection(data)).toThrowError(/shape mismatch/)
  })

  it("rejects a time-series response carrying both axes plural", () => {
    const data = {
      dates: ["2026-06-26"],
      securityCodeList: ["600519.SH", "000001.SZ"],
      indicatorList: [meta("qte_close", "收盘价"), meta("qte_open", "开盘价")],
      values: [[1800], [11]],
    }
    expect(() => flattenTimeSeries(data)).toThrowError(/does not support/)
  })

  // dates 有值但身份轴为空：行列数照样对得上（0 行配 0 序列），却每行都不属于任何证券。
  it("rejects dates with no identity axis", () => {
    const data = { dates: ["2026-06-26"], securityCodeList: [], indicatorList: [], values: [] }
    expect(() => flattenTimeSeries(data)).toThrowError(/could not be attributed/)
  })
})

// 捏造出来的身份比缺数据更危险 —— 它看起来是有效答案。
describe("identity axes are never coerced", () => {
  it("rejects a null security code instead of labelling a row 'null'", () => {
    const data = { securityCodeList: [null], indicatorList: [meta("qte_close", "收盘价")], values: [[1800]] }
    expect(() => flattenCrossSection(data)).toThrowError(/identifies nothing/)
  })

  it("rejects a null date instead of labelling a row 'null'", () => {
    const data = { dates: [null], securityCodeList: ["600519.SH"], indicatorList: [meta("qte_close", "收盘价")], values: [[1800]] }
    expect(() => flattenTimeSeries(data)).toThrowError(/identifies nothing/)
  })

  it("rejects an indicator entry with no usable code instead of emitting col0", () => {
    const data = { securityCodeList: ["600519.SH"], indicatorList: ["qte_close"], values: [[1800]] }
    expect(() => flattenCrossSection(data)).toThrowError(/no usable `code`/)
  })
})

// 异形载荷此前被原样透传（`data: null` 直接当成功结果打出去）。
describe("malformed payloads fail loudly", () => {
  it("rejects a payload carrying none of the matrix fields", () => {
    expect(() => flattenCrossSection({ list: [] })).toThrowError(/none of the matrix fields/)
  })

  it("rejects axis lists with no values array", () => {
    const data = { securityCodeList: ["600519.SH"], indicatorList: [meta("qte_close", "收盘价")], values: null }
    expect(() => flattenCrossSection(data)).toThrowError(/no `values` array/)
  })

  it("requireIndicatorMatrix rejects a null / array payload before the envelope is discarded", () => {
    expect(() => requireIndicatorMatrix({ code: "000000", status: true, data: null })).toThrowError(/no matrix object/)
    expect(() => requireIndicatorMatrix({ code: "000000", status: true, data: [] })).toThrowError(/no matrix object/)
  })

  // `data: null` 承载不了那个不可枚举的 traceId，所以校验必须发生在**丢弃信封之前**：
  // 拿内层信封当 details 是让这类失败仍可追踪的唯一办法。
  it("requireIndicatorMatrix keeps the outer traceId on a null payload", () => {
    const raw = unwrapEnvelope({ code: "0", data: { code: "000000", status: true, data: null }, traceId: "5150" })
    try {
      requireIndicatorMatrix(raw)
      throw new Error("should have thrown")
    } catch (err) {
      expect((err as ApiError).traceId).toBe("5150")
    }
  })
})

// 名称是**按位置**消费的，对不齐就一个都不能用；但它只是标题，
// 丢标题保数据比连正确的数值一起毙掉更优 —— 与本模块其他守卫有意不对称。
describe("securityNameList anomalies degrade instead of failing", () => {
  it("drops all names when the list length does not match, falling back to codes", () => {
    const data = {
      securityCodeList: ["600519.SH", "09992.HK"],
      securityNameList: ["泡泡玛特"], // 长度不符：会把茅台标成泡泡玛特
      indicatorList: [meta("qte_close", "收盘价")],
      values: [[1350.6], [100]],
    }
    const result = flattenCrossSection(data) as { list: Array<Record<string, unknown>> }
    expect(result.list[0]).not.toHaveProperty("name")
    expect(result.list[0].security).toBe("600519.SH")
    expect(result.list[0]["收盘价"]).toBe(1350.6)
  })

  it("falls back to the code for a single null name rather than a column headed 'null'", () => {
    const data = {
      dates: ["2026-06-26"],
      securityCodeList: ["600519.SH", "09992.HK"],
      securityNameList: [null, "泡泡玛特"],
      indicatorList: [meta("qte_close", "收盘价")],
      values: [[1350.6], [100]],
    }
    const result = flattenTimeSeries(data) as { list: Array<Record<string, unknown>> }
    expect(result.list[0]).toEqual({ date: "2026-06-26", "600519.SH": 1350.6, 泡泡玛特: 100 })
  })
})

// 整个查询无数据 ≠ 有东西被略过。把每个请求的 code 都列进 omitted 是假元数据。
describe("isEmptyMatrix", () => {
  it("accepts the time-series no-data answer (five empty arrays)", () => {
    expect(isEmptyMatrix({ dates: [], securityCodeList: [], securityNameList: [], indicatorList: [], values: [] })).toBe(true)
  })

  it("accepts the cross-section no-data answer (no dates key at all)", () => {
    expect(isEmptyMatrix({ securityCodeList: [], securityNameList: [], indicatorList: [], values: [] })).toBe(true)
  })

  // 这三种此前都被判成「合法空结果」并原样透传，恰好绕过全部矩阵保护。
  it("rejects malformed payloads masquerading as legitimately empty", () => {
    expect(isEmptyMatrix({ securityCodeList: [], indicatorList: [], values: null })).toBe(false)
    expect(isEmptyMatrix({ securityCodeList: [], indicatorList: [] })).toBe(false)
    expect(isEmptyMatrix({ dates: ["2026-06-26"], securityCodeList: [], indicatorList: [], values: [] })).toBe(false)
  })

  it("does not treat a populated matrix as empty", () => {
    expect(isEmptyMatrix({ securityCodeList: ["600519.SH"], indicatorList: [meta("qte_close", "收盘价")], values: [[1]] })).toBe(false)
  })

  // 时序的 `dates` 是必需轴：丢了它的应答是畸形而非空结果，否则它会拿到干净空表并跳过
  // flattenTimeSeries 的轴校验。截面/screener 本就不带这个键，故仍走宽松判据。
  it("requireDates rejects an otherwise-empty payload that lost the dates axis", () => {
    const noDates = { securityCodeList: [], securityNameList: [], indicatorList: [], values: [] }
    expect(isEmptyMatrix(noDates)).toBe(true)
    expect(isEmptyMatrix(noDates, { requireDates: true })).toBe(false)
    expect(isEmptyMatrix({ ...noDates, dates: [] }, { requireDates: true })).toBe(true)
  })
})

// 服务端不给缺失数据补 null：整指标无数据就整列消失、整证券无数据就整行消失，
// 都是 HTTP 200 的短结果，载荷里没有任何东西说明这件事。
describe("droppedFromMatrix", () => {
  it("reports an indicator that vanished from the response", () => {
    const data = { securityCodeList: ["09992.HK"], indicatorList: [meta("qte_close", "收盘价")], values: [[100]] }
    expect(droppedFromMatrix(data, ["09992.HK"], ["qte_close", "finc_pb_mrq"])).toEqual({
      securities: [],
      indicators: ["finc_pb_mrq"],
    })
  })

  it("reports a security that vanished from the response", () => {
    const data = { securityCodeList: ["600519.SH"], indicatorList: [meta("finc_pb_mrq", "市净率")], values: [[6.2]] }
    expect(droppedFromMatrix(data, ["600519.SH", "09992.HK"], ["finc_pb_mrq"])).toEqual({
      securities: ["09992.HK"],
      indicators: [],
    })
  })

  // 板块 ID 由服务端展开成成分股，它本身不出现在响应里是正常的，不是丢行。
  it("skips sector IDs, which the server expands into constituents", () => {
    const data = { securityCodeList: ["600519.SH"], indicatorList: [meta("qte_close", "收盘价")], values: [[1800]] }
    expect(droppedFromMatrix(data, ["1000012345"], ["qte_close"]).securities).toEqual([])
  })
})

// 响应里每列带的 `field` 是唯一能把这一列追溯回它来自哪个筛选条件的东西，
// 载荷里没有任何别的信息能发现它漂了。
describe("checkScreenerBindings", () => {
  const requested = [
    { field: "F1", indicatorCode: "qte_mkt_cptl" },
    { field: "F2", indicatorCode: "finc_pe_ttm" },
  ]

  it("accepts a response that binds every requested variable to its own code", () => {
    const data = {
      securityCodeList: ["600519.SH"],
      indicatorList: [
        { field: "F1", code: "qte_mkt_cptl", name: "总市值" },
        { field: "F2", code: "finc_pe_ttm", name: "市盈率(TTM)" },
      ],
      values: [[16883, 20.4]],
    }
    expect(checkScreenerBindings(data, requested, "F1 >= 500 && F2 <= 30")).toEqual([])
  })

  it("rejects a column bound to a variable that was never requested", () => {
    const data = {
      securityCodeList: ["600519.SH"],
      indicatorList: [{ field: "F9", code: "qte_mkt_cptl", name: "总市值" }],
      values: [[16883]],
    }
    expect(() => checkScreenerBindings(data, requested, "F1 >= 500")).toThrowError(/never requested/)
  })

  it("rejects a variable that came back carrying a different code", () => {
    const data = {
      securityCodeList: ["600519.SH"],
      indicatorList: [{ field: "F1", code: "finc_pe_ttm", name: "市盈率(TTM)" }],
      values: [[20.4]],
    }
    expect(() => checkScreenerBindings(data, requested, "F1 >= 500")).toThrowError(/filter and the column disagree/)
  })

  it("rejects the same variable appearing twice", () => {
    const data = {
      securityCodeList: ["600519.SH"],
      indicatorList: [
        { field: "F1", code: "qte_mkt_cptl", name: "总市值" },
        { field: "F1", code: "qte_mkt_cptl", name: "总市值" },
      ],
      values: [[16883, 16883]],
    }
    expect(() => checkScreenerBindings(data, requested, "F1 >= 500")).toThrowError(/appears twice/)
  })

  // 缺列的致命判定按表达式的**布尔结构**走，不是「有没有 ||」。
  it("is fatal when a conjunct has no column — the rows cannot be shown to satisfy it", () => {
    const data = {
      securityCodeList: ["600519.SH"],
      indicatorList: [{ field: "F2", code: "finc_pe_ttm", name: "市盈率(TTM)" }],
      values: [[20.4]],
    }
    expect(() => checkScreenerBindings(data, requested, "F1 >= 500 && F2 <= 30")).toThrowError(/cannot be evaluated/)
  })

  it("degrades to partial when a disjunct is missing but another branch still holds", () => {
    const data = {
      securityCodeList: ["09992.HK"],
      indicatorList: [{ field: "F2", code: "finc_pe_ttm", name: "市盈率(TTM)" }],
      values: [[14.9]],
    }
    expect(checkScreenerBindings(data, requested, "F1 > 0 || F2 > 0")).toEqual(["F1"])
  })

  it("is fatal when no branch of a disjunction survives", () => {
    const data = { securityCodeList: ["600519.SH"], indicatorList: [], values: [[]] }
    expect(() => checkScreenerBindings(data, requested, "F1 > 0 || F2 > 0")).toThrowError(/cannot be evaluated/)
  })

  // 绑定了但没参与表达式的辅助指标缺列，只是少了输出信息、不影响正确性。
  it("degrades to partial when the missing variable never appears in the expression", () => {
    const data = {
      securityCodeList: ["600519.SH"],
      indicatorList: [{ field: "F1", code: "qte_mkt_cptl", name: "总市值" }],
      values: [[16883]],
    }
    expect(checkScreenerBindings(data, requested, "F1 >= 500")).toEqual(["F2"])
  })

  it("leaves a zero-match result alone — it binds nothing", () => {
    expect(checkScreenerBindings({ securityCodeList: [], indicatorList: [], values: [] }, requested, "F1 >= 500 && F2 <= 30")).toEqual([])
  })
})

// 同一 code 可以合法地绑到两个变量，所以 screener 的列用 `field` 而不是 code 做后缀；
// 且同名列的**每个**出现都要带变量名——裸的「收盘价」挨着「收盘价 (F2)」
// 读起来像「那个收盘价」，实际只是服务端先列的那个。
describe("screener column headers disambiguate by variable", () => {
  it("suffixes every occurrence of a repeated display name with its field", () => {
    const data = {
      securityCodeList: ["600519.SH"],
      indicatorList: [
        { field: "F1", code: "cf_finc_exp", name: "财务费用" },
        { field: "F2", code: "cf_finc_exp_qtr", name: "财务费用" },
      ],
      values: [[100, 40]],
    }
    const row = (flattenCrossSection(data) as { list: Array<Record<string, unknown>> }).list[0]
    expect(row["财务费用 (F1)"]).toBe(100)
    expect(row["财务费用 (F2)"]).toBe(40)
    expect(row).not.toHaveProperty("财务费用")
  })
})

// EDE 是双层信封，traceId 只挂在外层。外层被 unwrapEnvelope 解掉后，内层报错要能
// 拿到它 —— 这类错误恰恰最需要报障（130001 无权限 / 999999 无数据都出在这一层）。
describe("EDE inner-envelope failures carry the outer traceId", () => {
  it("surfaces the traceId parked on the payload by unwrapEnvelope", () => {
    const raw = unwrapEnvelope({ code: "0", data: { code: "130001", status: false, msg: "无数据" }, traceId: "830965" })
    try {
      unwrapIndicatorData(raw)
      throw new Error("should have thrown")
    } catch (err) {
      expect((err as ApiError).code).toBe("130001")
      expect((err as ApiError).traceId).toBe("830965")
    }
  })

  it("stays undefined when the outer envelope sent no traceId", () => {
    const raw = unwrapEnvelope({ code: "0", data: { code: "130001", status: false, msg: "无数据" } })
    expect(() => unwrapIndicatorData(raw)).toThrowError(ApiError)
    try {
      unwrapIndicatorData(raw)
    } catch (err) {
      expect((err as ApiError).traceId).toBeUndefined()
    }
  })

  // 形状报错也要能报障：unwrapIndicatorData 把外层 traceId 转交给内层载荷，
  // 否则下游拍平函数看到的内层根本没有它。
  it("hands the traceId to the inner payload so shape failures stay traceable", () => {
    const raw = unwrapEnvelope({ code: "0", data: { securityCodeList: [null], indicatorList: [], values: [] }, traceId: "424242" })
    try {
      flattenCrossSection(unwrapIndicatorData(raw))
      throw new Error("should have thrown")
    } catch (err) {
      expect((err as ApiError).traceId).toBe("424242")
    }
  })
})
