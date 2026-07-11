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
  "insight.foreign-report.download",
  "vault.my-conference.download",
].sort()

const NO_999999_KEYS = ["indicator.search", "indicator.cross-section", "indicator.time-series"].sort()

// Synchronous AI generation regularly outlives the default 30s request timeout;
// aborting bills the orphaned generation anyway, so these carry a 120s floor.
const SLOW_AI_KEYS = [
  "ai.one-pager",
  "ai.investment-logic",
  "ai.peer-comparison",
  "ai.theme-tracking",
  "ai.research-outline",
  "ai.management-discuss-announcement",
  "ai.management-discuss-earnings-call",
].sort()

describe("ENDPOINTS retry/timeout annotations", () => {
  it("marks exactly the per-call billed endpoints as no-replay", () => {
    const annotated = Object.values(ENDPOINTS)
      .filter((e) => e.retry === "no-replay")
      .map((e) => e.key)
      .sort()
    expect(annotated).toEqual(NO_REPLAY_KEYS)
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
