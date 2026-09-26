import type { FamilyModule, ToolSpec } from "./mcp/define.js"

/** GANGTISE_MCP_TOOLS 选出的工具。`advertised`：列进 tools/list；`enabled`：任何入口都可调。
 *  目前两者相同。 */
export interface Profile {
  advertised(spec: ToolSpec): boolean
  enabled(spec: ToolSpec): boolean
}

const KEYWORDS = new Set(["core", "all", "legacy"])

/** 基础工具：instructions、大结果的落盘指针、空结果提示都会点名它们（日期换算、回读剩余数据、
 *  按名称查代码），任何选择下都启用，不能禁用——少了它们，别的工具给出的下一步就走不通。 */
export const FOUNDATION_TOOLS: ReadonlySet<string> = new Set(["gangtise_current_date", "gangtise_read_response", "gangtise_securities_search"])

/** 逗号分隔、取并集：`core`（默认）= 各族 core 档；`all` = core + extended；`legacy` = 被合并的旧工具；
 *  族名 = 该族 core + extended；工具名 = 该工具。前加 `-` 禁用该族或该工具，优先于任何选中。
 *  只写了禁用项时以 `core` 为底。选中的工具声明的 `requires` 一并启用；基础工具始终启用。
 *  不认识的名字、禁用基础工具、禁用了选中工具依赖的工具，都直接报错——配置写错不能静默变成
 *  另一套工具。 */
export function parseProfile(raw: string | undefined, families: FamilyModule[]): Profile {
  const familyOf = new Map<string, string>()
  const specOf = new Map<string, ToolSpec>()
  for (const family of families) {
    for (const tool of family.tools) {
      familyOf.set(tool.name, family.name)
      specOf.set(tool.name, tool)
    }
  }
  const familyNames = new Set(families.map((family) => family.name))
  const invalid = (token: string, why: string) => new Error(`GANGTISE_MCP_TOOLS 里的「${token}」${why}`)

  const tokens = (raw ?? "").split(",").map((token) => token.trim()).filter(Boolean)
  const selected = new Set<string>()
  const excluded = new Set<string>()
  for (const token of tokens) {
    const negated = token.startsWith("-")
    const name = negated ? token.slice(1) : token
    const known = familyNames.has(name) || familyOf.has(name) || (!negated && KEYWORDS.has(name))
    if (!known) {
      throw invalid(token, `不是可用的取值：可写 core / all / legacy、族名（${[...familyNames].join(" / ")}）或工具名，前加 - 表示禁用该族或该工具。`)
    }
    if (negated && FOUNDATION_TOOLS.has(name)) {
      throw invalid(token, `：${name} 是基础工具（大结果回读、日期换算、按名称查代码都靠它），始终启用，不能禁用。`)
    }
    ;(negated ? excluded : selected).add(name)
  }
  if (selected.size === 0) selected.add("core")

  const isExcluded = (name: string) => excluded.has(name) || excluded.has(familyOf.get(name) ?? "")
  const picked = (spec: ToolSpec): boolean => {
    const family = familyOf.get(spec.name)
    if (FOUNDATION_TOOLS.has(spec.name)) return true
    if (isExcluded(spec.name)) return false
    if (selected.has(spec.name)) return true
    if (spec.tier === "legacy") return selected.has("legacy")
    if (family !== undefined && selected.has(family)) return true
    return spec.tier === "core" ? selected.has("core") || selected.has("all") : selected.has("all")
  }

  const enabled = new Set<string>()
  const queue = [...specOf.values()].filter(picked).map((spec) => spec.name)
  while (queue.length > 0) {
    const name = queue.pop()!
    if (enabled.has(name)) continue
    enabled.add(name)
    for (const dependency of specOf.get(name)?.requires ?? []) {
      if (isExcluded(dependency)) throw invalid(`-${dependency}`, `：${name} 要靠 ${dependency} 取回结果，禁用它就用不了 ${name}。请一并禁用 ${name}，或去掉这一项。`)
      queue.push(dependency)
    }
  }
  const chosen = (spec: ToolSpec) => enabled.has(spec.name)
  return { advertised: chosen, enabled: chosen }
}
