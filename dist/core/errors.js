export class CliError extends Error {
    constructor(message) {
        super(message);
        this.name = new.target.name;
    }
}
export class ConfigError extends CliError {
}
export class ValidationError extends CliError {
}
export class DownloadError extends CliError {
}
export class AsyncTimeoutError extends CliError {
    dataId;
    constructor(dataId) {
        super(`Async content not ready after timeout (dataId: ${dataId})`);
        this.dataId = dataId;
        this.name = "AsyncTimeoutError";
    }
}
const ERROR_HINTS = {
    "999999": "Gangtise 系统错误，请稍后重试。",
    "999997": "当前账号未开通该接口权限。",
    "999995": "当前账号积分不足。",
    "900002": "请求缺少 uid。",
    "900001": "请求参数为空或缺少必填项。",
    "8000014": "GANGTISE_ACCESS_KEY 错误。",
    "8000015": "GANGTISE_SECRET_KEY 错误。",
    "8000016": "开发账号状态异常。",
    "8000018": "开发账号已到期。",
    "903301": "今日调用次数已达上限。",
};
export class ApiError extends CliError {
    code;
    statusCode;
    details;
    hint;
    constructor(message, code, statusCode, details) {
        super(message);
        this.code = code;
        this.statusCode = statusCode;
        this.details = details;
        this.hint = code ? ERROR_HINTS[code] : undefined;
    }
}
export function errorMessage(err) {
    if (err instanceof ApiError) {
        return err.hint ? `${err.message} — ${err.hint}` : err.message;
    }
    if (err instanceof Error)
        return err.message;
    return String(err);
}
