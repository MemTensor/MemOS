import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import type { Message, TraceInput } from '../types.ts';

export function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
export function textField(value: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) if (typeof value[key] === 'string' && value[key]) return value[key] as string;
  return undefined;
}
/** Copy only metadata backed by the source message, never a tool/event identity or inferred member. */
export function messageMetadata(message: Message, raw: unknown): Message {
  const row = object(raw), payload = object(row.payload), data = object(row.data);
  const sameRole = (value: Record<string, unknown>) => value.role === message.role
    || message.role === 'tool' && value.role === 'toolResult'
    || message.role === 'user' && value.type === 'UserMessage'
    || message.role === 'assistant' && value.type === 'AgentMessage';
  const sources = [object(row.message), object(data.message), ...(row.type === `${message.role}.message` ? [{ ...data, role: message.role }] : []), data, object(payload.message), object(payload.item), payload, row].filter(sameRole);
  const metadata: Record<string, unknown> = {};
  for (const key of ['id', 'chat_time', 'role_id', 'role_name']) {
    if (Object.hasOwn(message, key)) metadata[key] = message[key];
    else {
      const source = sources.find(value => Object.hasOwn(value, key));
      if (source) metadata[key] = source[key];
    }
  }
  if (!Object.hasOwn(metadata, 'id')) {
    const native = sources.find(value => textField(value, 'message_id', 'messageId'));
    const wrapper = ['message', 'user', 'assistant'].includes(String(row.type))
      || !row.type && sameRole(object(row.message)) && !['tool', 'toolResult'].includes(message.role)
        && message.tool_calls === undefined && !(Array.isArray(message.content) && message.content.some(part =>
          ['tool_use', 'tool-call', 'tool_call', 'toolCall', 'function_call'].includes(String(object(part).type))));
    const id = native && textField(native, 'message_id', 'messageId')
      || wrapper && textField(row, 'uuid', 'message_id', 'messageId', 'id');
    if (id) metadata.id = id;
  }
  const iso = (value: unknown): string | undefined => {
    if (typeof value !== 'string' && typeof value !== 'number') return;
    const date = new Date(typeof value === 'number' && value < 1e12 ? value * 1000 : value);
    return Number.isFinite(date.getTime()) ? date.toISOString() : undefined;
  };
  if (Object.hasOwn(metadata, 'chat_time')) metadata.chat_time = iso(metadata.chat_time) ?? metadata.chat_time;
  else {
    const times = [message, ...sources].flatMap(value => [value.timestamp, value.createdAt, object(value.time).created, value.time]);
    // Host message time precedes live receipt time. Historical rows never receive a new timestamp here.
    times.push(object(row.info).time && object(object(row.info).time).created, row.timestamp, row.createdAt,
      object(row.time).created, row.time, payload.timestamp, data.timestamp, row.occurredAt);
    const time = times.map(iso).find(value => value !== undefined);
    if (time) metadata.chat_time = time;
  }
  return { ...message, ...metadata } as Message;
}
/** Only real-time host callbacks may use receipt time; transcript replay never calls this. */
export function observed(raw: Record<string, any>): Record<string, any> {
  const times = [raw.occurredAt, raw.timestamp, raw.createdAt, raw.time, raw.payload?.timestamp,
    raw.message?.timestamp, raw.info?.time?.created, raw.data?.timestamp, raw.data?.message?.timestamp];
  return times.some(value => typeof value === 'string' || typeof value === 'number')
    ? raw : { ...raw, occurredAt: new Date().toISOString() };
}

export function asMessage(raw: unknown): Message | undefined {
  const row = object(raw);
  const candidate = object(row.message);
  if (typeof candidate.role === 'string') return { ...candidate, role: candidate.role, content: candidate.content ?? '' } as Message;
  // Cursor keeps the speaker on the outer record and the body in message.
  if (typeof row.role === 'string' && candidate.content !== undefined)
    return { ...candidate, role: row.role, content: candidate.content } as Message;
  if (typeof row.role === 'string') return { ...row, role: row.role, content: row.content ?? '' } as Message;
  const payload = object(row.payload);
  // Kimi Code v2 wire records (new product, distinct from legacy kimi-cli).
  if (row.type === 'tool.result') return {role:'tool',content:JSON.stringify(row.result ?? row),tool_call_id:row.toolCallId};
  if (row.type === 'tool.call.started') {
    const args=row.arguments ?? row.args;
    return {role:'assistant',content:'',tool_calls:[{id:row.toolCallId,type:'function',function:{name:row.name,arguments:typeof args==='string'?args:JSON.stringify(args)}}]};
  }
  if (row.type === 'content.part' && row.part) return {role:'assistant',content:[row.part]};
  if (row.type === 'response_item') {
    if (payload.type === 'message' && typeof payload.role === 'string') return { ...payload, role: payload.role, content: payload.content ?? '' } as Message;
    if (payload.type === 'function_call') return { role: 'assistant', content: '', tool_calls: [{id: payload.call_id, type:'function',function:{name:payload.name,arguments:payload.arguments}}] };
    if (payload.type === 'function_call_output') return { role: 'tool', content: typeof payload.output === 'string' ? payload.output : JSON.stringify(payload.output), tool_call_id:payload.call_id };
  }
  if (row.type === 'event_msg' && payload.type === 'user_message') return {role:'user',content:typeof payload.message==='string'?payload.message:JSON.stringify(payload.message)};
  // ACP transcript source (Grok): preserve structured content, do not flatten media.
  const update = object(row.update ?? object(row.params).update);
  if (update.sessionUpdate === 'user_message_chunk' || update.sessionUpdate === 'agent_message_chunk') return {role:update.sessionUpdate==='user_message_chunk'?'user':'assistant',content:[update.content]};
  if (update.sessionUpdate === 'tool_call' || update.sessionUpdate === 'tool_call_update') return {role:'tool',content:typeof update.content==='string'?update.content:JSON.stringify(update),tool_call_id:update.toolCallId};
  return undefined;
}

/** Raw rows are retained, including unknown metadata. Snapshot rereads deduplicate by native IDs. */
export async function readTranscript(path: string, sourceNamespace=path): Promise<TraceInput[]> {
  const content = await readFile(path, 'utf8');
  const lines = content.split('\n');
  const rows: TraceInput[] = [];
  const duplicates = new Map<string, number>();
  for (const [index, line] of lines.entries()) {
    if (!line.trim()) continue;
    let raw: unknown;
    try { raw = JSON.parse(line); } catch {
      // A concurrent writer may not have completed the final JSONL record yet.
      if (index === lines.length - 1) break;
      raw = { type:'unparsed', text:line };
    }
    const item=object(raw); const msg=object(item.message); const payload=object(item.payload);
    const identity=textField(item,'uuid','id','message_id','messageId') ?? textField(msg,'id') ?? textField(payload,'id','call_id');
    const signature=createHash('sha256').update(line).digest('hex');
    const occurrence=(duplicates.get(identity ?? signature) ?? 0)+1;duplicates.set(identity ?? signature,occurrence);
    // Retain versions of growing/rewritten records; never collapse identical separate source occurrences.
    const sourceId=identity ? `${sourceNamespace}:${identity}:${signature}` : `${sourceNamespace}:record:${signature}:${occurrence}`;
    rows.push({sourceId,raw,message:asMessage(raw),nativeTurnId:textField(item,'turn_id','prompt_id','generation_id','turnId') ?? (typeof item.turnId==='number'?String(item.turnId):undefined) ?? textField(payload,'turn_id')});
  }
  return rows;
}
