import { describe, expect, it } from "vitest"
import { isEnvelope, unwrapEnvelope } from "../../../src/core/envelope.js"
import { ApiError } from "../../../src/core/errors.js"

describe("isEnvelope", () => {
  it("recognizes a code + payload envelope", () => {
    expect(isEnvelope({ code: "0", data: { x: 1 } })).toBe(true)
    expect(isEnvelope({ code: 0, msg: "ok" })).toBe(true)
    expect(isEnvelope({ code: "x", success: true })).toBe(true)
  })

  it("rejects non-envelopes", () => {
    expect(isEnvelope(null)).toBe(false)
    expect(isEnvelope(42)).toBe(false)
    expect(isEnvelope({ foo: 1 })).toBe(false) // no code
    expect(isEnvelope({ code: 0 })).toBe(false) // code only, no payload markers
  })
})

describe("unwrapEnvelope", () => {
  it("passes through values that are not envelopes", () => {
    expect(unwrapEnvelope(42 as never)).toBe(42)
    expect(unwrapEnvelope({ foo: 1 } as never)).toEqual({ foo: 1 })
  })

  it("returns data for success codes 000000 and 0", () => {
    expect(unwrapEnvelope({ code: "000000", data: { x: 1 } })).toEqual({ x: 1 })
    expect(unwrapEnvelope({ code: "0", data: 5 })).toBe(5)
    expect(unwrapEnvelope({ code: 0, data: 3 })).toBe(3)
  })

  it("treats status:true / success:true as success regardless of code", () => {
    expect(unwrapEnvelope({ code: "x", status: true, data: 7 })).toBe(7)
    expect(unwrapEnvelope({ code: "x", success: true, data: 9 })).toBe(9)
  })

  it("returns the envelope itself when ok but no data field", () => {
    const env = { code: "0", msg: "ok" }
    expect(unwrapEnvelope(env)).toEqual(env)
  })

  it("throws ApiError with code and hint on failure", () => {
    try {
      unwrapEnvelope({ code: "999997", msg: "no perm" })
      throw new Error("should have thrown")
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError)
      expect((err as ApiError).code).toBe("999997")
      expect((err as ApiError).hint).toContain("权限")
    }
  })
})

// 服务端 2026-07-17 信封新增 traceId，且 Gangtise 也用 HTTP 200 信封返回错误。
describe("unwrapEnvelope 2026-07-17 envelope fields", () => {
  it("carries Retry-After into a 200-wrapped error envelope", () => {
    try {
      unwrapEnvelope({ code: "999006", msg: "rate limited" }, 200, 5_000)
      throw new Error("should have thrown")
    } catch (err) {
      expect((err as ApiError).retryAfterMs).toBe(5_000)
    }
  })

  it("puts the envelope traceId on the ApiError via details", () => {
    try {
      unwrapEnvelope({ code: "999999", msg: "boom", traceId: "830965044897325056" }, 500)
      throw new Error("should have thrown")
    } catch (err) {
      expect((err as ApiError).traceId).toBe("830965044897325056")
    }
  })

  it("stashes the traceId on a successful payload so the EDE inner envelope can still reach it", () => {
    const inner = { code: "130001", status: false, msg: "无数据" }
    const data = unwrapEnvelope({ code: "0", data: inner, traceId: "77" })
    // 非枚举：绝不进 JSON/工具输出。
    expect(JSON.stringify(data)).toBe(JSON.stringify(inner))
    expect(new ApiError("无数据", "130001", 500, data).traceId).toBe("77")
  })
})
