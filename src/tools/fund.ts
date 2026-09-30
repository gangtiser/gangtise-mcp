import { z } from "zod"
import { dateString } from "../core/dateContext.js"
import { defineJsonTool, type FamilyModule, type JsonToolSpec, type ZodShape } from "../mcp/define.js"
import { enumList, nonEmptyList, uniqueFieldList } from "../mcp/schemas.js"
import { fundEndpoints } from "./fund.endpoints.js"

// 代码格式、查不到时返回空、按次计费、行数上限与日期区间的规则在 routingHint 里说一遍（本族每个工具都适用）；
// 这里只写各工具自己的：单位，以及会让数据用错的字段口径。

const codes = nonEmptyList().describe("基金代码")
const range: ZodShape = { startDate: dateString.optional(), endDate: dateString.optional() }
const positionType = z.enum(["top", "all"]).optional().describe("top=重仓（各季度都披露，默认）| all=全部持仓（仅中报、年报，季报期为空）")
/** 零行的真因与股票工具不同，通用提示里的股票代码示例会把排查引错方向；各工具的零行原因也不同（有无日期、
 *  有无 positionType、按姓名查），按工具给。 */
const CODE_EMPTY = "0 行结果：基金代码查不到时返回空、不报错——场外用 .OF、场内用 .SH / .SZ，后缀大写，别传股票代码"
const emptyHint = (spec: JsonToolSpec): string => {
  if (spec.name === "gangtise_fund_manager_info") return "0 行结果：按姓名精确匹配，查不到返回空、不报错——核对姓名用字。"
  if (spec.name.startsWith("gangtise_fund_etf_pcf_")) return "0 行结果：代码查不到时返回空、不报错——申赎清单只有 ETF 有，用场内代码（.SH / .SZ），后缀大写。"
  const shape = spec.inputSchema
  if (!("startDate" in shape)) return `${CODE_EMPTY}。`
  return `${CODE_EMPTY}；也可能是区间内没有报告期或交易日${"positionType" in shape ? "，或 positionType=all 查了季报期（全部持仓只在中报、年报披露）" : ""}。`
}

/** 按基金代码查；`dated` 的带报告期 / 交易日区间。 */
const byCode = (name: string, tier: JsonToolSpec["tier"], endpointKey: string, description: string, extra: ZodShape = {}, dated = true): JsonToolSpec => ({
  name,
  tier,
  endpointKey,
  description,
  inputSchema: { fundCodeList: codes, ...(dated ? range : {}), ...extra },
})

const specs: JsonToolSpec[] = [
  byCode(
    "gangtise_fund_basic_info",
    "core",
    "fund.basic-info",
    "查询公募基金基本资料（当前资料，无历史快照）：一二级分类、管理人与托管人、成立与存续、运作方式、申赎规则、业绩基准、风险等级、投资范围、跟踪指数。A / C 等份额各有代码，合并成一只基金按 mainFundCode 分组；investTypeCodeLevel1/2 与 gangtise_constant_list 的 fundType 常量一致，层级按常量的 level 判、别按 ID 尾数猜；场外基金 exchange 为 null；investScope 是长文本，批量查时用 fieldList 去掉。",
    { fieldList: uniqueFieldList("指定返回字段，省略返回全部；fundCode 恒返回，写错名整批报 100003") },
    false,
  ),
  byCode(
    "gangtise_fund_nav",
    "core",
    "fund.nav",
    "查询基金逐交易日净值（按日期倒序）：单位净值 navUnit、累计净值 navAccumulated、复权因子 adjustFactor 与复权净值 navAdjusted（元）。算区间收益用 navAdjusted——单位净值在分红、拆分时跳变。货币基金另有 mmfAnnualizedYield（7 日年化，%）与 mmfUnitYield（每万份收益，元），其 adjustFactor 为 null。多只 × 长区间容易撞 10000 行上限（每只每年约 250 行），按只数分批。",
  ),
  byCode(
    "gangtise_fund_fee_rate",
    "extended",
    "fund.fee-rate",
    "查询基金当前费率。按金额或持有期分档时每档一行，feeCondition 是条件区间（无分档为 null）。⚠️ feeRate 是字符串（\"1.5%\"），大额固定收费时是金额描述（\"每笔1000元\"），不能直接当数字用。",
    { feeTypeList: enumList(z.enum(["purchaseFee", "redemptionFee", "managementFee", "custodianFee", "saleFee"])).optional().describe("purchaseFee=申购 | redemptionFee=赎回 | managementFee=管理 | custodianFee=托管 | saleFee=销售服务，省略返回全部") },
    false,
  ),
  {
    name: "gangtise_fund_manager_info",
    tier: "core",
    endpointKey: "fund.manager-info",
    description: "按姓名查询基金经理：学历、从业起始日与年限、在管规模（亿元）与只数、历任基金数与公司数、简介。精确匹配，查不到返回空；同名经理全部返回，用 currentCompany 区分（可能为 null）。workingYears / currentCompanyYears 可能与 careerStartDate、简介里的从业年数对不上，需要准确的从业年限时按 careerStartDate 计算。",
    inputSchema: { managerNameList: nonEmptyList().describe("基金经理姓名") },
  },
  byCode(
    "gangtise_fund_manager_history",
    "core",
    "fund.manager-history",
    "查询基金的历任与现任基金经理：每位经理每段任职一行，同期共管各占一行；endDate 为 null 的是现任。managedDays 任职天数，managedReturn 任职期间回报（%）。",
    {},
    false,
  ),
  byCode(
    "gangtise_fund_asset_allocation",
    "core",
    "fund.asset-allocation",
    "查询基金各报告期资产配置（报告期末基金资产组合）：按资产类型多行，assetType + assetTypeName、holdingValue（元）、pctToTotalAsset（占基金资产总值，不是占净值）。二级是一级的拆分，两级混在一起时别直接加总；没有持有的资产类型可能不出行，按 0 处理。",
    { assetLevelList: enumList(z.enum(["level1", "level2"])).optional().describe("level1=一级 | level2=二级，省略两级都返回") },
  ),
  byCode(
    "gangtise_fund_asset_size",
    "extended",
    "fund.asset-size",
    "查询基金各报告期的份额与规模：期初份额、申购 / 赎回 / 净申购份额（赎回多于申购时为负）、期末份额（万份），资产净值 netAsset（万元）。",
  ),
  byCode(
    "gangtise_fund_holder_structure",
    "extended",
    "fund.holder-structure",
    "查询基金持有人结构（只有中报、年报披露）：持有人户数、户均份额，机构 / 个人 / 员工持有份额（份）与占比（%，可能为 null）。⚠️ holderCount 是带千分位逗号的字符串（\"2,219,140\"），计算或排序前先去掉逗号转数字，否则按字符串比较会排错。",
  ),
  byCode(
    "gangtise_fund_top10_holders",
    "extended",
    "fund.top10-holders",
    "查询上市基金（LOF / ETF）的前十大持有人（中报、年报披露）：serialNumber 名次、持有人、持有份额（份）与占上市总份额比（%）。ETF 可能多一行 serialNumber=11，是它的联接基金，只要前十名按 serialNumber ≤ 10 过滤。最新一期可能晚于其他持仓类工具更新：按最新报告期查不到时先不带日期查一次，看已有哪些报告期。",
  ),
  byCode(
    "gangtise_fund_stock_portfolio",
    "core",
    "fund.stock-portfolio",
    "查询基金各报告期的股票持仓：持股数（万股）、占流通股比、持仓市值（万元）、占净值比与较上期变化 pctToNavChg。⚠️ 只返回股票简称 stockName、没有代码：要代码用 gangtise_securities_search 按简称换，注意 A / H 同名与改名。",
    { positionType },
  ),
  byCode(
    "gangtise_fund_industry_allocation",
    "core",
    "fund.industry-allocation",
    "查询基金股票持仓的一级行业分布（占净值比）。industryCode 与 gangtise_constant_list 的 swIndustry / citicIndustry 常量一致；两套划分不同，跨基金比较时统一用一套。占比为 0 的行业也可能出现。",
    { industryStandard: z.enum(["swIndustry", "citicIndustry"]).optional().describe("swIndustry=申万一级（默认）| citicIndustry=中信一级"), positionType },
  ),
  byCode(
    "gangtise_fund_bond_portfolio",
    "extended",
    "fund.bond-portfolio",
    "查询基金各报告期的债券持仓：债券简称 bondName（没有代码）、持仓量（万张）、持仓市值（万元）、占净值比。",
  ),
  byCode(
    "gangtise_fund_bond_type_allocation",
    "extended",
    "fund.bond-type-allocation",
    "查询基金债券持仓按券种的分布（占净值比），bondTypeCode 与 gangtise_constant_list 的 fundBondType 常量一致。⚠️ 金融债券包含政策性金融债券（两行都出），按券种加总会重复计算。",
  ),
  byCode(
    "gangtise_fund_fund_portfolio",
    "extended",
    "fund.fund-portfolio",
    "查询 FOF 持有的基金：持仓基金简称 holdingFundName（没有代码）、持仓市值（万元）、占净值比。",
  ),
  byCode(
    "gangtise_fund_fund_type_allocation",
    "extended",
    "fund.fund-type-allocation",
    "查询 FOF 持仓按基金一级分类的分布（占净值比），investTypeCodeLevel1 与 fundType 常量一致。没有持仓类型参数，口径随报告期：季报期只含重仓基金（positionType=top），中报、年报为全部持基（all）——同一只基金不同报告期的合计口径不同，做时序对比前先按 positionType 分开。",
  ),
  byCode(
    "gangtise_fund_etf_pcf_header",
    "extended",
    "fund.etf-pcf-header",
    "查询 ETF 最新一份申购赎回清单的参数（没有日期参数，查不了历史清单）：申赎状态、最小申赎单位（份）及其净值（元）、单日申购 / 赎回上限（份，无上限为 null）、现金差额与预估现金（元，可为负）、现金替代比例上限（%）、成分数。",
    {},
    false,
  ),
  byCode(
    "gangtise_fund_etf_pcf_components",
    "extended",
    "fund.etf-pcf-components",
    "查询 ETF 最新一份申购赎回清单的成分（没有日期参数，查不了历史清单）：每个成分一行，含收盘价、涨跌幅、权重（%）、申购数量（股）、现金替代标志（允许 / 必须）与溢价比例、替代金额（元）。componentCode 不带市场后缀（600519），接着查行情先补后缀。宽基 ETF 数百行，多只一起查注意 10000 行上限。",
    {},
    false,
  ),
  byCode(
    "gangtise_fund_etf_share_change",
    "extended",
    "fund.etf-share-change",
    "查询 ETF 逐交易日的份额（万份）与规模（万元）及较上期变动，sharesChangeRate 为份额变化率（%），按日期倒序。",
  ),
]

export const fundFamily: FamilyModule = {
  name: "fund",
  routingHint:
    "基金：fund_*（资金流向除外）收带大写后缀的基金代码（场外 005827.OF，场内 510300.SH / 159967.SZ；经理信息按姓名查）；场内基金可用 gangtise_securities_search（category=fund）按简称换代码，场外的搜不到。代码查不到返回空、不报错。按次计费，多只合并成一次查；结果按 fundCode 对应。不分页，超过 10000 行整批报 100006。日期筛报告期（净值与 ETF 份额筛交易日），两端都省略取账号可回溯窗口内全部，而非最新一期。",
  endpoints: fundEndpoints,
  tools: specs.map((spec) => defineJsonTool({ ...spec, emptyHint: emptyHint(spec) })),
}
