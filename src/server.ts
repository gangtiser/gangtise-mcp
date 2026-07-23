import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import type { GangtiseClient } from "./core/client.js"
import { DEFAULT_ASYNC_TIMEOUT_MS } from "./core/config.js"
import { dateContextInstruction } from "./core/dateContext.js"
import { getPackageVersion } from "./core/version.js"
import { registerContextTools } from "./tools/context.js"
import { registerLookupTools } from "./tools/lookup.js"
import { registerReferenceTools } from "./tools/reference.js"
import { registerInsightTools } from "./tools/insight.js"
import { registerQuoteTools } from "./tools/quote.js"
import { registerFundamentalTools } from "./tools/fundamental.js"
import { registerAiTools } from "./tools/ai.js"
import { registerVaultTools } from "./tools/vault.js"
import { registerAlternativeTools } from "./tools/alternative.js"
import { registerIndicatorTools } from "./tools/indicator.js"
import { registerResponseTools } from "./tools/response.js"

/**
 * 路由总则。分层原则：这里只放「哪类问题找哪族工具」，端点级细节（具体参数取值、
 * ID 来源、单端点的坑）一律留在工具描述里 —— 1,800B 预算装不下那些细节，
 * 描述也不该承担跨工具路由。
 * 预算：dateContextInstruction() 168B + 本常量 1,625B = 1,793B ≤ 1,800B（余 7B）。
 * 改动前先量字节，别手推。
 */
const ROUTING_INSTRUCTIONS = `日期 YYYY-MM-DD；时间 YYYY-MM-DD HH:mm:ss。取数窗口随账号权限变化，MCP 不硬编码拦截。
遇 _truncated:true：同机可读本地文件时按 _local_hint，否则用 gangtise_read_response；宽表优先传 fields。
代码带后缀 .SH/.SZ/.BJ=A股 .HK=港股 .O/.N/.A=美股；只知名称先 gangtise_securities_search。ID/List 按描述指定的 search/constant 工具解析，勿猜编码。
①行情/财务：日K与三表按市场用 _hk/_us；realtime 单工具覆盖三市场；分钟K/指数K/资金流仅 A 股。单票财务/估值/盈利预测/股东/主营用专用工具；多证券财务/估值指标优先 indicator_*(EDE) 截面/时序，长尾同；宏观行业 edb_*。
②内容：研报/观点/纪要/公告/公众号/问答 qa_list/研报图表 report_image 用对应 *_list；跨类语义检索用 knowledge_batch；roadshow/site_visit/strategy/forum 只查日程、正文用 summary_list。研报与独立观点有专用下载工具，机构观点无（见其描述）。
③AI(除注明外均取预生成内容)：stock_summary/security_clue_list/hot_topic/one_pager/investment_logic/peer_comparison/research_outline/theme_tracking/management_discuss_*；仅 earnings_review/viewpoint_debate 为异步提交，超时只用 *_check、勿重提。
④其他：drive_*/record_*/my_conference_*/wechat_* 查云盘/录音/会议/群消息；stock_pool_* 查股票池；名称与 ID 解析用 *_search/concept_*/sector_*/constant_*/lookup。
计费见各工具【积分】标签，未标注即免费；除①批量外，优先免费/低价，慎用全市场/超大 size/fetchAll。`

export interface McpServerOptions {
  asyncTimeoutMs?: number
  version?: string
}

export function createGangtiseMcpServer(
  client: GangtiseClient,
  options: McpServerOptions = {},
): McpServer {
  // Cross-cutting guidance lives here once instead of being repeated in every
  // tool/param description — keeps the tool listing lean for MCP clients.
  const server = new McpServer(
    { name: "gangtise-mcp", version: options.version ?? getPackageVersion() },
    { instructions: dateContextInstruction() + ROUTING_INSTRUCTIONS },
  )
  const asyncTimeoutMs = options.asyncTimeoutMs ?? DEFAULT_ASYNC_TIMEOUT_MS

  registerContextTools(server, client)
  registerLookupTools(server, client)
  registerReferenceTools(server, client)
  registerInsightTools(server, client)
  registerQuoteTools(server, client)
  registerFundamentalTools(server, client)
  registerAiTools(server, client, { asyncTimeoutMs })
  registerVaultTools(server, client)
  registerAlternativeTools(server, client)
  registerIndicatorTools(server, client)
  registerResponseTools(server, client)

  return server
}
