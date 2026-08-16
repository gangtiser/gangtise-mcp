import { z } from "zod"
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
①行情/财务：日K/realtime 各一个工具覆盖三市场+指数；三表按市场用 _hk/_us；分钟K/资金流仅 A 股。单票财务/估值/盈利预测/股东/主营用专用工具；多证券财务/估值指标优先 indicator_*(EDE) 截面/时序，长尾同；宏观行业 edb_*。
②内容：研报/观点/纪要/公告/公众号/问答 qa_list/研报图表 report_image 用对应 *_list；跨类语义检索用 knowledge_batch；roadshow/site_visit/strategy/forum 只查日程、正文用 summary_list。研报与独立观点有专用下载工具，机构观点无（见其描述）。
③AI(除注明外均取预生成内容)：stock_summary/security_clue_list/hot_topic/one_pager/investment_logic/peer_comparison/research_outline/theme_tracking/management_discuss_*；仅 earnings_review/viewpoint_debate 为异步提交，超时只用 *_check、勿重提。
④其他：drive_*/record_*/my_conference_*/wechat_* 查云盘/录音/会议/群消息；stock_pool_* 查股票池；名称与 ID 解析用 *_search/concept_*/sector_*/constant_*/lookup。
计费见各工具【积分】标签，未标注即免费；除①批量外，优先免费/低价，慎用全市场/超大 size/fetchAll。`


/** 把每个工具的 raw-shape `inputSchema` 收成 **strict** ZodObject：未声明的键**报错**，
 * 而不是被静默剥掉。
 *
 * 为什么必须有：SDK 用这个 schema 解析入参，非 strict 时未知键在进 handler 之前就被
 * strip 掉，于是「传了个没人认识的参数」变成一次**没有该筛选条件的正常调用**——
 * `isError=false`、按条计费、返回全量。而我们发布的 JSON Schema 写的是
 * `additionalProperties: false`，契约声明拒绝、行为却静默接受，两者矛盾。
 *
 * 不是假想：财报日历的日期入参在 2026-08-08 从 `startTime`/`endTime` 改成
 * `startDate`/`endDate`（服务端换了它接受的字段名），沿用旧名的调用方因此静默拿到
 * 12.8 万行全库切片而不是一周排期。
 *
 * 为什么拦在 server 层而不是逐个注册点改：直接 `server.registerTool` 的调用点有 27 个
 * 分散在 12 个文件里，漏一个就是一个静默剥参的工具，且将来新增工具还会再漏。这里拦
 * 一次，全部覆盖并自动继承。
 *
 * 幂等：已经是 Zod schema 的（`registerJsonTool` / `registerDownloadTool` 自己包过）
 * 原样放行，不会二次包裹。
 *
 * `registerTool` 的 `inputSchema` 接受 `ZodRawShapeCompat | AnySchema`（1.29.0 起就
 * 是这个签名，核对过 1.29.0 的类型定义——**升级到 1.30 是为了修 audit 漏洞，不是为了
 * 这个能力**）。对 tools/list 的 schema 表面无影响：strict 只改解析行为，不加字段。 */
function enforceStrictInput(server: McpServer): McpServer {
  const original = server.registerTool.bind(server) as (...args: unknown[]) => unknown
  // 用 rest 参数并只重写 args[1]，不写死 arity：当前 SDK 是 3 参签名，但将来加重载
  // 或补参数时，写死 (name, config, cb) 会把多出来的参数悄悄吃掉。
  const patched = (...args: unknown[]) => {
    const cfg = args[1] as { inputSchema?: unknown } | undefined
    const shape = cfg?.inputSchema
    const isRawShape =
      shape !== null && typeof shape === "object" && !("_def" in (shape as object)) && !("parse" in (shape as object))
    if (isRawShape) args[1] = { ...cfg, inputSchema: z.object(shape as z.ZodRawShape).strict() }
    return original(...args)
  }
  ;(server as unknown as { registerTool: unknown }).registerTool = patched
  return server
}

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
  enforceStrictInput(server)
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
