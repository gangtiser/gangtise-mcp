export type Market = "cn" | "hk" | "us"

const SUFFIX_MARKET: Record<string, Market> = {
  SH: "cn", SZ: "cn", BJ: "cn", HK: "hk", O: "us", N: "us", A: "us",
}

/** 代码后缀 → 市场与代码空间（大写后缀）。只看后缀，不判资产类别：`.SH` 同时是股票、ETF、
 *  债券与指数，资产类别要由端点契约或调用方的上下文给出。认不出的后缀 `market` 为 undefined。 */
export function parseSecurityCode(code: string): { market?: Market; codeSpace: string } {
  const dot = code.lastIndexOf(".")
  const codeSpace = dot >= 0 ? code.slice(dot + 1).toUpperCase() : ""
  return { market: SUFFIX_MARKET[codeSpace], codeSpace }
}
