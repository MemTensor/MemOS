import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';
// @ts-expect-error viewer modules are plain browser JavaScript
import { t, setText, attr, joinText, dateText, errorText, setLanguage, initTranslations } from '../viewer/i18n.js';

class TextNode {
  nodeType = 3;
  data: string;
  constructor(data: string) { this.data = data; }
  get textContent() { return this.data; }
}
class Element {
  nodeType = 1; childNodes: Array<Element | TextNode> = []; attributes: Record<string, string> = {};
  dataset: Record<string, string> = {}; listeners: Record<string, () => void> = {};
  value = ''; open = false; disabled = false; hidden = false;
  tagName: string;
  constructor(tagName = 'DIV') { this.tagName = tagName; }
  get textContent(): string { return this.childNodes.map(node => node.textContent).join(''); }
  set textContent(value: string) { this.childNodes = [new TextNode(value)]; }
  setAttribute(name: string, value: string) { this.attributes[name] = value; }
  getAttribute(name: string) { return this.attributes[name] ?? null; }
  hasAttribute(name: string) { return name in this.attributes; }
  addEventListener(name: string, callback: () => void) { this.listeners[name] = callback; }
}
function fixture() {
  const root = new Element('HTML'), ch = new Element('BUTTON'), en = new Element('BUTTON');
  ch.dataset.language = 'zh'; en.dataset.language = 'en'; root.childNodes.push(ch, en);
  const store = new Map<string, string>();
  const window = { localStorage: { getItem: (key: string) => store.get(key), setItem: (key: string, value: string) => store.set(key, value) } };
  const document = { documentElement: root, childNodes: [root], querySelectorAll: () => [ch, en] };
  (globalThis as any).window = window;
  setLanguage('zh', document);
  return { document, root, ch, en, store };
}

test('CH/EN translates original markup and accessibility copy, remembers language, and preserves form and dialog state', () => {
  const f = fixture(), label = new Element('LABEL'), input = new Element('INPUT'), dialog = new Element('DIALOG'), option = new Element('OPTION');
  label.textContent = ' 设置 '; input.value = '用户输入'; input.disabled = true; input.setAttribute('placeholder', '留空保留当前 Key');
  dialog.open = true; option.textContent = '编程'; f.root.childNodes.push(label, input, dialog, option);
  initTranslations(f.document); f.en.listeners.click();
  assert.equal(f.root.getAttribute('lang'), 'en'); assert.equal(label.textContent, ' Settings ');
  assert.equal(input.getAttribute('placeholder'), 'Leave blank to keep the current Key');
  assert.equal(input.value, '用户输入'); assert.equal(input.disabled, true); assert.equal(dialog.open, true);
  assert.equal(option.textContent, 'Coding'); assert.equal(option.value, '编程');
  assert.equal(f.en.getAttribute('aria-pressed'), 'true'); assert.equal(f.ch.getAttribute('aria-pressed'), 'false');
  assert.equal(f.store.get('memos-viewer-language'), 'en');
  initTranslations({ childNodes: [], querySelectorAll: () => [] });
  assert.equal(String(t('设置')), 'Settings');
  f.ch.listeners.click(); assert.equal(label.textContent, ' 设置 '); assert.equal(option.textContent, '编程');
});

test('live labels, nested counts, dates, and attributes switch in place without translating data', () => {
  const f = fixture(), status = new Element(), raw = new Element(), title = new Element(), time = new Element();
  f.root.childNodes.push(status, raw, title, time);
  setText(status, t('执行过程 · {0}', joinText([t('{0} 段思考', 2), t('{0} 次工具调用', 1)])));
  setText(raw, '设置'); attr(title, 'aria-label', t('查看 {0} 的 Space 列表', '运行概览'));
  const date = new Date('2026-11-23T01:00:00Z'); setText(time, dateText(date));
  setLanguage('en', f.document);
  assert.equal(status.textContent, 'Execution · Reasoning blocks: 2 · Tool calls: 1');
  assert.equal(raw.textContent, '设置'); assert.equal(title.getAttribute('aria-label'), 'View Spaces for 运行概览');
  assert.equal(time.textContent, date.toLocaleString('en-US', { hour12: false }));
  setLanguage('zh', f.document); assert.match(status.textContent, /执行过程.*2 段思考.*1 次工具调用/);
  assert.equal(time.textContent, date.toLocaleString('zh-CN', { hour12: false }));
});

test('cleared Agent feedback stays cleared and literal replacements do not regain old translations', () => {
  const f = fixture(), notice = new Element(); f.root.childNodes.push(notice);
  setText(notice, t('已解除该 Space 的绑定。')); setText(notice, ''); notice.hidden = true;
  setLanguage('en', f.document); assert.equal(notice.textContent, ''); assert.equal(notice.hidden, true);
  setText(notice, t('设置已保存。')); setText(notice, '用户提供的状态');
  setLanguage('zh', f.document); assert.equal(notice.textContent, '用户提供的状态');
});

test('known local errors translate, including nested cloud errors; unknown responses remain literal', () => {
  fixture(); setLanguage('en', null);
  assert.equal(String(errorText('单个项目绑定空间不能超过20个')), 'A project can have at most 20 bound Spaces.');
  assert.equal(String(errorText('Space 已创建，但绑定失败：MemOS get/space 业务错误 42')), 'Space created, but binding failed: MemOS get/space: API error 42');
  assert.equal(String(errorText('原始服务器回复：设置')), '原始服务器回复：设置');
  assert.equal(String(t('自定义：{0}', '办公')), 'Custom: 办公');
  setLanguage('zh', null);
});

test('disabled browser storage does not prevent switching languages', () => {
  const f = fixture(); Object.defineProperty((globalThis as any).window, 'localStorage', { get() { throw new Error('disabled'); } });
  initTranslations(f.document); setLanguage('en', f.document);
  assert.equal(String(t('设置')), 'Settings'); setLanguage('zh', f.document);
});

test('all static Chinese copy and literal dynamic translation keys have English text and matching placeholders', async () => {
  fixture(); setLanguage('en', null);
  const html = await readFile(new URL('../viewer/index.html', import.meta.url), 'utf8');
  const keys = new Set<string>();
  for (const match of html.matchAll(/>([^<>]+)</g)) if (/[\u3400-\u9fff]/.test(match[1]!)) keys.add(match[1]!.trim());
  for (const match of html.matchAll(/(?:title|placeholder|aria-label|alt)="([^"]+)"/g)) if (/[\u3400-\u9fff]/.test(match[1]!)) keys.add(match[1]!);
  for (const name of ['app.js', 'view.js']) {
    const source = await readFile(new URL('../viewer/' + name, import.meta.url), 'utf8');
    const ast = ts.createSourceFile(name, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node) && node.expression.getText(ast) === 't' && node.arguments[0] && ts.isStringLiteral(node.arguments[0])) keys.add(node.arguments[0].text);
      node.forEachChild(visit);
    }; visit(ast);
  }
  assert.ok(keys.size > 250);
  for (const key of keys) {
    const placeholders = [...key.matchAll(/\{(\d+)\}/g)].map(match => Number(match[1]));
    const args = Array.from({ length: Math.max(-1, ...placeholders) + 1 }, (_, index) => `VALUE_${index}`);
    const result = String(t(key, ...args));
    assert.doesNotMatch(result, /[\u3400-\u9fff]/, key);
    for (const index of placeholders) assert.ok(result.includes(`VALUE_${index}`), key);
  }
  setLanguage('zh', null);
});
