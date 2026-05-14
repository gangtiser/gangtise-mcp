import { z } from "zod"
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import type { GangtiseClient } from "../core/client.js"
import { getLookupData, type LookupKey } from "../core/lookupData/index.js"
import { errorMessage } from "../core/errors.js"

const LOOKUP_TYPES = [
  "research-areas",
  "broker-orgs",
  "meeting-orgs",
  "industries",
  "regions",
  "announcement-categories",
  "industry-codes",
  "theme-ids",
] as const

export function registerLookupTools(server: McpServer, _client: GangtiseClient): void {
  server.registerTool(
    "gangtise_lookup",
    {
      description: "List static reference data: research areas, broker orgs, meeting orgs, industries, regions, announcement categories, Shenwan industry codes, or theme IDs. Returns local data without an API call.",
      inputSchema: {
        type: z.enum(LOOKUP_TYPES).describe(
          "research-areas | broker-orgs | meeting-orgs | industries | regions | announcement-categories | industry-codes | theme-ids",
        ),
      },
    },
    async ({ type }) => {
      try {
        const data = await getLookupData(type as LookupKey)
        return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] }
      } catch (err) {
        return { content: [{ type: "text" as const, text: errorMessage(err) }], isError: true }
      }
    },
  )
}
