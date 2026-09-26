import type { ToolExamples } from "../mcp/contract.examples.js"

export const vaultExamples: ToolExamples = {
  gangtise_drive_list: [
    { title: "文件类型 + 空间", args: { keyword: "纪要", fileTypeList: [1], spaceTypeList: [2] }, expect: { requests: [{ method: "POST", path: "/application/open-vault/drive/getList", body: { keyword: "纪要", fileTypeList: [1], spaceTypeList: [2], size: 20, from: 0 } }] } },
  ],
  gangtise_record_list: [
    { title: "来源类别", args: { categoryList: ["upload", "pc"], spaceTypeList: [1] }, expect: { requests: [{ method: "POST", path: "/application/open-vault/record/getList", body: { categoryList: ["upload", "pc"], spaceTypeList: [1], size: 20, from: 0 } }] } },
  ],
  gangtise_my_conference_list: [
    { title: "来源 + 类别", args: { sourceList: [1], categoryList: ["earningsCall"] }, expect: { requests: [{ method: "POST", path: "/application/open-vault/my-conference/getList", body: { categoryList: ["earningsCall"], sourceList: [1], size: 20, from: 0 } }] } },
  ],
  gangtise_wechat_message_list: [
    { title: "from 越过偏移窗口本地拒绝", args: { from: 10000, keyword: "AI" }, expect: { rejects: /只能按偏移取到第 10000 行/ } },
    { title: "首页不跨偏移窗口", args: { from: 9990, keyword: "AI", fetchAll: true }, expect: { requests: [{ method: "POST", path: "/application/open-vault/wechatgroupmsg/list", body: { from: 9990, keyword: "AI", size: 10 } }] } },
    { title: "群 + 标签", args: { wechatGroupIdList: ["g-1"], tagList: ["research"], industryIdList: ["100800119"] }, expect: { requests: [{ method: "POST", path: "/application/open-vault/wechatgroupmsg/list", body: { wechatGroupIdList: ["g-1"], industryIdList: ["100800119"], tagList: ["research"], size: 20, from: 0 } }] } },
  ],
  gangtise_stock_pool_list: [
    { title: "无参", args: {}, expect: { requests: [{ method: "POST", path: "/application/open-vault/stock-pool/getPoolList", body: {} }] } },
  ],
  gangtise_drive_download: [
    { title: "fileId", args: { fileId: "file-1" }, expect: { requests: [{ method: "GET", path: "/application/open-vault/drive/download/file", query: { fileId: "file-1" } }] } },
  ],
  gangtise_record_download: [
    { title: "recordId + contentType", args: { recordId: "rec-1", contentType: "asr" }, expect: { requests: [{ method: "GET", path: "/application/open-vault/record/download/file", query: { recordId: "rec-1", contentType: "asr" } }] } },
  ],
  gangtise_my_conference_download: [
    { title: "conferenceId + contentType", args: { conferenceId: "conf-1", contentType: "summary" }, expect: { requests: [{ method: "GET", path: "/application/open-vault/my-conference/download/file", query: { conferenceId: "conf-1", contentType: "summary" } }] } },
    { title: "不支持原始音频", args: { conferenceId: "conf-1", contentType: "original" }, expect: { rejects: /at contentType/ } },
  ],
  gangtise_wechat_chatroom_list: [
    { title: "roomName 逗号拼接；省略 size 拉全部", args: { roomName: ["医药", "消费"] }, expect: { requests: [{ method: "POST", path: "/application/open-vault/wechatgroupmsg/chatroomId", body: { roomName: "医药,消费", from: 0, size: 50 } }] } },
  ],
  gangtise_stock_pool_stocks: [
    { title: "缺省为 ['all']", args: {}, expect: { requests: [{ method: "POST", path: "/application/open-vault/stock-pool/getStockList", body: { poolIdList: ["all"] } }] } },
    { title: "空数组本地拒绝", args: { poolIdList: [] }, expect: { rejects: /不能为空数组/ } },
  ],
  gangtise_stock_pool_create: [
    { title: "池名不 trim、原样下发", args: { poolName: " 我的池 " }, expect: { requests: [{ method: "POST", path: "/application/open-vault/stock-pool/createPool", body: { poolName: " 我的池 " } }] } },
  ],
  gangtise_stock_pool_rename: [
    { title: "poolId + poolName", args: { poolId: "pool-1", poolName: "新名字" }, expect: { requests: [{ method: "POST", path: "/application/open-vault/stock-pool/updatePool", body: { poolId: "pool-1", poolName: "新名字" } }] } },
  ],
  gangtise_stock_pool_add_stock: [
    { title: "poolId + securityCodeList", args: { poolId: "pool-1", securityCodeList: ["600519.SH", "00700.HK"] }, expect: { requests: [{ method: "POST", path: "/application/open-vault/stock-pool/addStock", body: { poolId: "pool-1", securityCodeList: ["600519.SH", "00700.HK"] } }] } },
  ],
  gangtise_stock_pool_remove_stock: [
    { title: "poolId + securityCodeList", args: { poolId: "pool-1", securityCodeList: ["600519.SH"] }, expect: { requests: [{ method: "POST", path: "/application/open-vault/stock-pool/deleteStock", body: { poolId: "pool-1", securityCodeList: ["600519.SH"] } }] } },
  ],
  gangtise_stock_pool_delete: [
    { title: "confirm=true 才下发，confirm 不进 body", args: { poolIdList: ["pool-1"], confirm: true }, expect: { requests: [{ method: "POST", path: "/application/open-vault/stock-pool/deletePool", body: { poolIdList: ["pool-1"] } }] } },
    { title: "未确认零请求拒绝", args: { poolIdList: ["pool-1"] }, expect: { rejects: /confirm 置为 true/ } },
  ],
}
