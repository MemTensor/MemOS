import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';

class Element {
  children: Element[] = []; textContent = ''; className = ''; hidden = false; disabled = false;
  open = false; returnValue = ''; focused = false;
  listeners: Record<string, (...args:any[])=>any> = {}; attributes:Record<string,string> = {};
  append(...nodes:Element[]) { this.children.push(...nodes); }
  replaceChildren(...nodes:Element[]) { this.children=nodes;this.textContent=''; }
  addEventListener(name:string,callback:(...args:any[])=>any) { this.listeners[name]=callback; }
  setAttribute(name:string,value:string) { this.attributes[name]=value; }
  showModal() { this.open = true; }
  close(value = this.returnValue) { if (!this.open) return; this.returnValue = value; this.open = false; this.listeners.close?.(); }
  focus() { this.focused = true; }
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
  const context:any={...view,document,window:{location:{hash:''},scrollTo(){},addEventListener(){},confirm(){throw new Error('System confirmation is forbidden');}},setTimeout:(callback:()=>Promise<void>)=>{timers.set(++timer,callback);return timer;},clearTimeout:(id:number)=>timers.delete(id),fetch:(path:string,options:any)=>new Promise((resolve,reject)=>requests.push({path,options,finish:(body,status=200)=>resolve({ok:status===200,status,json:async()=>body}),fail:reject}))};
  runInNewContext(source+`\nglobalThis.app={setState(next){state=next;window.location.hash='#projects';},changeHistory};`,context);
  return {app:context.app,node,requests,view};
}
const flush=()=>new Promise(resolve=>setImmediate(resolve));
const state=(scope:any)=>({bindings:[{...structuredClone(scope),history:{historyUploadConfirmCount:100,...structuredClone(scope.history)}}],projects:[{id:'wrong-project',name:'不应显示'}],sessions:[],tasks:[],batches:[],recalls:[],diagnostics:[]});
const scope={id:'agent/project',agentType:'codex-cli',name:'当前绑定',spaceIds:['space'],history:{status:'ready',pending:1,uploading:false,canUpload:true}};

test('101 independent records confirmed by the user submit once regardless of Space count',async()=>{
  const h=await harness(),current=structuredClone(scope);
  h.app.setState(state(current));const operation=h.app.changeHistory(current,new Element(),false);
  h.requests[0].finish(state({...scope,spaceIds:['A','B'],history:{...scope.history,status:'ready',pending:101}}).bindings);await flush();
  assert.equal(h.node('#history-upload-dialog').open,true);
  assert.match(h.node('#history-upload-count').text,/101/);
  assert.equal(h.node('#history-upload-project').text,scope.name);
  assert.equal(h.node('#history-upload-cancel').focused,true);
  assert.equal(h.requests.length,1);
  h.node('#history-upload-dialog').close('upload');await flush();
  assert.equal(h.requests[1].path,'/api/projects/agent%2Fproject/history');h.requests[1].finish({});await flush();
  h.requests[2].finish(state({...scope,history:{status:'ready',pending:0,recordCount:101,uploading:false}}).bindings);await operation;
  assert.match(h.node('#project-list').text,/已完成/);assert.equal(h.requests.filter(r=>r.options?.method==='POST').length,1);
});
