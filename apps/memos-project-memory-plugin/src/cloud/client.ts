import { connectionError, type Configuration } from '../config/config.ts';
import { prepareRequest, responseData, validateResponse } from './protocol.ts';

export interface CloudContext {
    sessionId?: string | null;
    conversationId?: string | null;
    agentType?: string;
    projectId?: string | null;
    projectName?: string;
    scopeId?: string;
    batchId?: string;
    spaceId?: string;
    taskId?: string;
}
export interface CloudFailure {
    endpoint: string;
    method: 'GET' | 'POST';
    url?: string;
    apiMode?: 'algorithm' | 'engineering';
    reason?: string;
    kind: 'http' | 'business' | 'timeout' | 'network' | 'response' | 'processing';
    message: string;
    httpStatus: number | null;
    businessCode: string | number | null;
    responseBody: string | null;
    context: CloudContext;
}
export function redactCloudText(text: string, apiKey: string): string {
    const safe = apiKey ? text.replaceAll(apiKey, '[REDACTED]') : text;
    try {
        let changed = false;
        const value = JSON.parse(safe, (key, value) => {
            if (/^(authorization|api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret|token)$/i.test(key)) { changed = true; return '[REDACTED]'; }
            return value;
        });
        return changed ? JSON.stringify(value, null, 2) : safe;
    } catch {
        return safe.replace(/((?:Authorization|api[_-]?key|access[_-]?token|password|secret)\s*[:=]\s*)[^\r\n]+/gi, '$1[REDACTED]');
    }
}
class CloudRequestError extends Error {
    kind: CloudFailure['kind'];
    constructor(message: string, kind: CloudFailure['kind']) { super(message); this.kind = kind; }
}
export class CloudClient {
    config: Configuration;
    private report?: (failure: CloudFailure) => void;
    constructor(config: Configuration, report?: (failure: CloudFailure) => void) { this.config = config; this.report = report; }
    async call<T = Record<string, unknown>>(endpoint: string, body: unknown, context: CloudContext = {}): Promise<T> {
        const config = { ...this.config.value }, configurationError = connectionError(config);
        if (configurationError) throw new Error(configurationError);
        const { apiKey } = config, request = prepareRequest(config, endpoint, body), identity = { ...context };
        let responseBody: string | null = null, httpStatus: number | null = null, businessCode: string | number | null = null, reason: string | undefined;
        const report = (kind: CloudFailure['kind'], message: string) => this.report?.({
            endpoint, method: request.method, url: redactCloudText(request.url, apiKey), apiMode: config.apiMode,
            ...(reason ? { reason } : {}), kind, message: redactCloudText(message, apiKey), httpStatus, businessCode,
            responseBody: responseBody === null ? null : redactCloudText(responseBody, apiKey), context: identity,
        });
        try {
            const response = await fetch(request.url, { method: request.method, headers: request.headers, body: request.body, redirect: 'error', signal: AbortSignal.timeout(15000) });
            httpStatus = response.status;
            responseBody = await response.text();
            let result: Record<string, any> | undefined;
            try { const parsed = JSON.parse(responseBody); if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) result = parsed; } catch { /* Keep non-JSON gateway responses. */ }
            if (typeof result?.code === 'number' || typeof result?.code === 'string') businessCode = result.code;
            if (typeof result?.reason === 'string') reason = redactCloudText(result.reason, apiKey);
            const detail = typeof result?.message === 'string' ? ': ' + result.message : '';
            if (!response.ok) throw new CloudRequestError('MemOS ' + endpoint + ' HTTP ' + response.status + detail, 'http');
            if (!result || typeof result.code !== 'number') throw new CloudRequestError('MemOS ' + endpoint + ' 响应格式无效', 'response');
            if (result.code !== (config.apiMode === 'algorithm' ? 200 : 0)) throw new CloudRequestError('MemOS ' + endpoint + ' 业务错误 ' + result.code + detail, 'business');
            if (!Object.hasOwn(result, 'data')) throw new CloudRequestError('MemOS ' + endpoint + ' 响应缺少 data', 'response');
            let data: Record<string, any>;
            try { data = responseData(config, endpoint, body, result.data); validateResponse(endpoint, body, data); }
            catch (error) { throw new CloudRequestError(error instanceof Error ? error.message : String(error), 'response'); }
            if (endpoint === 'get/status' && data.status === 'failed') report('processing', 'MemOS 云端任务处理失败');
            return data as T;
        } catch (error) {
            const name = error instanceof Error ? error.name : '';
            const kind = error instanceof CloudRequestError ? error.kind : ['AbortError', 'TimeoutError'].includes(name) ? 'timeout' : 'network';
            const message = error instanceof Error ? error.message : String(error);
            report(kind, message);
            const uncertain = ['add/message', 'create/space'].includes(endpoint) && (['network', 'timeout', 'response'].includes(kind) || httpStatus !== null && httpStatus >= 500);
            throw Object.assign(new Error(redactCloudText(message, apiKey), { cause: error }), { kind, httpStatus, businessCode, reason, uncertain });
        }
    }
    async probe(spaceId?: string): Promise<{ ok: boolean; reachable: boolean; verified: boolean; message: string; apiMode: string; baseUrl: string }> {
        const config = { ...this.config.value }, common = { apiMode: config.apiMode, baseUrl: config.baseUrl };
        const configurationError = connectionError(config);
        if (configurationError) return { ...common, ok: false, reachable: false, verified: false, message: configurationError };
        try {
            if (spaceId?.trim()) {
                await this.call('get/space', { space_id: spaceId.trim() });
                return { ...common, ok: true, reachable: true, verified: true, message: '连接、鉴权及空间读取验证成功' };
            }
            const headers: Record<string, string> = {};
            if (config.authMode !== 'none') headers.Authorization = (config.authMode === 'bearer' ? 'Bearer ' : 'Token ') + config.apiKey;
            const response = await fetch(config.baseUrl, { method: 'GET', headers, redirect: 'error', signal: AbortSignal.timeout(15000) });
            await response.body?.cancel();
            return { ...common, ok: false, reachable: true, verified: false, message: '已收到 HTTP ' + response.status + ' 响应；尚未验证接口协议及鉴权，可填写已有 Space ID 进行只读验证' };
        } catch (error) {
            const status = typeof error === 'object' && error !== null && 'httpStatus' in error ? error.httpStatus : null;
            return { ...common, ok: false, reachable: typeof status === 'number', verified: false, message: redactCloudText(error instanceof Error ? error.message : String(error), config.apiKey) };
        }
    }
}
