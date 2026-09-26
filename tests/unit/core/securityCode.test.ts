import { describe, expect, it } from "vitest"
import { parseSecurityCode } from "../../../src/core/securityCode.js"

describe("parseSecurityCode", () => {
  it.each([
    ["600519.SH", "cn", "SH"],
    ["000858.sz", "cn", "SZ"],
    ["830799.BJ", "cn", "BJ"],
    ["00700.HK", "hk", "HK"],
    ["AAPL.O", "us", "O"],
    ["BRK_B.N", "us", "N"],
    ["BRK.A", "us", "A"],
  ])("maps %s to market %s", (code, market, codeSpace) => {
    expect(parseSecurityCode(code)).toEqual({ market, codeSpace })
  })

  // 只看后缀：认不出的后缀（概念指数、行业指数、全球指数、将来的基金 / 期货）不猜市场。
  it.each([
    ["885001.GT", "GT"],
    ["801780.SWI", "SWI"],
    ["SPX.SPI", "SPI"],
    ["600519", "600519"],
  ])("leaves %s without a market", (code, codeSpace) => {
    expect(parseSecurityCode(code)).toEqual({ market: undefined, codeSpace })
  })

  // 单独一个市场字面量读作那个市场，让市场专用工具能在本地拒绝它，而不是照发、拿回一个空列表。
  it.each([["HK", "hk"], ["a", "us"], ["SH", "cn"]])("reads a bare market literal %s as its market", (code, market) => {
    expect(parseSecurityCode(code).market).toBe(market)
  })
})
