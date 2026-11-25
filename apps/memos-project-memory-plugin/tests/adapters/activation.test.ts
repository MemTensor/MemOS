import { test } from 'node:test';
import assert from 'node:assert/strict';
import { processHook } from '../../src/adapters/_shared/hooks.ts';

test('unbound hook returns before opening a transcript or emitting context', async () => {
  let captured = false, emitted = false;
  const request = Object.assign(async () => { captured = true; throw new Error('unexpected capture'); }, { activation: async () => false });
  // This directory is not a transcript: normalization must remain behind activation.
  const result = await processHook('claude-code', {
    session_id: 'native', cwd: '/project', hook_event_name: 'UserPromptSubmit', transcript_path: process.cwd(),
  }, { request, emit: () => { emitted = true; }, markDelivered: async () => { throw new Error('unexpected delivery'); } });
  assert.equal(result, ''); assert.equal(emitted, false); assert.equal(captured, false);
});
