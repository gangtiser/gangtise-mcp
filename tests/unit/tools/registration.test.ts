import { describe, it, expect, vi } from "vitest"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { createGangtiseMcpServer } from "../../../src/server.js"
import { ENDPOINTS } from "../../../src/core/endpoints.js"
import type { GangtiseClient } from "../../../src/core/client.js"
import type { JsonToolSpec, DownloadToolSpec } from "../../../src/tools/registry.js"

import { jsonSpecs as aiJsonSpecs, downloadSpecs as aiDownloadSpecs } from "../../../src/tools/ai.js"
import { listSpecs as vaultListSpecs, downloadSpecs as vaultDownloadSpecs } from "../../../src/tools/vault.js"
import { referenceSpecs } from "../../../src/tools/reference.js"
import { listSpecs as insightListSpecs, downloadSpecs as insightDownloadSpecs } from "../../../src/tools/insight.js"
import { specs as fundamentalSpecs } from "../../../src/tools/fundamental.js"
import { specs as alternativeSpecs } from "../../../src/tools/alternative.js"

// Every spec-driven tool routes spec.endpointKey through registerJsonTool/registerDownloadTool
// to client.call / the ENDPOINTS registry. A typo'd endpointKey or a paginated flag that
// disagrees with the endpoint only blows up at call time in prod — these guards catch it in
// CI instead. This is the exact class of error that syncing with gangtise-openapi-cli produces
// (endpoint/param renames, pagination toggles). Directly-registered tools (context/lookup/
// quote/indicator/response) are covered by the smoke test's boot+listTools below.

const jsonSpecs: JsonToolSpec[] = [
  ...aiJsonSpecs,
  ...vaultListSpecs,
  ...referenceSpecs,
  ...insightListSpecs,
  ...fundamentalSpecs,
  ...alternativeSpecs,
]

const downloadSpecs: DownloadToolSpec[] = [
  ...aiDownloadSpecs,
  ...vaultDownloadSpecs,
  ...insightDownloadSpecs,
]

const allSpecs: Array<JsonToolSpec | DownloadToolSpec> = [...jsonSpecs, ...downloadSpecs]

describe("tool spec ↔ ENDPOINTS consistency", () => {
  it("enumerates a substantial number of specs (guards against a vacuous pass if an export breaks)", () => {
    // Every assertion below filters to [] — an empty allSpecs would pass them all trivially.
    expect(allSpecs.length).toBeGreaterThanOrEqual(30)
  })

  it("every spec endpointKey exists in ENDPOINTS", () => {
    const missing = allSpecs.filter((s) => !ENDPOINTS[s.endpointKey]).map((s) => `${s.name} → ${s.endpointKey}`)
    expect(missing).toEqual([])
  })

  it("json specs point at kind:'json' endpoints, download specs at kind:'download'", () => {
    const jsonMismatch = jsonSpecs.filter((s) => ENDPOINTS[s.endpointKey]?.kind !== "json").map((s) => `${s.name} → ${s.endpointKey}`)
    const downloadMismatch = downloadSpecs.filter((s) => ENDPOINTS[s.endpointKey]?.kind !== "download").map((s) => `${s.name} → ${s.endpointKey}`)
    expect(jsonMismatch).toEqual([])
    expect(downloadMismatch).toEqual([])
  })

  it("spec.paginated agrees with endpoint pagination.enabled in both directions", () => {
    // Bidirectional: a paginated tool must hit a paginated endpoint (else requestPaginated
    // misbehaves), AND a tool pointing at a paginated endpoint must opt in (else it silently
    // drops from/size/fetchAll and only ever returns the default page). The codebase is a
    // strict bijection today — if an intentional exception ever arises, make it explicit here.
    const mismatched = jsonSpecs
      .filter((s) => Boolean(s.paginated) !== Boolean(ENDPOINTS[s.endpointKey]?.pagination?.enabled))
      .map((s) => `${s.name} → ${s.endpointKey} (spec.paginated=${Boolean(s.paginated)}, endpoint.enabled=${Boolean(ENDPOINTS[s.endpointKey]?.pagination?.enabled)})`)
    expect(mismatched).toEqual([])
  })

  it("spec-driven tool names are unique and gangtise_-prefixed", () => {
    const names = allSpecs.map((s) => s.name)
    const dups = names.filter((n, i) => names.indexOf(n) !== i)
    expect(dups).toEqual([])
    const badPrefix = names.filter((n) => !n.startsWith("gangtise_"))
    expect(badPrefix).toEqual([])
  })
})

function makeStubClient() {
  // Registration never calls the client — handlers close over it but only invoke it per
  // tool call — so a stub with the right shape is enough to boot the whole server.
  return { call: vi.fn(), download: vi.fn() } as unknown as GangtiseClient
}

// The full-server boot + listTools smoke (tool count, read-only/openWorldHint annotations,
// key tool presence) already lives in tests/integration/server.test.ts. This bridges the
// spec arrays enumerated above to that live registration: it fails if a register*Tools call
// is dropped while its spec array survives (which would let the cross-check above validate a
// dead spec), and — unlike the hardcoded name list in the integration test — auto-covers new
// specs so nobody has to hand-add assertions when a tool is introduced.
describe("spec-driven tools are all live on the server", () => {
  it("registers every enumerated spec on a booted server", async () => {
    const server = createGangtiseMcpServer(makeStubClient(), { version: "0.0.0-test" })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await server.connect(serverTransport)
    const client = new Client({ name: "test", version: "0.0.1" })
    await client.connect(clientTransport)
    const { tools } = await client.listTools()

    const liveNames = new Set(tools.map((t) => t.name))
    const missing = allSpecs.map((s) => s.name).filter((n) => !liveNames.has(n))
    expect(missing).toEqual([])
  })
})
