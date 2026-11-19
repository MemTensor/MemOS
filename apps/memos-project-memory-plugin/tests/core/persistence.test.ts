import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { PluginService } from '../../src/server/service.ts';

test('failed uploads stop after two sends across restart; new batches continue and processing failure keeps confirmation', async t=>{
 const directory=mkdtempSync(join(tmpdir(),'memos-persist-'));
 let sends=0,fail=true,reads=0;
 const cloud=createServer(async(req,res)=>{
  for await(const chunk of req){void chunk;}
  if(req.url?.endsWith('add/message')){sends++;if(fail){res.writeHead(503);res.end();return;}}
  if(req.url?.endsWith('get/memory'))reads++;
  res.setHeader('Content-Type','application/json');
  res.end(JSON.stringify({code:0,data:req.url?.endsWith('create/space')?{space_id:'fixed'}:req.url?.endsWith('add/message')?{success:true,task_id:'task1',status:'running'}:req.url?.endsWith('get/status')?{status:'failed'}:{topic_detail_list:[{topic_name:'Topic',topic_description:'Full overview'}]}}));
 });cloud.listen(0,'127.0.0.1');await once(cloud,'listening');
 const address=cloud.address();assert.ok(address&&typeof address!=='string');
 let service=new PluginService(directory);
 t.after(async()=>{service.close();rmSync(directory,{recursive:true});await new Promise<void>(r=>cloud.close(()=>r()));});
 service.configure({baseUrl:`http://127.0.0.1:${address.port}`,apiKey:'test'});
 const project=service.store.bindProject('Persistence','/persist','fixed',service.config.value.baseUrl,'test-host');
 const input={agentType:'test-host',nativeSessionId:'native',cwd:'/persist',event:'turn-start' as const,turnKey:'input1'};
 const first=await service.event({...input,records:[{sourceId:'source1',raw:{timestamp:new Date().toISOString(),content:'full original'},message:{role:'user',content:'full original'}}]});
 await service.event({...input,event:'turn-end'});
 await service.sync();assert.equal(sends,2);
 const failed=service.store.batches()[0]!;assert.equal(failed.uploaded,false);assert.equal(failed.status,'failed');
 service.close();service=new PluginService(directory);await service.sync();assert.equal(sends,2);
 assert.equal((service.store.sessionDetail(first.sessionId).traces[0]!.raw as any).content,'full original');
 fail=false;await service.event({...input,turnKey:'input2'});await service.event({...input,turnKey:'input2',event:'turn-end',records:[{sourceId:'source2',raw:{timestamp:new Date().toISOString(),content:'new'},message:{role:'assistant',content:'new'}}]});
 await service.sync();assert.equal(sends,3);
 const accepted=service.store.batches()[1]!;assert.equal(accepted.uploaded,true);assert.equal(accepted.status,'processing-failed');assert.equal(accepted.attempts,1);
 assert.deepEqual(service.store.binding(project.scopeId)?.spaceIds,['fixed']);
 const next=await service.event({...input,nativeSessionId:'native2'});assert.match(next.overview,/Full overview/);assert.equal(reads,2);assert.equal(next.overviewDelivered,false);
 service.store.markContextDelivered(next.sessionId);service.close();service=new PluginService(directory);
 const restored=await service.event({...input,nativeSessionId:'native2',turnKey:'input2'});assert.equal(reads,2);assert.equal(restored.overviewDelivered,true);assert.equal(restored.overview,next.overview);
 service.configure({paused:true});await service.event({...input,turnKey:'input3'});await service.event({...input,turnKey:'input3',event:'turn-end',records:[{sourceId:'source3',raw:{timestamp:new Date().toISOString(),role:'assistant',content:'paused'}}]});await service.sync();assert.equal(sends,3);assert.equal(service.store.batches()[2]!.status,'pending');
 service.configure({paused:false});await service.sync();assert.equal(sends,4);
});
