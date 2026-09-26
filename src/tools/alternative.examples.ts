import type { ToolExamples } from "../mcp/contract.examples.js"

export const alternativeExamples: ToolExamples = {
  gangtise_edb_search: [
    { title: "关键词 + limit", args: { keyword: "PMI", limit: 10 }, expect: { requests: [{ method: "POST", path: "/application/open-alternative/EDB/search", body: { keyword: "PMI", limit: 10 } }] } },
  ],
  gangtise_concept_info: [
    { title: "缺省 full：完整画像端点", args: { conceptId: "121000130" }, expect: { requests: [{ method: "POST", path: "/application/open-alternative/concept/info", body: { conceptId: "121000130" } }] } },
    { title: "full=false 走低价端点，开关不进 body", args: { conceptId: "121000130", full: false }, expect: { requests: [{ method: "POST", path: "/application/open-alternative/concept/v2/info", body: { conceptId: "121000130" } }] } },
  ],
  gangtise_concept_securities: [
    { title: "缺省 full：带重点标记的端点", args: { conceptId: "121000130" }, expect: { requests: [{ method: "POST", path: "/application/open-alternative/concept/securities", body: { conceptId: "121000130" } }] } },
    { title: "full=false 走低价端点", args: { conceptId: "121000130", full: false }, expect: { requests: [{ method: "POST", path: "/application/open-alternative/concept/v2/securities", body: { conceptId: "121000130" } }] } },
  ],
  gangtise_edb_data: [
    { title: "指标 + 区间", args: { indicatorIdList: ["edb-1", "edb-2"], startDate: "2025-01-01", endDate: "2026-06-30" }, expect: { requests: [{ method: "POST", path: "/application/open-alternative/EDB/getData", body: { indicatorIdList: ["edb-1", "edb-2"], startDate: "2025-01-01", endDate: "2026-06-30" } }] } },
  ],
}
