/** 首行比请求的起点晚这么多天以上才提示：两周内的差距是节假日与停牌。 */
const LATE_START_DAYS = 14

/** 最早一行比请求的起点晚两周以上时说一声：可能上市或复牌晚于起点，也可能区间超出了账号对这类数据的
 *  可查窗口——窗口外的部分不报错、直接不返回，结果读起来像覆盖了整个区间。`cause` 换掉原因那半句，
 *  用于窗口外不是这样处理的接口（债券行情整批报 110003，晚到只能是上市晚或数据起点晚）。
 *
 *  显式多只（`securities`）按证券逐只判：只看整个结果的最早一行时，一只覆盖完整就会掩盖另一只缺了
 *  几年。同时点出一行都没返回的代码（空 ≠ 没数据）；请求失败或载荷坏掉的那几只已有自己的标记，不重复。
 *  全市场与单只看整个结果。分片失败本身就会让序列晚开始，它有自己的标记，这里不再重复归因。
 *
 *  同一列的日期 / 时间串格式一致，整串的字典序就是先后顺序：逐行比整串、最后只切一次日期，十万行级的
 *  结果不必每行分配一个子串。 */
export function lateStartNote(result: unknown, start: unknown, field: string, securities?: string[], cause?: string): string | undefined {
  if (!result || typeof result !== "object" || Array.isArray(result)) return undefined
  const rec = result as { fieldList?: unknown; list?: unknown; _partial_reason?: unknown; _failed_securities?: unknown; _malformed_securities?: unknown }
  if (!Array.isArray(rec.list) || String(rec._partial_reason ?? "").includes("failed_shards")) return undefined
  const fields = Array.isArray(rec.fieldList) ? rec.fieldList : undefined
  const at = fields ? fields.indexOf(field) : -1
  const codeAt = fields ? fields.indexOf("securityCode") : -1
  const cell = (row: unknown, name: string, index: number): unknown => (Array.isArray(row) ? (index >= 0 ? row[index] : undefined) : (row as Record<string, unknown> | null)?.[name])
  const from = typeof start === "string" ? start.slice(0, 10) : undefined
  const lateDays = (min: string | undefined): number => {
    const day = min?.slice(0, 10)
    if (!from || !day || !/^\d{4}-\d{2}-\d{2}$/.test(day)) return 0
    return (Date.parse(`${day}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000
  }
  const TAIL = cause ?? "可能上市或复牌晚于起点、代码有误，也可能区间超出了账号对这类数据的可查窗口——窗口外的部分不报错、直接不返回"
  const listed = (items: string[]) => (items.length > 20 ? `${items.slice(0, 20).join("、")} 等 ${items.length} 只` : items.join("、"))

  if (securities && securities.length > 1 && (codeAt >= 0 || rec.list.some((row) => row && typeof row === "object" && !Array.isArray(row)))) {
    // 每只的最早日期；有行但读不到日期的记成空串（算返回了行，不判晚到）。
    const earliest = new Map<string, string>()
    for (const row of rec.list) {
      const code = cell(row, "securityCode", codeAt)
      if (typeof code !== "string") continue
      const key = code.toUpperCase()
      const value = cell(row, field, at)
      const current = earliest.get(key)
      if (typeof value === "string" && (current === undefined || current === "" || value < current)) earliest.set(key, value)
      else if (current === undefined) earliest.set(key, "")
    }
    const named = new Set<string>([
      ...(Array.isArray(rec._failed_securities) ? rec._failed_securities.map((item) => String((item as { security?: unknown }).security)) : []),
      ...(Array.isArray(rec._malformed_securities) ? rec._malformed_securities.map(String) : []),
    ].map((code) => code.toUpperCase()))
    const unique = [...new Set(securities)]
    const late = unique.filter((code) => lateDays(earliest.get(code.toUpperCase())) > LATE_START_DAYS).map((code) => `${code}（${earliest.get(code.toUpperCase())!.slice(0, 10)}）`)
    const absent = unique.filter((code) => !earliest.has(code.toUpperCase()) && !named.has(code.toUpperCase()))
    const parts = [
      late.length > 0 ? `以下证券的最早一行比请求的起点 ${from} 晚 ${LATE_START_DAYS} 天以上：${listed(late)}` : "",
      absent.length > 0 ? `以下证券没有返回任何行：${listed(absent)}` : "",
    ].filter(Boolean)
    return parts.length > 0 ? `${parts.join("；")}。${TAIL}` : undefined
  }

  let min: string | undefined
  for (const row of rec.list) {
    const value = cell(row, field, at)
    if (typeof value === "string" && (min === undefined || value < min)) min = value
  }
  const days = lateDays(min)
  return days > LATE_START_DAYS
    ? `最早一行是 ${min!.slice(0, 10)}，比请求的起点 ${from} 晚 ${days} 天：${cause ?? "可能上市或复牌晚于起点，也可能区间超出了账号对这类数据的可查窗口——窗口外的部分不报错、直接不返回"}`
    : undefined
}

/** 结果上的 `_note`：多条都有时用分号连起来。 */
export function withNote(result: unknown, ...notes: Array<string | undefined>): unknown {
  const note = notes.filter(Boolean).join("；")
  return note && result && typeof result === "object" && !Array.isArray(result) ? { ...result, _note: note } : result
}
