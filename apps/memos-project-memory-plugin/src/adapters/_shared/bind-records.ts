import type { Message, TraceInput } from '../types.ts';
import { object } from './transcript.ts';

const callTypes = ['tool_use', 'tool-call', 'tool_call', 'toolCall', 'function_call', 'custom_tool_call'];
const resultTypes = ['tool_result', 'tool-result', 'toolResult', 'function_call_output', 'custom_tool_call_output'];
const scope = (record: TraceInput) => {
  const source = record as TraceInput & { originSessionId?: string; nativeSessionId?: string; sessionId?: string };
  return JSON.stringify([source.originSessionId ?? source.nativeSessionId ?? source.sessionId ?? '', record.nativeTurnId ?? '']);
};
const parse = (value: unknown): Record<string, unknown> => {
  if (typeof value === 'string') { try { return object(JSON.parse(value)); } catch { return {}; } }
  return object(value);
};
function words(command: string): string[] | undefined {
  const tokens: string[] = [];
  let token = '', started = false, quote = '';
  for (let index = 0; index < command.length; index++) {
    const char = command[index]!;
    if (quote === "'") {
      if (char === "'") quote = ''; else token += char;
    } else if (quote === '"') {
      if (char === '"') quote = '';
      else if (char === '$' || char === '`') return;
      else if (char === '\\') {
        const next = command[++index]; if (next === undefined) return;
        token += ['"', '\\', '$', '`'].includes(next) ? next : '\\' + next;
      } else token += char;
    } else if (/\s/.test(char)) {
      if (started) { tokens.push(token); token = ''; started = false; }
    } else {
      started = true;
      if (char === "'" || char === '"') quote = char;
      else if (char === '\\') { const next = command[++index]; if (next === undefined || /[\r\n]/.test(next)) return; token += next; }
      else if (/[;&|<>$`]/.test(char)) return;
      else token += char;
    }
  }
  if (quote) return;
  if (started) tokens.push(token);
  return tokens;
}
/** Recognize one static invocation only; never interpret scripts or shell substitutions. */
export function isBindCommand(value: unknown): boolean {
  if (Array.isArray(value) && value.every(word => typeof word === 'string')) {
    if (/(?:^|\/)(?:ba|z|fi)?sh$/.test(value[0] ?? '') && /^-[a-z]*c$/.test(value[1] ?? '') && value.length === 3) return isBindCommand(value[2]);
    return isBindWords(value);
  }
  if (typeof value !== 'string') return false;
  // This is the adapter-owned command prefix, not a general export parser.
  const command = value.replace(/^\s*export\s+MEMOS_PM_BIND_CONTEXT=(?:'[\w-]+'|"[\w-]+"|[\w-]+);\s*/, '');
  const tokens = words(command);
  return !!tokens && isBindWords(tokens);
}
function isBindWords(tokens: string[]): boolean {
  const executable = tokens[0]?.replace(/^.*[\\/]/, '');
  if (executable === 'memos-pm' && ['bind', 'unbind'].includes(tokens[1] ?? '')) return tokens.length === 4 && tokens[2] === '--space-id' && !!tokens[3]?.trim();
  if (!executable || !['node', 'node.exe'].includes(executable)
    || !/[\\/]bind[\\/][\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}\.mjs$/i.test(tokens[1] ?? '')) return false;
  const args = tokens.slice(tokens[2] === 'unbind' ? 3 : 2);
  return args.length === 2 && args[0] === '--space-id' && !!args[1]?.trim();
}
function bindingCall(tool: string, args: unknown): boolean {
  const name = tool.split(/[.:/]/).at(-1)?.toLowerCase();
  const input = parse(args);
  if (['exec_command', 'bash', 'shell', 'run_terminal_command', 'run_command', 'execute_command', 'terminal'].includes(name ?? '')) return isBindCommand(input.cmd ?? input.command);
  if (name !== 'exec' || typeof args !== 'string') return false;
  // A single, literal exec_command wrapper is provable. Mixed JavaScript stays intact.
  const match = args.trim().match(/^(?:text\(\s*)?await\s+tools\.exec_command\(\s*(\{[\s\S]*\})\s*\)\s*\)?\s*;?$/);
  if (!match) return false;
  try {
    const data = JSON.parse(match[1]!.replace(/([{,]\s*)([a-zA-Z_][\w]*)(\s*:)/g, '$1"$2"$3'));
    return isBindCommand(data.cmd ?? data.command);
  } catch { return false; }
}
function call(value: unknown) {
  const row = object(value), fn = object(row.function);
  return { id: row.id ?? row.toolCallId ?? row.call_id, tool: fn.name ?? row.name ?? row.toolName, args: fn.arguments ?? row.arguments ?? row.input ?? row.args };
}
const resultId = (value: unknown) => { const row = object(value); return row.tool_call_id ?? row.tool_use_id ?? row.toolCallId ?? row.call_id; };
export function isBindControl(record: TraceInput): boolean { return object(record.raw).type === 'memos-bind-operation' && record.message?.role === 'system'; }
export function isTraceControl(record: TraceInput): boolean {
  return record.message?.role === 'system' && ['memos-bind-operation', 'memos-skill-read'].includes(String(object(record.raw).type));
}

/** Keep only durable call identities for late results. Control rows contain no command,
 * destination, or result body and are not task messages in the Viewer or upload. */
export function filterBindRecords<T extends TraceInput>(records: T[]): T[] {
  return filterToolRecords(records, bindingCall, 'memos-bind-operation');
}

/** A control row occupies the original record's position, so incremental readers
 * can correlate late results without retaining excluded commands or bodies. */
export function filterToolRecords<T extends TraceInput>(records: T[], identify: (tool: string, args: unknown, value?: unknown) => boolean, kind: 'memos-bind-operation' | 'memos-skill-read'): T[] {
  const decisions = new Map<string, boolean>();
  const field = kind === 'memos-bind-operation' ? 'bindCallIds' : 'skillCallIds';
  const key = (record: TraceInput, id: string) => scope(record) + '\0' + id;
  const remember = (record: TraceInput, id: string, excluded: boolean) => {
    const idKey = key(record, id);
    if (kind === 'memos-skill-read' && decisions.has(idKey) && decisions.get(idKey) !== excluded)
      throw new Error(`Conflicting tool call identity: ${id}`);
    decisions.set(idKey, decisions.has(idKey) ? decisions.get(idKey)! && excluded : excluded);
  };
  for (const record of records) {
    const raw = object(record.raw);
    for (const id of ids(raw[field])) remember(record, id, true);
    if (raw.type === kind) for (const id of ids(raw.callIds)) remember(record, id, true);
    const message = record.message;
    if (!message || isTraceControl(record)) continue;
    const calls = [...Array.isArray(message.tool_calls) ? message.tool_calls : [], ...Array.isArray(message.content) ? message.content.filter(value => callTypes.includes(String(object(value).type))) : []];
    for (const value of calls) { const valueCall = call(value); if (typeof valueCall.id === 'string' && typeof valueCall.tool === 'string') remember(record, valueCall.id, identify(valueCall.tool, valueCall.args, value)); }
    const id = resultId(message);
    if (typeof id === 'string' && typeof message.name === 'string' && message.tool_input !== undefined && identify(message.name, message.tool_input, message)) remember(record, id, true);
  }
  return records.map(record => {
    const message = record.message;
    if (!message || isTraceControl(record)) return record;
    const omitted: string[] = [];
    const remove = (id: unknown) => { if (typeof id !== 'string' || decisions.get(key(record, id)) !== true) return false; omitted.push(id); return true; };
    if (['tool', 'toolResult'].includes(message.role) && remove(resultId(message))) return control(record, omitted, kind);
    const tool_calls = Array.isArray(message.tool_calls) ? message.tool_calls.filter(value => !remove(call(value).id)) : message.tool_calls;
    const content = Array.isArray(message.content) ? message.content.filter(value => {
      const type = String(object(value).type);
      return callTypes.includes(type) ? !remove(call(value).id) : resultTypes.includes(type) ? !remove(resultId(value)) : true;
    }) : message.content;
    if (!omitted.length) return record;
    const filtered = { ...message, content, ...(tool_calls ? { tool_calls } : {}) };
    if ((content === '' || Array.isArray(content) && !content.length) && !tool_calls?.length && !message.thinking && !message.reasoning && !message.reasoning_content) return control(record, omitted, kind);
    return { ...record, message: filtered, raw: { ...metadata(record.raw), [field]: [...new Set([...ids(object(record.raw)[field]), ...omitted])], message: filtered } };
  });
}
function ids(value: unknown): string[] { return Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string') : []; }
function metadata(raw: unknown): Record<string, unknown> {
  const row = object(raw);
  return {
    ...Object.fromEntries(['timestamp', 'occurredAt', 'createdAt', 'time', 'type', 'id', 'sourceOrdinal', 'sourcePart'].filter(key => ['string', 'number'].includes(typeof row[key])).map(key => [key, row[key]])),
    ...Object.fromEntries(['bindCallIds', 'skillCallIds'].filter(key => Array.isArray(row[key])).map(key => [key, ids(row[key])])),
  };
}
function control<T extends TraceInput>(record: T, callIds: string[], kind: 'memos-bind-operation' | 'memos-skill-read'): T {
  return { ...record, raw: { ...metadata(record.raw), type: kind, callIds: [...new Set(callIds)] }, message: { role: 'system', content: '' } };
}
