import type { Message, TraceInput } from '../../types.ts';
import { Bridge, sendEvent, type Data, type Send } from './bridge.ts';
import type { CreateIdentity } from '../../_shared/create-context.ts';

/** OpenCode-only decoration; other hosts retain the shared Bridge semantics. */
export function captureBridge(agent: string, cwd: string, send: Send = sendEvent) {
  const parents = new Map<string, string>();
  const skills = new Map<string, string | undefined>();
  const transport = Object.assign(async (event: Parameters<Send>[0]) => {
    const records = event.records?.map(record => {
      let message = record.message;
      if (!message) return record;
      const prefix = `${event.nativeSessionId}\0${record.nativeTurnId ?? event.turnKey ?? ''}\0`;
      const tool_calls = message.tool_calls?.map(value => {
        const call = value as Data;
        if (call.function?.name !== 'skill') return call;
        let input: Data = {};
        try { input = JSON.parse(call.function.arguments); } catch { /* Never retain an unparsed skill body. */ }
        const name = typeof input?.name === 'string' ? input.name : undefined;
        skills.set(prefix + call.id, name);
        return { id: call.id, type: 'function', function: { name: 'skill', arguments: JSON.stringify({ name }) } };
      });
      if (tool_calls) message = { ...message, tool_calls };
      if (typeof message.tool_call_id === 'string' && skills.has(prefix + message.tool_call_id)) {
        message = { role: 'tool', tool_call_id: message.tool_call_id,
          content: JSON.stringify({ name: skills.get(prefix + message.tool_call_id), status: message.isError ? 'error' : 'completed' }) };
      }
      // Raw must contain the same projection, including on callback/replay duplicates.
      return { ...record, message, raw: { ...record.raw as Data, message } };
    });
    const result = await send({ ...event, records,
      ...(parents.has(event.nativeSessionId) ? { parentNativeSessionId: parents.get(event.nativeSessionId) } : {}) });
    if (event.event === 'turn-end' || event.event === 'session-end') {
      const prefix = `${event.nativeSessionId}\0${event.event === 'turn-end' ? `${event.turnKey ?? ''}\0` : ''}`;
      for (const key of skills.keys()) if (key.startsWith(prefix)) skills.delete(key);
    }
    return result;
  }, {
    activation: send.activation && ((agent: string, cwd: string, session?: string) => send.activation!(agent, cwd, session, session ? parents.get(session) : undefined)),
    delivered: send.delivered,
    createContext: send.createContext && ((identity:CreateIdentity) => send.createContext!({ ...identity,
      ...(parents.has(identity.nativeSessionId) ? { parentNativeSessionId: parents.get(identity.nativeSessionId) } : {}) })),
  });
  return { bridge: new Bridge(agent, cwd, transport), parents };
}

/** Project native parts to task evidence before raw or message leaves the adapter. */
export function captureRecords(info: Data, parts: string | Data[], nativeTurnId: string): TraceInput[] {
  if (!info.id || !['user', 'assistant', 'tool'].includes(info.role) || info.synthetic || info.isMeta) return [];
  const records: TraceInput[] = [];
  const time = info.time?.created ?? info.timestamp ?? info.occurredAt;
  const add = (sourceId: string, message: Message) => records.push({ sourceId, nativeTurnId, message,
    raw: { id: info.id, ...(time !== undefined ? { timestamp: time } : {}), message } });
  const call = (id: string, name: string, input: unknown) => {
    if (id && name) add(`tool-call:${id}`, { role: 'assistant', content: '', tool_calls: [
      { id, type: 'function', function: { name, arguments: typeof input === 'string' ? input : JSON.stringify(input) } },
    ] });
  };
  const result = (id: string, output: unknown, error = false) => {
    if (id) add(`tool-result:${id}`, { role: 'tool', content: (output === undefined ? '' : output) as Message['content'], tool_call_id: id, ...(error ? { isError: true } : {}) });
  };
  if (info.role === 'tool') {
    result(info.tool_call_id, parts, info.isError === true);
    return records;
  }
  const blocks = typeof parts === 'string' ? [{ type: 'text', text: parts }] : parts;
  if (info.role === 'user') {
    const content = blocks.filter(part => part.type === 'text' && !part.synthetic && !part.ignored && typeof part.text === 'string').map(part => part.text).join('\n');
    if (content.trim()) add(`message:${info.id}`, { role: 'user', content });
    return records;
  }
  for (const [index, part] of blocks.entries()) {
    if (part.synthetic || part.ignored) continue;
    if (part.type === 'text' && typeof part.text === 'string' && part.text.trim()) {
      add(`message:${info.id}:text:${part.id ?? index}`, { role: 'assistant', content: part.text });
    } else if (part.type === 'tool' && part.state) {
      const state = part.state;
      if (state.status === 'pending') continue;
      call(part.callID, part.tool, state.input);
      if (state.status === 'completed') result(part.callID, state.output);
      if (state.status === 'error') result(part.callID, state.error, true);
    } else if (part.type === 'tool-call') {
      call(part.toolCallId, part.toolName, part.input);
    } else if (part.type === 'tool-result') {
      result(part.toolCallId, part.output, part.isError === true);
    }
  }
  for (const item of info.tool_calls ?? []) call(item.id, item.function?.name, item.function?.arguments);
  return records;
}
