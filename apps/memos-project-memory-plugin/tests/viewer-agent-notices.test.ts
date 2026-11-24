import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';

class Element {
  children: Element[]=[]; textContent=''; className=''; hidden=true; disabled=false; value=''; id='';
  dataset:Record<string,string>={}; elements:Record<string,Element>={}; attributes:Record<string,string>={};
  listeners:Record<string,(...args:any[])=>any>={}; classList={toggle(){}};
  tagName:string;
  constructor(tagName='div'){this.tagName=tagName;}
  append(...nodes:Element[]){this.children.push(...nodes);}
  replaceChildren(...nodes:Element[]){this.children=nodes;this.textContent='';}
  addEventListener(name:string,fn:(...args:any[])=>any){this.listeners[name]=fn;}
  setAttribute(name:string,value:string){this.attributes[name]=value;}
  querySelector(){return this.elements.submit;}
  focus(){}
  get text():string{return this.textContent+this.children.map(child=>child.text).join('');}
  buttons():Element[]{return this.children.flatMap(child=>[...(child.tagName==='button'?[child]:[]),...child.buttons()]);}
}
const agent={id:'codex-cli',agentId:'codex-cli',name:'Codex CLI',installed:true,limitations:['长篇使用说明不应重复拼进完成提示。']};
const flush=()=>new Promise(resolve=>setImmediate(resolve));
async function harness(){
  const nodes=new Map<string,Element>();
  const node=(selector:string)=>{if(!nodes.has(selector))nodes.set(selector,new Element());return nodes.get(selector)!;};
  const document={createElement:(tag:string)=>new Element(tag),querySelector:node,querySelectorAll:()=>[],addEventListener(){}};
  (globalThis as any).document=document;
  // @ts-expect-error untyped browser module
  const view=await import('../viewer/view.js');
  const listeners:Record<string,()=>unknown>={};
  const window={location:{hash:'#agents'},scrollTo(){},addEventListener(name:string,handler:()=>unknown){listeners[name]=handler;}};
  let pending:{finish(value:unknown,status?:number):void}|undefined;
  const context:any={...view,document,window,fetch:async(path:string)=>{
    if(path==='/api/adapters')return {ok:true,json:async()=>[agent]};
    if(path.endsWith('/repair'))return new Promise(resolve=>{pending={finish:(value,status=200)=>resolve({ok:status<400,status,json:async()=>value})};});
    return {ok:true,json:async()=>path==='/api/health'?{apiVersion:10}:path==='/api/config'?{}:path==='/api/state'?{projects:[],bindings:[],sessions:[],batches:[],tasks:[],recalls:[],diagnostics:[]}:[]};
  }};
  const source=(await readFile(new URL('../viewer/app.js',import.meta.url),'utf8')).replace(/^import .*?;\n/,'').replace(/\nreload\(\)\.catch\([\s\S]*$/,'');
  runInNewContext(source+'\nglobalThis.app={renderAgents,reload,notify};',context);
  await context.app.renderAgents();
  const update=node('#agent-list').buttons().find(button=>button.text==='更新接入配置')!;
  return {node,window,app:context.app,listeners,start:()=>update.listeners.click(),finish:(value:unknown,status=200)=>pending!.finish(value,status)};
}

test('Agent action success stays local, concise, and is cleared after navigating away',async()=>{
  const h=await harness(),pending=h.start();await flush();
  h.finish({instructions:['长篇使用说明不应重复拼进完成提示。','请新建 Agent 会话或重新加载接入配置。如果宿主提示权限确认，请核对 MemOS 接入项并按提示授权。']});await pending;
  assert.match(h.node('#agent-notice').text,/Codex CLI.*已更新/);
  assert.doesNotMatch(h.node('#agent-notice').text,/长篇|权限确认/);
  assert.ok(h.node('#agent-notice').text.length<65);
  assert.equal(h.node('#notice').text,'');
  h.window.location.hash='#overview';await h.listeners.hashchange();
  assert.equal(h.node('#agent-notice').hidden,true);assert.equal(h.node('#agent-notice').text,'');
  h.window.location.hash='#agents';await h.listeners.hashchange();
  assert.equal(h.node('#agent-notice').hidden,true);
});
