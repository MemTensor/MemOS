import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Configuration, connectionError } from '../../src/config/config.ts';
import { requestBody } from '../../src/cloud/protocol.ts';

test('algorithm connections default to the required project ID and preserve custom IDs across protocol updates', t => {
    const directory = mkdtempSync(join(tmpdir(), 'pm-config-'));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const config = new Configuration(directory);
    assert.equal(config.value.cloudProjectId, 'test1');
    const configured = config.update({ apiMode: 'algorithm', apiKey: 'fixture-key' });
    assert.equal(configured.connectionConfigured, true);
    for (const endpoint of ['create/space', 'add/message'])
        assert.equal(requestBody(config.value, endpoint, {}).project_id, 'test1');
    config.update({ cloudProjectId: 'customer-project' });
    assert.equal(connectionError(config.value), undefined);
    config.update({ apiMode: 'engineering' });
    config.update({ apiMode: 'algorithm' });
    assert.equal(config.value.cloudProjectId, 'customer-project');
    assert.equal(new Configuration(directory).value.cloudProjectId, 'customer-project');
});

test('legacy configuration restores missing and empty project defaults and preserves explicit IDs', t => {
    const directory = mkdtempSync(join(tmpdir(), 'pm-config-legacy-'));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const legacy = { userId: 'fixture-user', installationId: 'fixture-install', baseUrl: 'http://localhost/product', apiKey: 'fixture-key', paused: false, apiMode: 'algorithm' };
    writeFileSync(join(directory, 'config.json'), JSON.stringify(legacy));
    const missing = new Configuration(directory);
    assert.equal(missing.value.cloudProjectId, 'test1');
    assert.equal(missing.public().connectionConfigured, true);
    writeFileSync(join(directory, 'config.json'), JSON.stringify({ ...legacy, cloudProjectId: '' }));
    assert.equal(new Configuration(directory).value.cloudProjectId, 'test1');
    writeFileSync(join(directory, 'config.json'), JSON.stringify({ ...legacy, cloudProjectId: 'customer-project' }));
    const explicit = new Configuration(directory);
    assert.equal(explicit.value.cloudProjectId, 'customer-project');
    assert.equal(explicit.public().connectionConfigured, true);
});
