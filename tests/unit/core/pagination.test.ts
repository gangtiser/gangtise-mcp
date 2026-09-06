import { describe, expect, it } from "vitest"
import { planRemainingPages } from "../../../src/core/client.js"

describe("planRemainingPages", () => {
  it("splits the remaining range into maxPageSize chunks", () => {
    // first page already covered [20), fetch up to 100 with 50/page
    expect(planRemainingPages(20, 100, 50, 1000)).toEqual([
      { from: 20, size: 50 },
      { from: 70, size: 30 },
    ])
  })

  it("handles an exact multiple of the page size", () => {
    expect(planRemainingPages(50, 150, 50, 1000)).toEqual([
      { from: 50, size: 50 },
      { from: 100, size: 50 },
    ])
  })

  it("returns nothing when there is no remaining range", () => {
    expect(planRemainingPages(100, 100, 50, 1000)).toEqual([])
    expect(planRemainingPages(120, 100, 50, 1000)).toEqual([])
  })

  it("caps total pages (including the already-fetched first page) at maxPages", () => {
    // 0..1000 by 50 = 20 remaining requests; maxPages 3 → keep only 2 (first page is the 3rd)
    const reqs = planRemainingPages(0, 1000, 50, 3)
    expect(reqs).toHaveLength(2)
    expect(reqs[0]).toEqual({ from: 0, size: 50 })
    expect(reqs[1]).toEqual({ from: 50, size: 50 })
  })
})

// 上限此前是「先把整段区间的请求对象全部造出来，再截成 maxPages-1 条」。total 千万级时
// 那一步要临时分配几十 MB，而最终只留下几百条。上限必须在生成循环里生效。
describe("planRemainingPages allocation", () => {
  it("never builds more than the cap, however large the range", () => {
    const reqs = planRemainingPages(50, 50_000_000, 50, 1000)
    expect(reqs).toHaveLength(999)
    expect(reqs[0]).toEqual({ from: 50, size: 50 })
    expect(reqs[998]).toEqual({ from: 50 + 998 * 50, size: 50 })
  })

  it("allocates proportionally to the cap, not to the range", () => {
    // 峰值堆内存与「区间多大」无关。两个区间差 1000 倍，分配量必须同量级。
    const measure = (endFrom: number) => {
      global.gc?.()
      const before = process.memoryUsage().heapUsed
      const reqs = planRemainingPages(50, endFrom, 50, 1000)
      const after = process.memoryUsage().heapUsed
      return { grew: after - before, len: reqs.length }
    }
    const small = measure(100_000)
    const huge = measure(100_000_000)
    expect(small.len).toBe(999)
    expect(huge.len).toBe(999)
    // 旧写法在 1 亿这一档要先造 200 万个对象（数十 MB）；现在两档都只造 999 个。
    expect(huge.grew).toBeLessThan(8 * 1024 * 1024)
  })
})
