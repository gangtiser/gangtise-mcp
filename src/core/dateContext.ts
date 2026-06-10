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

/** 返回 Asia/Shanghai 当前日期的 Date 对象（时间归零到 00:00:00 UTC+8）。 */
export function todayDate(): Date {
  const str = today()
  return new Date(`${str}T00:00:00+08:00`)
}
