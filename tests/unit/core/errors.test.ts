import { describe, it, expect } from "vitest"
import { ApiError, errorMessage } from "../../../src/core/errors.js"

describe("errorMessage", () => {
  it("returns the bare message when the API code has no hint", () => {
    expect(errorMessage(new ApiError("boom", "000000"))).toBe("boom")
  })

  it("appends a routing hint for the generic 410001 parameter error", () => {
    const message = errorMessage(new ApiError("参数错误", "410001"))
    expect(message).toContain("参数错误")
    expect(message).toContain("gangtise_sector_search")
  })

  it("unwraps non-ApiError values", () => {
    expect(errorMessage(new Error("plain"))).toBe("plain")
    expect(errorMessage("raw")).toBe("raw")
  })
})
