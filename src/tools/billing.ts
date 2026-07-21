/**
 * 积分目录 —— 单一事实源，与 retry 策略、MCP annotations 完全解耦：
 * 计费高不等于不可重试（重试按接口幂等性单独决定，见 core/endpoints.ts），
 * 只读也不等于免费（付费同步工具仍是 readOnlyHint: true）。
 *
 * 主源：OpenAPI 计分表（2026-07-16）。两处例外已就地标注来源。
 * 计分表给的是「标准产品数据窗口」，实际取数范围随账号权限变化 ——
 * 本目录只记单价，不记窗口，也不据此做任何本地拦截。
 */

export type BillingUnit = "call" | "item" | "article" | "image" | "indicator"

export type BillingSpec =
  | { kind: "local" }                                              // 本地工具，不打 OpenAPI
  | { kind: "free" }                                               // 0 积分
  | { kind: "fixed"; credits: number; unit: BillingUnit; amplify?: string }
  | { kind: "downstream"; note: string }                           // 按下游资源标准
  | { kind: "variable"; note: string; amplify?: string }           // 详见文档 / 按指标
  | { kind: "unconfirmed"; note: string }                          // 计分表未覆盖，不得写免费

const UNIT_LABEL: Record<BillingUnit, string> = {
  call: "次",
  item: "条",
  article: "篇",
  image: "张",
  indicator: "指标",
}

const FREE: BillingSpec = { kind: "free" }
const LOCAL: BillingSpec = { kind: "local" }

/**
 * `amplify` 是高放大提示。它**不进标签** —— 标签词表是规格冻结的 8 种取值之一，
 * 提示由 billingSuffix() 生成、排在标签**之前**（规格 §三D 要求「标签外」）。
 * 分页 list 类的数字是「按默认 size=20 调用**一次**的成本示例」，**不是上限**：
 * size 只有 .min(1)、无 .max()，且有 fetchAll 可拉全量 —— 故写「单次约 N 积分」，
 * 绝不能写「最多 N」。
 */
function fixed(credits: number, unit: BillingUnit, amplify?: string): BillingSpec {
  return { kind: "fixed", credits, unit, ...(amplify ? { amplify } : {}) }
}

// 计分表未列的参考类工具。不得擅自标 free —— 未确认 ≠ 免费。
const UNCONFIRMED_REFERENCE: BillingSpec = { kind: "unconfirmed", note: "计分表未列此参考类接口，单价未确认" }
// 异步 *_check 续查是否另计费未证（规格 7.4-1）。确认免费后直接改 FREE，
// 不要新增 "included" kind ——「含在 submit 费里」与「本来免费」对模型行为完全等价。
const UNCONFIRMED_CHECK: BillingSpec = { kind: "unconfirmed", note: "续查是否另计费未确认" }

export const BILLING_CATALOG: Record<string, BillingSpec> = {
  // ───────── local（3）：永不打 OpenAPI ─────────
  // lookup 走 getLookupData() 读 core/lookupData/，计分表没列它是因为它压根不是
  // OpenAPI 接口，不属于「未覆盖」—— 所以是 local，不是 unconfirmed。
  gangtise_current_date: LOCAL,
  gangtise_read_response: LOCAL,
  gangtise_lookup: LOCAL,

  // ───────── free（34）：0 积分 ─────────
  // 行情（标准窗口 -3Y）
  gangtise_realtime: FREE,
  gangtise_day_kline: FREE,
  gangtise_day_kline_hk: FREE,
  gangtise_day_kline_us: FREE,
  gangtise_minute_kline: FREE,
  gangtise_index_day_kline: FREE,
  gangtise_fund_flow: FREE,
  // 基本面（标准窗口 -3Y）
  gangtise_income_statement: FREE,
  gangtise_income_statement_quarterly: FREE,
  gangtise_income_statement_hk: FREE,
  gangtise_income_statement_us: FREE,
  gangtise_balance_sheet: FREE,
  gangtise_balance_sheet_hk: FREE,
  gangtise_balance_sheet_us: FREE,
  gangtise_cash_flow: FREE,
  gangtise_cash_flow_quarterly: FREE,
  gangtise_cash_flow_hk: FREE,
  gangtise_cash_flow_us: FREE,
  gangtise_main_business: FREE,
  gangtise_valuation_analysis: FREE,
  gangtise_top_holders: FREE,
  // 免费的列表/搜索类
  gangtise_edb_search: FREE,
  gangtise_indicator_search: FREE,
  gangtise_report_image_list: FREE,
  // 私域（无限窗口）
  gangtise_record_list: FREE,
  gangtise_record_download: FREE,
  gangtise_wechat_message_list: FREE,
  gangtise_wechat_chatroom_list: FREE,
  gangtise_stock_pool_list: FREE,
  gangtise_stock_pool_stocks: FREE,
  gangtise_drive_list: FREE,
  gangtise_drive_download: FREE,
  // 源非计分表：7.1 未列此二者，依据是既有代码描述已标「免费。」
  // （reference.ts 的 institution-search / official-account-search）
  gangtise_institution_search: FREE,
  gangtise_official_account_search: FREE,

  // ───────── fixed（43） ─────────
  // AI
  gangtise_knowledge_batch: fixed(10, "call"),
  gangtise_one_pager: fixed(50, "call"),
  gangtise_investment_logic: fixed(50, "call"),
  gangtise_peer_comparison: fixed(50, "call"),
  gangtise_research_outline: fixed(50, "call"),
  gangtise_theme_tracking: fixed(50, "call"),
  gangtise_earnings_review: fixed(50, "call"),
  gangtise_viewpoint_debate: fixed(50, "call"),
  gangtise_hot_topic: fixed(50, "article", "单次约 1000 积分"),
  // stock_summary 刻意不带 amplify：成本 = 3 × 实际返回条数，全市场展开上限未证
  // （6000 只约束显式数组长度，aShares 哨兵只占一个元素）。放大源已在
  // securityList 的参数描述里警示，那里不受 listTools 门禁扫描。
  gangtise_stock_summary: fixed(3, "item"),
  gangtise_security_clue_list: fixed(5, "item"),
  gangtise_management_discuss_announcement: fixed(10, "call"),
  gangtise_management_discuss_earnings_call: fixed(10, "call"),
  // 投研资讯 —— 列表
  gangtise_qa_list: fixed(0.1, "item"),
  gangtise_summary_list: fixed(0.1, "item"),
  gangtise_research_list: fixed(0.1, "item"),
  gangtise_foreign_report_list: fixed(0.1, "item"),
  gangtise_official_account_list: fixed(0.1, "item"),
  gangtise_announcement_list: fixed(0.1, "item"),
  gangtise_announcement_hk_list: fixed(0.1, "item"),
  gangtise_announcement_us_list: fixed(0.1, "item"),
  gangtise_my_conference_list: fixed(0.1, "item"),
  gangtise_opinion_list: fixed(30, "item", "单次约 600 积分"),
  gangtise_foreign_opinion_list: fixed(30, "item", "单次约 600 积分"),
  gangtise_independent_opinion_list: fixed(5, "item"),
  gangtise_roadshow_list: fixed(20, "item", "单次约 400 积分"),
  gangtise_site_visit_list: fixed(20, "item", "单次约 400 积分"),
  gangtise_strategy_list: fixed(20, "item", "单次约 400 积分"),
  gangtise_forum_list: fixed(20, "item", "单次约 400 积分"),
  // 投研资讯 —— 下载
  gangtise_summary_download: fixed(50, "item"),
  gangtise_foreign_report_download: fixed(50, "item"),
  gangtise_my_conference_download: fixed(50, "item"),
  gangtise_independent_opinion_download: fixed(30, "item"),
  gangtise_research_download: fixed(20, "item"),
  gangtise_announcement_hk_download: fixed(20, "item"),
  gangtise_announcement_us_download: fixed(20, "item"),
  gangtise_announcement_download: fixed(10, "item"),
  gangtise_official_account_download: fixed(10, "item"),
  gangtise_report_image_download: fixed(0.1, "image"),
  // 金融数据
  gangtise_earning_forecast: fixed(0.5, "item"),
  // 计分表口径澄清（用户确认）：行业指标数据「30/条」= 30/指标。
  // 刻意不带 amplify：有已证上界 300 = 30 × indicatorIdList.max(10)，且与日期范围无关，
  // 比 concept_info 的 500/次还低 —— 标它只会稀释真正高放大项的信噪比。
  gangtise_edb_data: fixed(30, "indicator"),
  // 刻意不带 amplify：500/次与 size 无关，就是单次实价，标签已如实表达。
  gangtise_concept_info: fixed(500, "call"),
  gangtise_concept_securities: fixed(500, "call"),

  // ───────── downstream（1） ─────────
  gangtise_knowledge_resource_download: { kind: "downstream", note: "按 resourceType 对应的下游资源标准计费" },

  // ───────── variable（2） ─────────
  // 源非 7.1：计分表只写「详见文档」。单元格计价（A股 0.05 / 港股 0.1 / 美股 0.2
  // 积分每 100 单元格）的依据是 gangtise CLI references/commands/indicator.md ——
  // 因此这里仍归 variable、note 指向该文档，不写死单价。
  gangtise_indicator_cross_section: {
    kind: "variable",
    note: "按单元格计价，单价见 gangtise CLI indicator.md（A股 0.05 / 港股 0.1 / 美股 0.2 每 100 单元格）",
    amplify: "按单元格计价，指标数×证券数×日期数即放大倍数",
  },
  gangtise_indicator_time_series: {
    kind: "variable",
    note: "按单元格计价，单价见 gangtise CLI indicator.md（A股 0.05 / 港股 0.1 / 美股 0.2 每 100 单元格）",
    amplify: "按单元格计价，指标数×证券数×日期数即放大倍数",
  },

  // ───────── unconfirmed（9） ─────────
  gangtise_securities_search: UNCONFIRMED_REFERENCE,
  gangtise_chiefs_search: UNCONFIRMED_REFERENCE,
  gangtise_constant_category: UNCONFIRMED_REFERENCE,
  gangtise_constant_list: UNCONFIRMED_REFERENCE,
  gangtise_sector_search: UNCONFIRMED_REFERENCE,
  gangtise_sector_constituents: UNCONFIRMED_REFERENCE,
  gangtise_concept_search: UNCONFIRMED_REFERENCE,
  gangtise_earnings_review_check: UNCONFIRMED_CHECK,
  gangtise_viewpoint_debate_check: UNCONFIRMED_CHECK,
}

/** 付费分页工具的 fetchAll 成本警示。不改默认 size、不自动开 fetchAll —— 只做告知。 */
const PAGINATED_BILLING_WARNING = "默认最多 20 条；size 调大或 fetchAll=true 按全部实际返回条目计费"

/**
 * 紧凑积分标签，是描述的**最后一段**。免费档返回空串 ——
 * instructions 末行已声明「未标注即免费」，34 个免费工具各省 21 B。
 * 目录缺条目直接 throw：新增工具忘归档时启动即炸，好过静默按免费展示。
 *
 * 取值是规格 §三D **冻结的 8 种**之一，`amplify` **绝不进这里**
 * （规格要求高放大提示在「标签外」）—— 它走 billingSuffix()。
 */
export function billingLabel(toolName: string): string {
  const spec = BILLING_CATALOG[toolName]
  if (!spec) throw new Error(`billing catalog missing an entry for tool: ${toolName}`)
  switch (spec.kind) {
    case "free":
      return ""
    case "local":
      return "【本地工具，不消耗 OpenAPI 积分】"
    case "fixed":
      return `【积分：${spec.credits}/${UNIT_LABEL[spec.unit]}】`
    case "downstream":
      return "【积分：按下游资源类型】"
    case "variable":
      return "【积分：按所选指标】"
    case "unconfirmed":
      return "【积分：计分表未覆盖】"
  }
}

/**
 * 标签**之外**的生成式计费尾注：付费分页的 fetchAll 警示 + 高放大提示。
 * 与标签一样由目录生成、非手写，但排在标签之前 —— 因此 listTools 门禁的顺序是
 * 「先剥标签 → 再剥本尾注 → 最后扫残留」。免费/本地档永远返回空串。
 */
export function billingSuffix(toolName: string, paginated: boolean): string {
  const spec = BILLING_CATALOG[toolName]
  if (!spec) throw new Error(`billing catalog missing an entry for tool: ${toolName}`)
  if (spec.kind === "free" || spec.kind === "local") return ""
  const parts: string[] = []
  // 按条计费的分页警示只对 fixed 档成立（每条明码单价）。unconfirmed/downstream/variable
  // 的计费方式未确认或非「按返回条数」，不能替它们断言这句——今天 18 个分页付费工具恰好
  // 全是 fixed，此守卫零当前影响，纯为防未来新增非 fixed 分页工具时误挂计费断言。
  if (paginated && spec.kind === "fixed") parts.push(PAGINATED_BILLING_WARNING)
  if ("amplify" in spec && spec.amplify) parts.push(spec.amplify)
  return parts.length > 0 ? `${parts.join("，")}。` : ""
}

/** 描述 + 生成式尾注 + 积分标签。标签必须留在最后 —— 门禁按尾部逐段剥离。 */
export function withBilling(toolName: string, description: string, paginated = false): string {
  return description + billingSuffix(toolName, paginated) + billingLabel(toolName)
}
