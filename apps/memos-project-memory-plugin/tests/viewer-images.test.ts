import { test } from 'node:test';
import assert from 'node:assert/strict';
class Node {
  tagName: string; children: Node[] = []; textContent = ''; className = '';
  constructor(tag: string) { this.tagName = tag; }
  append(...nodes: Node[]) { this.children.push(...nodes); }
  setAttribute() {}
  addEventListener() {}
  set innerHTML(_value: string) { throw new Error('Unsafe HTML'); }
  get text(): string { return this.textContent + this.children.map(node => node.text).join(''); }
}
(globalThis as any).document = { createElement: (tag: string) => new Node(tag) };
// @ts-expect-error plain browser module
const view = await import('../viewer/view.js');

test('viewer shows image references as text without dumping image payloads', () => {
  const entries = view.taskTraceEntries({ message: { role: 'user', content: [
    { type: 'text', text: 'inspect' },
    { type: 'input_text', text: '<image name=[Image #1] path="/fixture.png">' },
    { type: 'input_image', image_url: 'data:image/png;base64,SECRET' },
    { type: 'input_text', text: '</image>' },
    { type: 'local_image', path: '/second.png' },
  ] } }, '') as Node[];
  const content = entries[0].children.at(-1)!.text;
  assert.equal(content, 'inspect\n<image name=[Image #1] path="/fixture.png">\n<image name=[Image #2] path="/second.png">');
  assert.ok(!entries[0].text.includes('SECRET'));
});

test('viewer sanitizes structured and JSON-encoded tool image results but preserves literal user prose', () => {
  const json = JSON.stringify({ content: [{ type: 'image', mimeType: 'image/png', data: 'SECRET' }, { type: 'text', text: 'ok' }] });
  const tool = view.taskTraceEntries({ message: { role: 'tool', content: json } }, '') as Node[];
  assert.ok(!tool[0].text.includes('SECRET'));
  assert.ok(tool[0].text.includes('[image]'));
  assert.ok(tool[0].text.includes('ok'));
  const prose = 'Example: data:image/png;base64,SECRET <image name=example>';
  const user = view.taskTraceEntries({ message: { role: 'user', content: prose } }, '') as Node[];
  assert.ok(user[0].text.includes(prose));
});
