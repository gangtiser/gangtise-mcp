import { ApiError } from "./errors.js";
import { AsyncTimeoutError } from "./errors.js";
export const POLL_INITIAL_DELAY_MS = 5_000;
export const POLL_MAX_DELAY_MS = 30_000;
function nextDelayMs(attempt) {
    // 5s, 8s, 13s, 20s, 30s, 30s, ...
    const grown = POLL_INITIAL_DELAY_MS * 1.6 ** (attempt - 1);
    return Math.min(POLL_MAX_DELAY_MS, Math.round(grown));
}
function isAsyncPending(error) {
    return error instanceof ApiError && error.code === "410110";
}
export async function pollAsyncContent(client, getContentEndpoint, dataId, timeoutMs = 60_000) {
    const deadline = Date.now() + timeoutMs;
    let attempt = 0;
    while (true) {
        attempt++;
        try {
            const result = await client.call(getContentEndpoint, { dataId });
            if (result?.content != null) {
                return { content: result.content };
            }
        }
        catch (error) {
            if (error instanceof ApiError && error.code === "410111") {
                throw error;
            }
            if (!isAsyncPending(error))
                throw error;
        }
        const now = Date.now();
        if (now >= deadline) {
            throw new AsyncTimeoutError(dataId);
        }
        const delay = Math.min(nextDelayMs(attempt), deadline - now);
        await new Promise(resolve => setTimeout(resolve, delay));
        if (Date.now() >= deadline) {
            throw new AsyncTimeoutError(dataId);
        }
    }
}
