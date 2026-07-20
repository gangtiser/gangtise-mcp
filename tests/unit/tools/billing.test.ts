import { describe, it, expect } from "vitest"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { createGangtiseMcpServer } from "../../../src/server.js"
import { BILLING_CATALOG, billingLabel, billingSuffix } from "../../../src/tools/billing.js"
import type { GangtiseClient } from "../../../src/core/client.js"

const stubClient = { call: async () => ({}), download: async () => ({}) } as unknown as GangtiseClient

async function listLiveTools() {
  const server = createGangtiseMcpServer(stubClient, { version: "0.0.0-test" })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  const client = new Client({ name: "test", version: "0.0.1" })
  await client.connect(clientTransport)
  const { tools } = await client.listTools()
  return tools
}

describe("billing catalog coverage", () => {
  // 防漂移：新增工具忘了归档、或删档没删工具，都在这里红。
  it("classifies exactly the registered tool set", async () => {
    const live = (await listLiveTools()).map((t) => t.name).sort()
    expect(Object.keys(BILLING_CATALOG).sort()).toEqual(live)
    expect(live).toHaveLength(92)
  })

  it("renders the documented label shapes", () => {
    expect(billingLabel("gangtise_realtime")).toBe("")
    expect(billingLabel("gangtise_one_pager")).toBe("【积分：50/次】")
    expect(billingLabel("gangtise_independent_opinion_download")).toBe("【积分：30/条】")
    expect(billingLabel("gangtise_report_image_download")).toBe("【积分：0.1/张】")
    expect(billingLabel("gangtise_edb_data")).toBe("【积分：30/指标】")
    expect(billingLabel("gangtise_knowledge_resource_download")).toBe("【积分：按下游资源类型】")
    expect(billingLabel("gangtise_securities_search")).toBe("【积分：计分表未覆盖】")
    expect(billingLabel("gangtise_lookup")).toBe("【本地工具，不消耗 OpenAPI 积分】")
  })

  // 标签词表是规格 §三D 冻结的 8 种取值 —— 高放大提示绝不能混进来
  it("keeps the label vocabulary frozen: amplification never enters the label", () => {
    const FROZEN = new Set([
      "", "【积分：按下游资源类型】", "【积分：按所选指标】", "【积分：计分表未覆盖】",
      "【本地工具，不消耗 OpenAPI 积分】",
    ])
    for (const name of Object.keys(BILLING_CATALOG)) {
      const label = billingLabel(name)
      const ok = FROZEN.has(label) || /^【积分：[\d.]+\/(次|条|篇|张|指标)】$/.test(label)
      expect(ok, `${name} 标签越界：${label}`).toBe(true)
    }
    expect(billingLabel("gangtise_opinion_list")).toBe("【积分：30/条】")
    expect(billingLabel("gangtise_indicator_time_series")).toBe("【积分：按所选指标】")
  })

  // 独立常量钉住「哪 9 个」。live 门禁与实现共用 billingSuffix()，
  // 误删一条 amplify 时两边会一起变、门禁照样绿 —— 这条字面名单打破那个同源循环。
  it("pins the exact amplification roster so a deleted entry cannot slip past the live gate", () => {
    const amplified = Object.entries(BILLING_CATALOG)
      .filter(([, spec]) => "amplify" in spec && spec.amplify)
      .map(([name]) => name)
      .sort()
    expect(amplified).toEqual([
      "gangtise_foreign_opinion_list",
      "gangtise_forum_list",
      "gangtise_hot_topic",
      "gangtise_indicator_cross_section",
      "gangtise_indicator_time_series",
      "gangtise_opinion_list",
      "gangtise_roadshow_list",
      "gangtise_site_visit_list",
      "gangtise_strategy_list",
    ])
  })

  it("emits the amplification hint as a suffix outside the label, framed as an example not a cap", () => {
    const PAGED = "默认最多 20 条；fetchAll=true 按全部实际返回条目计费"
    expect(billingSuffix("gangtise_hot_topic", true)).toBe(`${PAGED}，单次约 1000 积分。`)
    expect(billingSuffix("gangtise_opinion_list", true)).toBe(`${PAGED}，单次约 600 积分。`)
    expect(billingSuffix("gangtise_foreign_opinion_list", true)).toBe(`${PAGED}，单次约 600 积分。`)
    for (const n of ["roadshow", "site_visit", "strategy", "forum"]) {
      expect(billingSuffix(`gangtise_${n}_list`, true)).toBe(`${PAGED}，单次约 400 积分。`)
    }
    // EDE 两工具不分页，尾注只有放大提示
    const CELL = "按单元格计价，指标数×证券数×日期数即放大倍数。"
    expect(billingSuffix("gangtise_indicator_time_series", false)).toBe(CELL)
    expect(billingSuffix("gangtise_indicator_cross_section", false)).toBe(CELL)
    // size 无 .max()、且有 fetchAll —— 这些数字是「一次调用的成本示例」，不是上限
    for (const n of ["gangtise_hot_topic", "gangtise_opinion_list", "gangtise_roadshow_list"]) {
      expect(billingSuffix(n, true)).not.toContain("最多约")
    }
  })

  it("keeps proven-bounded and per-call-priced tools free of amplification noise", () => {
    // edb_data 有已证上界 300（30/指标 × max(10)），低于 concept_info 的 500/次
    expect(billingSuffix("gangtise_edb_data", false)).toBe("")
    expect(billingSuffix("gangtise_concept_info", false)).toBe("")
    // stock_summary 全市场展开上限未证 —— 放大警示留在 securityList 的参数描述里
    expect(billingSuffix("gangtise_stock_summary", false)).toBe("")
    expect(billingSuffix("gangtise_summary_download", false)).toBe("")
    // 免费/本地档永不带尾注
    expect(billingSuffix("gangtise_drive_list", true)).toBe("")
    expect(billingSuffix("gangtise_lookup", false)).toBe("")
  })

  it("throws on an unclassified tool instead of silently labelling it free", () => {
    expect(() => billingLabel("gangtise_not_a_tool")).toThrow(/billing catalog/)
  })

  // 免费档 34 个不打标签（instructions 末行已声明「未标注即免费」），
  // 省 714 B 并让付费标签更醒目；目录仍 100% 覆盖 92 个（覆盖 ≠ 输出）。
  it("keeps 34 free tools label-free while all 92 stay classified", () => {
    const entries = Object.values(BILLING_CATALOG)
    expect(entries.filter((s) => s.kind === "free")).toHaveLength(34)
    expect(entries.filter((s) => s.kind === "fixed")).toHaveLength(43)
    expect(entries.filter((s) => s.kind === "downstream")).toHaveLength(1)
    expect(entries.filter((s) => s.kind === "variable")).toHaveLength(2)
    expect(entries.filter((s) => s.kind === "unconfirmed")).toHaveLength(9)
    expect(entries.filter((s) => s.kind === "local")).toHaveLength(3)
  })
})

describe("listTools billing-label gate", () => {
  // 目录覆盖测试证明不了每个 live tool 真带对标签，这条才能。
  it("gives every non-free tool exactly one generated label, and free tools none", async () => {
    for (const tool of await listLiveTools()) {
      const label = billingLabel(tool.name)
      const desc = tool.description ?? ""
      if (label === "") {
        expect(desc, `${tool.name}：免费工具不得带积分标签`).not.toContain("【积分")
        expect(desc, `${tool.name}：免费工具不得带本地工具标签`).not.toContain("【本地工具")
      } else {
        expect(desc.endsWith(label), `${tool.name}：描述应以 ${label} 结尾，实际尾部 "${desc.slice(-24)}"`).toBe(true)
        expect(desc.split(label).length - 1, `${tool.name}：标签出现了多次`).toBe(1)
      }
    }
  })

  it("leaves no hand-written billing prose outside the generated label and suffix", async () => {
    const BILLING_WORDS = /积分|免费|扣分|扣费/
    for (const tool of await listLiveTools()) {
      const props = (tool.inputSchema as { properties?: Record<string, unknown> })?.properties ?? {}
      const paginated = Boolean(props.from && props.size && props.fetchAll)
      const label = billingLabel(tool.name)
      const suffix = billingSuffix(tool.name, paginated)
      const desc = tool.description ?? ""

      // 顺序不能反：`【积分：50/次】`与`【本地工具，不消耗 OpenAPI 积分】`本身就含「积分」，
      // 高放大尾注也含「积分」。直接扫全描述则每个带标签的工具都命中，门禁 100% 假红。
      // 必须按尾部**逐段剥离**已验证过的生成内容，再扫剩余部分：先标签、后尾注。
      let rest = label === "" ? desc : desc.slice(0, -label.length)
      if (suffix !== "") {
        expect(rest.endsWith(suffix), `${tool.name}：生成尾注不在标签之前`).toBe(true)
        rest = rest.slice(0, -suffix.length)
      }
      expect(BILLING_WORDS.test(rest), `${tool.name}：描述残留手写计费文案「${rest.match(BILLING_WORDS)?.[0]}」`).toBe(false)
    }
  })

  // 数量用独立常量钉住 —— 与 Task 1 的字面名单配合，堵住「门禁与实现同源」的循环。
  it("puts the fetchAll billing warning on exactly the 18 paid paginated tools", async () => {
    const warned = (await listLiveTools())
      .filter((t) => (t.description ?? "").includes("fetchAll=true 按全部实际返回条目计费"))
      .map((t) => t.name)
    expect(warned).toHaveLength(18) // 21 个分页工具 − 3 个免费
    for (const free of ["gangtise_drive_list", "gangtise_record_list", "gangtise_wechat_message_list"]) {
      expect(warned, `${free} 是免费分页工具，不该带计费警示`).not.toContain(free)
    }
  })

  it("surfaces all 9 amplification hints in the live listing", async () => {
    const hinted = (await listLiveTools()).filter((t) => {
      const spec = BILLING_CATALOG[t.name]
      return "amplify" in spec && spec.amplify && (t.description ?? "").includes(spec.amplify)
    })
    expect(hinted).toHaveLength(9)
  })

  it("only scans tool.description — param descriptions keep their amplification warnings", async () => {
    // ai.ts 的 securityList 参数描述含「避免误触发全市场扣费」，是有效的放大警示，
    // 必须保留；门禁若扫 inputSchema 就会误杀它。这条把该边界钉死。
    const tools = await listLiveTools()
    const stockSummary = tools.find((t) => t.name === "gangtise_stock_summary")
    expect(JSON.stringify(stockSummary?.inputSchema)).toContain("避免误触发全市场扣费")
  })
})

describe("tool description boundaries", () => {
  it("states routing boundaries on the four tools that need them", async () => {
    const byName = new Map((await listLiveTools()).map((t) => [t.name, t.description ?? ""]))
    expect(byName.get("gangtise_indicator_search")).toContain("仅用于其未覆盖的长尾证券级指标")
    expect(byName.get("gangtise_opinion_list")).toContain("无专用下载工具")
    expect(byName.get("gangtise_foreign_opinion_list")).toContain("无专用下载工具")
    expect(byName.get("gangtise_stock_summary")).toContain("单证券长文另用 one_pager")
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
