import { z } from "zod"
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import type { GangtiseClient } from "../core/client.js"
import { ENDPOINTS } from "../core/endpoints.js"
import { normalizeRows } from "../core/normalize.js"
import { downloadToResult } from "../core/download.js"
import { errorMessage } from "../core/errors.js"

// Zod raw shape type (compatible with registerTool inputSchema)
type ZodShape = Record<string, z.ZodTypeAny>

export interface JsonToolSpec {
  name: string
  description: string
  endpointKey: string
  inputSchema: ZodShape
  /** Set true for paginated list endpoints — adds size/fetchAll params and default size: 20 */
  paginated?: boolean
}

export interface DownloadToolSpec {
  name: string
  description: string
  endpointKey: string
  inputSchema: ZodShape
}

interface SanitizeOptions {
  paginated?: boolean
  fetchAll?: boolean
}

export function sanitizeArgs(
  args: Record<string, unknown>,
  opts: SanitizeOptions = {},
): Record<string, unknown> {
  const { fetchAll: _fetchAll, ...rest } = args
  if (opts.paginated) {
    if (opts.fetchAll) {
      delete rest.size
    } else if (rest.size === undefined) {
      rest.size = 20
    }
  }
  return rest
}

export function registerJsonTool(server: McpServer, client: GangtiseClient, spec: JsonToolSpec): void {
  const schema: ZodShape = spec.paginated
    ? {
        ...spec.inputSchema,
        size: z.number().int().min(1).optional().describe("Max rows (default 20 for paginated endpoints)"),
        fetchAll: z.boolean().optional().describe("Fetch all pages; may be slow for large datasets"),
      }
    : spec.inputSchema

  server.registerTool(
    spec.name,
    { description: spec.description, inputSchema: schema },
    async (args) => {
      try {
        const { fetchAll, ...rest } = args as Record<string, unknown>
        const body = sanitizeArgs(rest, { paginated: spec.paginated, fetchAll: Boolean(fetchAll) })
        const result = await client.call(spec.endpointKey, body)
        return { content: [{ type: "text" as const, text: JSON.stringify(normalizeRows(result), null, 2) }] }
      } catch (err) {
        return { content: [{ type: "text" as const, text: errorMessage(err) }], isError: true }
      }
    },
  )
}

export function registerDownloadTool(server: McpServer, client: GangtiseClient, spec: DownloadToolSpec): void {
  server.registerTool(
    spec.name,
    { description: spec.description, inputSchema: spec.inputSchema },
    async (args) => {
      try {
        const endpoint = ENDPOINTS[spec.endpointKey]
        if (!endpoint) throw new Error(`Unknown endpoint: ${spec.endpointKey}`)
        const query = args as Record<string, string | number>
        const result = await downloadToResult(client, endpoint, query)
        return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] }
      } catch (err) {
        return { content: [{ type: "text" as const, text: errorMessage(err) }], isError: true }
      }
    },
  )
}
