import { test } from 'node:test';
import assert from 'node:assert/strict';
import { apply } from '../../src/adapters/deepseek-harness/extension/index.ts';
import type { AgentEvent, EventResult } from '../../src/adapters/types.ts';

type Data = Record<string, any>;
function harness(overview = '') {
  const callbacks = new Map<string, (...args: any[]) => any>();
  const providers = new Map<string, Data>();
  const effects: (() => unknown)[] = [];
  const events: AgentEvent[] = [], deliveries: string[] = [], warnings: string[] = [];
  const agent = { session: { id: 'dsh-1', header: { cwd: '/synthetic' } } };
  let fail = false, invalid = false, deliveryFailures = 0;
  let sendGate: { started(): void; released: Promise<void> } | undefined;
  const send = Object.assign(async (event: AgentEvent): Promise<EventResult> => {
    events.push(event);
    if (sendGate) { const gate = sendGate; sendGate = undefined; gate.started(); await gate.released; }
    if (fail) throw new Error('synthetic local service failure');
    const sessionId = `local-${event.nativeSessionId}`, conversationId = invalid ? null : event.turnKey ?? null;
    const identifiers = `session-id: ${sessionId}\nconversation-id: ${conversationId}`;
    return { sessionId, conversationId, identifiers, overview, overviewDelivered: deliveries.includes(sessionId), context: [overview, identifiers].filter(Boolean).join('\n\n') };
  }, { delivered: async (id: string) => { if (deliveryFailures-- > 0) throw new Error('synthetic acknowledgement failure'); deliveries.push(id); } });
  const ctx = {
    on(name: string, callback: (...args: any[]) => any) { callbacks.set(name, callback); return () => { callbacks.delete(name); }; },
    systemPrompt: { context(provider: Data) { providers.set(provider.name, provider); return () => { providers.delete(provider.name); }; } },
    effect(setup: () => (() => unknown)) { const dispose = setup(); effects.push(dispose); return dispose; },
    logger: { warn(text: string) { warnings.push(text); } },
  };
  apply(ctx, {}, send);
  const callContext = (subject: Data = agent) => [...providers.values()].map(p => p.text({ agent: subject, scope: subject })).join('\n');
  const prepare = (id?: string, subject: Data = agent, next?: () => Promise<Data>) => {
    const messages = id ? [{ id, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'synthetic task' }] }] : [];
    return callbacks.get('agent/pre-step')!({ agent: subject, messages }, next ?? (async () => ({ kind: 'enter', messages: [...messages] })));
  };
  let seq = 0;
  const commit = (message: Data, subject: Data = agent) => callbacks.get('session/event')!(subject.session, { seq: ++seq, type: 'user/message', data: message });
  const flush = (subject: Data = agent) => callbacks.get('session/flush')!(subject.session);
  const pauseNextSend = () => {
    let started!: () => void, release!: () => void;
    const entered = new Promise<void>(resolve => { started = resolve; });
    const released = new Promise<void>(resolve => { release = resolve; });
    sendGate = { started, released };
    return { entered, release };
  };
  return { callbacks, providers, effects, events, deliveries, warnings, agent, callContext, prepare, commit, flush, pauseNextSend,
    fail(value: boolean) { fail = value; }, invalid(value: boolean) { invalid = value; }, failDelivery() { deliveryFailures = 1; } };
}

test('DSH registers current call IDs as named context, leaving no standalone ID message', async () => {
  const h = harness();
  assert.equal(h.providers.size, 1);
  const provider = h.providers.get('memos-project-memory:call-context')!;
  assert.equal(provider.required, true);
  assert.equal(provider.interpolate, false);
  assert.equal(provider.text({}), '');
  assert.equal(h.callContext(), ''); // DSH assembles before pre-step has registered this turn.
  const result = await h.prepare('input-1');
  assert.equal(result.messages.length, 1);
  assert.match(h.callContext(), /session-id: local-dsh-1/);
  assert.match(h.callContext(), /conversation-id: input-1/);
  assert.match(h.callContext(), /memos-project-memory/);
  assert.deepEqual(h.deliveries, []);
  await h.prepare(); await h.prepare();
  assert.equal(h.events.filter(e => e.event === 'turn-start').length, 1);
  await h.prepare('input-2');
  assert.match(h.callContext(), /conversation-id: input-2/);
  assert.ok(!h.callContext().includes('input-1'));
});

test('DSH isolates interleaved agents and clears stale IDs on failure, then recovers', async () => {
  const h = harness(), other = { session: { id: 'dsh-2', header: { cwd: '/other' } } };
  await h.prepare('first'); await h.prepare('second', other);
  assert.match(h.callContext(), /conversation-id: first/);
  assert.match(h.callContext(other), /session-id: local-dsh-2/);
  assert.ok(!h.callContext(other).includes('first'));
  h.fail(true);
  const unavailable = await h.prepare('failed');
  assert.equal(unavailable.kind, 'enter');
  assert.ok(!h.callContext().includes('conversation-id:'));
  assert.match(h.callContext(), /不可用/);
  assert.match(h.callContext(other), /conversation-id: second/);
  assert.ok(h.warnings.length);
  h.fail(false); await h.prepare('recovered');
  assert.match(h.callContext(), /conversation-id: recovered/);
});

test('DSH overview has no dynamic IDs and is acknowledged only after matching history commit', async () => {
  const h = harness('synthetic project overview');
  const result = await h.prepare('input-1');
  const overview = result.messages.find((m: Data) => m.source.kind === 'memos-project-memory');
  assert.ok(overview);
  assert.match(overview.content[0].text, /synthetic project overview/);
  assert.ok(!overview.content[0].text.includes('conversation-id:'));
  assert.deepEqual(h.deliveries, []);
  h.commit({ ...overview, id: 'unrelated-message' });
  h.commit(overview, { session: { id: 'other-session', header: { cwd: '/other' } } });
  await h.flush(); assert.deepEqual(h.deliveries, []);
  h.commit(overview); await h.flush();
  assert.deepEqual(h.deliveries, ['local-dsh-1']);
  const next = await h.prepare('input-2');
  assert.equal(next.messages.length, 1);
  assert.match(h.callContext(), /conversation-id: input-2/);
  assert.ok(h.events.flatMap(e => e.records ?? []).every(r => !JSON.stringify(r.raw).includes('synthetic project overview')));
});

test('DSH rejected or abandoned overview proposals remain unacknowledged and reuse one candidate', async () => {
  const h = harness('synthetic overview');
  await h.prepare('input-1', h.agent, async () => ({ kind: 'reject', reason: 'synthetic rejection' }));
  assert.deepEqual(h.deliveries, []);
  await assert.rejects(h.prepare('input-1', h.agent, async () => { throw new Error('later waterfall error'); }), /later waterfall error/);
  const abandoned = await h.prepare('input-1');
  const proposed = abandoned.messages.find((m: Data) => m.source.kind === 'memos-project-memory');
  const retry = await h.prepare('input-1');
  const reproposed = retry.messages.find((m: Data) => m.source.kind === 'memos-project-memory');
  assert.equal(reproposed.id, proposed.id);
  assert.deepEqual(h.deliveries, []);
  h.commit(reproposed); await h.flush();
  const continued = await h.prepare();
  assert.equal(continued.messages.length, 0);
  assert.deepEqual(h.deliveries, ['local-dsh-1']);
});

test('DSH completion still follows task captures; disposal and unload remove call context', async () => {
  const h = harness();
  await h.prepare('input-1');
  h.callbacks.get('session/event')!(h.agent.session, { seq: 1, type: 'assistant/message', data: { message: { id: 'answer', role: 'assistant', content: 'synthetic answer' } } });
  h.callbacks.get('session/event')!(h.agent.session, { seq: 2, type: 'turn/end', data: {} });
  await h.flush();
  assert.deepEqual(h.events.map(e => e.event), ['turn-start', 'trace-available', 'turn-end']);
  h.callbacks.get('session/disposed')!(h.agent.session); await h.flush();
  assert.equal(h.callContext(), '');
  assert.equal(h.events.at(-1)?.event, 'session-end');
  for (const dispose of h.effects.reverse()) await dispose();
  assert.equal(h.providers.size, 0);
});

test('DSH retries overview acknowledgement without duplicating already committed history', async () => {
  const h = harness('synthetic overview');
  const result = await h.prepare('input-1');
  const overview = result.messages.find((m: Data) => m.source.kind === 'memos-project-memory');
  h.failDelivery(); h.commit(overview);
  await h.flush();
  const next = await h.prepare('input-2');
  assert.equal(next.messages.length, 1);
  assert.deepEqual(h.deliveries, ['local-dsh-1']);
  assert.ok(h.warnings.length);
});

test('DSH rejects incomplete local identities instead of exposing null IDs', async () => {
  const h = harness();
  await h.prepare('input-1');
  h.invalid(true); await h.prepare('input-2');
  assert.match(h.callContext(), /不可用/);
  assert.doesNotMatch(h.callContext(), /conversation-id:|input-1|null/);
});

test('DSH unload during identity preparation cannot append a late overview', async () => {
  const h = harness('synthetic overview'), gate = h.pauseNextSend();
  const preparing = h.prepare('input-1');
  await gate.entered;
  const disposing = Promise.all(h.effects.reverse().map(dispose => dispose()));
  assert.equal(h.providers.size, 0);
  gate.release(); await disposing;
  const result = await preparing;
  assert.equal(result.messages.length, 1);
  assert.deepEqual(h.deliveries, []);
  assert.equal(h.callContext(), '');
});

test('DSH uses the latest native title on a resumed session instead of the first user text', async () => {
  const h = harness();
  const history = [
    { seq: 1, type: 'session/title', data: { title: '你好' } },
    { seq: 5, type: 'session/title', data: { title: 'Greeting' } },
  ];
  const subject = { session: { ...h.agent.session, snapshotEvents: () => history } };
  await h.prepare('greeting', subject);
  assert.equal(h.events[0]!.title, 'Greeting');
  assert.equal(h.events[0]!.titleRevision, 5);
  assert.equal(h.events.length, 1);
  assert.equal(h.events[0]!.event, 'turn-start');
  assert.equal(h.events[0]!.records?.length, 1);
});

test('DSH late title and manual rename are metadata-only events ordered with task capture', async () => {
  const h = harness(), history: Data[] = [];
  const subject = { session: { ...h.agent.session, snapshotEvents: () => history } };
  await h.prepare('greeting', subject);
  assert.equal(h.events[0]!.title, undefined);
  const title = { seq: 2, type: 'session/title', data: { title: 'Greeting' } };
  history.push(title);
  h.callbacks.get('session/event')!(subject.session, title);
  await h.flush(subject);
  assert.equal(h.events.at(-1)!.title, 'Greeting');
  assert.equal(h.events.at(-1)!.event, 'trace-available');
  assert.equal(h.events.at(-1)!.records, undefined);
  const renamed = { seq: 3, type: 'session/title', data: { title: 'My conversation' } };
  history.push(renamed);
  h.callbacks.get('session/event')!(subject.session, renamed);
  h.callbacks.get('session/event')!(subject.session, { seq: 4, type: 'assistant/message', data: { message: { id: 'answer', role: 'assistant', content: 'Hello!' } } });
  await h.flush(subject);
  assert.deepEqual(h.events.map(event => event.title), [undefined, 'Greeting', 'My conversation', undefined]);
  assert.deepEqual(h.events.map(event => event.titleRevision), [undefined, 2, 3, undefined]);
  assert.equal(h.events.filter(event => event.event === 'turn-start').length, 1);
  assert.equal(h.events.flatMap(event => event.records ?? []).length, 2);
  assert.ok(h.events.flatMap(event => event.records ?? []).every(record => !JSON.stringify(record.raw).includes('session/title')));
});


test('DSH does not invent a title revision for malformed native sequence metadata', async () => {
  const h = harness();
  const subject = { session: { ...h.agent.session, snapshotEvents: () => [{ type: 'session/title', seq: 'bad', data: { title: 'Greeting' } }] } };
  await h.prepare('greeting', subject);
  assert.equal(h.events[0]!.title, 'Greeting');
  assert.equal(Object.hasOwn(h.events[0]!, 'titleRevision'), false);
});
