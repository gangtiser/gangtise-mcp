import { Agent } from "undici";
import { ApiError } from "./errors.js";
let cachedDispatcher = null;
export function getDispatcher() {
    if (!cachedDispatcher) {
        cachedDispatcher = new Agent({
            keepAliveTimeout: 60_000,
            keepAliveMaxTimeout: 600_000,
            connections: 16,
            pipelining: 1,
        });
    }
    return cachedDispatcher;
}
export async function runWithConcurrency(items, concurrency, fn) {
    if (items.length === 0)
        return [];
    const limit = Math.max(1, Math.min(concurrency, items.length));
    const results = new Array(items.length);
    let next = 0;
    async function worker() {
        while (true) {
            const index = next++;
            if (index >= items.length)
                return;
            results[index] = await fn(items[index], index);
        }
    }
    await Promise.all(Array.from({ length: limit }, () => worker()));
    return results;
}
const RETRYABLE_HTTP_STATUS = new Set([429, 500, 502, 503, 504]);
const RETRYABLE_NETWORK_CODES = new Set(["ECONNRESET", "ETIMEDOUT", "ENOTFOUND", "EAI_AGAIN", "UND_ERR_SOCKET", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT"]);
const RETRYABLE_API_CODES = new Set(["999999"]);
function isRetryableError(error) {
    if (error && typeof error === "object" && error.__retryable === true) {
        return true;
    }
    if (error instanceof ApiError) {
        if (error.statusCode != null && RETRYABLE_HTTP_STATUS.has(error.statusCode))
            return true;
        if (error.code && RETRYABLE_API_CODES.has(error.code))
            return true;
        return false;
    }
    if (error && typeof error === "object" && "code" in error) {
        const code = String(error.code);
        if (RETRYABLE_NETWORK_CODES.has(code))
            return true;
    }
    if (error instanceof Error && /timeout|ETIMEDOUT|ECONNRESET|socket hang up/i.test(error.message)) {
        return true;
    }
    return false;
}
export function markRetryable(error) {
    return Object.assign(error, { __retryable: true });
}
export async function withRetry(fn, options = {}) {
    const retries = options.retries ?? 2;
    const baseDelay = options.baseDelayMs ?? 400;
    const maxDelay = options.maxDelayMs ?? 4_000;
    let attempt = 0;
    while (true) {
        try {
            return await fn();
        }
        catch (error) {
            if (attempt >= retries || !isRetryableError(error))
                throw error;
            const jitter = Math.random() * baseDelay;
            const delay = Math.min(maxDelay, baseDelay * 2 ** attempt + jitter);
            options.onRetry?.(attempt + 1, error, delay);
            await new Promise(resolve => setTimeout(resolve, delay));
            attempt++;
        }
    }
}
let verboseEnabled = process.env.GANGTISE_VERBOSE === "1" || process.env.GANGTISE_VERBOSE === "true";
export function setVerbose(value) {
    verboseEnabled = value;
}
export function isVerbose() {
    return verboseEnabled;
}
export function logTiming(label, durationMs, extra) {
    if (!verboseEnabled)
        return;
    const ms = durationMs.toFixed(0).padStart(5, " ");
    process.stderr.write(`[gangtise] ${ms}ms ${label}${extra ? ` (${extra})` : ""}\n`);
}
