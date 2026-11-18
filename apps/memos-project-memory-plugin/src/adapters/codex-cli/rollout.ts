import { createHash } from 'node:crypto';
import { open } from 'node:fs/promises';
import type { Message } from '../types.ts';
import { stripImages } from '../_shared/image-content.ts';
import { normalizeCodexContent, codexRecordRaw } from './content-normalizer.ts';
import type { CodexExpectedChild, CodexParserState, CodexReaderState, CodexRecord, CodexSnapshot, CodexSourceKind, CodexTurn } from './types.ts';

const object = (value: unknown): Record<string, any> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : {};
const text = (value: unknown): string | undefined => typeof value === 'string' && value ? value : undefined;
const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const iso = (value: unknown): string | undefined => {
    const date = typeof value === 'number' ? new Date(value < 1e12 ? value * 1000 : value) : typeof value === 'string' ? new Date(value) : undefined;
    return date && Number.isFinite(date.getTime()) ? date.toISOString() : undefined;
};
const backgroundKinds = new Set(['codex-auto-review', 'next_user_message', 'next-user-message', 'suggest_next_user_message', 'composer_prediction', 'composer-prediction', 'title_generation', 'title-generation', 'prompt_suggestion', 'prompt-suggestion']);
const controlItems = new Set(['configuration_update', 'additional_tools', 'compaction', 'compaction_summary', 'ContextCompaction']);
const controlRows = new Set(['world_state', 'token_usage_record', 'inter_agent_communication_metadata', 'compacted']);
const controlEvents = new Set(['token_count', 'thread_settings_applied', 'agent_reasoning', 'agent_reasoning_raw_content', 'agent_message_delta', 'agent_reasoning_delta', 'agent_reasoning_raw_content_delta', 'item_started']);

function initialState(sourcePath = ''): CodexParserState {
    return { snapshot: { nativeSessionId: '', cwd: '', sourceKind: 'unknown', sourcePath, turns: [], gaps: [] }, pending: [], lineNumber: 0 };
}
function addGap(state: CodexParserState, reason: string, turn?: CodexTurn): void {
    const gaps = turn?.gaps ?? state.snapshot.gaps;
    if (!gaps.includes(reason)) gaps.push(reason);
}
function sourceKind(payload: Record<string, any>): CodexSourceKind {
    const source = object(payload.source), subagent = object(source.subagent), spawn = object(subagent.thread_spawn);
    if ([payload.purpose, payload.request_kind, payload.model, payload.thread_source, payload.source, source.kind, source.purpose].some(kind => backgroundKinds.has(String(kind)))) return 'background';
    if (payload.parent_thread_id || spawn.parent_thread_id || payload.agent_path && payload.agent_path !== '/root' || source.subagent) return 'subagent';
    if (['cli', 'vscode', 'exec', 'app-server', 'app_server', 'desktop', 'user'].includes(String(payload.source)) || ['user', 'interactive'].includes(String(source.kind))) return 'user';
    return 'unknown';
}
function findTurn(state: CodexParserState, id?: string): CodexTurn | undefined {
    return id ? state.snapshot.turns.find(turn => turn.nativeTurnId === id) : undefined;
}
function ensureTurn(state: CodexParserState, id: string, payload: Record<string, any>, timestamp?: string): CodexTurn {
    const attribution = object(payload.turn_attribution);
    let turn = findTurn(state, id);
    if (!turn) {
        turn = { nativeTurnId: id, rootTurnId: text(payload.root_turn_id) ?? text(attribution.root_turn_id) ?? id,
            parentTurnId: text(payload.parent_turn_id) ?? text(attribution.parent_turn_id), startedAt: iso(payload.started_at) ?? timestamp,
            status: 'running', records: [], expectedChildren: [], gaps: [] };
        state.snapshot.turns.push(turn);
    } else {
        const rootId = text(payload.root_turn_id) ?? text(attribution.root_turn_id);
        if (rootId) turn.rootTurnId = rootId;
        const parentId = text(payload.parent_turn_id) ?? text(attribution.parent_turn_id);
        if (parentId) turn.parentTurnId = parentId;
        turn.startedAt ??= iso(payload.started_at) ?? timestamp;
    }
    if (backgroundKinds.has(String(payload.model)) || backgroundKinds.has(String(payload.purpose))) turn.sourceKind = 'background';
    for (const record of turn.records) record.rootTurnId = turn.rootTurnId;
    return turn;
}
function nonempty(value: unknown): boolean { return Array.isArray(value) ? value.length > 0 : typeof value === 'string' ? value.length > 0 : value != null; }
function renderText(value: unknown): string {
    if (typeof value === 'string') return value;
    if (Array.isArray(value)) return value.map(renderText).join('');
    const part = object(value);
    if (part.type === 'encrypted_content') return '';
    return typeof part.text === 'string' ? part.text : '';
}
function comparisonContent(value: unknown): string {
    if (!Array.isArray(value)) return JSON.stringify(typeof value === 'string' ? [{ type: 'text', text: value }] : value);
    return JSON.stringify(value.map(part => {
        const item = object(part);
        return ['text', 'input_text', 'output_text'].includes(String(item.type)) ? { type: 'text', text: item.text } : item;
    }));
}
function toolMessage(name: string, callId: string, args: unknown): Message {
    return { role: 'assistant', content: '', tool_calls: [{ id: callId, type: 'function', function: { name, arguments: typeof args === 'string' ? args : JSON.stringify(args ?? {}) } }] };
}
function toolResult(callId: string, result: unknown, extra: Record<string, unknown> = {}): Message {
    return { role: 'tool', tool_call_id: callId, content: typeof result === 'string' ? result : JSON.stringify(result ?? ''), ...extra };
}
function jsonValue(value: unknown): unknown {
    if (typeof value !== 'string') return value;
    try { return JSON.parse(value); } catch { return undefined; }
}
function childPath(state: CodexParserState, name?: string): string | undefined {
    if (!name) return undefined;
    return name.startsWith('/') ? name : `${state.snapshot.agentPath ?? '/root'}/${name}`;
}
function registerChild(state: CodexParserState, turn: CodexTurn, name: string, callId: string, input: unknown, occurredAt: string | undefined, ordinal: number): void {
    const action = name.split('.').at(-1) ?? name;
    if (!['spawn_agent', 'followup_task', 'send_input'].includes(action)) return;
    const args = object(jsonValue(input) ?? input);
    // send_input without a turn-start guarantee remains an observed message, not an invented execution.
    if (action === 'send_input' && args.interrupt !== true) return;
    const existing = turn.expectedChildren.find(child => child.callId === callId);
    if (existing) { existing.kind = action === 'spawn_agent' ? 'spawn' : 'followup'; existing.occurredAt = occurredAt ?? existing.occurredAt; existing.sourceOrdinal = ordinal; return; }
    const target = text(args.target) ?? text(args.id) ?? text(args.agent_id);
    turn.expectedChildren.push({ callId, kind: action === 'spawn_agent' ? 'spawn' : 'followup',
        agentPath: action === 'spawn_agent' ? childPath(state, text(args.task_name)) : target?.includes('/') ? childPath(state, target) : undefined,
        agentId: action !== 'spawn_agent' && target && !target.includes('/') ? target : undefined,
        status: 'pending', occurredAt, sourceOrdinal: ordinal });
}
function updateChildResult(turn: CodexTurn, callId: string, output: unknown): void {
    const child = turn.expectedChildren.find(item => item.callId === callId);
    if (!child) return;
    const result = object(jsonValue(output) ?? output);
    const path = text(result.task_name) ?? text(result.agent_path);
    const agentId = text(result.agent_id) ?? text(result.thread_id) ?? text(result.id);
    if (path?.startsWith('/')) child.agentPath = path;
    if (agentId) child.agentId = agentId;
    if (result.error || result.success === false || result.status === 'failed' || typeof output === 'string' && /^aborted(?: before dispatch)?$/i.test(output.trim())) child.status = 'failed';
    else if (child.agentId || child.agentPath) child.status = 'started';
}

function appendRecord(state: CodexParserState, turn: CodexTurn, raw: unknown, payload: Record<string, any>, message: Message, ordinal: number, occurredAt: string | undefined, kind: string, eventIdentity?: string): void {
    message = stripImages(message);
    raw = codexRecordRaw(raw, message);
    const nativeId = eventIdentity ?? text(payload.id);
    const sourceId = `codex:${state.snapshot.nativeSessionId}:${turn.nativeTurnId}:${kind}:${nativeId ?? `ordinal:${ordinal}`}`;
    if (kind === 'tool-call' && object(raw).type === 'response_item') {
        const activityId = `codex:${state.snapshot.nativeSessionId}:${turn.nativeTurnId}:agent-activity:${nativeId}`;
        turn.records = turn.records.filter(record => record.sourceId !== activityId || record.message.agent_event === 'completed');
    }
    const existing = turn.records.find(record => record.sourceId === sourceId);
    if (existing) {
        // response_item is authoritative; completed item mirrors may omit phase/content details.
        if (object(raw).type === 'response_item' || object(existing.raw).type !== 'response_item') {
            existing.raw = raw; existing.message = message;
        }
        existing.occurredAt ??= occurredAt;
        return;
    }
    if (message.role === 'user') {
        const previous = turn.records.at(-1);
        const oldRaw = object(previous?.raw), oldPayload = object(oldRaw.payload);
        const oldIsMirror = oldRaw.type === 'event_msg' && (oldPayload.type === 'user_message' || object(oldPayload.item).type === 'UserMessage');
        const currentRaw = object(raw), currentPayload = object(currentRaw.payload);
        const isMirror = currentRaw.type === 'event_msg' && (currentPayload.type === 'user_message' || object(currentPayload.item).type === 'UserMessage');
        if (previous?.message.role === 'user' && oldIsMirror !== isMirror && ordinal === previous.sourceOrdinal + 1 && comparisonContent(previous.message.content) === comparisonContent(message.content)) {
            if (!isMirror) { previous.raw = raw; previous.message = message; }
            return;
        }
    }
    turn.records.push({ sourceId, raw, message, nativeTurnId: turn.nativeTurnId, rootTurnId: turn.rootTurnId,
        occurredAt, sourceOrdinal: ordinal, originSessionId: state.snapshot.nativeSessionId, agentPath: state.snapshot.agentPath });
}

function parseItem(state: CodexParserState, raw: Record<string, any>, payload: Record<string, any>, turn: CodexTurn, ordinal: number): void {
    const type = String(payload.type ?? '');
    const timestamp = iso(raw.timestamp) ?? iso(object(payload.internal_chat_message_metadata_passthrough).create_time);
    if (controlItems.has(type)) return;
    if (type === 'message' || type === 'UserMessage' || type === 'AgentMessage') {
        const role = type === 'UserMessage' ? 'user' : type === 'AgentMessage' ? 'assistant' : payload.role;
        if (role !== 'user' && role !== 'assistant') return;
        const content = payload.content;
        if (!nonempty(content)) return;
        appendRecord(state, turn, raw, payload, { role, content, ...(payload.phase ? { phase: payload.phase } : {}), ...(payload.channel ? { channel: payload.channel } : {}) }, ordinal, timestamp, 'message');
        return;
    }
    if (type === 'reasoning' || type === 'Reasoning') {
        const summary = payload.summary ?? payload.summary_text;
        const readable = renderText(summary);
        appendRecord(state, turn, raw, payload, { role: 'assistant', channel: 'analysis', content: readable ? [{ type: 'reasoning', text: readable }] : [{ type: 'redacted_thinking' }] }, ordinal, timestamp, 'reasoning');
        return;
    }
    if (type === 'agent_message') {
        const content = normalizeCodexContent({ ...payload, role: 'assistant' }).content;
        if (nonempty(content)) appendRecord(state, turn, raw, payload, { role: 'assistant', channel: 'agent_message', content, agent_author: payload.author, agent_recipient: payload.recipient }, ordinal, timestamp, 'agent-message');
        return;
    }
    if (['function_call', 'custom_tool_call', 'web_search_call', 'local_shell_call', 'computer_call', 'image_generation_call', 'file_search_call', 'code_interpreter_call', 'mcp_call'].includes(type)) {
        const callId = text(payload.call_id) ?? text(payload.id);
        if (!callId) { addGap(state, `tool_identity_missing:${ordinal}`, turn); return; }
        const namespace = text(payload.namespace);
        const name = text(payload.name) ? namespace ? `${namespace}.${payload.name}` : payload.name : type.replace(/_call$/, '');
        const input = payload.arguments ?? payload.input ?? payload.action;
        appendRecord(state, turn, raw, payload, toolMessage(name, callId, input), ordinal, timestamp, 'tool-call', callId);
        registerChild(state, turn, name, callId, input, timestamp, ordinal);
        if (payload.output !== undefined || payload.result !== undefined) appendRecord(state, turn, raw, payload, toolResult(callId, payload.output ?? payload.result), ordinal, timestamp, 'tool-result', callId);
        return;
    }
    if (['function_call_output', 'custom_tool_call_output', 'computer_call_output', 'local_shell_call_output'].includes(type)) {
        const callId = text(payload.call_id) ?? text(payload.id);
        if (!callId) { addGap(state, `tool_identity_missing:${ordinal}`, turn); return; }
        appendRecord(state, turn, raw, payload, toolResult(callId, payload.output ?? payload.result, payload.status ? { status: payload.status } : {}), ordinal, timestamp, 'tool-result', callId);
        updateChildResult(turn, callId, payload.output ?? payload.result);
        return;
    }
    if (type === 'SubAgentActivity') {
        const callId = text(payload.id);
        if (!callId) { addGap(state, `child_identity_missing:${ordinal}`, turn); return; }
        const kind = String(payload.kind ?? '').toLowerCase();
        const existing = turn.expectedChildren.find(child => child.callId === callId);
        if (existing) {
            existing.agentId = text(payload.agent_thread_id) ?? existing.agentId;
            existing.agentPath = text(payload.agent_path) ?? existing.agentPath;
            existing.status = 'started';
        } else if (/spawn|follow|send|resume/.test(kind) || kind === 'started') {
            turn.expectedChildren.push({ callId, agentId: text(payload.agent_thread_id), agentPath: text(payload.agent_path), kind: /spawn/.test(kind) || kind === 'started' ? 'spawn' : 'followup', status: 'started', occurredAt: timestamp, sourceOrdinal: ordinal });
        }
        if (kind !== 'completed' && turn.records.some(record => record.sourceId === `codex:${state.snapshot.nativeSessionId}:${turn.nativeTurnId}:tool-call:${callId}`)) return;
        if (!/spawn|follow|send|resume/.test(kind)) {
            appendRecord(state, turn, raw, payload, { role: 'assistant', channel: 'agent_event', content: [{ type: 'text', text: `子 agent ${payload.agent_path ?? payload.agent_thread_id ?? ''}：${payload.kind ?? 'activity'}` }], agent_author: payload.agent_path, agent_event: payload.kind }, ordinal, timestamp, 'agent-activity', callId);
            return;
        }
        // A call already recorded in response_item remains a single invocation.
        if (!turn.records.some(record => record.sourceId === `codex:${state.snapshot.nativeSessionId}:${turn.nativeTurnId}:tool-call:${callId}`)) appendRecord(state, turn, raw, payload, toolMessage(`subagent.${payload.kind ?? 'activity'}`, callId, { agent_id: payload.agent_thread_id, agent_path: payload.agent_path }), ordinal, timestamp, 'tool-call', callId);
        return;
    }
    if (['CommandExecution', 'McpToolCall', 'FileChange', 'ImageView', 'WebSearch'].includes(type)) {
        const callId = text(payload.id);
        if (!callId) { addGap(state, `tool_identity_missing:${ordinal}`, turn); return; }
        const name = type === 'CommandExecution' ? 'exec_command' : type === 'McpToolCall' ? `mcp__${payload.server}__${payload.tool}` : type === 'FileChange' ? 'apply_patch' : type === 'ImageView' ? 'view_image' : 'web_search';
        const input = type === 'CommandExecution' ? { command: payload.command, cwd: payload.cwd } : payload.arguments ?? payload.changes ?? { path: payload.path, query: payload.query };
        const envelope = object(raw.payload);
        const startedAt = iso(envelope.started_at_ms) ?? timestamp;
        const completedAt = iso(envelope.completed_at_ms) ?? timestamp;
        appendRecord(state, turn, raw, payload, toolMessage(name, callId, input), ordinal, startedAt, 'tool-call', callId);
        const output = payload.aggregated_output ?? payload.result ?? (type === 'FileChange' ? { stdout: payload.stdout, stderr: payload.stderr, status: payload.status } : undefined);
        if (output !== undefined) appendRecord(state, turn, raw, payload, toolResult(callId, output, { status: payload.status, ...(payload.exit_code !== undefined ? { exit_code: payload.exit_code } : {}) }), ordinal, completedAt, 'tool-result', callId);
        return;
    }
    addGap(state, `unknown_response:${type || 'missing_type'}:${ordinal}`, turn);
}

function consume(state: CodexParserState, value: unknown, ordinal: number): void {
    const raw = object(value), payload = object(raw.payload);
    const timestamp = iso(raw.timestamp);
    if (state.snapshot.nativeSessionId && state.historyStartOrdinal !== undefined && typeof raw.ordinal === 'number' && raw.ordinal < state.historyStartOrdinal) return;
    if (raw.type === 'session_meta') {
        const nativeSessionId = text(payload.id) ?? text(payload.session_id);
        if (state.snapshot.nativeSessionId && nativeSessionId && state.snapshot.nativeSessionId !== nativeSessionId) { addGap(state, 'session_identity_conflict'); return; }
        state.snapshot.nativeSessionId = nativeSessionId ?? state.snapshot.nativeSessionId;
        state.snapshot.cwd = text(payload.cwd) ?? state.snapshot.cwd;
        const spawn = object(object(object(payload.source).subagent).thread_spawn);
        state.snapshot.parentNativeSessionId = text(payload.parent_thread_id) ?? text(spawn.parent_thread_id);
        state.snapshot.agentPath = text(payload.agent_path) ?? text(spawn.agent_path);
        state.snapshot.sourceKind = sourceKind(payload);
        state.snapshot.startedAt = iso(payload.timestamp) ?? timestamp;
        if (typeof payload.subagent_history_start_ordinal === 'number') state.historyStartOrdinal = payload.subagent_history_start_ordinal;
        return;
    }
    if (state.historyStartOrdinal !== undefined) {
        if (typeof raw.ordinal !== 'number') { addGap(state, `history_ordinal_missing:${ordinal}`); return; }
        if (raw.ordinal < state.historyStartOrdinal) return;
    }
    const attribution = object(payload.turn_attribution), metadata = object(payload.internal_chat_message_metadata_passthrough);
    const explicitTurn = text(payload.turn_id) ?? text(attribution.turn_id) ?? text(metadata.turn_id);
    if (raw.type === 'turn_context' || raw.type === 'event_msg' && payload.type === 'task_started') {
        const id = explicitTurn;
        if (!id) { addGap(state, `turn_identity_missing:${ordinal}`); return; }
        const turn = ensureTurn(state, id, payload, timestamp);
        state.activeTurnId = id;
        const pending = state.pending.splice(0);
        for (const record of pending) consume(state, record.raw, record.ordinal);
        if (turn.records.length && turn.records[0]!.occurredAt && (!turn.startedAt || turn.records[0]!.occurredAt! < turn.startedAt)) turn.startedAt = turn.records[0]!.occurredAt;
        return;
    }
    if (raw.type === 'event_msg' && ['task_complete', 'task_completed', 'turn_aborted', 'task_aborted', 'task_failed'].includes(String(payload.type))) {
        const id = explicitTurn;
        if (!id) { addGap(state, `completion_identity_missing:${ordinal}`); return; }
        const turn = ensureTurn(state, id, payload);
        turn.status = payload.type === 'task_failed' || payload.status === 'failed' ? 'failed' : ['turn_aborted', 'task_aborted'].includes(payload.type) ? 'interrupted' : payload.status === 'cancelled' ? 'cancelled' : 'completed';
        turn.completedAt = iso(payload.completed_at) ?? timestamp;
        // Keep the last execution identity for late task-local content; a fresh boundary changes it explicitly.
        return;
    }
    if (controlRows.has(String(raw.type)) || raw.type === 'event_msg' && controlEvents.has(String(payload.type))) return;
    let item = payload;
    if (raw.type === 'event_msg' && payload.type === 'item_completed') item = object(payload.item);
    else if (raw.type === 'event_msg' && payload.type === 'user_message') item = { ...payload, type: 'message', role: 'user', content: payload.message };
    else if (raw.type === 'event_msg' && payload.type === 'agent_message') {
        // The event_msg text is a legacy mirror; response_item provides canonical assistant content.
        item = { ...payload, type: 'message', role: 'assistant', content: payload.message };
    } else if (raw.type !== 'response_item') {
        addGap(state, `unknown_event:${String(raw.type)}:${String(payload.type ?? '')}:${ordinal}`, findTurn(state, explicitTurn ?? state.activeTurnId));
        return;
    }
    if (controlItems.has(String(item.type)) || item.type === 'message' && !['user', 'assistant'].includes(String(item.role))) return;
    const itemMeta = object(item.internal_chat_message_metadata_passthrough);
    const turnId = text(item.turn_id) ?? text(itemMeta.turn_id) ?? explicitTurn ?? state.activeTurnId;
    if (!turnId) { state.pending.push({ raw, ordinal }); return; }
    const turn = ensureTurn(state, turnId, { ...payload, ...item });
    parseItem(state, raw, item, turn, ordinal);
}
function consumeLines(state: CodexParserState, content: string): void {
    for (const line of content.split('\n')) {
        if (!line.trim()) continue;
        state.lineNumber++;
        let raw: unknown;
        try { raw = JSON.parse(line); }
        catch { addGap(state, `invalid_json:${state.lineNumber}`, findTurn(state, state.activeTurnId)); continue; }
        const row = object(raw), payload = object(row.payload);
        const ordinal = typeof row.ordinal === 'number' ? row.ordinal : state.lineNumber;
        let item = row.type === 'event_msg' && payload.type === 'item_completed' ? object(payload.item)
            : row.type === 'event_msg' && ['user_message', 'agent_message'].includes(String(payload.type))
                ? { ...payload, type: 'message', role: payload.type === 'user_message' ? 'user' : 'assistant', content: payload.message }
                : payload;
        if (row.type === 'event_msg' && payload.type === 'user_message') {
            const attachments = [
                ...(Array.isArray(payload.local_images) ? payload.local_images.map((path: unknown) => ({ type: 'local_image', path })) : []),
                ...(Array.isArray(payload.images) ? payload.images.map((image: unknown) => typeof image === 'string' ? { type: 'input_image', image_url: image } : image) : []),
            ];
            if (attachments.length) item = { ...item, content: [...(Array.isArray(item.content) ? item.content : [{ type: 'text', text: item.content ?? '' }]), ...attachments] };
        }
        if ((row.type === 'response_item' || row.type === 'event_msg') && ['message', 'UserMessage', 'AgentMessage'].includes(String(item.type))) {
            const role = item.type === 'UserMessage' ? 'user' : item.type === 'AgentMessage' ? 'assistant' : item.role;
            if (role !== 'user' && role !== 'assistant') continue;
            const normalized = normalizeCodexContent({ ...item, role });
            if (normalized.unresolved) {
                const turnId = text(item.turn_id) ?? text(object(item.internal_chat_message_metadata_passthrough).turn_id) ?? text(payload.turn_id) ?? state.activeTurnId;
                addGap(state, `content_unresolved:${ordinal}`, findTurn(state, turnId));
            }
            if (!nonempty(normalized.content)) continue;
            raw = codexRecordRaw(row, stripImages({ role, content: normalized.content }));
        }
        consume(state, stripImages(raw), ordinal);
    }
}
function snapshotOf(state: CodexParserState, partial = false): CodexSnapshot {
    const snapshot = structuredClone(state.snapshot);
    if (!snapshot.nativeSessionId) snapshot.gaps.push('session_identity_missing');
    if (!snapshot.cwd) snapshot.gaps.push('workspace_missing');
    if (state.pending.length) snapshot.gaps.push(`unbound_records:${state.pending.length}`);
    if (partial) snapshot.gaps.push('partial_line');
    for (const turn of snapshot.turns) {
        turn.records.sort((a, b) => a.sourceOrdinal - b.sourceOrdinal || a.sourceId.localeCompare(b.sourceId));
        if (turn.records.some(record => !record.occurredAt)) turn.gaps.push('timestamp_missing');
    }
    snapshot.turns.sort((a, b) => (a.startedAt ?? '').localeCompare(b.startedAt ?? '') || (a.records[0]?.sourceOrdinal ?? 0) - (b.records[0]?.sourceOrdinal ?? 0) || a.nativeTurnId.localeCompare(b.nativeTurnId));
    return snapshot;
}

/** Initialization metadata alone is not a task; execution boundaries and gaps remain evidence. */
export function hasCodexActivity(snapshot: CodexSnapshot): boolean {
    return snapshot.turns.length > 0 || snapshot.gaps.length > 0;
}

/** Pure whole-file parser; no current clock, database, Hook identity, or prompt-text heuristics. */
export function parseCodexRollout(content: string, sourcePath = ''): CodexSnapshot {
    const state = initialState(sourcePath);
    consumeLines(state, content);
    return snapshotOf(state);
}

async function bytes(handle: Awaited<ReturnType<typeof open>>, start: number, size: number): Promise<Buffer> {
    const buffer = Buffer.alloc(size);
    const result = await handle.read(buffer, 0, size, start);
    return buffer.subarray(0, result.bytesRead);
}
/** Persist the returned state atomically with its events. Partial final lines are retried on the next read. */
export async function readCodexRollout(path: string, previous?: CodexReaderState): Promise<{ snapshot: CodexSnapshot; state: CodexReaderState; changed: boolean; directoryUpgrade: boolean }> {
    const handle = await open(path, 'r');
    try {
        const stat = await handle.stat();
        const fileIdentity = `${stat.dev}:${stat.ino}`;
        let reusable = previous !== undefined && [2, 3].includes(previous.version) && previous.fileIdentity === fileIdentity && previous.byteOffset <= stat.size && !(stat.size === previous.observedSize && stat.mtimeMs !== previous.modifiedAt);
        if (reusable && previous) {
            const prefix = await bytes(handle, 0, previous.prefixLength);
            const tail = await bytes(handle, previous.byteOffset - previous.tailLength, previous.tailLength);
            reusable = digest(prefix) === previous.prefixDigest && digest(tail) === previous.tailDigest;
        }
        // v2 cached turn cwd. Replay it, but retain verified source continuity
        // so the collector can distinguish this upgrade from file replacement.
        const directoryUpgrade = reusable && previous?.version === 2;
        reusable = reusable && previous?.version === 3;
        const parser = reusable && previous ? structuredClone(previous.parser) : initialState(path);
        let byteOffset = reusable && previous ? previous.byteOffset : 0;
        const appended = await bytes(handle, byteOffset, stat.size - byteOffset);
        const newline = appended.lastIndexOf(10);
        if (newline >= 0) {
            consumeLines(parser, appended.subarray(0, newline + 1).toString('utf8'));
            byteOffset += newline + 1;
        }
        const prefixLength = Math.min(byteOffset, 4096), tailLength = Math.min(byteOffset, 4096);
        const state: CodexReaderState = { version: 3, fileIdentity, observedSize: stat.size, modifiedAt: stat.mtimeMs, byteOffset, prefixLength, tailLength,
            prefixDigest: digest(await bytes(handle, 0, prefixLength)), tailDigest: digest(await bytes(handle, byteOffset - tailLength, tailLength)), parser };
        return { snapshot: snapshotOf(parser, byteOffset < stat.size), state, changed: !reusable || byteOffset !== previous?.byteOffset || stat.size !== previous?.observedSize, directoryUpgrade };
    } finally { await handle.close(); }
}
