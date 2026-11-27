import { constants, existsSync, watch, type FSWatcher } from 'node:fs';
import { open, readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { object } from '../_shared/transcript.ts';

export interface DoubaoTurn { sessionId: string; questionId: string; answerId: string; root: string; startedAt: number }
export type CompletedDoubaoTurn = DoubaoTurn & { endedAt: number };
interface Answer {
  questionIds: Set<string>; starts: Set<number>; began: boolean; ended: boolean; endedAt?: number; failed: boolean;
}
interface Conversation {
  title?: { name: string; version: number };
  roots: Set<string>; ack: Map<string, Set<number>>; answers: Map<string, Answer>;
}
type Cursor = { ino: number; dev: number; offset: number; mtimeMs: number; partial: Buffer };
const frontend = /^saman_frontend_\d{4}\.\d{4}\.\d+\.log$/;
const nativeId = (value: unknown): value is string => typeof value === 'string' && /^\d+$/.test(value);

function jsonObject(value: unknown): Record<string, unknown> {
  if (typeof value !== 'string') return object(value);
  try { return object(JSON.parse(value)); } catch { return {}; }
}

function singleton<T>(items: Set<T>): T | undefined { return items.size === 1 ? items.values().next().value : undefined; }

function answer(conv: Conversation, id: string): Answer {
  let value = conv.answers.get(id);
  if (!value) {
    value = { questionIds: new Set(), starts: new Set(), began: false, ended: false, failed: false };
    conv.answers.set(id, value);
  }
  return value;
}

function addRoot(conv: Conversation, workspace: unknown) {
  if (typeof workspace === 'string' && isAbsolute(workspace) && !workspace.includes('\0')) conv.roots.add(resolve(workspace));
}

/** Accept records only from the host chat logger, never from a quoted tool result or chat message. */
function envelope(line: string) {
  if (!line.includes('SSE_ACK:') && !line.includes('Cmd: Conversation') && !line.includes('general_agent_task_param_workspace_changed')
      && !line.includes('on_message_receiving_start') && !line.includes('on_message_session_end')) return;
  const prefix = /^\[\d+:\d+:\d{4}\/\d{6}\.\d+:INFO:FRONTEND\(\d+\)\] \[neotix\] \[office-api-logger\] \[page_load_metrics\]\[doubaowork-chat\]\[[^\]]*\]\[[^\]]*\] "\[webview\]\[[^\]]*\]\[flow-web\]\[logifier-report\]: /;
  const start = prefix.exec(line);
  const end = line.lastIndexOf('", source: ');
  if (!start || end < start[0].length) return;
  const row = jsonObject(line.slice(start[0].length, end));
  return row.version === 1 ? row : undefined;
}

class Index {
  conversations = new Map<string, Conversation>();
  conversation(id: string) {
    let conv = this.conversations.get(id);
    if (!conv) { conv = { roots:new Set(), ack:new Map(), answers:new Map() }; this.conversations.set(id, conv); }
    return conv;
  }
  read(line: string, year: number) {
    const row = envelope(line);
    if (!row) return;
    const m = object(row.meta), msg = row.message;
    if (row.type === 'log' && typeof msg === 'string' && msg.startsWith('SSE_ACK:')) {
      const match = /^SSE_ACK:\s*queryList: (.*?)\s+ackClientMeta: (.*)$/s.exec(msg);
      if (!match) return;
      const client = jsonObject(match[2]);
      if (!nativeId(client.conversation_id)) return;
      let questions: unknown;
      try { questions = JSON.parse(match[1]!); } catch { return; }
      if (!Array.isArray(questions)) return;
      const conv = this.conversation(client.conversation_id);
      for (const query of questions) {
        const {question_id:id, message_index:index} = object(query);
        if (!nativeId(id) || typeof index !== 'number' || !Number.isSafeInteger(index) || index < 0) continue;
        let indexes = conv.ack.get(id);
        if (!indexes) { indexes = new Set(); conv.ack.set(id, indexes); }
        indexes.add(index);
      }
      return;
    }
    if (row.type === 'event' && row.eventName === 'general_agent_task_param_workspace_changed' && nativeId(m.chatId)) {
      addRoot(this.conversation(m.chatId), m.resWorkspace);
      return;
    }
    if (!nativeId(m.conversation_id)) return;
    if (row.type === 'log' && (msg === 'Cmd: ConversationAdd' || msg === 'Cmd: ConversationUpdate')) {
      const info = jsonObject(m.conversation_info);
      if (info.conversation_id !== m.conversation_id) return;
      const conv = this.conversation(m.conversation_id), extra = jsonObject(info.extra);
      addRoot(conv, jsonObject(extra.agent_task_param).workspace);
      const { name, version } = info;
      if (typeof name === 'string' && name.trim() && typeof version === 'number' && Number.isSafeInteger(version)
        && version > (conv.title?.version ?? -1)) conv.title = { name: name.trim(), version };
      for (const [id, status] of Object.entries(jsonObject(extra.running_messages))) {
        const time = object(status).started_at_ms;
        if (nativeId(id) && typeof time === 'number' && Number.isSafeInteger(time) && time > 0) answer(conv,id).starts.add(time);
      }
      return;
    }
    if (row.type !== 'event' || row.eventName !== msg || m.mode_type !== 'work_task' || m.is_local_computer_on !== 1
      || !nativeId(m.receive_message_id) || (msg !== 'on_message_receiving_start' && msg !== 'on_message_session_end')) return;
    const a = answer(this.conversation(m.conversation_id), m.receive_message_id);
    if (msg === 'on_message_session_end') a.ended = true;
    if (!nativeId(m.send_message_id)) return; // Parallel view notifications omit question identity.
    a.questionIds.add(m.send_message_id);
    if (msg === 'on_message_receiving_start') { a.began = true; return; }
    if (m.session_success !== '1' || m.receive_success !== '1' || m.cancel_source !== '' || m.receive_err || m.session_err
      || (m.agent_error && m.agent_error !== '0')) { a.failed = true; return; }
    const stamp = /^\[\d+:\d+:(\d{2})(\d{2})\/(\d{2})(\d{2})(\d{2})\.(\d{3})/.exec(line);
    if (stamp) {
      // The frontend prints local month/day and time; its log filename supplies the year.
      const time = new Date(year, Number(stamp[1])-1, Number(stamp[2]), Number(stamp[3]), Number(stamp[4]), Number(stamp[5]), Number(stamp[6])).getTime();
      a.endedAt = Math.min(a.endedAt ?? time, time);
    }
  }

  resolve(sid: string, aid: string, live: boolean): DoubaoTurn | undefined {
    const conv = this.conversations.get(sid), a = conv?.answers.get(aid);
    if (!conv || !a?.began || (live ? a.ended : !a.endedAt || a.failed)) return;
    const root = singleton(conv.roots), startedAt = singleton(a.starts), questionId = singleton(a.questionIds);
    if (!root || !startedAt || !questionId || !live && a.endedAt! < startedAt) return;
    const order = conv.ack.get(questionId);
    const index = order && singleton(order);
    if (index === undefined) return;
    for (const [other, indexes] of conv.ack) {
      if (other !== questionId && (indexes.has(index) || live && [...indexes].some(n => n > index))) return;
    }
    for (const [other, evidence] of conv.answers) {
      if (other === aid) continue;
      if (evidence.questionIds.has(questionId) || evidence.starts.has(startedAt)) return;
      if (live && [...evidence.starts].some(n => n > startedAt)) return;
      if (live && evidence.began && !evidence.ended && !evidence.starts.size) {
        const q = singleton(evidence.questionIds), order = q && conv.ack.get(q);
        if (!order || singleton(order) === undefined) return;
      }
    }
    return {sessionId:sid, questionId, answerId:aid, root, startedAt};
  }
}

/** Index host metadata once and tail complete new lines on demand. No chat bodies are persisted. */
export class DoubaoHost {
  readonly directory: string;
  private index = new Index();
  private cursors = new Map<string, Cursor>();
  private queue: Promise<void> = Promise.resolve();
  private watcher?: FSWatcher;
  constructor(home = homedir()) { this.directory = join(home,'Library/Application Support/DoubaoWork/sdk_storage/log'); }

  refresh(): Promise<void> {
    const next = this.queue.then(() => this.readChanges());
    this.queue = next.catch(() => { this.index = new Index(); this.cursors.clear(); });
    return next;
  }
  private async readChanges() {
    let names: string[];
    try { names = (await readdir(this.directory,{withFileTypes:true})).filter(e=>e.isFile() && frontend.test(e.name)).map(e=>e.name).sort(); }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; names=[]; }
    // A removed/truncated log can invalidate earlier identity evidence; rebuild from retained sources.
    if ([...this.cursors.keys()].some(name=>!names.includes(name))) { this.cursors.clear(); this.index = new Index(); }
    for (const name of names) {
      const year = Number(name.slice('saman_frontend_'.length).split('.')[0]);
      const file = await open(join(this.directory,name),constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const stat = await file.stat();
        if (!stat.isFile()) continue;
        let cursor = this.cursors.get(name);
        if (cursor && (cursor.ino !== stat.ino || cursor.dev !== stat.dev || stat.size < cursor.offset
          || stat.size === cursor.offset && stat.mtimeMs !== cursor.mtimeMs)) {
          this.cursors.clear(); this.index = new Index();
          await this.readChanges(); return;
        }
        if (!cursor) { cursor = {ino:stat.ino, dev:stat.dev, offset:0, mtimeMs:stat.mtimeMs, partial:Buffer.alloc(0)}; this.cursors.set(name,cursor); }
        if (stat.size === cursor.offset) continue;
        const stream = file.createReadStream({start:cursor.offset,end:stat.size-1,autoClose:false});
        for await (const chunk of stream) {
          const bytes = cursor.partial.length ? Buffer.concat([cursor.partial,chunk]) : chunk as Buffer;
          let start = 0, end = bytes.indexOf(10);
          while (end >= 0) {
            this.index.read(bytes.toString('utf8',start,end),year);
            start = end+1; end=bytes.indexOf(10,start);
          }
          cursor.partial = start === bytes.length ? Buffer.alloc(0) : bytes.subarray(start);
          cursor.offset += chunk.length;
        }
        cursor.mtimeMs = stat.mtimeMs;
      } finally { await file.close(); }
    }
  }

  sessionTitle(sessionId: string, cwd: string) {
    const conversation = this.index.conversations.get(sessionId);
    if (conversation && singleton(conversation.roots) === cwd) return conversation.title;
  }
  active(sessionId: string, answerId: string) { return this.index.resolve(sessionId,answerId,true); }
  completed(): CompletedDoubaoTurn[] {
    const turns: CompletedDoubaoTurn[] = [];
    for (const [sid,conv] of this.index.conversations) for (const id of conv.answers.keys()) {
      const turn = this.index.resolve(sid,id,false);
      if (turn) turns.push({ ...turn, endedAt: conv.answers.get(id)!.endedAt! });
    }
    return turns;
  }

  /** A not-yet-running host may not have created its log directory on initial install. */
  watch(onChange: () => void): () => void {
    this.close();
    let current: FSWatcher | undefined;
    const stop = () => {
      if (current && this.watcher === current) this.close();
    };
    const arm = () => {
      let target = this.directory;
      while (!existsSync(target) && dirname(target) !== target) target = dirname(target);
      const next = relative(target, this.directory).split(sep)[0];
      try {
        const watcher = watch(target, {persistent:false}, (_event, filename) => {
          if (this.watcher !== watcher) return;
          if (filename && (next ? filename !== next : !frontend.test(filename)) && existsSync(target)) return;
          if (next || !existsSync(target)) { stop(); arm(); }
          onChange();
        });
        current = this.watcher = watcher;
        watcher.on('error', () => {
          if (this.watcher !== watcher) return;
          stop();
          arm();
          onChange();
        });
        // The missing component may have appeared between discovery and watch().
        if (next && existsSync(join(target,next))) { stop(); arm(); }
      } catch { stop(); }
    };
    arm();
    return stop;
  }
  close() { this.watcher?.close(); this.watcher = undefined; }
}
