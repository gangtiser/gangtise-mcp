const FMT_DATE = new Intl.DateTimeFormat("zh-CN", {
  timeZone: "Asia/Shanghai",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
})

const FMT_YEAR = new Intl.DateTimeFormat("zh-CN", {
  timeZone: "Asia/Shanghai",
  year: "numeric",
})

export function today(): string {
  return FMT_DATE.format(new Date()).replace(/\//g, "-")
}

export function year(): string {
  return FMT_YEAR.format(new Date()).replace("年", "")
}

export function dateContextPrefix(): string {
  return `[当前日期 ${today()}，当前年份 ${year()}，时区 Asia/Shanghai。用户说"今天/最近/今年/当前"时按此日期换算，不要使用训练数据年份。] `
}

export function dateDesc(): string {
  return `YYYY-MM-DD。当前日期 ${today()}，当前年份 ${year()}`
}

export function dateTimeDesc(): string {
  return `YYYY-MM-DD HH:mm:ss。当前日期 ${today()}，当前年份 ${year()}`
}

/** 返回 Asia/Shanghai 当前日期的 Date 对象（时间归零到 00:00:00 UTC+8）。 */
export function todayDate(): Date {
  const str = today()
  return new Date(`${str}T00:00:00+08:00`)
}
