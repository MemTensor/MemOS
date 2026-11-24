import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import type { AgentEvent } from '../types.ts';
import { object } from '../_shared/transcript.ts';
import type { Store } from '../../storage/store.ts';
import { primePaths, primeSources, readPrimeSession, type PrimeSession } from './sessions.ts';

/** Official read-only roster; no TUI wrapping, hooks or model calls. */
export async function primeStatus(home?: string): Promise<Record<string, unknown>[]> {
  const paths = primePaths(home);
  const { stdout } = await promisify(execFile)('prime-agent', ['list', '--all', '--json'], {
    env: { ...process.env, PRIME_AGENT_CODING_AGENT_DIR: paths.agent, PRIME_AGENT_SESSION_DIR: paths.sessions },
    timeout: 5000, maxBuffer: 8 * 1024 * 1024,
  });
  const value = object(JSON.parse(stdout));
  if (!Array.isArray(value.sessions)) throw new Error('Prime 会话状态响应无效');
  return value.sessions.map(object);
}

export function primeIdle(session: PrimeSession, rows: Record<string, unknown>[]): boolean {
  const row = rows.find(row => row.sessionId === session.nativeSessionId && typeof row.sessionFile === 'string' && resolve(row.sessionFile) === session.path
    && typeof row.cwd === 'string' && resolve(row.cwd) === session.cwd);
  const actions = object(row?.sessionActions);
  return !!row && row.activity === 'idle' && row.isSessionActive === false && row.isStreaming === false && row.isCompacting === false
    && (row.unfinishedActionCount === undefined || row.unfinishedActionCount === 0) && actions.queuedCount === 0
    && row.isRunningTools !== true && row.hasRunningRlmChildren !== true && row.isBashRunning !== true
    && Array.isArray(actions.steering) && !actions.steering.length && Array.isArray(actions.followUps) && !actions.followUps.length;
}

export class PrimeCapture {
  private store: Store;
  private home?: string;
  private closed = false;
  private running?: Promise<void>;
  private scanned = new Map<string, string>();
  private errors = new Map<string, string>();
  readStatus: () => Promise<Record<string, unknown>[]>;
  constructor(store: Store, home?: string) { this.store = store; this.home = home; this.readStatus = () => primeStatus(home); }
  close() { this.closed = true; }
  async flush() {
    if (this.running) return this.running;
    this.running = this.collect().catch(error => {
      if (this.closed) return;
      const message = error instanceof Error ? error.message : String(error);
      if (this.errors.get('discovery') !== message) this.store.diagnostic(`Prime 项目扫描: ${message}`);
      this.errors.set('discovery', message);
    }).finally(() => { this.running = undefined; });
    return this.running;
  }
  private async signature(path: string) {
    const file = await stat(path);
    return `${file.dev}:${file.ino}:${file.size}:${file.mtimeMs}`;
  }
  private async collect() {
    if (this.closed || !this.store.memory.all().some(scope => scope.agentType === 'prime-agent' && scope.enabledAt && scope.spaceIds.length)) return;
    // An uninstalled adapter must not keep collecting from the existing binding.
    try {
      const manifest = object(JSON.parse(await readFile(join(this.home ?? homedir(), '.memos-project-memory/adapters/prime-agent.json'), 'utf8')));
      if (manifest.installed === false) return;
    }
    catch { return; }
    for (const source of await primeSources(this.home)) {
      if (this.closed) return;
      const scope = this.store.memory.resolve('prime-agent', source.cwd);
      if (!scope?.enabledAt || scope.root !== source.cwd) continue;
      try {
        const before = await this.signature(source.path), signature = `${scope.id}:${scope.enabledAt}:${before}`;
        if (this.scanned.get(source.path) === signature) continue;
        const snapshot = await readPrimeSession(source.path);
        if (this.closed) return;
        if (snapshot.nativeSessionId !== source.nativeSessionId || snapshot.cwd !== source.cwd) throw new Error('Prime 会话身份发生变化');
        const turns = snapshot.turns.filter(turn => turn.records.length && turn.records.every(record => this.store.memory.allows(scope.id, this.store.memory.recordTime(record.raw))));
        const candidates = turns.filter(turn => turn.completedAt);
        const idle = candidates.length ? primeIdle(snapshot, await this.readStatus()) : false;
        if (this.closed) return;
        const after = await this.signature(source.path);
        if (this.closed) return;
        if (before !== after || this.store.memory.resolve('prime-agent', source.cwd)?.enabledAt !== scope.enabledAt) continue;
        if (turns.length) {
          this.store.db.exec('BEGIN');
          try {
            const session = this.store.registerSession({ agentType: 'prime-agent', ...source, title: snapshot.title });
            for (const turn of turns) {
              this.observeTurn(source, turn);
              const known = this.store.row('SELECT completedAt FROM turns WHERE sessionId=? AND nativeKey=?', session.id, turn.key);
              if (known?.completedAt) continue;
              this.store.startTurn(session.id, turn.key, false);
              this.store.capture(session.id, turn.records);
              if (idle && !snapshot.partial && turn.completedAt) this.store.finalizeTurn(session.id, turn.key);
            }
            const current = this.store.row('SELECT id,completedAt FROM turns WHERE sessionId=? AND nativeKey=?', session.id, snapshot.currentTurn ?? '');
            this.store.db.prepare('UPDATE sessions SET currentTurnId=? WHERE id=?').run(current && !current.completedAt ? String(current.id) : null, session.id);
            this.store.db.exec('COMMIT');
          } catch (error) { this.store.db.exec('ROLLBACK'); throw error; }
        }
        if (!snapshot.partial && (!candidates.length || idle)) this.scanned.set(source.path, signature);
        this.errors.delete(source.path);
      } catch (error) {
        if (this.closed) return;
        const message = error instanceof Error ? error.message : String(error);
        if (this.errors.get(source.path) !== message) this.store.diagnostic(`Prime 轨迹采集: ${message}`);
        this.errors.set(source.path, message);
      }
    }
  }
  /** Native user entries advance the creation boundary even without a model Skill call. */
  private observeTurn(source: Pick<PrimeSession, 'nativeSessionId' | 'cwd'>, turn: PrimeSession['turns'][number]) {
    const user = turn.records.find(record => record.message?.role === 'user');
    const occurredAt = user && this.store.memory.recordTime(user.raw);
    if (!occurredAt) return;
    this.store.creation.observe({ agentType: 'prime-agent', nativeSessionId: source.nativeSessionId, cwd: source.cwd,
      event: 'turn-start', nativeTurnId: turn.key, occurredAt });
  }
  /** Skill requests carry the runtime's ID; verify the current native user entry. */
  async context(event: AgentEvent) {
    if (!/^[\w-]+$/.test(event.nativeSessionId)) throw new Error('Prime 当前会话 ID 无效');
    const source = await readPrimeSession(join(primePaths(this.home).sessions, event.nativeSessionId + '.jsonl'));
    if (source.cwd !== resolve(event.cwd) || source.nativeSessionId !== event.nativeSessionId || source.currentTurn !== event.nativeTurnId)
      throw new Error('Prime 当前会话或用户轮上下文已失效');
    const turn = source.turns.find(turn => turn.key === source.currentTurn);
    const scope = this.store.memory.resolve('prime-agent', source.cwd);
    if (!scope?.enabledAt || scope.root !== source.cwd || !turn || source.partial || turn.completedAt || !turn.records.every(record => this.store.memory.allows(scope.id, this.store.memory.recordTime(record.raw)))) return;
    this.observeTurn(source, turn);
    const session = this.store.registerSession({ agentType: 'prime-agent', ...source });
    const current = this.store.startTurn(session.id, turn.key);
    this.store.db.prepare('UPDATE sessions SET currentTurnId=? WHERE id=?').run(current.id, session.id);
    this.store.capture(session.id, turn.records);
    return { sessionId: session.id, conversationId: current.id };
  }
}
