import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PluginService } from '../../src/server/service.ts';
import { createLocalServer } from '../../src/server/http.ts';

async function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'pm-dialog-unbind-'));
  const service = new PluginService(directory, {home:directory,codexRoots:[]});
  let cloudCalls = 0;
  service.cloud.call = async () => { cloudCalls++; throw new Error('unbind must stay local'); };
  const server = createLocalServer(service); server.listen(0,'127.0.0.1'); await once(server,'listening');
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  t.after(async () => {
    await new Promise<void>(resolve=>server.close(()=>resolve())); service.close();
    rmSync(directory,{recursive:true,force:true});
  });
  const post = async (body:unknown) => {
    const response = await fetch(`http://127.0.0.1:${address.port}/api/unbind-project`, {
      method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),
    });
    return {httpStatus:response.status,...await response.json() as any};
  };
  const identity={agentType:'qwen-code',nativeSessionId:'dialog',cwd:'/work/dialog',event:'turn-start',turnKey:'first'};
  const context=(await service.createContext(identity)).createContext;
  const bind=(root:string,agentType:string,spaceId:string,name='')=>service.store.bindProject(root.split('/').at(-1)!,root,spaceId,service.config.value.baseUrl,agentType,name);
  return {service,post,identity,context,bind,cloudCalls:()=>cloudCalls};
}

test('dialog unbind isolates Agents and projects, uses longest matching directory and protects unbound nested roots',async t=>{
  const {service,post,identity,bind,cloudCalls}=await fixture(t);
  const parent=bind('/work',identity.agentType,'same','父项目');
  const child=bind(identity.cwd,identity.agentType,'same','当前项目');
  const otherAgent=bind(identity.cwd,'claude-code','same','另一个 Agent');
  const nested=await service.createContext({...identity,nativeSessionId:'nested',cwd:identity.cwd+'/src'});
  assert.equal((await post({context:nested.createContext,spaceId:'same'})).status,'UNBOUND');
  assert.deepEqual(service.store.spaces(child.scopeId),[]);
  assert.deepEqual(service.store.spaces(parent.scopeId),[{spaceId:'same',name:'父项目'}]);
  assert.deepEqual(service.store.spaces(otherAgent.scopeId),[{spaceId:'same',name:'另一个 Agent'}]);
  bind(identity.cwd,identity.agentType,'same','当前项目');
  service.store.createProject('未绑定子项目',identity.cwd+'/src');
  const unbound=await service.createContext({...identity,nativeSessionId:'unbound',cwd:identity.cwd+'/src/deeper'});
  assert.equal((await post({context:unbound.createContext,spaceId:'same'})).status,'NOT_BOUND');
  assert.deepEqual(service.store.spaces(child.scopeId),[{spaceId:'same',name:'当前项目'}]);
  assert.equal(cloudCalls(),0);
});

test('dialog unbind during a real sync request preserves the received result, never retries and leaves another target active', {timeout:5000}, async t=>{
  for(const outcome of ['success','failure']) {
    const {service,identity,context,bind}=await fixture(t);
    service.configure({apiKey:'test-only'});
    const project=bind(identity.cwd,identity.agentType,'in-flight','正在发送');
    bind(identity.cwd,identity.agentType,'other','其他空间');
    const session=service.store.registerSession(identity);
    service.store.startTurn(session.id,'first');
    const timestamp=new Date(Date.now()+1000).toISOString();
    service.store.capture(session.id,[{sourceId:'business',nativeTurnId:'first',raw:{role:'user',content:'业务正文',timestamp},message:{role:'user',content:'业务正文'}}]);
    service.store.finalizeTurn(session.id,'first');
    service.deliveries.queueLive();
    const otherBefore=service.store.row("SELECT * FROM batch_deliveries WHERE spaceId='other'");
    let entered!:()=>void, release!:()=>void;
    const started=new Promise<void>(resolve=>{entered=resolve;});
    const response=new Promise<void>(resolve=>{release=resolve;});
    const sends:string[]=[];
    service.cloud.call=async<T>(endpoint:string,body:unknown):Promise<T>=>{
      if(endpoint==='get/status')return {status:'completed',memory_views:{project:{open_episode_messages:0,memory_ids:[]}}} as T;
      assert.equal(endpoint,'add/message');
      const id=(body as {space_ids:string[]}).space_ids[0]!; sends.push(id);
      if(id==='in-flight') {
        entered(); await response;
        if(outcome==='failure')throw new Error('response lost');
      }
      return {success:true,task_id:'task-'+id,status:'running'} as T;
    };
    const syncing=service.sync();
    await started;
    try {
      const result=service.unbindDialog({context,spaceId:'in-flight'});
      assert.equal(result.status,'UNBOUND');
      assert.deepEqual(result.data?.spaces,[{spaceId:'other',name:'其他空间'}]);
      assert.deepEqual(service.store.row("SELECT * FROM batch_deliveries WHERE spaceId='other'"),otherBefore);
      assert.equal(service.store.row("SELECT status FROM batch_deliveries WHERE spaceId='in-flight'")?.status,'cancelled');
    } finally {release();}
    await syncing;
    const delivery=service.store.row("SELECT status,taskId,attempts FROM batch_deliveries WHERE spaceId='in-flight'");
    assert.equal(delivery?.status,outcome==='success'?'accepted':'cancelled');
    assert.equal(delivery?.taskId,outcome==='success'?'task-in-flight':null);
    assert.equal(delivery?.attempts,1);
    assert.equal(service.store.row("SELECT status FROM batch_deliveries WHERE spaceId='other'")?.status,'completed');
    await service.sync();
    assert.deepEqual(sends,['in-flight','other']);
    assert.deepEqual(service.store.spaces(project.scopeId),[{spaceId:'other',name:'其他空间'}]);
  }
});
