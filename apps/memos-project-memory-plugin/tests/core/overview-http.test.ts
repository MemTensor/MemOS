import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PluginService } from '../../src/server/service.ts';
import { createLocalServer } from '../../src/server/http.ts';
import { profile } from '../../src/adapters/qwen-code/profile.ts';

function overview(text: string) {
    return { topic_detail_list: [{ id: 'topic', topic_name: 'Fixture topic', topic_summary: text, topic_description: text }] };
}
function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>(done => { resolve = done; });
    return { promise, resolve };
}

async function fixture(t: TestContext) {
    const directory = mkdtempSync(join(tmpdir(), 'pm-overview-http-'));
    const previousBlocking = (profile as any).sessionStartBlocking;
    (profile as any).sessionStartBlocking = false;
    let reads = 0;
    let overviewText = 'cached overview';
    let failedSpace: string | undefined;
    let held: { started: ReturnType<typeof deferred<void>>; result: ReturnType<typeof deferred<ReturnType<typeof overview>>> } | undefined;
    const cloud = createServer(async (request, response) => {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
        const endpoint = request.url?.split('/').slice(-2).join('/');
        let data: unknown;
        if (endpoint === 'get/space') data = { space_id: body.space_id, space_name: 'Fixture Space' };
        else if (endpoint === 'list/domains') data = { domains: [{ domain: '编程' }] };
        else if (endpoint === 'get/memory') {
            reads++;
            if (failedSpace === '*' || failedSpace === body.space_id) {
                failedSpace = undefined;
                response.writeHead(503, { 'Content-Type': 'application/json' });
                response.end(JSON.stringify({ code: 50004, message: 'fixture overview unavailable', data: null }));
                return;
            }
            const pending = held; held = undefined;
            if (pending) { pending.started.resolve(); data = await pending.result.promise; }
            else data = { topic_detail_list: [{ ...overview(overviewText).topic_detail_list[0], id: 'topic:' + body.space_id }] };
        } else { response.writeHead(404); response.end(); return; }
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ code: 0, data }));
    });
    cloud.listen(0, '127.0.0.1'); await once(cloud, 'listening');
    const cloudAddress = cloud.address(); assert.ok(cloudAddress && typeof cloudAddress !== 'string');
    const service = new PluginService(directory, { home: directory, codexRoots: [] });
    service.configure({ baseUrl: `http://127.0.0.1:${cloudAddress.port}/api/openmem/v1`, apiKey: 'fixture-key' });
    const server = createLocalServer(service); server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const address = server.address(); assert.ok(address && typeof address !== 'string');
    t.after(async () => {
        held?.result.resolve(overview('released during cleanup'));
        await new Promise<void>(resolve => server.close(() => resolve()));
        service.close();
        await new Promise<void>(resolve => cloud.close(() => resolve()));
        if (previousBlocking === undefined) delete (profile as any).sessionStartBlocking;
        else (profile as any).sessionStartBlocking = previousBlocking;
        rmSync(directory, { recursive: true, force: true });
    });
    const post = async (path: string, body: unknown) => {
        const response = await fetch(`http://127.0.0.1:${address.port}/api/${path}`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(2000),
        });
        return { http: response.status, body: await response.json() as any };
    };
    const start = (nativeSessionId: string) => post('events', { agentType: 'qwen-code', nativeSessionId, cwd: '/fixture/project', event: 'session-start' });
    const bind = async (spaceId = 'space') => {
        const result = await post('projects', { agentType: 'qwen-code', root: '/fixture/project', spaceId });
        assert.equal(result.http, 200, JSON.stringify(result.body));
        return result.body;
    };
    const expire = () => service.store.db.prepare('UPDATE project_overviews SET fetchedAt=?').run(new Date(Date.now() - 7 * 60 * 60 * 1000).toISOString());
    const hold = () => {
        const next = { started: deferred<void>(), result: deferred<ReturnType<typeof overview>>() }; held = next;
        return { started: next.started.promise, release: (text: string) => next.result.resolve(overview(text)) };
    };
    return { service, post, start, bind, expire, hold, reads: () => reads,
        failNextOverview: (spaceId = '*') => { failedSpace = spaceId; },
        setOverview: (text: string) => { overviewText = text; } };
}

test('HTTP session opening consumes the project cache without creating a task or reading the cloud within six hours', async t => {
    const f = await fixture(t);
    await f.bind();
    assert.equal(f.reads(), 1, 'binding must populate the per-Space cache immediately');
    const result = await f.start('fresh-session');
    assert.equal(result.http, 200);
    assert.match(result.body.overview, /cached overview/);
    assert.match(result.body.context, /cached overview/);
    assert.equal(f.reads(), 1);
    for (const table of ['tasks', 'turns', 'traces', 'batches'])
        assert.equal(f.service.store.row(`SELECT count(*) n FROM ${table}`)!.n, 0, `${table} must not be created by a lifecycle signal`);
});

test('HTTP nonblocking session opening returns the old cache while an expired refresh remains in flight', async t => {
    const f = await fixture(t);
    await f.bind(); f.expire();
    const refresh = f.hold();
    try {
        const result = await f.start('nonblocking-session');
        assert.equal(result.http, 200);
        assert.match(result.body.overview, /cached overview/);
        await Promise.race([refresh.started, new Promise<never>((_, reject) => setTimeout(() => reject(new Error('session opening never triggered refresh')), 1000))]);
        assert.equal(f.reads(), 2);
    } finally { refresh.release('updated overview'); }
    // A blocking consumer joins the same in-flight refresh, or reads its committed result.
    (profile as any).sessionStartBlocking = true;
    const next = await f.start('blocking-consumer');
    assert.match(next.body.overview, /updated overview/);
    assert.equal(f.reads(), 2, 'concurrent session starts must share one refresh');
});

test('HTTP blocking session opening returns the refreshed overview after the SQLite write', async t => {
    const f = await fixture(t);
    await f.bind(); f.expire();
    (profile as any).sessionStartBlocking = true;
    const refresh = f.hold();
    const pending = f.start('blocking-session');
    try {
        await Promise.race([refresh.started, new Promise<never>((_, reject) => setTimeout(() => reject(new Error('session opening never triggered refresh')), 1000))]);
    } finally { refresh.release('blocking fresh overview'); }
    const result = await pending;
    assert.match(result.body.overview, /blocking fresh overview/);
    const cache = f.service.store.row('SELECT data FROM project_overviews')!;
    assert.match(String(cache.data), /blocking fresh overview/);
});

test('HTTP dialog binding returns the newly fetched project overview in the same response', async t => {
    const f = await fixture(t);
    const context = await f.post('create-context', { agentType: 'qwen-code', nativeSessionId: 'dialog', cwd: '/fixture/project', event: 'turn-start', turnKey: 'user-input' });
    const result = await f.post('bind-project', { context: context.body.createContext, spaceId: 'space' });
    assert.equal(result.http, 200);
    assert.equal(result.body.status, 'BOUND');
    assert.match(result.body.data.overview, /cached overview/);
    assert.equal(f.reads(), 1);
    assert.equal(f.service.store.row('SELECT count(*) n FROM batches')!.n, 0);
});

test('HTTP delivery acknowledgement before any task is inherited by the first user turn without another overview request', async t => {
    const f = await fixture(t);
    await f.bind();
    const opened = await f.start('delivered-session');
    assert.equal(opened.body.sessionId, '');
    assert.equal(opened.body.overviewDelivered, false);
    assert.match(opened.body.overview, /cached overview/);
    const delivered = await f.post('context-delivery', { agentType: 'qwen-code', nativeSessionId: 'delivered-session' });
    assert.equal(delivered.http, 200);
    const turn = await f.post('events', {
        agentType: 'qwen-code', nativeSessionId: 'delivered-session', cwd: '/fixture/project', event: 'turn-start', turnKey: 'user-turn',
    });
    assert.equal(turn.http, 200);
    assert.equal(turn.body.overviewDelivered, true);
    assert.equal(f.service.store.session(turn.body.sessionId)!.overviewDelivered, 1);
    assert.equal(f.reads(), 1);
    assert.equal(f.service.store.row('SELECT count(*) n FROM batches')!.n, 0);
});

test('HTTP expired refresh failure retains the previous cache timestamp and successful binding', async t => {
    const f = await fixture(t);
    await f.bind(); f.expire();
    const beforeCache = f.service.store.rows('SELECT * FROM project_overviews');
    const beforeBinding = f.service.store.rows('SELECT * FROM bindings');
    (profile as any).sessionStartBlocking = true;
    f.failNextOverview();
    const result = await f.start('failed-refresh-session');
    assert.equal(result.http, 200);
    assert.match(result.body.overview, /cached overview/);
    assert.equal(f.reads(), 2);
    assert.deepEqual(f.service.store.rows('SELECT * FROM project_overviews'), beforeCache);
    assert.deepEqual(f.service.store.rows('SELECT * FROM bindings'), beforeBinding);
    assert.ok(f.service.store.rows('SELECT message FROM diagnostics').some(row => String(row.message).includes('fixture overview unavailable')));
});

test('HTTP blocking refresh updates a successful Space independently when another Space fails', async t => {
    const f = await fixture(t);
    await f.bind('space-a'); await f.bind('space-b'); f.expire();
    const beforeA = f.service.store.row('SELECT * FROM project_overviews WHERE spaceId=?', 'space-a');
    const beforeB = f.service.store.row('SELECT * FROM project_overviews WHERE spaceId=?', 'space-b');
    (profile as any).sessionStartBlocking = true;
    f.failNextOverview('space-a'); f.setOverview('fresh second Space');
    const result = await f.start('mixed-refresh-session');
    assert.equal(result.http, 200);
    assert.match(result.body.overview, /cached overview/);
    assert.match(result.body.overview, /fresh second Space/);
    assert.deepEqual(f.service.store.row('SELECT * FROM project_overviews WHERE spaceId=?', 'space-a'), beforeA);
    const nextB = f.service.store.row('SELECT * FROM project_overviews WHERE spaceId=?', 'space-b')!;
    assert.match(String(nextB.data), /fresh second Space/);
    assert.notEqual(nextB.fetchedAt, beforeB!.fetchedAt);
    assert.equal(f.reads(), 4);
});
