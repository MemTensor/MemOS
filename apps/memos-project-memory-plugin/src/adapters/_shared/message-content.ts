import type { Message } from '../types.ts';
import { object } from './transcript.ts';

function toolMessage(message: Message): boolean {
  return message.role === 'tool' || message.role === 'toolResult' || message.tool_calls !== undefined && (!Array.isArray(message.tool_calls) || !!message.tool_calls.length)
    || Array.isArray(message.content) && message.content.some(part =>
      ['tool_use', 'tool-call', 'tool_call', 'toolCall', 'tool_result', 'tool-result', 'function_call', 'function_call_output'].includes(String(object(part).type)));
}
function text(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(text).filter(part => part.trim()).join('\n');
  const part = object(value);
  if (part.type === 'redacted_thinking') return '';
  return text(part.thinking ?? part.text ?? part.summary ?? part.content ?? '');
}
function prose(message: Message): string {
  return [text(message.reasoning_content ?? message.thinking ?? message.reasoning), text(message.content)]
    .filter(part => part.trim()).join('\n');
}

/** Empty prose is not a task record; tool operations remain meaningful even with empty output. */
export function hasTaskContent(message: Message): boolean {
  return toolMessage(message) || !!prose(message).trim();
}

/** Legacy one-to-one body comparison for native reconciliation; uploadMessages owns transport projection. */
export function compactUploadMessage(message: Message): Message | undefined {
  if (toolMessage(message)) return message;
  const content = prose(message);
  return content.trim() ? { role: message.role, content } : undefined;
}

function uploadMeta(message: Message): Record<string, unknown> {
  return Object.fromEntries(['id', 'chat_time', 'role_id', 'role_name'].filter(key => message[key] !== undefined).map(key => [key, message[key]]));
}
function callBlock(value: unknown): boolean {
  return ['tool_use', 'tool-call', 'tool_call', 'toolCall', 'function_call', 'custom_tool_call'].includes(String(object(value).type));
}
function resultBlock(value: unknown): boolean {
  return ['tool_result', 'tool-result', 'toolResult', 'function_call_output', 'custom_tool_call_output'].includes(String(object(value).type));
}
function uploadCall(value: unknown): Record<string, unknown> {
  const call = object(value), fn = object(call.function);
  const args = Object.hasOwn(fn, 'arguments') ? fn.arguments : Object.hasOwn(call, 'arguments') ? call.arguments : Object.hasOwn(call, 'input') ? call.input : call.args;
  return { id: call.id ?? call.call_id ?? call.toolCallId,
    type: callBlock(call) || call.type === undefined ? 'function' : call.type,
    function: { name: fn.name ?? call.name ?? call.toolName, arguments: typeof args === 'string' ? args : JSON.stringify(args) },
    ...(call.status === 'incomplete' && (fn.name ?? call.name ?? call.toolName) === 'skill' ? { status: 'incomplete' } : {}) };
}
function uploadResult(value: Record<string, unknown>, fallbackId?: unknown): Message {
  const body = Object.hasOwn(value, 'content') ? value.content : Object.hasOwn(value, 'output') ? value.output : Object.hasOwn(value, 'result') ? value.result : '';
  const failed = value.isError === true || value.is_error === true || ['failed', 'error', 'cancelled', 'canceled', 'interrupted', 'aborted'].includes(String(value.status));
  const content = failed ? JSON.stringify({ ...(value.isError === true || value.is_error === true ? { is_error: true } : { status: value.status }), content: body })
    : typeof body === 'string' ? body : JSON.stringify(body);
  return { role: 'tool', content, tool_call_id: value.tool_call_id ?? value.tool_use_id ?? value.toolCallId ?? value.call_id ?? fallbackId,
    ...(value.name === 'skill' ? { name: 'skill' } : {}) };
}

/** Normalize one source message without deleting task operations or changing its source evidence. */
export function uploadMessages(message: Message): Message[] {
  const metadata = uploadMeta(message), messages: Message[] = [];
  if (message.tool_calls !== undefined && !Array.isArray(message.tool_calls))
    return [{ role: message.role, content: prose(message), tool_calls: message.tool_calls, ...metadata }];
  const calls = message.tool_calls?.map(uploadCall) ?? [];
  const parts = Array.isArray(message.content) ? message.content : undefined;
  if (parts?.some(part => callBlock(part) || resultBlock(part))) {
    const consumed = new Set<number>(), resultCount = parts.filter(resultBlock).length;
    let pending: unknown[] = [];
    const flush = () => {
      const content = prose({ ...message, content: pending, thinking: undefined, reasoning: undefined, reasoning_content: undefined });
      if (content.trim()) messages.push(message.role === 'tool' ? uploadResult({ ...message, content }) : { role: message.role, content });
      pending = [];
    };
    const outside = prose({ ...message, content: '' });
    if (outside.trim()) pending.push(outside);
    for (const part of parts) {
      if (callBlock(part)) {
        flush();
        const call = uploadCall(part);
        const matching = calls.findIndex((candidate, index) => !consumed.has(index) && JSON.stringify(candidate) === JSON.stringify(call));
        if (matching >= 0) consumed.add(matching);
        messages.push({ role: 'assistant', content: '', tool_calls: [call] });
      } else if (resultBlock(part)) {
        flush();
        messages.push(uploadResult(object(part), resultCount === 1 ? message.tool_call_id : undefined));
      } else pending.push(part);
    }
    flush();
    const remaining = calls.filter((_, index) => !consumed.has(index));
    if (remaining.length) messages.push({ role: 'assistant', content: '', tool_calls: remaining });
  } else if (['tool', 'toolResult'].includes(message.role)) {
    messages.push(uploadResult(message));
  } else {
    const content = prose(message);
    if (content.trim() || calls.length) messages.push({ role: message.role, content, ...(calls.length ? { tool_calls: calls } : {}) });
  }
  return messages.map((value, index) => ({ ...value, ...metadata,
    ...(messages.length > 1 && typeof metadata.id === 'string' ? { id: `${metadata.id}:part:${index}` } : {}) }));
}

/** Report a batch blocker rather than throwing away invalid task evidence. */
export function uploadValidationError(messages: Message[]): string | null {
  for (const message of messages) {
    if (!['user', 'assistant', 'tool'].includes(message.role)) return '上传消息 role 无效';
    if (typeof message.content !== 'string' && !Array.isArray(message.content)) return '上传消息 content 必须为文本或消息块数组';
    if (message.id !== undefined && (typeof message.id !== 'string' || !message.id.trim())) return '上传消息 id 无效';
    if (message.chat_time !== undefined && (typeof message.chat_time !== 'string' || !Number.isFinite(Date.parse(message.chat_time)))) return '上传消息 chat_time 无效';
    if (message.role_id !== undefined && (typeof message.role_id !== 'string' || !message.role_id.trim())) return '上传消息 role_id 无效';
    if (message.role_name !== undefined && (typeof message.role_name !== 'string' || !message.role_id)) return '上传消息 role_name 需要有效 role_id';
    if (message.role === 'tool' && (typeof message.tool_call_id !== 'string' || !message.tool_call_id.trim())) return '工具结果缺少可靠 tool_call_id';
    if (message.tool_calls !== undefined) {
      if (!Array.isArray(message.tool_calls)) return '工具调用 tool_calls 必须为数组';
      for (const value of message.tool_calls) {
        const call = object(value), fn = object(call.function);
        if (typeof call.id !== 'string' || !call.id.trim()) return '工具调用缺少可靠 id';
        if (call.type !== 'function') return '工具调用 type 必须为 function';
        if (typeof fn.name !== 'string' || !fn.name.trim()) return '工具调用缺少 function.name';
        if (typeof fn.arguments !== 'string') return '工具调用缺少字符串 function.arguments';
      }
    }
  }
  return null;
}
