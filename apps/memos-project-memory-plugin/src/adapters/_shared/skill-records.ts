import type { Message, TraceInput } from '../types.ts';
import { object } from './transcript.ts';

export interface SkillRead { name: string; mixed?: boolean }
export type SkillMatcher = (tool: string, args: unknown) => SkillRead | undefined;

export function parseSkillArgs(value: unknown): Record<string, unknown> {
  if (typeof value === 'string') { try { return object(JSON.parse(value)); } catch { return {}; } }
  return object(value);
}

/** Syntax helpers only. Each adapter chooses which host tools and arguments are reads. */
export function skillFileName(value: unknown): string | undefined {
  if (typeof value !== 'string' || /[\n\r\0]/.test(value)) return;
  const parts = value.replace(/\\/g, '/').split('/');
  if (parts.at(-1) !== 'SKILL.md') return;
  const name = parts.at(-2);
  return name && !['.', '..', '~'].includes(name) ? name : 'unknown';
}

export function skillCommand(value: unknown): SkillRead | undefined {
  if (Array.isArray(value) && value.every(word => typeof word === 'string')) {
    if (/(?:^|\/)(?:ba|z|fi)?sh$/.test(value[0] ?? '') && /^-[a-z]*c/.test(value[1] ?? '')) return skillCommand(value.at(-1));
    value = value.map(word => JSON.stringify(word)).join(' ');
  }
  if (typeof value !== 'string') return;
  // No evaluation, substitutions, aliases or general shell interpretation.
  const tokens = value.match(/"(?:\\.|[^"\\])*"|'[^']*'|#[^\r\n]*|\r?\n|&&|\|\||[;|&<>]|[^\s;|&<>]+/g) ?? [];
  const segments: string[][] = [[]];
  for (const token of tokens) {
    if (token.startsWith('#')) continue;
    if (/^(?:\r?\n|&&|\|\||[;|&<>])$/.test(token)) segments.push([]);
    else {
      let word = token;
      if (token.startsWith('"')) { try { word = String(JSON.parse(token)); } catch { word = token.slice(1, -1); } }
      else if (token.startsWith("'")) word = token.slice(1, -1);
      segments.at(-1)!.push(word);
    }
  }
  for (const segment of segments) {
    const [executable, ...args] = segment;
    const tool = executable?.replace(/^.*[\\/]/, '').toLowerCase();
    if (!tool || !['cat', 'head', 'tail', 'sed', 'bat', 'more', 'get-content', 'type'].includes(tool)) continue;
    const files = args.filter(token => skillFileName(token));
    if (!files.length) continue;
    const name = skillFileName(files[0])!;
  // Only a single explicit file read is lossless. Other operands/operators make
  // its output indivisible; adapters retain an incomplete summary, not the body.
  const mixed = segments.length !== 1 || files.length !== 1 || args.some(token => !files.includes(token)
    && token !== '--' && !/^-[\w-]+$/.test(token) && !/^\d+$/.test(token)
    && !(tool === 'sed' && /^(?:\d+|\$)(?:,(?:\d+|\$))?p$/.test(token)));
    return { name, ...(mixed ? { mixed: true } : {}) };
  }
}

function identity(value: unknown): { id?: string; tool: string; args: unknown } | undefined {
  const call = object(value), fn = object(call.function);
  const id = call.id ?? call.toolCallId ?? call.call_id;
  const tool = fn.name ?? call.name ?? call.toolName;
  if (typeof tool !== 'string') return;
  return { ...(typeof id === 'string' ? { id } : {}), tool, args: fn.arguments ?? call.arguments ?? call.input ?? call.args };
}
function isCall(value: unknown): boolean {
  return ['tool_use', 'tool-call', 'tool_call', 'toolCall', 'function_call', 'custom_tool_call'].includes(String(object(value).type));
}
function isResult(value: unknown): boolean {
  return ['tool_result', 'tool-result', 'toolResult', 'function_call_output', 'custom_tool_call_output'].includes(String(object(value).type));
}
function resultId(value: unknown): string | undefined {
  const row = object(value), id = row.tool_call_id ?? row.tool_use_id ?? row.toolCallId ?? row.call_id;
  return typeof id === 'string' ? id : undefined;
}
function status(...values: unknown[]): string {
  const rows = values.flatMap(value => {
    const row = object(value);
    return [row, ...(Array.isArray(row.content) ? row.content.filter(isResult).map(object) : [])];
  });
  if (rows.some(row => row.isError === true || row.is_error === true || row.success === false || typeof row.exit_code === 'number' && row.exit_code !== 0)) return 'failed';
  for (const row of rows) {
    if (['failed', 'error'].includes(String(row.status))) return 'failed';
    if (['cancelled', 'canceled', 'interrupted', 'aborted'].includes(String(row.status))) return 'cancelled';
    if (row.status === 'incomplete') return 'incomplete';
  }
  if (rows.some(row => row.isError === false || row.is_error === false || row.success === true || row.exit_code === 0
    || ['completed', 'complete', 'succeeded', 'success'].includes(String(row.status)))) return 'completed';
  for (const row of rows) {
    const summary = parseSkillArgs(row.content);
    if (typeof summary.skill_name === 'string' && 'call_id' in summary && ['completed', 'failed', 'cancelled', 'incomplete', 'unknown'].includes(String(summary.status))) return String(summary.status);
    // Codex command wrappers expose execution metadata alongside output. A JSON
    // example in the Skill body is not an execution status.
    if ('wall_time_seconds' in summary && typeof summary.output === 'string' && typeof summary.exit_code === 'number') return summary.exit_code === 0 ? 'completed' : 'failed';
  }
  return 'unknown';
}
const scope = (record: TraceInput) => {
  const row = record as TraceInput & { originSessionId?: string; nativeSessionId?: string };
  return JSON.stringify([row.originSessionId ?? row.nativeSessionId ?? '', row.nativeTurnId ?? '']);
};

/** Mechanical correlation only; no host is opted in and no tool is classified here. */
export function filterSkillRecords<T extends TraceInput>(records: T[], identify: SkillMatcher): T[] {
  const reads = new Map<string, SkillRead>();
  const seen = new Map<string, SkillRead | undefined>();
  const classify = (call: NonNullable<ReturnType<typeof identity>>, value: unknown): SkillRead | undefined => {
    const args = parseSkillArgs(call.args);
    return call.tool === 'skill' && typeof args.skill_name === 'string'
      ? { name: args.skill_name, ...(object(value).status === 'incomplete' ? { mixed: true } : {}) } : identify(call.tool, call.args);
  };
  const remember = (key: string, read: SkillRead | undefined) => {
    if (seen.has(key)) {
      const previous = seen.get(key);
      if (previous?.name !== read?.name && (previous || read)) {
        const conflict = { name: previous?.name ?? read!.name, mixed: true };
        reads.set(key, conflict); seen.set(key, conflict); return;
      }
    }
    seen.set(key, read);
    if (read) reads.set(key, { ...read, ...(reads.get(key)?.mixed ? { mixed: true } : {}) });
  };
  for (const record of records) {
    const message = record.message;
    if (!message) continue;
    const calls = [...Array.isArray(message.tool_calls) ? message.tool_calls : [], ...Array.isArray(message.content) ? message.content.filter(isCall) : []];
    for (const value of calls) {
      const call = identity(value);
      if (!call) continue;
      const read = classify(call, value);
      if (call.id) remember(`${scope(record)}\0${call.id}`, read);
    }
    // Post-tool hooks can carry the invocation even if a pre-hook was missed.
    const id = resultId(message);
    if (id && typeof message.name === 'string') {
      const read = identify(message.name, message.tool_input ?? {});
      if (read && !reads.has(`${scope(record)}\0${id}`)) remember(`${scope(record)}\0${id}`, read);
    }
  }
  return records.map(record => {
    const original = record.message;
    if (!original) return record;
    let changed = false;
    const readFor = (id: string) => reads.get(`${scope(record)}\0${id}`);
    const projectCall = (value: unknown, block = false): unknown => {
      const call = identity(value), ownRead = call && classify(call, value);
      const read = ownRead && (call!.id ? readFor(call!.id) : ownRead);
      if (!call || !read) return value;
      changed = true;
      const state = read.mixed || !call.id ? 'incomplete' : 'started';
      if (block) {
        const row = object(value);
        const inputKey = row.type === 'tool_use' ? 'input' : row.type === 'toolCall' ? 'arguments' : 'arguments';
        return { type: row.type, ...(call.id ? { id: call.id } : {}), name: 'skill', [inputKey]: { skill_name: read.name }, status: state };
      }
      return { ...(call.id ? { id: call.id } : {}), type: 'function', function: { name: 'skill', arguments: JSON.stringify({ skill_name: read.name }) }, status: state };
    };
    const projectResult = (value: unknown, block: boolean): unknown => {
      const row = object(value), id = resultId(row), read = id ? readFor(id)
        : typeof row.name === 'string' ? identify(row.name, row.tool_input ?? {}) : undefined;
      if (!read) return value;
      changed = true;
      const raw = object(record.raw);
      const content = JSON.stringify({ skill_name: read.name, call_id: id ?? null,
        status: read.mixed || !id ? 'incomplete' : status(row, raw, raw.data, raw.payload) });
      return block ? { type: row.type, name: 'skill', ...(row.type === 'tool_result' ? { tool_use_id: id } : { toolCallId: id }), content }
        : { ...Object.fromEntries(['id', 'chat_time', 'role_id', 'role_name'].filter(key => row[key] !== undefined).map(key => [key, row[key]])), role: 'tool', name: 'skill', ...(id ? { tool_call_id: id } : {}), content };
    };
    let message: Message = original;
    if (['tool', 'toolResult'].includes(message.role) && (resultId(message) || typeof message.name === 'string')) message = projectResult(message, false) as Message;
    if (message === original) {
      const tool_calls = Array.isArray(message.tool_calls) ? message.tool_calls.map(value => projectCall(value)) : message.tool_calls;
      const content = Array.isArray(message.content) ? message.content.map(value => isCall(value) ? projectCall(value, true) : isResult(value) ? projectResult(value, true) : value) : message.content;
      if (changed) message = { ...message, content, ...(tool_calls ? { tool_calls } : {}) };
    }
    if (!changed) return record;
    // Rebuild evidence instead of copying a second unfiltered tool envelope.
    const raw = object(record.raw), retained: Record<string, unknown> = {};
    for (const key of ['type', 'id', 'uuid', 'seq', 'ordinal', 'status', 'timestamp', 'occurredAt', 'createdAt', 'time', 'turn_id', 'turnId', 'generation_id', 'root_turn_id', 'parent_turn_id', 'hook_event_name', 'sourceOrdinal', 'sourcePart', 'parentId']) {
      if (['string', 'number'].includes(typeof raw[key])) retained[key] = raw[key];
    }
    for (const key of ['data', 'payload', 'info']) {
      const value = object(raw[key]), meta: Record<string, unknown> = {};
      for (const field of ['type', 'id', 'timestamp', 'createdAt', 'turn_id', 'root_turn_id', 'parent_turn_id']) if (['string', 'number'].includes(typeof value[field])) meta[field] = value[field];
      if (typeof object(value.item).type === 'string') meta.item = { type: object(value.item).type };
      if (['string', 'number'].includes(typeof object(value.time).created)) meta.time = { created: object(value.time).created };
      if (Object.keys(meta).length) retained[key] = meta;
    }
    return { ...record, message, raw: { ...retained, message } };
  });
}

export function hasIncompleteSkill(message: Message): boolean {
  const summary = parseSkillArgs(message.content);
  if (message.role === 'tool' && message.name === 'skill' && typeof summary.skill_name === 'string' && 'call_id' in summary && summary.status === 'incomplete') return true;
  if (Array.isArray(message.tool_calls) && message.tool_calls.some(call => object(call).status === 'incomplete' && object(object(call).function).name === 'skill')) return true;
  return Array.isArray(message.content) && message.content.some(value => {
    const row = object(value), summary = parseSkillArgs(row.content);
    return isCall(row) && row.name === 'skill' && row.status === 'incomplete' || isResult(row) && row.name === 'skill' && typeof summary.skill_name === 'string' && summary.status === 'incomplete';
  });
}
