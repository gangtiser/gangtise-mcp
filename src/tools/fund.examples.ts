import type { ToolExamples } from "../mcp/contract.examples.js"

const P = "/application/open-fundamental/fund"
const H1 = { startDate: "2026-06-30", endDate: "2026-06-30" }

export const fundExamples: ToolExamples = {
  gangtise_fund_basic_info: [
    { title: "多只 + fieldList 原样下发", args: { fundCodeList: ["005827.OF", "510300.SH"], fieldList: ["fundName", "mainFundCode"] }, expect: { requests: [{ method: "POST", path: `${P}/basic-info`, body: { fundCodeList: ["005827.OF", "510300.SH"], fieldList: ["fundName", "mainFundCode"] } }] } },
    { title: "空代码列表在 schema 层拒绝", args: { fundCodeList: [] }, expect: { rejects: /列表不能为空/ } },
    { title: "不收日期", args: { fundCodeList: ["005827.OF"], startDate: "2026-06-30" }, expect: { rejects: /Unrecognized key.*startDate/ } },
  ],
  gangtise_fund_nav: [
    { title: "日期筛交易日", args: { fundCodeList: ["005827.OF"], startDate: "2026-09-14", endDate: "2026-09-26" }, expect: { requests: [{ method: "POST", path: "/application/open-quote/fund/nav", body: { fundCodeList: ["005827.OF"], startDate: "2026-09-14", endDate: "2026-09-26" } }] } },
    { title: "起晚于止本地拒绝", args: { fundCodeList: ["005827.OF"], startDate: "2026-09-26", endDate: "2026-09-14" }, expect: { rejects: /晚于 endDate/ } },
  ],
  gangtise_fund_fee_rate: [
    { title: "按费率类型筛", args: { fundCodeList: ["005827.OF"], feeTypeList: ["managementFee", "custodianFee"] }, expect: { requests: [{ method: "POST", path: `${P}/fee-rate`, body: { fundCodeList: ["005827.OF"], feeTypeList: ["managementFee", "custodianFee"] } }] } },
    { title: "未知费率类型在 schema 层拒绝", args: { fundCodeList: ["005827.OF"], feeTypeList: ["bogusFee"] }, expect: { rejects: /feeTypeList/ } },
  ],
  gangtise_fund_manager_info: [
    { title: "按姓名查", args: { managerNameList: ["张坤"] }, expect: { requests: [{ method: "POST", path: `${P}/manager-info`, body: { managerNameList: ["张坤"] } }] } },
    { title: "不收基金代码", args: { fundCodeList: ["005827.OF"] }, expect: { rejects: /Unrecognized key.*fundCodeList/ } },
  ],
  gangtise_fund_manager_history: [
    { title: "只收代码", args: { fundCodeList: ["005827.OF"] }, expect: { requests: [{ method: "POST", path: `${P}/manager-history`, body: { fundCodeList: ["005827.OF"] } }] } },
  ],
  gangtise_fund_asset_allocation: [
    { title: "只要一级", args: { fundCodeList: ["005827.OF"], ...H1, assetLevelList: ["level1"] }, expect: { requests: [{ method: "POST", path: `${P}/asset-allocation`, body: { fundCodeList: ["005827.OF"], ...H1, assetLevelList: ["level1"] } }] } },
  ],
  gangtise_fund_asset_size: [
    { title: "日期可省", args: { fundCodeList: ["005827.OF"] }, expect: { requests: [{ method: "POST", path: `${P}/asset-size`, body: { fundCodeList: ["005827.OF"] } }] } },
  ],
  gangtise_fund_holder_structure: [
    { title: "日期筛报告期", args: { fundCodeList: ["005827.OF"], startDate: "2025-12-31", endDate: "2026-06-30" }, expect: { requests: [{ method: "POST", path: `${P}/holder-structure`, body: { fundCodeList: ["005827.OF"], startDate: "2025-12-31", endDate: "2026-06-30" } }] } },
  ],
  gangtise_fund_top10_holders: [
    { title: "只传起点", args: { fundCodeList: ["510300.SH"], startDate: "2025-01-01" }, expect: { requests: [{ method: "POST", path: `${P}/top10-holders`, body: { fundCodeList: ["510300.SH"], startDate: "2025-01-01" } }] } },
  ],
  gangtise_fund_stock_portfolio: [
    { title: "全部持股", args: { fundCodeList: ["005827.OF"], ...H1, positionType: "all" }, expect: { requests: [{ method: "POST", path: `${P}/stock-portfolio`, body: { fundCodeList: ["005827.OF"], ...H1, positionType: "all" } }] } },
    { title: "positionType 取值在 schema 层校验", args: { fundCodeList: ["005827.OF"], positionType: "full" }, expect: { rejects: /positionType/ } },
  ],
  gangtise_fund_industry_allocation: [
    { title: "中信一级 + 重仓", args: { fundCodeList: ["005827.OF"], ...H1, industryStandard: "citicIndustry", positionType: "top" }, expect: { requests: [{ method: "POST", path: `${P}/industry-allocation`, body: { fundCodeList: ["005827.OF"], ...H1, industryStandard: "citicIndustry", positionType: "top" } }] } },
  ],
  gangtise_fund_bond_portfolio: [
    { title: "日期筛报告期", args: { fundCodeList: ["000198.OF"], ...H1 }, expect: { requests: [{ method: "POST", path: `${P}/bond-portfolio`, body: { fundCodeList: ["000198.OF"], ...H1 } }] } },
  ],
  gangtise_fund_bond_type_allocation: [
    { title: "日期筛报告期", args: { fundCodeList: ["000198.OF"], ...H1 }, expect: { requests: [{ method: "POST", path: `${P}/bond-type-allocation`, body: { fundCodeList: ["000198.OF"], ...H1 } }] } },
  ],
  gangtise_fund_fund_portfolio: [
    { title: "FOF 持基", args: { fundCodeList: ["005220.OF"], ...H1 }, expect: { requests: [{ method: "POST", path: `${P}/fund-portfolio`, body: { fundCodeList: ["005220.OF"], ...H1 } }] } },
  ],
  gangtise_fund_fund_type_allocation: [
    { title: "没有持仓类型参数", args: { fundCodeList: ["005220.OF"], positionType: "all" }, expect: { rejects: /Unrecognized key.*positionType/ } },
    { title: "日期筛报告期", args: { fundCodeList: ["005220.OF"], ...H1 }, expect: { requests: [{ method: "POST", path: `${P}/fund-type-allocation`, body: { fundCodeList: ["005220.OF"], ...H1 } }] } },
  ],
  gangtise_fund_etf_pcf_header: [
    { title: "只收代码", args: { fundCodeList: ["510300.SH"] }, expect: { requests: [{ method: "POST", path: `${P}/etf-pcf-header`, body: { fundCodeList: ["510300.SH"] } }] } },
  ],
  gangtise_fund_etf_pcf_components: [
    { title: "没有日期参数", args: { fundCodeList: ["510300.SH"], endDate: "2026-09-30" }, expect: { rejects: /Unrecognized key.*endDate/ } },
    { title: "只收代码", args: { fundCodeList: ["510300.SH", "159919.SZ"] }, expect: { requests: [{ method: "POST", path: `${P}/etf-pcf-components`, body: { fundCodeList: ["510300.SH", "159919.SZ"] } }] } },
  ],
  gangtise_fund_etf_share_change: [
    { title: "日期筛交易日", args: { fundCodeList: ["510300.SH"], startDate: "2026-09-01", endDate: "2026-09-30" }, expect: { requests: [{ method: "POST", path: `${P}/etf-share-change`, body: { fundCodeList: ["510300.SH"], startDate: "2026-09-01", endDate: "2026-09-30" } }] } },
  ],
}
