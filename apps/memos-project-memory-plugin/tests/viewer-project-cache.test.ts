import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';

class Element {
  children: Element[] = []; value = ''; textContent = ''; hidden = false; disabled = false; className = '';
  listeners: Record<string, (...args: any[]) => any> = {}; elements: Record<string, Element> = {};
  classList = { toggle() {} };
  tagName: string;
  constructor(tagName = 'div') { this.tagName = tagName; }
  append(...nodes: Element[]) { this.children.push(...nodes); }
  replaceChildren(...nodes: Element[]) { this.children = nodes; this.value = ''; this.textContent = ''; }
  addEventListener(name: string, callback: (...args: any[]) => any) { this.listeners[name] = callback; }
  setAttribute() {}
  querySelector() { return this.elements.submit; }
}
const flush = () => new Promise(resolve => setImmediate(resolve));
const initial = { bindings: [], projects: [], tasks: [], sessions: [], batches: [], recalls: [], diagnostics: [] };
const projects = [{ name: 'First', root: '/first' }];
async function harness() {
  const nodes = new Map<string, Element>();
  const node = (key: string) => { if (!nodes.has(key)) nodes.set(key, new Element()); return nodes.get(key)!; };
  const form = node('#project-form');
  form.elements = { agentType: new Element('select'), root: new Element('select'), spaceId: new Element('input'), spaceName: new Element('input'), submit: new Element('button') };
  nodes.set('#project-form select[name="agentType"]', form.elements.agentType);
  nodes.set('#project-form select[name="root"]', form.elements.root);
  const document = { querySelector: node, querySelectorAll: () => [], createElement: (tag: string) => new Element(tag), addEventListener() {} };
  (globalThis as any).document = document;
  // @ts-expect-error viewer uses plain JavaScript
  const view = await import('../viewer/view.js');
  const requests: Array<{ path: string; finish(body: unknown): void }> = [];
  const source = (await readFile(new URL('../viewer/app.js', import.meta.url), 'utf8')).replace(/^import .*?;\n/, '').replace(/\nreload\(\)\.catch\([\s\S]*$/, '');
  const context: any = { ...view, document, window: { scrollTo() {} }, fetch: (path: string) => new Promise(resolve => requests.push({ path, finish: body => resolve({ ok: true, json: async () => body }) })) };
  runInNewContext(source + `\nglobalThis.app={loadProjectOptions,renderProjects,reload,setState(next){state=next;page='projects';},setAdapters(next){adapters=next;}};`, context);
  context.app.setState(structuredClone(initial)); context.app.setAdapters([{ agentId: 'codex-cli', name: 'Codex', installed: true }]);
  return { app: context.app, node, form, requests };
}

test('switching Agents restores each cached list and project without clearing it or requesting again', async () => {
  const h = await harness(); h.form.elements.agentType.value = 'codex-cli';
  const first = h.app.loadProjectOptions(); h.requests[0].finish(projects); await first;
  h.form.elements.root.value = '/first'; h.form.elements.spaceId.value = 'typed-space';
  const sameOptions = h.form.elements.root.children;
  await h.app.renderProjects();
  assert.equal(h.requests.length, 1); assert.equal(h.form.elements.root.value, '/first');
  assert.equal(h.form.elements.spaceId.value, 'typed-space'); assert.equal(h.form.elements.root.children, sameOptions);
  h.form.elements.agentType.value = 'pi'; const second = h.app.loadProjectOptions();
  h.requests[1].finish([{ name: 'Other', root: '/other' }]); await second; h.form.elements.root.value = '/other';
  h.form.elements.agentType.value = 'codex-cli'; await h.app.loadProjectOptions();
  assert.equal(h.requests.length, 2); assert.equal(h.form.elements.root.value, '/first');
});

test('explicit refresh retains usable options and selection while fetching new projects', async () => {
  const h = await harness(); h.form.elements.agentType.value = 'codex-cli';
  const first = h.app.loadProjectOptions(); h.requests[0].finish(projects); await first;
  h.form.elements.root.value = '/first'; h.form.elements.spaceId.value = 'typed-space';
  const options = h.form.elements.root.children, refresh = h.app.loadProjectOptions(true);
  assert.equal(h.requests[1].path, '/api/projects?agentType=codex-cli&refresh=1');
  assert.equal(h.form.elements.root.children, options); assert.equal(h.form.elements.root.disabled, false);
  assert.equal(h.form.elements.root.value, '/first'); assert.equal(h.form.elements.spaceId.value, 'typed-space');
  h.requests[1].finish([...projects, { name: 'New', root: '/new' }]); await refresh;
  assert.equal(h.form.elements.root.value, '/first'); assert.equal(h.form.elements.root.children.length, 3);
});

test('project page offers only configured Agents and updates bindings without rediscovery', async () => {
  const h = await harness();
  h.app.setAdapters([{ agentId: 'codex-cli', name: 'Codex', installed: true }, { agentId: 'pi', name: 'Pi', installed: false }]);
  h.form.elements.agentType.value = 'codex-cli';
  const first = h.app.renderProjects(); h.requests[0].finish(projects); await first;
  assert.deepEqual(h.form.elements.agentType.children.map(n => n.value), ['', 'codex-cli']);
  h.form.elements.root.value = '/first';
  h.app.setState({ ...initial, bindings: [{ id: 'scope', name: 'First', root: '/first', agentType: 'codex-cli', spaceIds: ['A'] }] });
  await h.app.renderProjects();
  assert.equal(h.requests.length, 1); assert.match(h.form.elements.root.children[1].textContent, /已绑定/);
});

test('project page reload reads configured Agent metadata instead of probing all host versions', async () => {
  const h = await harness(), loading = h.app.reload(); h.requests[0].finish({ apiVersion: 5 }); await flush();
  assert.deepEqual(h.requests.slice(1).map(r => r.path), ['/api/bind', '/api/config', '/api/adapters/installed']);
  h.requests[1].finish([]); h.requests[2].finish({}); h.requests[3].finish([]); await loading;
});

test('late discovery fills its own Agent cache without replacing the currently selected Agent', async () => {
  const h = await harness(); h.form.elements.agentType.value = 'codex-cli';
  const first = h.app.loadProjectOptions();
  h.form.elements.agentType.value = 'pi'; const second = h.app.loadProjectOptions();
  h.requests[1].finish([{ name: 'Pi', root: '/pi' }]); await second;
  h.form.elements.root.value = '/pi';
  h.requests[0].finish(projects); await first;
  assert.equal(h.form.elements.root.value, '/pi');
  h.form.elements.agentType.value = 'codex-cli'; await h.app.loadProjectOptions();
  assert.equal(h.requests.length, 2); assert.match(h.form.elements.root.children[1].textContent, /First/);
});
