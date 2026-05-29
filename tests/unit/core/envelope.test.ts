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
