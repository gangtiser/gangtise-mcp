import { z } from "zod"
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import type { GangtiseClient } from "../core/client.js"
import { normalizeRows } from "../core/normalize.js"
import { buildToolContent, registerJsonTool, type JsonToolSpec } from "./registry.js"
import { toolHandler, contentResult } from "./helpers.js"

const referenceSpecs: JsonToolSpec[] = [
  {
    name: "gangtise_constant_category",
    description:
      "查询常量分类列表：返回所有常量分类及每个分类适用于哪些接口的哪些参数（usageScopes）。当前分类：citicIndustry=中信一级行业 | swIndustry=申万一级行业 | gangtiseIndustry=Gangtise行业 | domesticCity=国内城市 | aShareAnnouncementCategory=A股公告分类 | hkShareAnnouncementCategory=港股公告分类 | regionCategory=区域分类。",
    endpointKey: "reference.constant-category",
    inputSchema: {},
  },
  {
    name: "gangtise_constant_list",
    description:
      "查询某个常量分类下的全部常量值（constantId / constantName / level），树形分类（公告分类）的父节点含 children 嵌套。行业、城市、公告类别、区域等筛选参数的 ID 都从这里查。",
    endpointKey: "reference.constant-list",
    inputSchema: {
      category: z
        .string()
        .describe(
          "分类代码（必填）：citicIndustry | swIndustry | gangtiseIndustry | domesticCity | aShareAnnouncementCategory | hkShareAnnouncementCategory | regionCategory，完整清单见 gangtise_constant_category",
        ),
    },
  },
  {
    name: "gangtise_concept_search",
    description:
      "按关键词搜索题材（概念/主题）ID，支持中文名、简称、拼音首字母（如 jqr）、分组名。返回 conceptId / conceptName / matchScore。该 ID 供 gangtise_concept_info / gangtise_concept_securities 的 conceptId 和 gangtise_theme_tracking 的 themeId 使用（同一套 ID）。",
    endpointKey: "reference.concept-search",
    inputSchema: {
      keyword: z.string().describe("搜索词：题材中文名/简称、拼音首字母（如 jqr）、分组名（如 灵巧手）"),
      top: z.number().int().min(1).max(10).optional().describe("最大返回条数（默认 10，上限 10）"),
    },
  },
  {
    name: "gangtise_sector_search",
    description:
      "按关键词搜索板块 ID（行业/概念/指数成份等分类树节点），返回 sectorId / sectorName / hierarchy（层级路径）/ matchScore。同名板块可能出现在多个层级，用 hierarchy 区分。sectorId 供 gangtise_sector_constituents 使用，与题材 conceptId 是两套 ID，不通用。",
    endpointKey: "reference.sector-search",
    inputSchema: {
      keyword: z.string().optional().describe("搜索词：板块中文名/简称、拼音首字母"),
      top: z.number().int().min(1).max(10).optional().describe("最大返回条数（默认 10，上限 10）"),
    },
  },
  {
    name: "gangtise_sector_constituents",
    description:
      "查询板块的全量成分股名单（gtsCode / gtsName）。sectorId 必须来自 gangtise_sector_search；返回 0 条通常是误用了题材 conceptId。题材成分股（含分组/重点标记）用 gangtise_concept_securities。申万行业代码全量列表（821xxx.SWI，共 31 个）：sectorId=2000000014（申万一级行业指数，取「指数数据板块」层级的节点；「指数成份类」层级的同名节点返回 0 条）。",
    endpointKey: "reference.sector-constituents",
    inputSchema: {
      sectorId: z.string().describe("板块 ID，来自 gangtise_sector_search（必填）"),
    },
  },
]

export function registerReferenceTools(server: McpServer, client: GangtiseClient): void {
  server.registerTool(
    "gangtise_securities_search",
    {
      description: "按关键词搜索证券，支持股票名称、代码（如 600519）、拼音或英文名。返回匹配证券及其 GTS 代码。",
      inputSchema: {
        keyword: z.string().describe("搜索词：股票名称、代码（如 600519）、拼音或英文名"),
        category: z.array(z.string()).optional().describe("按类别筛选，如 ['stock', 'fund', 'index']"),
        top: z.number().int().min(1).optional().describe("最大返回条数"),
      },
      annotations: { readOnlyHint: true },
    },
    toolHandler(async (args: Record<string, unknown>) => {
      const result = await client.call("reference.securities-search", args)
      return contentResult(await buildToolContent(normalizeRows(result)))
    }),
  )

  for (const spec of referenceSpecs) {
    registerJsonTool(server, client, spec)
  }
}
