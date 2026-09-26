import { z } from "zod"
import { normalizeRows } from "../core/normalize.js"
import { defineJsonTool, defineTool, type FamilyModule, type JsonToolSpec } from "../mcp/define.js"
import { buildToolContent } from "../core/present.js"
import { contentResult } from "../mcp/handler.js"
import { nonEmptyString, enumList } from "../mcp/schemas.js"
import { referenceEndpoints } from "./reference.endpoints.js"

export const referenceSpecs: JsonToolSpec[] = [
  {
    name: "gangtise_chiefs_search",
    tier: "core",
    description:
      "按姓名 / 机构 / 团队搜索首席分析师 ID，返回 chiefId 等。该 ID 供 gangtise_opinion_list 的 chiefList 使用。",
    endpointKey: "reference.chiefs-search",
    inputSchema: {
      keyword: z.string().trim().min(1, "搜索词不能为空").describe("搜索词：首席姓名、机构或团队名"),
      top: z.number().int().min(1).max(10).optional().describe("最大返回条数（默认 10，上限 10）"),
    },
    examples: [
      { title: "按姓名", args: { keyword: "张三", top: 3 }, expect: { requests: [{ method: "POST", path: "/application/open-reference/chiefs/search", body: { keyword: "张三", top: 3 } }] } },
    ],
  },
  {
    name: "gangtise_institution_search",
    tier: "core",
    description:
      "按机构名称 / 简称搜索机构 ID，返回 institutionId 及 usageScopes（标明该 ID 用于哪个接口的哪个参数）。覆盖内资券商 / 外资 / 牵头 / 观点机构，供各 list 工具的 institutionList / brokerList 等参数使用。提示：内资券商（domesticBroker）与外资机构（foreignInstitution）类需用较完整的机构名（如「华泰证券」「Goldman」「Morgan」），简称可能搜不到；牵头 / 观点类（leadInstitution / opinionInstitution / foreignOpinionInstitution）可用简称（如「中金」「高盛」）。",
    endpointKey: "reference.institution-search",
    inputSchema: {
      keyword: z.string().trim().min(1, "搜索词不能为空").describe("搜索词：机构名称或简称"),
      categoryList: enumList(
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
    examples: [
      { title: "按类别", args: { keyword: "中金", categoryList: ["leadInstitution"] }, expect: { requests: [{ method: "POST", path: "/application/open-reference/institutions/search", body: { keyword: "中金", categoryList: ["leadInstitution"] } }] } },
    ],
  },
  {
    name: "gangtise_official_account_search",
    tier: "core",
    description:
      "搜索公众号 ID：输入公众号名称/所属机构/关键字，返回 accountId（供 gangtise_official_account_list 的 accountIdList 使用）及 matchScore。注意：部分公众号不属任何分类（category 为 null），传 category 过滤会漏掉这些账号，要全量就不传 category。",
    endpointKey: "reference.official-account-search",
    inputSchema: {
      keyword: z.string().trim().min(1, "搜索词不能为空").describe("公众号名称/所属机构/关键字，如 '中信证券' '人民日报'"),
      category: enumList(z.enum(["listedCompany", "broker", "government", "media"]))
        .optional()
        .describe("分类过滤（可多选）：listedCompany=上市公司 | broker=券商团队 | government=政府官方 | media=媒体；不传=全部（含未分类）"),
      top: z.number().int().min(1).max(10).optional().describe("最大返回条数（默认 10，上限 10），按 matchScore 降序"),
    },
    examples: [
      { title: "按分类", args: { keyword: "中信证券", category: ["broker"], top: 3 }, expect: { requests: [{ method: "POST", path: "/application/open-reference/officialAccount/search", body: { keyword: "中信证券", category: ["broker"], top: 3 } }] } },
    ],
  },
  {
    name: "gangtise_constant_category",
    tier: "core",
    description:
      "查询常量分类列表：返回全部分类代码与名称，及每个分类适用于哪些接口的哪些参数（usageScopes）。",
    endpointKey: "reference.constant-category",
    inputSchema: {},
    examples: [
      { title: "GET 无参", args: {}, expect: { requests: [{ method: "GET", path: "/application/open-reference/constants/category" }] } },
    ],
  },
  {
    name: "gangtise_constant_list",
    tier: "core",
    description:
      "查询某个常量分类下的全部常量值（constantId / constantName / level），树形分类（公告分类）的父节点含 children 嵌套。行业、城市、公告类别、区域等筛选参数的 ID 都从这里查。",
    endpointKey: "reference.constant-list",
    inputSchema: {
      // 不做本地闭集：服务端新增分类不该要发版才能查。非法取值服务端报 100005，不会静默返回别的分类。
      category: nonEmptyString.describe(
        "分类代码，以 gangtise_constant_category 返回为准。已知：citicIndustry=中信一级行业 | swIndustry=申万一级行业 | gangtiseIndustry=Gangtise行业 | domesticCity=国内城市 | aShareAnnouncementCategory / hkShareAnnouncementCategory / usShareAnnouncementCategory=A股 / 港股 / 美股公告分类 | regionCategory=区域 | nationalEconomicIndustry=国民经济行业 | bondType=债券类型 | interestRateType=利率类型 | interestFrequency=付息频率 | absUnderlyingAssetType=ABS基础资产类型 | ratingType=评级类型 | exchange=交易市场 | fundType=基金分类 | fundBondType=基金持仓券种类别",
      ),
    },
    examples: [
      { title: "闭集内的分类", args: { category: "citicIndustry" }, expect: { requests: [{ method: "POST", path: "/application/open-reference/constants/getList", body: { category: "citicIndustry" } }] } },
      { title: "分类不做本地闭集，新增分类原样下发", args: { category: "fundType" }, expect: { requests: [{ method: "POST", path: "/application/open-reference/constants/getList", body: { category: "fundType" } }] } },
      { title: "空白分类本地拒绝", args: { category: " " }, expect: { rejects: /at category/ } },
    ],
  },
  {
    name: "gangtise_concept_search",
    tier: "core",
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
    examples: [
      { title: "按拼音首字母", args: { keyword: "jqr", top: 5 }, expect: { requests: [{ method: "POST", path: "/application/open-reference/concepts/search", body: { keyword: "jqr", top: 5 } }] } },
    ],
  },
  {
    name: "gangtise_sector_search",
    tier: "core",
    description:
      "按关键词搜索板块 ID（行业/概念/指数成份等分类树节点），返回 sectorId / sectorName / hierarchy（层级路径）/ matchScore。同名板块可能出现在多个层级，用 hierarchy 区分。sectorId 供 gangtise_sector_constituents 使用，与题材 conceptId 是两套 ID，不通用。",
    endpointKey: "reference.sector-search",
    inputSchema: {
      keyword: nonEmptyString
        .optional()
        .describe(
          "搜索词（缺省时返回分类树顶层节点，用于浏览）：板块中文名/简称；拼音首字母仅对概念类板块有效（如 bj=白酒），申万行业/沪深300 等指数类节点请用中文",
        ),
      top: z.number().int().min(1).max(10).optional().describe("最大返回条数（默认 10，上限 10）"),
    },
    examples: [
      { title: "按关键词", args: { keyword: "白酒", top: 3 }, expect: { requests: [{ method: "POST", path: "/application/open-reference/sectors/search", body: { keyword: "白酒", top: 3 } }] } },
      { title: "缺省关键词浏览顶层", args: {}, expect: { requests: [{ method: "POST", path: "/application/open-reference/sectors/search", body: {} }] } },
    ],
  },
  {
    name: "gangtise_sector_constituents",
    tier: "core",
    description:
      "查询板块的全量成分股名单（gtsCode / gtsName）。sectorId 必须来自 gangtise_sector_search；返回 0 条通常是误用了题材 conceptId。题材成分股（含分组/重点标记）用 gangtise_concept_securities。申万行业代码全量列表（801xxx.SWI，共 31 个）：sectorId=2000000014（申万一级行业指数，取「指数数据板块」层级的节点；「指数成份类」层级的同名节点返回 0 条）。",
    endpointKey: "reference.sector-constituents",
    inputSchema: {
      sectorId: nonEmptyString.describe("板块 ID，来自 gangtise_sector_search（必填）"),
    },
    examples: [
      { title: "申万一级行业指数板块", args: { sectorId: "2000000014" }, expect: { requests: [{ method: "POST", path: "/application/open-reference/sectors/constituents", body: { sectorId: "2000000014" } }] } },
    ],
  },
]

export const referenceFamily: FamilyModule = {
  name: "reference",
  endpoints: referenceEndpoints,
  tools: [
    defineTool({
      name: "gangtise_securities_search",
      tier: "core",
      access: "read",
      endpoint: "reference.securities-search",
      description: "按关键词搜索证券，支持股票名称、代码（如 600519）、拼音或英文名。返回匹配证券及其 GTS 代码。",
      input: {
        keyword: z.string().trim().min(1, "搜索词不能为空").describe("搜索词：股票名称、代码（如 600519）、拼音或英文名"),
        category: enumList(z.enum(["stock", "dr", "index", "fund"])).optional().describe("按类别筛选：stock=股票 | dr=存托凭证 | index=指数 | fund=基金（不传查所有）"),
        top: z.number().int().min(1).max(10).optional().describe("最大返回条数（默认 10，上限 10）"),
      },
      run: async ({ client }, args) => {
        const result = await client.call("reference.securities-search", args)
        return contentResult(await buildToolContent(normalizeRows(result)))
      },
      examples: [
        { title: "关键词 + 类别", args: { keyword: "贵州茅台", category: ["stock"], top: 5 }, expect: { requests: [{ method: "POST", path: "/application/open-reference/securities/search", body: { keyword: "贵州茅台", category: ["stock"], top: 5 } }] } },
      ],
    }),
    ...referenceSpecs.map(defineJsonTool),
  ],
}
