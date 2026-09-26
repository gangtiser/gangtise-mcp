/** 路由文字里点名的工具。instructions 只能点名已启用的工具：点名一个调不到的工具，模型会照着去调。
 *
 *  认得四种写法：完整工具名；省略 `gangtise_` 的多段简称（`qa_list`、`report_image`）；`xxx_*` 通配；
 *  与某个工具同名的单词（`realtime`、`lookup`）。中文说法（「三表」「资金流」）认不出来，写路由时
 *  用 `refs` 显式补上。 */
export function referencesIn(text: string, toolNames: readonly string[]): string[] {
  const refs: string[] = []
  for (const [name] of text.matchAll(/gangtise_[a-z_]+/g)) refs.push(name.slice("gangtise_".length))
  for (const [, stem, wildcard] of text.matchAll(/(?<![\w*])([a-z]+(?:_[a-z]+)+)(_\*)?(?![\w*])/g)) {
    if (!stem.startsWith("gangtise_")) refs.push(wildcard ? `${stem}_*` : stem)
  }
  for (const [, stem] of text.matchAll(/(?<![\w*])([a-z]+)_\*/g)) refs.push(`${stem}_*`)
  for (const [word] of text.matchAll(/(?<![\w*])[a-z]+(?![\w*])/g)) {
    if (toolNames.includes(`gangtise_${word}`)) refs.push(word)
  }
  return refs
}

/** 一个引用能不能落到已启用的工具上。有同名工具时必须是它本身；否则按前缀（`site_visit` → `site_visit_list`）。 */
export function resolves(ref: string, toolNames: readonly string[], enabled: ReadonlySet<string>): boolean {
  if (ref.endsWith("_*")) {
    const prefix = `gangtise_${ref.slice(0, -1)}`
    return [...enabled].some((name) => name.startsWith(prefix))
  }
  const full = `gangtise_${ref}`
  if (toolNames.includes(full)) return enabled.has(full)
  return [...enabled].some((name) => name.startsWith(`${full}_`))
}

/** 一段路由：文字 + 文字里认不出来的额外引用。 */
export type RoutingClause = string | { text: string; refs: string[] }

/** 只保留点名的工具全部已启用的分句。带前缀的行（「①行情/财务：」）一句都不剩时整行不出；最后一句
 *  停在「；」时改成「。」。 */
export function assembleRouting(
  lines: Array<{ prefix?: string; clauses: RoutingClause[] }>,
  toolNames: readonly string[],
  enabled: ReadonlySet<string>,
): string {
  const kept = (clause: RoutingClause) => {
    const text = typeof clause === "string" ? clause : clause.text
    const refs = [...referencesIn(text, toolNames), ...(typeof clause === "string" ? [] : clause.refs)]
    return refs.every((ref) => resolves(ref, toolNames, enabled)) ? text : undefined
  }
  const out: string[] = []
  for (const line of lines) {
    const texts = line.clauses.map(kept).filter((text): text is string => text !== undefined)
    if (texts.length === 0) continue
    let body = texts.join("")
    if (line.prefix !== undefined && body.endsWith("；")) body = `${body.slice(0, -1)}。`
    out.push(`${line.prefix ?? ""}${body}`)
  }
  return out.join("\n")
}
