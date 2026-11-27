import { filterBindRecords } from '../adapters/_shared/bind-records.ts';
import { createHash } from 'node:crypto';
import { uploadMessages } from '../adapters/_shared/message-content.ts';
import type { Message } from '../adapters/types.ts';
import { object } from '../adapters/_shared/transcript.ts';
import { normalizeTaskTrace } from '../adapters/_shared/task-trace.ts';
import { filterAdapterSkills } from '../adapters/skill-filters.ts';

type Trace = { sourceId?: unknown; message?: unknown; raw?: unknown; originSessionId?: unknown; nativeSessionId?: unknown; sessionId?: unknown; nativeTurnId?: unknown; conversationId?: unknown };
type Call = { id: string; name: string; args: unknown };
const parse = (value: unknown): unknown => { if (typeof value !== 'string') return value; try { return JSON.parse(value); } catch { return value; } };
const scope = (row: Trace) => JSON.stringify([row.originSessionId ?? row.nativeSessionId ?? row.sessionId ?? '', row.nativeTurnId ?? row.conversationId ?? '']);
const key = (row: Trace, id: string) => scope(row) + '\0' + id;

/** Stable across retries and independent of upload destinations and batch boundaries. */
export function sourceMessageId(row: Trace): string | undefined {
    if (typeof row.sourceId !== 'string' || !row.sourceId) return undefined;
    return 'memos:' + createHash('sha256').update(JSON.stringify([row.originSessionId ?? row.sessionId ?? row.nativeSessionId ?? '', row.sourceId])).digest('hex');
}

function calls(message: Message): Call[] {
    return [...(Array.isArray(message.tool_calls) ? message.tool_calls : []), ...(Array.isArray(message.content) ? message.content.filter(value => ['tool-call', 'tool_use', 'function_call'].includes(String(object(value).type))) : [])]
        .flatMap(value => {
            const call = object(value), fn = object(call.function);
            const name = fn.name ?? call.name, args = fn.arguments ?? call.arguments ?? call.input;
            return typeof call.id === 'string' && typeof name === 'string' ? [{ id: call.id, name, args }] : [];
        });
}
function unquote(value: string): string {
    if (value.startsWith('"')) { try { return JSON.parse(value); } catch { return value; } }
    return value.startsWith("'") ? value.slice(1, -1).replace(/\\(['\\])/g, '$1') : value;
}
function command(args: Record<string, unknown>): string | undefined {
    const value = args.cmd ?? args.command;
    if (typeof value === 'string') return value;
    if (Array.isArray(value) && value.every(word => typeof word === 'string')) {
        if (/(?:^|\/)(?:ba|z|fi)?sh$/.test(value[0] ?? '') && /^-[a-z]*c/.test(value[1] ?? '')) return value.at(-1);
        return value.map(word => JSON.stringify(word)).join(' ');
    }
    return undefined;
}
function executionCommands(code: string): string[] {
    return [...code.matchAll(/(?:\b(?:cmd|command)|"(?:cmd|command)"|'(?:cmd|command)')\s*:\s*("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')/g)].map(match => unquote(match[1]!));
}
/** Upload-only projection. Original rows, visible thinking and business bodies are never modified. */
export function filterUploadTraces<T extends Trace>(rows: T[], agentType = '', skills?: ReadonlySet<string>): T[] {
    const omitted = new Set<string>(), results = new Map<string, number>();
    const messages = rows.map(row => normalizeTaskTrace('', { sourceId: '', raw: parse(row.raw), message: object(row.message) as Message })?.message ?? { role: '', content: '' });
    for (let index = 0; index < rows.length; index++) {
        const message = messages[index]!, row = rows[index]!;
        if (message.role === 'tool' && typeof message.tool_call_id === 'string') results.set(key(row, message.tool_call_id), index);
    }
    const replacements = new Map<number, Message>();
    for (let index = 0; index < rows.length; index++) for (const call of calls(messages[index]!)) {
        if (!/(?:^|[.:/])exec$/.test(call.name) || omitted.has(key(rows[index]!, call.id))) continue;
        const end = results.get(key(rows[index]!, call.id));
        if (end === undefined || end <= index) continue;
        const code = String(call.args), commands = executionCommands(code);
        if (!commands.length || [...code.matchAll(/\btools\.([\w]+)\s*\(/g)].some(match => match[1] !== 'exec_command')) continue;
        const outputs: string[] = [];
        for (let child = index + 1; child < end; child++) {
            const row = rows[child]!, raw = object(parse(row.raw)), payload = object(raw.payload);
            if (scope(row) !== scope(rows[index]!) || object(payload.item).type !== 'CommandExecution') continue;
            for (const nested of calls(messages[child]!)) {
                if (!commands.includes(command(object(parse(nested.args))) ?? '')) continue;
                const result = results.get(key(row, nested.id));
                if (result !== undefined && result < end && typeof messages[result]!.content === 'string') outputs.push(String(messages[result]!.content));
            }
        }
        if (outputs.length !== commands.length) continue;
        const content = parse(messages[end]!.content);
        if (!Array.isArray(content)) continue;
        const unmatched = [...outputs];
        const remaining = content.filter(value => {
            const block = object(value);
            if (!['text', 'input_text'].includes(String(block.type)) || typeof block.text !== 'string') return true;
            if (/^Script completed\nWall time [\d.]+ seconds\nOutput:\n$/.test(block.text)) return false;
            const parsed = parse(block.text), output = object(parsed);
            if ('wall_time_seconds' in output && 'exit_code' in output && typeof output.output === 'string') {
                const match = unmatched.findIndex(text => text.trimEnd() === String(output.output).trimEnd());
                if (match >= 0) { unmatched.splice(match, 1); return false; }
            }
            return true;
        });
        if (unmatched.length) continue;
        if (!remaining.length) omitted.add(key(rows[index]!, call.id));
        else if (remaining.length !== content.length) replacements.set(end, { ...messages[end]!, content: JSON.stringify(remaining) });
    }
    const filtered = filterAdapterSkills(agentType, filterBindRecords(rows.map((row, index) => ({
        ...row, raw: parse(row.raw), sourceId: typeof row.sourceId === 'string' ? row.sourceId : '',
        nativeSessionId: typeof (row.nativeSessionId ?? row.sessionId) === 'string' ? String(row.nativeSessionId ?? row.sessionId) : undefined,
        nativeTurnId: typeof (row.nativeTurnId ?? row.conversationId) === 'string' ? String(row.nativeTurnId ?? row.conversationId) : undefined,
        message: replacements.get(index) ?? messages[index]!,
    }))), skills);
    return rows.flatMap((row, index) => {
        const message = filtered[index]!.message!;
        if (!['user', 'assistant', 'tool'].includes(message.role)) return [];
        if (typeof message.tool_call_id === 'string' && omitted.has(key(row, message.tool_call_id))) return [];
        const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls.filter(value => !omitted.has(key(row, String(object(value).id)))) : message.tool_calls;
        const content = Array.isArray(message.content) ? message.content.filter(value => {
            const block = object(value);
            if (block.type === 'tool_result') return !omitted.has(key(row, String(block.tool_use_id)));
            return !['tool-call', 'tool_use', 'function_call'].includes(String(block.type)) || !omitted.has(key(row, String(block.id)));
        }) : message.content;
        const changed = toolCalls?.length !== message.tool_calls?.length || Array.isArray(content) && content.length !== (message.content as unknown[]).length;
        if (message.role === 'assistant' && (toolCalls === undefined || Array.isArray(toolCalls) && !toolCalls.length) && (!content || Array.isArray(content) && !content.length) && !message.thinking && !message.reasoning && !message.reasoning_content) return [];
        const normalized = changed ? { ...message, content, ...(toolCalls ? { tool_calls: toolCalls } : {}) } : message;
        const id = normalized.id === undefined ? sourceMessageId(row) : undefined;
        const identified = id ? { ...normalized, id } : normalized;
        return uploadMessages(identified).map(projected => ({ ...row, message: projected }));
    });
}
