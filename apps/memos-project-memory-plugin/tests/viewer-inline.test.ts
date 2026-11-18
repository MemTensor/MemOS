import { test } from 'node:test';
import assert from 'node:assert/strict';
class Node {
  tagName: string; children: Node[]=[]; attributes: Record<string,string>={}; textContent=''; className=''; open?: boolean;
  constructor(tag:string){this.tagName=tag;}
  append(...nodes:Node[]){this.children.push(...nodes);}
  setAttribute(key:string,value:string){this.attributes[key]=value;}
  addEventListener(){}
  set innerHTML(_value:string){throw new Error('Unsafe HTML');}
  get text():string{return this.textContent+this.children.map(n=>n.text).join('');}
}
(globalThis as any).document={createElement:(tag:string)=>new Node(tag)};
// @ts-expect-error plain browser module
const view=await import('../viewer/view.js');
const all=(node:Node):Node[]=>[node,...node.children.flatMap(all)];

test('inline turns show complete questions and answers while preserving ordered execution runs',()=>{
 const dangerous='<img onerror=alert(1)>\n'+'完整回答'.repeat(2000);
 const article=view.taskTurnInline({executionStatus:'failed',captureStatus:'incomplete',traces:[
  {message:{role:'user',content:'检查项目'}},
  {message:{role:'assistant',content:[{type:'thinking',thinking:'分析一'},{type:'text',text:'中间答复'},{type:'thinking',thinking:'分析二'},{type:'text',text:dangerous}]}},
 ]},3,'12:00') as Node;
 assert.equal(article.tagName,'article');assert.equal(article.className,'trace-turn');
 assert.match(article.text,/第 3 轮.*执行失败.*采集有缺口/);
 const nodes=all(article),runs=nodes.filter(n=>n.className==='trace-execution');
 assert.equal(runs.length,2);assert.ok(runs.every(n=>n.tagName==='details'&&!n.open));
 assert.ok(nodes.some(n=>n.className==='trace-message user'&&n.text.includes('检查项目')));
 assert.ok(nodes.some(n=>n.className==='trace-message answer'&&n.text.includes(dangerous)));
 assert.ok(article.text.indexOf('分析一')<article.text.indexOf('中间答复'));
 assert.ok(article.text.indexOf('中间答复')<article.text.indexOf('分析二'));
 assert.ok(!nodes.some(n=>n.tagName==='img'));
});

test('inline execution pairs adjacent tool calls and results only within the same source identity',()=>{
 const call=(origin:string)=>({originSessionId:origin,agentPath:'/root/'+origin,message:{role:'assistant',tool_calls:[{id:'same-id',function:{name:'shell',arguments:'pwd'}}]}});
 const result=(origin:string)=>({originSessionId:origin,agentPath:'/root/'+origin,message:{role:'tool',tool_call_id:'same-id',content:'/work',is_error:true}});
 const paired=view.taskTurnInline({traces:[call('one'),result('one')]},1,'') as Node;
 assert.equal(all(paired).filter(n=>n.className.includes('trace-tool-pair')).length,1);
 assert.match(paired.text,/参数.*pwd.*错误结果.*\/work/);
 assert.match(paired.text,/\/root\/one/);
 const distinct=view.taskTurnInline({traces:[call('one'),result('two')]},1,'') as Node;
 assert.equal(all(distinct).filter(n=>n.className.includes('trace-tool-pair')).length,0);
 assert.match(distinct.text,/\/root\/two/);
});

test('scope groups preserve project identity and restrict unassigned sessions to the selected agent',()=>{
 const state={projects:[{id:'p1',name:'same',root:'/one'},{id:'p2',name:'same',root:'/two'},{id:'empty'}],sessions:[
 {id:'a',projectId:'p1',agentType:'codex',sourceStartedAt:'2026-11-18T04:00:00Z'},
 {id:'b',projectId:'p2',agentType:'dsh'},
 {id:'c',projectId:null,agentType:'codex'},
 {id:'d',projectId:null,agentType:'dsh'},
 {id:'child',projectId:'p1',agentType:'codex',sourceKind:'subagent'},
 ]};
 const groups=view.traceScopeGroups(state,'codex');
 assert.deepEqual(groups.map((g:any)=>g.id),['p1',null]);
 assert.deepEqual(groups[1].sessions.map((s:any)=>s.id),['c']);
 assert.equal(view.traceScopeSessions(groups).length,2);
 assert.deepEqual(view.traceScopeSessions(groups,{project:null}).map((s:any)=>s.id),['c']);
 assert.deepEqual(view.traceScopeSessions(groups,{project:'p2'}),[]);
});

test('scope search and source date filtering combine and sort true instants newest first with unknown dates last',()=>{
 const groups=[{id:'p',sessions:[
 {id:'early',title:'修复 A',sourceStartedAt:'2026-11-18T09:00:00+08:00'},
 {id:'late',title:'修复 B',sourceStartedAt:'2026-11-18T04:00:00Z'},
 {id:'unknown',title:'修复 C',sourceStartedAt:null,createdAt:'2026-11-18T12:00:00Z'},
 ]}];
 assert.deepEqual(view.traceScopeSessions(groups).map((s:any)=>s.id),['late','early','unknown']);
 assert.deepEqual(view.traceScopeSessions(groups,{query:'修复',from:'2026-11-18',to:'2026-11-18'}).map((s:any)=>s.id),['late','early']);
 assert.deepEqual(view.traceScopeSessions(groups,{query:'LATE'}).map((s:any)=>s.id),['late']);
});
