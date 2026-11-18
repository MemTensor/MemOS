#!/usr/bin/env node
import { serviceRequest } from '../adapters/_shared/client.ts';
import type { SearchResult } from '../server/service.ts';
export async function run(args: string[]): Promise<SearchResult> {
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
        return await serviceRequest<SearchResult>('/api/search', { sessionId: params['--session-id'], conversationId: params['--conversation-id'], query: params['--query'] });
    }
    catch {
        return fail('UNAVAILABLE', '项目记忆暂不可用');
    }
}
const result = await run(process.argv.slice(2));
process.stdout.write(JSON.stringify(result) + '\n');
process.exitCode = result.ok ? 0 : 1;
