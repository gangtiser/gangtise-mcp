import { describe, it, expect } from "vitest"
import { unwrapIndicatorData, flattenCrossSection, flattenTimeSeries } from "../../../src/core/indicatorMatrix.js"
import { ApiError } from "../../../src/core/errors.js"
import { unwrapEnvelope } from "../../../src/core/envelope.js"

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
  it("pivots the [indicator][security] matrix to one row per security", () => {
    const data = {
      date: "2026-06-26",
      securityCodeList: ["600519.SH", "000001.SZ"],
      securityNameList: ["贵州茅台", "平安银行"],
      indicatorCodeList: ["qte_close", "qte_volume"],
      indicatorNameList: ["收盘价", "成交量"],
      values: [
        [1800, 11],
        [5000, 9000],
      ],
    }
    const result = flattenCrossSection(data) as { list: Array<Record<string, unknown>>; total: number }
    expect(result.total).toBe(2)
    expect(result.list[0]).toEqual({ date: "2026-06-26", security: "600519.SH", name: "贵州茅台", 收盘价: 1800, 成交量: 5000 })
    expect(result.list[1]).toEqual({ date: "2026-06-26", security: "000001.SZ", name: "平安银行", 收盘价: 11, 成交量: 9000 })
  })

  it("returns the payload unchanged when the matrix shape is unexpected", () => {
    const data = { foo: "bar" }
    expect(flattenCrossSection(data)).toBe(data)
  })

  // 服务端会重排返回列序；flatten 按响应数组的共同索引绑定 name[i]↔code[i]↔values[i]，
  // 故不会贴错值。同显示名的指标（如 cf_finc_exp / _qtr 都叫「财务费用」）以 code 后缀
  // 区分、互不覆盖——这正是 CLI 拍平按名/位置会错、而本 flatten 不会错的原因。
  it("aligns by response index and keeps same-named indicators (dup name → code suffix, no overwrite)", () => {
    const data = {
      date: "2026-03-31",
      securityCodeList: ["600519.SH"],
      securityNameList: ["贵州茅台"],
      indicatorCodeList: ["cf_finc_exp", "is_op_rev", "cf_finc_exp_qtr"],
      indicatorNameList: ["财务费用", "营业收入(利润表,累计)", "财务费用"],
      values: [[100], [1688], [40]],
    }
    const row = (flattenCrossSection(data) as { list: Array<Record<string, unknown>> }).list[0]
    expect(row["财务费用"]).toBe(100) // 第一个「财务费用」= cf_finc_exp
    expect(row["营业收入(利润表,累计)"]).toBe(1688)
    expect(row["财务费用 (cf_finc_exp_qtr)"]).toBe(40) // 同名第二个加 code 后缀，值不丢
  })
})

describe("flattenTimeSeries", () => {
  it("uses indicators as columns for a single security", () => {
    const data = {
      dates: ["2026-06-25", "2026-06-26"],
      securityCodeList: ["600519.SH"],
      indicatorCodeList: ["qte_close", "qte_open"],
      indicatorNameList: ["收盘价", "开盘价"],
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
      indicatorCodeList: ["qte_close"],
      values: [
        [1800],
        [11],
      ],
    }
    const result = flattenTimeSeries(data) as { list: Array<Record<string, unknown>> }
    expect(result.list[0]).toEqual({ date: "2026-06-26", 贵州茅台: 1800, 平安银行: 11 })
  })
})

// An indicator whose display name collides with a metadata column (date /
// security / name) must be suffixed, not silently overwrite the metadata.
describe("reserved metadata column collision", () => {
  it("suffixes an indicator named 'date' in cross-section rows", () => {
    const data = {
      date: "2026-07-10",
      securityCodeList: ["600519.SH"],
      securityNameList: ["贵州茅台"],
      indicatorCodeList: ["ind_a"],
      indicatorNameList: ["date"],
      values: [[1800]],
    }
    const result = flattenCrossSection(data) as { list: Array<Record<string, unknown>> }
    expect(result.list[0].date).toBe("2026-07-10")
    expect(result.list[0]["date (ind_a)"]).toBe(1800)
  })

  it("suffixes indicators named 'security' / 'name' in cross-section rows", () => {
    const data = {
      date: "2026-07-10",
      securityCodeList: ["600519.SH"],
      securityNameList: ["贵州茅台"],
      indicatorCodeList: ["ind_a", "ind_b"],
      indicatorNameList: ["security", "name"],
      values: [[1], [2]],
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
      indicatorCodeList: ["ind_a"],
      indicatorNameList: ["date"],
      values: [[42]],
    }
    const result = flattenTimeSeries(data) as { list: Array<Record<string, unknown>> }
    expect(result.list[0].date).toBe("2026-07-09")
    expect(result.list[0]["date (ind_a)"]).toBe(42)
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
})
