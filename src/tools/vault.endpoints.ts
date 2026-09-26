import type { EndpointTable } from "../core/endpoints.js"

// ─── vault ───
export const vaultEndpoints: EndpointTable = {
  "vault.drive.list": {
    method: "POST",
    path: "/application/open-vault/drive/getList",
    kind: "json",
    description: "List vault drive files",
    billing: { kind: "free" },
    pagination: { mode: "offset", maxPageSize: 50 },
    rowId: "fileId",
  },
  "vault.drive.download": {
    method: "GET",
    path: "/application/open-vault/drive/download/file",
    kind: "download",
    description: "Download vault drive file",
    billing: { kind: "free" },
  },
  "vault.record.list": {
    method: "POST",
    path: "/application/open-vault/record/getList",
    kind: "json",
    description: "List voice recording transcriptions",
    billing: { kind: "free" },
    pagination: { mode: "offset", maxPageSize: 50 },
    rowId: "recordId",
  },
  "vault.record.download": {
    method: "GET",
    path: "/application/open-vault/record/download/file",
    kind: "download",
    description: "Download voice recording transcription file",
    billing: { kind: "free" },
  },
  "vault.my-conference.list": {
    method: "POST",
    path: "/application/open-vault/my-conference/getList",
    kind: "json",
    description: "List my conferences",
    billing: { kind: "fixed", per: "row", price: 0.1 },
    pagination: { mode: "offset", maxPageSize: 50 },
    rowId: "conferenceId",
  },
  "vault.my-conference.download": {
    method: "GET",
    path: "/application/open-vault/my-conference/download/file",
    kind: "download",
    description: "Download my conference resource",
    billing: { kind: "fixed", per: "document", price: 50 },
    retry: "no-replay",
  },
  "vault.wechat-message.list": {
    method: "POST",
    path: "/application/open-vault/wechatgroupmsg/list",
    kind: "json",
    description: "List WeChat group messages",
    billing: { kind: "free" },
    pagination: { mode: "offset", maxPageSize: 50, maxWindow: 10_000 },
    rowId: "msgId",
  },
  "vault.wechat-chatroom.list": {
    method: "POST",
    path: "/application/open-vault/wechatgroupmsg/chatroomId",
    kind: "json",
    description: "List WeChat group chatroom IDs",
    billing: { kind: "free" },
    pagination: { mode: "offset", maxPageSize: 50 },
    rowId: "chatroomId",
  },
  "vault.stock-pool.list": {
    method: "POST",
    path: "/application/open-vault/stock-pool/getPoolList",
    kind: "json",
    description: "List user stock pool IDs and names",
    billing: { kind: "free" },
  },
  "vault.stock-pool.stocks": {
    method: "POST",
    path: "/application/open-vault/stock-pool/getStockList",
    kind: "json",
    description: "List securities in stock pool(s)",
    billing: { kind: "free" },
  },

  // ─── vault stock-pool writes ───
  // 本服务仅有的五个写端点，只动当前账号本人的自选股。五个里有四个按服务端自己的规则
  // 就是幂等的：重复加已在池内的证券、移除本来就不在池内的、删一个不存在的池，都回
  // `000000` 并把该条计入 successList。createPool 是例外，见下。
  "vault.stock-pool.create": {
    method: "POST",
    path: "/application/open-vault/stock-pool/createPool",
    kind: "json",
    // 非幂等，而它的非幂等恰恰让重放变成**误报**：池名重复会被 `230006` 拒绝，于是重放
    // 一个其实已经建成的请求，拿回来的是失败——池建成了，调用方却被告知没建成。宁可如实
    // 说「不知道成没成，去 gangtise_stock_pool_list 查一眼」。这是 no-replay 清单里唯一
    // 不是出于计费原因的一条。
    retry: "no-replay",
    description: "Create a stock pool",
    billing: { kind: "free" },
  },
  "vault.stock-pool.rename": {
    method: "POST",
    path: "/application/open-vault/stock-pool/updatePool",
    kind: "json",
    description: "Rename a stock pool",
    billing: { kind: "free" },
  },
  "vault.stock-pool.add-stock": {
    method: "POST",
    path: "/application/open-vault/stock-pool/addStock",
    kind: "json",
    itemFailures: true,
    description: "Add securities to a stock pool",
    billing: { kind: "free" },
  },
  "vault.stock-pool.remove-stock": {
    method: "POST",
    path: "/application/open-vault/stock-pool/deleteStock",
    kind: "json",
    itemFailures: true,
    description: "Remove securities from a stock pool",
    billing: { kind: "free" },
  },
  "vault.stock-pool.delete": {
    method: "POST",
    path: "/application/open-vault/stock-pool/deletePool",
    kind: "json",
    destructive: {
      warning: "删除股票池会同时移除池内全部证券的关注关系，且不可恢复（个股的投资笔记独立保留、不受影响）。",
    },
    itemFailures: true,
    description: "Delete stock pools (removes every watch relation inside them)",
    billing: { kind: "free" },
  },
}
