export interface EndpointDefinition {
  key: string
  method: "GET" | "POST"
  path: string
  kind: "json" | "download"
  description: string
  pagination?: {
    enabled: true
    maxPageSize: number
    /** 偏移窗口：服务端拒绝 `from + size` 超过它的任何一页（与 total 无关）。页只在窗口内规划，
     *  需要窗口外的行时结果标 `window_cut`，`from` 本身越过窗口则本地拒绝。 */
    maxWindow?: number
  }
  /** 分页列表的行主键字段，供跨页去重与变动检测（见 client.ts 的 createRowTracker）。按非唯一键
   *  排序的列表，同一时间点的一组行会在两次翻页请求间换顺序，相邻两页各拿到一部分——行数仍等于
   *  total，却有行重复、有行缺失。没有该字段的行一律保留。 */
  rowId?: string
  /** `rowId` 只来自接口文档、未在真实响应里确认过是主键：整行重复照样去掉，但「同 ID 异内容」不报
   *  `changed_rows`（一个不唯一的字段只要重复对跨页出现，就会把每次拉取都误标）。 */
  rowIdUnverified?: true
  /** 返回形状声明，在 `requestJson` 仍握有信封（traceId）时校验，不符抛 `ResponseShapeError`。
   *  "list"：成功响应必是 `{…, list: [...]}`；`{total: 0, list: null}` 是合法的零行写法，照常放行。
   *  "array"：成功响应必是裸数组。形状不符不能读成「零行」——那会把一次异常当成正常的空结果。 */
  expects?: "list" | "array"
  /** "double"：`data` 里还包着一层 `{code, status, data}`（EDE），由 shape.ts 的 unwrapPayload 剥掉，
   *  内层失败码照常抛出。缺省为单层信封。 */
  envelope?: "single" | "double"
  /** 以错误码表示「零行」的端点：这些码收成 `{total: 0, list: []}`，不当错误抛出。 */
  emptyCodes?: string[]
  /** "no-replay": never resend a request the server may have executed — set
   * where a transport-level replay re-bills or duplicates a job. This is a
   * REPLAY-SAFETY marker, not a billing-model one: ai.hot-topic carries it and
   * bills per article (i.e. per row), and insight.pamirs-summary.download
   * publishes no price at all. Never read it as "charges per call".
   * "no-999999": EDE used to answer a no-data query with HTTP 500 + code 999999
   * (probed 2026-07-11). It stopped doing that on 2026-08-01, and since
   * 2026-08-07 a no-data answer keeps its row and column and carries a `null`
   * placeholder (the old indicator-dependent `0` tier is gone),
   * so 999999 is now a generic server fault here — the marker stays because
   * replaying an already-billed EDE query on a fault buys nothing.
   * See transport.ts RetryPolicy. */
  retry?: "no-replay" | "no-999999"
  /** Floor for the HTTP timeout (ms): effective timeout is max(config.timeoutMs,
   * timeoutMs). Set on synchronous AI generation that outlives the 30s default —
   * aborting bills the orphaned generation anyway. */
  timeoutMs?: number
  /** 落地即不可逆：请求发出前必须拿到调用方的显式确认。标在端点上而不是写在某个工具的
   * handler 里，是为了让「这个请求会做什么」只有一份事实——规则复制成两份，早晚只改其中
   * 一份。文案必须由端点给：网关是通用的，共享一句话会在第二个不可逆端点出现时指名股票池。 */
  destructive?: {
    /** 丢的是什么，用调用方的话说。 */
    warning: string
  }
  /** 在 `000000` 成功信封**内部**报逐条失败：`{successList, failList}`，解析不了的条目
   * 落在 `failList` 里而外层仍写着操作成功。不标记就会把一次部分失败当成全部成功返回。
   *
   * 🔴 **只对 `kind: "json"` 且未启用分页的端点有效**：`client.call` 对下载与分页端点
   * 提前 return，标在那两类上不会被执行。`endpoints.test.ts` 钉住这个约束。 */
  itemFailures?: true
}

export const ENDPOINTS: Record<string, EndpointDefinition> = {
  // ─── auth ───
  "auth.login": {
    key: "auth.login",
    method: "POST",
    path: "/application/auth/oauth/open/loginV2",
    kind: "json",
    description: "Get access token",
  },

  // ─── lookup (served from local data, not HTTP) ───
  "lookup.broker-orgs.list": {
    key: "lookup.broker-orgs.list",
    method: "GET",
    path: "/guide/broker-orgs-local",
    kind: "json",
    description: "List broker orgs from local docs",
  },
  "lookup.meeting-orgs.list": {
    key: "lookup.meeting-orgs.list",
    method: "GET",
    path: "/guide/meeting-orgs-local",
    kind: "json",
    description: "List meeting orgs from local docs",
  },

  // ─── insight ───
  // 观点列表两档：v2 只回标题与 200 字 brief（1/条），v1 带正文（30/条）。正文另可按 ID 取 detail。
  "insight.opinion.list": {
    key: "insight.opinion.list",
    method: "POST",
    path: "/application/open-insight/chief-opinion/v2/getList",
    kind: "json",
    description: "List domestic institution chief opinions (brief only)",
    pagination: { enabled: true, maxPageSize: 50 },
    rowId: "chiefOpinionId",
  },
  "insight.opinion.list-with-content": {
    key: "insight.opinion.list-with-content",
    method: "POST",
    path: "/application/open-insight/chief-opinion/getList",
    kind: "json",
    description: "List domestic institution chief opinions with full content",
    pagination: { enabled: true, maxPageSize: 50 },
    retry: "no-replay",
  },
  "insight.opinion.detail": {
    key: "insight.opinion.detail",
    method: "POST",
    path: "/application/open-insight/chief-opinion/getDetail",
    kind: "json",
    description: "Full content of domestic chief opinions by ID (at most 20 per call)",
    retry: "no-replay",
    expects: "array",
  },
  "insight.summary.list": {
    key: "insight.summary.list",
    method: "POST",
    path: "/application/open-insight/summary/v2/getList",
    kind: "json",
    description: "List summaries",
    pagination: { enabled: true, maxPageSize: 50 },
    rowId: "summaryId",
  },
  "insight.summary.download": {
    key: "insight.summary.download",
    method: "GET",
    path: "/application/open-insight/summary/v2/download/file",
    kind: "download",
    description: "Download summary file",
    retry: "no-replay",
  },
  "insight.pamirs-summary.list": {
    key: "insight.pamirs-summary.list",
    method: "POST",
    path: "/application/open-insight/pamirs-summary/getList",
    kind: "json",
    description: "List Pamirs expert summaries (requires the expert-summary database)",
    pagination: { enabled: true, maxPageSize: 50 },
    rowId: "summaryId",
  },
  "insight.pamirs-summary.download": {
    key: "insight.pamirs-summary.download",
    method: "GET",
    path: "/application/open-insight/pamirs-summary/download/file",
    kind: "download",
    description: "Download a Pamirs expert summary file",
    // The 2026-08-07 spec states an entitlement (the expert-summary database) but
    // no per-call price. Treated as non-idempotent anyway, like its
    // insight.summary.download sibling: if it does meter, a 5xx replay
    // double-bills, and the only cost of being wrong is losing one retry.
    retry: "no-replay",
  },
  "insight.roadshow.list": {
    key: "insight.roadshow.list",
    method: "POST",
    path: "/application/open-insight/schedule/roadshow/getList",
    kind: "json",
    description: "List roadshows",
    pagination: { enabled: true, maxPageSize: 50 },
    rowId: "id",
    rowIdUnverified: true,
  },
  "insight.site-visit.list": {
    key: "insight.site-visit.list",
    method: "POST",
    path: "/application/open-insight/schedule/site-visit/getList",
    kind: "json",
    description: "List site visits",
    pagination: { enabled: true, maxPageSize: 50 },
    rowId: "id",
    rowIdUnverified: true,
  },
  "insight.strategy.list": {
    key: "insight.strategy.list",
    method: "POST",
    path: "/application/open-insight/schedule/strategy-meeting/getList",
    kind: "json",
    description: "List strategy meetings",
    pagination: { enabled: true, maxPageSize: 50 },
    rowId: "id",
    rowIdUnverified: true,
  },
  "insight.forum.list": {
    key: "insight.forum.list",
    method: "POST",
    path: "/application/open-insight/schedule/forum/getList",
    kind: "json",
    description: "List forums",
    pagination: { enabled: true, maxPageSize: 50 },
    rowId: "id",
    rowIdUnverified: true,
  },
  "insight.performance-calendar.list": {
    key: "insight.performance-calendar.list",
    method: "POST",
    path: "/application/open-insight/schedule/performance-calendar/getList",
    kind: "json",
    description: "List earnings calendar events (forecast / express / announcement)",
    pagination: { enabled: true, maxPageSize: 50 },
    rowId: "performanceReportId",
  },
  "insight.performance-calendar.download": {
    key: "insight.performance-calendar.download",
    method: "GET",
    path: "/application/open-insight/schedule/performance-calendar/download/file",
    kind: "download",
    description: "Download an earnings report file (A-share 10 credits, HK/US 20)",
  },
  "insight.research.list": {
    key: "insight.research.list",
    method: "POST",
    path: "/application/open-insight/broker-report/getList",
    kind: "json",
    description: "List broker research reports",
    pagination: { enabled: true, maxPageSize: 50 },
    rowId: "reportId",
  },
  "insight.research.download": {
    key: "insight.research.download",
    method: "GET",
    path: "/application/open-insight/broker-report/download/file",
    kind: "download",
    description: "Download broker research report",
  },
  "insight.foreign-report.list": {
    key: "insight.foreign-report.list",
    method: "POST",
    path: "/application/open-insight/foreign-report/getList",
    kind: "json",
    description: "List foreign reports",
    pagination: { enabled: true, maxPageSize: 50 },
    rowId: "reportId",
  },
  "insight.foreign-report.download": {
    key: "insight.foreign-report.download",
    method: "GET",
    path: "/application/open-insight/foreign-report/download/file",
    kind: "download",
    description: "Download foreign report",
    retry: "no-replay",
  },
  "insight.announcement.list": {
    key: "insight.announcement.list",
    method: "POST",
    path: "/application/open-insight/announcement/getList",
    kind: "json",
    description: "List A-share announcements",
    pagination: { enabled: true, maxPageSize: 50 },
    rowId: "announcementId",
  },
  "insight.announcement.download": {
    key: "insight.announcement.download",
    method: "GET",
    path: "/application/open-insight/announcement/download/file",
    kind: "download",
    description: "Download A-share announcement file",
  },
  "insight.announcement-hk.list": {
    key: "insight.announcement-hk.list",
    method: "POST",
    path: "/application/open-insight/announcement-hk/getList",
    kind: "json",
    description: "List HK announcements",
    pagination: { enabled: true, maxPageSize: 50 },
    rowId: "announcementId",
  },
  "insight.announcement-hk.download": {
    key: "insight.announcement-hk.download",
    method: "GET",
    path: "/application/open-insight/announcement-hk/download/file",
    kind: "download",
    description: "Download HK announcement file",
  },
  "insight.announcement-us.list": {
    key: "insight.announcement-us.list",
    method: "POST",
    path: "/application/open-insight/announcement-us/getList",
    kind: "json",
    description: "List US announcements",
    pagination: { enabled: true, maxPageSize: 50 },
    rowId: "announcementId",
  },
  "insight.announcement-us.download": {
    key: "insight.announcement-us.download",
    method: "GET",
    path: "/application/open-insight/announcement-us/download/file",
    kind: "download",
    description: "Download US announcement file",
  },
  "insight.foreign-opinion.list": {
    key: "insight.foreign-opinion.list",
    method: "POST",
    path: "/application/open-insight/foreign-opinion/v2/getList",
    kind: "json",
    description: "List foreign institution opinions (brief only)",
    pagination: { enabled: true, maxPageSize: 50 },
    rowId: "foreignOpinionId",
  },
  "insight.foreign-opinion.list-with-content": {
    key: "insight.foreign-opinion.list-with-content",
    method: "POST",
    path: "/application/open-insight/foreign-opinion/getList",
    kind: "json",
    description: "List foreign institution opinions with full content",
    pagination: { enabled: true, maxPageSize: 50 },
    retry: "no-replay",
  },
  "insight.foreign-opinion.detail": {
    key: "insight.foreign-opinion.detail",
    method: "POST",
    path: "/application/open-insight/foreign-opinion/getDetail",
    kind: "json",
    description: "Full content of foreign opinions by ID (at most 20 per call)",
    retry: "no-replay",
    expects: "array",
  },
  "insight.independent-opinion.list": {
    key: "insight.independent-opinion.list",
    method: "POST",
    path: "/application/open-insight/independent-opinion/getList",
    kind: "json",
    description: "List foreign independent analyst opinions",
    pagination: { enabled: true, maxPageSize: 50 },
    rowId: "independentOpinionId",
    rowIdUnverified: true,
  },
  "insight.independent-opinion.download": {
    key: "insight.independent-opinion.download",
    method: "GET",
    path: "/application/open-insight/independent-opinion/download/file",
    kind: "download",
    description: "Download foreign independent opinion file",
  },
  "insight.official-account.list": {
    key: "insight.official-account.list",
    method: "POST",
    path: "/application/open-insight/officialAccount/getList",
    kind: "json",
    description: "List WeChat official account articles",
    pagination: { enabled: true, maxPageSize: 50 },
    rowId: "articleId",
  },
  "insight.official-account.download": {
    key: "insight.official-account.download",
    method: "GET",
    path: "/application/open-insight/officialAccount/download/file",
    kind: "download",
    description: "Download WeChat official account article (txt/HTML)",
  },
  "insight.qa.list": {
    key: "insight.qa.list",
    method: "POST",
    // The literal '&' is the vendor's path segment (Q&A-data), not a query separator.
    path: "/application/open-insight/Q&A-data/getList",
    kind: "json",
    description: "List investor Q&A (conference/interactive/survey) for a security",
    pagination: { enabled: true, maxPageSize: 500 },
  },
  "insight.report-image.list": {
    key: "insight.report-image.list",
    method: "POST",
    path: "/application/open-insight/report-image/getList",
    kind: "json",
    description: "Search research report images by keyword (returns chunkId + metadata)",
  },
  "insight.report-image.download": {
    key: "insight.report-image.download",
    method: "GET",
    path: "/application/open-insight/report-image/download/file",
    kind: "download",
    description: "Download a research report image by chunkId",
  },

  // ─── reference ───
  "reference.securities-search": {
    key: "reference.securities-search",
    method: "POST",
    path: "/application/open-reference/securities/search",
    kind: "json",
    description: "Search GTS codes (securities)",
  },
  "reference.chiefs-search": {
    key: "reference.chiefs-search",
    method: "POST",
    path: "/application/open-reference/chiefs/search",
    kind: "json",
    description: "Search chief analyst IDs by name / institution / team",
  },
  "reference.institution-search": {
    key: "reference.institution-search",
    method: "POST",
    path: "/application/open-reference/institutions/search",
    kind: "json",
    description: "Search institution IDs by keyword (domestic broker / foreign / lead / opinion institution)",
  },
  "reference.official-account-search": {
    key: "reference.official-account-search",
    method: "POST",
    path: "/application/open-reference/officialAccount/search",
    kind: "json",
    description: "Search official account (WeChat public account) IDs by name / institution / category",
  },
  "reference.constant-category": {
    key: "reference.constant-category",
    method: "GET",
    path: "/application/open-reference/constants/category",
    kind: "json",
    description: "List constant categories and their API usage scopes",
  },
  "reference.constant-list": {
    key: "reference.constant-list",
    method: "POST",
    path: "/application/open-reference/constants/getList",
    kind: "json",
    description: "List all constant values of a category",
  },
  "reference.concept-search": {
    key: "reference.concept-search",
    method: "POST",
    path: "/application/open-reference/concepts/search",
    kind: "json",
    description: "Search concept (theme) IDs by keyword",
  },
  "reference.sector-search": {
    key: "reference.sector-search",
    method: "POST",
    path: "/application/open-reference/sectors/search",
    kind: "json",
    description: "Search sector IDs by keyword",
  },
  "reference.sector-constituents": {
    key: "reference.sector-constituents",
    method: "POST",
    path: "/application/open-reference/sectors/constituents",
    kind: "json",
    description: "List constituent securities of a sector",
  },

  // ─── quote ───
  "quote.day-kline": {
    key: "quote.day-kline",
    method: "POST",
    path: "/application/open-quote/kline/daily",
    kind: "json",
    description: "Query A-share historical daily kline (SH/SZ/BJ)",
    expects: "list",
  },
  "quote.day-kline-hk": {
    key: "quote.day-kline-hk",
    method: "POST",
    path: "/application/open-quote/kline-hk/daily",
    kind: "json",
    description: "Query HK stock historical daily kline (HK)",
    expects: "list",
  },
  "quote.day-kline-us": {
    key: "quote.day-kline-us",
    method: "POST",
    path: "/application/open-quote/kline-us/daily",
    kind: "json",
    description: "Query US stock historical daily kline (NYSE/NASDAQ/AMEX)",
    expects: "list",
  },
  "quote.index-day-kline": {
    key: "quote.index-day-kline",
    method: "POST",
    path: "/application/open-quote/index/kline/daily",
    kind: "json",
    description: "Query SH/SZ/BJ index daily kline",
    expects: "list",
  },
  "quote.minute-kline": {
    key: "quote.minute-kline",
    method: "POST",
    path: "/application/open-quote/kline/minute",
    kind: "json",
    description: "Query A-share minute kline (SH/SZ/BJ)",
    expects: "list",
  },
  "quote.realtime": {
    key: "quote.realtime",
    method: "POST",
    path: "/application/open-quote/quote/realtime",
    kind: "json",
    description: "Query realtime quote snapshot (A-share / HK / US)",
    expects: "list",
  },
  "quote.fund-flow": {
    key: "quote.fund-flow",
    method: "POST",
    path: "/application/open-quote/fund-flow/daily",
    kind: "json",
    description: "Query A-share daily fund flow (SH/SZ/BJ; small/medium/large/xlarge orders + main net inflow)",
    expects: "list",
  },

  // ─── fundamental ───
  "fundamental.income-statement": {
    key: "fundamental.income-statement",
    method: "POST",
    path: "/application/open-fundamental/financial-report/income-statement/accumulated",
    kind: "json",
    description: "Query income statement (accumulated)",
  },
  "fundamental.income-statement-quarterly": {
    key: "fundamental.income-statement-quarterly",
    method: "POST",
    path: "/application/open-fundamental/financial-report/income-statement/quarterly",
    kind: "json",
    description: "Query income statement (quarterly)",
  },
  "fundamental.balance-sheet": {
    key: "fundamental.balance-sheet",
    method: "POST",
    path: "/application/open-fundamental/financial-report/balance-sheet/accumulated",
    kind: "json",
    description: "Query balance sheet (accumulated)",
  },
  "fundamental.cash-flow": {
    key: "fundamental.cash-flow",
    method: "POST",
    path: "/application/open-fundamental/financial-report/cash-flow-statement/accumulated",
    kind: "json",
    description: "Query cash flow statement (accumulated)",
  },
  "fundamental.cash-flow-quarterly": {
    key: "fundamental.cash-flow-quarterly",
    method: "POST",
    path: "/application/open-fundamental/financial-report/cash-flow-statement/quarterly",
    kind: "json",
    description: "Query cash flow statement (quarterly)",
  },
  "fundamental.main-business": {
    key: "fundamental.main-business",
    method: "POST",
    path: "/application/open-fundamental/main-business",
    kind: "json",
    description: "Query main business composition",
  },
  "fundamental.valuation-analysis": {
    key: "fundamental.valuation-analysis",
    method: "POST",
    path: "/application/open-fundamental/valuation-analysis",
    kind: "json",
    description: "Query valuation analysis",
  },
  "fundamental.top-holders": {
    key: "fundamental.top-holders",
    method: "POST",
    path: "/application/open-fundamental/capital-structure/top-holders",
    kind: "json",
    description: "Query top holders (top10 / top10 float)",
  },
  "fundamental.earning-forecast": {
    key: "fundamental.earning-forecast",
    method: "POST",
    path: "/application/open-fundamental/earning-forecast",
    kind: "json",
    description: "Query earning forecast (consensus estimates)",
    // 按行计费（0.5/条），行数随日期区间增长：每个工作日一个日期 × 三个预测年度，区间上限只受
    // 账号的取数窗口约束。单次调用可以远超几千积分，而客户端给不出可靠的行数上界，所以不重放。
    retry: "no-replay",
  },
  "fundamental.income-statement-hk": {
    key: "fundamental.income-statement-hk",
    method: "POST",
    path: "/application/open-fundamental/financial-report/income-statement/hk",
    kind: "json",
    description: "Query HK income statement (China GAAP)",
  },
  "fundamental.balance-sheet-hk": {
    key: "fundamental.balance-sheet-hk",
    method: "POST",
    path: "/application/open-fundamental/financial-report/balance-sheet/hk",
    kind: "json",
    description: "Query HK balance sheet (China GAAP)",
  },
  "fundamental.cash-flow-hk": {
    key: "fundamental.cash-flow-hk",
    method: "POST",
    path: "/application/open-fundamental/financial-report/cash-flow-statement/hk",
    kind: "json",
    description: "Query HK cash flow statement (China GAAP)",
  },
  "fundamental.income-statement-us": {
    key: "fundamental.income-statement-us",
    method: "POST",
    path: "/application/open-fundamental/financial-report/income-statement/us",
    kind: "json",
    description: "Query US income statement",
  },
  "fundamental.balance-sheet-us": {
    key: "fundamental.balance-sheet-us",
    method: "POST",
    path: "/application/open-fundamental/financial-report/balance-sheet/us",
    kind: "json",
    description: "Query US balance sheet",
  },
  "fundamental.cash-flow-us": {
    key: "fundamental.cash-flow-us",
    method: "POST",
    path: "/application/open-fundamental/financial-report/cash-flow-statement/us",
    kind: "json",
    description: "Query US cash flow statement",
  },

  // ─── ai ───
  "ai.stock-summary.list": {
    key: "ai.stock-summary.list",
    method: "POST",
    path: "/application/open-ai/stock-summary/getList",
    kind: "json",
    description: "Stock highlights (refined research summary per security)",
    // 按条计费（3/条），单次最多 6000 只：一次调用最多 18000 积分，不重放。不重放就要给足等待：
    // 大批量会跑过默认的 30s，而超时的那一次可能已经计费。
    retry: "no-replay",
    timeoutMs: 120_000,
  },
  "ai.knowledge-batch": {
    key: "ai.knowledge-batch",
    method: "POST",
    path: "/application/open-data/ai/search/knowledge/batch",
    kind: "json",
    description: "Batch knowledge search",
    retry: "no-replay",
  },
  "ai.knowledge-resource.download": {
    key: "ai.knowledge-resource.download",
    method: "GET",
    path: "/application/open-data/ai/resource/download",
    kind: "download",
    description: "Download knowledge resource",
  },
  "ai.security-clue.list": {
    key: "ai.security-clue.list",
    method: "POST",
    path: "/application/open-ai/security-clue/getList",
    kind: "json",
    description: "List security clues",
    pagination: { enabled: true, maxPageSize: 500 },
  },
  "ai.one-pager": {
    key: "ai.one-pager",
    method: "POST",
    path: "/application/open-ai/agent/one-pager",
    kind: "json",
    description: "Generate one pager",
    retry: "no-replay",
    timeoutMs: 120_000,
  },
  "ai.investment-logic": {
    key: "ai.investment-logic",
    method: "POST",
    path: "/application/open-ai/agent/investment-logic",
    kind: "json",
    description: "Generate investment logic",
    retry: "no-replay",
    timeoutMs: 120_000,
  },
  "ai.peer-comparison": {
    key: "ai.peer-comparison",
    method: "POST",
    path: "/application/open-ai/agent/peer-comparison",
    kind: "json",
    description: "Generate peer comparison",
    retry: "no-replay",
    timeoutMs: 120_000,
  },
  "ai.earnings-review.get-id": {
    key: "ai.earnings-review.get-id",
    method: "POST",
    path: "/application/open-ai/agent/earnings-review-getid",
    kind: "json",
    description: "Get earnings review ID",
    retry: "no-replay",
  },
  "ai.earnings-review.get-content": {
    key: "ai.earnings-review.get-content",
    method: "POST",
    path: "/application/open-ai/agent/earnings-review-getcontent",
    kind: "json",
    description: "Get earnings review content",
  },
  "ai.theme-tracking": {
    key: "ai.theme-tracking",
    method: "POST",
    path: "/application/open-ai/agent/theme-tracking",
    kind: "json",
    description: "Get theme tracking daily report",
    retry: "no-replay",
    timeoutMs: 120_000,
  },
  "ai.research-outline": {
    key: "ai.research-outline",
    method: "POST",
    path: "/application/open-ai/agent/research-outline",
    kind: "json",
    description: "Get company research outline",
    retry: "no-replay",
    timeoutMs: 120_000,
  },
  "ai.hot-topic": {
    key: "ai.hot-topic",
    method: "POST",
    path: "/application/open-ai/hot-topic/getList",
    kind: "json",
    description: "List hot topic reports",
    pagination: { enabled: true, maxPageSize: 20 },
    retry: "no-replay",
  },
  "ai.management-discuss-announcement": {
    key: "ai.management-discuss-announcement",
    method: "POST",
    path: "/application/open-ai/management-discuss/from-announcement",
    kind: "json",
    description: "Management discussion from financial reports (half-year/annual)",
    retry: "no-replay",
    timeoutMs: 120_000,
  },
  "ai.management-discuss-earnings-call": {
    key: "ai.management-discuss-earnings-call",
    method: "POST",
    path: "/application/open-ai/management-discuss/from-earningsCall",
    kind: "json",
    description: "Management discussion from earnings calls",
    retry: "no-replay",
    timeoutMs: 120_000,
  },
  "ai.viewpoint-debate.get-id": {
    key: "ai.viewpoint-debate.get-id",
    method: "POST",
    path: "/application/open-ai/agent/viewpoint-debate-getid",
    kind: "json",
    description: "Get viewpoint debate ID",
    retry: "no-replay",
  },
  "ai.viewpoint-debate.get-content": {
    key: "ai.viewpoint-debate.get-content",
    method: "POST",
    path: "/application/open-ai/agent/viewpoint-debate-getcontent",
    kind: "json",
    description: "Get viewpoint debate content",
  },

  // ─── vault ───
  "vault.drive.list": {
    key: "vault.drive.list",
    method: "POST",
    path: "/application/open-vault/drive/getList",
    kind: "json",
    description: "List vault drive files",
    pagination: { enabled: true, maxPageSize: 50 },
    rowId: "fileId",
  },
  "vault.drive.download": {
    key: "vault.drive.download",
    method: "GET",
    path: "/application/open-vault/drive/download/file",
    kind: "download",
    description: "Download vault drive file",
  },
  "vault.record.list": {
    key: "vault.record.list",
    method: "POST",
    path: "/application/open-vault/record/getList",
    kind: "json",
    description: "List voice recording transcriptions",
    pagination: { enabled: true, maxPageSize: 50 },
    rowId: "recordId",
  },
  "vault.record.download": {
    key: "vault.record.download",
    method: "GET",
    path: "/application/open-vault/record/download/file",
    kind: "download",
    description: "Download voice recording transcription file",
  },
  "vault.my-conference.list": {
    key: "vault.my-conference.list",
    method: "POST",
    path: "/application/open-vault/my-conference/getList",
    kind: "json",
    description: "List my conferences",
    pagination: { enabled: true, maxPageSize: 50 },
    rowId: "conferenceId",
  },
  "vault.my-conference.download": {
    key: "vault.my-conference.download",
    method: "GET",
    path: "/application/open-vault/my-conference/download/file",
    kind: "download",
    description: "Download my conference resource",
    retry: "no-replay",
  },
  "vault.wechat-message.list": {
    key: "vault.wechat-message.list",
    method: "POST",
    path: "/application/open-vault/wechatgroupmsg/list",
    kind: "json",
    description: "List WeChat group messages",
    pagination: { enabled: true, maxPageSize: 50, maxWindow: 10_000 },
    rowId: "msgId",
  },
  "vault.wechat-chatroom.list": {
    key: "vault.wechat-chatroom.list",
    method: "POST",
    path: "/application/open-vault/wechatgroupmsg/chatroomId",
    kind: "json",
    description: "List WeChat group chatroom IDs",
    pagination: { enabled: true, maxPageSize: 50 },
    rowId: "chatroomId",
  },
  "vault.stock-pool.list": {
    key: "vault.stock-pool.list",
    method: "POST",
    path: "/application/open-vault/stock-pool/getPoolList",
    kind: "json",
    description: "List user stock pool IDs and names",
  },
  "vault.stock-pool.stocks": {
    key: "vault.stock-pool.stocks",
    method: "POST",
    path: "/application/open-vault/stock-pool/getStockList",
    kind: "json",
    description: "List securities in stock pool(s)",
  },

  // ─── vault stock-pool writes ───
  // 本服务仅有的五个写端点，只动当前账号本人的自选股。五个里有四个按服务端自己的规则
  // 就是幂等的：重复加已在池内的证券、移除本来就不在池内的、删一个不存在的池，都回
  // `000000` 并把该条计入 successList。createPool 是例外，见下。
  "vault.stock-pool.create": {
    key: "vault.stock-pool.create",
    method: "POST",
    path: "/application/open-vault/stock-pool/createPool",
    kind: "json",
    // 非幂等，而它的非幂等恰恰让重放变成**误报**：池名重复会被 `230006` 拒绝，于是重放
    // 一个其实已经建成的请求，拿回来的是失败——池建成了，调用方却被告知没建成。宁可如实
    // 说「不知道成没成，去 gangtise_stock_pool_list 查一眼」。这是 no-replay 清单里唯一
    // 不是出于计费原因的一条。
    retry: "no-replay",
    description: "Create a stock pool",
  },
  "vault.stock-pool.rename": {
    key: "vault.stock-pool.rename",
    method: "POST",
    path: "/application/open-vault/stock-pool/updatePool",
    kind: "json",
    description: "Rename a stock pool",
  },
  "vault.stock-pool.add-stock": {
    key: "vault.stock-pool.add-stock",
    method: "POST",
    path: "/application/open-vault/stock-pool/addStock",
    kind: "json",
    itemFailures: true,
    description: "Add securities to a stock pool",
  },
  "vault.stock-pool.remove-stock": {
    key: "vault.stock-pool.remove-stock",
    method: "POST",
    path: "/application/open-vault/stock-pool/deleteStock",
    kind: "json",
    itemFailures: true,
    description: "Remove securities from a stock pool",
  },
  "vault.stock-pool.delete": {
    key: "vault.stock-pool.delete",
    method: "POST",
    path: "/application/open-vault/stock-pool/deletePool",
    kind: "json",
    destructive: {
      warning: "删除股票池会同时移除池内全部证券的关注关系，且不可恢复（个股的投资笔记独立保留、不受影响）。",
    },
    itemFailures: true,
    description: "Delete stock pools (removes every watch relation inside them)",
  },

  // ─── alternative ───
  "alternative.edb-search": {
    key: "alternative.edb-search",
    method: "POST",
    path: "/application/open-alternative/EDB/search",
    kind: "json",
    description: "Search industry indicator list by keyword",
  },
  "alternative.edb-data": {
    key: "alternative.edb-data",
    method: "POST",
    path: "/application/open-alternative/EDB/getData",
    kind: "json",
    description: "Get industry indicator time-series data by indicator ID list",
  },
  // 题材两档：v2（50/次）不含催化事件与重点标记，-full 走 v1（500/次）带全。
  "alternative.concept-info": {
    key: "alternative.concept-info",
    method: "POST",
    path: "/application/open-alternative/concept/v2/info",
    kind: "json",
    description: "Query latest concept (theme index) profile by conceptId (without keyEvents)",
    retry: "no-replay",
  },
  "alternative.concept-info-full": {
    key: "alternative.concept-info-full",
    method: "POST",
    path: "/application/open-alternative/concept/info",
    kind: "json",
    description: "Query latest concept (theme index) profile by conceptId, with keyEvents",
    retry: "no-replay",
  },
  "alternative.concept-securities": {
    key: "alternative.concept-securities",
    method: "POST",
    path: "/application/open-alternative/concept/v2/securities",
    kind: "json",
    description: "Query concept (theme index) constituent securities, grouped (without isKey / inclusionReason)",
    retry: "no-replay",
  },
  "alternative.concept-securities-full": {
    key: "alternative.concept-securities-full",
    method: "POST",
    path: "/application/open-alternative/concept/securities",
    kind: "json",
    description: "Query concept (theme index) constituent securities, grouped, with isKey / inclusionReason",
    retry: "no-replay",
  },

  // ─── indicator (EDE: security-level data indicators) ───
  "indicator.search": {
    key: "indicator.search",
    method: "POST",
    path: "/application/open-indicator/EDE/search",
    kind: "json",
    description: "Search data indicators by keyword (returns indicatorCode + params)",
    retry: "no-999999",
    envelope: "double",
  },
  "indicator.cross-section": {
    key: "indicator.cross-section",
    method: "POST",
    path: "/application/open-indicator/EDE/cross-section",
    kind: "json",
    description: "Get cross-section data (multi-indicator x multi-security, single date)",
    retry: "no-999999",
    envelope: "double",
  },
  "indicator.time-series": {
    key: "indicator.time-series",
    method: "POST",
    path: "/application/open-indicator/EDE/time-series",
    kind: "json",
    description: "Get time-series data (multi-indicator x single-security OR single-indicator x multi-security)",
    retry: "no-999999",
    envelope: "double",
  },
  // Note the path: the screener sits directly under open-indicator, NOT under
  // the EDE/ prefix its three siblings share.
  "indicator.screener": {
    key: "indicator.screener",
    method: "POST",
    path: "/application/open-indicator/screener",
    kind: "json",
    description: "Screen securities by an expression over indicator values (条件选股)",
    retry: "no-999999",
    envelope: "double",
  },
}
