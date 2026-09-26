import type { ToolExamples } from "../mcp/contract.examples.js"

export const responseExamples: ToolExamples = {
  gangtise_read_response: [
    { title: "非本进程临时文件拒读", args: { saved_to: "/etc/hosts" }, expect: { rejects: /gangtise-mcp- temp file/ } },
  ],
}
