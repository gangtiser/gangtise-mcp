import fs from "node:fs/promises";
import path from "node:path";
import { ConfigError } from "./errors.js";
export async function readTokenCache(filePath) {
    try {
        const content = await fs.readFile(filePath, "utf8");
        const parsed = JSON.parse(content);
        if (parsed && typeof parsed === "object" && typeof parsed.accessToken === "string" && typeof parsed.expiresAt === "number") {
            return parsed;
        }
        return null;
    }
    catch {
        return null;
    }
}
export async function writeTokenCache(filePath, cache) {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, JSON.stringify(cache, null, 2), { encoding: "utf8", mode: 0o600 });
}
export function isTokenCacheValid(cache, bufferSeconds = 300) {
    if (!cache?.accessToken || !cache.expiresAt) {
        return false;
    }
    const now = Math.floor(Date.now() / 1000);
    return cache.expiresAt - bufferSeconds > now;
}
export function normalizeToken(token) {
    return token.startsWith("Bearer ") ? token : `Bearer ${token}`;
}
export function requireAccessCredentials(accessKey, secretKey) {
    if (!accessKey || !secretKey) {
        throw new ConfigError("Missing GANGTISE_ACCESS_KEY or GANGTISE_SECRET_KEY");
    }
    return { accessKey, secretKey };
}
