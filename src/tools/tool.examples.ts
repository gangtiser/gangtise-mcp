import type { ToolExamples } from "../mcp/contract.examples.js"

const PATH = "/application/open-tool/web-search/search"

export const toolExamples: ToolExamples = {
  gangtise_web_search: [
    { title: "只传 query", args: { query: "减持新规" }, expect: { requests: [{ method: "POST", path: PATH, body: { query: "减持新规" } }] } },
    { title: "站点去重、时效与信源", args: { query: "减持新规", siteList: ["csrc.gov.cn", "sse.com.cn", "csrc.gov.cn"], freshness: "week", minTier: "T1" }, expect: { requests: [{ method: "POST", path: PATH, body: { query: "减持新规", siteList: ["csrc.gov.cn", "sse.com.cn"], freshness: "week", minTier: "T1" } }] } },
    { title: "带正文且省略 size：按上限 5 条发", args: { query: "某公告标题", includeContent: true, maxContentChars: 6000 }, expect: { requests: [{ method: "POST", path: PATH, body: { query: "某公告标题", includeContent: true, maxContentChars: 6000, size: 5 } }] } },
    { title: "带正文时 size 超 5 本地拒绝", args: { query: "某公告标题", includeContent: true, size: 10 }, expect: { rejects: /size 最多 5/ } },
    { title: "站点超 10 个本地拒绝", args: { query: "x", siteList: Array.from({ length: 11 }, (_, i) => `s${i}.gov.cn`) }, expect: { rejects: /最多 10 个/ } },
    { title: "query 超 200 字在 schema 层拒绝", args: { query: "字".repeat(201) }, expect: { rejects: /query/ } },
  ],
}
