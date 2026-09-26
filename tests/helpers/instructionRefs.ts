/** instructions 里点名、却不在 `names` 里的工具（与 src/routing.ts 各自实现，互相对照）。
 *  认完整工具名、省略 gangtise_ 的简称与通配（`qa_list`、`drive_*`、`indicator_*`），以及与某个工具
 *  同名的单词（`realtime`、`lookup`；`allNames` 是全部工具，用来判断一个单词是不是工具名）。 */
export function missingToolRefs(text: string, names: readonly string[], allNames: readonly string[] = names): string[] {
  const missing: string[] = []
  for (const [name] of text.matchAll(/gangtise_[a-z_]+/g)) {
    if (!names.includes(name)) missing.push(name)
  }
  for (const match of text.matchAll(/(?<![\w*])([a-z]+(?:_[a-z]+)+)(_\*)?(?![\w])/g)) {
    const [, stem, wildcard] = match
    if (stem.startsWith("gangtise_")) continue
    const full = `gangtise_${stem}`
    const ok = wildcard ? names.some((n) => n.startsWith(`${full}_`)) : names.some((n) => n === full || n.startsWith(`${full}_`))
    if (!ok) missing.push(`${stem}${wildcard ?? ""}`)
  }
  for (const [, stem] of text.matchAll(/(?<![\w*])([a-z]+)_\*/g)) {
    if (!names.some((n) => n.startsWith(`gangtise_${stem}_`))) missing.push(`${stem}_*`)
  }
  for (const [word] of text.matchAll(/(?<![\w*])[a-z]+(?![\w*])/g)) {
    if (allNames.includes(`gangtise_${word}`) && !names.includes(`gangtise_${word}`)) missing.push(word)
  }
  return missing
}
