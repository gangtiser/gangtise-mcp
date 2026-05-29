import fs from "node:fs"
import path from "node:path"

import { describe, expect, it } from "vitest"
import { getPackageVersion } from "../../../src/core/version.js"

describe("getPackageVersion", () => {
  it("returns the version declared in package.json", () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(process.cwd(), "package.json"), "utf8"))
    expect(getPackageVersion()).toBe(pkg.version)
  })

  it("returns a semver-shaped string", () => {
    expect(getPackageVersion()).toMatch(/^\d+\.\d+\.\d+/)
  })
})
