import type { GangtiseClient } from "./client.js"
import { unwrapPayload } from "./shape.js"
import { currentSignal } from "./requestContext.js"
import { runWithConcurrency } from "./transport.js"

/** 决定「这条序列该用哪条日期轴」的参数名。只有 `tradeDate` 能让交易日轴成立；
 *  另外两个标记的指标，其取值落在交易日历里根本没有的日期上。 */
const TRADE_DATE_KEY = "tradeDate"
const PERIOD_DATE_KEYS = ["reportDate", "fiscalYear"]

/** 同时在飞的探针数。它们免费且只读，而一条时序最多几个指标，所以这里只是给突发量封顶。 */
const PROBE_CONCURRENCY = 5

/**
 * 调用方没传 `calendarType` 时，替时序请求挑一条日期轴。
 *
 * 服务端自己的默认是 `ND`（自然日），而这个默认是**安全的那一个**：报告期类指标的值落在
 * 2024-03-31、2024-06-30 这种日期上，两个都是周日，交易日轴里压根没有这一列。在那里要
 * `TD` 丢的不是一列，而是**仅有的那几列有值的**——请求照样 200，回来是一整片 `null`，
 * 调用方读作「这家公司没有营收数据」。
 *
 * 但 `ND` 不是白拿的：纯行情序列上它就是浪费。一年 `ND` 回 366 列、`TD` 回 248 列，多出
 * 来的三成全是周末 `null`——既进账单，也占那 30000 单元格的额度。
 *
 * 所以：**只有每一个指标都能被证明是交易日型**才要 `TD`；报告期参数、空的
 * `parameterList`、搜不到的 code、探针本身失败，一律留给服务端默认。这个不对称就是全部
 * 要点——`ND` 判错只多花单元格，`TD` 判错是静默丢数。
 *
 * ⚠️ 这不是「自动补发 reportDate」那件事：那个改的是请求**参数值**，判错就取错数；
 * 这个选的是日期**轴**，判错等于什么都没做。
 *
 * @returns 每个指标都是交易日型时返回 `"TD"`，否则 `undefined`（不发，服务端按 `ND`）。
 */
export async function resolveCalendarType(client: GangtiseClient, indicators: string[]): Promise<"TD" | undefined> {
  const codes = [...new Set(indicators.filter((code) => typeof code === "string" && code.length > 0))]
  if (codes.length === 0) return undefined

  const verdicts = await runWithConcurrency(codes, PROBE_CONCURRENCY, (code) => isTradingDayTyped(client, code), currentSignal())
  return verdicts.every((verdict) => verdict === true) ? "TD" : undefined
}

/** 判定缓存。指标的 `parameterList` 不随查询变化，而一次「30 个指标 × 单证券」的时序
 *  就要 6 批往返（并发 5），每调一次工具重来一遍——默认超时只有 30s。进程内缓存把同一
 *  个 code 的探针降到一次。
 *
 *  🔴 **只缓存查到元数据后做出的判定**：探针抛错或搜不到都不写缓存，否则一次网络抖动
 *  会把整个进程的判定钉死在 `ND`，而这个进程是长驻的。 */
const verdictCache = new Map<string, boolean>()

/** 单个指标的判定。`false` 覆盖一切「没能证明」的情形，包括探针抛错——search 挂了不该
 *  改变一条时序请求要的东西。 */
async function isTradingDayTyped(client: GangtiseClient, code: string): Promise<boolean> {
  const cached = verdictCache.get(code)
  if (cached !== undefined) return cached

  let entry: Record<string, unknown> | undefined
  try {
    entry = await findIndicator(client, code)
  } catch {
    return false
  }
  if (!entry) return false

  const keys = paramKeys(entry.parameterList)
  // 空 parameterList 不能证明任何事：静态属性族（pty_* / scr_*）报的是空表，
  // cdr_conv_ratio 也报空表却照样吃日期。
  const verdict = keys.length > 0
    && !keys.some((key) => PERIOD_DATE_KEYS.includes(key))
    && keys.includes(TRADE_DATE_KEY)
  verdictCache.set(code, verdict)
  return verdict
}

/** 测试用：清空判定缓存。生产路径不调用——缓存的是不随查询变化的指标元数据。 */
export function clearCalendarTypeCacheForTests(): void {
  verdictCache.clear()
}

/** `indicator search` 按关键词匹配，所以 code 本身就是查询词，答案要按 code 精确挑出来
 *  ——关键词搜索会连近似项一起返回。 */
async function findIndicator(client: GangtiseClient, code: string): Promise<Record<string, unknown> | undefined> {
  const raw = await client.call("indicator.search", { keyword: code, limit: 100 })
  const data = unwrapPayload("indicator.search", raw)
  const list = Array.isArray(data) ? data : (data as { list?: unknown })?.list
  if (!Array.isArray(list)) return undefined
  return list.find((item): item is Record<string, unknown> =>
    !!item && typeof item === "object" && (item as Record<string, unknown>).indicatorCode === code)
}

function paramKeys(parameterList: unknown): string[] {
  if (!Array.isArray(parameterList)) return []
  return parameterList
    .map((param) => (param && typeof param === "object" ? (param as Record<string, unknown>).paramKey : undefined))
    .filter((key): key is string => typeof key === "string")
}
