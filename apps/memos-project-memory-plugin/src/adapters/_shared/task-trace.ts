import type { Message, TraceInput } from '../types.ts';
import { asMessage, object } from './transcript.ts';

/** Only task messages enter storage/upload; host bookkeeping has no fallback message. */
export function normalizeTaskTrace(agentType: string, record: TraceInput): TraceInput | undefined {
  const raw = object(record.raw), data = object(raw.data);
  let message: Message | undefined;
  let sourceId = record.sourceId;
  if (agentType === 'deepseek-harness') {
    if (raw.type === 'tool/call') {
      message = toolCall(data.callId, data.name, data.arguments);
    } else if (raw.type === 'user/message') {
      message = asMessage(data);
    } else if (raw.type === 'assistant/message' || raw.type === 'tool/result') {
      message = asMessage(data.message ?? data);
    } else if (!raw.type) {
      message = asMessage(raw);
    } else {
      return undefined;
    }
    if (message?.role === 'user' && object(message.source).kind !== 'user') return undefined;
    if (typeof message?.id === 'string') sourceId = `message:${message.id}`;
  } else {
    message = asMessage(raw) ?? record.message;
    if (agentType === 'pi' || agentType === 'prime-agent') message = executionMessage(raw) ?? message;
  }
  if (!message) return undefined;
  const candidates = [raw, object(raw.message), object(raw.payload), message];
  if (candidates.some(isInjected)) return undefined;
  message = { ...message, role: message.role === 'toolResult' ? 'tool' : message.role };
  if (!['user', 'assistant', 'tool'].includes(message.role)) return undefined;
  // Claude-style transcript tool results use the user role but are execution output.
  if (message.role === 'user' && Array.isArray(message.content) && message.content.length && message.content.every(part => object(part).type === 'tool_result')) {
    const blocks = message.content;
    message = { ...message, role: 'tool', ...(blocks.length === 1 ? { tool_call_id: object(blocks[0]).tool_use_id } : {}) };
  }
  if (message.role === 'tool' && !message.tool_call_id && typeof message.toolCallId === 'string') message.tool_call_id = message.toolCallId;
  let retainedRaw = record.raw;
  if (agentType === 'prime-agent' && message.role === 'user') {
    message = { ...message, content: withoutPrimeContext(message.content) };
    // Keep the stored original consistent: replay wrappers must not retain injected text.
    if (typeof object(raw.message).role === 'string') retainedRaw = { ...raw, message: { ...object(raw.message), content: message.content } };
    else if (typeof raw.role === 'string') retainedRaw = { ...raw, content: message.content };
  }
  return { ...record, sourceId, raw: retainedRaw, message };
}

function isInjected(value: Record<string, unknown>): boolean {
  const source = object(value.source).kind ?? value.source;
  return value.isMeta === true || value.isSynthetic === true || value.synthetic === true
    || value.customType === 'memos-project-memory'
    || ['runtime-context', 'memos-project-memory', 'skill-catalog', 'time-context', 'system-prompt', 'extension'].includes(String(source));
}

function toolCall(id: unknown, name: unknown, args: unknown): Message | undefined {
  if (typeof id !== 'string' || typeof name !== 'string') return undefined;
  return { role: 'assistant', content: '', tool_calls: [{ id, type: 'function', function: { name, arguments: typeof args === 'string' ? args : JSON.stringify(args ?? {}) } }] };
}

/** Pi/Prime emit tool execution events outside message envelopes. */
export function executionMessage(raw: Record<string, unknown>): Message | undefined {
  if (raw.type === 'tool_execution_start') return toolCall(raw.toolCallId, raw.toolName, raw.args);
  if (raw.type !== 'tool_execution_end') return undefined;
  const result = object(raw.result);
  const content = result.content ?? raw.result ?? '';
  return { role: 'tool', content: typeof content === 'string' || Array.isArray(content) ? content : JSON.stringify(content), tool_call_id: raw.toolCallId,
    ...(raw.toolName !== undefined ? { name: raw.toolName } : {}), ...(raw.args !== undefined ? { tool_input: raw.args } : {}), ...(raw.isError !== undefined ? { isError: raw.isError } : {}) };
}

function withoutPrimeContext(content: Message['content']): Message['content'] {
  const strip = (text: string) => text.replace(/\n*<memos-project-memory-context>[\s\S]*?<\/memos-project-memory-context>/g, '');
  if (typeof content === 'string') return strip(content);
  return content.map(part => {
    const block = object(part);
    return block.type === 'text' && typeof block.text === 'string' ? { ...block, text: strip(block.text) } : part;
  });
}
