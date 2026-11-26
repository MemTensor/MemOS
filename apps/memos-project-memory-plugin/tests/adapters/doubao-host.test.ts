import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, appendFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DoubaoHost } from '../../src/adapters/doubao-work/host.ts';

import { line, logName, ack, metadata, lifecycle } from '../helpers/doubao-log.ts';

async function setup(t: TestContext) {
  const home = await mkdtemp(join(tmpdir(), 'memos-doubao-metadata-'));
  const dir = join(home,'Library/Application Support/DoubaoWork/sdk_storage/log'); await mkdir(dir,{recursive:true});
  const path = join(dir,logName()),host = new DoubaoHost(home);
  t.after(async () => {host.close();await rm(home,{recursive:true,force:true});});
  return {home,dir,path,host};
}
test('two concurrent conversations resolve their explicitly selected workspace and exact active answer',async t=>{
  const {path,host}=await setup(t);
  await writeFile(path,ack('100','201',1)+ack('101','202',1)+metadata('101','/projects/b','302',101)+metadata('100','/projects/a','301',100)+lifecycle('100','201','301')+lifecycle('101','202','302'));
  await host.refresh(); assert.deepEqual(host.active('100','301'),{sessionId:'100',questionId:'201',answerId:'301',root:'/projects/a',startedAt:100});
  assert.equal(host.active('101','302')?.root,'/projects/b'); assert.equal(host.active('100','302'),undefined);
  await appendFile(path,ack('100','203',6));await host.refresh();assert.equal(host.active('100','301'),undefined);
  await appendFile(path,ack('100','201',1)+metadata('100','/projects/a','303',120)+lifecycle('100','203','303')+lifecycle('100','201','301'));await host.refresh();
  assert.equal(host.active('100','303')?.questionId,'203');assert.equal(host.active('100','301'),undefined);
  await appendFile(path,lifecycle('100','203','303',true)+lifecycle('100','203','303'));await host.refresh();assert.equal(host.active('100','303'),undefined);
  assert.deepEqual(host.completed().map(t=>t.answerId),['303']);assert.ok(host.active('101','302'));
});
test('never commit partial log lines; rotations, replay and restart preserve terminal identity',async t=>{
  const {home,path,dir,host}=await setup(t);
  await writeFile(path,ack('100','201',1)+metadata('100','/projects/explicit','301',100)+lifecycle('100','201','301'));
  const next = join(dir,logName(Date.now(), 1)), end=lifecycle('100','201','301',true);
  await writeFile(next,end.trimEnd());await host.refresh();assert.equal(host.completed().length,0);
  await appendFile(next,'\n'+end);await host.refresh();assert.equal(host.completed().length,1);
  const reopened=new DoubaoHost(home);try {await reopened.refresh();assert.deepEqual(reopened.completed(),host.completed());} finally {reopened.close();}
});
test('conflicting workspace, duplicate ACK index, failed end and missing native evidence fail closed',async t=>{
  const {path,host}=await setup(t);
  await writeFile(path,ack('100','201',1)+metadata('100','/project','301',100)+lifecycle('100','201','301'));
  await host.refresh();assert.ok(host.active('100','301'));
  await appendFile(path,ack('100','202',1));await host.refresh();assert.equal(host.active('100','301'),undefined);
  await appendFile(path,lifecycle('100','201','301',true,{cancel_source:'user'})+metadata('100','/other','301',100)+lifecycle('100','201','301',true));await host.refresh();
  assert.deepEqual(host.completed(),[]);
});

test('an unordered receiving start blocks the preceding invocation until native order is known', async t => {
  const {path,host} = await setup(t);
  await writeFile(path, ack('100','201',1)+metadata('100','/project','301',100)+lifecycle('100','201','301')+lifecycle('100','202','302'));
  await host.refresh();
  assert.equal(host.active('100','301'), undefined);
  await appendFile(path, ack('100','202',3)+metadata('100','/project','302',200));
  await host.refresh();
  assert.equal(host.active('100','302')?.questionId, '202');
  assert.equal(host.active('100','301'), undefined);
});

test('a successful terminal event is immutable and has the timestamp of the first successful receipt', async t => {
  const {path,host} = await setup(t);
  const time = Date.now();
  const first = lifecycle('100','201','301',true,{},time);
  await writeFile(path, first + ack('100','201',1)+metadata('100','/project','301',time-200)+lifecycle('100','201','301')+lifecycle('100','201','301',true,{},time+100));
  await host.refresh();
  assert.equal(host.completed()[0]?.endedAt, time);
  assert.equal(host.active('100','301'), undefined);
  await appendFile(path,lifecycle('100','201','301',true,{session_success:'0'}));
  await host.refresh();
  assert.deepEqual(host.completed(), []);
});

test('watch arms on directory creation and can be closed and restarted', {timeout:5000}, async t => {
  const {home,dir,path,host} = await setup(t);
  await rm(join(home,'Library'), {recursive:true});
  let resolveWake!: () => void;
  let wake = new Promise<void>(resolve => { resolveWake = resolve; });
  let stop = host.watch(() => resolveWake());
  await mkdir(dir, {recursive:true}); await wake;
  stop();
  wake = new Promise<void>(resolve => { resolveWake = resolve; });
  stop = host.watch(() => resolveWake());
  await writeFile(path,line({type:'log',message:'unrelated'})); await wake;
  stop();
});
