import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import type { AgentEvent, Message, TraceInput } from '../types.ts';
import { messageMetadata, messagePart, object, textField } from '../_shared/transcript.ts';
import type { Store } from '../../storage/store.ts';
import { normalizeTaskTrace } from '../_shared/task-trace.ts';

function transcriptPath(event: AgentEvent, env: NodeJS.ProcessEnv): string {
  const path = textField(object(event.raw), 'transcriptPath');
  const home = env.HOME ?? homedir();
  if (path) return path.startsWith('~/') ? join(home, path.slice(2)) : path;
  return join(env.COPILOT_HOME || join(home, '.copilot'), 'session-state', event.nativeSessionId, 'events.jsonl');
}

export function copilotNotification(event: AgentEvent, name: string, env: NodeJS.ProcessEnv): AgentEvent {
  const input = object(event.raw);
  if (typeof input.timestamp !== 'number' || !Number.isFinite(input.timestamp)) throw new Error('Copilot 结束通知缺少可靠时间标识');
  return { ...event, event: 'trace-available', records: [], raw: { hook_event_name: name, timestamp: input.timestamp,
    transcriptPath: transcriptPath(event, env) } };
}

/** Persist only completion notifications; reuse the service's existing sync cycle. */
export class CopilotCapture {
  private running: Promise<void> | undefined;
  private closed = false;
  private store: Store;
  constructor(store: Store) {
    this.store = store;
    store.db.exec('CREATE TABLE IF NOT EXISTS copilot_receipts(id TEXT PRIMARY KEY,event TEXT NOT NULL,scopeId TEXT NOT NULL,enabledAt TEXT NOT NULL,error TEXT)');
  }
  close() { this.closed = true; }
  enqueue(event: AgentEvent) {
    const session = this.store.row("SELECT * FROM sessions WHERE agentType='copilot-cli' AND nativeSessionId=?", event.nativeSessionId);
    const scope = session ? this.store.memory.forSession(this.store.session(String(session.id))!) : undefined;
    if (!scope?.enabledAt || !this.store.memory.allows(scope.id, this.store.memory.recordTime(event.raw))) return;
    const raw = object(event.raw), id = JSON.stringify([event.nativeSessionId, raw.hook_event_name, raw.timestamp]);
    this.store.db.prepare('INSERT OR IGNORE INTO copilot_receipts(id,event,scopeId,enabledAt) VALUES(?,?,?,?)').run(id, JSON.stringify(event), scope.id, scope.enabledAt);
  }
  async flush(): Promise<void> {
    if (this.running) return this.running;
    this.running = this.collect().finally(() => { this.running = undefined; });
    return this.running;
  }
  private async collect() {
    for (const receipt of this.store.rows('SELECT * FROM copilot_receipts ORDER BY rowid')) {
      if (this.closed) return;
      const scope = this.store.memory.get(String(receipt.scopeId));
      if (!scope?.spaceIds.length || scope.enabledAt !== receipt.enabledAt) {
        this.store.db.prepare('DELETE FROM copilot_receipts WHERE id=?').run(String(receipt.id)); continue;
      }
      try {
        const notification = JSON.parse(String(receipt.event)) as AgentEvent;
        const event = await copilotEvent(notification, String(object(notification.raw).hook_event_name), process.env);
        if (this.closed) return;
        if (this.store.memory.get(scope.id)?.enabledAt !== scope.enabledAt) continue;
        const session = this.store.row("SELECT id FROM sessions WHERE agentType='copilot-cli' AND nativeSessionId=? AND objectId=?", event.nativeSessionId, scope.id);
        const turn = session && event.turnKey && this.store.row('SELECT * FROM turns WHERE sessionId=? AND nativeKey=?', String(session.id), event.turnKey);
        if (!session || !turn) throw new Error('Copilot 完成记录缺少对应的已登记用户轮');
        if (event.records?.some(record => !this.store.memory.allows(scope.id, this.store.memory.recordTime(record.raw))))
          throw new Error('Copilot 任务记录缺少有效时间或不属于当前启用窗口');
        this.store.db.exec('BEGIN');
        try {
          if (!turn.completedAt) {
            // The submit Hook precedes the native user.message ID. Upgrade only
            // its verified, same-turn, never-sent record after native attribution.
            for (const record of event.records ?? []) {
              if (record.message?.role !== 'user' || !record.message.id) continue;
              const stored = this.store.row('SELECT * FROM traces WHERE sessionId=? AND sourceId=? AND conversationId=?', String(session.id), record.sourceId, String(turn.id));
              if (!stored || this.store.row(`SELECT 1 FROM batches b WHERE (b.id=? OR EXISTS(SELECT 1 FROM batch_traces bt WHERE bt.batchId=b.id AND bt.traceId=?)) AND (b.attempts>0 OR b.uploaded=1) LIMIT 1`, stored.batchId as string ?? null, Number(stored.id))) continue;
              const previous = JSON.parse(String(stored.message)) as Message;
              const message = normalizeTaskTrace('copilot-cli', record)?.message;
              if (!message || previous.role !== message.role || JSON.stringify(previous.content) !== JSON.stringify(message.content)) continue;
              if (previous.id && previous.id !== message.id) throw new Error('Copilot 原生用户消息 ID 与已保存来源冲突');
              this.store.db.prepare('UPDATE traces SET message=?,raw=? WHERE id=?')
                .run(JSON.stringify(message), JSON.stringify({ ...object(JSON.parse(String(stored.raw))), message }), Number(stored.id));
            }
            this.store.capture(String(session.id), event.records ?? []);
            this.store.finalizeTurn(String(session.id), event.turnKey, this.store.memory.recordTime(notification.raw));
          }
          this.store.db.prepare('DELETE FROM copilot_receipts WHERE id=?').run(String(receipt.id));
          this.store.db.exec('COMMIT');
        } catch (error) { this.store.db.exec('ROLLBACK'); throw error; }
      } catch (error) {
        if (this.closed) return;
        const message = error instanceof Error ? error.message : String(error);
        if (receipt.error !== message) this.store.diagnostic(`Copilot 轨迹补读: ${message}`);
        this.store.db.prepare('UPDATE copilot_receipts SET error=? WHERE id=?').run(message, String(receipt.id));
      }
    }
  }
}

function injectedUser(row: Record<string, unknown>): boolean {
  const data = object(row.data);
  return row.type === 'user.message' && (typeof data.source === 'string' && data.source.startsWith('skill-') || data.isAutopilotContinuation === true);
}

type NativeRow = Record<string, unknown>;
type Submission = { id: string; input: NativeRow; output?: NativeRow };
interface CopilotTurn {
  key: string;
  messageId: string;
  records: TraceInput[];
  openSteps: Set<string>;
  toolCalls: Map<string, 'pending' | 'complete'>;
  hasAnswer: boolean;
}

function submissionRows(event: AgentEvent, name: string, timestamp: number, transcript: string): NativeRow[] {
  const rows: NativeRow[] = [];
  let boundary = false, invocation: unknown, acknowledged = false;
  // Stop at this exact callback: a delayed/repeated Hook must not consume a newer turn.
  for (const line of transcript.split('\n')) {
    if (!line.trim()) continue;
    const row = object(JSON.parse(line)), data = object(row.data), hook = object(data.input);
    if (row.type === 'hook.start' && data.hookType === name && hook.timestamp === timestamp && hook.sessionId === event.nativeSessionId) {
      boundary = true; invocation = data.hookInvocationId; continue;
    }
    if (boundary) {
      if (row.type === 'hook.end' && data.hookInvocationId === invocation) {
        if (data.success !== true || object(data.output).decision === 'block') throw new Error('Copilot 结束 Hook 未确认完成');
        acknowledged = true; break;
      }
      continue;
    }
    rows.push(row);
  }
  if (!boundary) throw new Error('Copilot 原生记录尚未包含对应结束通知');
  if (!acknowledged) throw new Error('Copilot 等待结束 Hook 完成记录落盘');
  const start = rows.find(row => row.type === 'session.start');
  if (!start || object(start.data).sessionId !== event.nativeSessionId || resolve(String(object(object(start.data).context).cwd ?? '')) !== resolve(event.cwd))
    throw new Error('Copilot 原生会话身份或项目目录不匹配');

  // Earlier conversations may predate installation. Only this submission's
  // source interval can establish the current local round.
  const userIndex = rows.findLastIndex(row => !row.agentId && row.type === 'user.message' && !injectedUser(row));
  if (userIndex < 0) return [];
  const endIndex = rows.findLastIndex((row, index) => index < userIndex && !row.agentId && row.type === 'hook.end' && object(row.data).hookType === 'userPromptTransformed');
  const submission = object(rows[endIndex]?.data).hookInvocationId;
  const beginIndex = rows.findLastIndex((row, index) => index < endIndex && !row.agentId && row.type === 'hook.start' && object(row.data).hookInvocationId === submission);
  if (beginIndex < 0) throw new Error('Copilot 用户消息缺少对应提交记录');
  return rows.slice(beginIndex);
}

function beginTurn(event: AgentEvent, row: NativeRow, submission?: Submission): CopilotTurn {
  const data = object(row.data);
  if (!submission?.output || submission.input.sessionId !== event.nativeSessionId || typeof submission.input.timestamp !== 'number'
    || typeof data.messageId !== 'string' || data.content !== submission.input.prompt
    || data.transformedContent !== (submission.output.modifiedTransformedPrompt ?? submission.input.transformedPrompt))
    throw new Error('Copilot 用户消息无法与提交 Hook 可靠对应');
  const timestamp = submission.input.timestamp;
  const key = `userPromptTransformed:${timestamp}`;
  return {
    key,
    messageId: data.messageId,
    records: [{
      sourceId: `hook:${event.nativeSessionId}:userPromptTransformed:${timestamp}`, nativeTurnId: key,
      raw: { ...row, timestamp }, message: { role: 'user', id: data.messageId, content: String(data.content) },
    }],
    openSteps: new Set(), toolCalls: new Map(), hasAnswer: false,
  };
}

function applyTurnEvent(turn: CopilotTurn, sessionId: string, row: NativeRow) {
  const data = object(row.data);
  const addRecord = (message: Message, suffix = '') => {
    message = messageMetadata(message, row);
    if (row.type === 'assistant.message') message = messagePart(message, suffix === ':reasoning' ? 'reasoning' : 'body');
    turn.records.push({ sourceId: `copilot:${sessionId}:${row.id}${suffix}`, nativeTurnId: turn.key, raw: row, message });
  };
  if (row.type === 'assistant.turn_start') { turn.openSteps.add(String(data.turnId)); return; }
  if (row.type === 'assistant.turn_end') {
    if (!turn.openSteps.delete(String(data.turnId))) throw new Error('Copilot 模型步骤结束缺少对应开始记录');
    return;
  }
  if (row.type === 'assistant.message') {
    if (data.originatingMessageId !== turn.messageId) throw new Error('Copilot 回答的用户消息归属不匹配');
    if (typeof data.content !== 'string') throw new Error('Copilot 回答正文格式无法识别');
    const calls = Array.isArray(data.toolRequests) ? data.toolRequests.map(value => {
      const call = object(value);
      if (typeof call.toolCallId !== 'string' || typeof call.name !== 'string') throw new Error('Copilot 工具调用格式无法识别');
      return { id: call.toolCallId, type: 'function', function: { name: call.name, arguments: typeof call.arguments === 'string' ? call.arguments : JSON.stringify(call.arguments) } };
    }) : [];
    for (const call of calls) turn.toolCalls.set(call.id, 'pending');
    if (typeof data.reasoningText === 'string' && data.reasoningText.trim()) addRecord({ role: 'assistant', content: data.reasoningText, phase: 'analysis' }, ':reasoning');
    if (data.content.trim() || calls.length) addRecord({ role: 'assistant', content: data.content, ...(calls.length ? { tool_calls: calls } : {}) });
    if (data.content.trim() && !calls.length) turn.hasAnswer = true;
  } else if (row.type === 'tool.execution_start') {
    if (typeof data.toolCallId !== 'string' || typeof data.toolName !== 'string') throw new Error('Copilot 工具开始记录缺少身份');
    if (!turn.toolCalls.has(data.toolCallId)) {
      turn.toolCalls.set(data.toolCallId, 'pending');
      addRecord({ role: 'assistant', content: '', tool_calls: [{ id: data.toolCallId, type: 'function', function: { name: data.toolName, arguments: typeof data.arguments === 'string' ? data.arguments : JSON.stringify(data.arguments) } }] });
    }
  } else if (row.type === 'tool.execution_complete') {
    if (typeof data.toolCallId !== 'string' || !turn.toolCalls.has(data.toolCallId)) throw new Error('Copilot 工具结果缺少对应调用');
    turn.toolCalls.set(data.toolCallId, 'complete');
    addRecord({ role: 'tool', tool_call_id: data.toolCallId, content: JSON.stringify(data.result ?? data.error ?? ''), ...(data.success === false ? { isError: true } : {}) });
  }
}

function replaySubmission(event: AgentEvent, rows: NativeRow[]): AgentEvent {
  let pending: Submission | undefined;
  let current: CopilotTurn | undefined;
  const seen = new Map<string, string>();
  for (const row of rows) {
    const data = object(row.data);
    if (typeof row.id !== 'string') throw new Error('Copilot 原生事件缺少稳定 ID');
    const serialized = JSON.stringify(row), prior = seen.get(row.id);
    if (prior) { if (prior !== serialized) throw new Error('Copilot 原生事件 ID 内容冲突'); continue; }
    seen.set(row.id, serialized);
    if (injectedUser(row)) continue;
    if (row.agentId) {
      // Child actors need an explicit parent-call association; never mix by recency.
      if (current && ['user.message', 'assistant.message', 'tool.execution_start', 'tool.execution_complete'].includes(String(row.type)))
        throw new Error('Copilot 子 Agent 轨迹尚无法核对归属，保留轮次待核对');
      continue;
    }
    if (row.type === 'hook.start' && data.hookType === 'userPromptTransformed') {
      pending = { id: String(data.hookInvocationId), input: object(data.input) }; continue;
    }
    if (row.type === 'hook.end' && data.hookType === 'userPromptTransformed') {
      if (!pending || data.hookInvocationId !== pending.id || data.success !== true) { pending = undefined; continue; }
      pending.output = object(data.output); continue;
    }
    if (row.type === 'user.message') {
      current = beginTurn(event, row, pending);
      pending = undefined;
      continue;
    }
    if (current) applyTurnEvent(current, event.nativeSessionId, row);
  }
  if (!current) return { ...event, event: 'trace-available', records: [] };
  if (pending || current.openSteps.size || [...current.toolCalls.values()].includes('pending') || !current.hasAnswer)
    throw new Error('Copilot 轮次正文或执行完成证据不完整，暂不上传');
  // Never use session-end's generic "finish all turns" path for a single verified round.
  return { ...event, event: 'turn-end', nativeTurnId: undefined, turnKey: current.key, records: current.records };
}

/** Copilot events.jsonl is an event stream, not a role/content transcript. */
export async function copilotEvent(event: AgentEvent, name: string, env: NodeJS.ProcessEnv): Promise<AgentEvent> {
  const input = object(event.raw);
  const timestamp = input.timestamp;
  if (name === 'sessionStart') return { ...event, records: [] };
  if (name === 'userPromptTransformed') {
    if (typeof timestamp !== 'number' || !Number.isFinite(timestamp) || typeof input.prompt !== 'string')
      throw new Error('Copilot 提交缺少可靠时间标识或原始输入');
    const turnKey = `userPromptTransformed:${timestamp}`;
    return { ...event, nativeTurnId: undefined, turnKey, records: [{
      sourceId: `hook:${event.nativeSessionId}:userPromptTransformed:${timestamp}`,
      nativeTurnId: turnKey, raw: input, message: { role: 'user', content: input.prompt },
    }] };
  }
  // Tool callbacks are notifications. The native stream owns calls and results,
  // avoiding separate Hook copies without native call IDs.
  if (!['agentStop', 'sessionEnd'].includes(name)) return { ...event, event: 'trace-available', records: [] };
  if (typeof timestamp !== 'number' || !Number.isFinite(timestamp)) throw new Error('Copilot 结束通知缺少可靠时间标识');

  const transcript = await readFile(transcriptPath(event, env), 'utf8');
  const rows = submissionRows(event, name, timestamp, transcript);
  return replaySubmission(event, rows);
}
