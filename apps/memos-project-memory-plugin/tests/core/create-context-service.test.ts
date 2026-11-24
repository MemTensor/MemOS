import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PluginService } from '../../src/server/service.ts';
import { createLocalServer } from '../../src/server/http.ts';

async function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'pm-create-context-'));
  let creationCount = 0;
  const services: PluginService[] = [], servers: ReturnType<typeof createLocalServer>[] = [];
  t.after(async () => {
    for (const server of servers) if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()));
    for (const service of services) if (service.store.db.isOpen) service.close();
    rmSync(directory, { recursive: true, force: true });
  });
  async function start() {
    const service = new PluginService(directory, { home: directory, codexRoots: [] }); services.push(service);
    service.configure({ apiKey: 'fixture-key' });
    service.cloud.call = async <T>(endpoint: string) => {
      if (endpoint === 'create/space') return { space_id: 'space-' + ++creationCount } as T;
      assert.equal(endpoint, 'get/memory');
      return { topic_detail_list: [] } as T;
    };
    const server = createLocalServer(service); servers.push(server);
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const address = server.address(); assert.ok(address && typeof address !== 'string');
    const post = async (path: string, body: unknown) => {
      const response = await fetch(`http://127.0.0.1:${address.port}/api/${path}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      return { status: response.status, body: await response.json() as any };
    };
    return { service, server, post };
  }
  return { ...await start(), start, creationCount: () => creationCount };
}

const identity = { agentType: 'qwen-code', nativeSessionId: 'native-main', cwd: '/work/dialog-project', event: 'turn-start', turnKey: 'input-1' };

test('concurrent and restarted retries return the original creation result without making another Space', async t => {
  const { service, server, post, start, creationCount } = await fixture(t);
  const context = (await post('create-context', identity)).body.createContext;
  const input = { context, name: '唯一空间', domain: '编程' };
  const [first, second] = await Promise.all([post('create', input), post('create', input)]);
  assert.equal(first.body.status, 'CREATED'); assert.deepEqual(second.body, first.body);
  await new Promise<void>(resolve => server.close(() => resolve())); service.close();
  const restarted = await start();
  assert.deepEqual((await restarted.post('create', input)).body, first.body);
  assert.equal(creationCount(), 1);
});
