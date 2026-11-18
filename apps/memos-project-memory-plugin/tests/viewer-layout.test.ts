import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
test('trajectory redesign preserves the workspace navigation exactly', async () => {
 const html = await readFile(new URL('../viewer/index.html', import.meta.url), 'utf8');
 const sidebar = html.slice(html.indexOf('<aside class="sidebar">'), html.indexOf('</aside>') + 8);
 assert.equal(createHash('sha256').update(sidebar).digest('hex'), '612815147418eb5cae1eee11c1739cd5aadb626d5f49dd149794ff93c643ea3d');
});
test('trajectory page has agent/project/time scope and two reading columns', async () => {
 const html = await readFile(new URL('../viewer/index.html', import.meta.url), 'utf8');
 for (const id of ['trace-project-picker', 'trace-project-search', 'trace-time', 'trace-search', 'trace-project-options']) assert.ok(html.includes(`id="${id}"`), id);
 assert.ok(!html.includes('id="trace-project-list"'));
 const css = await readFile(new URL('../viewer/style.css', import.meta.url), 'utf8');
 assert.match(css, /#sessions \.session-layout/);
});
