import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rename, rm } from 'node:fs/promises';
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
