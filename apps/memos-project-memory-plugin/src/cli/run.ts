import { serviceRequest } from '../adapters/_shared/client.ts';
import type { BindResult, UnbindResult, SpacesResult, SearchResult } from '../server/service.ts';
export interface CreateResult {
    ok: boolean;
    status: 'CREATED' | 'INVALID_INPUT' | 'CONTEXT_MISSING' | 'UNAVAILABLE' | 'CREATE_UNCERTAIN' | 'BINDING_FAILED';
    data: { spaceId: string; spaceName: string; agentType: string; root: string; projectId: string; scopeId: string; uploadStartsNextTurn: true; overview: string | null } | null;
    error: { message: string; spaceId?: string } | null;
}
export type CliResult = SearchResult | CreateResult | BindResult | UnbindResult | SpacesResult;
export type Request = <T>(path: string, body: unknown) => Promise<T>;
export async function run(args: string[], request: Request = serviceRequest, env: NodeJS.ProcessEnv = process.env): Promise<CliResult> {
    if (args[0] === 'unbind') return unbind(args.slice(1), request, env);
    if (args[0] === 'spaces') return spaces(args.slice(1), request, env);
    if (args[0] === 'bind') return bind(args.slice(1), request, env);
    if (args[0] === 'create') return create(args.slice(1), request);
    const fail = (status: SearchResult['status'], message: string): SearchResult => ({ ok: false, status, data: null, error: { message } });
    if (args[0] !== 'search')
        return fail('INVALID_QUERY', '用法: memos-pm search --session-id <id> --conversation-id <id> --query <text>');
    const params: Record<string, string> = {};
    for (let i = 1; i < args.length; i += 2) {
        const key = args[i]!, value = args[i + 1];
        if (!['--session-id', '--conversation-id', '--query'].includes(key) || value === undefined || params[key] !== undefined)
            return fail('INVALID_QUERY', '参数无效');
        params[key] = value;
    }
    if (!params['--query']?.trim())
        return fail('INVALID_QUERY', '查询内容不能为空');
    if (!params['--session-id'] || !params['--conversation-id'])
        return fail('CONTEXT_MISSING', '缺少当前会话或轮次标识');
    try {
        return await request<SearchResult>('/api/search', { sessionId: params['--session-id'], conversationId: params['--conversation-id'], query: params['--query'] });
    }
    catch {
        return fail('UNAVAILABLE', '项目记忆暂不可用');
    }
}

async function create(args: string[], request: Request): Promise<CreateResult> {
    const fail = (status: CreateResult['status'], message: string): CreateResult => ({ ok: false, status, data: null, error: { message } });
    const params: Record<string, string> = {};
    for (let i = 0; i < args.length; i += 2) {
        const key = args[i]!, value = args[i + 1];
        if (!['--context', '--name', '--domain'].includes(key) || value === undefined || params[key] !== undefined) return fail('INVALID_INPUT', '创建参数无效');
        params[key] = value;
    }
    if (!params['--name']?.trim() || !params['--domain']?.trim()) return fail('INVALID_INPUT', '创建前必须由用户明确 Space 名称和领域');
    if (Array.from(params['--domain'].trim()).length > 24) return fail('INVALID_INPUT', '领域名称须为 1–24 个字符');
    if (!params['--context']?.trim()) return fail('CONTEXT_MISSING', '缺少宿主提供的当前创建上下文');
    try {
        return await request<CreateResult>('/api/create', { context: params['--context'], name: params['--name'].trim(), domain: params['--domain'].trim() });
    } catch { return fail('CREATE_UNCERTAIN', '项目空间创建结果未确认；请核对创建结果，不要自动重试'); }
}

async function bind(args: string[], request: Request, env: NodeJS.ProcessEnv): Promise<BindResult> {
    const fail = (status: BindResult['status'], message: string): BindResult => ({ ok: false, status, data: null, error: { message } });
    if (args.length !== 2 || args[0] !== '--space-id' || !args[1]?.trim())
        return fail('INVALID_INPUT', '用法: memos-pm bind --space-id <Space ID>');
    try {
        const identity = await projectContext(request, env);
        if ('error' in identity) return fail('CONTEXT_MISSING', identity.error);
        const { context } = identity;
        return await request<BindResult>('/api/bind-project', { context, spaceId: args[1].trim() });
    } catch {
        return fail('UNAVAILABLE', '绑定结果未确认，请核对当前项目绑定后重试；未自动重试');
    }
}

async function unbind(args: string[], request: Request, env: NodeJS.ProcessEnv): Promise<UnbindResult> {
    const fail = (status: UnbindResult['status'], message: string): UnbindResult => ({ ok: false, status, data: null, error: { message } });
    if (args.length !== 2 || args[0] !== '--space-id' || !args[1]?.trim())
        return fail('INVALID_INPUT', '用法: memos-pm unbind --space-id <Space ID>');
    try {
        const identity = await projectContext(request, env);
        if ('error' in identity) return fail('CONTEXT_MISSING', identity.error);
        return await request<UnbindResult>('/api/unbind-project', { context: identity.context, spaceId: args[1].trim() });
    } catch {
        return fail('UNAVAILABLE', '解绑结果未确认，请查询当前项目绑定后核对；未自动重试');
    }
}

async function spaces(args: string[], request: Request, env: NodeJS.ProcessEnv): Promise<SpacesResult> {
    const fail = (status: SpacesResult['status'], message: string): SpacesResult => ({ ok: false, status, data: null, error: { message } });
    if (args.length) return fail('INVALID_INPUT', '用法: memos-pm spaces（不需要参数）');
    try {
        const identity = await projectContext(request, env);
        if ('error' in identity) return fail('CONTEXT_MISSING', identity.error);
        return await request<SpacesResult>('/api/project-spaces', { context: identity.context });
    } catch {
        return fail('UNAVAILABLE', '当前项目绑定信息暂不可用');
    }
}

async function projectContext(request: Request, env: NodeJS.ProcessEnv): Promise<{ context: string } | { error: string }> {
    let context = env.MEMOS_PM_BIND_CONTEXT;
    const identities = [
        ...(env.CODEX_THREAD_ID ? [{ agentType: 'codex-cli', nativeSessionId: env.CODEX_THREAD_ID }] : []),
        ...(env.DSH_SESSION_ID ? [{ agentType: 'deepseek-harness', nativeSessionId: env.DSH_SESSION_ID }] : []),
        ...(env.COPILOT_AGENT_SESSION_ID ? [{ agentType: 'copilot-cli', nativeSessionId: env.COPILOT_AGENT_SESSION_ID }] : []),
    ];
    if (env.MEMOS_PM_BIND_SESSION) {
        let identity: unknown;
        try { identity = JSON.parse(env.MEMOS_PM_BIND_SESSION); } catch { return { error: '当前宿主身份无效' }; }
        if (!identity || typeof identity !== 'object' || Array.isArray(identity)
            || Object.keys(identity).sort().join(',') !== 'agentType,nativeSessionId'
            || typeof (identity as Record<string, unknown>).agentType !== 'string'
            || typeof (identity as Record<string, unknown>).nativeSessionId !== 'string')
            return { error: '当前宿主身份无效' };
        identities.push(identity as {agentType: string; nativeSessionId: string});
    }
    if (env.RLM_SESSION_ID) {
        if (!context && !identities.length) {
            const { primeSpaceContext } = await import('../adapters/prime-agent/skill.ts');
            const current = await primeSpaceContext(env, request);
            return current ? { context: current } : { error: '当前宿主没有有效用户轮' };
        }
        identities.push({ agentType: 'prime-agent', nativeSessionId: env.RLM_SESSION_ID });
    }
    const unique = [...new Map(identities.map(identity => [JSON.stringify([identity.agentType, identity.nativeSessionId]), identity])).values()];
    if (unique.length > 1 || !context && !unique.length)
        return { error: '缺少唯一的当前宿主身份，请使用宿主交付的本轮项目空间入口' };
    if (unique.length) {
        const current = (await request<{context?: string}>('/api/bind-context', unique[0])).context;
        if (context && current !== context)
            return { error: '继承的绑定环境与当前宿主身份不一致，请使用本轮项目空间入口' };
        context = current;
    }
    if (!context) return { error: '当前会话没有有效用户轮，请使用本轮项目空间入口' };
    return { context };
}
