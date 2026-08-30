import { z } from "zod"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js"
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
 * 路由总则。分层原则：这里放两类东西——「哪类问题找哪族工具」，以及**出现在 ≥10 个工具
 * 上的共用参数说明**。只属于单个端点的细节（该端点独有的取值、ID 来源、坑）留在工具描述里。
 *
 * 为什么共用参数归这里：每个工具的 inputSchema 是独立 JSON 文档，客户端不会跨工具解析
 * $ref —— instructions 是 tools/list 里**唯一的跨工具去重通道**。一句话写在 22 个参数
 * 描述上就付 22 遍，写在这里只付一遍。本文件的「通用参数」行 635B，换掉的是 schema 侧
 * 约 12KB 的逐字重复（含 19 处分页计费声明）。
 *
 * 所以预算不是「越小越好」，是**看杠杆**：一句话进来的成本 = 它的字节数，省下的 =
 * 字节数 × (出现次数 - 1)。低于 10 次的别往里搬，locality 更值钱。
 *
 * 预算：dateContextInstruction() 168B + 本常量 2,304B = 2,472B，上限 2,500B。
 * ⚠️ **只剩 28B 余量**——下一次往这里加东西基本一定要先从别处腾。腾不出来再抬上限，
 * 并在 commit 里说明换掉了 schema 侧多少字节；别为了塞进去而把上限悄悄调大。
 * 改动前先量字节，别手推；这两个数由 scripts/prerelease-check.mjs 的 ⑤ 一节钉住，
 * 改了忘同步注释不会报错，所以量完顺手把上面两个数字一起改掉。
 */
const ROUTING_INSTRUCTIONS = `以下为全局默认，**工具/参数自带描述时以其为准**。*Date=YYYY-MM-DD，*Time=YYYY-MM-DD HH:mm:ss。取数窗口随账号权限变化，不做本地拦截。
遇 _truncated:true：同机可读本地文件时按 _local_hint，否则用 gangtise_read_response；宽表优先传 fields。
代码带后缀 .SH/.SZ/.BJ=A股 .HK=港股 .O/.N/.A=美股；只知名称先 gangtise_securities_search。ID/List 按描述指定的 search/constant 工具解析，勿猜编码。
通用参数（工具描述不再重复，是否数组见 schema 的 type）：from=0-based 偏移(默认0)；size=总行数上限(默认20)；fetchAll=true 拉全部页并忽略 size（慢、响应大）；**付费列表按实际返回条目计费**——size/fetchAll 调大即等比放大费用；rankType=1 综合排序(默认，有 keyword 时取相关度子集，可能不含最新)/2 时间倒序——两档返回都按时间倒序**排列**，看不出本参数是否生效，要「最新 N 条」必须显式传 2；reportType(三表口径,数组)=consolidated 合并/standalone 母公司，带 Restated 后缀为调整后。
①行情/财务：日K/realtime 各一个工具覆盖三市场+指数；三表按市场用 _hk/_us；分钟K/资金流仅 A 股。单票财务/估值/盈利预测/股东/主营用专用工具；多证券财务/估值指标优先 indicator_*(EDE) 截面/时序，长尾同；宏观行业 edb_*。
②内容：研报/观点/纪要/公告/公众号/问答 qa_list/研报图表 report_image 用对应 *_list；跨类语义检索用 knowledge_batch；roadshow/site_visit/strategy/forum 只查日程、正文用 summary_list。研报与独立观点有专用下载工具，机构观点无（见其描述）。
③AI：除 earnings_review/viewpoint_debate 外均取平台已生成的内容，直接调即可；这两个是异步提交，超时只用对应 *_check 续查、勿重提（重提再计费）。
④其他：drive_*/record_*/my_conference_*/wechat_* 查云盘/录音/会议/群消息；stock_pool_* 查股票池；名称与 ID 解析用 *_search/concept_*/sector_*/constant_*/lookup。
计费见各工具【积分】标签，未标注即免费（最终以账户权限与平台计费规则为准）；除①批量外，优先免费/低价，慎用全市场/超大 size/fetchAll。`


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

/** SDK 生成 JSON Schema 时无条件写入 `"$schema":"http://json-schema.org/draft-07/schema#"`
 * —— 每个工具 47B，97 个工具 5,044B，占 tools/list 的 3.5%，而这段字节原样进客户模型的
 * 上下文。`$schema` 在 JSON Schema 里本就是可选的，MCP 也不要求：客户端按 `type:"object"`
 * 读 properties，没有谁会因为缺了方言声明而改变解析行为。
 *
/** 把 `$ref` 就地展开成它指向的子 schema。
 *
 * 🔴 为什么必须展开：`zod-to-json-schema` 按 **Zod 实例同一性**去重 —— `schemas.ts` 的
 * `nonEmptyString` 是个共享单例，于是同一个工具里第二次及以后用到它的参数，全都被折成
 * 指向「它第一次出现的位置」的指针。指针的落点由属性声明顺序决定，语义上完全不相干：
 *
 *   indicator_screener.securityCodeList.items
 *     → #/properties/indicatorList/items/properties/parameters/items/properties/paramKey
 *   day_kline.security.anyOf[0]  → #/properties/fieldList/items
 *   49 个 xxxList.items          → #/properties/keyword
 *
 * 会解引用的客户端拿到的东西是对的。但很多客户端是把 inputSchema 原样序列化进模型上下文
 * 的 —— 那模型读到的就是「证券代码 = 指标参数键」「证券代码 = 关键词」。而且这些指针几乎
 * 不省字节：`{"$ref":"#/properties/keyword"}` 30B，展开后 `{"type":"string","minLength":1}`
 * 31B。115 个指针净省 3.1KB，换来的是一份**依赖客户端解引用能力**的对外契约。
 *
 * 展开后每个 inputSchema 都是自包含的普通 JSON Schema，不再对客户端提任何要求。
 *
 * 循环引用会展开成无限深 —— 本仓的 schema 里没有（全是叶子级字符串复用），但仍设深度上
 * 限兜底：超深就把该 `$ref` 原样留下，退回今天的行为而不是把进程转死。 */
function inlineRefs(schema: Record<string, unknown>): void {
  const resolve = (ptr: string): unknown => {
    if (!ptr.startsWith("#/")) return undefined
    let cur: unknown = schema
    for (const part of ptr.slice(2).split("/")) {
      if (cur === null || typeof cur !== "object") return undefined
      cur = (cur as Record<string, unknown>)[part]
    }
    return cur
  }
  const walk = (node: unknown, depth: number): unknown => {
    if (node === null || typeof node !== "object") return node
    if (Array.isArray(node)) return node.map((x) => walk(x, depth))
    const obj = node as Record<string, unknown>
    if (typeof obj.$ref === "string" && depth < 8) {
      const target = resolve(obj.$ref)
      if (target !== undefined) {
        // 同级的兄弟键（如 description）优先于被引用的内容 —— JSON Schema 2019-09 起
        // $ref 旁边允许有别的关键字，且它们不该被展开结果盖掉。
        const { $ref: _dropped, ...siblings } = obj
        return { ...(walk(target, depth + 1) as Record<string, unknown>), ...siblings }
      }
    }
    for (const [k, v] of Object.entries(obj)) obj[k] = walk(v, depth)
    return obj
  }
  walk(schema, 0)
}

/** tools/list 出站时对每个 `inputSchema` 做两件事：摘掉 `$schema` 方言声明、展开 `$ref`。
 *
 * 为什么拦在 `transport.send`：schema 是响应 tools/list 时才生成的，注册期够不着，SDK 也
 * 没有开关。剩下的入口里 `Protocol._requestHandlers` 是私有字段（改名即启动崩），而
 * `Transport.send` 是公开接口的一部分。失败模式也温和：将来 SDK 若换了消息形状，这里
 * 只是**不再生效** —— 字节涨回来、`$ref` 回来，行为不变，由 scripts/prerelease-check.mjs 的
 * ⑤ 一节钉住（字节预算 + `$schema` 残留 + `$ref` 残留三项都会红）。
 *
 * 只认 tools/list 的响应形状（`result.tools[]`），其余消息原样透传。 */
function normalizePublishedSchemas(server: McpServer): McpServer {
  const connect = server.connect.bind(server)
  server.connect = async (transport: Transport) => {
    const send = transport.send.bind(transport)
    transport.send = (message, options) => {
      const tools = (message as { result?: { tools?: { inputSchema?: Record<string, unknown> }[] } }).result?.tools
      if (Array.isArray(tools)) {
        for (const tool of tools) {
          if (!tool.inputSchema) continue
          delete tool.inputSchema.$schema
          inlineRefs(tool.inputSchema)
        }
      }
      return send(message, options)
    }
    return connect(transport)
  }
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
  normalizePublishedSchemas(server)
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
