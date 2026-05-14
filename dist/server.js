import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerLookupTools } from "./tools/lookup.js";
import { registerReferenceTools } from "./tools/reference.js";
import { registerInsightTools } from "./tools/insight.js";
import { registerQuoteTools } from "./tools/quote.js";
import { registerFundamentalTools } from "./tools/fundamental.js";
import { registerAiTools } from "./tools/ai.js";
import { registerVaultTools } from "./tools/vault.js";
export function createGangtiseMcpServer(client, options = {}) {
    const server = new McpServer({ name: "gangtise-mcp", version: "0.1.0" });
    const asyncTimeoutMs = options.asyncTimeoutMs ?? 60_000;
    registerLookupTools(server, client);
    registerReferenceTools(server, client);
    registerInsightTools(server, client);
    registerQuoteTools(server, client);
    registerFundamentalTools(server, client);
    registerAiTools(server, client, { asyncTimeoutMs });
    registerVaultTools(server, client);
    return server;
}
