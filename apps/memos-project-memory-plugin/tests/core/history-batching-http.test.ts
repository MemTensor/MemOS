import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {PluginService} from '../../src/server/service.ts';
import {createMockServer,getMockState} from '../../dev/memos-mock/server.ts';

test('historical sessions are materialized oldest first, one capacity batch at a time, with durable receipts',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'pm-history-batches-')),sources=join(dir,'sources');await mkdir(sources);
 const row=(type:string,payload:object,time:string)=>JSON.stringify({type,payload,timestamp:time})+'\n';
 for(const [file,id,date] of [['rollout-a-new.jsonl','new','2021-01-01'],['rollout-z-old.jsonl','old','2020-01-01']]) {
  let body=row('session_meta',{id,cwd:'/project',source:'cli'},date+'T00:00:00Z')+row('event_msg',{type:'task_started',turn_id:'turn-'+id},date+'T00:00:01Z');
  body+=row('response_item',{type:'message',id:'user-'+id,role:'user',content:id+'甲'.repeat(100)},date+'T00:00:02Z');
  if(id==='old')body+=row('response_item',{type:'message',id:'huge',role:'assistant',content:'大'.repeat(1000)},date+'T00:00:03Z');
  body+=row('response_item',{type:'message',id:'answer-'+id,role:'assistant',content:id+'乙'.repeat(100),phase:'final_answer'},date+'T00:00:04Z')+row('event_msg',{type:'task_complete',turn_id:'turn-'+id},date+'T00:00:05Z');
  await writeFile(join(sources,file),body);
 }
 const mock=createMockServer({spaces:[{space_id:'A',space_name:'A',domains:[{domain:'编程'}]},{space_id:'B',space_name:'B',domains:[{domain:'编程'}]}]});
 mock.listen(0,'127.0.0.1');await once(mock,'listening');const address=mock.address();assert.ok(address&&typeof address!=='string');
 const data=join(dir,'data');let service=new PluginService(data,{home:dir,codexRoots:[sources]});
 t.after(async()=>{service.close();await new Promise<void>(resolve=>mock.close(()=>resolve()));await rm(dir,{recursive:true,force:true});});
 service.configure({baseUrl:`http://127.0.0.1:${address.port}/api/openmem/v1`,apiKey:'mock-key',uploadMaxBytes:800});
 const project=await service.bindProject({root:'/project',agentType:'codex-cli',spaceId:'A'});await service.history.scan(project.scopeId);
 assert.equal(service.history.catalog(project.scopeId).length,5,JSON.stringify(service.history.status(project.scopeId)));
 assert.equal(service.store.rows('SELECT id FROM traces').length,0);
 const calls=service.cloud.call.bind(service.cloud);let running=true;const imported:string[][]=[];
 service.cloud.call=async(path,body)=>{
  if(path==='get/status'&&running)return {status:'running'} as any;
  if(path==='add/message')imported.push(service.store.rows('SELECT nativeSessionId FROM sessions ORDER BY nativeSessionId').map(row=>String(row.nativeSessionId)));
  return calls(path,body);
 };
 await service.uploadHistory(project.scopeId);
 const uploads=()=>[...getMockState(mock).uploads.values()].flat().map(row=>row.body);
 assert.equal(uploads().length,1);assert.deepEqual(imported,[['old']]);
 assert.equal(service.bindingState().find(row=>row.id===project.scopeId)!.history.uploading,true);
 service.store.bind(project.scopeId,'B',service.config.value.baseUrl);
 service.configure({paused:true});await service.sync();assert.equal(uploads().length,1);
 service.configure({paused:false});running=false;await service.sync();
 assert.equal(uploads().length,4);assert.ok(uploads().every(body=>Buffer.byteLength(JSON.stringify(body))<=800));
 assert.deepEqual(uploads().map(body=>(body.messages as any[])[0].content.slice(0,3)),['old','old','new','new']);
 assert.deepEqual(imported,[['old'],['old'],['new','old'],['new','old']]);
 assert.ok(uploads().every(body=>body.space_ids[0]==='A'));
 assert.equal(service.store.rows('SELECT id FROM traces').length,5);
 assert.equal(service.deliveries.historyError(project.scopeId),undefined);
 assert.equal(service.bindingState().find(row=>row.id===project.scopeId)!.history.uploading,false);
 await service.uploadHistory(project.scopeId);assert.equal(uploads().length,8);
 assert.equal(service.deliveries.historyPending(project.scopeId,service.history.catalog(project.scopeId)),0);
 const frozen=service.store.rows("SELECT id,messages,attempts,status FROM batches WHERE uploaded=1 ORDER BY id");
 service.close();service=new PluginService(data,{home:dir,codexRoots:[sources]});
 await service.history.scan(project.scopeId);await service.uploadHistory(project.scopeId);
 assert.equal(uploads().length,8);assert.deepEqual(service.store.rows("SELECT id,messages,attempts,status FROM batches WHERE uploaded=1 ORDER BY id"),frozen);
});
