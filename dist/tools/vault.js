import { z } from "zod";
import { registerJsonTool, registerDownloadTool } from "./registry.js";
const listSpecs = [
    {
        name: "gangtise_drive_list",
        description: "List files in Gangtise vault cloud drive. Filter by keyword, file type, space type, or date range.",
        endpointKey: "vault.drive.list",
        paginated: true,
        inputSchema: {
            from: z.number().int().min(0).optional(),
            keyword: z.string().optional(),
            fileType: z.number().int().optional().describe("1=doc | 2=image | 3=video | 4=公众号 | 5=other"),
            spaceType: z.number().int().optional().describe("1=my space | 2=tenant space"),
            startTime: z.string().optional().describe("YYYY-MM-DD HH:mm:ss"),
            endTime: z.string().optional().describe("YYYY-MM-DD HH:mm:ss"),
        },
    },
    {
        name: "gangtise_record_list",
        description: "List voice recording transcriptions from Gangtise vault. Filter by keyword, category, or date range.",
        endpointKey: "vault.record.list",
        paginated: true,
        inputSchema: {
            from: z.number().int().min(0).optional(),
            keyword: z.string().optional(),
            category: z.array(z.string()).optional().describe("upload | link | mobile | gtNote | pc | share"),
            spaceType: z.number().int().optional().describe("1=my space | 2=tenant space"),
            startTime: z.string().optional().describe("YYYY-MM-DD HH:mm:ss"),
            endTime: z.string().optional().describe("YYYY-MM-DD HH:mm:ss"),
        },
    },
    {
        name: "gangtise_my_conference_list",
        description: "List internal conference recordings in Gangtise vault. Filter by security, institution, category, or date range.",
        endpointKey: "vault.my-conference.list",
        paginated: true,
        inputSchema: {
            from: z.number().int().min(0).optional(),
            keyword: z.string().optional(),
            researchArea: z.string().optional(),
            security: z.string().optional(),
            institution: z.string().optional(),
            category: z.array(z.string()).optional().describe("earningsCall | strategyMeeting | fundRoadshow | expertInterview | fieldResearch | industryConference | etc"),
            startTime: z.string().optional().describe("YYYY-MM-DD HH:mm:ss"),
            endTime: z.string().optional().describe("YYYY-MM-DD HH:mm:ss"),
        },
    },
    {
        name: "gangtise_wechat_message_list",
        description: "List WeChat group messages from Gangtise vault. Filter by chatroom, industry, category, tag, or date range.",
        endpointKey: "vault.wechat-message.list",
        paginated: true,
        inputSchema: {
            from: z.number().int().min(0).optional(),
            keyword: z.string().optional(),
            wechatGroupId: z.array(z.string()).optional().describe("Chatroom IDs from gangtise_wechat_chatroom_list"),
            industry: z.array(z.string()).optional(),
            category: z.array(z.string()).optional().describe("text | image | documents | url"),
            tag: z.array(z.string()).optional().describe("roadShow | research | policy | macro | industry | individual | hot"),
            startTime: z.string().optional().describe("YYYY-MM-DD HH:mm:ss"),
            endTime: z.string().optional().describe("YYYY-MM-DD HH:mm:ss"),
        },
    },
    {
        name: "gangtise_wechat_chatroom_list",
        description: "List available WeChat group chatroom IDs and names.",
        endpointKey: "vault.wechat-chatroom.list",
        paginated: true,
        inputSchema: {
            from: z.number().int().min(0).optional(),
            roomName: z.array(z.string()).optional().describe("Filter by room name(s)"),
        },
    },
];
const downloadSpecs = [
    {
        name: "gangtise_drive_download",
        description: "Download a file from Gangtise vault cloud drive by fileId.",
        endpointKey: "vault.drive.download",
        inputSchema: {
            fileId: z.string().describe("File ID from gangtise_drive_list"),
        },
    },
    {
        name: "gangtise_record_download",
        description: "Download a voice recording transcription. Returns original audio, ASR text, or AI summary.",
        endpointKey: "vault.record.download",
        inputSchema: {
            recordId: z.string().describe("Record ID from gangtise_record_list"),
            contentType: z.string().describe("original | asr | summary (required)"),
        },
    },
    {
        name: "gangtise_my_conference_download",
        description: "Download a conference recording resource. Returns ASR transcript or AI summary.",
        endpointKey: "vault.my-conference.download",
        inputSchema: {
            conferenceId: z.string().describe("Conference ID from gangtise_my_conference_list"),
            contentType: z.string().describe("asr | summary (required; original not supported)"),
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
}
