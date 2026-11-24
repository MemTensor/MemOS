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

test('algorithm create and domain reads map only domain objects and preserve configured URL prefixes without a Key', async t => {
  const f = await setup(t); f.respond({ space_id: 'space', space_name: 'Project' });
  const input = { space_name: 'Project', domains: [{ domain: '编程', description: '代码' }] };
  await f.client.call('create/space', input);
  assert.equal(f.calls[0]!.url, '/custom/product/create_space'); assert.equal(f.calls[0]!.headers.authorization, undefined);
  assert.deepEqual(f.calls[0]!.body, { project_id: 'tenant-fixture', space_name: 'Project', domains: [{ name: '编程', description: '代码' }] });
  assert.deepEqual(input.domains, [{ domain: '编程', description: '代码' }]);
  f.respond({ domains: [{ name: '编程', description: '代码' }] });
  assert.deepEqual(await f.client.call('list/domains', { space_id: 'space' }), { domains: [{ domain: '编程', description: '代码' }] });
  assert.equal(f.calls[1]!.url, '/custom/product/list_domains');
  f.respond({ space_id: 'space' }); await f.client.call('get/space', { space_id: 'space' });
  assert.equal(f.calls[2]!.url, '/custom/product/get_space');
});

test('algorithm upload maps session, async mode and message IDs and selects project receipt rather than first array item', async t => {
  const f = await setup(t);
  f.respond([{ memory_view: 'text', success: true, task_id: 'other' }, { memory_view: 'project', success: true, task_id: 'project-task', status: 'running' }]);
  const input = { user_id: 'member', conversation_id: 'session', agent_id: 'agent', space_ids: ['space'], allow_memory_view: ['project'], async_mode: true,
    messages: [{ id: 'user-msg', role: 'user', content: 'hello', chat_time: '2026-11-23T10:00:00Z' }, { id: 'tool', role: 'tool', tool_call_id: 'call', content: '{"domain":"keep","id":"business-id"}' }] };
  const result = await f.client.call<{ task_id: string }>('add/message', input);
  assert.equal(result.task_id, 'project-task'); assert.equal(f.calls[0]!.url, '/custom/product/add');
  const body = f.calls[0]!.body; assert.equal(body.session_id, 'session'); assert.equal(body.conversation_id, undefined); assert.equal(body.async_mode, 'async'); assert.equal(body.project_id, 'tenant-fixture');
  assert.equal(requestBodyBytes(f.config.value, input), Buffer.byteLength(JSON.stringify(body), 'utf8'));
  assert.equal(body.messages[0].message_id, 'user-msg'); assert.equal(body.messages[0].id, undefined);
  assert.equal(body.messages[1].tool_call_id, 'call'); assert.equal(body.messages[1].content, input.messages[1]!.content);
  assert.equal(input.messages[0]!.id, 'user-msg');
});

test('algorithm task status is an encoded GET with exact task match and preserves open Episode evidence', async t => {
  const f = await setup(t); f.respond([{ task_id: 'other', status: 'completed' }, { task_id: 'task &1', status: 'in_progress', memory_views: { project: { memory_ids: ['topic'], open_episode_messages: 2 } } }]);
  const result = await f.client.call<any>('get/status', { task_id: 'task &1', user_id: 'original member' });
  assert.equal(result.status, 'running'); assert.equal(result.memory_views.project.open_episode_messages, 2);
  const call = f.calls[0]!, url = new URL(call.url, 'http://fixture');
  assert.equal(url.pathname, '/custom/product/scheduler/status'); assert.equal(url.searchParams.get('task_id'), 'task &1'); assert.equal(url.searchParams.get('user_id'), 'original member');
  assert.equal(call.method, 'GET'); assert.equal(call.body, undefined);
  f.respond([{ task_id: 'wrong', status: 'completed' }]); await assert.rejects(f.client.call('get/status', { task_id: 'task' }), /任务|task/i);
});

test('algorithm search and overview retain domain names and use their own request mappings', async t => {
  const f = await setup(t); f.respond({ topic_detail_list: [{ domain: '编程' }] });
  await f.client.call('search/memory', { user_id: 'user', conversation_id: 'session', query: 'q', space_ids: ['space'], domains: ['编程'], include_memory_view: ['project'] });
  assert.equal(f.calls[0]!.url, '/custom/product/search'); assert.equal(f.calls[0]!.body.session_id, 'session'); assert.deepEqual(f.calls[0]!.body.domains, ['编程']);
  await f.client.call('get/memory', { space_id: 'space', page: 1, size: 10 });
  assert.equal(f.calls[1]!.url, '/custom/product/get_memory'); assert.deepEqual(f.calls[1]!.body, { space_id: 'space', page: 1, page_size: 10 });
});

test('engineering and existing Mock protocol keep POST, zero success code, Token and canonical fields', async t => {
  const f = await setup(t, 'engineering'); f.respond({ success: true, task_id: 'task', status: 'running' });
  const input = { user_id: 'user', conversation_id: 'session', async_mode: true, messages: [{ id: 'message', role: 'user', content: 'hello' }] };
  await f.client.call('add/message', input); assert.equal(f.calls[0]!.url, '/custom/product/add/message'); assert.deepEqual(f.calls[0]!.body, input); assert.equal(f.calls[0]!.headers.authorization, 'Token fixture-secret');
  f.respond({ status: 'completed' }); await f.client.call('get/status', { task_id: 'task' }); assert.equal(f.calls[1]!.method, 'POST');
  f.respond({ space_id: 'space' }, 200); await assert.rejects(f.client.call('create/space', { space_name: 'wrong envelope' }), /200/);
});

test('engineering status refuses a mismatched task ID while retaining legacy responses without that field', async t => {
  const f = await setup(t, 'engineering'); f.respond({ task_id: 'different-task', status: 'completed' });
  await assert.rejects(f.client.call('get/status', { task_id: 'expected-task' }), /任务|task/i);
  f.respond({ task_id: 'expected-task', status: 'completed', memory_views: { project: { open_episode_messages: 0 } } });
  assert.equal((await f.client.call<any>('get/status', { task_id: 'expected-task' })).status, 'completed');
  f.respond({ status: 'completed' }); assert.equal((await f.client.call<any>('get/status', { task_id: 'expected-task' })).status, 'completed');
});

test('ambiguous algorithm receipts fail closed and diagnostics preserve reason while redacting credentials', async t => {
  const f = await setup(t); f.respond([{ memory_view: 'project', success: true, task_id: 'a' }, { memory_view: 'project', success: true, task_id: 'b' }]);
  await assert.rejects(f.client.call('add/message', {}), /project|项目/);
  Object.assign(f.config.value, { authMode: 'bearer', apiKey: 'hidden-secret' });
  f.respond({ token: 'hidden-secret' }, 404, 404, { reason: 'SPACE_NOT_FOUND', message: 'hidden-secret is not allowed' });
  await assert.rejects(f.client.call('get/status', { task_id: 'task' }), (error: any) => error.reason === 'SPACE_NOT_FOUND' && error.uncertain === false);
  assert.equal(f.calls.at(-1)!.headers.authorization, 'Bearer hidden-secret');
  assert.equal(f.failures.at(-1)!.method, 'GET'); assert.doesNotMatch(JSON.stringify(f.failures), /hidden-secret/);
  assert.equal(f.failures.at(-1)!.reason, 'SPACE_NOT_FOUND');
});

test('an in-flight call decodes and reports using its original configuration snapshot', async t => {
  const f = await setup(t); f.respond({ space_id: 'space' });
  const pending = f.client.call('get/space', { space_id: 'space' });
  Object.assign(f.config.value, { apiMode: 'engineering', baseUrl: 'http://invalid.example/api', authMode: 'token', apiKey: 'new-secret' });
  assert.deepEqual(await pending, { space_id: 'space' });
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0]!.url, '/custom/product/get_space'); assert.equal(f.calls[0]!.headers.authorization, undefined);
});

test('lost or invalid write receipts are uncertain without an automatic retry', async t => {
  const f = await setup(t); f.respond([{ memory_view: 'project', success: true }]);
  await assert.rejects(f.client.call('add/message', {}), (error: any) => error.uncertain === true && error.kind === 'response');
  assert.equal(f.calls.length, 1);
  f.respond(null, 400, 400, { reason: 'SPACE_DOMAIN_NOT_CONFIGURED' });
  await assert.rejects(f.client.call('add/message', {}), (error: any) => error.uncertain === false && error.reason === 'SPACE_DOMAIN_NOT_CONFIGURED');
  assert.equal(f.calls.length, 2);
});

test('connection probe never creates a space and reports HTTP reachability separately from verified protocol access', async t => {
  const f = await setup(t); f.respond(null, 404, 404);
  const result = await f.client.probe(); assert.equal(result.reachable, true); assert.equal(result.verified, false);
  assert.equal(f.calls[0]!.method, 'GET'); assert.equal(f.calls[0]!.url, '/custom/product/');
  f.respond({ space_id: 'known', space_name: 'Known' }); const verified = await f.client.probe('known'); assert.equal(verified.verified, true);
  assert.equal(f.calls[1]!.url, '/custom/product/get_space'); assert.equal(f.calls.some(call => call.url.includes('create')), false);
});
test('a degraded project search is unavailable rather than a successful empty result', async t => {
  const f = await setup(t);
  f.respond({ topic_detail_list: [], channels: [], degraded: ['project'], truncated: false });
  await assert.rejects(f.client.call('search/memory', { user_id: 'user', query: 'task', include_memory_view: ['project'], space_ids: ['space'] }), /检索通道暂不可用/);
});
