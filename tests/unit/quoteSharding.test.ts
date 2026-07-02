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
      startDate: "2026-04-01",
      endDate: "2026-04-05",
    }, { shardDays: 1 }) as Record<string, unknown>

    expect(result._partial).toBe(true)
    expect(Array.isArray(result.list)).toBe(true)
    expect((result.list as unknown[]).length).toBe(4) // 5 shards, 1 failed
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
