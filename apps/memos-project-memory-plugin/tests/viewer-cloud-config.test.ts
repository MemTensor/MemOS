import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';

class Element {
  value = ''; textContent = ''; hidden = false; disabled = false; required = false; checked = false; className = ''; name = '';
  children: Element[] = []; elements: Record<string, Element> = {}; listeners: Record<string, (event?: any) => any> = {}; dataset = {};
  append(...nodes: Element[]) { this.children.push(...nodes); }
  replaceChildren(...nodes: Element[]) { this.children = nodes; }
  addEventListener(type: string, callback: (event?: any) => any) { this.listeners[type] = callback; }
  setAttribute() {} querySelector() { return this.elements.submit; }
  get text(): string { return this.textContent + this.children.map(node => node.text).join(''); }
}
async function harness() {
  const nodes = new Map<string, Element>();
  const node = (id: string) => { if (!nodes.has(id)) nodes.set(id, new Element()); return nodes.get(id)!; };
  const form = node('#config-form');
  for (const name of ['apiMode', 'authMode', 'baseUrl', 'cloudProjectId', 'apiKey', 'clearApiKey', 'userId', 'uploadMaxBytes', 'historyUploadConfirmCount', 'connectionTestSpaceId', 'submit']) {
    const field = new Element(); field.name = name; form.elements[name] = field;
  }
  const document = { querySelector: node, querySelectorAll: () => [], createElement: () => new Element(), addEventListener() {} };
  (globalThis as any).document = document;
  // @ts-expect-error Viewer is plain browser JavaScript.
  const view = await import('../viewer/view.js');
  const requests: { path: string; options: any }[] = [];
  const source = (await readFile(new URL('../viewer/app.js', import.meta.url), 'utf8')).replace(/^import .*?;\n/, '').replace(/\nreload\(\)\.catch\([\s\S]*$/, '');
  const context: any = { ...view, document, window: { location: { hash: '' }, addEventListener() {} }, fetch: async (path: string, options: any) => {
    requests.push({ path, options });
    return { ok: true, json: async () => path === '/api/connection-test' ? { ok: true, reachable: true, verified: true, message: 'fixture verified' } : {} };
  } };
  runInNewContext(source + `\nreload = async () => {}; globalThis.app = { setConfig(next) { config = next; }, setBatches(batches) { state.batches = batches; }, setBindings(bindings) { state.bindings = bindings; }, renderSettings, renderOverview };`, context);
  context.app.setConfig({ apiMode: 'algorithm', authMode: 'none', baseUrl: 'https://example.invalid/custom/product', cloudProjectId: 'test1', userId: 'user', uploadMaxBytes: 39000, historyUploadConfirmCount: 100, connectionConfigured: true, keyConfigured: true });
  return { app: context.app, node, form, requests };
}

test('settings display the real editable base URL, protocol and cloud project without exposing a saved Key', async () => {
  const h = await harness(); h.app.renderSettings();
  assert.equal(h.form.elements.baseUrl!.value, 'https://example.invalid/custom/product');
  assert.equal(h.form.elements.apiMode!.value, 'algorithm');
  assert.equal(h.form.elements.cloudProjectId!.value, 'test1');
  assert.equal(h.form.elements.apiKey!.value, '');
  assert.equal(h.form.elements.apiKey!.disabled, true);
  assert.match(h.node('#key-status').textContent, /无需 Key/);
  h.form.elements.apiMode!.value = 'engineering';
  h.form.listeners.change!({ target: h.form.elements.apiMode });
  assert.equal(h.form.elements.authMode!.value, 'token');
  assert.equal(h.form.elements.baseUrl!.value, 'https://example.invalid/custom/product');
  assert.equal(h.node('#cloud-project-field').hidden, true);
  assert.equal(h.form.elements.apiKey!.disabled, false);
});

test('saving sends all connection fields and preserves a blank Key unless explicitly cleared', async () => {
  const h = await harness(); h.app.renderSettings();
  await h.form.listeners.submit!({ preventDefault() {}, currentTarget: h.form });
  let body = JSON.parse(h.requests[0]!.options.body);
  assert.equal(h.requests[0]!.path, '/api/config');
  assert.equal(h.requests[0]!.options.method, 'PUT');
  assert.equal(body.apiMode, 'algorithm'); assert.equal(body.authMode, 'none'); assert.equal(body.cloudProjectId, 'test1');
  assert.equal('apiKey' in body, false);
  h.form.elements.clearApiKey!.checked = true;
  await h.form.listeners.submit!({ preventDefault() {}, currentTarget: h.form });
  body = JSON.parse(h.requests[1]!.options.body); assert.equal(body.apiKey, '');
});

test('connection test uses only an optional Space ID and the saved configuration, never a creation request', async () => {
  const h = await harness(); h.app.renderSettings();
  h.form.elements.connectionTestSpaceId!.value = 'existing-space';
  h.form.elements.baseUrl!.value = 'https://unsaved.invalid/product';
  await h.node('#test-connection').listeners.click!({ currentTarget: h.node('#test-connection') });
  assert.equal(h.requests.length, 1); assert.equal(h.requests[0]!.path, '/api/connection-test');
  assert.deepEqual(JSON.parse(h.requests[0]!.options.body), { spaceId: 'existing-space' });
  assert.match(h.node('#connection-test-result').textContent, /fixture verified/);
});

test('accumulating messages have a distinct translated processing label', async () => {
  // @ts-expect-error Viewer is plain browser JavaScript.
  const view = await import('../viewer/view.js');
  assert.equal(String(view.statusLabel('accumulating')), '消息积累中');
});

test('missing cloud completion evidence is shown as unconfirmed rather than accumulating', async () => {
  const h = await harness();
  // @ts-expect-error Viewer is plain browser JavaScript.
  const view = await import('../viewer/view.js');
  assert.equal(String(view.statusLabel('unknown')), '整理状态待确认');
  h.app.setBatches([{ status: 'accepted', processingStatus: 'unknown', uploaded: true }]);
  h.app.renderOverview();
  assert.match(h.node('#upload-status').textContent, /整理状态待确认/);
  assert.doesNotMatch(h.node('#upload-status').textContent, /消息积累中/);
  h.app.setBatches([{ status: 'accepted', processingStatus: 'unknown', uploaded: true }, { status: 'accepted', processingStatus: 'accumulating', uploaded: true }]);
  h.app.renderOverview();
  assert.match(h.node('#upload-status').textContent, /消息积累中.*整理状态待确认/);
});

test('overview counts only active bindings for the selected connection while preserving old bindings', async () => {
  const h = await harness();
  const retained = [{ id: 'mock-one', spaceIds: ['old-one'], active: false }, { id: 'mock-two', spaceIds: ['old-two'], active: false }];
  h.app.setBindings(retained); h.app.renderOverview();
  assert.equal(h.node('#metrics').children[0]!.children[1]!.textContent, '0');
  h.app.setBindings([...retained, { id: 'cloud', spaceIds: ['current'], active: true }]); h.app.renderOverview();
  assert.equal(h.node('#metrics').children[0]!.children[1]!.textContent, '1');
  assert.equal(retained.length, 2);
});

test('cloud diagnostics show the actual request method, URL and protocol while retaining old record fallback', async () => {
  await harness();
  // @ts-expect-error Viewer is plain browser JavaScript.
  const view = await import('../viewer/view.js');
  const actual = view.cloudDiagnosticDetail({ endpoint: 'get/status', method: 'GET', url: 'https://example.invalid/product/scheduler/status?task_id=task1', apiMode: 'algorithm', kind: 'network', message: 'fixture error' }) as Element;
  assert.match(actual.text, /GET https:\/\/example.invalid\/product\/scheduler\/status\?task_id=task1/);
  assert.match(actual.text, /算法接口/);
  const legacy = view.cloudDiagnosticDetail({ endpoint: 'get/status', method: 'POST', kind: 'network', message: 'fixture error' }) as Element;
  assert.match(legacy.text, /POST get\/status/);
});
