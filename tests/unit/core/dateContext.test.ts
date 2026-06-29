import { describe, expect, it } from "vitest"

import { today, year, dateTime } from "../../../src/core/dateContext.js"

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
