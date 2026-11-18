import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,appendFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {PluginService} from '../../src/server/service.ts';
const rows=(items:object[])=>items.map((row,i)=>JSON.stringify({timestamp:`2026-01-01T00:00:0${i}Z`,...row})).join('\n')+'\n';
async function fixture(t:any){
 const dir=await mkdtemp(join(tmpdir(),'pm-empty-codex-')),sources=join(dir,'sessions'),cwd=join(dir,'project');await mkdir(sources);await mkdir(cwd);
 const service=new PluginService(join(dir,'data'),{codexRoots:[sources]});t.after(async()=>{service.close();await rm(dir,{recursive:true,force:true});});
 const path=join(sources,'rollout.jsonl');await writeFile(path,rows([{type:'session_meta',payload:{id:'empty',cwd,source:'vscode'}}]));
 return {service,path,cwd};
}
const activity=[{type:'event_msg',payload:{type:'task_started',turn_id:'t'}},{type:'response_item',payload:{type:'message',id:'u',role:'user',content:'real task'}}];

test('metadata-only session leaves no SQLite rows and later activity is captured without another hook',async t=>{
 const {service,path,cwd}=await fixture(t);
 await service.event({agentType:'codex-cli',nativeSessionId:'empty',cwd,event:'session-start',raw:{transcript_path:path}});
 for(const table of ['sessions','tasks','traces','turns','batches','codex_source_meta','codex_sources','codex_receipts'])assert.equal(service.store.rows(`SELECT * FROM ${table}`).length,0,table);
 assert.equal(service.store.state().sessions.length,0);
 await appendFile(path,rows(activity));await service.captureCodex(true);
 assert.equal(service.store.state().sessions.length,1);
 assert.equal(service.store.rows('SELECT * FROM traces').length,1);
 assert.equal(service.store.state().sessions[0]!.turnCount,1);
});

test('empty source discovered within a registered project is not persisted',async t=>{
 const {service,cwd}=await fixture(t);
 const project=service.store.createProject('project',cwd);service.store.db.prepare('INSERT INTO project_agents VALUES(?,?)').run(project.id,'codex-cli');
 await service.captureCodex(true);await service.captureCodex(true);
 for(const table of ['sessions','tasks','codex_source_meta','codex_sources'])assert.equal(service.store.rows(`SELECT * FROM ${table}`).length,0,table);
 assert.equal(service.store.state().projects[0]!.sessionCount,0);
});

test('a previously nonempty source becoming header-only is not treated as an unused empty session',async t=>{
 const {service,path,cwd}=await fixture(t);await appendFile(path,rows(activity));
 await service.event({agentType:'codex-cli',nativeSessionId:'empty',cwd,event:'trace-available',raw:{transcript_path:path}});
 const session=service.store.state().sessions[0]!;
 await writeFile(path,rows([{type:'session_meta',payload:{id:'empty',cwd,source:'vscode'}}]));
 await service.captureCodex(true);
 assert.equal(service.store.state().sessions[0]!.id,session.id);
 assert.equal(service.store.rows('SELECT * FROM traces').length,1);
 assert.ok(service.store.rows('SELECT captureStatus FROM codex_rounds').every(r=>r.captureStatus==='incomplete'));
});
