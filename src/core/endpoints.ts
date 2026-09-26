import { lookupEndpoints } from "../tools/lookup.endpoints.js"
import { insightEndpoints } from "../tools/insight.endpoints.js"
import { referenceEndpoints } from "../tools/reference.endpoints.js"
import { quoteEndpoints } from "../tools/quote.endpoints.js"
import { fundamentalEndpoints } from "../tools/fundamental.endpoints.js"
import { aiEndpoints } from "../tools/ai.endpoints.js"
import { vaultEndpoints } from "../tools/vault.endpoints.js"
import { alternativeEndpoints } from "../tools/alternative.endpoints.js"
import { indicatorEndpoints } from "../tools/indicator.endpoints.js"

/** 公布的单价。它同时是工具描述里积分标签的来源（billing.ts 渲染）与重试守卫的依据
 *  （endpoints.test.ts），所以价格只在端点表里写一次。与重试策略、MCP annotations 解耦：计费高不等于
 *  不可重试，只读也不等于免费。只记单价，不记取数窗口，也不据此做本地拦截。
 *
 *  - `fixed.per`：`call` 每次请求；`page` 每页（提交文档的页数）；`row` 每条返回行（分页列表按每页
 *    实际行数计）；`document` 每个下载文件。`maxUnits`：不分页的端点一次请求最多计多少个单位
 *    （分页端点由页大小封顶）。`unit` 只改标签里的计量词（默认 次 / 页 / 条 / 条）。
 *  - `amplify`：高放大提示，排在标签**之前**、不进标签。分页列表的数字是按默认 size=20 调用一次的
 *    成本示例，**不是上限**（size 无上限、另有 fetchAll），所以写「单次约 N 积分」，绝不写「最多」。
 *  - `local`：本地工具，不打 OpenAPI；只用在工具上，不用在端点上。
 *  - `unknown`：未公布价。未确认 ≠ 免费，标签不显示免费；缺失 `billing` 按它处理。 */
export type Billing =
  | { kind: "free" }
  | { kind: "local" }
  | { kind: "fixed"; per: "call" | "page" | "row" | "document"; price: number; maxUnits?: number; unit?: "篇" | "张" | "指标"; amplify?: string }
  | { kind: "variable"; note: string; amplify?: string }
  | { kind: "downstream"; note: string }
  | { kind: "unknown"; note: string }

/** 分页方式。
 *  - `offset`：from / size / total → 自动翻页、total 探针、跨页去重。`maxWindow` 是偏移窗口：服务端
 *    拒绝 `from + size` 超过它的任何一页（与 total 无关）。页只在窗口内规划，需要窗口外的行时结果标
 *    `window_cut`，`from` 本身越过窗口则本地拒绝。
 *  - `page`：pageNo / pageSize、无 total → 不自动翻页，由调用方按页取。
 *  - `cursor`：预留，尚无端点使用；同样不自动翻页。 */
export type Pagination =
  | { mode: "offset"; maxPageSize: number; maxWindow?: number }
  | { mode: "page"; maxPageSize: number }
  | { mode: "cursor"; cursorField: string }

/** 行主键：单字段、复合字段或取键函数。取不到键（字段缺失或为 null、函数返回 undefined）的行一律保留。 */
export type RowId = string | readonly string[] | ((row: Record<string, unknown>) => string | undefined)

export interface EndpointDefinition {
  key: string
  method: "GET" | "POST"
  path: string
  kind: "json" | "download"
  description: string
  billing?: Billing
  pagination?: Pagination
  /** 分页列表的行主键，供跨页去重与变动检测（见 paginate.ts 的 createRowTracker）。按非唯一键
   *  排序的列表，同一时间点的一组行会在两次翻页请求间换顺序，相邻两页各拿到一部分——行数仍等于
   *  total，却有行重复、有行缺失。没有它就不去重。 */
  rowId?: RowId
  /** `rowId` 只来自接口文档、未在真实响应里确认过是主键：整行重复照样去掉，但「同 ID 异内容」不报
   *  `changed_rows`（一个不唯一的字段只要重复对跨页出现，就会把每次拉取都误标）。 */
  rowIdUnverified?: true
  /** 返回形状声明，在 `requestJson` 仍握有信封（traceId）时校验，不符抛 `ResponseShapeError`。
   *  "list"：成功响应必是 `{…, list: [...]}`；`{total: 0, list: null}` 是合法的零行写法，照常放行。
   *  "array"：成功响应必是裸数组。形状不符不能读成「零行」——那会把一次异常当成正常的空结果。 */
  expects?: "list" | "array"
  /** "double"：`data` 里还包着一层 `{code, status, data}`（EDE），由 shape.ts 的 unwrapPayload 剥掉，
   *  内层失败码照常抛出。缺省为单层信封。 */
  envelope?: "single" | "double"
  /** 以错误码表示「零行」的端点：这些码收成 `{total: 0, list: []}`，不当错误抛出。 */
  emptyCodes?: string[]
  /** "no-replay": never resend a request the server may have executed — set
   * where a transport-level replay re-bills or duplicates a job. This is a
   * REPLAY-SAFETY marker, not a billing-model one: ai.hot-topic carries it and
   * bills per article (i.e. per row), and insight.pamirs-summary.download
   * publishes no price at all. Never read it as "charges per call".
   * "no-999999": EDE used to answer a no-data query with HTTP 500 + code 999999
   * (probed 2026-07-11). It stopped doing that on 2026-08-01, and since
   * 2026-08-07 a no-data answer keeps its row and column and carries a `null`
   * placeholder (the old indicator-dependent `0` tier is gone),
   * so 999999 is now a generic server fault here — the marker stays because
   * replaying an already-billed EDE query on a fault buys nothing.
   * See transport.ts RetryPolicy. */
  retry?: "no-replay" | "no-999999"
  /** Floor for the HTTP timeout (ms): effective timeout is max(config.timeoutMs,
   * timeoutMs). Set on synchronous AI generation that outlives the 30s default —
   * aborting bills the orphaned generation anyway. */
  timeoutMs?: number
  /** 落地即不可逆：请求发出前必须拿到调用方的显式确认。标在端点上而不是写在某个工具的
   * handler 里，是为了让「这个请求会做什么」只有一份事实——规则复制成两份，早晚只改其中
   * 一份。文案必须由端点给：网关是通用的，共享一句话会在第二个不可逆端点出现时指名股票池。 */
  destructive?: {
    /** 丢的是什么，用调用方的话说。 */
    warning: string
  }
  /** 在 `000000` 成功信封**内部**报逐条失败：`{successList, failList}`，解析不了的条目
   * 落在 `failList` 里而外层仍写着操作成功。不标记就会把一次部分失败当成全部成功返回。
   *
   * 🔴 **只对 `kind: "json"` 且未启用分页的端点有效**：`client.call` 对下载与分页端点
   * 提前 return，标在那两类上不会被执行。`endpoints.test.ts` 钉住这个约束。 */
  itemFailures?: true
}

/** 端点表里的一条：键即端点键，`key` 字段由汇总时补上。 */
export type EndpointSpec = Omit<EndpointDefinition, "key">
export type EndpointTable = Record<string, EndpointSpec>

const coreEndpoints: EndpointTable = {
  "auth.login": {
    method: "POST",
    path: "/application/auth/oauth/open/loginV2",
    kind: "json",
    description: "Get access token",
  },
}

/** 各族的端点表在族旁的 `tools/<族>.endpoints.ts` 里（只含数据）；这里按注册顺序汇总，补上 `key`。 */
const TABLES: EndpointTable[] = [coreEndpoints, lookupEndpoints, insightEndpoints, referenceEndpoints, quoteEndpoints, fundamentalEndpoints, aiEndpoints, vaultEndpoints, alternativeEndpoints, indicatorEndpoints]

export const ENDPOINTS: Record<string, EndpointDefinition> = {}
for (const table of TABLES) {
  for (const [key, spec] of Object.entries(table)) {
    if (key in ENDPOINTS) throw new Error(`duplicate endpoint key: ${key}`)
    ENDPOINTS[key] = { key, ...spec }
  }
}
