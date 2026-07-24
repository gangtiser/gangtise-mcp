import { describe, it, expect } from "vitest"
import { normalizeRows } from "../../../src/core/normalize.js"

describe("normalizeRows", () => {
  it("passes through primitives, null, and arrays unchanged", () => {
    expect(normalizeRows(null)).toBeNull()
    expect(normalizeRows("text")).toBe("text")
    expect(normalizeRows([1, 2])).toEqual([1, 2])
  })

  it("zips fieldList + row arrays into keyed objects, preserving meta", () => {
    const raw = {
      fieldList: ["tradeDate", "close"],
      list: [["2026-06-09", 1700.5], ["2026-06-10", 1711.0]],
      total: 2,
    }
    expect(normalizeRows(raw)).toEqual({
      total: 2,
      list: [
        { tradeDate: "2026-06-09", close: 1700.5 },
        { tradeDate: "2026-06-10", close: 1711.0 },
      ],
    })
  })

  it("returns a bare array when fieldList + list come without meta", () => {
    const raw = { fieldList: ["a"], list: [[1]] }
    expect(normalizeRows(raw)).toEqual([{ a: 1 }])
  })

  // 上游对「fieldList 含该接口不存在的字段名」的处理：值只按**有效**字段返回、字段名却按
  // **请求**回显 → 两者长度不等。按位置拍平会把值贴到错误的字段上：实测 realtime 传
  // ["securityCode","close","turnoverRate"]（无 close）会把换手率 28.5573 贴成 close，
  // 读起来就是「茅台收盘价 28.56」（真实价 ~1297）。静默错列必须变成显式失败。
  it("throws instead of mis-zipping when the row is shorter than fieldList (invalid field name)", () => {
    const raw = {
      fieldList: ["securityCode", "close", "turnoverRate"],
      list: [["600519.SH", 28.5573]],
      total: 1,
    }
    expect(() => normalizeRows(raw)).toThrowError(/响应字段数与请求 fieldList 不匹配/)
  })

  it("leaves non-array rows in a fieldList response untouched", () => {
    const raw = { fieldList: ["a"], list: [{ already: "object" }], total: 1 }
    expect(normalizeRows(raw)).toEqual({ total: 1, list: [{ already: "object" }] })
  })

  it("unwraps a plain list, keeping meta only when present", () => {
    expect(normalizeRows({ list: [1, 2], total: 2 })).toEqual({ total: 2, list: [1, 2] })
    expect(normalizeRows({ list: [1, 2] })).toEqual([1, 2])
  })

  it("renames constants to list, preserving category metadata", () => {
    const raw = {
      category: "citicIndustry",
      structureType: "flat",
      maxLevel: 1,
      constantCount: 2,
      constants: [{ constantId: "1", constantName: "石油石化", level: 1 }, { constantId: "2", constantName: "煤炭", level: 1 }],
    }
    expect(normalizeRows(raw)).toEqual({
      category: "citicIndustry",
      structureType: "flat",
      maxLevel: 1,
      constantCount: 2,
      list: raw.constants,
    })
    expect(normalizeRows({ constants: [{ constantId: "1" }] })).toEqual([{ constantId: "1" }])
  })

  it("normalizes a null constants payload to an empty list, keeping the key stable", () => {
    const raw = {
      category: "swIndustry",
      structureType: "flat",
      maxLevel: 1,
      constantCount: null,
      constants: null,
    }
    expect(normalizeRows(raw)).toEqual({
      category: "swIndustry",
      structureType: "flat",
      maxLevel: 1,
      constantCount: null,
      list: [],
    })
    expect(normalizeRows({ constants: null })).toEqual([])
  })
})
