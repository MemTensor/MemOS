import { observed } from '../../_shared/transcript.ts';
import type { AgentEvent } from '../../types.ts';
import { randomUUID } from 'node:crypto';
import { normalizeTaskTrace } from '../../_shared/task-trace.ts';
import { Bridge, message, sendEvent, type Data, type Send } from '../../opencode-v1/extension/bridge.ts';

export const name = 'memos-project-memory';
export const inject = ['sessions', 'systemPrompt'];

interface Context {
  on(name: string, handler: (...args: any[]) => unknown): () => void;
  effect(setup: () => (() => unknown)): unknown;
  systemPrompt: {
    context(provider: {
      name: string; order: number; required: boolean; interpolate: boolean;
      text(context: { agent?: Data }): string;
    }): () => void;
  };
  logger?: { warn(message: string): void };
}
interface Overview {
  message: Data;
  localSessionId: string;
  committed: boolean;
  acknowledged: boolean;
}
interface SessionState {
  session: Data;
  bridge?: Bridge;
  turnKey?: string;
  pending: Promise<void>;
  text: string;
  overview?: Overview;
}

const unavailable = '项目记忆检索调用上下文（memos-project-memory）\n本轮项目记忆暂不可用，请勿复用历史调用标识。';

/** Async identity preparation is refreshed by DSH before admitting its runtime snapshot. */
export function apply(ctx: Context, _config: unknown = {}, send: Send = sendEvent) {
  const sessions = new Map<string, SessionState>();
  const agents = new WeakMap<object, SessionState>();
  let active = true;
  const warn = () => ctx.logger?.warn('MemOS 项目记忆本地服务操作失败；稍后可重试。');
  const get = (session: Data): SessionState => {
    let state = sessions.get(session.id);
    if (!state) {
      if (!session.id || !session.header?.cwd) throw new Error('DeepSeek session identity or cwd missing');
      state = { session, pending: Promise.resolve(), text: '' };
      sessions.set(session.id, state);
    }
    return state;
  };
  const bridgeFor = (state: SessionState) => {
    if (!state.bridge) {
      state.bridge = new Bridge('deepseek-harness', state.session.header.cwd, Object.assign((event:AgentEvent) => {
        // DSH owns naming and renames. Read its latest logged title, including
        // sessions that were already loaded when this extension attached.
        if (event.event !== 'turn-start' && !(event.event === 'trace-available' && !event.records)) return send(event);
        const latest = state.session.snapshotEvents?.().findLast((item: Data) => item.type === 'session/title');
        const title = latest?.data?.title;
        if (typeof title !== 'string' || !title.trim()) return send(event);
        return send({ ...event, title, ...(Number.isSafeInteger(latest.seq) && latest.seq >= 0 ? { titleRevision: latest.seq } : {}) });
      }, {activation:send.activation,delivered:send.delivered}));
      if (state.turnKey) state.bridge.turns.set(state.session.id, state.turnKey);
    }
    return state.bridge;
  };
  const failed = (state: SessionState) => {
    // Bridge serializes requests; discard its rejected tail so a later turn can recover.
    state.bridge = undefined;
    state.text = unavailable;
    warn();
  };
  const clear = (state: SessionState) => { state.text = ''; state.overview = undefined; state.turnKey = undefined; };
  const queue = (state: SessionState, operation: () => Promise<unknown>) => {
    state.pending = state.pending.then(operation).then(result => { if (result && typeof result === 'object' && 'sessionId' in result && !result.sessionId) clear(state); }, () => { failed(state); });
  };
  const acknowledge = async (state: SessionState) => {
    const overview = state.overview;
    if (!overview?.committed || overview.acknowledged) return;
    try {
      if (!await bridgeFor(state).active(state.session.id)) { clear(state); return; }
      await send.delivered?.(overview.localSessionId);
      overview.acknowledged = true;
    } catch {
      // Keep the committed candidate: retry its acknowledgement without reinjecting it.
      warn();
    }
  };

  const removeContext = ctx.systemPrompt.context({
    name: 'memos-project-memory:call-context', order: 220, required: true, interpolate: false,
    text({ agent }) {
      if (!active || !agent) return '';
      const state = agents.get(agent);
      return state && sessions.get(agent.session?.id) === state ? state.text : '';
    },
  });
  ctx.effect(() => async () => {
    active = false;
    removeContext();
    await Promise.all([...sessions.values()].map(state => state.pending));
    sessions.clear();
  });

  ctx.on('session/event', (session: Data, event: Data) => {
    if (!active) return;
    const known = sessions.get(session.id), candidate = known?.overview;
    if (event.type === 'user/message' && event.data?.source?.kind === name
      && candidate && candidate.message.id === event.data.id) {
      candidate.committed = true;
      queue(known!, () => acknowledge(known!));
    }
    if (event.type === 'session/title') {
      if (typeof event.data?.title !== 'string' || !event.data.title.trim()) return;
      const state = known ?? get(session);
      queue(state, () => bridgeFor(state).dispatch(session.id, 'trace-available'));
      return;
    }
    const record = normalizeTaskTrace('deepseek-harness', { sourceId: `event:${event.seq}`, raw: observed(event) });
    if (!record && event.type !== 'turn/end') return;
    const state = known ?? get(session);
    queue(state, () => record
      ? bridgeFor(state).trace(session.id, record.raw, record.sourceId, record.message)
      : bridgeFor(state).dispatch(session.id, 'turn-end'));
  });
  ctx.on('agent/pre-step', async (payload: Data, next: () => Promise<Data>) => {
    if (!active) return next();
    const session = payload.agent.session, state = get(session);
    const isCurrent = () => active && payload.agent.session?.id === session.id && sessions.get(session.id) === state;
    agents.set(payload.agent, state);
    await state.pending;
    if (!isCurrent()) return next();
    try { if (!await bridgeFor(state).active(session.id)) { clear(state); return next(); } }
    catch { failed(state); return next(); }
    await acknowledge(state);
    if (!isCurrent()) return next();
    const input = payload.messages.find((item: Data) => item.source?.kind === 'user');
    let overviewText = '', localSessionId = '';
    if (input) {
      state.text = unavailable;
      try {
        if (!input.id) throw new Error('DeepSeek user message identity missing');
        state.turnKey = input.id;
        const result = await bridgeFor(state).turn(session.id, input.id, [{ sourceId: `message:${input.id}`, raw: observed(input), message: message(input) }]);
        if (!isCurrent()) return next();
        if (!result.sessionId && !result.conversationId && !result.context && !result.identifiers) { clear(state); return next(); }
        if (typeof result.sessionId !== 'string' || !result.sessionId.trim()
          || typeof result.conversationId !== 'string' || !result.conversationId.trim()) {
          throw new Error('MemOS local session or user turn identity missing');
        }
        state.text = `项目记忆检索调用上下文（memos-project-memory）\n以下是本轮 search 的调用参数；使用本次运行上下文中的当前值。\nsession-id: ${result.sessionId}\nconversation-id: ${result.conversationId}\n检索时按 memos-project-memory Skill 的说明调用 memos-pm search。`;
        if (!result.overviewDelivered) { overviewText = result.overview; localSessionId = result.sessionId; }
      } catch {
        failed(state);
      }
    }
    const decision = await next();
    if (isCurrent() && decision.kind === 'enter' && overviewText && !state.overview?.committed) {
      state.overview ??= {
        message: { id: randomUUID(), role: 'user', source: { kind: name, form: 'instructions' }, content: [{ type: 'text', text: `项目记忆初始概览（背景资料）\n${overviewText}` }] },
        localSessionId, committed: false, acknowledged: false,
      };
      if (!decision.messages.some((item: Data) => item.id === state.overview!.message.id)) decision.messages.push(state.overview.message);
    }
    return decision;
  });
  ctx.on('session/flush', async (session: Data) => {
    const state = sessions.get(session.id);
    if (state) { await state.pending; await acknowledge(state); }
  });
  ctx.on('session/disposed', (session: Data) => {
    const state = sessions.get(session.id);
    if (!state) return;
    state.text = '';
    queue(state, async () => {
      try { await bridgeFor(state).dispatch(session.id, 'session-end'); }
      finally { sessions.delete(session.id); }
    });
  });
}
