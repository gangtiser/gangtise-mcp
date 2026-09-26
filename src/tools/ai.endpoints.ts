import type { Billing, EndpointTable } from "../core/endpoints.js"

// 异步任务续查是否另计费未确认。确认免费后直接改 free，不要新增「含在提交费里」一类——
// 那与「本来免费」对模型行为完全等价。
const UNPRICED_CHECK: Billing = { kind: "unknown", note: "续查是否另计费未确认" }

// ─── ai ───
export const aiEndpoints: EndpointTable = {
  "ai.stock-summary.list": {
    method: "POST",
    path: "/application/open-ai/stock-summary/getList",
    kind: "json",
    description: "Stock highlights (refined research summary per security)",
    // 不带 amplify：成本 = 3 × 实际返回条数，请求侧只有「传了几个代码」这一个上限。
    // 放大源在 securityList 的参数描述里警示。
    billing: { kind: "fixed", per: "row", price: 3, maxUnits: 6000 },
    // 按条计费（3/条），单次最多 6000 只：一次调用最多 18000 积分，不重放。不重放就要给足等待：
    // 大批量会跑过默认的 30s，而超时的那一次可能已经计费。
    retry: "no-replay",
    timeoutMs: 120_000,
  },
  "ai.knowledge-batch": {
    method: "POST",
    path: "/application/open-data/ai/search/knowledge/batch",
    kind: "json",
    description: "Batch knowledge search",
    billing: { kind: "fixed", per: "call", price: 10 },
    retry: "no-replay",
  },
  "ai.knowledge-resource.download": {
    method: "GET",
    path: "/application/open-data/ai/resource/download",
    kind: "download",
    description: "Download knowledge resource",
    billing: { kind: "downstream", note: "按 resourceType 对应的下游资源标准计费" },
  },
  "ai.security-clue.list": {
    method: "POST",
    path: "/application/open-ai/security-clue/getList",
    kind: "json",
    description: "List security clues",
    billing: { kind: "fixed", per: "row", price: 5 },
    pagination: { mode: "offset", maxPageSize: 500 },
  },
  "ai.one-pager": {
    method: "POST",
    path: "/application/open-ai/agent/one-pager",
    kind: "json",
    description: "Generate one pager",
    billing: { kind: "fixed", per: "call", price: 50 },
    retry: "no-replay",
    timeoutMs: 120_000,
  },
  "ai.investment-logic": {
    method: "POST",
    path: "/application/open-ai/agent/investment-logic",
    kind: "json",
    description: "Generate investment logic",
    billing: { kind: "fixed", per: "call", price: 50 },
    retry: "no-replay",
    timeoutMs: 120_000,
  },
  "ai.peer-comparison": {
    method: "POST",
    path: "/application/open-ai/agent/peer-comparison",
    kind: "json",
    description: "Generate peer comparison",
    billing: { kind: "fixed", per: "call", price: 50 },
    retry: "no-replay",
    timeoutMs: 120_000,
  },
  "ai.earnings-review.get-id": {
    method: "POST",
    path: "/application/open-ai/agent/earnings-review-getid",
    kind: "json",
    description: "Get earnings review ID",
    billing: { kind: "fixed", per: "call", price: 50 },
    retry: "no-replay",
  },
  "ai.earnings-review.get-content": {
    method: "POST",
    path: "/application/open-ai/agent/earnings-review-getcontent",
    kind: "json",
    description: "Get earnings review content",
    billing: UNPRICED_CHECK,
  },
  "ai.theme-tracking": {
    method: "POST",
    path: "/application/open-ai/agent/theme-tracking",
    kind: "json",
    description: "Get theme tracking daily report",
    billing: { kind: "fixed", per: "call", price: 50 },
    retry: "no-replay",
    timeoutMs: 120_000,
  },
  "ai.research-outline": {
    method: "POST",
    path: "/application/open-ai/agent/research-outline",
    kind: "json",
    description: "Get company research outline",
    billing: { kind: "fixed", per: "call", price: 50 },
    retry: "no-replay",
    timeoutMs: 120_000,
  },
  "ai.hot-topic": {
    method: "POST",
    path: "/application/open-ai/hot-topic/getList",
    kind: "json",
    description: "List hot topic reports",
    // 「篇」= 一整份热点话题报告（早报 / 午报 / 盘中快报 / 晚报），不是报告里的一条话题。
    // 按返回的报告计费，与观点列表同一模型，不是按次。
    billing: { kind: "fixed", per: "row", price: 50, unit: "篇", amplify: "单次约 1000 积分" },
    pagination: { mode: "offset", maxPageSize: 20 },
    retry: "no-replay",
  },
  "ai.management-discuss-announcement": {
    method: "POST",
    path: "/application/open-ai/management-discuss/from-announcement",
    kind: "json",
    description: "Management discussion from financial reports (half-year/annual)",
    billing: { kind: "fixed", per: "call", price: 10 },
    retry: "no-replay",
    timeoutMs: 120_000,
  },
  "ai.management-discuss-earnings-call": {
    method: "POST",
    path: "/application/open-ai/management-discuss/from-earningsCall",
    kind: "json",
    description: "Management discussion from earnings calls",
    billing: { kind: "fixed", per: "call", price: 10 },
    retry: "no-replay",
    timeoutMs: 120_000,
  },
  "ai.viewpoint-debate.get-id": {
    method: "POST",
    path: "/application/open-ai/agent/viewpoint-debate-getid",
    kind: "json",
    description: "Get viewpoint debate ID",
    billing: { kind: "fixed", per: "call", price: 50 },
    retry: "no-replay",
  },
  "ai.viewpoint-debate.get-content": {
    method: "POST",
    path: "/application/open-ai/agent/viewpoint-debate-getcontent",
    kind: "json",
    description: "Get viewpoint debate content",
    billing: UNPRICED_CHECK,
  },
}
