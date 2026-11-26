import { test } from 'node:test';
import assert from 'node:assert/strict';

// Minimal DOM checks text-only rendering without adding a browser runtime dependency.
class Node {
  tagName: string; children: Node[] = []; attributes: Record<string, string> = {}; textContent = ''; className = ''; hidden = false; open?: boolean;
  listeners: Record<string, (...args: any[]) => any> = {};
  constructor(tag: string) { this.tagName = tag; }
  append(...children: Node[]) { this.children.push(...children); }
  addEventListener(name: string, callback: (...args: any[]) => any) { this.listeners[name] = callback; }
  setAttribute(name: string, value: string) { this.attributes[name] = value; }
  set innerHTML(_value: string) { throw new Error('Unsafe HTML write'); }
  get text(): string { return this.textContent + this.children.map((child) => child.text).join(''); }
}
(globalThis as any).document = { createElement: (tag: string) => new Node(tag), createElementNS: (_namespace: string, tag: string) => new Node(tag) };
// @ts-expect-error viewer is deliberately plain browser JavaScript
const view = await import('../viewer/view.js');
const { taskTraceEntries } = view;

test('trace details preserve full malicious-looking content as text', () => {
  const payload = { message: '<img src=x onerror="alert(1)">', tool: 'complete\n'.repeat(15000), nested: { secretLookingText: '<script>test</script>' } };
  const [rendered] = taskTraceEntries({ message: { role: 'tool', tool_call_id: 'call-1', content: JSON.stringify(payload) } }, '') as Node[];
  assert.ok(rendered);
  assert.equal(rendered.tagName, 'details');
  assert.ok(all(rendered).some(node => node.tagName === 'pre' && node.textContent === JSON.stringify(payload, null, 2)));
  assert.ok(!all(rendered).some((child) => child.tagName === 'img' || child.tagName === 'script'));
});

const all=(node:Node):Node[]=>[node,...node.children.flatMap(all)];

test('the Agent project picker shows the scoped name while the shared group keeps its name', () => {
  const state = {
    projects: [{ id: 'p', name: 'Shared', root: '/work' }],
    bindings: [{ id: 'scope', projectId: 'p', agentType: 'doubao-work', name: 'Renamed', spaceIds: ['space'] }],
    sessions: [
      { id: 'a', projectId: 'p', objectId: 'scope', agentType: 'doubao-work' },
      { id: 'b', projectId: 'p', agentType: 'codex-cli' },
    ],
  };
  assert.equal(view.traceScopeGroups(state, 'doubao-work')[0].name, 'Renamed');
  assert.equal(view.traceScopeGroups(state, 'codex-cli')[0].name, 'Shared');
  assert.equal(view.traceScopeGroups(state)[0].name, 'Shared');
});
