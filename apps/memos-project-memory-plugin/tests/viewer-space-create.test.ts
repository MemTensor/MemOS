import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';

class Element {
  children: Element[] = []; value = ''; textContent = ''; hidden = false; disabled = false; required = false; className = ''; open = false; focused = false;
  listeners: Record<string, (...args: any[]) => any> = {}; attributes: Record<string, string> = {}; elements: Record<string, Element> = {};
  classList = { toggle() {} };
  tagName: string;
  constructor(tagName = 'div') { this.tagName = tagName; }
  append(...nodes: Element[]) { this.children.push(...nodes); }
  replaceChildren(...nodes: Element[]) { this.children = nodes; this.textContent = ''; }
  addEventListener(name: string, callback: (...args: any[]) => any) { this.listeners[name] = callback; }
  setAttribute(name: string, value: string) { this.attributes[name] = value; }
  getAttribute(name: string) { return this.attributes[name]; }
  removeAttribute(name: string) { delete this.attributes[name]; }
  querySelector(selector: string) { return selector.includes('submit') ? this.elements.submit : undefined; }
  querySelectorAll() { return Object.values(this.elements); }
  showModal() { this.open = true; }
  close() { this.open = false; this.listeners.close?.({ target: this }); }
  focus() { this.focused = true; }
}
type Request = { path: string; options: any; finish(body: unknown, status?: number): void; fail(error: Error): void };
async function harness() {
  const nodes = new Map<string, Element>(), requests: Request[] = [], alerts: string[] = [];
  const node = (selector: string) => { if (!nodes.has(selector)) nodes.set(selector, new Element()); return nodes.get(selector)!; };
  const form = node('#project-form');
  form.elements = { agentType: new Element('select'), root: new Element('select'), spaceId: new Element('input'), spaceName: new Element('input'), domain: new Element('select'), submit: new Element('button') };
  nodes.set('#project-form select[name="agentType"]', form.elements.agentType);
  nodes.set('#project-form select[name="root"]', form.elements.root);
  nodes.set('#project-form input[name="spaceName"]', form.elements.spaceName);
  nodes.set('#project-form input[name="spaceId"]', form.elements.spaceId);
  nodes.set('#project-form select[name="domain"]', form.elements.domain);
  form.elements.domain.value = '编程';
  const document = { querySelector: node, querySelectorAll: () => [], createElement: (tag: string) => new Element(tag), addEventListener() {} };
  (globalThis as any).document = document;
  // @ts-expect-error viewer is intentionally plain browser JavaScript
  const view = await import('../viewer/view.js');
  const source = (await readFile(new URL('../viewer/app.js', import.meta.url), 'utf8')).replace(/^import .*?;\n/, '').replace(/\nreload\(\)\.catch\([\s\S]*$/, '');
  const context: any = { ...view, document, window: { location: { hash: '' }, scrollTo() {}, addEventListener() {}, alert(message: string) { alerts.push(message); } }, fetch: (path: string, options: any) => new Promise((resolve, reject) => requests.push({
    path, options, finish: (body, status = 200) => resolve({ ok: status < 400, status, json: async () => body }), fail: reject,
  })) };
  runInNewContext(source + `
    let reloadCount = 0;
    reload = async () => { reloadCount++; };
    globalThis.app = { setProjectSpaceMode, get reloadCount() { return reloadCount; },
      select() { window.location.hash='#projects'; adapters=[{agentId:'codex-cli',name:'Codex CLI',installed:true}]; projectOptions=[{name:'First',root:'/first'}]; }
    };`, context);
  context.app.select(); form.elements.agentType.value = 'codex-cli'; form.elements.root.value = '/first';
  const event = (currentTarget: Element) => ({ currentTarget, target: currentTarget, preventDefault() {} });
  const submit = () => form.listeners.submit!(event(form));
  const click = (selector: string) => node(selector).listeners.click!(event(node(selector)));
  return { app: context.app, form, node, requests, alerts, submit, click };
}
const body = (request: Request) => JSON.parse(request.options.body);

test('a known created Space ID survives binding failure and retry uses only existing binding', async () => {
  const h = await harness(); h.app.setProjectSpaceMode('create'); h.form.elements.spaceName.value = '已创建空间'; await h.submit();
  const confirming = h.click('#space-create-confirm');
  h.requests[0]!.finish({ error: '已创建，绑定失败', spaceId: 'created-space' }, 400); await confirming;
  assert.equal(h.form.elements.spaceId.value, 'created-space');
  assert.equal(h.form.elements.spaceId.disabled, false);
  assert.equal(h.form.elements.spaceName.disabled, true);
  assert.equal(h.node('#space-create-dialog').open, false);
  assert.match(h.node('#notice').textContent, /created-space/);
  const retry = h.submit();
  assert.equal(h.requests.length, 2);
  assert.deepEqual(body(h.requests[1]!), { name: 'First', root: '/first', agentType: 'codex-cli', spaceId: 'created-space' });
  h.requests[1]!.finish({ id: 'project', scopeId: 'scope' }); await retry;
  assert.equal(h.app.reloadCount, 1);
});
