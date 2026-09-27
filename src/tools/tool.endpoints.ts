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
}
