import { z } from "zod"
import { getLookupData, type LookupKey } from "../core/lookupData/index.js"
import { contentResult } from "../mcp/handler.js"
import { buildToolContent } from "../core/present.js"
import { LOCAL } from "../mcp/billing.js"
import { defineTool, type FamilyModule } from "../mcp/define.js"
import { lookupEndpoints } from "./lookup.endpoints.js"

const LOOKUP_TYPES = [
  "broker-orgs",
  "meeting-orgs",
] as const

export const lookupFamily: FamilyModule = {
  name: "lookup",
  endpoints: lookupEndpoints,
  tools: [
    defineTool({
      name: "gangtise_lookup",
      tier: "core",
      access: "read",
      billingLabel: LOCAL,
      description:
        "查询本地静态参考数据（常量/板块 API 未覆盖的 ID）：券商机构、会议机构。无需调用 API，直接返回本地数据。行业/研究方向/地区/公告类别 ID 用 gangtise_constant_list，主题 ID 用 gangtise_concept_search，申万行业代码（801xxx.SWI）用 gangtise_sector_constituents sectorId=2000000014。",
      input: {
        type: z.enum(LOOKUP_TYPES).describe(
          "broker-orgs=券商机构 | meeting-orgs=会议机构",
        ),
      },
      run: async (_ctx, args) => contentResult(await buildToolContent(await getLookupData(args.type as LookupKey))),
      examples: [
        { title: "本地码表不发请求", args: { type: "broker-orgs" }, expect: { requests: [] } },
        { title: "未知 type 本地拒绝", args: { type: "bogus" }, expect: { rejects: /Invalid enum value.*at type/ } },
      ],
    }),
  ],
}
