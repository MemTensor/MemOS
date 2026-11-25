import { createHash } from 'node:crypto';
import { open } from 'node:fs/promises';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, resolve, basename } from 'node:path';
import type { Stats } from 'node:fs';
import { orderTraceRecords } from '../../storage/trace-order.ts';
import { object } from '../_shared/transcript.ts';

export type CursorSource = { dev?: number; ino?: number; offset: number; prefixHash: string; size: number; sourceHash?: string; terminal?: string };

function sourceBoundary(bytes: Buffer): CursorSource {
  let offset = 0, start = 0, terminal: string | undefined;
  for (let end = bytes.indexOf(10); end >= 0; end = bytes.indexOf(10, start)) {
    try {
      if (JSON.parse(bytes.subarray(start, end).toString('utf8')).type === 'turn_ended') {
        offset = end + 1;
        if (offset === bytes.length) {
          terminal = bytes.subarray(start).toString('utf8');
          offset = start;
        }
      }
    } catch { /* Incomplete or invalid records cannot establish an end boundary. */ }
    start = end + 1;
  }
  const size = terminal === undefined ? bytes.length : offset;
  return { offset, size, prefixHash: createHash('sha256').update(bytes.subarray(0, offset)).digest('hex'),
    sourceHash: createHash('sha256').update(bytes.subarray(0, size)).digest('hex'), ...(terminal === undefined ? {} : { terminal }) };
}

/** Validate immutable task bytes; the final lifecycle marker may be retained or replaced. */
export function cursorReadSource(source: CursorSource, data: Buffer): { source: CursorSource; offset: number } {
  // Legacy receipts hashed the trailing marker too. Upgrade only after reproducing
  // their exact original snapshot, never from a guessed byte count or prompt match.
  if (source.terminal === undefined && source.offset === source.size && source.size > 0) {
    const candidates = [data.subarray(0, source.size)];
    let start = 0;
    for (let end = data.indexOf(10); end >= 0; end = data.indexOf(10, start)) {
      try {
        if (JSON.parse(data.subarray(start, end).toString('utf8')).type === 'turn_ended') {
          const terminal = data.subarray(start, end + 1), prefix = source.size - terminal.length;
          if (prefix >= 0 && (prefix === 0 || data[prefix - 1] === 10)) candidates.push(Buffer.concat([data.subarray(0, prefix), terminal]));
        }
      } catch { /* Only observed complete terminal records can reconstruct an old snapshot. */ }
      start = end + 1;
    }
    for (const bytes of candidates) {
      const hash = createHash('sha256').update(bytes).digest('hex');
      if (bytes.length !== source.size || hash !== source.prefixHash || source.sourceHash !== undefined && hash !== source.sourceHash) continue;
      const boundary = sourceBoundary(bytes);
      if (boundary.terminal !== undefined) source = { ...source, ...boundary };
      break;
    }
  }
  if (data.length < source.size || createHash('sha256').update(data.subarray(0, source.offset)).digest('hex') !== source.prefixHash
    || source.sourceHash !== undefined && createHash('sha256').update(data.subarray(0, source.size)).digest('hex') !== source.sourceHash)
    throw new Error('Cursor 原生文件身份或已有内容发生变化，等待核对来源');
  let offset = source.offset;
  if (source.terminal !== undefined) {
    const terminal = Buffer.from(source.terminal);
    if (data.subarray(offset, offset + terminal.length).equals(terminal)) offset += terminal.length;
  }
  return { source, offset };
}

/** Resolve host-owned directories, never reverse the lossy workspace directory name. */
export function cursorTranscript(home: string, cwd: string, sessionId: string): string | undefined {
  if (basename(sessionId) !== sessionId || sessionId === '.' || sessionId === '..') return;
  const root = join(home, '.cursor/projects'), candidates: string[] = [];
  let entries;
  try { entries = readdirSync(root, { withFileTypes: true }); }
  catch (error) { if (object(error).code === 'ENOENT') return; throw error; }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const directory = join(root, entry.name), path = join(directory, 'agent-transcripts', sessionId, `${sessionId}.jsonl`);
    let workspace: unknown;
    try { workspace = JSON.parse(readFileSync(join(directory, '.workspace-trusted'), 'utf8')).workspacePath; }
    catch { /* Exact session ID lookup also works for older workspaces without trust metadata. */ }
    if (typeof workspace === 'string' ? resolve(workspace) === resolve(cwd) : existsSync(path)) candidates.push(path);
  }
  if (candidates.length > 1) throw new Error('Cursor 会话文件存在多个候选路径，无法唯一定位');
  return candidates[0];
}

/** Merge proven native positions with Hook results without inventing native timestamps. */
export function orderCursorTraces<T extends Record<string, unknown>>(rows: T[]): T[] {
  const groups = new Map<string, T[]>(), replacements = new Map<T, T>();
  const parse = (value: unknown) => { if (typeof value !== 'string') return object(value); try { return object(JSON.parse(value)); } catch { return {}; } };
  for (const row of rows) {
    const key = JSON.stringify([row.sessionId, row.conversationId ?? row.id]);
    const group = groups.get(key) ?? []; group.push(row); groups.set(key, group);
  }
  for (const group of groups.values()) {
    const native = group.filter(row => Number.isInteger(parse(row.raw).sourcePart));
    if (native.length < 2) continue;
    native.sort((left, right) => Number(parse(left.raw).sourceOrdinal) - Number(parse(right.raw).sourceOrdinal)
      || Number(parse(left.raw).sourcePart) - Number(parse(right.raw).sourcePart));
    const positions = new Map(native.map((row, index) => [row, index]));
    const nodes = group.map((row, index) => ({ sourceId: String(index), originSessionId: positions.has(row) ? 'native' : `hook:${index}`,
      sourceOrdinal: positions.get(row) ?? index, occurredAt: String(index).padStart(String(group.length).length, '0'), message: parse(row.message), row }));
    const calls = new Map<string, string>(), edges: [string, string][] = [];
    for (const node of nodes) for (const call of [...(Array.isArray(node.message.tool_calls) ? node.message.tool_calls : []),
      ...(Array.isArray(node.message.content) ? node.message.content.filter(part => ['tool_use', 'tool-call', 'function_call'].includes(String(object(part).type))) : [])]) {
      if (typeof object(call).id === 'string') calls.set(String(object(call).id), node.sourceId);
    }
    for (const node of nodes) {
      const ids = [node.message.tool_call_id, ...(Array.isArray(node.message.content) ? node.message.content.map(part => object(part).type === 'tool_result' ? object(part).tool_use_id : undefined) : [])];
      for (const id of ids) if (typeof id === 'string' && calls.has(id)) edges.push([calls.get(id)!, node.sourceId]);
    }
    const ordered = orderTraceRecords(nodes, edges);
    if (ordered.cyclic) throw new Error('Cursor 轨迹来源顺序冲突，等待核对');
    ordered.records.forEach((node, index) => replacements.set(group[index]!, node.row));
  }
  return rows.map(row => replacements.get(row) ?? row);
}

/** The entry-time stat limits the read even if a prompt/answer flush races the hook. */
export async function cursorSource(path: string, observed?: Pick<Stats, 'dev' | 'ino' | 'size'>): Promise<CursorSource> {
  const empty = createHash('sha256').digest('hex');
  if (!observed) return { offset: 0, size: 0, prefixHash: empty, sourceHash: empty };
  const file = await open(path, 'r');
  try {
    const current = await file.stat();
    if (current.dev !== observed.dev || current.ino !== observed.ino || current.size < observed.size) throw new Error('Cursor 会话文件在提交期间发生变化');
    const bytes = Buffer.alloc(observed.size);
    let read = 0;
    while (read < bytes.length) {
      const result = await file.read(bytes, read, bytes.length - read, read);
      if (!result.bytesRead) throw new Error('Cursor 会话文件在提交期间被截断');
      read += result.bytesRead;
    }
    return { dev: observed.dev, ino: observed.ino, ...sourceBoundary(bytes) };
  } finally { await file.close(); }
}
