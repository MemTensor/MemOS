import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PluginService } from '../../src/server/service.ts';

function setup(t: { after: (fn: () => void) => void }) {
    const home = mkdtempSync(join(tmpdir(), 'pm-overview-service-'));
    const service = new PluginService(home, { home, codexRoots: [] });
    t.after(() => { service.close(); rmSync(home, { recursive: true, force: true }); });
    service.configure({ apiKey: 'fixture-key' });
    return service;
}
test('a creation receipt keeps no overview copy and a replay reads only the current cache', async t => {
    const service = setup(t);
    let overview = 'Sensitive old overview', createdSpaces = 0;
    service.cloud.call = async endpoint => {
        if (endpoint === 'create/space') { createdSpaces++; return { space_id: 'space', space_name: 'Space' } as any; }
        if (endpoint === 'get/space') return { space_id: 'space', space_name: 'Space' } as any;
        return { topic_detail_list: [{ id: 'topic', topic_summary: overview }] } as any;
    };
    const context = await service.createContext({ agentType: 'qwen-code', nativeSessionId: 'session', cwd: '/fixture/project', event: 'turn-start', turnKey: 'first' });
    const input = { context: context.createContext, name: 'Space', domain: '编程' };
    const created = await service.create(input);
    assert.match(created.data!.overview!, /Sensitive old overview/);
    const receipt = service.store.row('SELECT result FROM create_contexts WHERE token=?', context.createContext)!;
    assert.doesNotMatch(String(receipt.result), /Sensitive old overview/);
    overview = 'Refreshed overview';
    await service.bind(created.data!.scopeId, 'space');
    const replayed = await service.create(input);
    assert.match(replayed.data!.overview!, /Refreshed overview/);
    assert.doesNotMatch(replayed.data!.overview!, /Sensitive old overview/);
    assert.equal(createdSpaces, 1);
    service.store.unbind(created.data!.scopeId, 'space');
    const replay = await service.create(input);
    assert.equal(replay.status, 'CREATED');
    assert.equal(replay.data!.overview, null);
});
