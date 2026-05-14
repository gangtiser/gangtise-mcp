#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { GangtiseClient } from "./core/client.js";
import { loadConfig } from "./core/config.js";
import { createGangtiseMcpServer } from "./server.js";
const config = loadConfig();
const client = new GangtiseClient(config);
const server = createGangtiseMcpServer(client, { asyncTimeoutMs: config.asyncTimeoutMs });
await server.connect(new StdioServerTransport());
