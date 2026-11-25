import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';

class Element {
  placeholder = ''; value = ''; textContent = ''; hidden = false; disabled = false; required = false; checked = false; className = ''; name = '';
  children: Element[] = []; elements: Record<string, Element> = {}; listeners: Record<string, (event?: any) => any> = {}; dataset = {};
  append(...nodes: Element[]) { this.children.push(...nodes); }
  replaceChildren(...nodes: Element[]) { this.children = nodes; }
  addEventListener(type: string, callback: (event?: any) => any) { this.listeners[type] = callback; }
  focus() {}
  setAttribute() {} querySelector() { return this.elements.submit; }
  get text(): string { return this.textContent + this.children.map(node => node.text).join(''); }
}
async function harness() {
  const nodes = new Map<string, Element>();
  const node = (id: string) => { if (!nodes.has(id)) nodes.set(id, new Element()); return nodes.get(id)!; };
  const form = node('#config-form');
  for (const name of ['apiKey', 'userId', 'historyUploadConfirmCount', 'submit']) {
    const field = new Element(); field.name = name; form.elements[name] = field;
  }
  const document = { querySelector: node, querySelectorAll: () => [], createElement: () => new Element(), addEventListener() {} };
  (globalThis as any).document = document;
  // @ts-expect-error Viewer is plain browser JavaScript.
  const view = await import('../viewer/view.js');
  let savedKey = 'abcdefghijkl';
  const requests: { path: string; options: any }[] = [];
  const source = (await readFile(new URL('../viewer/app.js', import.meta.url), 'utf8')).replace(/^import .*?;\n/, '').replace(/\nreload\(\)\.catch\([\s\S]*$/, '');
  const context: any = { ...view, document, window: { location: { hash: '' }, addEventListener() {} }, fetch: async (path: string, options: any) => {
    requests.push({ path, options });
    const body = JSON.parse(options.body);
    if (body.apiKey !== undefined) savedKey = body.apiKey;
    return { ok: true, json: async () => ({ ...body, apiKey: undefined, apiKeyLength: savedKey.length, keyConfigured: !!savedKey }) };
  } };
  runInNewContext(source + `\nreload = async () => {}; globalThis.app = { setConfig(next) { config = next; }, renderSettings };`, context);
  context.app.setConfig({ apiMode: 'algorithm', authMode: 'none', baseUrl: 'https://example.invalid/custom/product', cloudProjectId: 'test1', userId: 'user', uploadMaxBytes: 39000, historyUploadConfirmCount: 100, connectionConfigured: true, keyConfigured: true, apiKeyLength: 12 });
  return { app: context.app, form, requests, clear: node('#clear-api-key') };
}

test('settings mask the saved Key and submit only an explicit replacement or clear', async () => {
  const html = await readFile(new URL('../viewer/index.html', import.meta.url), 'utf8');
  assert.doesNotMatch(html, /name="(?:apiMode|baseUrl|connectionTestSpaceId|authMode|cloudProjectId|uploadMaxBytes)"|id="test-connection"/);
  const h = await harness();
  h.app.renderSettings();
  const field = h.form.elements.apiKey!;
  assert.equal(field.value, '');
  assert.equal(field.placeholder, '*'.repeat(12));
  const save = async () => {
    await h.form.listeners.submit!({ preventDefault() {}, currentTarget: h.form });
    return JSON.parse(h.requests.at(-1)!.options.body);
  };
  assert.deepEqual(await save(), { historyUploadConfirmCount: 100 });
  assert.equal(h.requests[0]!.path, '/api/config');
  field.value = 'new-key';
  assert.deepEqual(await save(), { historyUploadConfirmCount: 100, apiKey: 'new-key', authMode: 'token' });
  assert.equal(field.placeholder, '*'.repeat(7));
  h.clear.listeners.click!();
  assert.equal(field.placeholder, '');
  assert.equal(h.requests.length, 2);
  assert.equal((await save()).apiKey, '');
});
