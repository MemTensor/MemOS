import { test } from 'node:test';
import assert from 'node:assert/strict';

// Minimal DOM checks text-only rendering without adding a browser runtime dependency.
class Node {
  tagName: string; children: Node[] = []; attributes: Record<string, string> = {}; textContent = ''; className = ''; hidden = false; open?: boolean;
  listeners: Record<string, (...args: any[]) => any> = {};
  constructor(tag: string) { this.tagName = tag; }
  append(...children: Node[]) { this.children.push(...children); }
  addEventListener(name: string, callback: (...args: any[]) => any) { this.listeners[name] = callback; }
  setAttribute(name: string, value: string) { this.attributes[name] = value; }
  set innerHTML(_value: string) { throw new Error('Unsafe HTML write'); }
  get text(): string { return this.textContent + this.children.map((child) => child.text).join(''); }
}
(globalThis as any).document = { createElement: (tag: string) => new Node(tag), createElementNS: (_namespace: string, tag: string) => new Node(tag) };
// @ts-expect-error viewer is deliberately plain browser JavaScript
const view = await import('../viewer/view.js');
const { details } = view;

test('trace details preserve full malicious-looking content as text', () => {
  const payload = { message: '<img src=x onerror="alert(1)">', tool: 'complete\n'.repeat(15000), nested: { secretLookingText: '<script>test</script>' } };
  const rendered = details('完整轨迹', payload) as Node;
  assert.equal(rendered.tagName, 'details');
  assert.equal(rendered.children[1].textContent, JSON.stringify(payload, null, 2));
  assert.ok(!rendered.children.some((child) => child.tagName === 'img' || child.tagName === 'script'));
});

const all=(node:Node):Node[]=>[node,...node.children.flatMap(all)];

test('inline turns show complete questions and answers while preserving ordered execution runs',()=>{
 const dangerous='<img onerror=alert(1)>\n'+'完整回答'.repeat(2000);
 const article=view.taskTurnInline({executionStatus:'failed',captureStatus:'incomplete',traces:[
  {id:'database-id',raw:{secret:'internal metadata'},message:{role:'user',content:'检查项目'}},
  {message:{role:'system',content:'runtime settings'}},
  {message:{role:'assistant',content:[{type:'reasoning',text:'分析一'},{type:'text',text:'中间答复'},{type:'thinking',thinking:'分析二'},{type:'tool_use',id:'tool',name:'shell',input:{cmd:'pwd'}},{type:'text',text:dangerous}]}},
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
 assert.doesNotMatch(article.text,/internal metadata|database-id|runtime settings/);
 assert.ok(article.text.indexOf('分析二')<article.text.indexOf('tool use'));
 assert.ok(article.text.indexOf('tool use')<article.text.indexOf(dangerous));
});
