import { z } from "zod"
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import type { GangtiseClient } from "../core/client.js"
import { getLookupData, type LookupKey } from "../core/lookupData/index.js"
import { errorMessage } from "../core/errors.js"

const LOOKUP_TYPES = [
  "broker-orgs",
  "meeting-orgs",
] as const

export function registerLookupTools(server: McpServer, _client: GangtiseClient): void {
  server.registerTool(
    "gangtise_lookup",
    {
      description: "查询本地静态参考数据（常量/板块 API 未覆盖的 ID）：券商机构、会议机构。无需调用 API，直接返回本地数据。行业/地区/公告类别 ID 用 gangtise_constant_list，主题 ID 用 gangtise_concept_search，申万行业代码（821xxx.SWI）用 gangtise_sector_constituents sectorId=2000000014。",
      inputSchema: {
        type: z.enum(LOOKUP_TYPES).describe(
          "broker-orgs=券商机构 | meeting-orgs=会议机构",
        ),
      },
      annotations: { readOnlyHint: true },
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
