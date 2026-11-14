import { describe, expect, it } from "vitest"

import type { EndpointDefinition } from "../../../src/core/endpoints.js"
import { ApiError } from "../../../src/core/errors.js"
import { emptyResultFor } from "../../../src/core/shape.js"

const base: EndpointDefinition = { key: "test.x", method: "POST", path: "/x", kind: "json", description: "t" }

describe("emptyResultFor", () => {
  const withCodes = { ...base, emptyCodes: ["130001"] }
  it("turns a declared empty code into a legal empty list", () => {
    expect(emptyResultFor(withCodes, new ApiError("未找到数据", "130001", 404))).toEqual({ total: 0, list: [] })
  })
  it("ignores other codes, errors without a code, and endpoints that declare none", () => {
    expect(emptyResultFor(withCodes, new ApiError("参数错误", "100003", 400))).toBeUndefined()
    expect(emptyResultFor(withCodes, new Error("network"))).toBeUndefined()
    expect(emptyResultFor(base, new ApiError("未找到数据", "130001", 404))).toBeUndefined()
  })
})
