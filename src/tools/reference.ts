import { z } from "zod"
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import type { GangtiseClient } from "../core/client.js"
import { normalizeRows } from "../core/normalize.js"
import { buildToolContent, registerJsonTool, type JsonToolSpec } from "./registry.js"
import { toolHandler, contentResult } from "./helpers.js"

const referenceSpecs: JsonToolSpec[] = [
  {
    name: "gangtise_chiefs_search",
    description:
      "按姓名 / 机构 / 团队搜索首席分析师 ID，返回 chiefId 等。该 ID 供 gangtise_opinion_list 的 chiefList 使用。",
    endpointKey: "reference.chiefs-search",
    inputSchema: {
      keyword: z.string().trim().min(1, "搜索词不能为空").describe("搜索词：首席姓名、机构或团队名"),
      top: z.number().int().min(1).max(10).optional().describe("最大返回条数（默认 10，上限 10）"),
    },
  },
  {
    name: "gangtise_institution_search",
    description:
      "按机构名称 / 简称搜索机构 ID，返回 institutionId 及 usageScopes（标明该 ID 用于哪个接口的哪个参数）。覆盖内资券商 / 外资 / 牵头 / 观点机构，供各 list 工具的 institutionList / brokerList 等参数使用。免费。提示：内资券商（domesticBroker）与外资机构（foreignInstitution）类需用较完整的机构名（如「华泰证券」「Goldman」「Morgan」），简称可能搜不到；牵头 / 观点类（leadInstitution / opinionInstitution / foreignOpinionInstitution）可用简称（如「中金」「高盛」）。",
    endpointKey: "reference.institution-search",
    inputSchema: {
      keyword: z.string().trim().min(1, "搜索词不能为空").describe("搜索词：机构名称或简称"),
      categoryList: z
        .array(
          z.enum([
            "domesticBroker",
            "foreignInstitution",
            "leadInstitution",
            "opinionInstitution",
            "foreignOpinionInstitution",
          ]),
        )
        .optional()
        .describe(
          "机构类别筛选（可多选，不传查全部）：domesticBroker=内资券商 | foreignInstitution=外资机构 | leadInstitution=牵头机构 | opinionInstitution=观点机构 | foreignOpinionInstitution=外资观点机构",
        ),
      top: z.number().int().min(1).max(10).optional().describe("最大返回条数（默认 10，上限 10）"),
    },
  },
  {
    name: "gangtise_constant_category",
    description:
      "查询常量分类列表：返回所有常量分类及每个分类适用于哪些接口的哪些参数（usageScopes）。当前分类：citicIndustry=中信一级行业 | swIndustry=申万一级行业 | gangtiseIndustry=Gangtise行业 | domesticCity=国内城市 | aShareAnnouncementCategory=A股公告分类 | hkShareAnnouncementCategory=港股公告分类 | usShareAnnouncementCategory=美股公告分类 | regionCategory=区域分类。",
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
        .enum([
          "citicIndustry",
          "swIndustry",
          "gangtiseIndustry",
          "domesticCity",
          "aShareAnnouncementCategory",
          "hkShareAnnouncementCategory",
          "usShareAnnouncementCategory",
          "regionCategory",
        ])
        .describe(
          "分类代码（必填）：citicIndustry=中信一级行业 | swIndustry=申万一级行业 | gangtiseIndustry=Gangtise行业 | domesticCity=国内城市 | aShareAnnouncementCategory=A股公告分类 | hkShareAnnouncementCategory=港股公告分类 | usShareAnnouncementCategory=美股公告分类 | regionCategory=区域分类，完整清单见 gangtise_constant_category",
        ),
    },
  },
  {
    name: "gangtise_concept_search",
    description:
      "按关键词搜索题材（概念/主题）ID，支持中文名、简称、拼音首字母（如 jqr）、分组名。返回 conceptId / conceptName / matchScore。该 ID 供 gangtise_concept_info / gangtise_concept_securities 的 conceptId 和 gangtise_theme_tracking 的 themeId 使用（同一套 ID）。",
    endpointKey: "reference.concept-search",
    inputSchema: {
      keyword: z
        .string()
        .trim()
        .min(1, "搜索词不能为空")
        .describe("搜索词：题材中文名/简称、拼音首字母（如 jqr）、分组名（如 灵巧手）"),
      top: z.number().int().min(1).max(10).optional().describe("最大返回条数（默认 10，上限 10）"),
    },
  },
  {
    name: "gangtise_sector_search",
    description:
      "按关键词搜索板块 ID（行业/概念/指数成份等分类树节点），返回 sectorId / sectorName / hierarchy（层级路径）/ matchScore。同名板块可能出现在多个层级，用 hierarchy 区分。sectorId 供 gangtise_sector_constituents 使用，与题材 conceptId 是两套 ID，不通用。",
    endpointKey: "reference.sector-search",
    inputSchema: {
      keyword: z
        .string()
        .optional()
        .describe(
          "搜索词（缺省时返回分类树顶层节点，用于浏览）：板块中文名/简称；拼音首字母仅对概念类板块有效（如 bj=白酒），申万行业/沪深300 等指数类节点请用中文",
        ),
      top: z.number().int().min(1).max(10).optional().describe("最大返回条数（默认 10，上限 10）"),
    },
  },
  {
    name: "gangtise_sector_constituents",
    description:
      "查询板块的全量成分股名单（gtsCode / gtsName）。sectorId 必须来自 gangtise_sector_search；返回 0 条通常是误用了题材 conceptId。题材成分股（含分组/重点标记）用 gangtise_concept_securities。申万行业代码全量列表（821xxx.SWI，共 31 个）：sectorId=2000000014（申万一级行业指数，取「指数数据板块」层级的节点；「指数成份类」层级的同名节点返回 0 条）。",
    endpointKey: "reference.sector-constituents",
    inputSchema: {
      sectorId: z.string().min(1, "sectorId 不能为空").describe("板块 ID，来自 gangtise_sector_search（必填）"),
    },
  },
]

export function registerReferenceTools(server: McpServer, client: GangtiseClient): void {
  server.registerTool(
    "gangtise_securities_search",
    {
      description: "按关键词搜索证券，支持股票名称、代码（如 600519）、拼音或英文名。返回匹配证券及其 GTS 代码。",
      inputSchema: {
        keyword: z.string().trim().min(1, "搜索词不能为空").describe("搜索词：股票名称、代码（如 600519）、拼音或英文名"),
        category: z.array(z.enum(["stock", "dr", "index", "fund"])).optional().describe("按类别筛选：stock=股票 | dr=存托凭证 | index=指数 | fund=基金（不传查所有）"),
        top: z.number().int().min(1).max(10).optional().describe("最大返回条数（默认 10，上限 10）"),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
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
