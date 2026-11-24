import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { profiles } from '../../src/adapters/registry.ts';
import { normalizeHook, hookOutput, processHook } from '../../src/adapters/_shared/hooks.ts';
import { Bridge } from '../../src/adapters/opencode-v1/extension/bridge.ts';
import type { AgentEvent, EventResult } from '../../src/adapters/types.ts';
import { installAdapter } from '../../src/adapters/installer.ts';

test('only verified synchronous session starts request blocking overview refresh', () => {
    assert.equal(profiles.find(profile => profile.id === 'claude-code')?.sessionStartBlocking, true);
    assert.equal(profiles.find(profile => profile.id === 'codex-cli')?.sessionStartBlocking, true);
    assert.notEqual(profiles.find(profile => profile.id === 'cursor-cli')?.sessionStartBlocking, true);
    assert.notEqual(profiles.find(profile => profile.id === 'prime-agent')?.sessionStartBlocking, true);
});

test('native session notifications stay distinct from user turns without a new request parameter', async () => {
    for (const agent of ['claude-code', 'codex-cli', 'cursor-cli', 'copilot-cli']) {
        const identity = { session_id: 'session', sessionId: 'session', conversation_id: 'session', cwd: '/project' };
        const start = await normalizeHook(agent, identity, { event: agent === 'cursor-cli' || agent === 'copilot-cli' ? 'sessionStart' : 'SessionStart' });
        assert.equal(start.event, 'session-start');
        assert.equal('waitForOverview' in start, false);
        const prompt = await normalizeHook(agent, { ...identity, prompt_id: 'turn', prompt: 'question', transformedPrompt: 'question', timestamp: 1795482000000 }, { event: agent === 'cursor-cli' ? 'beforeSubmitPrompt' : agent === 'copilot-cli' ? 'userPromptTransformed' : 'UserPromptSubmit' });
        assert.equal(prompt.event, 'turn-start');
    }
});

test('native bridge retains session-start overview before a local task or turn exists', async () => {
    const sent: AgentEvent[] = [];
    const result: EventResult = { sessionId: '', conversationId: null, overview: 'SQLite 项目概览', context: 'SQLite 项目概览', identifiers: '' };
    const bridge = new Bridge('opencode-v1', '/project', async event => { sent.push(event); return result; });
    await bridge.start('native-session');
    assert.equal(bridge.historyContext('native-session'), 'SQLite 项目概览');
    assert.equal(bridge.turns.size, 0);
    assert.deepEqual(sent.map(event => event.event), ['session-start']);
});

test('session-start delivery uses each host existing output schema even before a local task exists', () => {
    const result = { sessionId: '', conversationId: null, overview: 'cached overview', context: 'cached overview', identifiers: '' };
    assert.deepEqual(hookOutput('claude-code', 'SessionStart', result), { hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: 'cached overview' } });
    assert.deepEqual(hookOutput('cursor-cli', 'sessionStart', result), { additional_context: 'cached overview' });
    assert.deepEqual(hookOutput('copilot-cli', 'sessionStart', result), { additionalContext: 'cached overview' });
});

test('a pure session-start hook acknowledges actual output using its existing host identity', async () => {
    const identity = { agentType: 'claude-code', nativeSessionId: 'native-session' };
    const acknowledged: unknown[] = [], emitted: unknown[] = [];
    const overview = { sessionId: '', conversationId: null, overview: 'cached overview', context: 'cached overview', identifiers: '' };
    await processHook(identity.agentType, { session_id: identity.nativeSessionId, cwd: '/project' }, {
        event: 'SessionStart', request: async () => overview,
        emit: output => emitted.push(output),
        markDelivered: async (sessionId, host) => { acknowledged.push({ sessionId, host }); },
    });
    assert.equal(emitted.length, 1);
    assert.deepEqual(acknowledged, [{ sessionId: '', host: identity }]);
});

test('a native bridge acknowledges a session-start overview without creating a local task', async () => {
    const acknowledged: unknown[] = [];
    const send = Object.assign(async (): Promise<EventResult> => ({ sessionId: '', conversationId: null, overview: 'cached', context: 'cached', identifiers: '' }), {
        delivered: async (sessionId: string, identity?: { agentType: string; nativeSessionId: string }) => { acknowledged.push({ sessionId, identity }); },
    });
    const bridge = new Bridge('pi', '/project', send);
    await bridge.start('native-session'); await bridge.delivered('native-session'); await bridge.delivered('native-session');
    assert.deepEqual(acknowledged, [{ sessionId: '', identity: { agentType: 'pi', nativeSessionId: 'native-session' } }]);
    assert.equal(bridge.historyContext('native-session'), '');
});

test('verified blocking SessionStart keeps the existing local request budget without extending ordinary hooks', async t => {
    const home = await mkdtemp(join(tmpdir(), 'pm-overview-hook-'));
    t.after(() => rm(home, { recursive: true, force: true }));
    for (const [agent, path] of [['claude-code', '.claude/settings.json'], ['codex-cli', '.codex/hooks.json']]) {
        await installAdapter(agent!, { home, cwd: '/project' });
        const config = JSON.parse(await readFile(join(home, path!), 'utf8'));
        assert.equal(config.hooks.SessionStart[0].hooks[0].timeout, 20);
        assert.equal(config.hooks.UserPromptSubmit[0].hooks[0].timeout, 10);
        assert.equal(config.hooks.SessionStart[0].hooks[0].async, undefined);
    }
});
