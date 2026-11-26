import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { discoverProjects } from '../../src/adapters/projects.ts';
import { doubaoChatCachePath } from '../../src/adapters/doubao-work/capture.ts';
import { cacheWrite, projectKey, projectSnapshot } from '../helpers/doubao-project-cache.ts';

test('discover uses the latest complete native project list including renames and an explicit empty list', async t => {
  const home = await mkdtemp(join(tmpdir(), 'doubao-projects-'));
  t.after(() => rm(home, {recursive: true, force: true}));
  const dir = doubaoChatCachePath(home);
  await mkdir(dir, {recursive:true});
  const discover = () => discoverProjects('doubao-work', {home});
  const save = (file: string, record: unknown, seq: bigint) => writeFile(join(dir, file), cacheWrite(projectKey,record,seq));
  const project = {name:'New title',root:'/work/original-directory'};
  await save('000009.log',projectSnapshot([{...project,name:'Old title'}, {name:'Archived',root:'/archive'}]), 3n);
  await save('000002.log',projectSnapshot([project]), 6n);
  assert.deepEqual(await discover(),[project]);
  await save('000002.log',projectSnapshot([project],true), 7n);
  await assert.rejects(discover);
  await save('000002.log',projectSnapshot([]), 8n);
  assert.deepEqual(await discover(),[]);
  await save('000002.log',undefined, 9n);
  await assert.rejects(discover);
});

test('maps only a matching project reference and a workspace identifying one native project',async t => {
  const home = await mkdtemp(join(tmpdir(),'doubao-projects-'));
  t.after(() => rm(home,{recursive:true,force:true}));
  const dir = doubaoChatCachePath(home);
  await mkdir(dir,{recursive:true});
  const projects = ['/unique','/other','/shared','/shared','/mismatch'].map((root,i)=>({name:String(i),root}));
  const snapshot = projectSnapshot(projects);
  snapshot.data.projects[1].conversations.push({...snapshot.data.projects[1].conversations[0],extra: JSON.stringify({agent_task_param: JSON.stringify({workspace:'/ambiguous'})})});
  snapshot.data.projects[4].conversations[0].project_reference.project_id = '900';
  await writeFile(join(dir,'000001.log'),cacheWrite(projectKey,snapshot));
  assert.deepEqual(await discoverProjects('doubao-work',{home}),[projects[0]]);
});

test('rejects a torn journal or multiple live stores instead of refreshing from a stale list', async t => {
  const home = await mkdtemp(join(tmpdir(), 'doubao-projects-'));
  t.after(() => rm(home, {recursive: true, force: true}));
  const dir = doubaoChatCachePath(home), path = join(dir, '000001.log');
  await mkdir(dir, {recursive: true});
  const discover = () => discoverProjects('doubao-work', {home});
  const record = cacheWrite(projectKey, projectSnapshot([]));
  await writeFile(path, record);
  await appendFile(path, record.subarray(0, 4));
  await assert.rejects(discover);
  await writeFile(path, record);
  const other = Buffer.from(projectKey);
  other[1]++;
  await writeFile(join(dir, '000002.log'), cacheWrite(other, projectSnapshot([])));
  await assert.rejects(discover);
  await writeFile(join(dir, '000002.log'), cacheWrite(other, undefined, 5n));
  assert.deepEqual(await discover(), []);
});
