import { z } from "zod"

/**
 * A required, non-blank string: trims surrounding whitespace and rejects "" / "   ".
 * Use for IDs and codes always forwarded to the upstream API — a blank value
 * guarantees a wasted (sometimes billed) round-trip or a 400.
 */
export const nonEmptyString = z.string().trim().min(1)

const EMPTY_LIST_MSG = "列表不能为空：要加这个筛选就至少给一个值，不加就整个省略该参数"

/** 一个筛选/ID 列表：条目非空，且**整个列表不能为空**。
 *
 * 🔴 `[]` 与「不传」在语义上是同一件事（都=不加这个条件），但形式上不是：调用方写出
 * `securityList: []` 时通常以为自己加了约束。空列表照样下发，接口按「没有该条件」处理，
 * 于是返回的是**未经筛选的全量**并按条计费 —— 与 0.2.4 收紧空串（`[""]`）是同一类问题的
 * 另一半。这里直接拒，报错里说清「要么给值、要么别传」，比返回一份读起来完全正常的
 * 错数据便宜得多。 */
export const nonEmptyList = () => z.array(nonEmptyString).min(1, EMPTY_LIST_MSG)

/** 同上，但取值来自闭集（评级、报告期、市场……）。
 *
 * ⚠️ 只用于**顶层筛选参数**。`indicatorParamList` 这类嵌套参数数组有意不收紧：那里
 * `[]` 与省略同样是「没有分指标参数」，而调用方常是程序化拼出来的，逼它改成条件省略
 * 只增加麻烦、换不来任何安全性 —— 顶层筛选不一样，`[]` 会静默放开筛选并按条计费。 */
export const enumList = <T extends z.ZodTypeAny>(item: T) => z.array(item).min(1, EMPTY_LIST_MSG)

/** 字段投影参数：条目非空且**不得重复**。
 *
 * 🔴 重复字段名是一次**静默丢列**：服务端把 `fieldList` 原样回显、按位置返回等长的值，
 * 于是 `['a','a','b']` 的第二个 `a` 会在拍平时盖掉第一个——长度校验对得上，结果里少一
 * 列而没有任何信号。与 `gangtise_read_response` 的 `fields` 用同一条规则。 */
export function uniqueFieldList(describe: string) {
  return z
    .array(nonEmptyString)
    .min(1, "fieldList 不能为空数组：要投影字段就至少给一个，要全量就省略该参数")
    .refine((v) => new Set(v).size === v.length, "fieldList 不能重复：同名字段在按位置拍平时会相互覆盖，导致静默少一列")
    .optional()
    .describe(describe)
}

/**
 * A closed set of integer literals (e.g. a download `fileType` of 1|2). Rejects
 * out-of-set values at the tool boundary instead of forwarding them for an
 * upstream 400. Requires ≥2 values — a single valid value should be z.literal().
 */
export function intLiteralEnum(values: readonly [number, number, ...number[]]) {
  return z.union(
    values.map((v) => z.literal(v)) as [z.ZodLiteral<number>, z.ZodLiteral<number>, ...z.ZodLiteral<number>[]],
  )
}

/**
 * Whole-market keywords the quote APIs accept in `securityList`, lower-cased for
 * comparison. Which ones a given endpoint takes differs — the unified day K-line and
 * realtime take `aShares` / `hkStocks` / `usStocks`, the market-specific day K-line
 * endpoints take `all`, fund flow takes only `aShares`, and `gangtise_stock_summary`
 * takes none — so callers pass their own accepted list; this set only answers "is this
 * string a market keyword at all".
 *
 * Unknown keywords are deliberately absent rather than guessed at: this is a
 * known-keyword list, so a future server-side addition degrades to "not recognised as a
 * keyword" instead of being refused outright.
 */
export const MARKET_KEYWORDS = new Set(["all", "ashares", "hkstocks", "usstocks"])

/** Market keywords are compared case-insensitively — see the note on
 * `assertMarketKeywords` in tools/quote.ts for why that folding is load-bearing. */
export const matchesKeyword = (value: string, keyword: string): boolean =>
  value.toLowerCase() === keyword.toLowerCase()
