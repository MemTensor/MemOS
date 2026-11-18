import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeHook, processHook } from '../../src/adapters/_shared/hooks.ts';

test('Codex hooks notify one reader instead of duplicating prompt and child transcript messages', async () => {
    const event = await normalizeHook('codex-cli', { session_id: 'parent', cwd: '/project', hook_event_name: 'UserPromptSubmit', turn_id: 'turn-a', prompt: 'task', transcript_path: '/missing/parent.jsonl' });
    assert.equal(event.nativeTurnId, 'turn-a');
    assert.deepEqual(event.records, []);
    assert.equal((event.raw as any).transcript_path, '/missing/parent.jsonl');
    const events: any[] = [];
    await processHook('codex-cli', { session_id: 'parent', cwd: '/project', hook_event_name: 'SubagentStop', turn_id: 'turn-a', agent_id: 'child', agent_transcript_path: '/missing/child.jsonl', last_assistant_message: 'child result' }, {
        request: async captured => { events.push(captured); return { sessionId: 'local-parent', conversationId: 'round', context: '', overview: '', identifiers: '' }; }
    });
    assert.equal(events.length, 1);
    assert.deepEqual(events[0].records, []);
    assert.equal(events[0].raw.agent_id, 'child');
});

test('Codex never invents random turns for an unidentifiable prompt receipt', async () => {
    const input = { session_id: 'parent', cwd: '/project', hook_event_name: 'UserPromptSubmit', prompt: 'same task' };
    const first = await normalizeHook('codex-cli', input);
    const second = await normalizeHook('codex-cli', input);
    assert.equal(first.turnKey, undefined);
    assert.equal(second.turnKey, undefined);
});
