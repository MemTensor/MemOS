import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { cursorToolEvidence, readKey } from './tool-evidence.ts';
import type { Stats } from 'node:fs';
import { open } from 'node:fs/promises';
import { homedir } from 'node:os';
import type { AgentEvent, Message, TraceInput } from '../types.ts';
import { asMessage, object, textField } from '../_shared/transcript.ts';
import { normalizeTaskTrace } from '../_shared/task-trace.ts';
import type { Store, Session } from '../../storage/store.ts';
import { conflict, cursorText, parseTurn, waiting, type ParsedTurn, type TurnIssue } from './turn-transcript.ts';
import { cursorSource, cursorTranscript, cursorReadSource, CursorSourceConflict, type CursorSource } from './source.ts';

type Receipt = { sessionId: string; conversationId: string; nativeSessionId: string; nativeTurnId: string; scopeId: string; enabledAt: string; submittedAt: string; path?: string; source?: CursorSource; observed?: { dev: number; ino: number; size: number }; stopped?: boolean; stoppedAt?: string; parentNativeTurnId?: string };

type ExistingTrace = { sourceId: string; message: Message; raw: Record<string, unknown> };

/** Cursor completion is proven by its own transcript, never by a timer or Hook arrival order. */
export class CursorCapture {
  private store: Store;
  private home: string;
  private running: Promise<unknown> = Promise.resolve();
  private closed = false;
  constructor(store: Store, home = homedir()) {
    this.store = store;
    this.home = home;
    store.db.exec('CREATE TABLE IF NOT EXISTS cursor_receipts(id TEXT PRIMARY KEY,event TEXT NOT NULL,error TEXT)');
  }
  close() { this.closed = true; }
  private serial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.running.then(work);
    this.running = next.catch(() => {});
    return next;
  }
  context(event: AgentEvent): Promise<{ sessionId: string; conversationId: string | null } | undefined> {
    return this.serial(async () => {
      if (this.closed) return;
      const known = this.store.row("SELECT id FROM sessions WHERE agentType='cursor-cli' AND nativeSessionId=?", event.nativeSessionId);
      const parent = event.parentNativeSessionId && this.store.row("SELECT id FROM sessions WHERE agentType='cursor-cli' AND nativeSessionId=?", event.parentNativeSessionId);
      const scope = known ? this.store.memory.forSession(this.store.session(String(known.id))!)
        : parent ? this.store.memory.forSession(this.store.session(String(parent.id))!) : this.store.memory.resolve('cursor-cli', event.cwd);
      if (!scope) return;
      const key = event.nativeTurnId ?? event.turnKey;
      if (!known && event.event !== 'turn-start') return;
      const session = this.store.registerSession(event), raw = object(event.raw);
      if (event.event === 'turn-start') {
        if (!key) throw new Error('Cursor 用户轮缺少可靠标识');
        const source = this.source(raw.cursor_source);
        if (source && this.claimed(session.id, key, source.offset)) throw new Error('Cursor 来源区间已归属另一轮次，无法重复关联');
        const turn = this.store.startTurn(session.id, key);
        if (!this.store.row('SELECT completedAt FROM turns WHERE id=?', String(turn.id))?.completedAt) {
          const submittedAt = this.store.memory.recordTime(raw);
          if (submittedAt && this.store.memory.allows(scope.id, submittedAt)) {
            const receipt: Receipt = { sessionId: session.id, conversationId: String(turn.id), nativeSessionId: event.nativeSessionId,
              nativeTurnId: key, scopeId: scope.id, enabledAt: scope.enabledAt!, submittedAt,
              path: textField(raw, 'transcript_path', 'transcriptPath'), source,
              ...(session.parentNativeSessionId && textField(raw, 'parent_generation_id') ? { parentNativeTurnId: textField(raw, 'parent_generation_id') } : {}) };
            const observed = object(raw.cursor_source_stat);
            if (!source && ['dev', 'ino', 'size'].every(key => Number.isSafeInteger(observed[key]) && Number(observed[key]) >= 0))
              receipt.observed = { dev: Number(observed.dev), ino: Number(observed.ino), size: Number(observed.size) };
            this.store.db.prepare('INSERT OR IGNORE INTO cursor_receipts(id,event,error) VALUES(?,?,?)')
              .run(String(turn.id), JSON.stringify(receipt), textField(raw, 'cursor_source_error') ?? null);
          }
        }
      }
      const turn = key ? this.store.row('SELECT id,completedAt FROM turns WHERE sessionId=? AND nativeKey=?', session.id, key) : undefined;
      // A delayed callback belongs to its native generation; never reopen an already frozen turn.
      if (turn && !turn.completedAt) {
        const pending = this.store.row('SELECT event FROM cursor_receipts WHERE id=?', String(turn.id));
        const receipt = pending ? JSON.parse(String(pending.event)) as Receipt : undefined;
        // Record timestamps alone cannot reauthorize a generation from a closed
        // binding window: validate its original admission before any live write.
        const admitted = receipt && receipt.scopeId === scope.id && receipt.enabledAt === scope.enabledAt
          && this.store.memory.allows(scope.id, receipt.submittedAt);
        const records = (event.records ?? []).flatMap(record => {
          if (!admitted) return [];
          const normalized = normalizeTaskTrace('cursor-cli', record);
          const message = normalized?.message;
          if (!message || message.role === 'assistant' && !this.calls(message).length && raw.hook_event_name !== 'afterAgentResponse') return [];
          if (message.role === 'user' && event.event !== 'turn-start') return [];
          return [{ ...normalized!, nativeTurnId: key, raw: { ...object(normalized!.raw), hook_event_name: raw.hook_event_name } }];
        });
        if (records.length) this.store.capture(session.id, records);
        if (admitted) {
          if (!receipt.path) receipt.path = textField(raw, 'transcript_path', 'transcriptPath');
          if (event.event === 'turn-end' || event.event === 'session-end') {
            receipt.stopped = true;
            receipt.stoppedAt ??= this.store.memory.recordTime(raw);
          }
          this.store.db.prepare('UPDATE cursor_receipts SET event=? WHERE id=?').run(JSON.stringify(receipt), String(turn.id));
        }
      }
      if (event.event === 'session-end' && !key) {
        for (const row of this.store.rows('SELECT id,event FROM cursor_receipts WHERE json_extract(event,\'$.sessionId\')=?', session.id)) {
          const receipt = JSON.parse(String(row.event)) as Receipt; receipt.stopped = true;
          receipt.stoppedAt ??= this.store.memory.recordTime(raw);
          this.store.db.prepare('UPDATE cursor_receipts SET event=? WHERE id=?').run(JSON.stringify(receipt), String(row.id));
        }
      }
      await this.collect();
      if (this.closed) return;
      const current = this.store.session(session.id)!;
      return { sessionId: current.id, conversationId: current.currentTurnId };
    });
  }
  flush(): Promise<void> { return this.serial(() => this.closed ? Promise.resolve() : this.collect()); }
  private claimed(sessionId: string, nativeTurnId: string, offset: number) {
    return this.store.row("SELECT 1 FROM traces t JOIN turns u ON u.id=t.conversationId WHERE t.sessionId=? AND u.nativeKey<>? AND json_extract(t.message,'$.role')='user' AND json_extract(t.raw,'$.sourceOrdinal')=? LIMIT 1", sessionId, nativeTurnId, offset);
  }
  private source(value: unknown): CursorSource | undefined {
    const row = object(value);
    const size = row.size ?? row.offset;
    if (!Number.isSafeInteger(row.offset) || Number(row.offset) < 0 || !Number.isSafeInteger(size) || Number(size) < Number(row.offset)
      || typeof row.prefixHash !== 'string' || !/^[a-f0-9]{64}$/.test(row.prefixHash)
      || row.sourceHash !== undefined && (typeof row.sourceHash !== 'string' || !/^[a-f0-9]{64}$/.test(row.sourceHash))) return;
    if (row.terminal !== undefined) {
      if (typeof row.terminal !== 'string' || !row.terminal.endsWith('\n') || size !== row.offset) return;
      try { if (JSON.parse(row.terminal).type !== 'turn_ended') return; } catch { return; }
    }
    return { offset: Number(row.offset), size: Number(size), prefixHash: row.prefixHash,
      ...(typeof row.sourceHash === 'string' ? { sourceHash: row.sourceHash } : {}),
      ...(typeof row.terminal === 'string' ? { terminal: row.terminal } : {}),
      ...(typeof row.dev === 'number' ? { dev: row.dev } : {}), ...(typeof row.ino === 'number' ? { ino: row.ino } : {}) };
  }
  private calls(message: Message): Record<string, unknown>[] {
    return [...(message.tool_calls ?? []).map(object), ...(Array.isArray(message.content) ? message.content.map(object).filter(block => ['tool_use', 'tool-call', 'function_call'].includes(String(block.type))) : [])];
  }
  /** Cursor's anonymous Shell transcript omits Hook execution defaults and display description. */
  private shell(message: Message): { key: string; timeout: unknown } | undefined {
    const calls = this.calls(message);
    if (calls.length !== 1) return;
    const call = calls[0]!, fn = object(call.function);
    if ((call.name ?? fn.name) !== 'Shell') return;
    let input = call.input ?? fn.arguments;
    try { if (typeof input === 'string') input = JSON.parse(input); } catch { return; }
    const args = object(input);
    if (typeof args.command !== 'string' || Object.keys(args).some(key => !['command', 'cwd', 'timeout', 'description'].includes(key))) return;
    return { key: JSON.stringify([args.command, args.cwd ?? '']), timeout: args.timeout };
  }
  private reconcileCalls(records: TraceInput[], existing: ExistingTrace[], receipt: Receipt, cwd: string) {
    const replacements = new Set<string>();
    const candidates = records.flatMap(record => {
      const call = this.calls(record.message!)[0], fn = object(call?.function);
      const name = call?.name ?? fn.name;
      if (typeof name !== 'string') return [];
      let input = call.input ?? fn.arguments ?? call.arguments;
      if (input === undefined) return [];
      try { if (typeof input === 'string') input = JSON.parse(input); } catch { return []; }
      return [{ record, call, name, input }];
    });
    if (!candidates.some(item => !item.call.id)) return replacements;
    const native = cursorToolEvidence(this.home, cwd, receipt.nativeSessionId, receipt.nativeTurnId);
    for (const { record, call, name, input } of candidates) {
      if (call.id) continue;
      const same = (other: { name: string; input: unknown }) => other.name === name && isDeepStrictEqual(other.input, input);
      const matches = native?.calls.filter(c => same({ name: c.name, input: c.args })) ?? [];
      if (candidates.filter(same).length !== 1 || matches.length > 1) continue;
      const match = matches[0];
      const prefix = `hook:${receipt.nativeSessionId}:tool-call:`;
      let hook = match && existing.find(row => row.sourceId === prefix + match.id);
      const resultId = (id: string) => `hook:${receipt.nativeSessionId}:tool-result:${id}`;
      const hasResult = (id: string) => [...existing, ...records].some(row => row.sourceId === resultId(id));
      // Older Shell hooks can carry an execution UUID distinct from the provider ID.
      // Defaults omitted by the transcript are tolerated only for a unique compatible hook.
      if (!hook && name === 'Shell') {
        const shell = this.shell(record.message!);
        if (shell && candidates.filter(c => this.shell(c.record.message!)?.key === shell.key).length === 1) {
          const possible = existing.filter(row => row.sourceId.startsWith(prefix) && this.shell(row.message)?.key === shell.key);
          const candidate = possible.length === 1 ? possible[0] : undefined;
          const timeout = candidate && this.shell(candidate.message)!.timeout;
          if (shell.timeout === undefined || timeout === undefined || shell.timeout === timeout) hook = candidate;
        }
      } else if (!hook && !match) {
        const key = readKey(name, input);
        if (key && candidates.filter(c => readKey(c.name, c.input) === key).length === 1) {
          const possible = existing.filter(row => {
            if (!row.sourceId.startsWith(prefix)) return false;
            const call = this.calls(row.message)[0], fn = object(call?.function);
            return (readKey(call?.name ?? fn.name, call?.input ?? fn.arguments ?? call?.arguments) ?? row.raw.cursorReadKey) === key;
          });
          if (possible.length === 1) hook = possible[0];
        }
      }
      const hookCall = hook && this.calls(hook.message)[0];
      const id = hook ? hookCall?.id : match?.id;
      if (typeof id !== 'string' || !id.trim() || (hook && hook.sourceId !== prefix + id)) continue;
      if ((!match || match.id !== id) && native?.calls.some(c => c.id === id)) continue;
      if (records.some(other => other.sourceId === prefix + id)) continue;
      const result = name === 'GetDynamicTools' ? native?.results.get(id) : undefined;
      if (!hasResult(id) && result !== undefined) {
        if (!hook && existing.some(row => this.calls(row.message).some(c => object(c.function).name === name))) continue;
        const raw = object(record.raw);
        const part = 1 + Math.max(...records.filter(row => object(row.raw).sourceOrdinal === raw.sourceOrdinal).map(row => Number(object(row.raw).sourcePart)));
        records.push({ ...record, sourceId: resultId(id), raw: { occurredAt: receipt.submittedAt, sourceOrdinal: raw.sourceOrdinal, sourcePart: part },
          message: { role: 'tool', tool_call_id: id, content: result } });
      }
      record.sourceId = prefix + id;
      call.id = id;
      if (!hook || !match || match.id !== id || object(hookCall?.function).name === 'skill') continue;
      // Preserve the Hook's stable message metadata and the transcript's verified position.
      const position = object(record.raw);
      record.raw = { ...hook.raw, sourceOrdinal: position.sourceOrdinal, sourcePart: position.sourcePart };
      record.message = { ...hook.message, tool_calls: [{ ...hookCall, function: { name: match.name, arguments: JSON.stringify(match.args) } }] };
      replacements.add(record.sourceId);
    }
    return replacements;
  }

  private async readTranscript(path: string, receipt: Receipt) {
    if (!receipt.source && receipt.observed) receipt.source = await cursorSource(path, receipt.observed);
    const file = await open(path, 'r');
    try {
      const metadata = await file.stat();
      return { metadata, data: await file.readFile() };
    } finally { await file.close(); }
  }

  private checkpointSource(id: string, receipt: Receipt, metadata: Stats, data: Buffer, previousError: unknown) {
    // Without submission evidence, only an explicit native generation can
    // recover an interval. Matching prompt text or file recency is insufficient.
    if (!receipt.source) {
      const matches: number[] = [];
      let at = 0;
      for (const line of data.subarray(0, data.lastIndexOf(10) + 1).toString('utf8').split('\n')) {
        try {
          const raw = object(JSON.parse(line));
          if (asMessage(raw)?.role === 'user' && textField(raw, 'generation_id', 'turn_id', 'prompt_id') === receipt.nativeTurnId) matches.push(at);
        } catch { /* Invalid or incomplete lines cannot prove a boundary. */ }
        at += Buffer.byteLength(line, 'utf8') + 1;
      }
      if (matches.length !== 1) return conflict(String(previousError ?? 'Cursor 缺少提交时来源边界，原生记录也没有唯一轮次标识'));
      const offset = matches[0]!;
      receipt.source = { dev: metadata.dev, ino: metadata.ino, offset, size: offset, prefixHash: createHash('sha256').update(data.subarray(0, offset)).digest('hex') };
    }
    if (receipt.source.dev !== undefined && receipt.source.dev !== metadata.dev || receipt.source.ino !== undefined && receipt.source.ino !== metadata.ino)
      return conflict('Cursor 原生文件身份或已有内容发生变化，等待核对来源');
    const { source, offset: readOffset } = cursorReadSource(receipt.source, data);
    receipt.source = source;
    this.store.db.prepare('UPDATE cursor_receipts SET event=? WHERE id=?').run(JSON.stringify(receipt), id);
    const competing = this.store.rows('SELECT id,event FROM cursor_receipts WHERE id<>?', id).some(other => {
      const pending = JSON.parse(String(other.event)) as Receipt;
      if (pending.path !== receipt.path || !pending.source) return false;
      try { return cursorReadSource(pending.source, data).offset === readOffset; } catch { return false; }
    });
    if (competing) return conflict('Cursor 多个轮次共享来源边界，无法唯一关联');
    return { kind: 'boundary' as const, readOffset };
  }

  private prepareCompletion(receipt: Receipt, cwd: string, turn: ParsedTurn, existing: ExistingTrace[]) {
    const { records, terminal, readOffset } = turn;
    if (this.claimed(receipt.sessionId, receipt.nativeTurnId, readOffset)) return conflict('Cursor 来源区间已归属另一轮次，无法重复关联');
    if (!['success', 'completed', 'cancelled', 'canceled', 'failed', 'error', 'aborted', 'interrupted'].includes(String(terminal.status))) return waiting('Cursor 原生结束状态尚无法确认');
    const cancelled = ['cancelled', 'canceled', 'failed', 'error', 'aborted', 'interrupted'].includes(String(terminal.status));
    if (!cancelled && !records.some(record => record.message?.role === 'assistant' && cursorText(record.message.content).trim())) return waiting('Cursor 等待本轮最终回答');
    const replacements = this.reconcileCalls(records, existing, receipt, cwd);
    const messages = [...existing.map(record => record.message), ...records.map(record => record.message!)];
    const pendingCalls = new Set(messages.flatMap(message => this.calls(message).flatMap(call => typeof call.id === 'string' ? [call.id] : [])));
    for (const message of messages) {
      if (typeof message.tool_call_id === 'string') pendingCalls.delete(message.tool_call_id);
      if (Array.isArray(message.content)) for (const block of message.content.map(object)) if (block.type === 'tool_result' && typeof block.tool_use_id === 'string') pendingCalls.delete(block.tool_use_id);
    }
    if (pendingCalls.size && !cancelled) return waiting('Cursor 等待已知工具调用结束');
    const children = this.store.rows("SELECT s.id FROM sessions s JOIN turns t ON t.sessionId=s.id LEFT JOIN cursor_receipts r ON r.id=t.id WHERE s.agentType='cursor-cli' AND s.parentNativeSessionId=? AND t.completedAt IS NULL AND (json_extract(r.event,'$.parentNativeTurnId') IS NULL OR json_extract(r.event,'$.parentNativeTurnId')=?)", receipt.nativeSessionId, receipt.nativeTurnId);
    if (children.length) return waiting('Cursor 等待已登记子任务结束');
    return { kind: 'ready' as const, replacements };
  }

  private commitTurn(id: string, receipt: Receipt, turn: ParsedTurn, replacements: Set<string>) {
    const { records, prose, terminal, readOffset } = turn;
    this.store.db.exec('BEGIN IMMEDIATE');
    try {
      for (const hook of this.store.rows("SELECT id,message FROM traces WHERE sessionId=? AND conversationId=? AND batchId IS NULL AND json_extract(raw,'$.hook_event_name')='afterAgentResponse' ORDER BY id", receipt.sessionId, receipt.conversationId)) {
        const message = JSON.parse(String(hook.message)) as Message;
        if (message.role !== 'assistant' || this.calls(message).length) continue;
        const text = cursorText(message.content);
        const matched = text && prose.some((_, start) => {
          let projection = '';
          for (let at = start; at < prose.length; at++) {
            projection += prose[at];
            if (projection === text) return true;
            if (!text.startsWith(projection)) break;
          }
          return false;
        });
        if (!matched) continue; // Unmatched task text must not be discarded.
        this.store.db.prepare('DELETE FROM traces WHERE id=?').run(Number(hook.id));
      }
      this.store.capture(receipt.sessionId, records, replacements);
      for (const record of records) this.store.db.prepare("UPDATE traces SET raw=json_set(raw,'$.sourceOrdinal',?,'$.sourcePart',?) WHERE sessionId=? AND conversationId=? AND sourceId=?")
        .run(Number(object(record.raw).sourceOrdinal), Number(object(record.raw).sourcePart), receipt.sessionId, receipt.conversationId, record.sourceId);
      this.store.db.prepare("UPDATE traces SET raw=json_set(raw,'$.sourceOrdinal',?,'$.sourcePart',-1) WHERE sessionId=? AND conversationId=? AND json_extract(message,'$.role')='user'").run(readOffset, receipt.sessionId, receipt.conversationId);
      const unresolved = records.flatMap(record => this.calls(record.message!).filter(call => !call.id)
        .map(call => String(call.name ?? object(call.function).name ?? 'unknown')));
      if (unresolved.length) this.store.diagnostic(`Cursor 本轮缺少可唯一关联的工具调用 ID：${[...new Set(unresolved)].join('、')}（${receipt.nativeTurnId}）`);
      this.store.finalizeTurn(receipt.sessionId, receipt.nativeTurnId, this.store.memory.recordTime(terminal) ?? receipt.stoppedAt);
      this.store.db.prepare('DELETE FROM cursor_receipts WHERE id=?').run(id);
      this.store.db.exec('COMMIT');
    } catch (error) { if (this.store.db.isTransaction) this.store.db.exec('ROLLBACK'); throw error; }
  }

  private collectTranscript(id: string, receipt: Receipt, session: Session, file: { metadata: Stats; data: Buffer }, previousError: unknown): TurnIssue | undefined {
    const boundary = this.checkpointSource(id, receipt, file.metadata, file.data, previousError);
    if (boundary.kind !== 'boundary') return boundary;
    const endAt = file.data.lastIndexOf(10);
    if (endAt < boundary.readOffset) return waiting('Cursor 等待原生消息完整落盘');
    const existing = this.store.rows("SELECT sourceId,message,raw FROM traces WHERE sessionId=? AND conversationId=? ORDER BY id", receipt.sessionId, receipt.conversationId)
      .map(item => ({ sourceId: String(item.sourceId), raw: object(JSON.parse(String(item.raw))), message: JSON.parse(String(item.message)) as Message }));
    const expected = existing.find(record => record.message.role === 'user')?.message;

    const completeLines = file.data.subarray(boundary.readOffset, endAt + 1);
    const turn = parseTurn(completeLines, boundary.readOffset, receipt, expected, Boolean(session.parentNativeSessionId));
    if (turn.kind !== 'parsed') return turn;
    const completion = this.prepareCompletion(receipt, session.cwd, turn, existing);
    if (completion.kind !== 'ready') return completion;
    this.commitTurn(id, receipt, turn, completion.replacements);
  }

  private async collect() {
    for (const row of this.store.rows('SELECT id,event,error FROM cursor_receipts ORDER BY rowid')) {
      if (this.closed) return;
      const receipt = JSON.parse(String(row.event)) as Receipt;
      const session = this.store.session(receipt.sessionId), scope = session && this.store.memory.forSession(session);
      if (!session || !scope || scope.id !== receipt.scopeId || scope.enabledAt !== receipt.enabledAt || !this.store.memory.allows(scope.id, receipt.submittedAt)) {
        this.store.db.prepare('DELETE FROM cursor_receipts WHERE id=?').run(String(row.id)); continue;
      }

      if (!receipt.stopped) continue;
      let issue: TurnIssue | { kind: 'error'; message: string } | undefined;
      try {
        // Persist synchronous lookup failures before a queued close can interrupt the receipt.
        if (!receipt.path) receipt.path = cursorTranscript(this.home, session.cwd, receipt.nativeSessionId);
        if (receipt.path) {
          const file = await this.readTranscript(receipt.path, receipt);
          if (this.closed) return;
          if (this.store.memory.forSession(session)?.enabledAt !== receipt.enabledAt) continue;
          issue = this.collectTranscript(String(row.id), receipt, session, file, row.error);
        } else {
          issue = waiting(String(row.error ?? 'Cursor 尚未定位本轮原生文件'));
        }
      } catch (error) {
        issue = error instanceof CursorSourceConflict ? error : { kind: 'error', message: error instanceof Error ? error.message : String(error) };
      }
      if (this.closed) return;
      if (!issue) continue;
      const { message } = issue;
      this.store.db.prepare('UPDATE cursor_receipts SET error=? WHERE id=?').run(message, String(row.id));
      if (row.error !== message) this.store.diagnostic(`Cursor 轨迹补读: ${message}`);
    }
  }
}
