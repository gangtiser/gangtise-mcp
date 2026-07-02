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
