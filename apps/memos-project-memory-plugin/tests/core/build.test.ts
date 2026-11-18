import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, cp, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const run = promisify(execFile);
test('failed staging preserves a usable build and successful publication never removes its entrypoint', async t => {
 const root = await mkdtemp(join(tmpdir(), 'pm-build-'));
 t.after(() => rm(root, { recursive:true, force:true }));
 await mkdir(join(root,'scripts')); await mkdir(join(root,'src/runtime'),{recursive:true}); await mkdir(join(root,'dist/runtime'),{recursive:true});
 await cp(fileURLToPath(new URL('../../scripts/build.mjs',import.meta.url)),join(root,'scripts/build.mjs'));
 await symlink(fileURLToPath(new URL('../../node_modules',import.meta.url)),join(root,'node_modules'));
 await writeFile(join(root,'src/runtime/main.ts'),'export const version = 2;');
 await writeFile(join(root,'dist/runtime/main.js'),'export const version = 1;');
 await assert.rejects(run(process.execPath,['scripts/build.mjs'],{cwd:root}));
 assert.equal(await readFile(join(root,'dist/runtime/main.js'),'utf8'),'export const version = 1;');
 await mkdir(join(root,'src/cli')); await writeFile(join(root,'src/cli/index.ts'),'export {};');
 const observed: string[] = [];
 const timer = setInterval(()=>{void readFile(join(root,'dist/runtime/main.js'),'utf8').catch(error=>observed.push(error.code));},1);
 try { await run(process.execPath,['scripts/build.mjs'],{cwd:root}); } finally { clearInterval(timer); }
 assert.deepEqual(observed,[]);
 assert.match(await readFile(join(root,'dist/runtime/main.js'),'utf8'),/version = 2/);
});
