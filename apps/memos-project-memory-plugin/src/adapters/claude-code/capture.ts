import type { AgentEvent, TraceInput } from '../types.ts';
import { object, readTranscript, textField } from '../_shared/transcript.ts';
import { normalizeTaskTrace } from '../_shared/task-trace.ts';
import type { Store } from '../../storage/store.ts';

/** Claude alone owns its pending file reads. No Codex reader/state is reused. */
export class ClaudeCapture {
  private store: Store;
  private running: Promise<void> | undefined;
  private closed = false;
  constructor(store: Store) {
    this.store = store;
    store.db.exec('CREATE TABLE IF NOT EXISTS claude_receipts(id TEXT PRIMARY KEY,event TEXT NOT NULL,error TEXT)');
  }
  close() { this.closed = true; }
  private session(nativeId: string) {
    const row = this.store.row("SELECT id FROM sessions WHERE agentType='claude-code' AND nativeSessionId=?", nativeId);
    return row ? this.store.session(String(row.id)) : undefined;
  }
  private scope(event: AgentEvent) {
    const session = this.session(event.nativeSessionId) ?? (event.parentNativeSessionId ? this.session(event.parentNativeSessionId) : undefined);
    return session ? this.store.memory.forSession(session) : this.store.memory.resolve('claude-code', event.cwd);
  }
  private enqueue(event: AgentEvent) {
    const raw = object(event.raw);
    // Keep only the source address and completion evidence, never tool output or injected context.
    const receipt: AgentEvent = { ...event, records: undefined, raw: {
      hook_event_name: raw.hook_event_name, transcript_path: raw.transcript_path,
      tool_use_id: raw.tool_use_id, occurredAt: this.store.memory.recordTime(raw),
      ...(event.event === 'turn-end' || event.event === 'session-end' ? { last_assistant_message: raw.last_assistant_message } : {}),
    } };
    const id = JSON.stringify([event.nativeSessionId, event.nativeTurnId ?? event.turnKey, event.event, raw.hook_event_name, raw.tool_use_id]);
    if (typeof raw.transcript_path === 'string') this.store.db.prepare("UPDATE claude_receipts SET event=json_set(event,'$.raw.transcript_path',?) WHERE json_extract(event,'$.nativeSessionId')=? AND json_extract(event,'$.raw.transcript_path') IS NULL").run(raw.transcript_path, event.nativeSessionId);
    this.store.db.prepare('INSERT INTO claude_receipts(id,event) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET event=excluded.event').run(id, JSON.stringify(receipt));
  }
  async context(event: AgentEvent) {
    if (event.event === 'turn-start') {
      const key = event.nativeTurnId ?? event.turnKey;
      if (!key) throw new Error('Claude 用户轮缺少可靠标识');
      const session = this.store.registerSession(event);
      this.store.startTurn(session.id, key);
    }
    const raw = object(event.raw);
    if (raw.transcript_path || !raw.agent_transcript_path) this.enqueue(event);
    const childId = textField(raw, 'agent_id', 'agentId'), childPath = textField(raw, 'agent_transcript_path');
    if (childId && childPath) this.enqueue({ agentType: 'claude-code', nativeSessionId: childId, cwd: event.cwd,
      parentNativeSessionId: event.nativeSessionId, event: raw.hook_event_name === 'SubagentStop' ? 'session-end' : 'trace-available',
      raw: { hook_event_name: raw.hook_event_name, transcript_path: childPath, last_assistant_message: raw.last_assistant_message, occurredAt: raw.occurredAt ?? raw.timestamp },
    });
    await this.flush();
    const session = this.session(event.nativeSessionId);
    return session ? { sessionId: session.id, conversationId: session.currentTurnId } : undefined;
  }
  async flush(): Promise<void> {
    while (this.running) await this.running;
    if (this.closed) return;
    const work = this.collect(); this.running = work;
    try { await work; } finally { if (this.running === work) this.running = undefined; }
  }
  private async collect() {
    for (const receipt of this.store.rows('SELECT id,event,error FROM claude_receipts ORDER BY rowid')) {
      if (this.closed) return;
      const event = JSON.parse(String(receipt.event)) as AgentEvent;
      const scope = this.scope(event);
      if (!scope || !this.store.memory.allows(scope.id, this.store.memory.recordTime(event.raw))) { this.store.db.prepare('DELETE FROM claude_receipts WHERE id=?').run(String(receipt.id)); continue; }
      try {
        const raw = object(event.raw), path = textField(raw, 'transcript_path');
        if (!path) throw new Error('Claude 等待原始会话文件路径');
        const source = await readTranscript(path, `claude-code:${event.nativeSessionId}`);
        if (this.closed) return;
        if (this.scope(event)?.enabledAt !== scope.enabledAt) continue;
        const records: TraceInput[] = [];
        let turn: string | undefined;
        for (const record of source) {
          const data = object(record.raw);
          if (data.sessionId && data.sessionId !== event.nativeSessionId && data.sessionId !== event.parentNativeSessionId) continue;
          const normalized = normalizeTaskTrace('claude-code', record);
          if (!normalized?.message) continue;
          if (normalized.message.role === 'user') turn = textField(data, 'promptId', 'prompt_id', 'turn_id') ?? `transcript:${record.sourceId}`;
          if (turn && this.store.memory.allows(scope.id, this.store.memory.recordTime(record.raw))) records.push({ ...normalized, nativeTurnId: turn });
        }
        if (!records.length) throw new Error('Claude 等待当前绑定范围内的原始会话消息');
        const session = this.session(event.nativeSessionId) ?? this.store.registerSession(event);
        this.store.capture(session.id, records);
        const terminal = event.event === 'turn-end' || event.event === 'session-end';
        if (terminal) {
          const key = event.nativeTurnId ?? event.turnKey ?? records.at(-1)!.nativeTurnId;
          if (event.event === 'turn-end' && this.store.row('SELECT completedAt FROM turns WHERE sessionId=? AND nativeKey=?', session.id, key!)?.completedAt) {
            this.store.db.prepare('DELETE FROM claude_receipts WHERE id=?').run(String(receipt.id));
            continue;
          }
          const current = records.filter(record => record.nativeTurnId === key);
          const expected = textField(raw, 'last_assistant_message');
          const final = current.findLast(record => record.message?.role === 'assistant' && this.text(record.message.content));
          if (expected && (!final || this.text(final.message!.content) !== expected)) throw new Error('Claude 等待最终回答写入原始会话文件');
          // Claude writes Stop's summary after the hook returns. Do not block the hook
          // waiting for its own completion, or freeze the upload before that flush.
          if (raw.hook_event_name === 'Stop' && (!final || !source.slice(source.findIndex(record => record.sourceId === final.sourceId) + 1).some(record => {
            const row = object(record.raw);
            return row.type === 'system' && row.subtype === 'stop_hook_summary'
              && typeof row.timestamp === 'string' && typeof raw.occurredAt === 'string' && Date.parse(row.timestamp) >= Date.parse(raw.occurredAt);
          }))) throw new Error('Claude 等待 Stop 完成后的会话落盘');
          const keys = event.event === 'session-end' ? new Set(records.map(record => record.nativeTurnId!)) : new Set([key!]);
          for (const nativeKey of keys) {
            const end = nativeKey === key ? this.store.memory.recordTime(raw)
              : this.store.memory.recordTime(records.findLast(record => record.nativeTurnId === nativeKey)?.raw);
            this.store.finalizeTurn(session.id, nativeKey, end);
          }
        } else if (event.event === 'turn-start' && !records.some(record => record.nativeTurnId === (event.nativeTurnId ?? event.turnKey))) {
          throw new Error('Claude 等待本轮用户输入写入原始会话文件');
        }
        this.store.db.prepare('DELETE FROM claude_receipts WHERE id=?').run(String(receipt.id));
      } catch (error) {
        if (this.closed) return;
        const message = error instanceof Error ? error.message : String(error);
        this.store.db.prepare('UPDATE claude_receipts SET error=? WHERE id=?').run(message, String(receipt.id));
        if (receipt.error !== message) this.store.diagnostic(`Claude 轨迹补读: ${message}`);
      }
    }
  }
  private text(content: unknown): string {
    if (typeof content === 'string') return content;
    return Array.isArray(content) ? content.flatMap(block => object(block).type === 'text' && typeof object(block).text === 'string' ? [object(block).text] : []).join('\n') : '';
  }
}
