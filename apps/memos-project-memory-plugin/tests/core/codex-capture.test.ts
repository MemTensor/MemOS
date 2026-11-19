import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, appendFile, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PluginService } from '../../src/server/service.ts';
import { normalizeHook } from '../../src/adapters/_shared/hooks.ts';

const row = (type: string, payload: object, ordinal: number, day = 1) => ({ type, payload, ordinal, timestamp: `2026-01-${String(day).padStart(2,'0')}T00:00:${String(ordinal).padStart(2,'0')}.000Z` });
const meta = (id: string, cwd: string, day = 1, extra = {}) => row('session_meta', { id, cwd, source: 'cli', ...extra }, 0, day);
const start = (id: string, n = 1, day = 1, extra = {}) => row('event_msg', { type: 'task_started', turn_id: id, root_turn_id: id, ...extra }, n, day);
const message = (id: string, role: string, content: string, n: number, day = 1) => row('response_item', { type: 'message', id, role, content, phase: role === 'assistant' ? 'final_answer' : undefined }, n, day);
const end = (id: string, n: number, day = 1) => row('event_msg', { type: 'task_complete', turn_id: id }, n, day);
const jsonl = (rows: unknown[]) => rows.map(x => JSON.stringify(x)).join('\n') + '\n';

test('archiving a complete rollout retires its missing path without losing traces or sent audit', async t => {
    const { sources, project, service } = await fixture(t);
    const path = join(sources, 'rollout-main.jsonl'), archive = join(sources, 'archived_sessions');
    await mkdir(archive);
    await writeFile(path, jsonl([meta('main', project), start('t'), message('u', 'user', 'task', 2), message('a', 'assistant', 'answer', 3), end('t', 4)]));
    await service.event(await normalizeHook('codex-cli', { session_id: 'main', cwd: project, transcript_path: path, turn_id: 't', hook_event_name: 'Stop' }));
    service.store.db.exec("UPDATE batches SET uploaded=1,status='accepted',attempts=1");
    const traces = service.store.rows('SELECT * FROM traces ORDER BY id'), batches = service.store.rows('SELECT * FROM batches ORDER BY id');
    await rename(path, join(archive, 'rollout-main.jsonl'));
    await service.captureCodex(true);
    assert.equal(service.store.rows('SELECT captureStatus FROM codex_rounds')[0]!.captureStatus, 'complete');
    await service.captureCodex(true);
    assert.equal(service.store.rows('SELECT captureStatus FROM codex_rounds')[0]!.captureStatus, 'complete');
    for (const table of ['codex_sources', 'codex_source_meta', 'codex_execution_sources', 'codex_event_sources']) {
        assert.equal(service.store.rows(`SELECT * FROM ${table} WHERE ${table === 'codex_sources' ? 'path' : 'sourcePath'}=?`, path).length, 0);
    }
    assert.deepEqual(service.store.rows('SELECT * FROM traces ORDER BY id'), traces);
    assert.deepEqual(service.store.rows('SELECT * FROM batches ORDER BY id'), batches);
});

test('a same-session truncated archive cannot hide the missing original source', async t => {
    const { sources, project, service } = await fixture(t);
    const path = join(sources, 'rollout-main.jsonl'), archive = join(sources, 'rollout-archive.jsonl');
    const first = [meta('main', project), start('t'), message('u', 'user', 'task', 2), message('a', 'assistant', 'answer', 3), end('t', 4)];
    await writeFile(path, jsonl([...first, start('later', 5), message('u2', 'user', 'later task', 6), message('a2', 'assistant', 'later answer', 7), end('later', 8)]));
    await service.event(await normalizeHook('codex-cli', { session_id: 'main', cwd: project, transcript_path: path, turn_id: 'later', hook_event_name: 'Stop' }));
    await rm(path);
    await writeFile(archive, jsonl(first));
    await service.captureCodex(true);
    assert.equal(service.store.rows('SELECT * FROM codex_sources WHERE path=?', path).length, 1);
    assert.ok(service.store.rows('SELECT captureStatus,gaps FROM codex_rounds').every(round => round.captureStatus === 'incomplete' && String(round.gaps).includes('source_unavailable')));
    assert.equal(service.store.rows('SELECT * FROM traces').length, 4);
});

test('an archive must preserve event identity, content, time, and ownership before replacing a missing source', async t => {
    const { sources, project, service } = await fixture(t);
    const path = join(sources, 'rollout-main.jsonl'), archive = join(sources, 'rollout-archive.jsonl');
    const original = [meta('main', project), start('t'), message('u', 'user', 'task', 2), message('a', 'assistant', 'answer', 3), end('t', 4)];
    await writeFile(path, jsonl(original));
    await service.event(await normalizeHook('codex-cli', { session_id: 'main', cwd: project, transcript_path: path, turn_id: 't', hook_event_name: 'Stop' }));
    await rm(path);
    const variants = [
        [meta('main', project), start('t'), message('different-id', 'user', 'task', 2), original[3], original[4]],
        [meta('main', project), start('t'), message('u', 'user', 'changed task', 2), original[3], original[4]],
        [meta('main', project), start('t'), message('u', 'user', 'task', 2, 2), original[3], original[4]],
        [meta('main', project), start('t', 1, 1, { root_turn_id: 'different-root' }), ...original.slice(2)],
    ];
    for (const variant of variants) {
        await writeFile(archive, jsonl(variant));
        await service.captureCodex(true);
        assert.equal(service.store.rows('SELECT * FROM codex_sources WHERE path=?', path).length, 1);
        assert.ok(service.store.rows('SELECT gaps FROM codex_source_meta WHERE sourcePath=?', path).some(source => String(source.gaps).includes('source_unavailable')));
    }
});

async function fixture(t: any) {
    const dir = await mkdtemp(join(tmpdir(), 'pm-codex-capture-'));
    const sources = join(dir, 'sessions'), project = join(dir, 'project');
    await mkdir(sources); await mkdir(project);
    const service = new PluginService(join(dir, 'data'), { codexRoots: [sources] });
    service.store.bindProject('Fixture', project, 'space', service.config.value.baseUrl, 'codex-cli');
    service.store.db.exec("UPDATE capture_windows SET startedAt='2025-01-01T00:00:00.000Z'");
    t.after(async () => { if (service.store.db.isOpen) service.close(); await rm(dir, { recursive: true, force: true }); });
    return { dir, sources, project, service };
}

test('startup reconciles unchanged source metadata without requiring another hook or new trace', async t => {
    const { dir, sources, service } = await fixture(t);
    const path = join(sources, 'rollout-local.jsonl'), cwd = join(dir, 'local');
    service.store.bindProject('Local',cwd,'space',service.config.value.baseUrl,'codex-cli');
    service.store.db.exec("UPDATE capture_windows SET startedAt='2025-01-01T00:00:00.000Z'");
    await writeFile(path, jsonl([meta('local', cwd), start('t'), message('u', 'user', 'task', 2), message('a', 'assistant', 'done', 3), end('t', 4)]));
    await service.event(await normalizeHook('codex-cli', { session_id: 'local', cwd, transcript_path: path, turn_id: 't', hook_event_name: 'Stop' }));
    const session = service.store.rows("SELECT * FROM sessions WHERE nativeSessionId='local'")[0]!;
    service.store.db.prepare('UPDATE sessions SET cwd=? WHERE id=?').run('/wrong', String(session.id));
    service.store.db.prepare('UPDATE tasks SET name=? WHERE id=?').run('wrong', String(session.taskId));
    const reader = service.store.rows('SELECT * FROM codex_sources');
    service.close();
    const restarted = new PluginService(join(dir, 'data'), { codexRoots: [sources] });
    try {
        await restarted.captureCodex(true);
        assert.equal(restarted.store.session(String(session.id))!.cwd, cwd);
        assert.equal(restarted.store.memory.forSession(restarted.store.session(String(session.id))!)?.root, cwd);
        assert.deepEqual(restarted.store.rows('SELECT * FROM codex_sources'), reader);
    } finally { restarted.close(); }
});

for (const change of ['unchanged', 'append', 'replace']) test(`legacy cache directory upgrade preserves source replacement isolation (${change})`, async t => {
    const { sources, project, service } = await fixture(t);
    const path = join(sources, 'rollout-main.jsonl');
    await writeFile(path, jsonl([meta('main', project), start('t'), row('turn_context', { turn_id: 't', cwd: '/tool-directory' }, 2), message('u', 'user', 'task', 3), end('t', 4)]));
    await service.event(await normalizeHook('codex-cli', { session_id: 'main', cwd: project, transcript_path: path, turn_id: 't', hook_event_name: 'Stop' }));
    const cached = service.store.row('SELECT state FROM codex_sources WHERE path=?', path)!;
    const state = JSON.parse(String(cached.state)); state.version = 2; state.parser.snapshot.cwd = '/tool-directory';
    service.store.db.prepare('UPDATE codex_sources SET state=? WHERE path=?').run(JSON.stringify(state), path);
    service.store.db.prepare('UPDATE codex_source_meta SET cwd=? WHERE sourcePath=?').run('/tool-directory', path);
    if (change === 'replace') await writeFile(path, jsonl([meta('main', '/replaced-project'), start('t'), message('u', 'user', 'task', 3), end('t', 4)]));
    if (change === 'append') await appendFile(path, jsonl([start('next', 5), message('u2', 'user', 'next task', 6), end('next', 7)]));
    await service.captureCodex(true);
    const stored = service.store.row('SELECT cwd,gaps FROM codex_source_meta WHERE sourcePath=?', path)!;
    assert.equal(stored.cwd, change === 'replace' ? '/tool-directory' : project);
    assert.equal(String(stored.gaps).includes('source_identity_changed'), change === 'replace');
});

test('project backfill precedes current hook and reread preserves complete rounds and original ordering', async t => {
    const { sources, project, service } = await fixture(t);
    const old = join(sources, 'rollout-old.jsonl'), current = join(sources, 'rollout-new.jsonl');
    await writeFile(old, jsonl([meta('old', project), start('old-turn'), message('ou','user','old task',2), message('oa','assistant','old answer',3), end('old-turn',4)]));
    await writeFile(current, jsonl([meta('new', project, 2), start('new-turn',1,2), message('nu','user','new task',2,2), message('na','assistant','new answer',3,2), end('new-turn',4,2)]));
    const hook = await normalizeHook('codex-cli', { session_id: 'new', turn_id: 'new-turn', cwd: project, transcript_path: current, hook_event_name: 'Stop', last_assistant_message: 'new answer' });
    await service.event(hook);
    await service.event(hook);
    const sessions = service.store.state().sessions;
    assert.deepEqual(sessions.map(s => s.nativeSessionId), ['old', 'new']);
    for (const session of sessions) {
        const detail = service.store.sessionDetail(String(session.id),1,10,'turn');
        assert.equal(detail.total,1);
        assert.equal(detail.groups![0]!.traces.length,2);
        assert.match(String(detail.groups![0]!.traces[0]!.occurredAt), /^2026-01-/);
    }
    assert.equal(service.store.batches().length,2);
});

test('late child source completes its parent round and cannot create another visible session', async t => {
    const { sources, project, service } = await fixture(t);
    const parent = join(sources,'rollout-parent.jsonl');
    await writeFile(parent,jsonl([meta('parent',project),start('root'),message('u','user','delegate',2),
        row('response_item',{type:'function_call',id:'spawn',call_id:'spawn',name:'collaboration.spawn_agent',arguments:'{"task_name":"worker"}'},3),
        row('response_item',{type:'function_call_output',id:'spawn-result',call_id:'spawn',output:'{"agent_id":"child","task_name":"/root/worker"}'},4),
        message('a','assistant','parent answer',8),end('root',9)]));
    await service.event(await normalizeHook('codex-cli',{session_id:'parent',turn_id:'root',cwd:project,transcript_path:parent,hook_event_name:'Stop'}));
    assert.equal(service.store.batches().length,0);
    const child=join(sources,'rollout-child.jsonl');
    await writeFile(child,jsonl([meta('child','/temporary-worktree',1,{parent_thread_id:'parent',agent_path:'/root/worker',source:{subagent:{thread_spawn:{parent_thread_id:'parent'}}},subagent_history_start_ordinal:1}),
        start('child-turn',1,1,{root_turn_id:'root',turn_attribution:{parent_turn_id:'root',root_turn_id:'root'}}),message('cu','user','delegation',5),message('ca','assistant','child result',6),end('child-turn',7)]));
    await service.captureCodex(true);
    const sessions=service.store.state().sessions;
    assert.equal(sessions.length,1);
    assert.equal(sessions[0]!.nativeSessionId,'parent');
    const detail=service.store.sessionDetail(String(sessions[0]!.id),1,10,'turn');
    assert.equal(detail.total,1);
    assert.equal(detail.groups![0]!.traces.length,6);
    assert.equal(service.store.batches().length,1);
    assert.equal(service.store.batches()[0]!.messages.length,6);
    const archive = join(sources, 'archived_sessions');
    await mkdir(archive);
    await rename(parent, join(archive, 'rollout-parent.jsonl'));
    await rename(child, join(archive, 'rollout-child.jsonl'));
    await service.captureCodex(true);
    assert.equal(service.store.rows('SELECT captureStatus FROM codex_rounds')[0]!.captureStatus, 'complete');
    assert.equal(service.store.sessionDetail(String(sessions[0]!.id),1,10,'turn').groups![0]!.traces.length,6);
    assert.equal(service.store.rows('SELECT * FROM codex_sources WHERE path IN (?,?)',parent,child).length,0);
});

test('receipts survive missing files and restart; auxiliary sources never create user tasks', async t => {
    const dir=await mkdtemp(join(tmpdir(),'pm-codex-recover-')),sources=join(dir,'sources'),project=join(dir,'project');
    await mkdir(sources);await mkdir(project);
    const data=join(dir,'data'),path=join(sources,'rollout-delayed.jsonl');
    let service=new PluginService(data,{codexRoots:[sources]});
    t.after(async()=>{service.close();await rm(dir,{recursive:true,force:true});});
    service.store.bindProject('Fixture',project,'space',service.config.value.baseUrl,'codex-cli');
    service.store.db.exec("UPDATE capture_windows SET startedAt='2025-01-01T00:00:00.000Z'");
    await service.event(await normalizeHook('codex-cli',{session_id:'delayed',turn_id:'t',cwd:project,transcript_path:path,hook_event_name:'UserPromptSubmit',prompt:'task'}));
    assert.equal(service.store.state().sessions.length,0);
    service.close();
    await writeFile(path,jsonl([meta('delayed',project),start('t'),message('u','user','task',2)]));
    await writeFile(join(sources,'rollout-background.jsonl'),jsonl([meta('background',project,1,{purpose:'next_user_message'}),start('b'),message('bu','user','suggest',2),end('b',3)]));
    service=new PluginService(data,{codexRoots:[sources]});
    await service.captureCodex(true);
    assert.deepEqual(service.store.state().sessions.map(s=>s.nativeSessionId),['delayed']);
    assert.equal(service.store.batches().length,0);
    await appendFile(path,jsonl([message('a','assistant','answer',3),end('t',4)]));
    await service.captureCodex(true);await service.captureCodex(true);
    assert.equal(service.store.batches().length,1);
    assert.equal(service.store.batches()[0]!.messages.length,2);
});

test('a child working inside another registered project cannot activate that project history', async t => {
    const { sources, project, service, dir } = await fixture(t);
    const other=join(dir,'other-project'); await mkdir(other); service.store.createProject('Other',other);
    const main=join(sources,'rollout-parent.jsonl');
    await writeFile(main,jsonl([meta('parent',project),start('root'),message('u','user','task',2)]));
    await service.event(await normalizeHook('codex-cli',{session_id:'parent',cwd:project,transcript_path:main,turn_id:'root',hook_event_name:'UserPromptSubmit'}));
    await writeFile(join(sources,'rollout-unrelated.jsonl'),jsonl([meta('unrelated',other),start('other'),message('ou','user','unrelated',2),end('other',3)]));
    const child=join(sources,'rollout-child.jsonl');
    await writeFile(child,jsonl([meta('child',other,1,{parent_thread_id:'parent',source:{subagent:{thread_spawn:{parent_thread_id:'parent'}}}}),start('ct',1,1,{root_turn_id:'root',turn_attribution:{root_turn_id:'root',parent_turn_id:'root'}}),message('cu','user','delegation',2)]));
    await service.event(await normalizeHook('codex-cli',{session_id:'child',cwd:other,transcript_path:child,turn_id:'ct',hook_event_name:'UserPromptSubmit'}));
    await service.captureCodex(true);
    assert.deepEqual(service.store.state().sessions.map(s=>s.nativeSessionId),['parent']);
    assert.equal(service.store.rows("SELECT * FROM sessions WHERE nativeSessionId='unrelated'").length,0);
});

test('a known source path replaced with another identity is quarantined without importing unrelated content', async t => {
    const { sources, project, service } = await fixture(t);
    const path=join(sources,'rollout-source.jsonl');
    await writeFile(path,jsonl([meta('main',project),start('t'),message('u','user','task',2)]));
    await service.event(await normalizeHook('codex-cli',{session_id:'main',cwd:project,transcript_path:path,turn_id:'t',hook_event_name:'UserPromptSubmit'}));
    await writeFile(path,jsonl([meta('unrelated','/another-project'),start('unrelated'),message('secret','user','outside scope',2),end('unrelated',3)]));
    await service.captureCodex(true);
    assert.deepEqual(service.store.state().sessions.map(s=>s.nativeSessionId),['main']);
    assert.equal(service.store.rows("SELECT * FROM traces WHERE message LIKE '%outside scope%'").length,0);
    assert.equal(service.store.batches().length,0);
});

test('a prompt hook before the native turn is flushed reserves one stable invisible context', async t => {
    const { sources, project, service }=await fixture(t),path=join(sources,'rollout-main.jsonl');
    await writeFile(path,jsonl([meta('main',project)]));
    const event=await normalizeHook('codex-cli',{session_id:'main',cwd:project,transcript_path:path,turn_id:'t',hook_event_name:'UserPromptSubmit',prompt:'task'});
    const first=await service.event(event), repeated=await service.event(event);
    assert.ok(first.sessionId);assert.ok(first.conversationId);
    assert.equal(repeated.conversationId,first.conversationId);
    assert.equal(service.store.sessionDetail(first.sessionId,1,10,'turn').total,0);
    assert.equal(service.store.validContext(first.sessionId,first.conversationId!),true);
    await appendFile(path,jsonl([start('t'),message('u','user','task',2),message('a','assistant','answer',3),end('t',4)]));
    await service.captureCodex(true);
    const after=service.store.sessionDetail(first.sessionId,1,10,'turn');
    assert.equal(after.total,1);assert.equal(after.groups![0]!.id,first.conversationId);
    assert.equal(after.groups![0]!.traces.length,2);
});

test('one growing source does not rewrite unchanged historical snapshots', async t => {
    const { sources, project, service } = await fixture(t);
    const a = join(sources, 'rollout-a.jsonl'), b = join(sources, 'rollout-b.jsonl');
    await writeFile(a, jsonl([meta('a', project), start('a-turn'), message('au', 'user', 'task a', 2), end('a-turn', 3)]));
    await writeFile(b, jsonl([meta('b', project), start('b-turn'), message('bu', 'user', 'task b', 2), end('b-turn', 3)]));
    await service.event(await normalizeHook('codex-cli', { session_id: 'a', cwd: project, transcript_path: a, turn_id: 'a-turn', hook_event_name: 'Stop' }));
    await service.event(await normalizeHook('codex-cli', { session_id: 'b', cwd: project, transcript_path: b, turn_id: 'b-turn', hook_event_name: 'Stop' }));
    const original = service.store.applyCodexSnapshots.bind(service.store), applied: string[] = [];
    service.store.applyCodexSnapshots = (snapshots, options) => { applied.push(...snapshots.map(snapshot => snapshot.sourcePath)); return original(snapshots, options); };
    await appendFile(a, jsonl([start('a-next', 4), message('au2', 'user', 'next task', 5)]));
    await service.captureCodex(true);
    assert.deepEqual(applied, [a]);
    assert.equal(service.store.rows("SELECT * FROM codex_event_meta WHERE originSessionId='b'").length, 1);
});
