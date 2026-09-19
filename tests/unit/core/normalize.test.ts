import { describe, it, expect } from "vitest"
import { flagFailedItems, flagMissingFields, normalizeRows } from "../../../src/core/normalize.js"

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

describe("normalizeRows: caller-controlled field names and shape drift", () => {
  // `fieldList` 是调用方可控的。普通对象字面量上 `acc["__proto__"] = v` 走原型 setter：
  // 值是非对象时整格**静默消失**（该列在输出里根本不存在）。用无原型对象后它只是普通属性。
  it("keeps a __proto__ column as ordinary data instead of silently dropping it", () => {
    const out = normalizeRows({
      fieldList: ["securityCode", "__proto__"],
      list: [["600519.SH", "value-not-lost"]],
    }) as unknown[]
    const row = out[0] as Record<string, unknown>
    expect(Object.hasOwn(row, "__proto__")).toBe(true)
    expect(row["__proto__"]).toBe("value-not-lost")
    expect(Object.getPrototypeOf(row)).toBeNull()
  })

  it("treats constants: null as a legitimate empty list", () => {
    expect(normalizeRows({ constants: null, category: "citicIndustry" }))
      .toEqual({ category: "citicIndustry", list: [] })
  })

  // 🔴 其他非数组是形状漂移，不是「这个分类下没有常量」。旧写法一律折成 []，
  // 于是一次返回结构变更会伪装成空码表，调用方拿它去解析行业 ID 只会得出「查不到」。
  it("fails loudly when constants is a non-array, non-null shape", () => {
    expect(() => normalizeRows({ constants: { a: 1 } })).toThrow(/constants 不是数组/)
    expect(() => normalizeRows({ constants: "oops" })).toThrow(/constants 不是数组/)
  })
})

// 数组行按位置拍平，所以列名必须唯一、且必须存在——两者都不成立时，输出要么静默少一列，
// 要么是一批无名数字。
describe("normalizeRows columnar guards", () => {
  it("rejects a fieldList with duplicate column names", () => {
    expect(() => normalizeRows({ fieldList: ["a", "a", "b"], list: [[1, 2, 3]] })).toThrow(/重复列名/)
  })

  it("allows duplicate names when the rows are objects (no positional flattening)", () => {
    // 无额外 meta 时 normalizeRows 返回裸数组（既有约定）。
    expect(normalizeRows({ fieldList: ["a", "a"], list: [{ a: 1 }] })).toEqual([{ a: 1 }])
  })

  it("rejects array rows that arrive without any fieldList", () => {
    expect(() => normalizeRows({ total: 1, list: [[1, 2]] })).toThrow(/没有 fieldList/)
  })

  it("still passes object rows without a fieldList", () => {
    expect(normalizeRows({ total: 1, list: [{ a: 1 }] })).toEqual({ total: 1, list: [{ a: 1 }] })
  })
})

// 行情类接口对不认识的字段名是**名和值一起丢**：长度对得上，结果里就是少一列，
// 没有任何信号。比对请求与返回的 fieldList，缺列要标出来。
describe("flagMissingFields", () => {
  it("marks the columns that were requested but never came back", () => {
    const out = flagMissingFields(
      { fieldList: ["securityCode", "latestPrice"], list: [["600519.SH", 1]] },
      ["securityCode", "latestPrice", "turnoverRate"],
    ) as Record<string, unknown>
    expect(out._partial).toBe(true)
    expect(String(out._partial_reason)).toContain("missing_fields")
    expect(out.missingFields).toEqual(["turnoverRate"])
  })

  it("stays quiet when every requested column came back", () => {
    const out = flagMissingFields(
      { fieldList: ["securityCode"], list: [["600519.SH"]] },
      ["securityCode"],
    ) as Record<string, unknown>
    expect(out._partial).toBeUndefined()
    expect(out.missingFields).toBeUndefined()
  })

  it("appends to an existing _partial_reason instead of overwriting it", () => {
    const out = flagMissingFields(
      { fieldList: ["a"], list: [["x"]], _partial: true, _partial_reason: "limit_truncated" },
      ["a", "b"],
    ) as Record<string, unknown>
    expect(String(out._partial_reason)).toBe("limit_truncated,missing_fields")
  })

  it("is a no-op without a requested fieldList or without a returned one", () => {
    const payload = { fieldList: ["a"], list: [["x"]] }
    expect(flagMissingFields(payload, undefined)).toBe(payload)
    const noFields = { list: [{ a: 1 }] }
    expect(flagMissingFields(noFields, ["a"])).toBe(noFields)
  })
})

// 逐条写操作的失败藏在 `000000` 成功信封里：不查 failList，一次「10 只里 3 只代码写错」
// 会原样报成功，调用方以为 10 只都进池了。
describe("flagFailedItems", () => {
  it("marks a non-empty failList as partial and names the items", () => {
    const out = flagFailedItems({
      successList: ["600519.SH"],
      failList: [{ securityCode: "999999.XX", failReason: "证券不存在" }],
    }) as Record<string, unknown>
    expect(out._partial).toBe(true)
    expect(out._partial_reason).toBe("failed_items")
    expect(out.failedItems).toEqual(["999999.XX（证券不存在）"])
  })

  it("keys a pool failure on poolId", () => {
    const out = flagFailedItems({ failList: [{ poolId: "404", failReason: "池不存在" }] }) as Record<string, unknown>
    expect(out.failedItems).toEqual(["404（池不存在）"])
  })

  it("falls back to the raw entry when neither key is present", () => {
    const out = flagFailedItems({ failList: [{ what: "?" }] }) as Record<string, unknown>
    expect(out.failedItems).toEqual(['{"what":"?"}'])
  })

  it("omits the reason when the server gave none", () => {
    const out = flagFailedItems({ failList: [{ securityCode: "999999.XX" }] }) as Record<string, unknown>
    expect(out.failedItems).toEqual(["999999.XX"])
  })

  it("leaves a fully successful response untouched", () => {
    const input = { successList: ["600519.SH"], failList: [] }
    expect(flagFailedItems(input)).toBe(input)
  })

  it("leaves a response without failList untouched", () => {
    const input = { poolId: "1", poolName: "x" }
    expect(flagFailedItems(input)).toBe(input)
  })

  // `_partial_reason` 是逗号拼接的多原因列表：追加，不覆盖。
  it("appends to an existing partial reason instead of replacing it", () => {
    const out = flagFailedItems({
      _partial: true,
      _partial_reason: "short_page",
      failList: [{ securityCode: "X" }],
    }) as Record<string, unknown>
    expect(out._partial_reason).toBe("short_page,failed_items")
  })

  it("does not duplicate its own reason", () => {
    const out = flagFailedItems({
      _partial_reason: "failed_items",
      failList: [{ securityCode: "X" }],
    }) as Record<string, unknown>
    expect(out._partial_reason).toBe("failed_items")
  })
})
