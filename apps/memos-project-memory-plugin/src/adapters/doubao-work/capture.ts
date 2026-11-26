import { readFile, readdir, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Store } from '../../storage/store.ts';
import { filterSkillRecords, hasIncompleteSkill, parseSkillArgs, skillCommand, skillFileName } from '../_shared/skill-records.ts';
import { object } from '../_shared/transcript.ts';
import type { Message, TraceInput } from '../types.ts';
import { cachedDoubaoReply, doubaoChatCachePath } from './cache.ts';
export { doubaoChatCachePath } from './cache.ts';
import type { DoubaoTurn } from './host.ts';

export const doubaoSessionsPath = (home = homedir()) =>
  join(home, 'Library/Application Support/DoubaoWork/Default/.doubaowork/agent_mode/workspace/.sessions');

function turnRows(assignment: string, trajectory: string, startedAt: number): Message[] | undefined {
  const headings = [...assignment.matchAll(/^## \[(\d{4}-\d\d-\d\dT[^\]\r\n]+)\] 需求\r?\n/gm)];
  const requests = headings.map((h, i) => ({
    time: Date.parse(h[1]), text: assignment.slice(h.index + h[0].length, headings[i + 1]?.index).trim(),
  }));
  const index = requests.findIndex(request => request.time === startedAt);
  if (index < 0 || requests.some((r, i) => !r.text || !Number.isFinite(r.time) || i > 0 && r.time <= requests[i - 1].time)) return;
  // Only complete, newline-committed records establish a turn boundary.
  if (!trajectory.endsWith('\n')) return;
  const lines = trajectory.trimEnd().split('\n').map(line => object(JSON.parse(line)));
  let group = 0;
  const selected: Message[] = [{ role: 'user', content: requests[index].text }];
  for (const [ordinal, row] of lines.entries()) {
    if (row.role === 'user') {
      const text = typeof row.content === 'string' ? row.content.trim() : undefined;
      // The native journal may omit the very first user row. Identical opening
      // requests cannot distinguish a missing first row from a present one.
      if (!ordinal && text === requests[0].text && text === requests[1]?.text) return;
      if (ordinal || text !== requests[0].text) group++;
      if (text !== requests[group]?.text) return;
      if (group > index) break;
      continue;
    }
    if (group !== index) continue;
    if (row.role !== 'assistant' && row.role !== 'tool') return;
    if (row.content !== undefined && typeof row.content !== 'string') return;
    if (row.role === 'tool' && (typeof row.content !== 'string' || typeof row.tool_call_id !== 'string')) return;
    if (row.tool_calls !== undefined && (!Array.isArray(row.tool_calls) || row.role !== 'assistant')) return;
    const message: Message = { role: row.role, content: typeof row.content === 'string' ? row.content : '' };
    if (row.role === 'tool') message.tool_call_id = row.tool_call_id;
    if (Array.isArray(row.tool_calls)) message.tool_calls = row.tool_calls.map(value => {
      const call = object(value), fn = object(call.function);
      return { id: call.id, type: call.type, function: { name: fn.name, ...(Object.hasOwn(fn, 'arguments') ? { arguments: fn.arguments } : {}) } };
    });
    if (row.role === 'assistant' && typeof row.reasoning_content === 'string') message.reasoning_content = row.reasoning_content;
    selected.push(message);
  }
  return group >= index && selected.length > 1 ? selected : undefined;
}

function pairedTools(rows: Message[]): boolean {
  const seen = new Set<string>(), pending = new Set<string>();
  for (const row of rows) {
    if (row.role === 'tool') {
      if (!pending.delete(String(row.tool_call_id))) return false;
    } else {
      if (pending.size) return false;
      for (const value of row.tool_calls ?? []) {
        const call = object(value), fn = object(call.function);
        if (call.type !== 'function' || typeof call.id !== 'string' || !call.id.trim() || seen.has(call.id)
          || typeof fn.name !== 'string' || !fn.name.trim() || !Object.hasOwn(fn, 'arguments')) return false;
        seen.add(call.id); pending.add(call.id);
      }
    }
  }
  return pending.size === 0;
}

export async function readDoubaoTurn(turn: DoubaoTurn & { endedAt?: number }, home = homedir()): Promise<TraceInput[] | undefined> {
  if (![turn.sessionId, turn.questionId, turn.answerId].every(id => /^\d+$/.test(id))) return;
  try {
    const sessions = await realpath(doubaoSessionsPath(home));
    const agents = join(sessions, turn.sessionId, 'agents');
    if (await realpath(agents) !== agents) return;
    let selected: Message[] | undefined;
    for (const agent of await readdir(agents, { withFileTypes: true })) {
      if (!agent.isDirectory()) continue;
      const system = join(agents, agent.name, 'system');
      const assignmentPath = join(system, 'assignment.md');
      let assignment: string;
      try {
        if (await realpath(assignmentPath) !== assignmentPath) return;
        assignment = await readFile(assignmentPath, 'utf8');
      } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
      if (!/^- Role: main$/m.test(assignment.split(/^## /m, 1)[0])) continue;
      if (selected) return;
      const trajectory = join(system, 'trajectory.jsonl');
      if (await realpath(trajectory) !== trajectory) return;
      selected = turnRows(assignment, await readFile(trajectory, 'utf8'), turn.startedAt);
      if (!selected || !pairedTools(selected)) return;
    }
    if (!selected) return;
    const last = selected.at(-1)!;
    const cached = await cachedDoubaoReply(doubaoChatCachePath(home), turn);
    if (cached === null) return;
    if (last.role === 'assistant' && String(last.content).trim() && !last.tool_calls?.length) {
      if (cached !== undefined && cached !== last.content) return;
    } else {
      if (last.role !== 'tool' || !cached) return;
      selected.push({ role: 'assistant', content: cached });
    }
    selected[0].id = turn.questionId;
    selected.at(-1)!.id = turn.answerId;
    if (turn.endedAt !== undefined) selected.at(-1)!.chat_time = new Date(turn.endedAt).toISOString();
    selected[0].chat_time = new Date(turn.startedAt).toISOString();
    // The journal has no per-tool timestamps. Use the verified request time
    // only for capture-window admission, while preserving native message times.
    const records = selected.map((message, i) => ({
      sourceId: 'doubao:' + turn.questionId + ':' + i, nativeTurnId: turn.questionId,
      raw: { type: 'doubao-work.trajectory', occurredAt: new Date(turn.startedAt).toISOString() }, message,
    }));
    const filtered = filterSkillRecords(records, (tool, raw) => {
      const args = parseSkillArgs(raw);
      if (tool === 'Bash') return skillCommand(args.command);
      if (tool === 'Read') { const name = skillFileName(args.file_path); if (name) return { name }; }
      if (tool === 'Skill') return { name: typeof args.skill === 'string' ? args.skill : 'unknown' };
    });
    if (filtered.some(record => hasIncompleteSkill(record.message))) return;
    return filtered;
  } catch (error) {
    if (error instanceof SyntaxError || ['ENOENT', 'ENOTDIR', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? '')) return;
    throw error;
  }
}

export async function captureDoubaoTurn(store: Store, turn: DoubaoTurn & { endedAt?: number }, home = homedir(), stillEnabled: () => boolean | Promise<boolean> = () => true): Promise<'complete' | 'pending' | 'inactive'> {
  const time = new Date(turn.startedAt).toISOString();
  const scope = store.memory.resolve('doubao-work', turn.root);
  if (!scope || scope.root !== turn.root || !store.memory.allows(scope.id, time)) return 'inactive';
  const completed = () => store.row(`SELECT t.completedAt FROM sessions s JOIN turns t ON t.sessionId=s.id
    WHERE s.agentType='doubao-work' AND s.nativeSessionId=? AND s.cwd=? AND s.objectId=? AND t.nativeKey=?`, turn.sessionId, turn.root, scope.id, turn.questionId)?.completedAt;
  if (completed()) return 'complete';
  const records = await readDoubaoTurn(turn, home);
  if (!await stillEnabled()) return 'inactive';
  const current = store.memory.resolve('doubao-work', turn.root);
  if (current?.id !== scope.id || current.root !== turn.root || current.enabledAt !== scope.enabledAt
    || current.connectionId !== scope.connectionId || !store.memory.allows(scope.id, time)) return 'inactive';
  if (!records) return 'pending';
  if (completed()) return 'complete';
  store.db.exec('BEGIN');
  try {
    const session = store.registerSession({ agentType: 'doubao-work', nativeSessionId: turn.sessionId, cwd: turn.root });
    if (session.cwd !== turn.root || session.objectId !== scope.id) { store.db.exec('ROLLBACK'); return 'inactive'; }
    store.startTurn(session.id, turn.questionId, false);
    store.capture(session.id, records);
    store.finalizeTurn(session.id, turn.questionId, turn.endedAt === undefined ? undefined : new Date(turn.endedAt).toISOString());
    store.db.exec('COMMIT');
    return 'complete';
  } catch (error) { store.db.exec('ROLLBACK'); throw error; }
}
