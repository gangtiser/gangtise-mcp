import { describe, expect, it, vi } from "vitest"
import { callKlineWithSharding } from "../../src/core/quoteSharding.js"

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
