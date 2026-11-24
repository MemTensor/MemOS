import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PluginService } from '../../src/server/service.ts';
import { createLocalServer } from '../../src/server/http.ts';

async function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'pm-dialog-spaces-'));
  const service = new PluginService(directory, {home: directory, codexRoots: []});
  let cloudCalls = 0;
  service.cloud.call = async () => { cloudCalls++; throw new Error('local query must never call the cloud'); };
  const server = createLocalServer(service); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  t.after(async () => {
    await new Promise<void>(resolve => server.close(() => resolve())); service.close();
    rmSync(directory, {recursive: true, force: true});
  });
  const post = async (body: unknown) => {
    const response = await fetch(`http://127.0.0.1:${address.port}/api/project-spaces`, {
      method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body),
    });
    return {httpStatus: response.status, ...await response.json() as any};
  };
  const identity = {agentType: 'qwen-code', nativeSessionId: 'dialog', cwd: '/work/dialog', event: 'turn-start', turnKey: 'first'};
  const context = (await service.createContext(identity)).createContext;
  const bind = (root: string, agentType: string, spaceId: string, name = '') => service.store.bindProject(root.split('/').at(-1)!, root, spaceId, service.config.value.baseUrl, agentType, name);
  return {service, post, identity, context, bind, cloudCalls: () => cloudCalls};
}

test('dialog spaces returns locally cached names and IDs without a Key, cloud access or database changes', async t => {
  const {service, post, context, identity, bind, cloudCalls} = await fixture(t);
  bind(identity.cwd, identity.agentType, 'one', '开发记忆');
  bind(identity.cwd, identity.agentType, 'two', '');
  assert.equal(service.config.value.apiKey, '');
  const before = service.store.row('SELECT total_changes() AS changes')!.changes;
  const result = await post({context});
  assert.equal(result.httpStatus, 200);
  assert.equal(result.status, 'FOUND'); assert.equal(result.ok, true);
  assert.deepEqual(result.data, {agentType: identity.agentType, root: identity.cwd, spaces: [
    {spaceId: 'one', name: '开发记忆'}, {spaceId: 'two', name: ''},
  ]});
  assert.equal(service.store.row('SELECT total_changes() AS changes')!.changes, before);
  assert.equal(cloudCalls(), 0); assert.equal(service.state().sessions.length, 0);
  service.configure({baseUrl:'http://127.0.0.1:1/changed', paused:true});
  assert.deepEqual((await post({context})).data, result.data);
  assert.equal(cloudCalls(), 0);
});
