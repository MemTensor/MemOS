import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Configuration } from '../../src/config/config.ts';

function setup(t: { after: (fn: () => void) => void }) {
    const dir = mkdtempSync(join(tmpdir(), 'pm-cloud-config-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    return dir;
}
test('old connection settings migrate as engineering without changing identity, key or upload preferences', t => {
    const dir = setup(t);
    const previous = { userId: 'user', installationId: 'installation', baseUrl: 'http://localhost:8711/api/openmem/v1', apiKey: 'private-key', paused: true, uploadMaxBytes: 900, historyUploadConfirmCount: 7 };
    writeFileSync(join(dir, 'config.json'), JSON.stringify(previous));
    const config = new Configuration(dir);
    assert.deepEqual(config.value, { ...previous, apiMode: 'engineering', authMode: 'token', cloudProjectId: '' });
    assert.equal(config.public().connectionConfigured, true);
    assert.equal('apiKey' in config.public(), false);
});
test('algorithm connection can be ready without a key and requires an explicit cloud project id', t => {
    const dir = setup(t), config = new Configuration(dir);
    config.update({ apiMode: 'algorithm', baseUrl: 'http://localhost:9801/product/' });
    assert.equal(config.public().authMode, 'none');
    assert.equal(config.public().connectionConfigured, false);
    config.update({ cloudProjectId: 'test-project' });
    assert.equal(config.public().connectionConfigured, true);
    assert.equal(config.public().baseUrl, 'http://localhost:9801/product');
    assert.equal(config.public().keyConfigured, false);
    config.update({ apiMode: 'engineering' });
    assert.equal(config.public().authMode, 'token');
    assert.equal(config.public().connectionConfigured, false);
    assert.equal(config.public().baseUrl, 'http://localhost:9801/product');
});
test('invalid settings are rejected atomically in memory and on disk', t => {
    const dir = setup(t), config = new Configuration(dir), before = { ...config.value };
    const disk = readFileSync(config.path, 'utf8');
    for (const input of [{ baseUrl: 'http://localhost/product', authMode: 'unknown' }, { apiMode: 'unknown' }, { baseUrl: 'http://localhost/product?token=private' }, { baseUrl: 'http://user:pass@localhost/product' }, { apiKey: 123 }]) {
        assert.throws(() => config.update(input as any));
        assert.deepEqual(config.value, before);
        assert.equal(readFileSync(config.path, 'utf8'), disk);
    }
});
test('a failed disk save cannot change the active connection or its revision', t => {
    const config = new Configuration(setup(t)), before = { ...config.value }, revision = config.revision;
    const path = config.path;
    config.path = join(config.path, 'missing', 'config.json');
    assert.throws(() => config.update({ baseUrl: 'http://localhost:7777/product', apiMode: 'algorithm', cloudProjectId: 'other' }));
    config.path = path;
    assert.deepEqual(config.value, before);
    assert.equal(config.revision, revision);
});
