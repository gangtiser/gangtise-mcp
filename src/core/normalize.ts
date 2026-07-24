import { ValidationError } from "./errors.js"

function wrapList(meta: Record<string, unknown>, list: unknown[]): unknown {
  return Object.keys(meta).length > 0 ? { ...meta, list } : list
}

export function normalizeRows(value: unknown): unknown {
  if (!value || typeof value !== "object") {
    return value
  }

  if (Array.isArray(value)) {
    return value
  }

  const record = value as Record<string, unknown>

  if (Array.isArray(record.fieldList) && Array.isArray(record.list)) {
    const fields = record.fieldList as unknown[]
    const normalizedList = record.list.map((row) => {
      if (!Array.isArray(row)) return row
      // 上游对「fieldList 里有该接口不存在的字段名」的处理是：值只按**有效**字段返回，
      // 字段名却按**请求**原样回显。长度一旦不等，按位置拍平就会把值贴到错误的字段上
      // ——实测请求 ["securityCode","close","turnoverRate"]（realtime 无 close）会把
      // 换手率 28.5573 贴成 close，读起来就是「茅台收盘价 28.56」。静默错列远比缺字段
      // 危险，这里必须直接失败，不允许输出错位数据。
      if (row.length !== fields.length) {
        throw new ValidationError(
          `响应字段数与请求 fieldList 不匹配（fieldList ${fields.length} 项、该行返回 ${row.length} 个值）——通常是 fieldList 里含该接口不存在的字段名：上游只返回有效字段的值、字段名却按请求回显，按位置拍平会把值贴到错误的字段上。请只传该工具实际支持的字段名；不确定就不传 fieldList（=返回全量字段，最稳）。`,
        )
      }
      return fields.reduce<Record<string, unknown>>((acc, field, index) => {
        acc[String(field)] = row[index]
        return acc
      }, {})
    })
    const { fieldList, list, ...meta } = record
    return wrapList(meta, normalizedList)
  }

  if (Array.isArray(record.list)) {
    const { list, ...meta } = record
    return wrapList(meta, list)
  }

  if ("constants" in record) {
    const { constants, ...meta } = record
    return wrapList(meta, Array.isArray(constants) ? constants : [])
  }

  return value
}
