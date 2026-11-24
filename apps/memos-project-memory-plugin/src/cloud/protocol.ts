import type { Config } from '../config/config.ts';

export type CloudConnection = Pick<Config, 'apiMode' | 'baseUrl' | 'authMode' | 'apiKey' | 'cloudProjectId' | 'userId'>;
export interface PreparedRequest {
    url: string;
    method: 'GET' | 'POST';
    headers: Record<string, string>;
    body?: string;
}

const algorithmPaths: Record<string, string> = {
    'create/space': 'create_space', 'get/space': 'get_space', 'list/domains': 'list_domains',
    'add/message': 'add', 'get/status': 'scheduler/status', 'search/memory': 'search', 'get/memory': 'get_memory',
};
function object(value: unknown): Record<string, any> {
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : {};
}

/** Canonical business input stays unchanged; only the selected transport is projected. */
export function requestBody(config: CloudConnection, endpoint: string, body: unknown): Record<string, unknown> {
    const input = object(body);
    if (config.apiMode !== 'algorithm') return { ...input };
    const result = { ...input };
    if (endpoint === 'create/space') {
        result.project_id = config.cloudProjectId;
        if (Array.isArray(input.domains)) result.domains = input.domains.map(value => {
            const { domain, ...rest } = object(value); return { ...rest, name: domain };
        });
    }
    if (endpoint === 'add/message' || endpoint === 'search/memory') {
        if (input.conversation_id !== undefined) { result.session_id = input.conversation_id; delete result.conversation_id; }
    }
    if (endpoint === 'add/message') {
        result.project_id = config.cloudProjectId;
        if (input.async_mode !== undefined) result.async_mode = input.async_mode ? 'async' : 'sync';
        if (Array.isArray(input.messages)) result.messages = input.messages.map(value => {
            const message = object(value), { id, ...rest } = message;
            return id === undefined ? { ...rest } : { ...rest, message_id: id };
        });
    }
    if (endpoint === 'get/memory' && input.size !== undefined) { result.page_size = input.size; delete result.size; }
    return result;
}

/** Used by both the packer and the sender, including protocol-added fields. */
export function requestBodyBytes(config: CloudConnection, canonicalBody: unknown): number {
    return Buffer.byteLength(JSON.stringify(requestBody(config, 'add/message', canonicalBody)), 'utf8');
}

export function prepareRequest(config: CloudConnection, endpoint: string, body: unknown): PreparedRequest {
    if (!Object.hasOwn(algorithmPaths, endpoint)) throw new Error('未知云服务操作：' + endpoint);
    const path = config.apiMode === 'algorithm' ? algorithmPaths[endpoint]! : endpoint;
    const url = new URL(config.baseUrl.replace(/\/+$/, '') + '/' + path);
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    const authMode = config.authMode ?? 'token';
    if (authMode !== 'none') headers.Authorization = (authMode === 'bearer' ? 'Bearer ' : 'Token ') + config.apiKey;
    if (config.apiMode === 'algorithm' && endpoint === 'get/status') {
        const input = object(body);
        url.searchParams.set('user_id', String(input.user_id ?? config.userId));
        url.searchParams.set('task_id', String(input.task_id ?? ''));
        return { url: url.href, method: 'GET', headers };
    }
    return { url: url.href, method: 'POST', headers, body: JSON.stringify(requestBody(config, endpoint, body)) };
}

/** Array response selection is by explicit identity, never array position. */
export function responseData(config: CloudConnection, endpoint: string, body: unknown, data: unknown): Record<string, any> {
    if (config.apiMode === 'algorithm' && (endpoint === 'add/message' || endpoint === 'get/status')) {
        if (!Array.isArray(data)) throw new Error('MemOS ' + endpoint + ' 响应缺少任务数组');
        const matches = data.filter(value => endpoint === 'add/message' ? object(value).memory_view === 'project' : object(value).task_id === object(body).task_id);
        if (matches.length !== 1) throw new Error(endpoint === 'add/message' ? 'MemOS 响应缺少唯一 project 接收结果' : 'MemOS 响应缺少唯一匹配任务');
        data = matches[0];
    }
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('MemOS ' + endpoint + ' data 格式无效');
    const result = { ...object(data) };
    if (config.apiMode === 'algorithm') {
        if (endpoint === 'list/domains' && Array.isArray(result.domains)) result.domains = result.domains.map(value => {
            const { name, ...rest } = object(value); return { ...rest, domain: name };
        });
        if (endpoint === 'get/status' && result.status === 'in_progress') result.status = 'running';
    }
    return result;
}

export function validateResponse(endpoint: string, body: unknown, data: Record<string, any>): void {
    if (endpoint === 'search/memory' && Array.isArray(data.degraded) && data.degraded.includes('project'))
        throw new Error('项目记忆检索通道暂不可用');
    if (['get/memory', 'search/memory'].includes(endpoint) && !Array.isArray(data.topic_detail_list)) throw new Error('MemOS ' + endpoint + ' 响应缺少主题列表');
    if (endpoint === 'list/domains' && (!Array.isArray(data.domains) || data.domains.length > 20 || data.domains.some((value: unknown) => {
        const item = object(value); return typeof item.domain !== 'string' || !item.domain.trim();
    }))) throw new Error('MemOS list/domains 响应领域列表格式无效');
    if (endpoint === 'get/status') {
        if (data.task_id !== undefined && data.task_id !== object(body).task_id) throw new Error('MemOS get/status 返回的任务 ID 不匹配');
        if (!['running', 'completed', 'failed'].includes(data.status)) throw new Error('MemOS get/status 响应处理状态无效');
        const project = object(object(data.memory_views).project);
        if (project.open_episode_messages !== undefined && (!Number.isSafeInteger(project.open_episode_messages) || project.open_episode_messages < 0)) throw new Error('MemOS get/status 开放消息数无效');
        if (project.memory_ids !== undefined && (!Array.isArray(project.memory_ids) || project.memory_ids.some((value: unknown) => typeof value !== 'string' || !value.trim()))) throw new Error('MemOS get/status 主题 ID 无效');
    }
    if (endpoint === 'add/message' && (data.success !== true || typeof data.task_id !== 'string' || !data.task_id.trim())) throw new Error('上传缺少接收确认或task_id');
    if (endpoint === 'create/space' && (typeof data.space_id !== 'string' || !data.space_id.trim())) throw new Error('创建响应缺少有效的 Space ID，请核对云端结果后再创建');
    if (endpoint === 'get/space' && (typeof data.space_id !== 'string' || !data.space_id.trim() || data.space_id !== object(body).space_id)) throw new Error('空间响应缺少匹配的 Space ID');
}
