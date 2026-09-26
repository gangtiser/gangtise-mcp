import { describe, expect, it } from "vitest"
import { ENDPOINTS } from "../../../src/core/endpoints.js"

// Billing-protection contract (synced from gangtise-openapi-cli v0.26/v0.27,
// probed 2026-07-11): these endpoints bill per call with no cache-hit exemption,
// so a transport-level replay re-bills. The exact-set assertions make adding or
// removing an annotation a deliberate, reviewed act — not silent drift.
//
// Deliberately ABSENT despite being billed (reviewed 2026-07-11, keep CLI parity):
// - insight.qa.list (0.1/row): per-ROW billed — a failed response has no rows and
//   is not billed (upstream probe), and it's paginated, so no-replay would turn
//   self-healing transient page failures into _partial results for zero benefit.
// - insight.report-image.download (0.1/image): accepted residual risk, NOT proof
//   that a replay can't double-bill — upstream drew the no-replay line at the
//   50-credit download tier (10-30-credit downloads keep default retry), and at
//   0.1/image the worst-case double-bill is negligible next to retry reliability.
const NO_REPLAY_KEYS = [
  "ai.knowledge-batch",
  "ai.one-pager",
  "ai.investment-logic",
  "ai.peer-comparison",
  "ai.earnings-review.get-id",
  "ai.theme-tracking",
  "ai.research-outline",
  "ai.hot-topic",
  "ai.management-discuss-announcement",
  "ai.management-discuss-earnings-call",
  "ai.viewpoint-debate.get-id",
  "alternative.concept-info",
  "alternative.concept-securities",
  "insight.summary.download",
  // Price not published (the 2026-08-07 spec states only an entitlement), so it
  // is treated as its insight.summary.download sibling: if it does meter, a 5xx
  // replay double-bills, and being wrong costs only one retry.
  "insight.pamirs-summary.download",
  "insight.foreign-report.download",
  "vault.my-conference.download",
  // 按行计费且单次行数无可靠上界（盈利预测随区间增长；个股看点单次最多 6000 只 × 3 积分）。
  "fundamental.earning-forecast",
  "ai.stock-summary.list",
  // 观点带正文的列表与按 ID 取正文：30 积分/条。题材完整画像：500 积分/次。
  "insight.opinion.list-with-content",
  "insight.opinion.detail",
  "insight.foreign-opinion.list-with-content",
  "insight.foreign-opinion.detail",
  "alternative.concept-info-full",
  "alternative.concept-securities-full",
  // 清单里唯一不是出于计费原因的一条：池名不允许重复，所以重发一个其实已经建成的
  // 创建请求会撞上 230006，把一次成功报成失败。
  "vault.stock-pool.create",
].sort()

const NO_999999_KEYS = ["indicator.search", "indicator.cross-section", "indicator.time-series", "indicator.screener"].sort()

// Synchronous AI generation regularly outlives the default 30s request timeout;
// aborting bills the orphaned generation anyway, so these carry a 120s floor.
// ai.stock-summary.list 不是生成类，但它不重放、大批量又会跑过 30s，同样给足下限。
const SLOW_AI_KEYS = [
  "ai.stock-summary.list",
  "ai.one-pager",
  "ai.investment-logic",
  "ai.peer-comparison",
  "ai.theme-tracking",
  "ai.research-outline",
  "ai.management-discuss-announcement",
  "ai.management-discuss-earnings-call",
].sort()

describe("ENDPOINTS retry/timeout annotations", () => {
  it("marks exactly the replay-unsafe endpoints as no-replay", () => {
    const annotated = Object.values(ENDPOINTS)
      .filter((e) => e.retry === "no-replay")
      .map((e) => e.key)
      .sort()
    expect(annotated).toEqual(NO_REPLAY_KEYS)
  })

  // 逐条失败藏在 `000000` 成功信封里，判据挂在端点上、由 client.call 统一执行。
  // 漏标就等于把一次部分失败当成全部成功返回，所以加删都必须是一次被看见的改动。
  it("marks exactly the per-item batch writes as itemFailures", () => {
    const annotated = Object.values(ENDPOINTS).filter((e) => e.itemFailures).map((e) => e.key).sort()
    expect(annotated).toEqual([
      "vault.stock-pool.add-stock",
      "vault.stock-pool.delete",
      "vault.stock-pool.remove-stock",
    ])
  })

  // 🔴 标记只在 `requestJson` 那条路径末尾生效：`call` 对 download 与分页端点**提前
  // return**，标了也不会被执行。而这正是该字段要防的那类「标了就以为完事」——将来标在
  // 一个分页端点上会静默失效，上面那条「哪几个端点标了」的断言照样绿。
  it("keeps every itemFailures endpoint on the path where the flag actually runs", () => {
    for (const e of Object.values(ENDPOINTS).filter((x) => x.itemFailures)) {
      expect(e.kind, `${e.key}: download 端点走的是另一条 return，itemFailures 不会执行`).toBe("json")
      expect(e.pagination?.enabled, `${e.key}: 分页端点走的是另一条 return，itemFailures 不会执行`).toBeFalsy()
    }
  })

  it("marks exactly the irreversible endpoints as destructive", () => {
    const annotated = Object.values(ENDPOINTS).filter((e) => e.destructive).map((e) => e.key).sort()
    expect(annotated).toEqual(["vault.stock-pool.delete"])
    // 文案由端点给：网关是通用的，共享一句话会在第二个不可逆端点出现时指名股票池。
    for (const key of annotated) {
      expect(ENDPOINTS[key].destructive!.warning.length, `${key} 的后果说明是空的`).toBeGreaterThan(10)
    }
  })

  it("marks exactly the EDE indicator endpoints as no-999999", () => {
    const annotated = Object.values(ENDPOINTS)
      .filter((e) => e.retry === "no-999999")
      .map((e) => e.key)
      .sort()
    expect(annotated).toEqual(NO_999999_KEYS)
  })

  it("gives exactly the synchronous AI generation endpoints a 120s timeout floor", () => {
    const annotated = Object.values(ENDPOINTS)
      .filter((e) => e.timeoutMs != null)
      .map((e) => e.key)
      .sort()
    expect(annotated).toEqual(SLOW_AI_KEYS)
    for (const endpoint of Object.values(ENDPOINTS)) {
      if (endpoint.timeoutMs != null) expect(endpoint.timeoutMs).toBeGreaterThanOrEqual(120_000)
    }
  })
})
