import { describe, expect, it } from "vitest"
import { toolHandler, textResult, errorResult } from "../../../src/tools/helpers.js"
import { ApiError } from "../../../src/core/errors.js"
import { currentSignal } from "../../../src/core/requestContext.js"

const c0 = new AbortController()

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

// 取消信号靠 toolHandler 进入调用链（分页扇出、分片、重试退避、异步轮询都从这里读）。
describe("toolHandler carries the request cancel signal", () => {
  it("exposes extra.signal to the handler via the request context", async () => {
    const c = new AbortController()
    let seen: AbortSignal | undefined
    const handler = toolHandler(async () => {
      seen = currentSignal()
      return textResult("ok")
    })
    await handler({}, { signal: c.signal })
    expect(seen).toBe(c.signal)
  })

  it("leaves the context empty when the client sends no signal", async () => {
    let seen: AbortSignal | undefined = c0.signal
    const handler = toolHandler(async () => {
      seen = currentSignal()
      return textResult("ok")
    })
    await handler({})
    expect(seen).toBeUndefined()
  })

  it("reports a cancelled call as cancelled, not as the raw abort error", async () => {
    const c = new AbortController()
    const handler = toolHandler(async () => {
      c.abort(new Error("AbortError"))
      throw new Error("AbortError")
    })
    const r = await handler({}, { signal: c.signal })
    expect(r.isError).toBe(true)
    expect(r.content[0].text).toContain("已被客户端取消")
  })

  it("does not swallow a genuine error as a cancellation", async () => {
    const c = new AbortController()
    const handler = toolHandler(async () => {
      throw new Error("real failure")
    })
    const r = await handler({}, { signal: c.signal })
    expect(r.content[0].text).toBe("real failure")
  })
})
