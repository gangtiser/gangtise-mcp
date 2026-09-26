import type { ToolExamples } from "../mcp/contract.examples.js"

export const lookupExamples: ToolExamples = {
  gangtise_lookup: [
    { title: "本地码表不发请求", args: { type: "broker-orgs" }, expect: { requests: [] } },
    { title: "未知 type 本地拒绝", args: { type: "bogus" }, expect: { rejects: /Invalid enum value.*at type/ } },
  ],
}
