import { open, readFile, readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, isAbsolute, join, resolve } from 'node:path';
import type { TraceInput } from '../types.ts';
import { object } from '../_shared/transcript.ts';
import { executionMessage, normalizeTaskTrace } from '../_shared/task-trace.ts';

export function primePaths(home?: string, env: NodeJS.ProcessEnv = process.env) {
  const userHome = home ?? homedir();
  const expand = (path: string) => path === '~' ? userHome : path.startsWith('~/') ? join(userHome, path.slice(2)) : resolve(path);
  const agent = !home && env.PRIME_AGENT_CODING_AGENT_DIR ? expand(env.PRIME_AGENT_CODING_AGENT_DIR) : join(userHome, '.prime/agent');
  const sessions = !home && env.PRIME_AGENT_SESSION_DIR ? expand(env.PRIME_AGENT_SESSION_DIR) : join(agent, 'sessions');
  return { agent, sessions };
}

export type PrimeSource = { path: string; nativeSessionId: string; cwd: string };
export type PrimeTurn = { key: string; records: TraceInput[]; completedAt?: string };
export type PrimeSession = PrimeSource & { turns: PrimeTurn[]; currentTurn?: string; title?: string; partial: boolean };

function source(path: string, value: unknown): PrimeSource | undefined {
  const row = object(value);
  if (row.type !== 'session' || typeof row.id !== 'string' || row.id !== basename(path, '.jsonl')
      || typeof row.cwd !== 'string' || !isAbsolute(row.cwd)) return;
  return { path, nativeSessionId: row.id, cwd: resolve(row.cwd) };
}

/** The native flat session store is an index of directories; never scan code roots. */
export async function primeSources(home?: string): Promise<PrimeSource[]> {
  const root = primePaths(home).sessions;
  let entries;
  try { entries = await readdir(root, { withFileTypes: true }); }
  catch (error) { if (object(error).code === 'ENOENT') return []; throw error; }
  const result: PrimeSource[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
    const path = join(root, entry.name);
    try {
      const file = await open(path, 'r');
      let text: string;
      try { const buffer = Buffer.alloc(65536); const { bytesRead } = await file.read(buffer); text = buffer.subarray(0, bytesRead).toString('utf8'); }
      finally { await file.close(); }
      const end = text.indexOf('\n');
      if (end < 0) continue;
      const header = source(path, JSON.parse(text.slice(0, end)));
      if (header) result.push(header);
    } catch { /* A missing, malformed or concurrently replaced header discovers nothing. */ }
  }
  return result.sort((a, b) => a.path.localeCompare(b.path));
}

/** Read only complete JSONL records and use native entry IDs and parent links. */
export async function readPrimeSession(path: string): Promise<PrimeSession> {
  const content = await readFile(path, 'utf8'), end = content.lastIndexOf('\n');
  const lines = content.slice(0, end + 1).split('\n').filter(line => line.trim());
  const header = source(path, JSON.parse(lines.shift() ?? '{}'));
  if (!header) throw new Error('Prime 会话头缺少可靠身份或项目目录');
  const session: PrimeSession = { ...header, turns: [], partial: !content.endsWith('\n') };
  const seen = new Map<string, string>(), owners = new Map<string, PrimeTurn | undefined>();
  const calls = new Map<PrimeTurn, Set<string>>();
  for (const line of lines) {
    const raw = object(JSON.parse(line));
    if (typeof raw.id !== 'string') throw new Error('Prime 原生记录缺少稳定 ID');
    const prior = seen.get(raw.id);
    if (prior !== undefined) { if (prior !== line) throw new Error('Prime 原生记录 ID 内容冲突'); continue; }
    seen.set(raw.id, line);
    if (raw.parentId !== null && raw.parentId !== undefined && (typeof raw.parentId !== 'string' || !owners.has(raw.parentId)))
      throw new Error('Prime 原生记录父链不完整');
    let turn = typeof raw.parentId === 'string' ? owners.get(raw.parentId) : undefined;
    const message = object(raw.message);
    let record = raw.type === 'message' ? normalizeTaskTrace('prime-agent', { sourceId: `entry:${raw.id}`, raw }) : undefined;
    if (record?.message?.role === 'user') {
      turn = { key: raw.id, records: [] };
      session.turns.push(turn); calls.set(turn, new Set());
    }
    owners.set(raw.id, turn);
    session.currentTurn = turn?.key;
    if (raw.type === 'session_info' && typeof raw.name === 'string') session.title = raw.name;
    if (!turn) continue;
    const pending = calls.get(turn)!;
    if (raw.type === 'tool_started') {
      if (typeof raw.toolCallId !== 'string') throw new Error('Prime 工具开始缺少调用 ID');
      if (!pending.has(raw.toolCallId)) {
        const tool = executionMessage({ ...raw, type: 'tool_execution_start' });
        if (!tool) throw new Error('Prime 工具开始格式无效');
        record = { sourceId: `entry:${raw.id}`, raw, message: tool };
      }
      pending.add(raw.toolCallId);
      turn.completedAt = undefined;
    }
    if (raw.type !== 'message' && raw.type !== 'tool_started') continue;
    if (!record?.message) { turn.completedAt = undefined; continue; }
    turn.records.push({ ...record, nativeTurnId: turn.key });
    turn.completedAt = undefined;
    if (record.message.role === 'assistant') {
      for (const part of Array.isArray(message.content) ? message.content : []) {
        const call = object(part);
        if (call.type !== 'toolCall') continue;
        if (typeof call.id !== 'string') throw new Error('Prime 工具调用缺少稳定 ID');
        pending.add(call.id);
      }
      if (!pending.size && ['stop', 'length'].includes(String(message.stopReason)) && typeof raw.timestamp === 'string')
        turn.completedAt = raw.timestamp;
    } else if (record.message.role === 'tool') {
      if (typeof message.toolCallId !== 'string' || !pending.delete(message.toolCallId)) throw new Error('Prime 工具结果缺少对应调用');
      // rlm.end_turn can end on a tool result. This is only a candidate:
      // the capture service must additionally prove native idle/no queued work.
      if (!pending.size && typeof raw.timestamp === 'string') turn.completedAt = raw.timestamp;
    }
  }
  return session;
}
