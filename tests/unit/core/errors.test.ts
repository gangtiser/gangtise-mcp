import { describe, it, expect } from "vitest"
import { ApiError, errorMessage } from "../../../src/core/errors.js"

describe("errorMessage", () => {
  it("appends the error code when the API code has no hint", () => {
    expect(errorMessage(new ApiError("boom", "424242"))).toBe("boom（错误码 424242）")
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

describe("error hints", () => {
  it("guides 100003 (invalid param value) to check enum spellings — the server does not name the parameter", () => {
    // Server message is English/neutral; the Chinese guidance must come from the hint.
    const message = errorMessage(new ApiError("param invalid", "100003"))
    expect(message).toContain("枚举")
    expect(message).toContain("拼写")
  })

  it("maps 110003 to a window-is-account-scoped hint without dropping the code", () => {
    const err = new ApiError("超出时间范围限制", "110003", 400)
    const msg = errorMessage(err)
    expect(msg).toContain("110003")
    expect(msg).toContain("取数窗口随账号权限变化")
  })
})
