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
  const nodes = new Map<string, Element>(), requests: Request[] = [];
  const node = (selector: string) => { if (!nodes.has(selector)) nodes.set(selector, new Element()); return nodes.get(selector)!; };
  const form = node('#project-form');
  form.elements = { agentType: new Element('select'), root: new Element('select'), spaceId: new Element('input'), spaceName: new Element('input'), submit: new Element('button') };
  nodes.set('#project-form select[name="agentType"]', form.elements.agentType);
  nodes.set('#project-form select[name="root"]', form.elements.root);
  nodes.set('#project-form input[name="spaceName"]', form.elements.spaceName);
  nodes.set('#project-form input[name="spaceId"]', form.elements.spaceId);
  const document = { querySelector: node, querySelectorAll: () => [], createElement: (tag: string) => new Element(tag), addEventListener() {} };
  (globalThis as any).document = document;
  // @ts-expect-error viewer is intentionally plain browser JavaScript
  const view = await import('../viewer/view.js');
  const source = (await readFile(new URL('../viewer/app.js', import.meta.url), 'utf8')).replace(/^import .*?;\n/, '').replace(/\nreload\(\)\.catch\([\s\S]*$/, '');
  const context: any = { ...view, document, window: { scrollTo() {} }, fetch: (path: string, options: any) => new Promise((resolve, reject) => requests.push({
    path, options, finish: (body, status = 200) => resolve({ ok: status < 400, status, json: async () => body }), fail: reject,
  })) };
  runInNewContext(source + `
    let reloadCount = 0, reloadError;
    reload = async () => { reloadCount++; if (reloadError) throw new Error(reloadError); };
    globalThis.app = { setProjectSpaceMode, updateProjectSelection, get reloadCount() { return reloadCount; },
      rejectReload(message) { reloadError = message; },
      select() { page='projects'; adapters=[{agentId:'codex-cli',name:'Codex CLI',installed:true}]; projectOptions=[{name:'First',root:'/first'}]; }
    };`, context);
  context.app.select(); form.elements.agentType.value = 'codex-cli'; form.elements.root.value = '/first';
  const event = (currentTarget: Element) => ({ currentTarget, target: currentTarget, preventDefault() {} });
  const submit = () => form.listeners.submit!(event(form));
  const click = (selector: string) => node(selector).listeners.click!(event(node(selector)));
  return { app: context.app, form, node, requests, submit, click };
}
const flush = () => new Promise(resolve => setImmediate(resolve));
const body = (request: Request) => JSON.parse(request.options.body);

test('Space modes require their own nonblank input and a selected project', async () => {
  const h = await harness();
  h.app.setProjectSpaceMode('create');
  assert.equal(h.form.elements.submit.disabled, true);
  h.form.elements.spaceName.value = '   '; h.app.updateProjectSelection();
  assert.equal(h.form.elements.submit.disabled, true);
  h.form.elements.spaceName.value = '开发记忆'; h.app.updateProjectSelection();
  assert.equal(h.form.elements.submit.disabled, false);
  assert.equal(h.form.elements.spaceId.disabled, true);
  h.app.setProjectSpaceMode('bind');
  assert.equal(h.form.elements.spaceName.disabled, true);
  assert.equal(h.form.elements.submit.disabled, true);
  h.form.elements.spaceId.value = 'existing'; h.app.updateProjectSelection();
  assert.equal(h.form.elements.submit.disabled, false);
  h.form.elements.root.value = ''; h.app.updateProjectSelection();
  assert.equal(h.form.elements.submit.disabled, true);
});

test('new Space submission confirms the selected scope and cancellation sends no request', async () => {
  const h = await harness(); h.app.setProjectSpaceMode('create'); h.form.elements.spaceName.value = ' 开发记忆 ';
  await h.submit();
  assert.equal(h.requests.length, 0);
  assert.equal(h.node('#space-create-dialog').open, true);
  assert.equal(h.node('#space-confirm-name').textContent, '开发记忆');
  assert.equal(h.node('#space-confirm-agent').textContent, 'Codex CLI');
  assert.match(h.node('#space-confirm-project').textContent, /First/);
  await h.click('#space-create-cancel');
  assert.equal(h.node('#space-create-dialog').open, false);
  assert.equal(h.requests.length, 0);
  assert.equal(h.form.elements.spaceName.value, ' 开发记忆 ');
  assert.equal(h.form.elements.submit.focused, true);
});

test('confirming creates once, locks the scope during the request and refreshes saved bindings', async () => {
  const h = await harness(); h.app.setProjectSpaceMode('create'); h.form.elements.spaceName.value = ' 开发记忆 ';
  await h.submit();
  const confirming = h.click('#space-create-confirm');
  const duplicate = h.click('#space-create-confirm');
  await flush();
  assert.equal(h.requests.length, 1);
  assert.equal(h.requests[0]!.path, '/api/projects');
  assert.deepEqual(body(h.requests[0]!), { name: 'First', root: '/first', agentType: 'codex-cli', spaceName: '开发记忆' });
  assert.equal(h.form.elements.agentType.disabled, true);
  assert.equal(h.form.elements.root.disabled, true);
  assert.equal(h.form.elements.submit.disabled, true);
  assert.equal(h.node('#space-create-confirm').disabled, true);
  h.requests[0]!.finish({ id: 'project', scopeId: 'scope' }); await Promise.all([confirming, duplicate]);
  assert.equal(h.app.reloadCount, 1);
  assert.equal(h.node('#space-create-dialog').open, false);
  assert.equal(h.form.elements.agentType.disabled, false);
  assert.equal(h.form.elements.root.disabled, false);
  assert.match(h.node('#notice').textContent, /已.*绑定|创建.*成功/);
});

test('creation failure retains the name and does not refresh a nonexistent binding', async () => {
  const h = await harness(); h.app.setProjectSpaceMode('create'); h.form.elements.spaceName.value = '保留名称'; await h.submit();
  const confirming = h.click('#space-create-confirm');
  h.requests[0]!.finish({ error: 'Mock 创建失败' }, 400); await confirming;
  assert.equal(h.form.elements.spaceName.value, '保留名称');
  assert.equal(h.app.reloadCount, 0);
  assert.match(h.node('#notice').textContent, /Mock 创建失败/);
  assert.equal(h.form.elements.agentType.disabled, false);
});

test('committed creation with a failed refresh clears the input and cannot submit creation again', async () => {
  const h = await harness(); h.app.setProjectSpaceMode('create'); h.form.elements.spaceName.value = '已保存空间';
  h.app.rejectReload('无法读取状态'); await h.submit();
  const confirming = h.click('#space-create-confirm');
  h.requests[0]!.finish({ id: 'project', scopeId: 'scope' }); await confirming;
  assert.equal(h.app.reloadCount, 1);
  assert.equal(h.form.elements.spaceName.value, '');
  assert.equal(h.node('#space-create-dialog').open, false);
  assert.equal(h.form.elements.submit.disabled, true);
  assert.equal(h.form.elements.spaceName.focused, true);
  assert.match(h.node('#notice').textContent, /已绑定并保存到本地.*刷新失败.*无法读取状态/);
  await h.submit();
  assert.equal(h.requests.length, 1, 'refresh failure must not issue another creation');
});

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

test('binding an existing Space ID remains immediate and uses no creation parameter', async () => {
  const h = await harness(); h.app.setProjectSpaceMode('bind'); h.form.elements.spaceId.value = ' existing-space ';
  const binding = h.submit();
  assert.equal(h.node('#space-create-dialog').open, false);
  assert.equal(h.requests.length, 1);
  assert.deepEqual(body(h.requests[0]!), { name: 'First', root: '/first', agentType: 'codex-cli', spaceId: 'existing-space' });
  h.requests[0]!.finish({ id: 'project', scopeId: 'scope' }); await binding;
  assert.equal(h.app.reloadCount, 1);
});
