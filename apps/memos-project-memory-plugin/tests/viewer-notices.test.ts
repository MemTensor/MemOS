import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { LOCAL_API_VERSION } from '../src/runtime/revision.ts';

class Element {
  children: Element[] = []; textContent = ''; hidden = true; disabled = false; className = '';
  listeners: Record<string, (...args: any[]) => any> = {};
  append(...nodes: Element[]) { this.children.push(...nodes); }
  replaceChildren(...nodes: Element[]) { this.children = nodes; this.textContent = ''; }
  addEventListener(name: string, fn: (...args: any[]) => any) { this.listeners[name] = fn; }
  setAttribute() {}
}
const flush = () => new Promise(resolve => setImmediate(resolve));
const scope = { id: 'scope', name: '项目', spaceIds: ['space'], history: { status: 'ready', pending: 1, canUpload: true, uploading: false, historyUploadConfirmCount: 2 } };

async function harness() {
  const nodes = new Map<string, Element>(), handlers: Record<string, () => Promise<void>> = {};
  const node = (selector: string) => {
    if (!nodes.has(selector)) nodes.set(selector, new Element());
    return nodes.get(selector)!;
  };
  const document = { createElement: () => new Element(), querySelector: node, querySelectorAll: () => [], addEventListener() {} };
  (globalThis as any).document = document;
  // @ts-expect-error plain browser module
  const view = await import('../viewer/view.js');
  const window = { location: { hash: '#projects' }, scrollTo() {}, addEventListener(name: string, fn: () => Promise<void>) { handlers[name] = fn; } };
  const requests: Array<{ path: string; finish(body?: unknown, status?: number): void }> = [];
  const context: any = { ...view, document, window, setTimeout: () => 1, clearTimeout() {}, fetch: async (path: string, options: any) => {
    if (options?.method) return new Promise(resolve => requests.push({ path, finish(body = {}, status = 200) {
      resolve({ ok: status === 200, json: async () => body });
    } }));
    return { ok: true, json: async () => path === '/api/health' ? { apiVersion: LOCAL_API_VERSION }
      : path === '/api/bind' ? [structuredClone(scope)] : path === '/api/config' ? { paused: false }
      : path === '/api/state' ? { bindings: [], sessions: [], batches: [], tasks: [], recalls: [], diagnostics: [] } : [] };
  } };
  const source = (await readFile(new URL('../viewer/app.js', import.meta.url), 'utf8')).replace(/^import .*?;\n/, '').replace(/\nreload\(\)\.catch\([\s\S]*$/, '');
  runInNewContext(source + '\nrenderPage=()=>{};globalThis.app={notify,changeHistory,action,toggleUpload,reload};', context);
  return { app: context.app, node, requests, async navigate(page: string) {
    window.location.hash = '#' + page; await handlers.hashchange();
  } };
}

for (const error of [false, true]) test(`navigation clears the global ${error ? 'error' : 'success'} notice and returning does not restore it`, async () => {
  const h = await harness();
  h.app.notify('历史会话扫描已执行。', error);
  await h.app.reload(); assert.equal(h.node('#notice').hidden, false);
  await h.navigate('agents');
  assert.equal(h.node('#notice').hidden, true); assert.equal(h.node('#notice').textContent, '');
  await h.navigate('projects'); assert.equal(h.node('#notice').textContent, '');
});

for (const scan of [true, false]) for (const failed of [false, true]) for (const returnBack of [false, true]) {
  test(`late ${scan ? 'scan' : 'upload'} ${failed ? 'error' : 'success'} cannot overwrite a new notice${returnBack ? ' after returning' : ''}`, async () => {
    const h = await harness(), trigger = new Element();
    const operation = h.app.changeHistory(structuredClone(scope), trigger, scan); await flush();
    assert.equal(h.requests.length, 1);
    await h.navigate('agents'); if (returnBack) await h.navigate('projects');
    h.app.notify('当前页面的新提示');
    h.requests[0]!.finish(failed ? { error: '旧请求失败' } : {}, failed ? 500 : 200); await operation;
    assert.equal(h.node('#notice').textContent, '当前页面的新提示');
    assert.equal(h.node('#notice').className, 'notice'); assert.equal(trigger.disabled, false);
  });
}

test('same-page refresh does not discard a current scan completion notice', async () => {
  const h = await harness();
  const operation = h.app.changeHistory(structuredClone(scope), new Element(), true); await flush();
  await h.app.reload(); h.requests[0]!.finish(); await operation;
  assert.equal(h.node('#notice').textContent, '历史会话扫描已执行。');
});

test('a stale action rejection does not surface on another page', async () => {
  const h = await harness(); let fail!: (error: Error) => void;
  const operation = h.app.action(new Element(), () => new Promise((_resolve, reject) => { fail = reject; }));
  await h.navigate('agents'); fail(new Error('旧操作失败')); await operation;
  assert.equal(h.node('#notice').hidden, true); assert.equal(h.node('#notice').textContent, '');
});

test('pause/resume completion does not notify a page opened during the request', async () => {
  const h = await harness(), operation = h.app.toggleUpload(); await flush();
  await h.navigate('agents'); h.app.notify('当前页面的新提示');
  h.requests[0]!.finish({ paused: true }); await operation;
  assert.equal(h.node('#notice').textContent, '当前页面的新提示');
});
