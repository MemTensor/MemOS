import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';

class Element {
  children: Element[] = []; textContent = ''; className = ''; hidden = false; disabled = false;
  listeners: Record<string, (...args:any[])=>any> = {}; attributes:Record<string,string> = {};
  append(...nodes:Element[]) { this.children.push(...nodes); }
  replaceChildren(...nodes:Element[]) { this.children=nodes;this.textContent=''; }
  addEventListener(name:string,callback:(...args:any[])=>any) { this.listeners[name]=callback; }
  setAttribute(name:string,value:string) { this.attributes[name]=value; }
  get text():string { return this.textContent+this.children.map(node=>node.text).join(''); }
}
async function harness() {
  const nodes=new Map<string,Element>(),requests:Array<{path:string;options:any;finish(body:unknown,status?:number):void;fail(error:Error):void}>=[],timers=new Map<number,()=>Promise<void>>();
  let timer=0;
  const node=(selector:string)=>{if(!nodes.has(selector))nodes.set(selector,new Element());return nodes.get(selector)!;};
  const document={createElement:()=>new Element(),querySelector:node,querySelectorAll:()=>[],addEventListener(){}};
  (globalThis as any).document=document;
  // @ts-expect-error viewer is intentionally plain browser JavaScript
  const view=await import('../viewer/view.js');
  const source=(await readFile(new URL('../viewer/app.js',import.meta.url),'utf8')).replace(/^import .*?;\n/,'').replace(/\nreload\(\)\.catch\([\s\S]*$/,'');
  const context:any={...view,document,setTimeout:(callback:()=>Promise<void>)=>{timers.set(++timer,callback);return timer;},clearTimeout:(id:number)=>timers.delete(id),fetch:(path:string,options:any)=>new Promise((resolve,reject)=>requests.push({path,options,finish:(body,status=200)=>resolve({ok:status===200,status,json:async()=>body}),fail:reject}))};
  runInNewContext(source+`\nglobalThis.app={setState(next){state=next;page='projects';},renderBindings,pollProjects,changeHistory,reload};`,context);
  return {app:context.app,node,requests,timers};
}
const flush=()=>new Promise(resolve=>setImmediate(resolve));
const state=(scope:any)=>({bindings:[scope],projects:[{id:'wrong-project',name:'不应显示'}],sessions:[],tasks:[],batches:[],recalls:[],diagnostics:[]});
const scope={id:'agent/project',agentType:'codex-cli',name:'当前绑定',spaceIds:['space'],history:{status:'ready',pending:1,uploading:false}};

test('binding table uses Agent scopes and upload targets the encoded scope ID',async()=>{
  const h=await harness(),current=structuredClone(scope);h.app.setState(state(current));h.app.renderBindings();
  assert.match(h.node('#project-list').text,/当前绑定/);assert.doesNotMatch(h.node('#project-list').text,/不应显示/);
  const trigger=new Element(),operation=h.app.changeHistory(current,trigger,false);
  assert.equal(h.requests[0].path,'/api/projects/agent%2Fproject/history');assert.equal(h.requests[0].options.method,'POST');
  assert.equal(trigger.disabled,true);assert.equal(trigger.textContent,'上传中…');
  h.requests[0].finish({ok:true});await flush();
  assert.equal(h.requests[1].path,'/api/bind');h.requests[1].finish(state({...scope,history:{status:'ready',pending:0,uploading:false}}).bindings);await operation;
  const historyButton=h.node('#project-list').children[0].children[1].children[0].children[3].children[0];
  assert.equal(historyButton.disabled,true);assert.equal(h.timers.size,0);
});

test('history retry uses scan endpoint and polling updates only bindings without project rediscovery',async()=>{
  const h=await harness(),current={...scope,history:{status:'failed',pending:0,uploading:false}};h.app.setState(state(current));
  const operation=h.app.changeHistory(current,new Element(),true);
  assert.equal(h.requests[0].path,'/api/projects/agent%2Fproject/history/scan');h.requests[0].finish({ok:true});await flush();
  h.requests[1].finish(state({...scope,history:{status:'scanning',pending:0,uploading:false}}).bindings);await operation;
  assert.equal(h.timers.size,1);assert.match(h.node('#project-list').text,/--/);
  const [id,tick]=[...h.timers.entries()][0];h.timers.delete(id);const polling=tick();
  assert.equal(h.requests[2].path,'/api/bind');h.requests[2].finish(state(scope).bindings);await polling;
  assert.match(h.node('#project-list').text,/上传历史/);assert.equal(h.timers.size,0);
  assert.ok(h.requests.every(request=>request.path!=='/api/projects?agentType=codex-cli'));
});


test('Viewer rejects version 4 without explicit Space creation and accepts version 5',async()=>{
  const h=await harness();
  const rejected=assert.rejects(h.app.reload(),/后台服务版本已过期/);
  h.requests[0].finish({apiVersion:4});await flush();assert.equal(h.requests.length,1);await rejected;
  const refreshed=h.app.reload();h.requests[1].finish({apiVersion:5});await flush();
  assert.deepEqual(h.requests.slice(2).map(request=>request.path),['/api/state','/api/config','/api/adapters/installed']);
  h.requests[2].finish({bindings:[],projects:[],tasks:[],sessions:[],batches:[],recalls:[],diagnostics:[]});
  h.requests[3].finish({});h.requests[4].finish([]);await refreshed;
});


test('a failed history upload remains visible after state refresh and never changes global pause configuration',async()=>{
  const h=await harness(),current=structuredClone(scope);h.app.setState(state(current));
  const operation=h.app.changeHistory(current,new Element(),false);
  h.requests[0].finish({error:'历史会话源身份已变化，请重新扫描'},400);await flush();
  h.requests[1].finish(state(scope).bindings);await operation;
  const cell=h.node('#project-list').children[0].children[1].children[0].children[3];
  assert.equal(cell.children[0].text,'上传历史失败');assert.equal(cell.children[0].disabled,true);
  assert.match(cell.text,/历史会话源身份已变化/);
  assert.match(h.node('#notice').text,/历史会话源身份已变化/);assert.match(h.node('#notice').className,/error/);
  assert.ok(h.requests.every(request=>request.path!=='/api/config'));
});

test('network failure still renders the upload failure when the following state refresh also fails',async()=>{
  const h=await harness(),current=structuredClone(scope);h.app.setState(state(current));
  const operation=h.app.changeHistory(current,new Element(),false);
  h.requests[0].fail(new Error('本地服务连接中断'));await flush();h.requests[1].fail(new Error('状态读取失败'));await operation;
  assert.match(h.node('#project-list').text,/上传历史失败.*本地服务连接中断/);
});

test('successful history POST displays a backend upload blocker instead of a success notification',async()=>{
  const h=await harness(),current=structuredClone(scope);h.app.setState(state(current));
  const operation=h.app.changeHistory(current,new Element(),false);
  h.requests[0].finish({status:'ready'});await flush();
  h.requests[1].finish(state({...scope,history:{...scope.history,uploading:true,uploadError:'上传已暂停，请先恢复上传'}}).bindings);await operation;
  assert.match(h.node('#project-list').text,/上传历史失败.*上传已暂停/);
  assert.match(h.node('#notice').text,/上传已暂停/);assert.doesNotMatch(h.node('#notice').text,/已提交/);
  assert.match(h.node('#notice').className,/error/);
});

test('scan request failure remains a separate retryable scan action',async()=>{
  const h=await harness(),current={...scope,history:{status:'failed',pending:0,error:'旧扫描错误'}};h.app.setState(state(current));
  const operation=h.app.changeHistory(current,new Element(),true);
  h.requests[0].finish({error:'无法读取历史目录'},400);await flush();
  h.requests[1].finish(state(scope).bindings);await operation;
  const control=h.node('#project-list').children[0].children[1].children[0].children[3].children[0];
  assert.equal(control.text,'重试扫描');assert.equal(control.disabled,false);
  assert.doesNotMatch(control.className,/history-upload-failed/);
  assert.match(h.node('#notice').text,/无法读取历史目录/);
});
