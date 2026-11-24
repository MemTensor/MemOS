import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Configuration } from '../../src/config/config.ts';
import { CloudClient, type CloudFailure } from '../../src/cloud/client.ts';
import { requestBodyBytes } from '../../src/cloud/protocol.ts';

async function setup(t: TestContext, mode: 'algorithm' | 'engineering' = 'algorithm') {
  const directory = mkdtempSync(join(tmpdir(), 'pm-protocol-'));
  const calls: { url: string; method: string; headers: Record<string, unknown>; body: any }[] = [];
  let response: { status: number; body: unknown } = { status: 200, body: { code: mode === 'algorithm' ? 200 : 0, data: {} } };
  const server = createServer(async (req, res) => {
    let raw = ''; for await (const part of req) raw += part;
    calls.push({ url: req.url!, method: req.method!, headers: req.headers, body: raw ? JSON.parse(raw) : undefined });
    res.writeHead(response.status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(response.body));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const config = new Configuration(directory);
  Object.assign(config.value, { apiMode: mode, baseUrl: `http://127.0.0.1:${address.port}/custom/product/`, authMode: mode === 'algorithm' ? 'none' : 'token', cloudProjectId: 'tenant-fixture', apiKey: mode === 'algorithm' ? '' : 'fixture-secret' });
  const failures: CloudFailure[] = [], client = new CloudClient(config, failure => failures.push(failure));
  t.after(async () => { await new Promise<void>(resolve => server.close(() => resolve())); rmSync(directory, { recursive: true, force: true }); });
  return { calls, config, client, failures, respond(data: unknown, code = mode === 'algorithm' ? 200 : 0, status = 200, extra = {}) { response = { status, body: { code, data, ...extra } }; } };
}

test('algorithm upload maps session, async mode and message IDs and selects project receipt rather than first array item', async t => {
  const f = await setup(t);
  f.config.update({ apiMode: 'algorithm', apiKey: 'fixture-secret' });
  f.respond([{ memory_view: 'text', success: true, task_id: 'other' }, { memory_view: 'project', success: true, task_id: 'project-task', status: 'running' }]);
  const input = { user_id: 'member', conversation_id: 'session', agent_id: 'agent', space_ids: ['space'], allow_memory_view: ['project'], async_mode: true,
    messages: [{ id: 'user-msg', role: 'user', content: 'hello', chat_time: '2026-11-23T10:00:00Z' }, { id: 'tool', role: 'tool', tool_call_id: 'call', content: '{"domain":"keep","id":"business-id"}' }] };
  const result = await f.client.call<{ task_id: string }>('add/message', input);
  assert.equal(result.task_id, 'project-task'); assert.equal(f.calls[0]!.url, '/custom/product/add');
  const body = f.calls[0]!.body; assert.equal(body.session_id, 'session'); assert.equal(body.conversation_id, undefined); assert.equal(body.async_mode, 'async'); assert.equal(body.project_id, 'tenant-fixture');
  assert.equal(f.calls[0]!.headers.authorization, 'Token fixture-secret');
  assert.equal(requestBodyBytes(f.config.value, input), Buffer.byteLength(JSON.stringify(body), 'utf8'));
  assert.equal(body.messages[0].message_id, 'user-msg'); assert.equal(body.messages[0].id, undefined);
  assert.equal(body.messages[1].tool_call_id, 'call'); assert.equal(body.messages[1].content, input.messages[1]!.content);
  assert.equal(input.messages[0]!.id, 'user-msg');
});

test('engineering protocol keeps POST, zero success code, Token and canonical fields', async t => {
  const f = await setup(t, 'engineering'); f.respond({ success: true, task_id: 'task', status: 'running' });
  const input = { user_id: 'user', conversation_id: 'session', async_mode: true, messages: [{ id: 'message', role: 'user', content: 'hello' }] };
  await f.client.call('add/message', input); assert.equal(f.calls[0]!.url, '/custom/product/add/message'); assert.deepEqual(f.calls[0]!.body, input); assert.equal(f.calls[0]!.headers.authorization, 'Token fixture-secret');
  f.respond({ status: 'completed' }); await f.client.call('get/status', { task_id: 'task' }); assert.equal(f.calls[1]!.method, 'POST');
  f.respond({ space_id: 'space' }, 200); await assert.rejects(f.client.call('create/space', { space_name: 'wrong envelope' }), /200/);
});
