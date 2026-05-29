import { readFileSync } from "node:fs"

let cached: string | null = null

/**
 * Reads the package version at runtime from the bundled package.json.
 * Resolved relative to this module so it works both from `dist/core/` (compiled)
 * and `src/core/` (tsx dev) — both sit two levels under the package root.
 */
export function getPackageVersion(): string {
  if (cached) return cached
  try {
    const pkgUrl = new URL("../../package.json", import.meta.url)
    const pkg = JSON.parse(readFileSync(pkgUrl, "utf8")) as { version?: string }
    cached = typeof pkg.version === "string" ? pkg.version : "0.0.0"
  } catch {
    cached = "0.0.0"
  }
  return cached
}
