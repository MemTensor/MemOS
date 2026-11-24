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
const initial = { bindings: [], projects: [], tasks: [], sessions: [], batches: [], recalls: [], diagnostics: [] };
const projects = [{ name: 'First', root: '/first' }];
async function harness() {
  const nodes = new Map<string, Element>();
  const node = (key: string) => { if (!nodes.has(key)) nodes.set(key, new Element()); return nodes.get(key)!; };
  const form = node('#project-form');
  form.elements = { agentType: new Element('select'), root: new Element('select'), spaceId: new Element('input'), spaceName: new Element('input'), domain: new Element('select'), submit: new Element('button') };
  nodes.set('#project-form select[name="agentType"]', form.elements.agentType);
  nodes.set('#project-form select[name="root"]', form.elements.root);
  const document = { querySelector: node, querySelectorAll: () => [], createElement: (tag: string) => new Element(tag), addEventListener() {} };
  (globalThis as any).document = document;
  // @ts-expect-error viewer uses plain JavaScript
  const view = await import('../viewer/view.js');
  const requests: Array<{ path: string; finish(body: unknown): void }> = [];
  const source = (await readFile(new URL('../viewer/app.js', import.meta.url), 'utf8')).replace(/^import .*?;\n/, '').replace(/\nreload\(\)\.catch\([\s\S]*$/, '');
  const context: any = { ...view, document, window: { location: { hash: '' }, scrollTo() {}, addEventListener() {} }, fetch: (path: string) => new Promise(resolve => requests.push({ path, finish: body => resolve({ ok: true, json: async () => body }) })) };
  runInNewContext(source + `\nglobalThis.app={loadProjectOptions,renderProjects,reload,setState(next){state=next;window.location.hash='#projects';},setAdapters(next){adapters=next;}};`, context);
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
