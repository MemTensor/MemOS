import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';

class Element {
  children: Element[] = []; textContent = ''; className = ''; title = ''; value = ''; max = ''; hidden = false; disabled = false; open = false;
  attributes: Record<string, string> = {}; listeners: Record<string, (...args: any[]) => any> = {}; dataset: Record<string, string> = {};
  elements: Record<string, Element> = {};
  classList = { toggle() {} };
  tagName: string;
  constructor(tagName: string) { this.tagName = tagName; }
  append(...nodes: Element[]) { const wasEmpty = !this.children.length; this.children.push(...nodes); if (this.tagName === 'select' && wasEmpty) this.value = nodes[0]?.value ?? ''; }
  replaceChildren(...nodes: Element[]) { this.children = []; this.textContent = ''; if (this.tagName === 'select') this.value = ''; this.append(...nodes); }
  addEventListener(type: string, callback: (...args: any[]) => any) { this.listeners[type] = callback; }
  setAttribute(name: string, value: string) { this.attributes[name] = value; }
  contains(node: Element): boolean { return this === node || this.children.some(child => child.contains(node)); }
  querySelectorAll(selector: string): Element[] {
    return this.children.flatMap(child => [...(selector.startsWith('.') ? child.className.split(' ').includes(selector.slice(1)) : child.tagName === selector) ? [child] : [], ...child.querySelectorAll(selector)]);
  }
  querySelector(selector: string) { return this.querySelectorAll(selector)[0] ?? null; }
  click() { this.listeners.click?.({ currentTarget: this, target: this }); }
  get text(): string { return this.textContent + this.children.map(node => node.text).join(''); }
}
const agentSelector = '#session-filters select[name="agent"]';
async function harness() {
  const nodes = new Map<string, Element>();
  const node = (selector: string) => {
    if (!nodes.has(selector)) nodes.set(selector, new Element(selector === agentSelector || selector === '#trace-time' ? 'select' : 'div'));
    return nodes.get(selector)!;
  };
  node('#session-filters').elements = { from: new Element('input'), to: new Element('input') };
  const document = { createElement: (tag: string) => new Element(tag), createElementNS: (_ns: string, tag: string) => new Element(tag), querySelector: node, querySelectorAll: () => [], addEventListener() {}, body: new Element('body') };
  (globalThis as any).document = document;
  // @ts-expect-error browser module intentionally has no separate declaration file
  const view = await import('../viewer/view.js');
  const requests: Array<{ path: string; finish(body: unknown): void }> = [];
  const fetch = (path: string) => new Promise(resolve => requests.push({ path, finish: body => resolve({ ok: true, json: async () => body }) }));
  const source = (await readFile(new URL('../viewer/app.js', import.meta.url), 'utf8')).replace(/^import .*?;\n/, '').replace(/\nreload\(\)\.catch\([\s\S]*$/, '');
  const context: any = { ...view, document, fetch, Date, window: { location: { hash: '' }, scrollTo() {}, addEventListener() {} } };
  runInNewContext(source + `\nglobalThis.testApp = {
    setState(next) { state = next; }, setPage(next) { window.location.hash = '#' + next; }, openSession, renderSessions,
    selection() { return {project: selectedProject,session: selectedSession,page: tracePage}; }
  };`, context);
  const state = {
    bindings: [
      { id: 'codex-one', agentType: 'codex-cli', spaceIds: ['A'] },
      { id: 'claude-one', agentType: 'claude-code', spaceIds: ['B'] },
      { id: 'codex-two', agentType: 'codex-cli', spaceIds: ['C'] },
    ],
    projects: [{id:'p1',name:'同名项目',root:'/one'}, {id:'p2',name:'同名项目',root:'/two'}], tasks: [], batches: [], recalls: [], diagnostics: [],
    sessions: [
      {id:'new',objectId:'codex-one',projectId:'p1',agentType:'codex-cli',title:'较晚任务',sourceStartedAt:'2026-11-18T12:00:00Z',cwd:'/one',turnCount:1},
      {id:'old',objectId:'claude-one',projectId:'p1',agentType:'claude-code',title:'较早任务',sourceStartedAt:'2026-11-18T09:00:00Z',cwd:'/one',turnCount:1},
      {id:'other',objectId:'codex-two',projectId:'p2',agentType:'codex-cli',title:'另一个项目任务',sourceStartedAt:'2026-11-18T10:00:00Z',cwd:'/two',turnCount:1},
    ],
  };
  context.testApp.setState(state); context.testApp.setPage('sessions'); context.testApp.renderSessions(false);
  const changeAgent = (value: string) => { node(agentSelector).value=value; node(agentSelector).listeners.change(); };
  const chooseProject = (root: string) => { const button=node('#trace-project-options').children.find(option=>option.text.includes(root)); assert.ok(button, `project option ${root}`); button.click(); };
  return { app: context.testApp, node, requests, state, changeAgent, chooseProject };
}

test('Agent then project selection isolates equal names, scopes options and restores each Agent project', async () => {
  const h=await harness();
  assert.equal(h.app.selection().project,undefined);
  assert.match(h.node('#session-list').text,/较晚任务.*另一个项目任务.*较早任务/);
  h.changeAgent('codex-cli');
  assert.match(h.node('#trace-project-options').text,/\/one.*\/two/);
  assert.ok(!h.node('#session-list').text.includes('较早任务'));
  h.chooseProject('/two');
  assert.equal(h.app.selection().project,'p2');
  assert.match(h.node('#session-list').text,/另一个项目任务/);
  assert.ok(!h.node('#session-list').text.includes('较晚任务'));
  h.changeAgent('claude-code');
  assert.ok(!h.node('#trace-project-options').text.includes('/two'));
  h.chooseProject('/one');
  h.changeAgent('codex-cli');
  assert.equal(h.app.selection().project,'p2');
  assert.equal(h.app.selection().session,'other');
  assert.equal(h.app.selection().page,1);
});
