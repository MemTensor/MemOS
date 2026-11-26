import { serviceRequest } from '../_shared/client.ts';
import type { SearchResult } from '../../server/service.ts';

async function search(args: string[]): Promise<SearchResult> {
  const fail = (status: SearchResult['status'], message: string): SearchResult =>
    ({ ok: false, status, data: null, error: { message } });
  const [query] = args;
  if (args.length !== 1 || !query?.trim()) return fail('INVALID_QUERY', '请只传入一条非空查询内容');
  const nativeSessionId = process.env.MCP_VM_CONVERSATION_ID;
  const answerId = process.env.DOUBAO_OFFICE_ANSWER_MESSAGE_ID;
  if (!nativeSessionId || !/^\d+$/.test(nativeSessionId) || !answerId || !/^\d+$/.test(answerId))
    return fail('CONTEXT_MISSING', '请在当前豆包工作会话的本机工具中执行查询');
  try {
    return await serviceRequest<SearchResult>('/api/doubao/search', { nativeSessionId, answerId, query });
  } catch {
    return fail('UNAVAILABLE', '项目记忆本地服务暂不可用');
  }
}

const result = await search(process.argv.slice(2));
process.stdout.write(JSON.stringify(result) + '\n');
if (!result.ok) process.exitCode = 1;
