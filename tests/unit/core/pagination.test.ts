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
