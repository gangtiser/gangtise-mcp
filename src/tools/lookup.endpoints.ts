import type { EndpointTable } from "../core/endpoints.js"

// ─── lookup (served from local data, not HTTP) ───
export const lookupEndpoints: EndpointTable = {
  "lookup.broker-orgs.list": {
    method: "GET",
    path: "/guide/broker-orgs-local",
    kind: "json",
    description: "List broker orgs from local docs",
  },
  "lookup.meeting-orgs.list": {
    method: "GET",
    path: "/guide/meeting-orgs-local",
    kind: "json",
    description: "List meeting orgs from local docs",
  },
}
