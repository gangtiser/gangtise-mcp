import { AsyncLocalStorage } from "node:async_hooks"

/** 把 MCP 请求的取消信号带进整条调用链——分页扇出、全市场分片、重试退避、异步轮询的
 *  等待，以及 HTTP 请求本身——而不用给每个 handler 与 client 方法都多加一个参数。
 *
 *  工具 handler 在入口 `runWithRequestContext`，下游按需 `currentSignal()` 读取。没有上下文
 *  （直接调用 client 的测试、脚本）时返回 undefined，行为与不带信号时完全一致。 */
const store = new AsyncLocalStorage<{ signal?: AbortSignal }>()

export function runWithRequestContext<T>(signal: AbortSignal | undefined, fn: () => Promise<T>): Promise<T> {
  return store.run({ signal }, fn)
}

export function currentSignal(): AbortSignal | undefined {
  return store.getStore()?.signal
}
