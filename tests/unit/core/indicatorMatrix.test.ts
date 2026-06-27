import { describe, it, expect } from "vitest"
import { unwrapIndicatorData, flattenCrossSection, flattenTimeSeries } from "../../../src/core/indicatorMatrix.js"
import { ApiError } from "../../../src/core/errors.js"

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
