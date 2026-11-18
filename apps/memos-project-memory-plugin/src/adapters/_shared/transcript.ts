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
export function asMessage(raw: unknown): Message | undefined {
  const row = object(raw);
  const candidate = object(row.message);
  if (typeof candidate.role === 'string') return { ...candidate, role: candidate.role, content: candidate.content ?? '' } as Message;
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
