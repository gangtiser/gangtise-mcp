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
    expect(msg).toContain("可查范围")
    // 旧文案「请缩小日期范围」被证伪：单个日期也会报此码（screener 传较早的 date），
    // 此时没有窗口可缩，照做会陷进一个永远返回同一个码的循环。
    expect(msg).not.toContain("请缩小日期范围")
    // 归因只到「接口」，不到「账号权限」——原始报文只有「超出时间范围限制」，
    // 除 theme-tracking 外没有端点证过权限归因。这条守卫自 v0.1.44 round-3 起有效，
    // v0.1.51 一度被放开又改回，别再放开。
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

// EDE 的入参错全部压在 100001 / 100003 两个码上，按码只能给通用建议。日期这一类的 msg
// 已经指名了问题，但没说在本服务里怎么改——补一层按 msg 匹配的提示，把改法直接给出来。
describe("message-keyed hints for EDE date params", () => {
  it("tells a reportDate indicator's caller to add it to indicatorParamList", () => {
    const hint = new ApiError("指标 is_op_rev 不支持参数 tradeDate; 指标 is_op_rev 缺少必填参数 reportDate", "100003").hint!
    expect(hint).toContain("reportDate")
    expect(hint).toContain("indicatorParamList")
    // 不能归纳成「哪些前缀吃哪个日期」——同一前缀下两种都有，只能指向 parameterList。
    expect(hint).toContain("parameterList")
    expect(hint).not.toContain("is_*")
  })

  // 声明了 reportDate 会让本服务不再注入 tradeDate；两个日期都必填的指标因此报缺
  // tradeDate。方向相反，提示也必须相反，否则会让调用方再补一次已经补过的 reportDate。
  it("tells a both-dates indicator's caller to add tradeDate as well", () => {
    const hint = new ApiError("指标 div_cash_yld 缺少必填参数 tradeDate", "100001").hint!
    expect(hint).toContain("两个日期都必填")
    expect(hint).toContain("tradeDate")
  })

  // 🔴 服务端把「拒收了哪个键」和「缺哪个键」拼在同一句里。给一个只吃 tradeDate 的指标
  // 传了 reportDate，收到的是「不支持参数 reportDate; 缺少必填参数 tradeDate」——只看后半
  // 句会建议「再补 tradeDate」，而正确的改法是**删掉 reportDate**（删掉后 date 会自动作为
  // tradeDate 注入，那半句自然消失）。两条规则的先后顺序就是为了守住这一点。
  it("tells a tradeDate-only indicator's caller to DROP reportDate, not add tradeDate", () => {
    const hint = new ApiError("指标 qte_close 不支持参数 reportDate; 指标 qte_close 缺少必填参数 tradeDate", "100003").hint!
    expect(hint).toContain("删掉")
    expect(hint).not.toContain("两个日期都必填")
  })

  // 反方向的同款拼接句必须仍然走第一条规则。
  it("keeps the reportDate advice for the mirrored combined message", () => {
    const hint = new ApiError("指标 is_op_rev 不支持参数 tradeDate; 指标 is_op_rev 缺少必填参数 reportDate", "100003").hint!
    expect(hint).toContain("要的是 reportDate")
    expect(hint).not.toContain("删掉")
  })

  // 🔴 半句（只说拒收、没说缺什么）**推不出**该换成哪个键：只吃 fiscalYear 的指标、以及
  // 一个日期都不吃的静态属性指标，收到的都是这半句。前一版把半句并进拼接句的规则里，于是
  // 「补 reportDate」与「删掉 reportDate」互相指反、构成死循环，而正确答案 fiscalYear 一次
  // 都没出现。这两条钉住半句只给不断言的指引，并点名那条确定可行的路。
  it("does not assert reportDate on a bare 不支持参数 tradeDate", () => {
    const hint = new ApiError("指标 div_cash_paid_ratio 不支持参数 tradeDate", "100003").hint!
    expect(hint).not.toContain("要的是 reportDate")
    expect(hint).toContain("fiscalYear")
    expect(hint).toContain("gangtise_indicator_time_series")
  })

  it("does not promise an auto-injected tradeDate on a bare 不支持参数 reportDate", () => {
    const hint = new ApiError("指标 div_cash_paid_ratio 不支持参数 reportDate", "100003").hint!
    expect(hint).toContain("删掉")
    // 半句里不能承诺「删掉后 date 会自动补上」——该指标可能连 tradeDate 都不吃。
    expect(hint).not.toContain("自动作为 tradeDate 下发")
    expect(hint).toContain("parameterList")
  })

  // 三步闭环的回归钉：把这三种形态的建议连起来读，不能绕回起点。
  it("breaks the add-reportDate / drop-reportDate loop", () => {
    const step1 = new ApiError("指标 div_cash_paid_ratio 不支持参数 tradeDate", "100003").hint!
    const step2 = new ApiError("指标 div_cash_paid_ratio 不支持参数 reportDate", "100003").hint!
    expect(step1).not.toContain("补一条 { indicatorCode")
    expect(step2).not.toContain("自动作为 tradeDate 下发")
  })

  it("falls back to the per-code hint for other messages on the same codes", () => {
    const hint = new ApiError("请求体结构错误或字段类型不匹配", "100003").hint!
    expect(hint).toContain("msg 已指明字段名")
  })

  it("does not fire on a different code carrying a similar message", () => {
    expect(new ApiError("指标 x 缺少必填参数 reportDate", "410106").hint).toContain("parameterList")
    expect(new ApiError("指标 x 缺少必填参数 reportDate", "410106").hint).not.toContain("indicatorParamList 里给该指标补")
  })

  it("still lets an explicit hintOverride win", () => {
    const err = new ApiError("指标 is_op_rev 不支持参数 tradeDate", "100003", undefined, undefined, undefined, "调用点更清楚")
    expect(err.hint).toBe("调用点更清楚")
  })
})

// 一次请求里多个指标各有各的毛病时，服务端在同一句 msg 里逐个点名，而提示只讲得了其中
// 一种形态。提示因此不能用「这个指标」这种单数口吻假装只有一个问题。
describe("multi-indicator date errors", () => {
  const MULTI = "指标 div_cash_paid_ratio 不支持参数 tradeDate; 指标 is_op_rev 不支持参数 tradeDate; 指标 is_op_rev 缺少必填参数 reportDate"

  it("points at the indicator the message names, not an unnamed 'this one'", () => {
    const hint = new ApiError(MULTI, "100003").hint!
    expect(hint).toContain("报错里点名的那个指标")
    expect(hint).not.toContain("这个指标")
  })

  it("warns that one message may name several indicators", () => {
    expect(new ApiError(MULTI, "100003").hint).toContain("同时点名多个指标")
  })

  it("carries that warning on every date rule, not just the first", () => {
    for (const msg of [
      "指标 X 缺少必填参数 reportDate",
      "指标 X 不支持参数 reportDate; 指标 X 缺少必填参数 tradeDate",
      "指标 X 不支持参数 reportDate",
      "指标 X 不支持参数 tradeDate",
      "指标 X 缺少必填参数 tradeDate",
    ]) {
      expect(new ApiError(msg, "100003").hint, msg).toContain("同时点名多个指标")
    }
  })
})

// 规则 4 覆盖的那批指标（静态属性 / 只要 fiscalYear）在截面和条件选股上都取不到数。
// 时序工具能取到值，但**不能筛**（没有 expression），所以只说「改用时序」对选股调用方
// 是把人指去一个做不到那件事的工具。可行路径是「时序 + 板块 ID 取到该列，再本地筛」。
describe("rule 4 gives the screener caller a route that can actually filter", () => {
  const hint = () => new ApiError("指标 scr_exchg_sctr 不支持参数 tradeDate", "100003").hint!

  it("names the time-series tool for plain lookups", () => {
    expect(hint()).toContain("gangtise_indicator_time_series")
  })

  it("tells a screener caller to fetch the column and filter locally", () => {
    expect(hint()).toContain("条件选股")
    expect(hint()).toContain("本地")
  })
})
