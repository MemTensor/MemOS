import type { Message, TraceInput } from '../types.ts';
import { asMessage, messageMetadata, object } from './transcript.ts';
import { normalizeWorkBuddyRecord } from '../workbuddy/normalize.ts';

/** Only task messages enter storage/upload; host bookkeeping has no fallback message. */
export function normalizeTaskTrace(agentType: string, record: TraceInput): TraceInput | undefined {
  if (agentType === 'workbuddy') record = normalizeWorkBuddyRecord(record);
  const raw = object(record.raw), data = object(raw.data);
  let message: Message | undefined;
  let sourceId = record.sourceId;
  if (agentType === 'deepseek-harness') {
    if (typeof object(raw.message).role === 'string') {
      message = asMessage(raw);
    } else if (raw.type === 'tool/call') {
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
    message = record.message ?? asMessage(raw);
    if ((agentType === 'pi' || agentType === 'prime-agent') && typeof object(raw.message).role !== 'string') message = executionMessage(raw) ?? message;
  }
  if (!message) return undefined;
  const candidates = [raw, object(raw.message), object(raw.payload), object(raw.data), message];
  const source = message.source;
  if (candidates.some(value => isInjected({ ...value, source: value.source ?? source }))) return undefined;
  message = { ...message, role: message.role === 'toolResult' ? 'tool' : message.role };
  if (!['user', 'assistant', 'tool'].includes(message.role)) return undefined;
  message = Object.fromEntries(Object.entries(message).filter(([key]) => !['model', 'usage', 'signature', 'tools', 'tool_definitions', 'tool_catalog', 'skill_catalog', 'skills', 'system', 'system_prompt', 'systemPrompt', 'instructions', 'stop_reason', 'stop_sequence', 'stop_details', 'diagnostics', 'context_management', 'container', 'user_email', 'cursor_version', 'workspace_roots', 'transcript_path', 'hook_event_name', 'session_id', 'conversation_id', 'generation_id', 'duration'].includes(key))) as Message;
  if (message.role !== 'tool' && Array.isArray(message.content)) message.content = taskContent(message.content);
  if (message.tool_calls === undefined && (message.content === '' || Array.isArray(message.content) && !message.content.length)
      && !message.thinking && !message.reasoning && !message.reasoning_content && message.role !== 'tool') return undefined;
  // Claude-style transcript tool results use the user role but are execution output.
  if (message.role === 'user' && Array.isArray(message.content) && message.content.length && message.content.every(part => object(part).type === 'tool_result')) {
    const blocks = message.content;
    message = { ...message, role: 'tool', ...(blocks.length === 1 ? { tool_call_id: object(blocks[0]).tool_use_id } : {}) };
  }
  if (message.role === 'tool' && !message.tool_call_id && typeof message.toolCallId === 'string') message.tool_call_id = message.toolCallId;
  if (agentType === 'prime-agent' && message.role === 'user') {
    message = { ...message, content: withoutPrimeContext(message.content) };
  }
  // Doubao's journal has no per-tool clock. Its occurredAt is the request
  // admission time for the whole turn, not a timestamp on individual messages.
  message = messageMetadata(message, raw.type === 'doubao-work.trajectory' ? { ...raw, occurredAt: undefined } : raw);
  // Keep only source evidence needed for identity, ordering and replay. A second
  // unfiltered body in raw would bypass the same boundary applied to message.
  const retainedRaw: Record<string, unknown> = {};
  for (const key of ['type', 'id', 'uuid', 'seq', 'timestamp', 'occurredAt', 'createdAt', 'time', 'turn_id', 'turnId', 'generation_id', 'root_turn_id', 'parent_turn_id', 'hook_event_name', 'sourceOrdinal', 'sourcePart']) {
    if (['string', 'number'].includes(typeof raw[key])) retainedRaw[key] = raw[key];
  }
  for (const key of ['data', 'payload', 'info']) {
    const value = object(raw[key]), metadata: Record<string, unknown> = {};
    for (const field of ['type', 'id', 'timestamp', 'createdAt', 'turn_id', 'root_turn_id', 'parent_turn_id']) {
      if (['string', 'number'].includes(typeof value[field])) metadata[field] = value[field];
    }
    if (typeof object(value.item).type === 'string') metadata.item = { type: object(value.item).type };
    if (['string', 'number'].includes(typeof object(value.time).created)) metadata.time = { created: object(value.time).created };
    if (Object.keys(metadata).length) retainedRaw[key] = metadata;
  }
  if (agentType === 'cursor-cli' && typeof raw.cursorReadKey === 'string' && /^[a-f0-9]{64}$/.test(raw.cursorReadKey)) retainedRaw.cursorReadKey = raw.cursorReadKey;
  if (Array.isArray(raw.bindCallIds)) retainedRaw.bindCallIds = raw.bindCallIds.filter((id: unknown) => typeof id === 'string');
  retainedRaw.message = message;
  if (agentType === 'workbuddy' && typeof raw.parentId === 'string') retainedRaw.parentId = raw.parentId;
  if (agentType === 'workbuddy' && typeof raw.status === 'string') retainedRaw.status = raw.status;
  return { ...record, sourceId, raw: retainedRaw, message };
}

export function isInjected(value: Record<string, unknown>): boolean {
  const source = object(value.source).kind ?? value.source;
  return value.isMeta === true
    || (value.isSynthetic === true || value.synthetic === true) && !['user', 'model', 'tool', 'subagent'].includes(String(source))
    || value.customType === 'memos-project-memory'
    || ['runtime-context', 'memos-project-memory', 'skill-catalog', 'tool-catalog', 'time-context', 'system-prompt', 'extension'].includes(String(source))
    || ['system-prompt', 'runtime-context', 'skill-catalog', 'tool-catalog'].includes(String(value.type));
}

function taskContent(content: unknown[]): unknown[] {
  return content.filter(part => !isInjected(object(part))).map(part => {
    const block = object(part);
    if (['tool_result', 'tool-result', 'function_call_output'].includes(String(block.type))) return part;
    if (Array.isArray(block.content)) return { ...block, content: taskContent(block.content) };
    if (['thinking', 'reasoning', 'text', 'input_text', 'output_text'].includes(String(block.type))) {
      const { signature: _signature, ...readable } = block;
      return readable;
    }
    return part;
  });
}

function toolCall(id: unknown, name: unknown, args: unknown): Message | undefined {
  if (typeof id !== 'string' || typeof name !== 'string') return undefined;
  return { role: 'assistant', content: '', tool_calls: [{ id, type: 'function', function: { name, arguments: typeof args === 'string' ? args : JSON.stringify(args) } }] };
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
