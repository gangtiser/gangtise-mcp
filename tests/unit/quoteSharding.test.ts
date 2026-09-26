import { describe, expect, it, vi } from "vitest"
import { callKlinePerSecurity, callKlineWithSharding, estimateTradingDays } from "../../src/core/quoteSharding.js"
import { ResponseShapeError } from "../../src/core/errors.js"

describe("callKlineWithSharding", () => {
  it("injects API-max limit (10000) for security='all' when user didn't set limit", async () => {
    const seenBodies: Array<Record<string, unknown>> = []
    const call = vi.fn().mockImplementation(async (_key: string, body: Record<string, unknown>) => {
      seenBodies.push(body)
      return { list: [] }
    })

    await callKlineWithSharding({ call }, "quote.day-kline", {
      securityList: ["all"],
      startDate: "2026-04-01",
      endDate: "2026-04-05",
    }, { shardDays: 1 })

    expect(seenBodies.length).toBeGreaterThan(0)
    for (const b of seenBodies) {
      expect(b.limit).toBe(10_000)
    }
  })

  it("preserves a user-supplied limit instead of overriding it", async () => {
    const seenBodies: Array<Record<string, unknown>> = []
    const call = vi.fn().mockImplementation(async (_key: string, body: Record<string, unknown>) => {
      seenBodies.push(body)
      return { list: [] }
    })

    await callKlineWithSharding({ call }, "quote.day-kline", {
      securityList: ["all"],
      startDate: "2026-04-01",
      endDate: "2026-04-05",
      limit: 500,
    }, { shardDays: 1 })

    for (const b of seenBodies) {
      expect(b.limit).toBe(500)
    }
  })

  it("returns a loud partial result when some shards fail", async () => {
    const call = vi.fn().mockImplementation(async (_key: string, body: Record<string, unknown>) => {
      if (body.startDate === "2026-04-03") throw new Error("shard 0403 failed")
      return { fieldList: ["tradeDate"], list: [{ tradeDate: body.startDate }] }
    })

    const result = await callKlineWithSharding({ call }, "quote.day-kline", {
      securityList: ["all"],
      startDate: "2026-03-30", // Monday — a weekday-only window (weekends are skipped)
      endDate: "2026-04-03", // Friday
    }, { shardDays: 1 }) as Record<string, unknown>

    expect(result._partial).toBe(true)
    expect(Array.isArray(result.list)).toBe(true)
    expect((result.list as unknown[]).length).toBe(4) // 5 weekday shards, 1 failed
    expect(Array.isArray(result._failed_shards)).toBe(true)
    expect((result._failed_shards as Array<{ startDate: string }>).some((s) => s.startDate === "2026-04-03")).toBe(true)
  })

  it("throws when every shard fails (does not mask a systemic error)", async () => {
    const call = vi.fn().mockRejectedValue(new Error("auth expired"))

    await expect(callKlineWithSharding({ call }, "quote.day-kline", {
      securityList: ["all"],
      startDate: "2026-04-01",
      endDate: "2026-04-05",
    }, { shardDays: 1 })).rejects.toThrow("auth expired")
  })

  // Missing either date used to bypass the limit lift entirely (raw body sent),
  // so upstream applied its default 6000-row cap and silently truncated a
  // full-market query with no _partial marker.
  it("lifts the limit for security='all' even when a date is missing", async () => {
    const seenBodies: Array<Record<string, unknown>> = []
    const call = vi.fn().mockImplementation(async (_key: string, body: Record<string, unknown>) => {
      seenBodies.push(body)
      return { list: [] }
    })

    await callKlineWithSharding({ call }, "quote.day-kline", {
      securityList: ["all"],
      startDate: "2026-04-01",
    }, { shardDays: 1 })

    expect(seenBodies).toHaveLength(1)
    expect(seenBodies[0].limit).toBe(10_000)
  })

  // HK kline runs 2-day shards in production but every test used shardDays: 1,
  // leaving the shard boundary math (no overlap, no gap, truncated tail) and
  // the merged `total` semantics unpinned.
  it("builds gap-free 2-day shards with a truncated tail and recomputes total from merged rows", async () => {
    const seen: Array<[string, string]> = []
    const call = vi.fn().mockImplementation(async (_key: string, body: Record<string, unknown>) => {
      seen.push([body.startDate as string, body.endDate as string])
      return { fieldList: ["tradeDate"], list: [[body.startDate]], total: 1 }
    })

    const result = await callKlineWithSharding({ call }, "quote.day-kline-hk", {
      securityList: ["all"],
      startDate: "2026-04-01",
      endDate: "2026-04-05",
    }, { shardDays: 2 }) as Record<string, unknown>

    expect(seen).toEqual([
      ["2026-04-01", "2026-04-02"],
      ["2026-04-03", "2026-04-04"],
      ["2026-04-05", "2026-04-05"],
    ])
    expect((result.list as unknown[]).length).toBe(3)
    // total must describe the merged result, not leak the first shard's count.
    expect(result.total).toBe(3)
  })

  // A multi-year range would fire thousands of shard requests and merge more
  // rows than a single JSON.stringify can hold (V8 string limit) — the whole
  // batch would succeed and then be thrown away. Fail loudly up front instead.
  it("rejects an oversized all-market range before firing thousands of shards", async () => {
    const call = vi.fn().mockResolvedValue({ list: [] })

    await expect(callKlineWithSharding({ call }, "quote.day-kline", {
      securityList: ["all"],
      startDate: "2024-01-01",
      endDate: "2026-06-30",
    }, { shardDays: 1 })).rejects.toThrow(/区间过大|缩小/)
    expect(call).not.toHaveBeenCalled()
  })

  // v0.23: a shard whose row count reaches the per-request limit was itself capped,
  // so its slice of that day's market is incomplete — the merged result must be flagged.
  it("flags _partial limit_truncated when a shard's rows reach the per-shard limit", async () => {
    const call = vi.fn().mockImplementation(async (_key: string, body: Record<string, unknown>) => {
      // Each shard returns exactly `limit` (2) rows → a truncated slice.
      return { fieldList: ["tradeDate"], list: [{ tradeDate: body.startDate }, { tradeDate: body.startDate }], total: 2 }
    })

    const result = await callKlineWithSharding({ call }, "quote.day-kline", {
      securityList: ["all"],
      startDate: "2026-04-01",
      endDate: "2026-04-03",
      limit: 2,
    }, { shardDays: 1 }) as Record<string, unknown>

    expect(result._partial).toBe(true)
    expect(result._partial_reason).toBe("limit_truncated")
    expect((result.list as unknown[]).length).toBe(6) // 3 shards × 2 rows
  })

  // The single-request full-market path (missing/short range) skips the merge loop,
  // so it needs the same inline truncation check — e.g. index 'all' over one 30-day window.
  it("flags _partial limit_truncated on a single full-market request that hits the limit", async () => {
    const call = vi.fn().mockResolvedValue({ list: [{ a: 1 }, { a: 2 }], total: 2 })

    const result = await callKlineWithSharding({ call }, "quote.index-day-kline", {
      securityList: ["all"],
      startDate: "2026-04-01", // endDate omitted → single request, no sharding
      limit: 2,
    }, { shardDays: 30 }) as Record<string, unknown>

    expect(call).toHaveBeenCalledTimes(1)
    expect(result._partial).toBe(true)
    expect(result._partial_reason).toBe("limit_truncated")
  })

  it("does not touch single-security queries", async () => {
    const seenBodies: Array<Record<string, unknown>> = []
    const call = vi.fn().mockImplementation(async (_key: string, body: Record<string, unknown>) => {
      seenBodies.push(body)
      return { list: [] }
    })

    await callKlineWithSharding({ call }, "quote.day-kline", {
      securityList: ["600519.SH"],
      startDate: "2026-04-01",
      endDate: "2026-04-05",
    }, { shardDays: 1 })

    expect(seenBodies).toHaveLength(1)
    expect(seenBodies[0].limit).toBeUndefined()
  })
})

// Weekend skip (synced from CLI v0.24): A/HK/US markets are closed Sat/Sun, so
// 1-day full-market shards on those dates are guaranteed-empty requests — skip
// them to save quota. Multi-day shards are unaffected.
describe("weekend skip for 1-day shards", () => {
  it("skips Saturday and Sunday shards in a Mon–Sun range", async () => {
    const seenDates: string[] = []
    const call = vi.fn().mockImplementation(async (_key: string, body: Record<string, unknown>) => {
      seenDates.push(String(body.startDate))
      return { list: [] }
    })

    await callKlineWithSharding({ call }, "quote.day-kline", {
      securityList: ["all"],
      startDate: "2026-07-06", // Monday
      endDate: "2026-07-12", // Sunday
    }, { shardDays: 1 })

    expect(seenDates).toEqual(["2026-07-06", "2026-07-07", "2026-07-08", "2026-07-09", "2026-07-10"])
  })

  it("returns empty without any API call for a weekend-only range", async () => {
    const call = vi.fn()
    const result = await callKlineWithSharding({ call }, "quote.day-kline", {
      securityList: ["all"],
      startDate: "2026-07-11", // Saturday
      endDate: "2026-07-12", // Sunday
    }, { shardDays: 1 })
    expect(call).not.toHaveBeenCalled()
    expect(result).toEqual({ list: [] })
  })

  it("keeps weekend days inside multi-day shards", async () => {
    const seen: Array<{ start: string; end: string }> = []
    const call = vi.fn().mockImplementation(async (_key: string, body: Record<string, unknown>) => {
      seen.push({ start: String(body.startDate), end: String(body.endDate) })
      return { list: [] }
    })

    await callKlineWithSharding({ call }, "quote.day-kline-hk", {
      securityList: ["all"],
      startDate: "2026-07-10", // Friday
      endDate: "2026-07-13", // Monday
    }, { shardDays: 2 })

    expect(seen).toEqual([
      { start: "2026-07-10", end: "2026-07-11" },
      { start: "2026-07-12", end: "2026-07-13" },
    ])
  })
})

// Symmetric with _failed_shards (synced from CLI v0.27): name the exact date
// windows that hit the per-shard cap so a consumer can re-pull just those days
// with a narrower window instead of guessing.
describe("truncated shard reporting", () => {
  it("lists the date ranges of limit-capped shards in _truncated_shards", async () => {
    const call = vi.fn().mockImplementation(async (_key: string, body: Record<string, unknown>) => {
      if (body.startDate === "2026-07-07") {
        return { list: [{ d: 1 }, { d: 2 }] } // reaches the limit of 2
      }
      return { list: [{ d: 1 }] }
    })

    const result = await callKlineWithSharding({ call }, "quote.day-kline", {
      securityList: ["all"],
      startDate: "2026-07-06",
      endDate: "2026-07-08",
      limit: 2,
    }, { shardDays: 1 }) as Record<string, unknown>

    expect(result._partial).toBe(true)
    expect(String(result._partial_reason)).toContain("limit_truncated")
    expect(result._truncated_shards).toEqual([{ startDate: "2026-07-07", endDate: "2026-07-07" }])
  })
})

// The single-request fast path (totalDays <= shardDays) must apply the same
// weekend rule as the sharded path — a one-day Sat/Sun window on a 1-day-shard
// endpoint is a guaranteed-empty request.
describe("weekend skip on the single-request fast path", () => {
  it("returns empty without an API call for a single Saturday", async () => {
    const call = vi.fn()
    const result = await callKlineWithSharding({ call }, "quote.day-kline", {
      securityList: ["all"],
      startDate: "2026-07-11",
      endDate: "2026-07-11",
    }, { shardDays: 1 })
    expect(call).not.toHaveBeenCalled()
    expect(result).toEqual({ list: [] })
  })

  it("returns empty without an API call for a single Sunday", async () => {
    const call = vi.fn()
    const result = await callKlineWithSharding({ call }, "quote.day-kline", {
      securityList: ["all"],
      startDate: "2026-07-12",
      endDate: "2026-07-12",
    }, { shardDays: 1 })
    expect(call).not.toHaveBeenCalled()
    expect(result).toEqual({ list: [] })
  })

  it("still fires the single request for a one-day weekday window", async () => {
    const call = vi.fn().mockResolvedValue({ list: [] })
    await callKlineWithSharding({ call }, "quote.day-kline", {
      securityList: ["all"],
      startDate: "2026-07-10", // Friday
      endDate: "2026-07-10",
    }, { shardDays: 1 })
    expect(call).toHaveBeenCalledTimes(1)
  })
})

// 🔴 分片形状漂移此前是**静默丢数据**：没有数组 `list` 的分片被 `continue` 掉，
// 既不进 merged 也不标 _partial —— 一天的全市场行情凭空消失而结果读起来完整。
describe("callKlineWithSharding: malformed shard shapes", () => {
  const range = { securityList: ["all"], startDate: "2026-04-06", endDate: "2026-04-09" }

  it("flags a shard whose payload carries no list, instead of dropping it silently", async () => {
    let n = 0
    const call = vi.fn().mockImplementation(async () => {
      n += 1
      // 第二个分片形状漂移（有回包、没 list）
      return n === 2 ? { note: "upstream-shape-changed" } : { list: [{ securityCode: `s${n}` }] }
    })

    const out = await callKlineWithSharding({ call }, "quote.day-kline", range, { shardDays: 1 }) as Record<string, unknown>

    expect(out._partial).toBe(true)
    expect(String(out._partial_reason)).toContain("malformed_shards")
    expect(out._malformed_shards).toEqual([{ startDate: "2026-04-07", endDate: "2026-04-07" }])
    // 好分片的行仍然合并返回 —— 标记是附加信号，不是把结果丢掉
    expect((out.list as unknown[]).length).toBe(3)
  })

  it("throws when EVERY shard is malformed rather than returning a clean empty table", async () => {
    const call = vi.fn().mockResolvedValue({ note: "upstream-shape-changed" })
    await expect(
      callKlineWithSharding({ call }, "quote.day-kline", range, { shardDays: 1 }),
    ).rejects.toThrow(/没有可合并的 list/)
  })

  it("treats {total:0, list:null} as a legitimately empty shard, not a malformed one", async () => {
    let n = 0
    const call = vi.fn().mockImplementation(async () => {
      n += 1
      return n === 2 ? { total: 0, list: null } : { total: 1, list: [{ securityCode: `s${n}` }] }
    })

    const out = await callKlineWithSharding({ call }, "quote.day-kline", range, { shardDays: 1 }) as Record<string, unknown>

    expect(out._partial).toBeUndefined()
    expect(out._malformed_shards).toBeUndefined()
    expect((out.list as unknown[]).length).toBe(3)
  })

  it("still merges a non-object shard as malformed rather than crashing", async () => {
    let n = 0
    const call = vi.fn().mockImplementation(async () => {
      n += 1
      return n === 2 ? [{ rogue: true }] : { list: [{ securityCode: `s${n}` }] }
    })

    const out = await callKlineWithSharding({ call }, "quote.day-kline", range, { shardDays: 1 }) as Record<string, unknown>
    expect(String(out._partial_reason)).toContain("malformed_shards")
  })
})

// 🔴 合并采用首片的 fieldList 解释全部分片，而没有谁保证各片列顺序一致。第二片把
// open/close 调个位置，按位置并进来就是开盘价与收盘价互换：列数相同、长度校验抓不到、
// 也不标 _partial —— 一份读起来完全正常的错数。必须按列名对齐。
describe("shard column alignment", () => {
  const range = { securityList: ["all"], startDate: "2026-03-30", endDate: "2026-04-01" }

  it("realigns a shard whose columns come back in a different order", async () => {
    let n = 0
    const call = vi.fn().mockImplementation(async () => {
      n += 1
      return n === 1
        ? { fieldList: ["securityCode", "open", "close"], list: [["600519.SH", 1, 2]] }
        // 同样三列，顺序不同：open=1 / close=2 的语义必须跟着列名走。
        : { fieldList: ["securityCode", "close", "open"], list: [["600519.SH", 20, 10]] }
    })

    const out = await callKlineWithSharding({ call }, "quote.day-kline", range, { shardDays: 1 }) as Record<string, unknown>

    expect(out.fieldList).toEqual(["securityCode", "open", "close"])
    // 第二片重排后必须是 [代码, open=10, close=20]，不是原样的 [代码, 20, 10]。
    expect(out.list).toEqual([["600519.SH", 1, 2], ["600519.SH", 10, 20], ["600519.SH", 10, 20]])
    expect(out._partial).toBeUndefined()
  })

  it("drops a shard whose column set cannot be aligned, and says so", async () => {
    let n = 0
    const call = vi.fn().mockImplementation(async () => {
      n += 1
      return n === 1
        ? { fieldList: ["securityCode", "open", "close"], list: [["600519.SH", 1, 2]] }
        : { fieldList: ["securityCode", "open", "high"], list: [["600519.SH", 1, 9]] }  // 没有 close
    })

    const out = await callKlineWithSharding({ call }, "quote.day-kline", range, { shardDays: 1 }) as Record<string, unknown>

    expect(String(out._partial_reason)).toContain("malformed_shards")
    expect(out.list).toEqual([["600519.SH", 1, 2]])
  })

  it("drops a shard whose columnar rows do not match its own fieldList", async () => {
    let n = 0
    const call = vi.fn().mockImplementation(async () => {
      n += 1
      return n === 1
        ? { fieldList: ["securityCode", "open"], list: [["600519.SH", 1]] }
        : { fieldList: ["securityCode", "open"], list: [["600519.SH", 1, 999]] }  // 行长多一格
    })

    const out = await callKlineWithSharding({ call }, "quote.day-kline", range, { shardDays: 1 }) as Record<string, unknown>
    expect(String(out._partial_reason)).toContain("malformed_shards")
    expect(out.list).toEqual([["600519.SH", 1]])
  })

  it("drops a shard whose fieldList has duplicate column names", async () => {
    let n = 0
    const call = vi.fn().mockImplementation(async () => {
      n += 1
      return n === 1
        ? { fieldList: ["securityCode", "open"], list: [["600519.SH", 1]] }
        : { fieldList: ["open", "open"], list: [["600519.SH", 1]] }
    })

    const out = await callKlineWithSharding({ call }, "quote.day-kline", range, { shardDays: 1 }) as Record<string, unknown>
    expect(String(out._partial_reason)).toContain("malformed_shards")
  })

  // 对象行没有列顺序问题，不该被列对齐逻辑波及。
  it("leaves object rows alone", async () => {
    const call = vi.fn().mockImplementation(async (_k: string, body: Record<string, unknown>) => ({
      fieldList: ["tradeDate"],
      list: [{ tradeDate: body.startDate, close: 1 }],
    }))
    const out = await callKlineWithSharding({ call }, "quote.day-kline", range, { shardDays: 1 }) as Record<string, unknown>
    expect((out.list as unknown[]).length).toBe(3)
    expect(out._partial).toBeUndefined()
  })

  // 合并结果只展开首片的元数据、随后又覆写 _partial_reason —— 不单独收集的话，
  // 非首片自带的 _partial 会在合并时整个消失。
  it("carries a non-first shard's own _partial into the merged result", async () => {
    let n = 0
    const call = vi.fn().mockImplementation(async () => {
      n += 1
      return n === 2
        ? { list: [{ id: n }], _partial: true, _partial_reason: "limit_truncated" }
        : { list: [{ id: n }] }
    })
    const out = await callKlineWithSharding({ call }, "quote.day-kline", range, { shardDays: 1 }) as Record<string, unknown>
    expect(out._partial).toBe(true)
    expect(String(out._partial_reason)).toContain("limit_truncated")
  })
})

// 显式多证券且单请求装不下时逐只拉：单请求会在窗口开头截断，只剩前几只的前几个月，
// 且只有一个 _partial 说不清缺了谁。
describe("callKlinePerSecurity", () => {
  it("merges per-security parts in the requested order", async () => {
    const call = vi.fn().mockImplementation(async (_k: string, body: Record<string, unknown>) => ({
      fieldList: ["securityCode"],
      list: [[(body.securityList as string[])[0]]],
      total: 1,
    }))

    const out = await callKlinePerSecurity(
      { call }, "quote.day-kline", ["600519.SH", "000858.SZ"],
      (code) => ({ securityList: [code] }), 6000,
    ) as Record<string, unknown>

    expect(out.list).toEqual([["600519.SH"], ["000858.SZ"]])
    expect(out.total).toBe(2)
    expect(out._partial).toBeUndefined()
  })

  it("names the securities that hit the per-request limit", async () => {
    const call = vi.fn().mockImplementation(async (_k: string, body: Record<string, unknown>) => {
      const code = (body.securityList as string[])[0]
      return { list: code === "000858.SZ" ? [{ a: 1 }, { a: 2 }] : [{ a: 1 }] }
    })

    const out = await callKlinePerSecurity(
      { call }, "quote.day-kline", ["600519.SH", "000858.SZ"],
      (code) => ({ securityList: [code] }), 2,
    ) as Record<string, unknown>

    expect(out._partial).toBe(true)
    expect(String(out._partial_reason)).toContain("limit_truncated")
    expect(out._truncated_securities).toEqual(["000858.SZ"])
  })

  it("keeps the securities that worked when one fails, and names the failure", async () => {
    const call = vi.fn().mockImplementation(async (_k: string, body: Record<string, unknown>) => {
      if ((body.securityList as string[])[0] === "000858.SZ") throw new Error("boom")
      return { list: [{ a: 1 }] }
    })

    const out = await callKlinePerSecurity(
      { call }, "quote.day-kline", ["600519.SH", "000858.SZ"],
      (code) => ({ securityList: [code] }), 6000,
    ) as Record<string, unknown>

    expect(String(out._partial_reason)).toContain("failed_securities")
    expect((out._failed_securities as Array<{ security: string }>)[0].security).toBe("000858.SZ")
    expect((out.list as unknown[]).length).toBe(1)
  })

  it("throws the original error when every security fails", async () => {
    const call = vi.fn().mockRejectedValue(new Error("auth expired"))
    await expect(callKlinePerSecurity(
      { call }, "quote.day-kline", ["600519.SH", "000858.SZ"],
      (code) => ({ securityList: [code] }), 6000,
    )).rejects.toThrow("auth expired")
  })
})

describe("estimateTradingDays", () => {
  it("counts weekdays inclusive and skips the weekend", () => {
    expect(estimateTradingDays("2026-03-30", "2026-04-03")).toBe(5)   // Mon–Fri
    expect(estimateTradingDays("2026-03-28", "2026-03-29")).toBe(0)   // Sat+Sun
  })

  it("falls back to a year when the start date is missing or unparseable", () => {
    expect(estimateTradingDays(undefined, "2026-04-03")).toBe(262)
    expect(estimateTradingDays("nope", "2026-04-03")).toBe(262)
  })
})

// 🔴 后片比首片**多**出来的列此前被静默丢掉：合并结果的 fieldList 取自首片，多的列没有
// 位置可放，于是那几天/那几只确实返回了的一列凭空消失，结果读起来还是完整的。
// 列丢可以接受（fieldList 是首片的契约），静默不行。
describe("shard column supersets are reported, not silently dropped", () => {
  const range = { securityList: ["all"], startDate: "2026-03-30", endDate: "2026-03-31" }

  it("names the columns a later shard had but the merged fieldList cannot hold", async () => {
    let n = 0
    const call = vi.fn().mockImplementation(async () => {
      n += 1
      return n === 1
        ? { fieldList: ["securityCode", "open"], list: [["600519.SH", 1]] }
        : { fieldList: ["securityCode", "open", "close"], list: [["000858.SZ", 10, 20]] }
    })

    const out = await callKlineWithSharding({ call }, "quote.day-kline", range, { shardDays: 1 }) as Record<string, unknown>

    expect(out._partial).toBe(true)
    expect(String(out._partial_reason)).toContain("dropped_columns")
    expect(out._dropped_columns).toEqual(["close"])
    // 保留下来的列仍要对得上：多出来的那一列被剔掉，不是把值挤到别的列里。
    expect(out.fieldList).toEqual(["securityCode", "open"])
    expect(out.list).toEqual([["600519.SH", 1], ["000858.SZ", 10]])
  })

  it("stays quiet when every shard has the same columns", async () => {
    const call = vi.fn().mockImplementation(async (_k: string, body: Record<string, unknown>) => ({
      fieldList: ["securityCode", "open"],
      list: [[String(body.startDate), 1]],
    }))
    const out = await callKlineWithSharding({ call }, "quote.day-kline", range, { shardDays: 1 }) as Record<string, unknown>
    expect(out._partial).toBeUndefined()
    expect(out._dropped_columns).toBeUndefined()
  })

  it("reports the same way on the per-security path", async () => {
    const call = vi.fn().mockImplementation(async (_k: string, body: Record<string, unknown>) =>
      body.securityCode === "600519.SH"
        ? { fieldList: ["securityCode", "open"], list: [["600519.SH", 1]] }
        : { fieldList: ["securityCode", "open", "close"], list: [["000858.SZ", 10, 20]] },
    )

    const out = await callKlinePerSecurity(
      { call }, "quote.day-kline", ["600519.SH", "000858.SZ"],
      (securityCode) => ({ securityCode }), 6000,
    ) as Record<string, unknown>

    expect(String(out._partial_reason)).toContain("dropped_columns")
    expect(out._dropped_columns).toEqual(["close"])
  })

  // 缺列（首片有、这片没有）与多列是两种事：前者对不齐、整片不能并，后者只是放不下。
  it("keeps missing-column shards distinct from superset shards", async () => {
    let n = 0
    const call = vi.fn().mockImplementation(async () => {
      n += 1
      return n === 1
        ? { fieldList: ["securityCode", "open"], list: [["600519.SH", 1]] }
        : { fieldList: ["securityCode", "close"], list: [["000858.SZ", 20]] }  // 没有 open
    })
    const out = await callKlineWithSharding({ call }, "quote.day-kline", range, { shardDays: 1 }) as Record<string, unknown>
    expect(String(out._partial_reason)).toContain("malformed_shards")
    expect(out._dropped_columns).toBeUndefined()
  })
})

// 「没有可读 list」的载荷由端点的 `expects` 在 client 里拦下（ResponseShapeError，带 traceId）。
// 分片层要做的只有两件：单请求路径把它原样抛给调用方；多片路径把那一片记成 malformed、其余照常合并。
describe("全市场单请求路径的形状护栏", () => {
  const shapeError = () => new ResponseShapeError("响应不是预期的列表结构", 200, { code: "000000", traceId: "t-1" }, { total: 42, fieldList: ["securityCode", "close"] })

  it.each([
    ["单日区间（一个分片就装下）", { securityList: ["all"], startDate: "2026-04-01", endDate: "2026-04-01" }],
    ["缺起止日期", { securityList: ["all"] }],
  ])("surfaces the client's shape error on the single-request path — %s", async (_label, body) => {
    const call = vi.fn().mockRejectedValue(shapeError())
    await expect(
      callKlineWithSharding({ call }, "quote.day-kline", body, { shardDays: 1, tool: "gangtise_day_kline" }),
    ).rejects.toBeInstanceOf(ResponseShapeError)
  })

  it("records a shard whose payload failed the shape check as malformed and merges the rest", async () => {
    const call = vi.fn().mockImplementation(async (_key: string, body: { startDate: string }) => {
      if (body.startDate === "2026-04-02") throw shapeError()
      return { total: 1, fieldList: ["securityCode", "tradeDate"], list: [["600519.SH", body.startDate]] }
    })
    const r = await callKlineWithSharding(
      { call }, "quote.day-kline",
      { securityList: ["all"], startDate: "2026-04-01", endDate: "2026-04-03" },
      { shardDays: 1, tool: "t" },
    ) as Record<string, unknown>
    expect(r._partial_reason).toBe("malformed_shards")
    expect(r._malformed_shards).toEqual([{ startDate: "2026-04-02", endDate: "2026-04-02" }])
    expect(r._failed_shards).toBeUndefined()
    expect((r.list as unknown[]).length).toBe(2)
  })

  // `{total: 0, list: null}` 是部分端点编码零行的合法写法，不能被这道护栏误伤。
  it("still accepts the documented empty-result shape", async () => {
    const call = vi.fn().mockResolvedValue({ total: 0, list: null })
    const r = await callKlineWithSharding({ call }, "quote.day-kline", { securityList: ["all"] }, { shardDays: 1, tool: "t" })
    expect(r).toEqual({ total: 0, list: null })
  })

  it("lets a normal single-day result through", async () => {
    const call = vi.fn().mockResolvedValue({ total: 1, list: [{ securityCode: "600519.SH", close: 1 }] })
    const r = await callKlineWithSharding(
      { call }, "quote.day-kline",
      { securityList: ["all"], startDate: "2026-04-01", endDate: "2026-04-01" },
      { shardDays: 1, tool: "t" },
    )
    expect((r as { list: unknown[] }).list).toHaveLength(1)
  })

  // 周六日是必然空的请求，压根不发 —— 护栏不该改变这条捷径。
  it("keeps the weekend short-circuit", async () => {
    const call = vi.fn()
    const r = await callKlineWithSharding(
      { call }, "quote.day-kline",
      { securityList: ["all"], startDate: "2026-04-04", endDate: "2026-04-04" },
      { shardDays: 1, tool: "t" },
    )
    expect(r).toEqual({ list: [] })
    expect(call).not.toHaveBeenCalled()
  })
})
