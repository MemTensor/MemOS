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
