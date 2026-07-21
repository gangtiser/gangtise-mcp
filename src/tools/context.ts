import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import type { GangtiseClient } from "../core/client.js"
import { currentDateContext, CURRENT_TIMEZONE } from "../core/dateContext.js"
import { withBilling } from "./billing.js"

export function registerContextTools(server: McpServer, _client: GangtiseClient): void {
  server.registerTool(
    "gangtise_current_date",
    {
      description: withBilling(
        "gangtise_current_date",
        `查询当前日期、当前年份和当前时间（${CURRENT_TIMEZONE}），用于换算今天/最近/今年/当前等相对日期。`,
      ),
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => ({
      content: [{ type: "text" as const, text: JSON.stringify(currentDateContext(), null, 2) }],
    }),
  )
}
