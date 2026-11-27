import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync,rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PluginService } from '../../src/server/service.ts';
import { createLocalServer } from '../../src/server/http.ts';
async function fixture(t: TestContext) {
 const dir = mkdtempSync(join(tmpdir(), 'pm-http-'));
 const service = new PluginService(dir), server = createLocalServer(service);
 server.listen(0, '127.0.0.1');
 await once(server, 'listening');
 t.after(async () => {
  await new Promise<void>(done => server.close(() => done()));
  service.close();
  rmSync(dir, { recursive: true });
 });
 const address = server.address();
 assert.ok(address && typeof address !== 'string');
 return { service, base: `http://127.0.0.1:${address.port}` };
}

test('local API exposes config safely, creates projects, and rejects cross-origin mutations',async t=>{
 const { base } = await fixture(t);
 const health=await (await fetch(base+'/api/health')).json() as any;
 assert.equal(health.apiVersion,10);assert.equal(health.pid,process.pid);assert.equal(typeof health.runtimeRevision,'string');assert.ok(health.runtimeRevision.length>0);
 let response=await fetch(base+'/api/config',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({apiKey:'private-value'})});const config=await response.json() as any;assert.equal(config.keyConfigured,true);assert.equal(config.apiKey,undefined);assert.equal(config.apiKeyLength,13);
 response=await fetch(base+'/api/projects',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:'Demo',root:'/demo'})});assert.equal(response.status,200);
 response=await fetch(base+'/api/projects',{method:'POST',headers:{'Content-Type':'application/json',Origin:'https://evil.example'},body:JSON.stringify({name:'Other',root:'/other'})});assert.equal(response.status,403);
 const state=await (await fetch(base+'/api/state')).json() as any;assert.equal(state.projects.length,1);
 assert.equal((await fetch(base+'/')).status,200);
 const translations=await fetch(base+'/i18n.js');assert.equal(translations.status,200);assert.match(translations.headers.get('content-type')??'',/javascript/);
 assert.equal((await fetch(base+'/unknown.js')).status,404);
});

test('session reads refresh titles before validation and paginate visible sessions in stable order', async t => {
 const { service, base } = await fixture(t);
 const { store } = service;
 const root = '/fixture/project';
 const project = store.bindProject('Demo', root, 'space', service.config.value.baseUrl, 'qwen-code');
 const first = store.registerSession({ agentType: 'qwen-code', nativeSessionId: 'first', cwd: root });
 const second = store.registerSession({ agentType: 'qwen-code', nativeSessionId: 'second', cwd: root });
 const hidden = store.registerSession({ agentType: 'cursor-cli', nativeSessionId: 'hidden', cwd: root });
 store.db.exec("UPDATE sessions SET createdAt='2026-01-01T00:00:00Z'");
 const ids = [first.id, second.id].sort((a, b) => a.localeCompare(b));
 let refreshCount = 0;
 t.mock.method(service, 'refreshSessionTitles', async () => {
  store.setSessionTitle(ids[1]!, `title-${++refreshCount}`);
 });
 const get = (path: string) => fetch(base + '/api/' + path);
 for (const suffix of ['', '?projectId=' + project.id + '&scope=unassigned']) {
  const response = await get('sessions' + suffix);
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: '请选择项目或未归属范围' });
 }
 const missing = await get('sessions?projectId=missing');
 assert.equal(missing.status, 404);
 assert.deepEqual(await missing.json(), { error: '项目不存在' });
 const page = await (await get('sessions?projectId=' + project.id + '&page=2&size=1')).json() as any;
 assert.deepEqual([page.projectId, page.total, page.page, page.size], [project.id, 2, 2, 1]);
 assert.deepEqual(page.sessions.map((s: { id: string; title: string }) => [s.id, s.title]), [[ids[1], 'title-4']]);
 const unassigned = await (await get('sessions?scope=unassigned&size=999')).json();
 assert.deepEqual(unassigned, { projectId: null, sessions: [], total: 0, page: 1, size: 200 });
 const detail = await get('sessions/' + hidden.id);
 assert.equal(detail.status, 404);
 assert.deepEqual(await detail.json(), { error: '会话不存在' });
 assert.equal((await get('state')).status, 200);
 assert.equal(refreshCount, 7);
});

test('only the project creation response includes the Space ID on a partial failure', async t => {
 const { service, base } = await fixture(t);
 const error = Object.assign(new Error('binding failed'), { spaceId: 'already-created' });
 t.mock.method(service, 'bindProject', async () => { throw error; });
 t.mock.method(service, 'bindDialog', async () => { throw error; });
 for (const path of ['projects', 'bind-project']) {
  const response = await fetch(base + '/api/' + path, {
   method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"spaceId":"requested"}',
  });
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), path === 'projects'
   ? { error: 'binding failed', spaceId: 'already-created' } : { error: 'binding failed' });
 }
 assert.equal(service.store.rows("SELECT id FROM diagnostics WHERE message='binding failed'").length, 2);
});

test('context delivery uses the registered session first and falls back to an active host', async t => {
 const { service, base } = await fixture(t);
 const { store } = service;
 const cwd = '/fixture/project', agentType = 'qwen-code';
 store.bindProject('Demo', cwd, 'space', service.config.value.baseUrl, agentType);
 const session = store.registerSession({ agentType, nativeSessionId: 'registered', cwd });
 const host = { agentType, nativeSessionId: 'host-only' };
 await service.createContext({ ...host, cwd, event: 'session-start' });
 const deliver = async (body: object) => {
  const response = await fetch(base + '/api/context-delivery', {
   method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true });
 };
 await deliver({ ...host, sessionId: session.id });
 assert.equal(store.session(session.id)?.overviewDelivered, 1);
 assert.equal(store.hostContextDelivered(agentType, host.nativeSessionId), false);
 await deliver(host);
 assert.equal(store.hostContextDelivered(agentType, host.nativeSessionId), true);
});
