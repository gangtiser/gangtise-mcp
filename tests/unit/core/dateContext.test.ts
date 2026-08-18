import { describe, expect, it } from "vitest"

import { today, year, dateTime, dateString, dateTimeString, quarterEndDate } from "../../../src/core/dateContext.js"

// These pin the Asia/Shanghai (UTC+8) conversion. If anyone drops the timezone
// (falling back to the host/UTC), "today" shifts by up to a day and silently
// breaks every relative-date query plus the theme-tracking 30-day guard.
describe("dateContext Asia/Shanghai", () => {
  it("rolls 'today' to the next day once past Shanghai midnight", () => {
    // 2026-06-29T16:30:00Z == 2026-06-30 00:30 in Shanghai
    expect(today(new Date("2026-06-29T16:30:00Z"))).toBe("2026-06-30")
  })

  it("keeps 'today' on the same day just before Shanghai midnight", () => {
    // 2026-06-29T15:30:00Z == 2026-06-29 23:30 in Shanghai
    expect(today(new Date("2026-06-29T15:30:00Z"))).toBe("2026-06-29")
  })

  it("derives the year from the Shanghai-local date across a New Year boundary", () => {
    // 2025-12-31T16:30:00Z == 2026-01-01 00:30 in Shanghai
    expect(year(new Date("2025-12-31T16:30:00Z"))).toBe("2026")
  })

  it("formats date-time in Shanghai with zero-padding and 24-hour clock", () => {
    expect(dateTime(new Date("2026-06-29T16:05:09Z"))).toBe("2026-06-30 00:05:09")
  })
})

// Shared zod schemas (X5 tightening): malformed dates must fail fast at the
// schema boundary instead of reaching the backend, which silently coerces
// (JS Date rolls 2026-02-30 → 2026-03-02) or errors opaquely.
describe("dateString schema", () => {
  it("rejects a non-zero-padded date", () => {
    expect(dateString.safeParse("2026-4-1").success).toBe(false)
  })

  it("rejects a calendar-impossible date that JS Date would roll over", () => {
    expect(dateString.safeParse("2026-02-30").success).toBe(false)
  })

  it("accepts a leap day", () => {
    expect(dateString.safeParse("2024-02-29").success).toBe(true)
  })

  // 年在前的三种写法对任何读者都是同一天，故都收，并归一成一种下发。
  it("accepts the other two year-first layouts and normalizes them", () => {
    expect(dateString.parse("2026/07/01")).toBe("2026-07-01")
    expect(dateString.parse("20260701")).toBe("2026-07-01")
    expect(dateString.parse("2026-07-01")).toBe("2026-07-01")
  })

  it("applies the calendar check to the normalized value, not just the shape", () => {
    expect(dateString.safeParse("2026/02/30").success).toBe(false)
    expect(dateString.safeParse("20260230").success).toBe(false)
  })

  // 🔴 反向断言，本组最重要的一条。服务端对年在后也解析、且按美式月在前读（平台约定，
  // 不是缺陷），但 01-07-2026 对美国人是 1 月 7 日、对欧洲人是 7 月 1 日——放过去等于让
  // 一半调用方静默拿到差半年的数据（HTTP 200、行数合理、无信号）。**放开年在前写法时
  // 不要顺手把年在后也放开**，那才是这条不对称存在的意义。
  it("still refuses year-last layouts, which read differently per convention", () => {
    for (const bad of ["07-01-2026", "07/01/2026", "01-07-2026", "01/07/2026"]) {
      expect(dateString.safeParse(bad).success, `should reject ${bad}`).toBe(false)
    }
  })

  it("refuses a mixed separator, which is a typo rather than a layout", () => {
    expect(dateString.safeParse("2026-07/01").success).toBe(false)
    expect(dateString.safeParse("2026/07-01").success).toBe(false)
  })
})

describe("dateTimeString schema", () => {
  it("accepts a well-formed date-time", () => {
    expect(dateTimeString.safeParse("2026-04-01 09:30:00").success).toBe(true)
  })

  it("rejects an out-of-range hour", () => {
    expect(dateTimeString.safeParse("2026-04-01 25:00:00").success).toBe(false)
  })

  it("rejects a non-zero-padded date part", () => {
    expect(dateTimeString.safeParse("2026-4-1 09:00:00").success).toBe(false)
  })

  // 只归一日期那一半：时间部分被接口原样回显，不要重排。
  it("normalizes only the date half of the other year-first layouts", () => {
    expect(dateTimeString.parse("2026/04/01 09:30:00")).toBe("2026-04-01 09:30:00")
    expect(dateTimeString.parse("20260401 09:30:00")).toBe("2026-04-01 09:30:00")
  })

  it("still refuses a year-last date part", () => {
    expect(dateTimeString.safeParse("01-04-2026 09:30:00").success).toBe(false)
    expect(dateTimeString.safeParse("01/04/2026 09:30:00").success).toBe(false)
  })

  it("rejects a calendar-impossible date part", () => {
    expect(dateTimeString.safeParse("2026-02-30 09:00:00").success).toBe(false)
  })

  it("rejects the ISO 'T' separator (upstream expects a space)", () => {
    expect(dateTimeString.safeParse("2026-04-01T09:00:00").success).toBe(false)
  })

  it("rejects a date without the time part", () => {
    expect(dateTimeString.safeParse("2026-04-01").success).toBe(false)
  })
})

describe("quarterEndDate schema", () => {
  const interimOrAnnual = quarterEndDate("06-30", "12-31")

  it("accepts an allowed quarter-end", () => {
    expect(interimOrAnnual.safeParse("2026-06-30").success).toBe(true)
  })

  it("rejects a non-quarter-end date", () => {
    expect(interimOrAnnual.safeParse("2026-05-15").success).toBe(false)
  })

  it("rejects a quarter-end outside the allowed set", () => {
    expect(interimOrAnnual.safeParse("2026-03-31").success).toBe(false)
  })
})
