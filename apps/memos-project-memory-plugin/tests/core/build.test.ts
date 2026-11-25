import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, readdir, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
const script = fileURLToPath(new URL('../../scripts/build.mjs', import.meta.url));
async function fixture(t: { after: (callback: () => Promise<void>) => void }) {
  const root = await mkdtemp(join(tmpdir(), 'pm-build-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'src/cli'), { recursive: true });
  await mkdir(join(root, 'src/runtime'), { recursive: true });
  await writeFile(join(root, 'src/cli/index.ts'), '#!/usr/bin/env node\nexport const cli: string = "current";\n');
  await writeFile(join(root, 'src/runtime/main.ts'), 'export const runtime: string = "current";\n');
  return root;
}

test('build removes deleted source outputs without following directory symlinks', async t => {
  const root = await fixture(t);
  await mkdir(join(root, 'src/legacy'), { recursive: true });
  await writeFile(join(root, 'src/legacy/runner.ts'), 'export const legacy = true;\n');
  await run(process.execPath, [script], { cwd: root });
  assert.match(await readFile(join(root, 'dist/legacy/runner.js'), 'utf8'), /legacy/);
  await rm(join(root, 'src/legacy'), { recursive: true });
  await writeFile(join(root, 'dist/keep.txt'), 'unrelated data');
  await mkdir(join(root, 'outside'));
  await writeFile(join(root, 'outside/external.js'), 'must survive');
  await symlink(join(root, 'outside'), join(root, 'dist/linked'), 'dir');
  await run(process.execPath, [script], { cwd: root });
  await assert.rejects(readFile(join(root, 'dist/legacy/runner.js')), { code: 'ENOENT' });
  assert.equal(await readFile(join(root, 'outside/external.js'), 'utf8'), 'must survive');
  assert.equal(await readFile(join(root, 'dist/keep.txt'), 'utf8'), 'unrelated data');
  assert.match(await readFile(join(root, 'dist/runtime/main.js'), 'utf8'), /current/);
  assert.ok(!(await readdir(root)).some(name => name.startsWith('.dist-build-')));
});

test('failed transpilation preserves previous runtime and stale outputs', async t => {
  const root = await fixture(t);
  await run(process.execPath, [script], { cwd: root });
  const previous = await readFile(join(root, 'dist/runtime/main.js'), 'utf8');
  await writeFile(join(root, 'dist/legacy.js'), 'previous output');
  await writeFile(join(root, 'src/runtime/main.ts'), 'export const runtime = ;\n');
  await assert.rejects(run(process.execPath, [script], { cwd: root }));
  assert.equal(await readFile(join(root, 'dist/runtime/main.js'), 'utf8'), previous);
  assert.equal(await readFile(join(root, 'dist/legacy.js'), 'utf8'), 'previous output');
  assert.ok(!(await readdir(root)).some(name => name.startsWith('.dist-build-')));
});
