import { describe, it, expect } from "vitest"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { createGangtiseMcpServer } from "../../../src/server.js"
import { LOCAL, billingLabel, billingSuffix } from "../../../src/tools/billing.js"
import { ENDPOINTS } from "../../../src/core/endpoints.js"
import type { GangtiseClient } from "../../../src/core/client.js"

const stubClient = { call: async () => ({}), download: async () => ({}) } as unknown as GangtiseClient

/** 服务器声明的 instructions —— 走 initialize 结果，与客户端拿到的是同一份。 */
async function liveInstructions(): Promise<string> {
  const server = createGangtiseMcpServer(stubClient, { version: "0.0.0-test" })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  const client = new Client({ name: "test", version: "0.0.1" })
  await client.connect(clientTransport)
  return client.getInstructions() ?? ""
}

async function listLiveTools() {
  const server = createGangtiseMcpServer(stubClient, { version: "0.0.0-test" })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  const client = new Client({ name: "test", version: "0.0.1" })
  await client.connect(clientTransport)
  const { tools } = await client.listTools()
  return tools
}

/** 描述尾部的积分标签（免费工具没有标签，返回空串）。标签由端点 billing 生成、恒在最后。 */
const TRAILING_LABEL = /【(?:积分：[^】]+|本地工具，不消耗 OpenAPI 积分)】$/
const labelOf = (desc: string) => desc.match(TRAILING_LABEL)?.[0] ?? ""

const FROZEN_LABELS = new Set([
  "", "【积分：按下游资源类型】", "【积分：按所选指标】", "【积分：单价以平台计费为准】",
  "【本地工具，不消耗 OpenAPI 积分】",
])
const inFrozenVocabulary = (label: string) => FROZEN_LABELS.has(label) || /^【积分：[\d.]+\/(次|条|篇|张|指标)】$/.test(label)

const AMPLIFY_HINTS = [...new Set(Object.values(ENDPOINTS).flatMap((e) => (e.billing && "amplify" in e.billing && e.billing.amplify ? [e.billing.amplify] : [])))]

describe("billing labels", () => {
  it("labels every registered tool from the frozen vocabulary", async () => {
    const live = await listLiveTools()
    expect(live).toHaveLength(103)
    for (const tool of live) {
      const label = labelOf(tool.description ?? "")
      expect(inFrozenVocabulary(label), `${tool.name} 标签越界：${label}`).toBe(true)
    }
  })

  it("renders the documented label shapes from endpoint billing", () => {
    expect(billingLabel("quote.realtime")).toBe("")
    expect(billingLabel("ai.one-pager")).toBe("【积分：50/次】")
    expect(billingLabel("insight.independent-opinion.download")).toBe("【积分：30/条】")
    expect(billingLabel("insight.report-image.download")).toBe("【积分：0.1/张】")
    expect(billingLabel("alternative.edb-data")).toBe("【积分：30/指标】")
    expect(billingLabel("ai.hot-topic")).toBe("【积分：50/篇】")
    expect(billingLabel("ai.knowledge-resource.download")).toBe("【积分：按下游资源类型】")
    expect(billingLabel("reference.securities-search")).toBe("【积分：单价以平台计费为准】")
    expect(billingLabel("indicator.time-series")).toBe("【积分：按所选指标】")
    expect(billingLabel(LOCAL)).toBe("【本地工具，不消耗 OpenAPI 积分】")
  })

  // 按参数选端点的工具，标签取默认档的端点。
  it("labels switchable tools by their default endpoint", async () => {
    const byName = new Map((await listLiveTools()).map((t) => [t.name, t.description ?? ""]))
    expect(labelOf(byName.get("gangtise_opinion_list")!)).toBe("【积分：30/条】")
    expect(labelOf(byName.get("gangtise_foreign_opinion_list")!)).toBe("【积分：30/条】")
    expect(labelOf(byName.get("gangtise_concept_info")!)).toBe("【积分：500/次】")
    expect(labelOf(byName.get("gangtise_lookup")!)).toBe("【本地工具，不消耗 OpenAPI 积分】")
  })

  it("keeps the label vocabulary frozen for every endpoint: amplification never enters the label", () => {
    for (const key of Object.keys(ENDPOINTS)) {
      const label = billingLabel(key)
      expect(inFrozenVocabulary(label), `${key} 标签越界：${label}`).toBe(true)
    }
  })

  // 未确认 ≠ 免费：没写 billing 的端点按「单价以平台计费为准」展示，绝不显示成免费。
  it("renders a missing billing as unpriced, never as free", () => {
    expect(ENDPOINTS["auth.login"].billing).toBeUndefined()
    expect(billingLabel("auth.login")).toBe("【积分：单价以平台计费为准】")
  })

  it("throws on an unknown endpoint key instead of silently labelling it", () => {
    expect(() => billingLabel("not.an.endpoint")).toThrow(/unknown endpoint/)
  })

  // 独立常量钉住「哪几个」。live 门禁与实现共用 billingSuffix()，误删一条 amplify 时两边会一起变、
  // 门禁照样绿 —— 这两份字面名单打破那个同源循环。performance-calendar.download 是名单里唯一
  // 非放大倍数的条目：它借 amplify 承载「港美股 20/条」，因为标签词表没有「按标的市场分档」。
  it("pins the exact amplification roster so a deleted entry cannot slip past the live gate", async () => {
    const amplified = Object.values(ENDPOINTS)
      .filter((e) => e.billing && "amplify" in e.billing && e.billing.amplify)
      .map((e) => e.key)
      .sort()
    expect(amplified).toEqual([
      "ai.hot-topic",
      "indicator.cross-section",
      "indicator.screener",
      "indicator.time-series",
      "insight.foreign-opinion.list-with-content",
      "insight.forum.list",
      "insight.opinion.list-with-content",
      "insight.performance-calendar.download",
      "insight.roadshow.list",
      "insight.site-visit.list",
      "insight.strategy.list",
    ])
    const hinted = (await listLiveTools())
      .filter((t) => AMPLIFY_HINTS.some((hint) => (t.description ?? "").includes(`${hint}。${labelOf(t.description ?? "")}`)))
      .map((t) => t.name)
      .sort()
    expect(hinted).toEqual([
      "gangtise_foreign_opinion_list",
      "gangtise_forum_list",
      "gangtise_hot_topic",
      "gangtise_indicator_cross_section",
      "gangtise_indicator_screener",
      "gangtise_indicator_time_series",
      "gangtise_opinion_list",
      "gangtise_performance_calendar_download",
      "gangtise_roadshow_list",
      "gangtise_site_visit_list",
      "gangtise_strategy_list",
    ])
  })

  // 尾注现在只剩放大提示：通用的分页计费声明已上收到 server.instructions，
  // 逐工具不同的「单次约 N 积分」留在这里 —— 那一半搬不动，也正是估成本要用的。
  it("emits the amplification hint as a suffix outside the label, framed as an example not a cap", () => {
    expect(billingSuffix("ai.hot-topic")).toBe("单次约 1000 积分。")
    expect(billingSuffix("insight.opinion.list-with-content")).toBe("单次约 600 积分。")
    expect(billingSuffix("insight.foreign-opinion.list-with-content")).toBe("单次约 600 积分。")
    for (const n of ["roadshow", "site-visit", "strategy", "forum"]) {
      expect(billingSuffix(`insight.${n}.list`)).toBe("单次约 400 积分。")
    }
    const CELL = "按单元格计价，指标数×证券数×日期数即放大倍数，单次上限 3 万单元格（服务端硬限，超出报 100006 且不返回部分结果）。"
    expect(billingSuffix("indicator.time-series")).toBe(CELL)
    expect(billingSuffix("indicator.cross-section")).toBe(CELL)
    // size 无上限、且有 fetchAll —— 这些数字是「一次调用的成本示例」，不是上限
    for (const hint of AMPLIFY_HINTS) expect(hint).not.toContain("最多约")
  })

  it("keeps proven-bounded and per-call-priced endpoints free of amplification noise", () => {
    // edb-data 有已证上界 300（30/指标 × 最多 10 个），低于题材完整画像的 500/次
    expect(billingSuffix("alternative.edb-data")).toBe("")
    expect(billingSuffix("alternative.concept-info-full")).toBe("")
    // stock-summary 的放大警示留在 securityList 的参数描述里
    expect(billingSuffix("ai.stock-summary.list")).toBe("")
    expect(billingSuffix("insight.summary.download")).toBe("")
    // 免费 / 本地档永不带尾注
    expect(billingSuffix("vault.drive.list")).toBe("")
    expect(billingSuffix(LOCAL)).toBe("")
  })

  // 免费档不打标签（instructions 末行已声明「未标注即免费」），省下字节并让付费标签更醒目。
  it("keeps free tools label-free and pins the per-kind tool counts", async () => {
    const kinds = (await listLiveTools()).map((t) => {
      const label = labelOf(t.description ?? "")
      if (label === "") return "free"
      if (label.startsWith("【本地工具")) return "local"
      if (label === "【积分：按下游资源类型】") return "downstream"
      if (label === "【积分：按所选指标】") return "variable"
      if (label === "【积分：单价以平台计费为准】") return "unknown"
      return "fixed"
    })
    const count = (kind: string) => kinds.filter((k) => k === kind).length
    expect(count("free")).toBe(39)
    expect(count("fixed")).toBe(46)
    expect(count("downstream")).toBe(1)
    expect(count("variable")).toBe(3)
    // 11 = 7 个参考类 + 2 个续查 + 帕米尔两个：未确认 ≠ 免费。
    expect(count("unknown")).toBe(11)
    expect(count("local")).toBe(3)
  })
})

describe("listTools billing-label gate", () => {
  it("gives every labelled tool exactly one label, and free tools none", async () => {
    for (const tool of await listLiveTools()) {
      const desc = tool.description ?? ""
      const label = labelOf(desc)
      if (label === "") {
        expect(desc, `${tool.name}：免费工具不得带积分标签`).not.toContain("【积分")
        expect(desc, `${tool.name}：免费工具不得带本地工具标签`).not.toContain("【本地工具")
      } else {
        expect(desc.split(label).length - 1, `${tool.name}：标签出现了多次`).toBe(1)
      }
    }
  })

  it("leaves no hand-written billing prose outside the generated label and suffix", async () => {
    const BILLING_WORDS = /积分|免费|扣分|扣费/
    for (const tool of await listLiveTools()) {
      const desc = tool.description ?? ""
      const label = labelOf(desc)

      // 顺序不能反：`【积分：50/次】`与`【本地工具，不消耗 OpenAPI 积分】`本身就含「积分」，
      // 高放大尾注也含「积分」。直接扫全描述则每个带标签的工具都命中，门禁 100% 假红。
      // 必须按尾部**逐段剥离**生成内容，再扫剩余部分：先标签、后尾注。
      let rest = desc.slice(0, desc.length - label.length)
      const suffix = AMPLIFY_HINTS.map((hint) => `${hint}。`).find((s) => rest.endsWith(s))
      if (suffix) rest = rest.slice(0, -suffix.length)
      expect(BILLING_WORDS.test(rest), `${tool.name}：描述残留手写计费文案「${rest.match(BILLING_WORDS)?.[0]}」`).toBe(false)
    }
  })

  // 🔴 反向钉：分页计费警示曾逐字挂在 19 个工具描述上，已上收到 server.instructions。
  // 每个工具的 inputSchema 是独立 JSON 文档、客户端不跨工具解析 $ref —— 写在描述里付
  // 19 遍，写在 instructions 里付一遍。这条防的是「有人又把它抄回描述」。
  it("keeps the per-item billing warning in instructions, not in 19 tool descriptions", async () => {
    const leaked = (await listLiveTools())
      .filter((t) => /按全部实际返回条目计费|默认最多 20 条/.test(t.description ?? ""))
      .map((t) => t.name)
    expect(leaked, "分页计费警示回流到了工具描述里").toEqual([])

    const instructions = await liveInstructions()
    expect(instructions, "instructions 里没有按条计费的声明，等于这条警示整个丢了").toMatch(/按实际返回条目计费/)
  })

  it("only scans tool.description — param descriptions keep their amplification warnings", async () => {
    // ai.ts 的 securityList 参数描述含「按条计费」，是有效的放大警示，必须保留；
    // 门禁若扫 inputSchema 就会误杀它。这条把该边界钉死。
    const tools = await listLiveTools()
    const stockSummary = tools.find((t) => t.name === "gangtise_stock_summary")
    expect(JSON.stringify(stockSummary?.inputSchema)).toContain("按条计费")
  })
})

describe("tool description boundaries", () => {
  it("states routing boundaries on the four tools that need them", async () => {
    const byName = new Map((await listLiveTools()).map((t) => [t.name, t.description ?? ""]))
    // 钉稳定的路由结论「回退专用工具」，而非会随指标库扩充失效的覆盖度断言
    expect(byName.get("gangtise_indicator_search")).toContain("回退专用工具")
    // 观点没有下载工具（instructions 的路由行已声明），描述要指向拿正文的办法。
    expect(byName.get("gangtise_opinion_list")).toMatch(/正文见 withContent/)
    expect(byName.get("gangtise_foreign_opinion_list")).toMatch(/正文见 withContent/)
    expect(byName.get("gangtise_stock_summary")).toContain("单证券长文另用 one_pager")
  })

  it("declares the EDE batch-vs-dedicated routing on the indicator tools", async () => {
    const byName = new Map((await listLiveTools()).map((t) => [t.name, t.description ?? ""]))
    // search 侧：核对 scopeList、基础行情走专用、不匹配即回退
    const search = byName.get("gangtise_indicator_search") ?? ""
    expect(search).toContain("scopeList")
    expect(search).toContain("realtime/day_kline")
    expect(search).toContain("回退专用工具")
    // 「一批」而非「同一」：与 server 路由行去「同一」、cross-section 多指标×多证券保持一致
    expect(search).toContain("一批已实现财务/估值指标")
    // 截面：多证券批量首选，免去逐只调用
    expect(byName.get("gangtise_indicator_cross_section")).toContain("免去逐只调用")
    // 时序：既声明批量首选，也声明多×多需拆分（优先级与限制都覆盖）
    const ts = byName.get("gangtise_indicator_time_series") ?? ""
    expect(ts).toContain("首选")
    expect(ts).toContain("需拆分")
  })

  it("declares the EDE parameter-filling recipe (date routing / required params / resolved reportType)", async () => {
    const tools = await listLiveTools()
    const cs = tools.find((t) => t.name === "gangtise_indicator_cross_section")
    // 公司类型 + 占位值形态在描述里（占位一律是 null；「个别指标填 0」那一档已随服务端修复撤除，
    // 语义守卫在 indicator.test.ts 的「EDE placeholder is a single declaration」那组）。
    // 整批无数据不再返回 999999，所以旧的「报 999999 时改用 time_series」兜底已作废——
    // 描述不得再教它。
    expect(cs?.description ?? "").toContain("分公司类型")
    expect(cs?.description ?? "").not.toContain("999999")
    // 认不出的 code 现在会被接口指名拒绝，不再静默丢整行整列——描述必须说这一点，
    // 否则模型仍会按旧模型把报错当成「覆盖缺口」去排查。
    expect(cs?.description ?? "").toContain("拒绝并指名")
    // 日期路由 + 必填参数填法 + reportType 口径在 inputSchema（date / indicatorParamList 描述）
    const schema = JSON.stringify(cs?.inputSchema)
    expect(schema).toContain("报告期末季末")
    for (const p of ["periodNum", "fiscalYear", "sDate"]) expect(schema, `应含参数填法 ${p}`).toContain(p)
    // ⚠️ `startDate` 在 EDE 指标上根本不存在（2026-08-03 实测：区间指标只声明
    // sDate/changePeriod/tradeDate），写它会被服务端静默忽略。旧描述教模型传 startDate，
    // 这条断言防止它回归——只允许作为「没有 startDate」的否定说明出现。
    expect(schema).toContain("没有 startDate")
    expect(schema).not.toContain("→startDate")
    // reportType 悬案已关闭：enum label 与实际取数一致（CLI v0.30.0 用中信证券 FY2024
    // 营收四值逐一对上三大报表），同一响应里那段与 enum 相反的 paramDescription 也已
    // 撤掉。描述给映射并指向 enumList；「别读 paramDescription」那句随之收回——留着它
    // 会让调用方去防一个不存在的坑。
    expect(schema).toContain("1=合并")
    expect(schema).toContain("3=母公司")
    expect(schema).toContain("enumList")
    expect(schema).not.toMatch(/不要读[^"]{0,20}paramDescription/)
    expect(schema).not.toContain("尚未定论")
    expect(schema).not.toContain("reportType 勿传")
    // adjustType 仍要点名（它是复权的正确键名）。但「写成 adjustmentType 会被静默忽略并
    // 退回不复权」那套警示已经作废——参数名写错现在会被接口指名拒绝，所以描述改成教
    // 「照 msg 改 + 以 parameterList 为准」，不再列举某个错名。
    expect(schema).toContain("adjustType")
    expect(schema).not.toContain("adjustmentType")
    expect(schema).toContain("不支持参数")
    expect(schema).toContain("parameterList 为准")
  })

  // 总市值是 qte_ 族里唯一「专用工具没有」的：realtime/day_kline 实测都无市值字段，
  // 只有 EDE qte_mkt_cptl 有。若「行情优先专用工具」这条 carve-out 不点名它，
  // 模型查单票市值会被推去 realtime 然后空手而归（0.1.47 实际踩过）。
  it("routes 总市值 to EDE qte_mkt_cptl (realtime/day_kline don't carry it)", async () => {
    const byName = new Map((await listLiveTools()).map((t) => [t.name, t.description ?? ""]))
    const rt = byName.get("gangtise_realtime") ?? ""
    // realtime 是模型的落点，必须在这里就掉头。两条分开断言、不钉整句措辞：
    // 要守的是「说了没有 close」和「说了没有市值」这两件事，不是它们怎么连成一句。
    expect(rt).toMatch(/没有 close/)
    expect(rt).toMatch(/没有市值/)
    expect(rt).toContain("qte_mkt_cptl")
    // 字段清单要准（旧文案写「开高低收」会诱导模型传 close → 触发错列）
    expect(rt).toContain("latestPrice")
    expect(rt).toContain("preClose")
    // 0.38 起 realtime 不再返回这两个字段：传了会连字段名一起被丢掉，描述必须点名，
    // 否则模型照旧传、拿到少两列的结果而看不出原因。
    expect(rt).toContain("turnoverRate")
    expect(rt).toContain("volumeRatio")
    expect(rt).toContain("tradeStatus")
    // search 的行情 carve-out 必须点名这个例外，否则又把它推回 realtime
    expect(byName.get("gangtise_indicator_search")).toContain("qte_mkt_cptl")
  })

  it("says 获取 not 生成 on the pre-generated AI tools", async () => {
    // instructions ③ 声明「AI 除注明外均取预生成内容」；描述若还写「生成」，
    // 模型会看到 instructions 与描述互相打架。
    const byName = new Map((await listLiveTools()).map((t) => [t.name, t.description ?? ""]))
    for (const name of ["gangtise_one_pager", "gangtise_investment_logic", "gangtise_peer_comparison", "gangtise_research_outline"]) {
      expect(byName.get(name), `${name} 应写「获取」`).toMatch(/^获取/)
    }
  })

  it("does not leak the unproven opinion download path into any description", async () => {
    for (const tool of await listLiveTools()) {
      expect(tool.description ?? "", `${tool.name}`).not.toContain("knowledge_batch 拿 sourceId")
    }
  })
})

// 内资研报下载 10 积分/条。价签报虚高一倍会让模型无谓地回避这个工具。
describe("download prices", () => {
  it("prices insight.research.download at 10 credits per document", () => {
    expect(ENDPOINTS["insight.research.download"].billing).toEqual({ kind: "fixed", per: "document", price: 10 })
  })

  it("keeps the other announcement downloads at their prices", () => {
    expect(ENDPOINTS["insight.announcement-hk.download"].billing).toMatchObject({ price: 20 })
    expect(ENDPOINTS["insight.announcement-us.download"].billing).toMatchObject({ price: 20 })
    expect(ENDPOINTS["insight.announcement.download"].billing).toMatchObject({ price: 10 })
  })
})
