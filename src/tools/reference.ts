import { z } from "zod"
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import type { GangtiseClient } from "../core/client.js"
import { normalizeRows } from "../core/normalize.js"
import { errorMessage } from "../core/errors.js"

export function registerReferenceTools(server: McpServer, client: GangtiseClient): void {
  server.registerTool(
    "gangtise_securities_search",
    {
      description: "Search Gangtise securities by keyword, stock code, pinyin, or English name. Returns matching securities with their GTS codes.",
      inputSchema: {
        keyword: z.string().describe("Search term: stock name, code (e.g. 600519), pinyin, or English name"),
      },
    },
    async ({ keyword }) => {
      try {
        const result = await client.call("reference.securities-search", { keyword })
        return { content: [{ type: "text" as const, text: JSON.stringify(normalizeRows(result), null, 2) }] }
      } catch (err) {
        return { content: [{ type: "text" as const, text: errorMessage(err) }], isError: true }
      }
    },
  )
}
