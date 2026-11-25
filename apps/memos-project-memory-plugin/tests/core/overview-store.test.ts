import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { Configuration } from '../../src/config/config.ts';
import { Store } from '../../src/storage/store.ts';

function setup(t: TestContext) {
    const directory = mkdtempSync(join(tmpdir(), 'pm-overview-store-'));
    const config = new Configuration(directory);
    config.update({ baseUrl: 'http://localhost:9801/product', apiMode: 'algorithm', cloudProjectId: 'fixture' });
    const path = join(directory, 'memory.sqlite');
    let store = new Store(path, config);
    t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
    const project = store.bindProject('Project', '/fixture/project', 'A', config.value.baseUrl, 'qwen-code');
    const save = (spaceId: string, content: string) => store.saveProjectOverview(project.scopeId, store.connectionId(), spaceId,
        String(store.row('SELECT boundAt FROM bindings WHERE objectId=? AND spaceId=?', project.scopeId, spaceId)!.boundAt), content);
    return { config, project, save, get store() { return store; }, restart() { store.close(); store = new Store(path, config); return store; } };
}

test('project overview merges only current bound Spaces, keeps entry order and duplicates and does not cross scopes', t => {
    const f = setup(t);
    f.store.bind(f.project.scopeId, 'B', f.config.value.baseUrl);
    f.save('A', '- shared\n\n- A');
    f.save('B', '- shared\n\n- B');
    assert.equal(f.store.projectOverviewContent(f.project.scopeId), '- shared\n\n- A\n\n- shared\n\n- B');
    const other = f.store.bindProject('Other', '/fixture/other', 'A', f.config.value.baseUrl, 'qwen-code');
    assert.deepEqual(f.store.projectOverview(other.scopeId, 'A'), { content: null, fetchedAt: null });
    assert.deepEqual(f.store.projectOverviewContent(other.scopeId), null);
    const otherAgent = f.store.bindProject('Project', '/fixture/project', 'A', f.config.value.baseUrl, 'claude-code');
    assert.deepEqual(f.store.projectOverview(otherAgent.scopeId, 'A'), { content: null, fetchedAt: null });
    f.store.unbind(f.project.scopeId, 'A');
    assert.equal(f.store.projectOverview(f.project.scopeId, 'A'), undefined);
    assert.equal(f.store.projectOverviewContent(f.project.scopeId), '- shared\n\n- B');
    assert.equal(f.store.rows('SELECT * FROM project_overviews WHERE scopeId=? AND spaceId=?', f.project.scopeId, 'A').length, 0);
});

test('legacy per-Space JSON is backed up and converted locally once, preserving successful and unknown timestamps', t => {
    const f = setup(t);
    for (const space of ['B', 'C']) f.store.bind(f.project.scopeId, space, f.config.value.baseUrl);
    f.store.db.exec(`DROP TABLE project_overviews;
        CREATE TABLE project_overviews(scopeId TEXT NOT NULL,connectionId TEXT NOT NULL,spaceId TEXT NOT NULL,data TEXT,fetchedAt TEXT,PRIMARY KEY(scopeId,connectionId,spaceId))`);
    const put = f.store.db.prepare('INSERT INTO project_overviews VALUES(?,?,?,?,?)');
    const fetchedAt = '2026-01-01T12:00:00.000Z';
    const raw = JSON.stringify({ topic_detail_list: [
        { id: 'k', topic_summary: ' summary ', topic_description: 'line one\nline two', decisions: ['excluded'] },
        { id: 'k', topic_description: 'last', topic_name: 'excluded' },
    ] });
    put.run(f.project.scopeId, f.store.connectionId(), 'A', raw, fetchedAt);
    put.run(f.project.scopeId, f.store.connectionId(), 'B', '{"topic_detail_list":[]}', fetchedAt);
    put.run(f.project.scopeId, f.store.connectionId(), 'C', null, null);
    const expected = { content: '- summary\n  line one\n  line two\n\n- last', fetchedAt };
    f.restart();
    assert.deepEqual(f.store.projectOverview(f.project.scopeId, 'A'), expected);
    assert.deepEqual(f.store.projectOverview(f.project.scopeId, 'B'), { content: '', fetchedAt });
    assert.deepEqual(f.store.projectOverview(f.project.scopeId, 'C'), { content: null, fetchedAt: null });
    const backups = () => readdirSync(dirname(f.config.path)).filter(name => name.includes('.before-overview-content-'));
    assert.equal(backups().length, 1);
    const backup = new DatabaseSync(join(dirname(f.config.path), backups()[0]!), { readOnly: true });
    try { assert.equal(backup.prepare("SELECT data FROM project_overviews WHERE spaceId='A'").get()?.data, raw); }
    finally { backup.close(); }
    assert.deepEqual(f.restart().projectOverview(f.project.scopeId, 'A'), expected);
    assert.equal(backups().length, 1);
});
