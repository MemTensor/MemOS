import { existsSync, watch, type FSWatcher } from 'node:fs';
import { basename, dirname, join, relative, sep } from 'node:path';
import type { Store } from '../../storage/store.ts';
import { adapterInstalled } from '../installer.ts';
import { getProfile } from '../registry.ts';
import { DoubaoHost, type DoubaoTurn } from './host.ts';
import { captureDoubaoTurn, doubaoChatCachePath, doubaoSessionsPath } from './capture.ts';

export class DoubaoRuntime {
  private readonly store: Store;
  private readonly home?: string;
  private host?: DoubaoHost;
  private revision = 0;
  private ready?: Promise<void>;
  private closed = false;
  private watchers = new Map<string, FSWatcher>();
  private dirty = false;
  private sourcesChanged = false;
  private outcomes = new Map<string, 'complete' | 'pending' | 'inactive'>();
  private running?: Promise<void>;

  constructor(store: Store, home?: string) { this.store = store; this.home = home; }

  private enabled() {
    return !this.closed && this.store.memory.all().some(scope => scope.agentType === 'doubao-work'
      && scope.enabledAt && scope.spaceIds.length && this.store.matchesConnection(scope.connectionId));
  }

  configure() { return this.ready = this.reconfigure(); }

  private async installed() {
    try { return await adapterInstalled(getProfile('doubao-work'), {home:this.home}); }
    catch (error) {
      if (!this.closed) this.store.diagnostic(String(error));
      return false;
    }
  }

  private async reconfigure() {
    const revision = ++this.revision;
    const installed = this.enabled() && await this.installed();
    if (this.closed || revision !== this.revision) return;
    if (!installed) { this.stop(); return; }
    this.outcomes.clear();
    this.host ??= new DoubaoHost(this.home);
    this.host.watch(this.changed);
    this.changed();
  }

  private stop() {
    this.host?.close(); this.host = undefined;
    for (const watcher of this.watchers.values()) watcher.close();
    this.watchers.clear();
    this.outcomes.clear();
  }
  close() { this.closed = true; this.stop(); }

  private sourceChanged = () => { this.sourcesChanged = true; this.changed(); };

  private changed = () => {
    if (!this.host) return;
    this.dirty = true;
    if (!this.running) this.running = this.drain().catch(error => {
      if (!this.closed) this.store.diagnostic(String(error));
    }).finally(() => { this.running = undefined; if (this.dirty) this.changed(); });
  };

  refreshSessionTitles() {
    if (!this.host) return;
    for (const session of this.store.rows("SELECT id,nativeSessionId,cwd,objectId,titleRevision FROM sessions WHERE agentType='doubao-work'")) {
      const title = this.host.sessionTitle(String(session.nativeSessionId), String(session.cwd));
      if (!title || title.version <= Number(session.titleRevision ?? -1)) continue;
      const scope = this.store.memory.forSession({agentType:'doubao-work', objectId:String(session.objectId)});
      if (scope?.root === session.cwd) this.store.setSessionTitle(String(session.id), title.name, title.version);
    }
  }

  private scope(turn: DoubaoTurn) {
    const scope = this.store.memory.resolve('doubao-work', turn.root);
    if (scope?.root === turn.root && this.store.memory.allows(scope.id, new Date(turn.startedAt).toISOString())) return scope;
  }

  async current(sessionId: string, answerId: string) {
    await this.ready;
    const host = this.host;
    if (!host || !await this.installed() || host !== this.host) return;
    try { await host.refresh(); }
    catch (error) {
      if (!this.closed) this.store.diagnostic(String(error));
      return;
    }
    if (host !== this.host) return;
    const turn = host.active(sessionId, answerId);
    if (!turn || !this.scope(turn)) return;
    return turn;
  }

  private async drain() {
    while (this.dirty && this.host) {
      this.dirty = false;
      const host = this.host, revision = this.revision;
      const retryPending = this.sourcesChanged;
      this.sourcesChanged = false;
      await host.refresh();
      if (host !== this.host) continue;
      const pending = new Set<string>();
      const retained = new Set<string>();
      for (const turn of host.completed()) {
        if (host !== this.host || revision !== this.revision) break;
        const key = JSON.stringify(turn);
        retained.add(key);
        let result = this.outcomes.get(key);
        if (!result || (result === 'pending' && retryPending)) {
          result = await captureDoubaoTurn(this.store, turn, this.home, async () => {
            if (host !== this.host || revision !== this.revision || !await this.installed()) return false;
            await host.refresh();
            return host === this.host && revision === this.revision && host.completed().some(current =>
              current.sessionId === turn.sessionId && current.answerId === turn.answerId && current.questionId === turn.questionId
              && current.startedAt === turn.startedAt && current.root === turn.root && current.endedAt === turn.endedAt);
          });
          if (host !== this.host || revision !== this.revision) break;
          this.outcomes.set(key, result);
        }
        if (result === 'pending') {
          pending.add(join(doubaoSessionsPath(this.home), turn.sessionId));
          pending.add(doubaoChatCachePath(this.home));
        }
      }
      if (host !== this.host || revision !== this.revision) continue;
      for (const [key, result] of this.outcomes) {
        if (retained.has(key)) continue;
        if (result === 'pending') this.store.diagnostic('豆包待采集轮次的宿主证据已缺失或发生冲突');
        this.outcomes.delete(key);
      }
      this.watchPending(pending);
    }
  }

  // Observe only the sources a completed turn is waiting for. Arm before the second
  // read so a final write between the first read and watch registration is visible.
  private watchPending(paths: Set<string>) {
    const wanted = new Set<string>();
    for (const path of paths) {
      let target = path;
      while (!existsSync(target) && dirname(target) !== target) target = dirname(target);
      const next = relative(target,path).split(sep)[0];
      const key = JSON.stringify([target,next]);
      wanted.add(key);
      if (this.watchers.has(key)) continue;
      try {
        const watcher = watch(target, {persistent:false, recursive:!next}, (event, file) => {
          if (!file || (next ? file === next : event === 'rename' || /^(assignment\.md|trajectory\.jsonl|.*\.(ldb|log|sst))$/.test(basename(file)))) this.sourceChanged();
        });
        watcher.on('error', () => { watcher.close(); this.watchers.delete(key); this.sourceChanged(); });
        this.watchers.set(key,watcher);
        this.sourceChanged();
      } catch { /* A concurrent directory move will also wake the host watcher. */ }
    }
    for (const [key, watcher] of this.watchers) if (!wanted.has(key)) { watcher.close(); this.watchers.delete(key); }
  }
}
