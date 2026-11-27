import type { Message, TraceInput } from '../types.ts';
import { asMessage, messagePart, object, textField } from '../_shared/transcript.ts';
import { normalizeTaskTrace } from '../_shared/task-trace.ts';
import { hasTaskContent } from '../_shared/message-content.ts';

type TurnIdentity = { nativeTurnId: string; nativeSessionId: string; submittedAt: string };
export type TurnIssue = { kind: 'waiting' | 'conflict'; message: string };
export type ParsedTurn = { kind: 'parsed'; readOffset: number; records: TraceInput[]; prose: string[]; terminal: Record<string, unknown> };

export const waiting = (message: string): TurnIssue => ({ kind: 'waiting', message });
export const conflict = (message: string): TurnIssue => ({ kind: 'conflict', message });

export function cursorText(content: unknown): string {
  if (typeof content === 'string') return content;
  return Array.isArray(content) ? content.flatMap(block => ['text', 'input_text', 'output_text'].includes(String(object(block).type)) && typeof object(block).text === 'string' ? [String(object(block).text)] : []).join('') : '';
}

function prompt(message: Message): string {
  const text = cursorText(message.content);
  const match = /^(?:<timestamp>[^]*?<\/timestamp>\s*)?<user_query>\s*\n?([^]*?)\n?\s*<\/user_query>\s*$/.exec(text);
  return (match ? match[1] : text).trim();
}

function appendMessage(records: TraceInput[], receipt: TurnIdentity, raw: Record<string, unknown>, message: Message, at: number) {
  // The generation's persisted source interval proves these are new task
  // records. Its admission timestamp is provenance, not a replay-time guess.
  const record: TraceInput = { sourceId: `cursor:${receipt.nativeSessionId}:${receipt.nativeTurnId}:${at}`, nativeTurnId: receipt.nativeTurnId, raw: { ...raw, occurredAt: receipt.submittedAt }, message };
  const append = (body: Message, part: number, sourceId = `${record.sourceId}:${part}`) => records.push({ ...record, sourceId,
    raw: { ...object(record.raw), sourceOrdinal: at, sourcePart: part }, message: messagePart(body, part, message) });
  if (message.role === 'tool' && typeof message.tool_call_id === 'string') {
    append(message, 0, `hook:${receipt.nativeSessionId}:tool-result:${message.tool_call_id}`);
  } else if (message.role === 'tool' && Array.isArray(message.content) && message.content.some(block => object(block).type === 'tool_result' && typeof object(block).tool_use_id === 'string')) {
    for (const [part, block] of message.content.entries()) {
      const id = object(block).type === 'tool_result' ? object(block).tool_use_id : undefined;
      append({ ...message, ...(typeof id === 'string' ? { tool_call_id: id } : {}), content: [block] }, part,
        typeof id === 'string' ? `hook:${receipt.nativeSessionId}:tool-result:${id}` : `${record.sourceId}:${part}`);
    }
  } else if (message.role === 'assistant') {
    const { tool_calls: calls, thinking, reasoning, reasoning_content, ...body } = message;
    const prefix: Message = { ...body, content: '', thinking, reasoning, reasoning_content };
    if (hasTaskContent(prefix)) append(prefix, -1);
    const content = Array.isArray(message.content) ? message.content : [message.content];
    for (const [part, block] of content.entries()) {
      const id = ['tool_use', 'tool-call', 'function_call'].includes(String(object(block).type)) ? object(block).id : undefined;
      const item: Message = { ...body, content: typeof block === 'string' ? block : [block] };
      if (hasTaskContent(item)) append(item, part, typeof id === 'string' ? `hook:${receipt.nativeSessionId}:tool-call:${id}` : `${record.sourceId}:${part}`);
    }
    for (const [part, call] of (calls ?? []).entries()) append({ role: 'assistant', content: '', tool_calls: [call] }, content.length + part,
      typeof object(call).id === 'string' ? `hook:${receipt.nativeSessionId}:tool-call:${object(call).id}` : `${record.sourceId}:${content.length + part}`);
  } else append(message, 0);
}

export function parseTurn(
  completeLines: Buffer, readOffset: number, receipt: TurnIdentity, expected: Message | undefined, isChild: boolean,
): ParsedTurn | TurnIssue {
  const records: TraceInput[] = [];
  const prose: string[] = [];
  let userSeen = false, terminal: Record<string, unknown> | undefined, offset = readOffset;
  for (const line of completeLines.toString('utf8').split('\n')) {
    const at = offset; offset += Buffer.byteLength(line, 'utf8') + 1;
    if (!line.trim()) continue;
    let raw: Record<string, unknown>;
    try { raw = object(JSON.parse(line)); } catch { return conflict('Cursor 原生记录格式无效，等待核对来源'); }
    const nativeKey = textField(raw, 'generation_id', 'turn_id', 'prompt_id');
    if (nativeKey && nativeKey !== receipt.nativeTurnId) return conflict('Cursor 原生轮次标识与通知不一致');
    if (raw.type === 'turn_ended') { terminal = raw; break; }
    const message = normalizeTaskTrace('cursor-cli', { sourceId: String(at), raw, message: asMessage(raw) })?.message;
    if (!message) continue;
    if (message.role === 'user' && !(Array.isArray(message.content) && message.content.every(block => object(block).type === 'tool_result'))) {
      if (userSeen || expected && prompt(message) !== prompt(expected) || !expected && !isChild) return conflict('Cursor 原生用户轮次无法唯一关联');
      userSeen = true;
      if (expected) continue; // The submitted input already has its stable Hook identity.
      message.content = prompt(message); // A proven child source owns its delegated input.
    }
    if (!userSeen) return waiting('Cursor 等待本轮原生用户输入');
    // Match Hook text against whole native messages before splitting them for ordering.
    if (message.role === 'assistant') {
      const response = cursorText(message.content);
      if (response) prose.push(response);
    }
    appendMessage(records, receipt, raw, message, at);
  }
  if (!userSeen || !terminal) return waiting('Cursor 等待本轮 turn_ended 完整落盘');
  return { kind: 'parsed', readOffset, terminal, records, prose };
}
