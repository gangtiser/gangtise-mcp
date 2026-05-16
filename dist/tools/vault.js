import { z } from "zod";
import { registerJsonTool, registerDownloadTool, buildToolContent } from "./registry.js";
import { normalizeRows } from "../core/normalize.js";
import { errorMessage } from "../core/errors.js";
import { dateContextPrefix } from "../core/dateContext.js";
import { dateTimeDesc } from "../core/dateContext.js";
const listSpecs = [
    {
        name: "gangtise_drive_list",
        description: "查询 Gangtise 云盘文件列表，支持按关键词、文件类型、空间类型、时间范围筛选。",
        endpointKey: "vault.drive.list",
        paginated: true,
        inputSchema: {
            from: z.number().int().min(0).optional(),
            keyword: z.string().optional(),
            fileType: z.number().int().optional().describe("1=文档 | 2=图片 | 3=视频 | 4=公众号 | 5=其他"),
            spaceType: z.number().int().optional().describe("1=个人空间 | 2=企业空间"),
            startTime: z.string().optional().describe(dateTimeDesc()),
            endTime: z.string().optional().describe(dateTimeDesc()),
        },
    },
    {
        name: "gangtise_record_list",
        description: "查询 Gangtise 语音录音转写列表，支持按关键词、类别、时间范围筛选。",
        endpointKey: "vault.record.list",
        paginated: true,
        inputSchema: {
            from: z.number().int().min(0).optional(),
            keyword: z.string().optional(),
            category: z.array(z.string()).optional().describe("upload=上传 | link=链接 | mobile=移动端 | gtNote=GT笔记 | pc=PC端 | share=分享"),
            spaceType: z.number().int().optional().describe("1=个人录音 | 2=企业录音"),
            startTime: z.string().optional().describe(dateTimeDesc()),
            endTime: z.string().optional().describe(dateTimeDesc()),
        },
    },
    {
        name: "gangtise_my_conference_list",
        description: "查询我的会议录音列表，支持按证券、机构、类别、时间范围筛选。",
        endpointKey: "vault.my-conference.list",
        paginated: true,
        inputSchema: {
            from: z.number().int().min(0).optional(),
            keyword: z.string().optional(),
            researchArea: z.string().optional(),
            security: z.string().optional(),
            institution: z.string().optional(),
            category: z.array(z.string()).optional().describe("earningsCall=业绩会 | strategyMeeting=策略会 | fundRoadshow=路演 | shareholdersMeeting=股东大会 | maMeeting=并购 | specialMeeting=专题会 | companyAnalysis=公司分析 | industryAnalysis=行业分析 | other=其他"),
            startTime: z.string().optional().describe(dateTimeDesc()),
            endTime: z.string().optional().describe(dateTimeDesc()),
        },
    },
    {
        name: "gangtise_wechat_message_list",
        description: "查询微信群消息列表，支持按群 ID、行业、类别、标签、时间范围筛选。",
        endpointKey: "vault.wechat-message.list",
        paginated: true,
        inputSchema: {
            from: z.number().int().min(0).optional(),
            keyword: z.string().optional(),
            securityList: z.array(z.string()).optional().describe("证券代码列表，如 ['000001.SZ']"),
            wechatGroupId: z.array(z.string()).optional().describe("群 ID，来自 gangtise_wechat_chatroom_list"),
            industry: z.array(z.string()).optional(),
            category: z.array(z.string()).optional().describe("text=文字 | image=图片 | documents=文件 | url=链接"),
            tag: z.array(z.string()).optional().describe("roadShow=路演 | research=调研 | strategyMeeting=策略会 | meetingSummary=会议纪要 | industryComment=行业点评 | companyComment=公司点评 | earningsReview=业绩点评"),
            startTime: z.string().optional().describe(dateTimeDesc()),
            endTime: z.string().optional().describe(dateTimeDesc()),
        },
    },
    {
        name: "gangtise_wechat_chatroom_list",
        description: "查询可用的微信群 ID 和群名称列表。",
        endpointKey: "vault.wechat-chatroom.list",
        paginated: true,
        inputSchema: {
            from: z.number().int().min(0).optional(),
            roomName: z.array(z.string()).optional().describe("按群名称筛选"),
        },
    },
    {
        name: "gangtise_stock_pool_list",
        description: "查询用户的自选股池列表，返回池 ID 和名称。",
        endpointKey: "vault.stock-pool.list",
        paginated: false,
        inputSchema: {},
    },
];
const downloadSpecs = [
    {
        name: "gangtise_drive_download",
        description: "按 fileId 从 Gangtise 云盘下载文件。",
        endpointKey: "vault.drive.download",
        inputSchema: {
            fileId: z.string().describe("文件 ID，来自 gangtise_drive_list"),
        },
    },
    {
        name: "gangtise_record_download",
        description: "下载语音录音转写内容，可选原始音频、ASR 文字或 AI 摘要。",
        endpointKey: "vault.record.download",
        inputSchema: {
            recordId: z.string().describe("录音 ID，来自 gangtise_record_list"),
            contentType: z.string().describe("original=原始音频 | asr=语音转文字 | summary=AI摘要（必填）"),
        },
    },
    {
        name: "gangtise_my_conference_download",
        description: "下载会议录音资源，返回 ASR 转写或 AI 摘要。",
        endpointKey: "vault.my-conference.download",
        inputSchema: {
            conferenceId: z.string().describe("会议 ID，来自 gangtise_my_conference_list"),
            contentType: z.string().describe("asr=语音转文字 | summary=AI摘要（必填，不支持原始音频）"),
        },
    },
];
export function registerVaultTools(server, client) {
    for (const spec of listSpecs) {
        registerJsonTool(server, client, spec);
    }
    for (const spec of downloadSpecs) {
        registerDownloadTool(server, client, spec);
    }
    server.registerTool("gangtise_stock_pool_stocks", {
        description: dateContextPrefix() + "查询指定自选股池中的证券列表。不传 poolIdList 时默认返回所有池的股票。",
        inputSchema: {
            poolIdList: z.array(z.string()).optional().describe("池 ID 列表，来自 gangtise_stock_pool_list；不传默认 ['all'] 即所有池"),
        },
    }, async (args) => {
        try {
            const { poolIdList = ["all"] } = args;
            const result = await client.call("vault.stock-pool.stocks", { poolIdList });
            return { content: await buildToolContent(normalizeRows(result)) };
        }
        catch (err) {
            return { content: [{ type: "text", text: errorMessage(err) }], isError: true };
        }
    });
}
