import type { ToolExamples } from "../mcp/contract.examples.js"

export const referenceExamples: ToolExamples = {
  gangtise_chiefs_search: [
    { title: "按姓名", args: { keyword: "张三", top: 3 }, expect: { requests: [{ method: "POST", path: "/application/open-reference/chiefs/search", body: { keyword: "张三", top: 3 } }] } },
  ],
  gangtise_institution_search: [
    { title: "按类别", args: { keyword: "中金", categoryList: ["leadInstitution"] }, expect: { requests: [{ method: "POST", path: "/application/open-reference/institutions/search", body: { keyword: "中金", categoryList: ["leadInstitution"] } }] } },
  ],
  gangtise_official_account_search: [
    { title: "按分类", args: { keyword: "中信证券", category: ["broker"], top: 3 }, expect: { requests: [{ method: "POST", path: "/application/open-reference/officialAccount/search", body: { keyword: "中信证券", category: ["broker"], top: 3 } }] } },
  ],
  gangtise_constant_category: [
    { title: "GET 无参", args: {}, expect: { requests: [{ method: "GET", path: "/application/open-reference/constants/category" }] } },
  ],
  gangtise_constant_list: [
    { title: "闭集内的分类", args: { category: "citicIndustry" }, expect: { requests: [{ method: "POST", path: "/application/open-reference/constants/getList", body: { category: "citicIndustry" } }] } },
    { title: "分类不做本地闭集，新增分类原样下发", args: { category: "fundType" }, expect: { requests: [{ method: "POST", path: "/application/open-reference/constants/getList", body: { category: "fundType" } }] } },
    { title: "空白分类本地拒绝", args: { category: " " }, expect: { rejects: /at category/ } },
  ],
  gangtise_concept_search: [
    { title: "按拼音首字母", args: { keyword: "jqr", top: 5 }, expect: { requests: [{ method: "POST", path: "/application/open-reference/concepts/search", body: { keyword: "jqr", top: 5 } }] } },
  ],
  gangtise_sector_search: [
    { title: "按关键词", args: { keyword: "白酒", top: 3 }, expect: { requests: [{ method: "POST", path: "/application/open-reference/sectors/search", body: { keyword: "白酒", top: 3 } }] } },
    { title: "缺省关键词浏览顶层", args: {}, expect: { requests: [{ method: "POST", path: "/application/open-reference/sectors/search", body: {} }] } },
  ],
  gangtise_sector_constituents: [
    { title: "申万一级行业指数板块", args: { sectorId: "2000000014" }, expect: { requests: [{ method: "POST", path: "/application/open-reference/sectors/constituents", body: { sectorId: "2000000014" } }] } },
  ],
  gangtise_securities_search: [
    { title: "关键词 + 类别", args: { keyword: "贵州茅台", category: ["stock"], top: 5 }, expect: { requests: [{ method: "POST", path: "/application/open-reference/securities/search", body: { keyword: "贵州茅台", category: ["stock"], top: 5 } }] } },
  ],
}
