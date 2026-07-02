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

// Shared date-param schema: reject malformed dates at the schema boundary so
// they fail fast locally instead of reaching the backend, which silently
// coerces (JS Date rolls "2026-02-30" to 2026-03-02) or errors opaquely. The
// round-trip check rejects any date JS would normalize away; the !isNaN guard
// short-circuits so toISOString() never throws on values like "2026-13-45".
export const dateString = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "日期格式须为 YYYY-MM-DD（须零填充，如 2026-04-01）")
  .refine((v) => {
    const d = new Date(`${v}T00:00:00Z`)
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v
  }, "无效日期（不存在的日历日期，请检查月份/日期取值）")

// YYYY-MM-DD HH:mm:ss — hour/minute/second ranges enforced by the regex, the
// date part gets the same calendar round-trip as dateString.
export const dateTimeString = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2} ([01]\d|2[0-3]):[0-5]\d:[0-5]\d$/, "时间格式须为 YYYY-MM-DD HH:mm:ss（如 2026-04-01 09:30:00）")
  .refine((v) => {
    const d = new Date(`${v.slice(0, 10)}T00:00:00Z`)
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v.slice(0, 10)
  }, "无效日期（不存在的日历日期，请检查月份/日期取值）")

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
