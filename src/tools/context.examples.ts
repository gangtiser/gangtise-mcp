import type { ToolExamples } from "../mcp/contract.examples.js"

export const contextExamples: ToolExamples = {
  gangtise_current_date: [
    { title: "本地工具不发请求", args: {}, expect: { requests: [] } },
  ],
}
