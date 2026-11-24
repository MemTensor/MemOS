import type { Message, TraceInput } from '../types.ts';
import { asMessage, object, textField } from '../_shared/transcript.ts';

/** WorkBuddy stores execution events outside ordinary role-bearing messages. */
export function normalizeWorkBuddyRecord(record: TraceInput): TraceInput {
    const raw = object(record.raw);
    const nativeMessage = asMessage(raw);
    const unwrap = raw.type === 'message' && raw.role === 'user'
        && (!record.message || JSON.stringify(record.message.content) === JSON.stringify(nativeMessage?.content));
    let message: Message | undefined = record.message ?? nativeMessage;
    if (!message && raw.type === 'function_call') {
        const id = textField(raw, 'callId'), name = textField(raw, 'name');
        if (id && name) message = { role: 'assistant', content: '', tool_calls: [{ id, type: 'function', function: {
            name, arguments: typeof raw.arguments === 'string' ? raw.arguments : JSON.stringify(raw.arguments ?? {}),
        } }] };
    } else if (!message && raw.type === 'function_call_result') {
        const id = textField(raw, 'callId');
        if (id) message = { role: 'tool', tool_call_id: id,
            content: typeof raw.output === 'string' ? raw.output : raw.output === undefined ? '' : JSON.stringify(raw.output),
            ...(typeof raw.name === 'string' ? { name: raw.name } : {}),
            ...(typeof raw.isError === 'boolean' ? { isError: raw.isError } : raw.status === 'failed' ? { isError: true } : {}),
        };
    } else if (!message && raw.type === 'reasoning') {
        const visible = reasoningContent(raw.content);
        const content = visible.length ? visible : reasoningContent(raw.rawContent);
        if (content.length) message = { role: 'assistant', content };
    }
    const nativeTurnId = textField(object(raw.providerData), 'conversationRequestId') ?? textField(raw, 'generation_id') ?? record.nativeTurnId;
    let sourceId = record.sourceId;
    const sessionId = textField(raw, 'sessionId', 'session_id');
    if (message) {
        const original = message;
        let content = message.content;
        if (message.role !== 'tool') {
            let unwrapped = false;
            const clean = (text: string) => {
                if (!unwrap || unwrapped) return text;
                const body = userText(text);
                if (body !== text) unwrapped = true;
                return body;
            };
            if (typeof content === 'string') content = clean(content);
            else if (Array.isArray(content)) content = content.map(value => {
                const block = object(value);
                if (!['text', 'input_text', 'output_text'].includes(String(block.type)) || typeof block.text !== 'string') return value;
                const { providerData: _provider, _meta: _meta, __codebuddyLocal: _local, ...body } = block;
                return { ...body, text: clean(block.text) };
            });
        }
        message = { role: message.role, content };
        for (const key of ['tool_calls', 'tool_call_id', 'name', 'tool_input', 'isError', 'source', 'customType', 'isMeta', 'isSynthetic', 'synthetic', 'thinking', 'reasoning', 'reasoning_content']) {
            if (original[key] !== undefined) message[key] = original[key];
        }
        if (sessionId && nativeTurnId) {
            const prefix = `workbuddy:${sessionId}:${nativeTurnId}`;
            const hook = String(raw.hook_event_name ?? '').toLowerCase();
            if (message.role === 'user' && (object(raw.providerData).startsNewUserRequest === true || hook === 'userpromptsubmit')) sourceId = `${prefix}:user`;
            else if (message.role === 'tool' && typeof message.tool_call_id === 'string') sourceId = `${prefix}:result:${message.tool_call_id}`;
            else if (raw.type === 'function_call' && typeof raw.callId === 'string') sourceId = `${prefix}:call:${raw.callId}`;
            else if (message.role === 'assistant' && ['stop', 'sessionend'].includes(hook)) sourceId = `${prefix}:answer`;
            else if (typeof raw.id === 'string') sourceId = `${prefix}:${raw.type}:${raw.id}`;
        }
    }
    return { ...record, sourceId, message, nativeTurnId };
}

/** Only the complete native prefix is a host envelope; the user query is opaque. */
function userText(text: string): string {
    let rest = text.trimStart();
    if (!/^<system-reminder data-role="(?:user-context|additional-data)">/.test(rest)) return text;
    while (rest.startsWith('<system-reminder')) {
        const match = /^<system-reminder data-role="(?:user-context|additional-data)">[\s\S]*?<\/system-reminder>\s*/.exec(rest);
        if (!match) throw new Error('WorkBuddy 用户消息封装不完整，不能安全提取任务正文');
        rest = rest.slice(match[0].length);
    }
    if (!rest.startsWith('<user_query>') || !rest.trimEnd().endsWith('</user_query>'))
        throw new Error('WorkBuddy 用户消息封装缺少完整 user_query，不能安全提取任务正文');
    return rest.trimEnd().slice('<user_query>'.length, -'</user_query>'.length);
}

function reasoningContent(value: unknown): { type: string; text: string }[] {
    if (typeof value === 'string') return value.trim() ? [{ type: 'reasoning', text: value }] : [];
    if (!Array.isArray(value)) return [];
    return value.flatMap(value => {
        const block = object(value);
        if (!['thinking', 'reasoning', 'reasoning_text', 'summary_text'].includes(String(block.type))) return [];
        const text = block.thinking ?? block.text;
        return typeof text === 'string' && text.trim() ? [{ type: 'reasoning', text }] : [];
    });
}
