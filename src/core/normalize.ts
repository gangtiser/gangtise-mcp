import { markPartial } from "./partial.js"

import { ValidationError } from "./errors.js"

function wrapList(meta: Record<string, unknown>, list: unknown[]): unknown {
  return Object.keys(meta).length > 0 ? { ...meta, list } : list
}

/** 请求了却没回来的列。行情类接口（日K / 分钟K / 实时 / 资金流）对不认识的字段名是
 *  **名和值一起丢**、不报错——结果里就是少一列，长度校验抓不到。比对请求与返回的
 *  fieldList，缺列标 `_partial` + `missingFields`，让「字段名写错或已下线」有信号。
 *  在 normalizeRows 之前调用（那一步会摘掉 fieldList）。 */
export function flagMissingFields(result: unknown, requested: unknown): unknown {
  if (!Array.isArray(requested) || requested.length === 0) return result
  if (!result || typeof result !== "object" || Array.isArray(result)) return result
  const rec = result as Record<string, unknown>
  if (!Array.isArray(rec.fieldList)) return result
  const returned = new Set(rec.fieldList.map(String))
  const missing = requested.filter((field): field is string => typeof field === "string" && !returned.has(field))
  if (missing.length === 0) return result
  return markPartial(rec, "missing_fields", { missingFields: missing })
}

/** 逐条写操作（加/删证券、删池）的逐条失败**藏在成功信封里**：外层 `code` 恒为
 *  `000000`，解析不了的条目落在 `failList`。不查这个键，一次「10 只里 3 只代码写错」
 *  的调用会原样报成功，而调用方以为 10 只都进池了。非空即标 `_partial` + `failedItems`。 */
export function flagFailedItems(result: unknown): unknown {
  if (!result || typeof result !== "object" || Array.isArray(result)) return result
  const rec = result as Record<string, unknown>
  if (!Array.isArray(rec.failList) || rec.failList.length === 0) return result
  const failedItems = rec.failList.map((item) => {
    if (!item || typeof item !== "object") return String(item)
    const entry = item as Record<string, unknown>
    // 两族写操作把失败挂在不同的键上：证券类是 securityCode，删池是 poolId。
    const id = entry.securityCode ?? entry.poolId ?? JSON.stringify(entry)
    return entry.failReason ? `${String(id)}（${String(entry.failReason)}）` : String(id)
  })
  return markPartial(rec, "failed_items", { failedItems })
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
    // 重名列按位置拍平时后一列会盖掉前一列——长度对得上、没有任何信号地少一列。
    const names = fields.map(String)
    if (record.list.some(Array.isArray) && new Set(names).size !== names.length) {
      const dupes = [...new Set(names.filter((name, i) => names.indexOf(name) !== i))]
      throw new ValidationError(
        `响应 fieldList 有重复列名（${dupes.join("、")}）——按位置拍平时后一列会覆盖前一列，已拒绝输出。返回结构可能已变更，请重试；持续出现请带上工具名与入参报障。`,
      )
    }
    // 列名碰上 Object.prototype 上的名字（`__proto__`、`constructor`……）时用无原型对象：`fieldList`
    // 是**调用方可控**的，而普通对象上 `out["__proto__"] = v` 走的是原型 setter —— 值为非对象时整格
    // 静默消失（该列在输出里不存在），值为对象时改的是原型。其余情况用普通对象：同一张表的行共享
    // 一个隐藏类，拍平与之后的序列化都快两三倍（十万行级的全市场结果差出一百多毫秒）。
    const plain = names.every((name) => !(name in Object.prototype))
    const width = names.length
    const normalizedList = record.list.map((row) => {
      if (!Array.isArray(row)) return row
      // 部分接口（主营构成、估值分析）对「fieldList 里有不存在的字段名」的处理是：值只按
      // **有效**字段返回，字段名却按**请求**原样回显。长度一旦不等，按位置拍平就会把值
      // 贴到错误的字段上。静默错列远比缺字段危险，这里必须直接失败，不允许输出错位数据。
      //（行情类接口是名和值一起丢，长度对得上，由 flagMissingFields 另行标记。）
      if (row.length !== fields.length) {
        throw new ValidationError(
          `响应字段数与请求 fieldList 不匹配（fieldList ${fields.length} 项、该行返回 ${row.length} 个值）——通常是 fieldList 里含该接口不存在的字段名：此时只返回有效字段的值、字段名却按请求回显，按位置拍平会把值贴到错误的字段上。请只传该工具实际支持的字段名；不确定就不传 fieldList（=返回全量字段，最稳）。`,
        )
      }
      const out: Record<string, unknown> = plain ? {} : Object.create(null)
      for (let i = 0; i < width; i++) out[names[i]] = row[i]
      return out
    })
    const { fieldList, list, ...meta } = record
    return wrapList(meta, normalizedList)
  }

  if (Array.isArray(record.list)) {
    // 数组行没有 fieldList 就无从知道各列是什么，原样交出去等于一批无名数字。
    if (record.list.some(Array.isArray)) {
      throw new ValidationError(
        "响应包含数组形式的行但没有 fieldList，无法确定各列的含义，已拒绝输出。返回结构可能已变更，请重试；持续出现请带上工具名与入参报障。",
      )
    }
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
