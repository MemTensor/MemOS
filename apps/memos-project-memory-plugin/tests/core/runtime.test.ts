import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Store } from '../../src/storage/store.ts';
import { LOCAL_API_VERSION, currentRuntimeRevision } from '../../src/runtime/revision.ts';

const run = promisify(execFile);
const client = fileURLToPath(new URL('../../src/adapters/_shared/client.ts', import.meta.url));
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor<T>(read: () => T | undefined, message: string): Promise<T> {
  for (let i = 0; i < 150; i++) { const value = read(); if (value !== undefined) return value; await pause(100); }
  throw new Error(message);
}
async function ensure(directory: string, override?: string, parallel = false) {
  const script = `import {ensureService} from ${JSON.stringify(client)}; console.log(JSON.stringify(await ${parallel ? 'Promise.all([ensureService(),ensureService(),ensureService()])' : 'ensureService()'}));`;
  const result = await run(process.execPath, ['--input-type=module', '-e', script], { env: { ...process.env, MEMOS_PM_DATA_DIR: directory, ...(override ? { MEMOS_PM_URL: override } : { MEMOS_PM_URL: '' }) }, timeout: 20000 });
  return JSON.parse(result.stdout.trim());
}
async function legacy(directory: string, revision?: string, interruptConcurrentHealth = false, healthDelay = 0) {
  const script = join(directory, 'legacy.mjs');
  writeFileSync(script, `
import {createServer} from 'node:http';
import {writeFileSync,unlinkSync,existsSync} from 'node:fs';
const directory=${JSON.stringify(directory)};
let healthRequests=0;
const server=createServer((req,res)=>{res.setHeader('Content-Type','application/json');const respond=()=>res.end(JSON.stringify({ok:true,service:'memos-project-memory-plugin',${revision ? `apiVersion:${LOCAL_API_VERSION},runtimeRevision:${JSON.stringify(revision)},` : ''}pid:process.pid}));${interruptConcurrentHealth ? 'if(++healthRequests===1)setTimeout(respond,200);' : `setTimeout(respond,${healthDelay});`}});
server.listen(0,'127.0.0.1',()=>{const url='http://127.0.0.1:'+server.address().port;writeFileSync(directory+'/service.lock',String(process.pid));writeFileSync(directory+'/service.json',JSON.stringify({url,pid:process.pid}));});
process.on('SIGTERM',()=>{server.close(()=>{for(const file of ['service.lock','service.json'])if(existsSync(directory+'/'+file))unlinkSync(directory+'/'+file);process.exit(0);});${interruptConcurrentHealth ? 'server.closeAllConnections();' : ''}});
`);
  const child = spawn(process.execPath, [script], { stdio: 'ignore' });
  const endpoint = await waitFor(() => existsSync(join(directory, 'service.json')) ? JSON.parse(readFileSync(join(directory, 'service.json'), 'utf8')) as { url: string; pid: number } : undefined, 'legacy did not start');
  return { child, ...endpoint };
}
async function stop(directory: string) {
  const endpoint = join(directory, 'service.json');
  if (!existsSync(endpoint)) return;
  const { pid } = JSON.parse(readFileSync(endpoint, 'utf8'));
  try { process.kill(pid, 'SIGTERM'); } catch { }
  await waitFor(() => !existsSync(endpoint) ? true : undefined, 'service did not exit');
}

test('source hooks and built CLI share one runtime revision and API contract', async () => {
  assert.equal(LOCAL_API_VERSION, 5);
  assert.match(currentRuntimeRevision(), /\S+/);
  const built = new URL('../../dist/runtime/revision.js', import.meta.url);
  if (existsSync(built)) assert.equal((await import(built.href)).currentRuntimeRevision(), currentRuntimeRevision());
});

test('managed legacy service is replaced on the same port, preserving SQLite and concurrent client calls', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'pm-runtime-'));
  t.after(async () => { await stop(directory); rmSync(directory, { recursive: true, force: true }); });
  const store = new Store(join(directory, 'memory.sqlite'));
  const project = store.bindProject('Saved project', '/saved', 'saved-space', 'http://cloud', 'deepseek-harness'); store.close();
  const old = await legacy(directory);
  const [urls, concurrent] = await Promise.all([ensure(directory, undefined, true), ensure(directory)]);
  assert.deepEqual(urls, [old.url, old.url, old.url]); assert.equal(concurrent, old.url);
  const endpoint = JSON.parse(readFileSync(join(directory, 'service.json'), 'utf8'));
  assert.notEqual(endpoint.pid, old.pid);
  const health = await (await fetch(old.url + '/api/health')).json() as any;
  assert.equal(health.apiVersion, LOCAL_API_VERSION); assert.equal(health.runtimeRevision, currentRuntimeRevision());
  assert.equal(await ensure(directory), old.url);
  assert.equal(JSON.parse(readFileSync(join(directory, 'service.json'), 'utf8')).pid, endpoint.pid);
  const restored = new Store(join(directory, 'memory.sqlite'));
  assert.deepEqual(restored.binding(project.scopeId)?.spaceIds, ['saved-space']); restored.close();
});

test('same API with an obsolete build revision is replaced but explicit URL overrides are left alone', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'pm-runtime-revision-'));
  t.after(async () => { await stop(directory); rmSync(directory, { recursive: true, force: true }); });
  const old = await legacy(directory, 'obsolete-build');
  assert.equal(await ensure(directory, old.url), old.url);
  assert.equal(JSON.parse(readFileSync(join(directory, 'service.json'), 'utf8')).pid, old.pid);
  assert.equal(await ensure(directory), old.url);
  assert.notEqual(JSON.parse(readFileSync(join(directory, 'service.json'), 'utf8')).pid, old.pid);
});

test('mismatched managed lock never terminates the endpoint process', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'pm-runtime-owner-'));
  t.after(async () => { await stop(directory); rmSync(directory, { recursive: true, force: true }); });
  const old = await legacy(directory);
  writeFileSync(join(directory, 'service.lock'), String(process.pid));
  await assert.rejects(ensure(directory), /归属|ownership|不一致/);
  assert.doesNotThrow(() => process.kill(old.pid, 0));
});

test('runtime rechecks a repair lock acquired while it creates the service lock', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'pm-runtime-repair-race-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const preload = join(directory, 'race.mjs');
  writeFileSync(preload, `
import fs from 'node:fs';
import {syncBuiltinESMExports} from 'node:module';
const original = fs.writeFileSync;
fs.writeFileSync = function(path, ...args) {
  const result = original.call(this, path, ...args);
  if (String(path).endsWith('/service.lock')) original(${JSON.stringify(join(directory, 'repair.lock'))}, ${JSON.stringify(String(process.pid))});
  return result;
};
syncBuiltinESMExports();
`);
  await assert.rejects(run(process.execPath, ['--import', preload, fileURLToPath(new URL('../../src/runtime/main.ts', import.meta.url))], {
    env: { ...process.env, MEMOS_PM_DATA_DIR: directory, MEMOS_PM_PORT: '0' }, timeout: 5000,
  }), (error: any) => {
    assert.equal(error.code, 1);
    assert.match(error.stderr, /轨迹修复正在进行/);
    return true;
  });
  assert.equal(existsSync(join(directory, 'service.lock')), false);
  assert.equal(existsSync(join(directory, 'memory.sqlite')), false);
  assert.equal(readFileSync(join(directory, 'repair.lock'), 'utf8'), String(process.pid));
});

test('runtime cannot delete a repair lock before its owner finishes writing the PID', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'pm-runtime-repair-owner-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  writeFileSync(join(directory, 'repair.lock'), '');
  await assert.rejects(run(process.execPath, [fileURLToPath(new URL('../../src/runtime/main.ts', import.meta.url))], {
    env: { ...process.env, MEMOS_PM_DATA_DIR: directory }, timeout: 5000,
  }), (error: any) => { assert.equal(error.code,1); assert.match(error.stderr,/修复锁/); return true; });
  assert.equal(existsSync(join(directory,'repair.lock')),true);
  assert.equal(existsSync(join(directory,'memory.sqlite')),false);
});


test('concurrent clients preserve the old port when shutdown interrupts another client health request', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'pm-runtime-health-race-'));
  t.after(async () => { await stop(directory); rmSync(directory, { recursive: true, force: true }); });
  const old = await legacy(directory, undefined, true);
  const urls = await Promise.all([ensure(directory), ensure(directory), ensure(directory)]);
  assert.deepEqual(urls, [old.url, old.url, old.url]);
});


test('a crashed startup owner is recovered with its saved port after endpoint cleanup', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'pm-runtime-crashed-start-'));
  t.after(async () => { await stop(directory); rmSync(directory, { recursive: true, force: true }); });
  const old = await legacy(directory);
  await stop(directory);
  assert.equal(existsSync(join(directory, 'service.json')), false);
  writeFileSync(join(directory, 'service.startup.lock'), JSON.stringify({ pid: old.pid, token: 'dead-owner', url: old.url }));
  const urls = await Promise.all([ensure(directory), ensure(directory)]);
  assert.deepEqual(urls, [old.url, old.url]);
  assert.equal(existsSync(join(directory, 'service.startup.lock')), false);
});

test('a live startup owner is respected and a waiting client does not delete its lock', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'pm-runtime-live-start-'));
  t.after(async () => { await stop(directory); rmSync(directory, { recursive: true, force: true }); });
  const lock = join(directory, 'service.startup.lock');
  const owner = JSON.stringify({ pid: process.pid, token: 'test-owner' });
  writeFileSync(lock, owner);
  const waiting = ensure(directory);
  await pause(250);
  assert.equal(readFileSync(lock, 'utf8'), owner);
  assert.equal(existsSync(join(directory, 'service.json')), false);
  unlinkSync(lock);
  assert.match(await waiting, /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.equal(existsSync(lock), false);
});


test('health checks tolerate a busy capture cycle without replacing a compatible service', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'pm-runtime-busy-health-'));
  t.after(async () => { await stop(directory); rmSync(directory, { recursive: true, force: true }); });
  const old = await legacy(directory, currentRuntimeRevision(), false, 800);
  assert.equal(await ensure(directory, old.url), old.url);
  assert.equal(await ensure(directory), old.url);
  assert.equal(JSON.parse(readFileSync(join(directory, 'service.json'), 'utf8')).pid, old.pid);
});
