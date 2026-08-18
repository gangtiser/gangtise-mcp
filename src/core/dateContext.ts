import { z } from "zod"

export const CURRENT_TIMEZONE = "Asia/Shanghai"

const FMT_DATE_TIME = new Intl.DateTimeFormat("en-US", {
  timeZone: CURRENT_TIMEZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
})

interface DateTimeParts {
  year: string
  month: string
  day: string
  hour: string
  minute: string
  second: string
}

export interface CurrentDateContext {
  currentDate: string
  currentYear: string
  currentDateTime: string
  timezone: typeof CURRENT_TIMEZONE
}

function dateTimeParts(date: Date): DateTimeParts {
  const parts = Object.fromEntries(
    FMT_DATE_TIME.formatToParts(date)
      .filter(part => part.type !== "literal")
      .map(part => [part.type, part.value]),
  ) as Partial<DateTimeParts>

  return {
    year: parts.year ?? "",
    month: parts.month ?? "",
    day: parts.day ?? "",
    hour: parts.hour ?? "",
    minute: parts.minute ?? "",
    second: parts.second ?? "",
  }
}

export function today(date = new Date()): string {
  const parts = dateTimeParts(date)
  return `${parts.year}-${parts.month}-${parts.day}`
}

export function year(date = new Date()): string {
  return dateTimeParts(date).year
}

export function dateTime(date = new Date()): string {
  const parts = dateTimeParts(date)
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`
}

export function currentDateContext(date = new Date()): CurrentDateContext {
  return {
    currentDate: today(date),
    currentYear: year(date),
    currentDateTime: dateTime(date),
    timezone: CURRENT_TIMEZONE,
  }
}

/** Served once via McpServer instructions (server.ts) — do not repeat in tool/param descriptions. */
export function dateContextInstruction(): string {
  return `涉及"今天/最近/今年/当前"等相对日期时，先调用 gangtise_current_date 获取当前日期（时区 ${CURRENT_TIMEZONE}），不要使用训练数据年份。`
}

export function dateDesc(): string {
  return "YYYY-MM-DD"
}

export function dateTimeDesc(): string {
  return "YYYY-MM-DD HH:mm:ss"
}

// 三种「年在前」写法，发请求前统一归一成 YYYY-MM-DD。反向引用保证分隔符一致，
// 所以 "2026-07/01" 这种手误不是日期。
//
// 🔴 只收年在前，是有意的不对称。服务端对「年在后」也做解析，且按美式月在前读
// （2026-08-17 实测：01-07-2026 与 01/07/2026 都是 1 月 7 日，07-01-2026 与
// 07/01/2026 都是 7 月 1 日）——那是平台约定，不是缺陷。但 2026/07/01 对任何人
// 都是同一天，01-07-2026 对美国人是 1 月 7 日、对欧洲人是 7 月 1 日：放过去等于
// 让一半调用方拿到差半年的数据，HTTP 200、行数合理、无任何信号。本地拒掉还省一
// 次往返（不发请求、不计费），报错直接给出可用的写法。
const YEAR_FIRST_DATE = /^(\d{4})([-/]?)(\d{2})\2(\d{2})$/
const YEAR_FIRST_DATE_HEAD = /^(\d{4})([-/]?)(\d{2})\2(\d{2})/
const DATE_HINT = "日期格式须为 YYYY-MM-DD（YYYY/MM/DD、YYYYMMDD 也可，须零填充）；不接受「年在后」写法——接口按美式月在前解析，01-07-2026 是 1 月 7 日而不是 7 月 1 日"

/** 日历有效性：拒掉 JS Date 会顺延掉的日期（2026-02-30 → 2026-03-02）。
 * !isNaN 短路，避免 toISOString() 在 "2026-13-45" 上抛异常。 */
const isRealDate = (isoDate: string) => {
  const d = new Date(`${isoDate}T00:00:00Z`)
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === isoDate
}

// Shared date-param schema: reject malformed dates at the schema boundary so
// they fail fast locally instead of reaching the backend, which silently
// coerces or errors opaquely. 归一放在校验之后、日历检查之前，所以
// 日历检查与下发的都是 YYYY-MM-DD。
export const dateString = z
  .string()
  .regex(YEAR_FIRST_DATE, DATE_HINT)
  .transform((v) => v.replace(YEAR_FIRST_DATE, "$1-$3-$4"))
  .refine(isRealDate, "无效日期（不存在的日历日期，请检查月份/日期取值）")

// YYYY-MM-DD HH:mm:ss — hour/minute/second ranges enforced by the regex, the
// date part gets the same normalization + calendar round-trip as dateString.
// 时间部分原样保留：接口回显它，不要重排。
export const dateTimeString = z
  .string()
  .regex(/^(\d{4})([-/]?)(\d{2})\2(\d{2}) ([01]\d|2[0-3]):[0-5]\d:[0-5]\d$/, "时间格式须为 YYYY-MM-DD HH:mm:ss（日期部分同样接受 YYYY/MM/DD、YYYYMMDD；不接受年在后写法，接口按美式月在前解析）")
  .transform((v) => v.replace(YEAR_FIRST_DATE_HEAD, "$1-$3-$4"))
  .refine((v) => isRealDate(v.slice(0, 10)), "无效日期（不存在的日历日期，请检查月份/日期取值）")

/** Quarter-end report dates (financial reporting periods), e.g. quarterEndDate("06-30", "12-31"). */
export function quarterEndDate(...monthDays: string[]) {
  return dateString.refine(
    (v) => monthDays.some((md) => v.endsWith(`-${md}`)),
    `报告期须为季末日：${monthDays.map((md) => `xxxx-${md}`).join(" | ")}`,
  )
}

/** 返回 Asia/Shanghai 当前日期的 Date 对象（时间归零到 00:00:00 UTC+8）。 */
export function todayDate(): Date {
  const str = today()
  return new Date(`${str}T00:00:00+08:00`)
}
