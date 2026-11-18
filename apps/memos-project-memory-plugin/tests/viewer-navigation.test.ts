import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';

class Element {
  children: Element[] = []; textContent = ''; className = ''; title = ''; value = ''; hidden = false; disabled = false; open = false;
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
const flush = () => new Promise(resolve => setImmediate(resolve));
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
  const context: any = { ...view, document, fetch, window: { scrollTo() {} } };
  runInNewContext(source + `\nglobalThis.testApp = {
    setState(next) { state = next; }, setPage(next) { page = next; }, openSession, renderSessions,
    selection() { return {project: selectedProject,session: selectedSession,page: tracePage}; }
  };`, context);
  const state = {
    projects: [{id:'p1',name:'同名项目',root:'/one'}, {id:'p2',name:'同名项目',root:'/two'}], tasks: [], batches: [], recalls: [], diagnostics: [],
    sessions: [
      {id:'new',projectId:'p1',agentType:'codex-cli',title:'较晚任务',sourceStartedAt:'2026-11-18T12:00:00Z',cwd:'/one',turnCount:1},
      {id:'old',projectId:'p1',agentType:'claude-code',title:'较早任务',sourceStartedAt:'2026-11-18T09:00:00Z',cwd:'/one',turnCount:1},
      {id:'other',projectId:'p2',agentType:'codex-cli',title:'另一个项目任务',sourceStartedAt:'2026-11-18T10:00:00Z',cwd:'/two',turnCount:1},
    ],
  };
  context.testApp.setState(state); context.testApp.setPage('sessions'); context.testApp.renderSessions(false);
  const changeAgent = (value: string) => { node(agentSelector).value=value; node(agentSelector).listeners.change(); };
  const chooseProject = (root: string) => { const button=node('#trace-project-options').children.find(option=>option.text.includes(root)); assert.ok(button, `project option ${root}`); button.click(); };
  const search = (query: string) => { node('#trace-search').value=query; node('#trace-search').listeners.input(); };
  return { app: context.testApp, node, requests, state, changeAgent, chooseProject, search };
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

test('a slow session response cannot overwrite a different project selected while loading', async () => {
  const h=await harness();
  const pending=h.app.openSession('old');
  assert.equal(h.requests.length,1);
  h.chooseProject('/two');
  assert.equal(h.requests.length,2);
  h.requests[1].finish({session:h.state.sessions[2],groups:[],total:0}); await flush();
  const expected=h.node('#session-detail').text;
  assert.match(expected,/另一个项目任务/);
  h.requests[0].finish({session:h.state.sessions[1],groups:[{traces:[{message:{role:'user',content:'过期项目回复'}}]}],total:1});
  await pending;
  assert.equal(h.node('#session-detail').text,expected);
  assert.equal(h.app.selection().project,'p2');
  assert.equal(h.app.selection().session,'other');
});

test('same-session page requests reject stale results and retain a whole long round inline', async () => {
  const h=await harness();
  const first=h.app.openSession('old',1),second=h.app.openSession('old',2);
  const round={id:'round-11',roundNumber:11,startedAt:'2026-11-18T09:01:00Z',traces:Array.from({length:250},(_,i)=>({occurredAt:'2026-11-18T09:01:00Z',message:{role:i?'assistant':'user',content:i?'详细执行':'第十一轮输入'}}))};
  h.requests[1].finish({session:h.state.sessions[1],groups:[round],total:11,page:2,size:10}); await second;
  h.requests[0].finish({session:h.state.sessions[1],groups:[{id:'wrong',traces:[{message:{role:'user',content:'过期第一页'}}]}],total:11,page:1,size:10}); await first;
  assert.match(h.node('#session-detail').text,/第 11 轮/);
  assert.ok(!h.node('#session-detail').text.includes('过期第一页'));
  assert.equal(h.node('#session-detail').querySelectorAll('.trace-turn').length,1);
  assert.equal(h.node('#session-detail').querySelectorAll('.trace-message').length,250);
  const pager=h.node('#session-detail').querySelector('.pagination')!;
  assert.match(pager.text,/第 2 \/ 2 页 · 11 轮/);
  assert.equal(pager.children[2].disabled,true);
});

test('overview direct links set the target Agent and project and clear stale search/date scope', async () => {
  const h=await harness();
  h.changeAgent('claude-code'); h.search('不存在');
  h.node('#session-filters').elements.from.value='2001-01-01'; h.node('#session-filters').elements.to.value='2001-01-02';
  h.node('#trace-date-apply').click();
  h.app.setPage('overview');
  const pending=h.app.openSession('new');
  const request=h.requests.at(-1)!;
  assert.match(request.path,/\/api\/sessions\/new\?/);
  assert.equal(h.node(agentSelector).value,'codex-cli');
  assert.equal(h.node('#trace-search').value,'');
  assert.equal(h.node('#trace-time').value,'all');
  assert.equal(h.app.selection().project,'p1');
  request.finish({session:h.state.sessions[0],groups:[],total:0}); await pending;
  assert.equal(h.app.selection().session,'new');
  assert.match(h.node('#trace-breadcrumb').text,/codex-cli.*同名项目/);
  assert.match(h.node('#session-detail').text,/较晚任务/);
});

test('search with no matches clears detail and invalidates an in-flight request', async () => {
  const h=await harness(),pending=h.app.openSession('new');
  h.search('不存在');
  assert.equal(h.app.selection().session,null);
  assert.match(h.node('#session-list').text,/没有匹配的会话/);
  const emptyText=h.node('#session-detail').text;
  assert.match(emptyText,/此范围暂无符合条件的会话/);
  h.requests[0].finish({session:h.state.sessions[0],groups:[],total:0}); await pending;
  assert.equal(h.node('#session-detail').text,emptyText);
  const reset=h.node('#session-detail').children.find(n=>n.tagName==='button')!;
  reset.click();
  assert.equal(h.node('#trace-search').value,'');
  assert.equal(h.app.selection().session,'new');
});

test('switching away from sessions prevents a pending detail from rendering', async () => {
  const h=await harness(),pending=h.app.openSession('new');
  h.app.setPage('overview');
  h.requests[0].finish({session:h.state.sessions[0],groups:[],total:0}); await pending;
  assert.ok(!h.node('#session-detail').text.includes('较晚任务'));
});

test('discovered local projects can be selected before Space binding and appear in the breadcrumb', async () => {
  const h = await harness();
  const session = { id: 'local', projectId: null, agentType: 'codex-cli', title: '本地任务', cwd: '/work/项目记忆', turnCount: 1 };
  h.app.setState({ projects: [], tasks: [], sessions: [session], batches: [], recalls: [], diagnostics: [] });
  h.app.renderSessions(false);
  h.changeAgent('codex-cli');
  h.chooseProject('/work/项目记忆');
  assert.match(h.node('#trace-project-label').text, /项目记忆/);
  assert.equal(h.node('#trace-project-label').title, '/work/项目记忆');
  h.requests.at(-1)!.finish({ session, groups: [], total: 0 }); await flush();
  assert.equal(h.app.selection().session, 'local');
  assert.match(h.node('#trace-breadcrumb').text, /codex-cli.*项目记忆/);
  assert.ok(!h.node('#trace-breadcrumb').text.includes('未归属项目'));
});

test('native session titles remain authoritative over user text and follow host renames', async () => {
  const h = await harness();
  const session = { ...h.state.sessions[0], title: 'Greeting', agentType: 'deepseek-harness' };
  h.app.setState({ ...h.state, sessions: [session] }); h.app.renderSessions(false);
  const first = h.app.openSession(session.id);
  h.requests.at(-1)!.finish({ session: { ...session }, groups: [{ traces: [{ message: { role: 'user', content: '你好' } }] }], total: 1 }); await first;
  assert.equal(h.node('#session-detail').querySelector('h2')!.text, 'Greeting');
  assert.match(h.node('#session-list').text, /Greeting/);
  assert.ok(!h.node('#session-list').text.includes('你好'));
  const renamed = h.app.openSession(session.id);
  h.requests.at(-1)!.finish({ session: { ...session, title: 'Welcome back' }, groups: [], total: 1 }); await renamed;
  assert.equal(h.node('#session-detail').querySelector('h2')!.text, 'Welcome back');
  assert.match(h.node('#session-list').text, /Welcome back/);
  assert.ok(!h.node('#session-list').text.includes('Greeting'));
  h.search('Greeting'); assert.match(h.node('#session-list').text, /没有匹配/);
  h.search('Welcome back'); assert.match(h.node('#session-list').text, /Welcome back/);
});

test('missing native title uses short identity and never restores cached title or first user text', async () => {
  const h = await harness();
  const session = { ...h.state.sessions[0], nativeSessionId: 'session-31427b39-4cce-47ad-b6f1-0b7304deb9fc', title: 'outdated title' };
  h.app.setState({ ...h.state, sessions: [session] }); h.app.renderSessions(false);
  const pending = h.app.openSession(session.id);
  h.requests.at(-1)!.finish({ session: { ...session, title: null }, groups: [{ traces: [{ message: { role: 'user', content: '你好' } }] }], total: 1 }); await pending;
  assert.equal(h.node('#session-detail').querySelector('h2')!.text, '未命名会话 · 31427b39');
  assert.match(h.node('#session-list').text, /未命名会话 · 31427b39/);
  assert.ok(!h.node('#session-list').text.includes('你好'));
  assert.ok(!h.node('#session-list').text.includes('outdated title'));
  h.search('你好'); assert.match(h.node('#session-list').text, /没有匹配/);
});
