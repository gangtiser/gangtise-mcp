import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"

import { clearCalendarTypeCacheForTests } from "../../src/core/calendarType.js"
import { startHarness, type Harness } from "../helpers/harness.js"
import type { RecordedRequest } from "../helpers/mockUpstream.js"
import { EXAMPLES } from "./examples.js"
import type { ExpectedRequest } from "./types.js"

/** 请求黄金用例：每个工具的每条 example 走**真正的 MCP 校验路径**（strict schema、handler、
 *  真实 client、真 HTTP），断言发到服务端的请求序列。
 *
 *  断言的是请求的**内容**（方法、路径、query、body 深相等），不是字节：body 的键序对服务端
 *  没有意义，钉住它只会让无害的重排变红。序列按规范化字符串排序后比较——分页扇出、分片、
 *  逐只拆分都是并发的，到达顺序不确定。 */

let harness: Harness

beforeAll(async () => {
  harness = await startHarness({ asyncTimeoutMs: 5_000 })
})

afterAll(async () => {
  await harness.close()
})

beforeEach(() => {
  harness.upstream.reset()
  // time_series 的日历探针有进程级缓存，不清的话同一个 code 第二次调用会少一个请求。
  clearCalendarTypeCacheForTests()
})

const canonical = (r: ExpectedRequest) =>
  `${r.method} ${r.path} ${JSON.stringify(r.query ?? null)} ${JSON.stringify(r.body ?? null)}`

function normalize(requests: RecordedRequest[] | ExpectedRequest[]): ExpectedRequest[] {
  return requests
    .map((r) => {
      const out: ExpectedRequest = { method: r.method as ExpectedRequest["method"], path: r.path }
      if (r.query !== undefined) out.query = r.query
      if (r.body !== undefined) out.body = r.body
      return out
    })
    .sort((a, b) => canonical(a).localeCompare(canonical(b)))
}

describe("contract examples cover every tool", () => {
  it("每个已注册工具至少一条 example，且没有指向不存在工具的 example", async () => {
    const names = (await harness.mcp.listTools()).tools.map((tool) => tool.name).sort()
    const covered = Object.keys(EXAMPLES).sort()
    expect(names.filter((name) => !EXAMPLES[name]?.length)).toEqual([])
    expect(covered.filter((name) => !names.includes(name))).toEqual([])
  })
})

for (const [tool, examples] of Object.entries(EXAMPLES)) {
  describe(tool, () => {
    for (const example of examples) {
      it(example.title, async () => {
        harness.upstream.setResponder(example.upstream)
        const outcome = await harness.call(tool, example.args)
        const actual = normalize(outcome.requests)
        if (example.expect.rejects !== undefined) {
          expect(outcome.isError, outcome.text).toBe(true)
          expect(outcome.text).toMatch(example.expect.rejects)
          expect(actual).toEqual(normalize(example.expect.requests ?? []))
        } else {
          expect(outcome.isError, outcome.text).toBe(false)
          expect(actual).toEqual(normalize(example.expect.requests))
        }
      })
    }
  })
}
