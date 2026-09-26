import type { ToolExamples } from "../mcp/contract.examples.js"
import { oneQuoteRow } from "../mcp/contract.examples.js"

export const quoteExamples: ToolExamples = {
  gangtise_day_kline: [
    { title: "单只：钉住 limit=6000", args: { security: "600519.SH", startDate: "2026-09-01", endDate: "2026-09-05", fieldList: ["securityCode", "tradeDate", "close"] }, expect: { requests: [{ method: "POST", path: "/application/open-quote/kline/daily", body: { securityList: ["600519.SH"], startDate: "2026-09-01", endDate: "2026-09-05", fieldList: ["securityCode", "tradeDate", "close"], limit: 6000 } }] } },
    { title: "多只且单请求装不下（4 只 × 约 1695 个交易日 > 6000）：逐只请求", args: { security: ["600519.SH", "000858.SZ", "00700.HK", "AAPL.O"], startDate: "2020-01-01", endDate: "2026-06-30" }, upstream: oneQuoteRow(), expect: { requests: [
        { method: "POST", path: "/application/open-quote/kline/daily", body: { securityList: ["000858.SZ"], startDate: "2020-01-01", endDate: "2026-06-30", limit: 6000 } },
        { method: "POST", path: "/application/open-quote/kline/daily", body: { securityList: ["00700.HK"], startDate: "2020-01-01", endDate: "2026-06-30", limit: 6000 } },
        { method: "POST", path: "/application/open-quote/kline/daily", body: { securityList: ["600519.SH"], startDate: "2020-01-01", endDate: "2026-06-30", limit: 6000 } },
        { method: "POST", path: "/application/open-quote/kline/daily", body: { securityList: ["AAPL.O"], startDate: "2020-01-01", endDate: "2026-06-30", limit: 6000 } },
      ] } },
    { title: "多只但装得下：一个请求", args: { security: ["600519.SH", "00700.HK"], startDate: "2026-09-01", endDate: "2026-09-30" }, expect: { requests: [{ method: "POST", path: "/application/open-quote/kline/daily", body: { securityList: ["600519.SH", "00700.HK"], startDate: "2026-09-01", endDate: "2026-09-30", limit: 6000 } }] } },
    { title: "aShares 全市场：1 天/片、跳周末、limit=10000", args: { security: "aShares", startDate: "2026-09-04", endDate: "2026-09-08" }, upstream: oneQuoteRow(), expect: { requests: [
        { method: "POST", path: "/application/open-quote/kline/daily", body: { securityList: ["aShares"], startDate: "2026-09-04", endDate: "2026-09-04", limit: 10000 } },
        { method: "POST", path: "/application/open-quote/kline/daily", body: { securityList: ["aShares"], startDate: "2026-09-07", endDate: "2026-09-07", limit: 10000 } },
        { method: "POST", path: "/application/open-quote/kline/daily", body: { securityList: ["aShares"], startDate: "2026-09-08", endDate: "2026-09-08", limit: 10000 } },
      ] } },
    { title: "hkStocks 全市场：2 天/片，关键字大小写归一", args: { security: "HKSTOCKS", startDate: "2026-09-07", endDate: "2026-09-10" }, upstream: oneQuoteRow(), expect: { requests: [
        { method: "POST", path: "/application/open-quote/kline/daily", body: { securityList: ["hkStocks"], startDate: "2026-09-07", endDate: "2026-09-08", limit: 10000 } },
        { method: "POST", path: "/application/open-quote/kline/daily", body: { securityList: ["hkStocks"], startDate: "2026-09-09", endDate: "2026-09-10", limit: 10000 } },
      ] } },
    { title: "全市场关键字与代码混传本地拒绝", args: { security: ["aShares", "600519.SH"], startDate: "2026-09-01", endDate: "2026-09-02" }, expect: { rejects: /全市场关键字必须单独传/ } },
    { title: "all 不是本工具的关键字", args: { security: "all", startDate: "2026-09-01", endDate: "2026-09-02" }, expect: { rejects: /'all' 不是 gangtise_day_kline 的全市场关键字/ } },
  ],
  gangtise_day_kline_hk: [
    { title: "港股代码", args: { security: "00700.HK", startDate: "2026-09-01", endDate: "2026-09-05" }, expect: { requests: [{ method: "POST", path: "/application/open-quote/kline-hk/daily", body: { securityList: ["00700.HK"], startDate: "2026-09-01", endDate: "2026-09-05", limit: 6000 } }] } },
    { title: "all：2 天/片", args: { security: "all", startDate: "2026-09-07", endDate: "2026-09-10" }, upstream: oneQuoteRow(), expect: { requests: [
        { method: "POST", path: "/application/open-quote/kline-hk/daily", body: { securityList: ["all"], startDate: "2026-09-07", endDate: "2026-09-08", limit: 10000 } },
        { method: "POST", path: "/application/open-quote/kline-hk/daily", body: { securityList: ["all"], startDate: "2026-09-09", endDate: "2026-09-10", limit: 10000 } },
      ] } },
    { title: "美股代码本地拒绝", args: { security: "AAPL.O" }, expect: { rejects: /是美股代码/ } },
  ],
  gangtise_day_kline_us: [
    { title: "美股代码", args: { security: "AAPL.O", startDate: "2026-09-01", endDate: "2026-09-05", limit: 100 }, expect: { requests: [{ method: "POST", path: "/application/open-quote/kline-us/daily", body: { securityList: ["AAPL.O"], startDate: "2026-09-01", endDate: "2026-09-05", limit: 100 } }] } },
    { title: "港股代码本地拒绝", args: { security: "00700.HK" }, expect: { rejects: /是港股代码/ } },
  ],
  gangtise_index_day_kline: [
    { title: "单个指数", args: { security: "000001.SH", startDate: "2026-09-01", endDate: "2026-09-05" }, expect: { requests: [{ method: "POST", path: "/application/open-quote/index/kline/daily", body: { securityList: ["000001.SH"], startDate: "2026-09-01", endDate: "2026-09-05", limit: 6000 } }] } },
    { title: "all 本地拒绝（本端点对 all 返回空结果）", args: { security: "all", startDate: "2026-08-01", endDate: "2026-08-31" }, expect: { rejects: /没有全市场关键字/ } },
  ],
  gangtise_minute_kline: [
    { title: "单只：securityCode 标量", args: { security: "600519.SH", startTime: "2026-09-01 09:30:00", endTime: "2026-09-01 15:00:00" }, expect: { requests: [{ method: "POST", path: "/application/open-quote/kline/minute", body: { startTime: "2026-09-01 09:30:00", endTime: "2026-09-01 15:00:00", limit: 6000, securityCode: "600519.SH" } }] } },
    { title: "多只：逐只请求", args: { security: ["600519.SH", "512800.SH"], startTime: "2026-09-01 09:30:00", endTime: "2026-09-01 15:00:00", limit: 500 }, upstream: oneQuoteRow(), expect: { requests: [
        { method: "POST", path: "/application/open-quote/kline/minute", body: { startTime: "2026-09-01 09:30:00", endTime: "2026-09-01 15:00:00", limit: 500, securityCode: "512800.SH" } },
        { method: "POST", path: "/application/open-quote/kline/minute", body: { startTime: "2026-09-01 09:30:00", endTime: "2026-09-01 15:00:00", limit: 500, securityCode: "600519.SH" } },
      ] } },
  ],
  gangtise_realtime: [
    { title: "混合市场 + fieldList", args: { security: ["600519.SH", "00700.HK", "AAPL.O"], fieldList: ["securityCode", "latestPrice"] }, expect: { requests: [{ method: "POST", path: "/application/open-quote/quote/realtime", body: { securityList: ["600519.SH", "00700.HK", "AAPL.O"], fieldList: ["securityCode", "latestPrice"] } }] } },
    { title: "全市场关键字大小写归一", args: { security: "usstocks" }, expect: { requests: [{ method: "POST", path: "/application/open-quote/quote/realtime", body: { securityList: ["usStocks"] } }] } },
  ],
  gangtise_fund_flow: [
    { title: "单只", args: { security: "600519.SH", startDate: "2026-09-01", endDate: "2026-09-05" }, expect: { requests: [{ method: "POST", path: "/application/open-quote/fund-flow/daily", body: { securityList: ["600519.SH"], startDate: "2026-09-01", endDate: "2026-09-05", limit: 6000 } }] } },
    { title: "aShares 全市场：1 天/片", args: { security: "aShares", startDate: "2026-09-04", endDate: "2026-09-07" }, upstream: oneQuoteRow(), expect: { requests: [
        { method: "POST", path: "/application/open-quote/fund-flow/daily", body: { securityList: ["aShares"], startDate: "2026-09-04", endDate: "2026-09-04", limit: 10000 } },
        { method: "POST", path: "/application/open-quote/fund-flow/daily", body: { securityList: ["aShares"], startDate: "2026-09-07", endDate: "2026-09-07", limit: 10000 } },
      ] } },
    { title: "全市场缺日期本地拒绝", args: { security: "aShares", startDate: "2026-09-04" }, expect: { rejects: /须同时提供 startDate 和 endDate/ } },
    { title: "港股代码本地拒绝", args: { security: "00700.HK" }, expect: { rejects: /仅支持 A 股/ } },
  ],
}
