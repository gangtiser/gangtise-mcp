export type Market = "cn" | "hk" | "us"

const SUFFIX_MARKET: Record<string, Market> = {
  SH: "cn", SZ: "cn", BJ: "cn", HK: "hk", O: "us", N: "us", A: "us",
}

/** 代码后缀 → 市场与代码空间（最后一个点之后的部分，大写）。只看后缀，不判资产类别：`.SH` 同时是
 *  股票、ETF、债券与指数，资产类别要由端点契约或调用方的上下文给出。认不出的后缀 `market` 为 undefined。
 *
 *  没有点号时整串就是代码空间：单独传一个 `HK` / `A` 这样的市场字面量会被认成那个市场，市场专用
 *  工具得以在本地拒绝它——照发的话，那些接口对无效代码返回空列表，读起来像「没有数据」。 */
export function parseSecurityCode(code: string): { market?: Market; codeSpace: string } {
  const codeSpace = code.slice(code.lastIndexOf(".") + 1).toUpperCase()
  return { market: SUFFIX_MARKET[codeSpace], codeSpace }
}
