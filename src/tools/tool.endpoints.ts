import type { EndpointTable } from "../core/endpoints.js"

// ─── tool ───
export const toolEndpoints: EndpointTable = {
  "tool.web-search": {
    method: "POST",
    path: "/application/open-tool/web-search/search",
    kind: "json",
    description: "Search the public web for research (tiered sources, optional page content)",
    billing: { kind: "fixed", per: "call", price: 1 },
    // 成功应答即计费：超时后重放会计两次。
    retry: "no-replay",
    expects: "list",
  },
  "tool.file-parse.submit": {
    method: "POST",
    path: "/application/open-tool/file-parse/submit",
    kind: "upload",
    description: "Submit a PDF for parsing (multipart upload), returns taskId",
    // 提交时按实际页数一次性计费；100MB 的文件要传几分钟，不能让默认 30 秒超时掐断，也绝不重放。
    billing: { kind: "fixed", per: "page", price: 0.8 },
    timeoutMs: 300_000,
    retry: "no-replay",
    bigIntFields: ["taskId"],
  },
  "tool.file-parse.result": {
    method: "POST",
    path: "/application/open-tool/file-parse/result",
    kind: "download",
    description: "Fetch a file-parse result ZIP by taskId (140001 = still generating)",
    billing: { kind: "free" },
  },
}
