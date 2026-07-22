import { describe, it, expect } from "vitest"
import { ApiError, attachEnvelopeTraceId, errorMessage } from "../../../src/core/errors.js"
import { isRetryableError } from "../../../src/core/transport.js"

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

  it("maps 110003 to an actionable hint without dropping the code", () => {
    const err = new ApiError("超出时间范围限制", "110003", 400)
    const msg = errorMessage(err)
    expect(msg).toContain("110003")
    expect(msg).toContain("请缩小日期范围或改用更近日期")
    // 只保留普适且可操作的建议——不对未证的端点断言账号权限归因（仅 theme-tracking 已证会发此码）。
    expect(msg).not.toContain("账号权限")
  })
})

// 服务端 2026-07-17 把 41 个公开错误码重排为三层（999xxx 服务统一 / 1xxxxx 业务通用 /
// 2xxxxx 接口专有）。上游实测（sibling CLI, 2026-07-20）迁移是按「错误处理层」而非按
// 接口进行的：同一接口内参数校验层已发新码、方法路由层与 token 过滤器仍发旧码。
// 两代都必须有提示，少哪一代都会让线上的活码变成无提示。
describe("2026-07-17 三层错误码", () => {
  const hintOf = (code: string) => new ApiError("server msg", code).hint

  // 2026-07-17 公开的 41 个码全量枚举（17 服务统一 + 17 业务通用 + 7 接口专有），
  // 不抽样 —— README 承诺「覆盖 41 个新码」，漏一个就该红。
  const PUBLIC_CODES_2026_07_17 = [
    // 服务统一层 999xxx（17）
    "999001", "999002", "999003", "999004", "999005", "999006", "999007", "999008",
    "999009", "999010", "999011", "999012", "999013", "999014", "999015", "999016",
    "999999",
    // 业务通用层 1xxxxx（17）
    "100001", "100002", "100003", "100004", "100005", "100006",
    "110001", "110002", "110003", "120001",
    "130001", "130002", "130003", "130004", "130005",
    "140001", "140002",
    // 接口专有层 2xxxxx（7）
    "210001", "220001", "230001", "240001", "240002", "240003", "250001",
  ]

  it("enumerates all 41 public codes", () => {
    expect(PUBLIC_CODES_2026_07_17).toHaveLength(41)
    expect(new Set(PUBLIC_CODES_2026_07_17).size).toBe(41)
  })

  it.each(PUBLIC_CODES_2026_07_17)("covers new-generation code %s", (code) => {
    expect(hintOf(code)).toBeTruthy()
  })

  it.each([
    "0000001007", "0000001008", "900001", "900002", "903301",
    "410001", "410004", "410106", "410110", "410111", "8000014", "8000015",
  ])("keeps legacy code %s hinted (still live per 2026-07-20 probes)", (code) => {
    expect(hintOf(code)).toBeTruthy()
  })

  // 900002 的旧文档写作「请求缺少 uid」，实测服务端用它表示「请求方法不正确」(HTTP 405)。
  // 按旧释义排查会去翻本来就没有的 uid 参数。
  it("does not describe 900002 as a missing uid", () => {
    expect(hintOf("900002")).not.toContain("uid")
  })

  // 提示拼在服务端 msg 之后，复述诊断会读成叠字（「资源不存在 资源不存在，确认 ID 有效」）。
  it("gives 130002 the next action, not a restatement of the diagnosis", () => {
    const hint = hintOf("130002")!
    expect(hint).not.toContain("资源不存在")
    expect(hint).toContain("fileType")
  })

  // 410106 是 EDE 取数最常见的两个报错之一（漏传 periodNum 等 required 参数）。
  it("routes 410106 to the parameterList of indicator_search", () => {
    expect(hintOf("410106")).toContain("gangtise_indicator_search")
  })

  // 410004 在 EDE 上最常见的真因是未开通指标权限，只说「数据未找到」会让人一直换日期。
  it("names the indicator-permission cause on 410004", () => {
    expect(hintOf("410004")).toContain("未开通")
  })

  // 终态失败重新提交会再次计费 50 积分，提示必须说清这一点。
  it.each(["410111", "140002"])("warns that resubmitting %s re-bills", (code) => {
    expect(hintOf(code)).toContain("计费")
  })
})

// traceId 是 Gangtise 侧唯一能回溯一次失败的抓手。
describe("ApiError.traceId", () => {
  it("reads the traceId off the response envelope kept in details", () => {
    const err = new ApiError("boom", "999999", 500, { code: "999999", traceId: "830965044897325056" })
    expect(err.traceId).toBe("830965044897325056")
    expect(errorMessage(err)).toContain("trace 830965044897325056")
  })

  it("coerces a numeric traceId", () => {
    expect(new ApiError("boom", "999999", 500, { traceId: 12345 }).traceId).toBe("12345")
  })

  it("falls back to the outer envelope id for EDE inner-envelope failures", () => {
    // The EDE inner envelope carries no traceId of its own — unwrapEnvelope parks
    // the outer one on the payload, which is what the inner failure passes as details.
    const inner = attachEnvelopeTraceId({ code: "130001", status: false, msg: "无数据" }, "77")
    expect(new ApiError("无数据", "130001", 500, inner).traceId).toBe("77")
  })

  it("stays undefined when the server sent none, leaving the message unchanged", () => {
    const err = new ApiError("boom", "424242")
    expect(err.traceId).toBeUndefined()
    expect(errorMessage(err)).toBe("boom（错误码 424242）")
  })

  it("keeps the stashed id off enumerable output (never leaks into tool payloads)", () => {
    const payload = attachEnvelopeTraceId({ a: 1 }, "99")
    expect(JSON.stringify(payload)).toBe('{"a":1}')
    expect(Object.keys(payload)).toEqual(["a"])
  })
})

// hintOverride 让调用方在保留 code/status/details（以及 traceId）的前提下改写提示。
describe("ApiError hintOverride", () => {
  it("beats the per-code table without dropping the code", () => {
    const err = new ApiError("system error", "999999", 500, { traceId: "1" }, undefined, "指标查询无数据：请检查查询条件")
    expect(err.hint).toBe("指标查询无数据：请检查查询条件")
    expect(err.code).toBe("999999")
    expect(err.traceId).toBe("1")
  })
})

// knowledge_batch 现在收 10 位秒 / 13 位毫秒两种 epoch，提示不能只说毫秒。
describe("110001 hint tracks the accepted epoch widths", () => {
  it("names both the seconds and milliseconds forms", () => {
    const hint = new ApiError("date invalid", "110001").hint!
    expect(hint).toContain("10 位")
    expect(hint).toContain("13 位")
  })
})

// 999006 的提示描述的是 transport 的实际重试策略。两者曾经反向漂移过一次
// （提示写「200 信封不重试」，而 transport 已改成会重试），这里把两边钉在一起。
describe("999006 hint matches the actual retry policy", () => {
  const err = (status: number) => new ApiError("rate limited", "999006", status)

  it("普通端点：任何状态都退避重试，提示如此声明", () => {
    expect(isRetryableError(err(200), "default")).toBe(true)
    expect(isRetryableError(err(429), "default")).toBe(true)
    expect(new ApiError("rate limited", "999006").hint).toContain("普通端点会自动退避重试")
  })

  it("按次计费端点：仅 429 重试，非 429 不重放，提示如此声明", () => {
    expect(isRetryableError(err(429), "no-replay")).toBe(true)
    expect(isRetryableError(err(200), "no-replay")).toBe(false)
    expect(isRetryableError(err(500), "no-replay")).toBe(false)
    const hint = new ApiError("rate limited", "999006").hint!
    expect(hint).toContain("按次计费端点仅在 HTTP 429 时重试")
    expect(hint).toContain("非 429 错误信封不重放")
  })

  it("提示不得再出现「不重试」式的反向断言", () => {
    expect(new ApiError("rate limited", "999006").hint).not.toContain("形态不重试")
  })
})
