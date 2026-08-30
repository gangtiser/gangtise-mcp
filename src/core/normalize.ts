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
          `响应字段数与请求 fieldList 不匹配（fieldList ${fields.length} 项、该行返回 ${row.length} 个值）——通常是 fieldList 里含该接口不存在的字段名：此时只返回有效字段的值、字段名却按请求回显，按位置拍平会把值贴到错误的字段上。请只传该工具实际支持的字段名；不确定就不传 fieldList（=返回全量字段，最稳）。`,
        )
      }
      // Object.create(null)：`fieldList` 是**调用方可控**的，而普通对象字面量上
      // `acc["__proto__"] = v` 走的是原型 setter —— 值为非对象时整格静默消失（该列在
      // 输出里不存在），值为对象时改的是原型。用无原型对象后它就只是个普通自有属性。
      return fields.reduce<Record<string, unknown>>((acc, field, index) => {
        acc[String(field)] = row[index]
        return acc
      }, Object.create(null) as Record<string, unknown>)
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
    // `null` / 缺失 = 合法零行（与分页端点 `{total:0, list:null}` 同一约定）。
    // 但**其他非数组**（对象、字符串、数字）是形状漂移：旧写法一律折成 `[]`，于是
    // 一次「码表接口改了返回结构」会伪装成「这个分类下一个常量都没有」，而调用方拿这
    // 张空表去解析行业/公告类别 ID，只会得出「查不到」。响亮失败。
    if (constants !== null && constants !== undefined && !Array.isArray(constants)) {
      throw new ValidationError(
        `常量列表响应异常：constants 不是数组（实际为 ${typeof constants}）——返回结构可能已变更。请重试；持续出现请带上工具名与入参报障。`,
      )
    }
    return wrapList(meta, Array.isArray(constants) ? constants : [])
  }

  return value
}
