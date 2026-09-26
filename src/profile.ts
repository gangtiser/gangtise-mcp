import type { FamilyModule, ToolSpec } from "./mcp/define.js"

/** GANGTISE_MCP_TOOLS 选出的工具。`advertised`：列进 tools/list；`enabled`：任何入口都可调。
 *  目前两者相同。 */
export interface Profile {
  advertised(spec: ToolSpec): boolean
  enabled(spec: ToolSpec): boolean
}

const KEYWORDS = new Set(["core", "all", "legacy"])

/** 逗号分隔、取并集：`core`（默认）= 各族 core 档；`all` = core + extended；`legacy` = 被合并的旧工具；
 *  族名 = 该族 core + extended；工具名 = 该工具。前加 `-` 禁用该族或该工具，优先于任何选中。
 *  只写了禁用项时以 `core` 为底。不认识的名字直接报错——配置写错不能静默退回默认档。 */
export function parseProfile(raw: string | undefined, families: FamilyModule[]): Profile {
  const familyOf = new Map<string, string>()
  for (const family of families) for (const tool of family.tools) familyOf.set(tool.name, family.name)
  const familyNames = new Set(families.map((family) => family.name))

  const tokens = (raw ?? "").split(",").map((token) => token.trim()).filter(Boolean)
  const selected = new Set<string>()
  const excluded = new Set<string>()
  for (const token of tokens) {
    const negated = token.startsWith("-")
    const name = negated ? token.slice(1) : token
    const known = familyNames.has(name) || familyOf.has(name) || (!negated && KEYWORDS.has(name))
    if (!known) {
      throw new Error(
        `GANGTISE_MCP_TOOLS 里的「${token}」不是可用的取值：可写 core / all / legacy、族名（${[...familyNames].join(" / ")}）或工具名，前加 - 表示禁用该族或该工具。`,
      )
    }
    ;(negated ? excluded : selected).add(name)
  }
  if (selected.size === 0) selected.add("core")

  const chosen = (spec: ToolSpec): boolean => {
    const family = familyOf.get(spec.name)
    if (excluded.has(spec.name) || (family !== undefined && excluded.has(family))) return false
    if (selected.has(spec.name)) return true
    if (spec.tier === "legacy") return selected.has("legacy")
    if (family !== undefined && selected.has(family)) return true
    return spec.tier === "core" ? selected.has("core") || selected.has("all") : selected.has("all")
  }
  return { advertised: chosen, enabled: chosen }
}
