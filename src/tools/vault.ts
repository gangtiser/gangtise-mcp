import { openAsBlob } from "node:fs"
import fs from "node:fs/promises"
import path from "node:path"
import { z } from "zod"
import { ValidationError } from "../core/errors.js"
import { defineDownloadTool, defineJsonTool, defineTool, defineWriteTool, type DownloadToolSpec, type FamilyModule, type JsonToolSpec } from "../mcp/define.js"
import { buildToolContent } from "../core/present.js"
import { contentResult } from "../mcp/handler.js"
import { normalizeRows } from "../core/normalize.js"
import { ENDPOINTS } from "../core/endpoints.js"
import { intLiteralEnum, nonEmptyString, nonEmptyList, enumList } from "../mcp/schemas.js"
import { dateTimeString } from "../core/dateContext.js"
import { vaultEndpoints } from "./vault.endpoints.js"

/** 删池的后果说明只有一份，写在端点上（vault.endpoints.ts），工具描述与确认闸门都读它。 */
const STOCK_POOL_DELETE_WARNING = ENDPOINTS["vault.stock-pool.delete"].destructive!.warning

export const listSpecs: JsonToolSpec[] = [
  {
    name: "gangtise_drive_list",
    tier: "core",
    description: "查询 Gangtise 云盘文件列表，支持按关键词、文件类型、空间类型、时间范围筛选。",
    endpointKey: "vault.drive.list",
    paginated: true,
    inputSchema: {
      from: z.number().int().min(0).optional(),
      keyword: nonEmptyString.optional(),
      fileTypeList: enumList(intLiteralEnum([1, 2, 3, 4, 5])).optional().describe("1=文档 | 2=图片 | 3=视频 | 4=公众号 | 5=其他"),
      spaceTypeList: enumList(intLiteralEnum([1, 2])).optional().describe("1=个人空间 | 2=企业空间"),
      startTime: dateTimeString.optional(),
      endTime: dateTimeString.optional(),
    },
  },
  {
    name: "gangtise_record_list",
    tier: "core",
    description: "查询 Gangtise 语音录音转写列表，支持按关键词、类别、时间范围筛选。",
    endpointKey: "vault.record.list",
    paginated: true,
    inputSchema: {
      from: z.number().int().min(0).optional(),
      keyword: nonEmptyString.optional(),
      categoryList: enumList(z.enum(["upload", "link", "mobile", "gtNote", "pc", "share"])).optional().describe("upload=上传 | link=链接 | mobile=移动端 | gtNote=GT笔记 | pc=PC端 | share=分享"),
      spaceTypeList: enumList(intLiteralEnum([1, 2])).optional().describe("1=个人录音 | 2=企业录音"),
      startTime: dateTimeString.optional(),
      endTime: dateTimeString.optional(),
    },
  },
  {
    name: "gangtise_my_conference_list",
    tier: "core",
    description: "查询我的会议录音列表，支持按证券、机构、类别、时间范围筛选。",
    endpointKey: "vault.my-conference.list",
    paginated: true,
    inputSchema: {
      from: z.number().int().min(0).optional(),
      keyword: nonEmptyString.optional(),
      researchAreaList: nonEmptyList().optional().describe("研究方向 ID，接受两类码：行业码用 gangtise_constant_list category=citicIndustry（1008001xx，如食品饮料 100800119）；宏观/策略/固收/金工/海外/其他这类方向码用 category=gangtiseIndustry（122000xxx，该 category 只有这 6 条、不含行业）。本端点不支持申万码（104xxxxxx），传了会返 0 条而不报错"),
      securityList: nonEmptyList().optional(),
      institutionList: nonEmptyList().optional().describe("机构 ID（牵头机构）：用 gangtise_institution_search categoryList=['leadInstitution'] 按名称搜；需全量枚举用 gangtise_lookup type=meeting-orgs"),
      categoryList: enumList(z.enum(["earningsCall", "strategyMeeting", "fundRoadshow", "shareholdersMeeting", "maMeeting", "specialMeeting", "companyAnalysis", "industryAnalysis", "other"])).optional().describe("earningsCall=业绩会 | strategyMeeting=策略会 | fundRoadshow=路演 | shareholdersMeeting=股东大会 | maMeeting=并购 | specialMeeting=专题会 | companyAnalysis=公司分析 | industryAnalysis=行业分析 | other=其他"),
      sourceList: enumList(intLiteralEnum([1, 2])).optional().describe("录制来源：1=企微会议助理 | 2=会议服务微信群（可多选，不传返回全部）"),
      startTime: dateTimeString.optional(),
      endTime: dateTimeString.optional(),
    },
  },
  {
    name: "gangtise_wechat_message_list",
    tier: "core",
    description: "查询微信群消息列表，支持按群 ID、行业、类别、标签、时间范围筛选。",
    endpointKey: "vault.wechat-message.list",
    paginated: true,
    inputSchema: {
      from: z.number().int().min(0).optional(),
      keyword: nonEmptyString.optional(),
      securityList: nonEmptyList().optional().describe("证券代码列表，如 ['000001.SZ']"),
      wechatGroupIdList: nonEmptyList().optional().describe("群 ID，来自 gangtise_wechat_chatroom_list"),
      industryIdList: nonEmptyList().optional().describe("行业 ID，来自 gangtise_constant_list category=citicIndustry（1008001xx）；本端点只认中信码，申万码（104xxxxxx）会被接口拒绝"),
      categoryList: enumList(z.enum(["text", "image", "documents", "url"])).optional().describe("text=文字 | image=图片 | documents=文件 | url=链接"),
      tagList: enumList(z.enum(["roadShow", "research", "strategyMeeting", "meetingSummary", "industryComment", "companyComment", "earningsReview"])).optional().describe("roadShow=路演 | research=调研 | strategyMeeting=策略会 | meetingSummary=会议纪要 | industryComment=行业点评 | companyComment=公司点评 | earningsReview=业绩点评"),
      startTime: dateTimeString.optional(),
      endTime: dateTimeString.optional(),
    },
  },
  {
    name: "gangtise_stock_pool_list",
    tier: "core",
    description: "查询用户的自选股池列表，返回池 ID 和名称。",
    endpointKey: "vault.stock-pool.list",
    paginated: false,
    inputSchema: {},
  },
]

export const downloadSpecs: DownloadToolSpec[] = [
  {
    name: "gangtise_drive_download",
    tier: "legacy",
    description: "按 fileId 从 Gangtise 云盘下载文件。",
    endpointKey: "vault.drive.download",
    inputSchema: {
      fileId: nonEmptyString.describe("文件 ID，来自 gangtise_drive_list"),
    },
  },
  {
    name: "gangtise_record_download",
    tier: "legacy",
    description: "下载语音录音转写内容，可选原始音频、ASR 文字或 AI 摘要。",
    endpointKey: "vault.record.download",
    inputSchema: {
      recordId: nonEmptyString.describe("录音 ID，来自 gangtise_record_list"),
      contentType: z.enum(["original", "asr", "summary"]).describe("original=原始音频 | asr=语音转文字 | summary=AI摘要（必填）"),
    },
  },
  {
    name: "gangtise_my_conference_download",
    tier: "legacy",
    description: "下载会议录音资源，返回 ASR 转写或 AI 摘要。",
    endpointKey: "vault.my-conference.download",
    inputSchema: {
      conferenceId: nonEmptyString.describe("会议 ID，来自 gangtise_my_conference_list"),
      contentType: z.enum(["asr", "summary"]).describe("asr=语音转文字 | summary=AI摘要（必填，不支持原始音频）"),
    },
  },
]

// ─── 股票池写操作 ───
// 只动当前账号本人的自选股。
// 三个逐条端点的失败藏在成功信封里，由 client 按端点上的 itemFailures 标记统一标注；
// 删池的确认闸门在 invokeOperation，读端点上的 destructive 标记。

const poolId = nonEmptyString.describe("池 ID，来自 gangtise_stock_pool_list")
// 🔴 有意不加 `.trim()`：zod 的 trim 是**转换**，会真的改掉发出去的值。而池名判重是
// 整串精确比较（首尾空格不 trim），所以替调用方 trim 既改了用户指定的名字，又可能让
// 一个本来不冲突的名字撞上已有池。只判「是不是全空白」，长度与发送都用原串。
const poolName = z
  .string()
  .min(1, "池名不能为空")
  .max(10, "池名最多 10 个字符（中文算 1 个）")
  .refine((value) => value.trim().length > 0, "池名不能全是空白字符")
  .describe("池名，最多 10 个字符（中文算 1 个，超出报 230007）；不能与该账号已有的池重名（报 230006，判重是整串精确比较，首尾空格不 trim、大小写不归一）")
const securityCodeList = nonEmptyList()
  .describe("证券代码列表，须带市场后缀且大小写敏感，如 ['600519.SH','00700.HK']。单池上限 10000 只")

// ─── 云盘管理（全部免费）───
// 云盘允许同名、只以 ID 区分；删除不可恢复，确认闸门读端点上的 destructive 标记（mcp/invoke.ts）。

const spaceType = intLiteralEnum([1, 2]).optional()
/** 服务端按 UTF-16 计长度（与 JS 的 length 相同），中文算 1、emoji 算 2；超出报 230004。首尾空格
 *  不替调用方去掉——那会改掉用户指定的名字。 */
const driveName = z.string().min(1).max(200).refine((value) => value.trim().length > 0, "名称不能全是空白字符")
const DRIVE_UPLOAD_MAX_BYTES = 100 * 1024 * 1024

/** 每个动作打的端点、收哪些参数（第一项起为必填，`optional` 之后为可选）与请求体。 */
interface DriveAction {
  endpoint: string
  required: string[]
  optional?: string[]
  body: (args: Record<string, unknown>) => Record<string, unknown>
}

const DRIVE_ACTIONS: Record<string, DriveAction> = {
  create_folder: { endpoint: "vault.drive.create-folder", required: ["name"], optional: ["spaceType", "parentId"], body: (a) => ({ folderName: a.name, spaceType: a.spaceType ?? 1, parentId: a.parentId }) },
  rename: { endpoint: "vault.drive.rename", required: ["type", "id", "name"], body: (a) => ({ type: a.type, id: a.id, name: a.name }) },
  move_file: { endpoint: "vault.drive.move-file", required: ["fileIdList", "targetFolderId"], body: (a) => ({ fileIdList: a.fileIdList, targetFolderId: a.targetFolderId }) },
  move_folder: { endpoint: "vault.drive.move-folder", required: ["folderId", "targetParentId"], body: (a) => ({ folderId: a.folderId, targetParentId: a.targetParentId }) },
  copy: { endpoint: "vault.drive.copy", required: ["fileIdList", "targetFolderId"], body: (a) => ({ copyType: "file", fileIdList: a.fileIdList, targetFolderId: a.targetFolderId }) },
  copy_folder: { endpoint: "vault.drive.copy", required: ["folderId", "targetParentId"], body: (a) => ({ copyType: "folder", folderId: a.folderId, targetParentId: a.targetParentId }) },
  delete_file: { endpoint: "vault.drive.delete-file", required: ["fileIdList"], optional: ["confirm"], body: (a) => ({ fileIdList: a.fileIdList }) },
  delete_folder: { endpoint: "vault.drive.delete-folder", required: ["folderId"], optional: ["confirm"], body: (a) => ({ folderId: a.folderId }) },
}
const DRIVE_ACTION_NAMES = Object.keys(DRIVE_ACTIONS) as [string, ...string[]]

export const vaultFamily: FamilyModule = {
  name: "vault",
  endpoints: vaultEndpoints,
  tools: [
    ...listSpecs.map(defineJsonTool),
    ...downloadSpecs.map(defineDownloadTool),
    defineTool({
      name: "gangtise_wechat_chatroom_list",
      tier: "core",
      access: "read",
      endpoint: "vault.wechat-chatroom.list",
      description: "查询可用的微信群 ID 和群名称列表（服务端返回 {total, list}，按 total 自动并发翻页；省略 size 拉取全部群，传 size 取前 N 条）。",
      input: {
        from: z.number().int().min(0).optional().describe("起始行偏移（0-based），默认 0"),
        size: z.number().int().min(1).optional().describe("返回总行数上限；省略则拉取全部群"),
        roomName: nonEmptyList().optional().describe("按群名称筛选；多个会以逗号拼接发送"),
      },
      run: async ({ client }, args) => {
        const { roomName, from, size } = args as { roomName?: string[]; from?: number; size?: number }
        const body: Record<string, unknown> = {}
        if (typeof from === "number") body.from = from
        if (typeof size === "number") body.size = size
        // Upstream reads roomName as a comma-joined scalar (not an array), matching the CLI.
        if (roomName && roomName.length > 0) body.roomName = roomName.join(",")
        // The endpoint declares pagination, so client.call fans out pages by `total`
        // and merges them (with loud-partial markers). Omitting size fetches all groups.
        const result = await client.call("vault.wechat-chatroom.list", body)
        return contentResult(await buildToolContent(normalizeRows(result)))
      },
    }),
    defineTool({
      name: "gangtise_stock_pool_stocks",
      tier: "core",
      access: "read",
      endpoint: "vault.stock-pool.stocks",
      description: "查询指定自选股池中的证券列表。不传 poolIdList 时默认返回所有池的股票。",
      input: {
        // Live-tested: upstream returns [] for an empty list instead of the
        // "all pools" default — reject it locally so the model omits the param.
        poolIdList: nonEmptyList().min(1, "poolIdList 不能为空数组——查询所有池请省略该参数").optional().describe("池 ID 列表，来自 gangtise_stock_pool_list；不传默认 ['all'] 即所有池"),
      },
      run: async ({ client }, args) => {
        const { poolIdList = ["all"] } = args as { poolIdList?: string[] }
        const result = await client.call("vault.stock-pool.stocks", { poolIdList })
        return contentResult(await buildToolContent(normalizeRows(result)))
      },
    }),
    defineWriteTool({
      name: "gangtise_stock_pool_create",
      tier: "core",
      access: "write",
      idempotent: false,
      endpointKey: "vault.stock-pool.create",
      description: "新建自选股池（写操作，只动当前账号本人的自选股）。返回 {poolId, poolName}。每账号最多 30 个池。⚠️ **不重放**：池名不许重复，超时后自动重发会撞重名、把一次已经成功的创建报成失败。所以超时请先用 gangtise_stock_pool_list 查一眼建成没有，不要直接重试。",
      inputSchema: { poolName },
    }),
    defineWriteTool({
      name: "gangtise_stock_pool_rename",
      tier: "core",
      access: "write",
      idempotent: true,
      endpointKey: "vault.stock-pool.rename",
      description: "自选股池改名（写操作）。返回 {poolId, poolName}。改回自己当前的名字算成功；用了别的池的名字报 230006。",
      inputSchema: { poolId, poolName },
    }),
    defineWriteTool({
      name: "gangtise_stock_pool_add_stock",
      tier: "core",
      access: "write",
      idempotent: true,
      endpointKey: "vault.stock-pool.add-stock",
      description: "把证券加进指定的自选股池（写操作）。重复加已在池内的证券算幂等成功。返回 {successList, failList}；🔴 单条失败（如代码写错）**不会**让整次调用报错，只标 _partial + failedItems——拿到结果先看有没有这个标记，否则会以为传进去的都加成功了。",
      inputSchema: { poolId, securityCodeList },
    }),
    defineWriteTool({
      name: "gangtise_stock_pool_remove_stock",
      tier: "core",
      access: "destructive",
      idempotent: true,
      endpointKey: "vault.stock-pool.remove-stock",
      description: "把证券移出指定的自选股池（写操作）。移除本来就不在池内的证券算幂等成功；只动池内的关注关系，不删池。返回与单条失败标记同 gangtise_stock_pool_add_stock。",
      inputSchema: { poolId, securityCodeList },
    }),
    defineWriteTool({
      name: "gangtise_stock_pool_delete",
      tier: "core",
      access: "destructive",
      idempotent: true,
      endpointKey: "vault.stock-pool.delete",
      description: `删除自选股池（写操作）。🔴 ${STOCK_POOL_DELETE_WARNING}股票池的另外四个写工具都能跑一次相反的操作还原，只有这一个不能——所以删之前先用 gangtise_stock_pool_list 核对 poolId 是哪个池、把池名念给用户确认，再把 confirm 置为 true。删一个不存在的池算幂等成功。返回与单条失败标记同 gangtise_stock_pool_add_stock。`,
      inputSchema: {
        poolIdList: nonEmptyList().describe("要删除的池 ID 列表，来自 gangtise_stock_pool_list"),
        // 有意用 optional boolean 而不是 literal(true)：literal 会让「没传」和「传了
        // false」都在 schema 层被拒成一句通用的 -32602，而**被拒时那句话恰恰是唯一
        // 会告诉调用方「这次要删掉什么」的话**。让所有非 true 的情形都走到闸门，
        // 拿到的就是端点上那段后果说明。
        confirm: z
          .boolean()
          .optional()
          .describe("必须显式传 true 才会发出请求。这是不可恢复操作的二次确认：请先向用户复述将被删除的池名并得到同意，不要仅因为被拒绝过就补上这个参数重试"),
      },
    }),
    defineJsonTool({
      name: "gangtise_drive_folder_list",
      tier: "core",
      description: "查看云盘某个文件夹的直接子文件夹（folderList）与直接文件（fileList），不递归；文件夹 ID 用本工具逐层看。parentId 必须属于 spaceType 那个空间，否则报 100003。",
      endpointKey: "vault.drive.folder-list",
      inputSchema: {
        spaceType: spaceType.describe("1=我的云盘（默认）| 2=租户云盘"),
        parentId: nonEmptyString.optional().describe("文件夹 ID；不传或传 root 为根目录"),
      },
      transformBody: (body) => ({ spaceType: 1, ...body }),
    }),
    defineTool({
      name: "gangtise_drive_manage",
      tier: "extended",
      access: "destructive",
      idempotent: false,
      billingLabel: { kind: "free" },
      endpointFor: (args) => DRIVE_ACTIONS[args.action as string]?.endpoint,
      description: "管理云盘（写操作）：action 选动作，各参数注明了哪个动作用。⚠️ 云盘允许同名、只以 ID 区分：create_folder 与 copy / copy_folder 每执行一次就多一份，超时不会自动重发，别对同一内容重复执行。move_file / move_folder 只能在同一空间内；跨空间（我的云盘 ↔ 租户云盘）用 copy（文件）或 copy_folder（整个文件夹连同子文件夹与文件，返回 newFolderId），源保留。delete_file / delete_folder 不可恢复，须传 confirm: true，delete_folder 连同全部子内容一起删。move_file / copy / delete_file 对单条失败仍返回成功，明细在 failList 并标 _partial。租户云盘对整个租户可见，在里面新建、复制、删除前先向用户确认。",
      input: {
        action: z.enum(DRIVE_ACTION_NAMES).describe("create_folder=新建文件夹 | rename=重命名 | move_file=移动文件 | move_folder=移动文件夹 | copy=跨空间复制文件 | copy_folder=跨空间复制文件夹 | delete_file=删除文件 | delete_folder=删除文件夹"),
        name: driveName.optional().describe("create_folder 的文件夹名 / rename 的新名称，最多 200 个字符（emoji 算 2 个）"),
        spaceType: spaceType.describe("create_folder 用：1=我的云盘（默认）| 2=租户云盘"),
        parentId: nonEmptyString.optional().describe("create_folder 用：父文件夹 ID，须属于 spaceType 那个空间；不传或 root 为根目录"),
        type: z.enum(["file", "folder"]).optional().describe("rename 用：id 是文件还是文件夹"),
        id: nonEmptyString.optional().describe("rename 用：文件或文件夹 ID"),
        fileIdList: nonEmptyList().optional().describe("move_file / copy / delete_file 用：文件 ID，来自 gangtise_drive_folder_list 的 fileList 或 gangtise_drive_list"),
        folderId: nonEmptyString.optional().describe("move_folder / copy_folder / delete_folder 用：文件夹 ID"),
        targetFolderId: nonEmptyString.optional().describe("move_file 用：同一空间的目标文件夹 ID；copy 用：另一空间的目标文件夹 ID；root 为根目录"),
        targetParentId: nonEmptyString.optional().describe("move_folder 用：同一空间的目标父文件夹 ID 或 root，不能是它自己或其子文件夹；copy_folder 用：另一空间的目标父文件夹 ID 或 root"),
        confirm: z.boolean().optional().describe("delete_file / delete_folder 必须显式传 true；先向用户列出将被删除的名称并得到同意，不要仅因为被拒绝过就补上重试"),
      },
      run: async ({ client }, args) => {
        const { action: name, ...rest } = args as { action: string } & Record<string, unknown>
        const action = DRIVE_ACTIONS[name]
        // 每个动作的参数契约：该给的缺了拒，不属于它的传了拒——多余的参数不会被发出去，调用方却以为生效了。
        const allowed = new Set([...action.required, ...(action.optional ?? [])])
        const extra = Object.keys(rest).filter((key) => rest[key] !== undefined && !allowed.has(key))
        if (extra.length > 0) throw new ValidationError(`action=${name} 不收 ${extra.join(" / ")}。`)
        const missing = action.required.filter((key) => rest[key] === undefined)
        if (missing.length > 0) throw new ValidationError(`action=${name} 须传 ${missing.join(" / ")}。`)
        const result = await client.call(action.endpoint, action.body(rest))
        return contentResult(await buildToolContent(normalizeRows(result)))
      },
    }),
    defineTool({
      name: "gangtise_drive_upload",
      tier: "extended",
      access: "write",
      idempotent: false,
      endpoint: "vault.drive.upload",
      description: "把本机文件上传到云盘，单个文件最多 100MB；单日累计超出账号额度报 230008。filePath 是运行本服务的这台机器上的路径。⚠️ 云盘允许同名，每上传一次就多一份，超时不会自动重发——重传前先用 gangtise_drive_folder_list 看是否已经传上去了。上传到租户云盘（spaceType=2）对整个租户可见，先向用户确认。",
      input: {
        filePath: nonEmptyString.describe("本机文件路径，绝对路径最稳"),
        spaceType: spaceType.describe("1=我的云盘（默认）| 2=租户云盘"),
        folderId: nonEmptyString.optional().describe("目标文件夹 ID，须属于 spaceType 那个空间；不传或 root 为根目录"),
        title: driveName.optional().describe("云盘里的文件名，最多 200 个字符（emoji 算 2 个）；不传用本地文件名"),
      },
      run: async ({ client }, args) => {
        const { filePath, spaceType: space, folderId, title } = args as { filePath: string; spaceType?: number; folderId?: string; title?: string }
        const resolved = path.resolve(filePath)
        // 拒绝的理由都在发请求之前查完：一个注定失败的大文件不该先传一遍。
        const stat = await fs.stat(resolved).catch(() => undefined)
        if (!stat) throw new ValidationError(`找不到文件：${filePath}`)
        if (!stat.isFile()) throw new ValidationError(`不是文件：${filePath}`)
        if (stat.size === 0) throw new ValidationError(`文件是空的：${filePath}`)
        if (stat.size > DRIVE_UPLOAD_MAX_BYTES) throw new ValidationError(`文件 ${(stat.size / 1024 / 1024).toFixed(1)}MB，云盘单个文件最多 100MB。`)
        const filename = path.basename(resolved)
        if (title === undefined && filename.length > 200) throw new ValidationError(`本地文件名有 ${filename.length} 个字符，云盘最多 200 个：请传一个更短的 title。`)
        // 按需读磁盘的 Blob：发送时流式读出，不把整个文件先读进内存。
        const blob = await openAsBlob(resolved)
        const result = await client.uploadFile("vault.drive.upload", { filename, blob }, { spaceType: space ?? 1, folderId, title })
        return contentResult(await buildToolContent(normalizeRows(result)))
      },
    }),
  ],
}
