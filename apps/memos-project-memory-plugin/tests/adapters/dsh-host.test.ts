import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';
import { apply } from '../../src/adapters/deepseek-harness/extension/index.ts';
import { identifiers } from '../../src/recall/format.ts';
import type { AgentEvent, EventResult } from '../../src/adapters/types.ts';

const installation = process.env.MEMOS_PM_DSH_ROOT;
const skip = installation ? false : 'Set MEMOS_PM_DSH_ROOT to verify installed DSH components; host compatibility is unverified.';
const contextName = 'memos-project-memory:call-context';
type Data = Record<string, any>;

async function hostComponents() {
  const require = createRequire(join(installation!, 'package.json'));
  const load = (name: string) => import(pathToFileURL(require.resolve(name)).href);
  const [{ Context }, { SystemPrompt, renderContextSections }, { SessionStore }, skill] = await Promise.all([
    load('@deepseek-ai/cordis'), load('@deepseek-ai/dsh-system-prompt'), load('@deepseek-ai/dsh-session'), load('@deepseek-ai/dsh-tool-skill'),
  ]);
  // Node does not strip TypeScript under node_modules. Compile this installed
  // host source in memory, resolving its imports through that installation.
  const loopRoot = dirname(require.resolve('@deepseek-ai/dsh-agent-loop/package.json'));
  async function compiledSource(path: string, localImports: Record<string, string> = {}) {
    const source = await readFile(path, 'utf8');
    const compiled = ts.transpileModule(source, {
      compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext },
    }).outputText.replace(/from ['"]([^'"]+)['"]/g, (_match, name: string) => {
      const resolved = localImports[name] ?? pathToFileURL(require.resolve(name)).href;
      return `from ${JSON.stringify(resolved)}`;
    });
    return 'data:text/javascript;base64,' + Buffer.from(compiled).toString('base64');
  }
  const { RuntimeContextProjection } = await import(await compiledSource(join(loopRoot, 'src/runtime-context.ts')));
  const adapterRoot = dirname(require.resolve('@deepseek-ai/dsh-llm-deepseek/package.json'));
  const replay = await compiledSource(join(adapterRoot, 'src/replay.ts'));
  const { serialize } = await import(await compiledSource(join(adapterRoot, 'src/serialize.ts'), { './replay.ts': replay }));
  const version = JSON.parse(await readFile(join(installation!, 'package.json'), 'utf8')).version;
  return { Context, SystemPrompt, SessionStore, renderContextSections, RuntimeContextProjection, serialize, skill, version };
}

async function fixture(reverse = false, overview = '') {
  const host = await hostComponents();
  const plugin = process.env.MEMOS_PM_DSH_ENTRY
    ? await import(pathToFileURL(process.env.MEMOS_PM_DSH_ENTRY).href)
    : { apply };
  const bus = new host.Context();
  const prompt = new host.SystemPrompt(bus, { includeHarnessIdentity: false });
  const sessions = new host.SessionStore(bus);
  const tools = new Map<string, unknown>();
  const acknowledged = new Set<string>();
  const events: AgentEvent[] = [];
  let skillBodyReads = 0, fail = false;
  const ctx = {
    on: (...args: any[]) => bus.on(...args),
    effect: (...args: any[]) => bus.effect(...args),
    systemPrompt: prompt,
    logger: { warn: (_message: string) => {} },
    tools: { register: (tool: Data) => tools.set(tool.name, tool), get: (name: string) => tools.get(name) },
    workingDirectory: { ensure: async () => '/synthetic-project' },
    skills: {
      snapshot: async () => ({ complete: true, skills: [{
        name: 'memos-project-memory', description: 'Project decisions and history',
        invocation: { modelInvocable: true, userInvocable: true },
      }] }),
      get: async () => { skillBodyReads++; throw new Error('Catalog publication must not load the Skill body'); },
    },
  };
  const send = Object.assign(async (event: AgentEvent): Promise<EventResult> => {
    events.push(event);
    if (fail) throw new Error('Synthetic local service outage');
    const sessionId = `local-${event.nativeSessionId}`, conversationId = event.turnKey ? `local-${event.turnKey}` : null;
    const ids = identifiers(sessionId, conversationId);
    return { sessionId, conversationId, identifiers: ids, overview, overviewDelivered: acknowledged.has(sessionId), context: [overview, ids].filter(Boolean).join('\n\n') };
  }, { delivered: async (id: string) => { acknowledged.add(id); } });
  if (reverse) { plugin.apply(ctx, {}, send); host.skill.apply(ctx); }
  else { host.skill.apply(ctx); plugin.apply(ctx, {}, send); }
  prompt.context({ name: 'synthetic-host', order: 100, text: 'Synthetic working directory and policy' });

  function session(id: string) {
    const value = sessions.create(id, { meta: { cwd: '/synthetic-project' } });
    return { value, runtime: new host.RuntimeContextProjection(ctx, value), agent: { session: value } };
  }

  async function step(subject: ReturnType<typeof session>, input?: string) {
    const signal = new AbortController().signal;
    const scope = { agent: subject.agent, scope: subject.agent, signal };
    // This order mirrors agent-loop/src/agent.ts: assemble before pre-step,
    // refresh at admission, replace the proposed runtime placeholder, commit.
    const assembly = await prompt.assemble(scope);
    const claimed = input ? [{ id: input, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'Synthetic task' }] }] : [];
    const decision = await bus.waterfall('agent/pre-step', { ...scope, messages: claimed, turn: 1, step: 1 }, async () => {
      const runtime = subject.runtime.project(host.renderContextSections(assembly));
      return { kind: 'enter', messages: runtime ? [...claimed, runtime] : claimed };
    });
    const refreshed = prompt.refreshContext(assembly, scope);
    const current = subject.runtime.project(host.renderContextSections(refreshed));
    let admitted = false;
    const committed: Data[] = [];
    for (const proposed of decision.messages) {
      if (proposed.source.kind === 'runtime-context') {
        if (current && !admitted) { subject.value.append('user/message', current, { surfaceOp: 'append' }); committed.push(current); admitted = true; }
      } else { subject.value.append('user/message', proposed, { surfaceOp: 'append' }); committed.push(proposed); }
    }
    if (current && !admitted) { subject.value.append('user/message', current, { surfaceOp: 'append' }); committed.push(current); }
    await bus.parallel('session/flush', subject.value);
    const history = subject.value.deriveMessages();
    const latest = history.findLast((message: Data) => message.source.kind === 'runtime-context');
    // Capture the official provider serializer's outgoing body without any
    // connection, credentials, model execution or fetch.
    const request = host.serialize({ model: 'synthetic-model', reasoningEffort: 'off' },
      { models: [{ id: 'synthetic-model', maxTokens: 100 }], defaults: { thinking: 'disabled' } },
      history, new Map(), () => { throw new Error('Synthetic text requests have no images'); });
    return { assembly, refreshed, committed, latest, request };
  }
  return { host, bus, ctx, session, step, events, acknowledged, skillBodyReads: () => skillBodyReads, outage: () => { fail = true; } };
}

for (const reverse of [false, true]) {
  test(`installed DSH admission refresh embeds current MemOS IDs in runtime context (reverse=${reverse})`, { skip }, async t => {
    const f = await fixture(reverse);
    t.after(async () => { await f.bus.fiber.dispose(); });
    t.diagnostic(`Installed DSH ${f.host.version}; real Cordis/SystemPrompt/runtime projection/Session/Skill catalog/provider serializer, simulated driver admission and local transport`);
    const session = f.session('native-a');
    const first = await f.step(session, 'user-a1');
    const contribution = first.latest.source.sections.find((section: Data) => section.name === contextName);
    assert.ok(contribution, 'Dynamic IDs must be a named runtime-context contribution');
    assert.match(contribution.text, /local-user-a1/);
    assert.ok(!first.assembly.contexts.some((section: Data) => section.text.includes('local-user-a1')), 'First assembly precedes local identity allocation');
    assert.ok(!first.committed.some(message => message.source.kind === 'memos-project-memory'), 'No standalone ID message');
    const catalog = first.committed.find(message => message.source.kind === 'skill-catalog');
    assert.ok(catalog);
    assert.deepEqual(catalog.source.entries.map((entry: Data) => entry.name), ['memos-project-memory']);
    const wireText = first.request.messages.flatMap((message: Data) => message.content).filter((block: Data) => block.type === 'text').map((block: Data) => block.text);
    const idBlocks = wireText.filter((text: string) => text.includes('session-id:'));
    assert.equal(idBlocks.length, 1, 'The outgoing wire request contains one identity block');
    assert.ok(idBlocks[0].startsWith('<system-reminder>'), 'The outgoing ID block remains inside the host runtime reminder');
    assert.equal(f.skillBodyReads(), 0);

    for (let i = 0; i < 2; i++) {
      const continuation = await f.step(session);
      assert.equal(continuation.committed.length, 0, 'Unchanged tool continuations must not append context snapshots');
    }
    const second = await f.step(session, 'user-a2');
    const current = second.latest.source.sections.find((section: Data) => section.name === contextName);
    assert.match(current.text, /local-user-a2/);
    assert.doesNotMatch(current.text, /local-user-a1/);
    assert.equal(f.events.filter(event => event.event === 'turn-start').length, 2);
  });
}

test('installed DSH contexts remain isolated and replace stale IDs after local service failure', { skip }, async t => {
  const f = await fixture();
  t.after(async () => { await f.bus.fiber.dispose(); });
  const a = f.session('native-a'), b = f.session('native-b');
  await f.step(a, 'user-a1');
  const other = await f.step(b, 'user-b1');
  const own = await f.step(a);
  assert.match(other.latest.content[0].text, /local-native-b/);
  assert.doesNotMatch(other.latest.content[0].text, /local-native-a|local-user-a1/);
  assert.match(own.latest.content[0].text, /local-native-a/);
  assert.doesNotMatch(own.latest.content[0].text, /local-native-b|local-user-b1/);
  f.outage();
  const unavailable = await f.step(a, 'user-a2');
  const current = unavailable.latest.source.sections.find((section: Data) => section.name === contextName);
  assert.ok(current, 'An operational unavailable context must supersede old IDs');
  assert.doesNotMatch(current.text, /local-user-a1|local-native-a/);
  assert.match(current.text, /不可用/);
});

test('installed DSH commits initial overview once without mixing it into runtime identifiers', { skip }, async t => {
  const f = await fixture(false, 'Synthetic project overview');
  t.after(async () => { await f.bus.fiber.dispose(); });
  const session = f.session('native-overview');
  const first = await f.step(session, 'user-first');
  const overview = first.committed.filter(message => message.source.kind === 'memos-project-memory');
  assert.equal(overview.length, 1);
  assert.match(overview[0]!.content[0].text, /Synthetic project overview/);
  assert.doesNotMatch(overview[0]!.content[0].text, /session-id:|conversation-id:/);
  assert.doesNotMatch(first.latest.content[0].text, /Synthetic project overview/);
  assert.ok(f.acknowledged.has('local-native-overview'));
  const next = await f.step(session, 'user-second');
  assert.ok(!next.committed.some(message => message.source.kind === 'memos-project-memory'));
});
