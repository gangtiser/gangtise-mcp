import { describe, expect, it } from "vitest"
import { toolHandler, textResult, errorResult } from "../../../src/tools/helpers.js"
import { ApiError } from "../../../src/core/errors.js"

describe("textResult", () => {
  it("wraps a string into a single text content block", () => {
    expect(textResult("hello")).toEqual({ content: [{ type: "text", text: "hello" }] })
  })
})

describe("errorResult", () => {
  it("marks isError and surfaces the message", () => {
    const r = errorResult(new Error("boom"))
    expect(r.isError).toBe(true)
    expect(r.content[0].text).toBe("boom")
  })

  it("appends the hint for known ApiError codes", () => {
    const r = errorResult(new ApiError("nope", "999997"))
    expect(r.isError).toBe(true)
    expect(r.content[0].text).toContain("权限")
  })
})

describe("toolHandler", () => {
  it("returns the handler result on success", async () => {
    const handler = toolHandler(async () => textResult("ok"))
    const r = await handler({})
    expect(r.isError).toBeFalsy()
    expect(r.content[0].text).toBe("ok")
  })

  it("catches a thrown error and returns an error result", async () => {
    const handler = toolHandler(async () => {
      throw new Error("handler failed")
    })
    const r = await handler({})
    expect(r.isError).toBe(true)
    expect(r.content[0].text).toBe("handler failed")
  })
})
