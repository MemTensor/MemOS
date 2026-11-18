import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {installNative,uninstallNative,isDshInstalled} from '../../src/adapters/_shared/native-install.ts';
import {profile as pi} from '../../src/adapters/pi/profile.ts';
import {profile as v1} from '../../src/adapters/opencode-v1/profile.ts';
import {profile as v2} from '../../src/adapters/opencode-v2/profile.ts';
test('native installer copies full skill, is idempotent, preserves user edits on uninstall',async()=>{
 const home=await mkdtemp(join(tmpdir(),'memos-native-install-'));try{
 const options={home,cwd:home};const first=await installNative(pi,options);assert.equal(first.installed,true);
 assert.ok(first.files.some(path=>path.endsWith('references/cli-contract.md')));
 assert.deepEqual(await installNative(pi,options),first);
 const wrapper=first.files[0]!;assert.match(await readFile(wrapper,'utf8'),/export \{default\}/);
 await writeFile(wrapper,'// user changed\n');await uninstallNative(pi,options);
 assert.equal(await readFile(wrapper,'utf8'),'// user changed\n');
 }finally{await rm(home,{recursive:true,force:true});}
});
test('OpenCode v1/v2 profiles cannot both inject into the same host',async()=>{
 const home=await mkdtemp(join(tmpdir(),'memos-native-version-'));try{
 const options={home,cwd:home};await installNative(v1,options);
 await assert.rejects(installNative(v2,options),/other OpenCode/);
 await uninstallNative(v1,options);assert.equal((await installNative(v2,options)).installed,true);
 }finally{await rm(home,{recursive:true,force:true});}
});

test('DSH persists configuration, repairs missing entries, and preserves unrelated settings',async()=>{
 const {profile}=await import('../../src/adapters/deepseek-harness/profile.ts');
 const {mkdir}=await import('node:fs/promises');
 const home=await mkdtemp(join(tmpdir(),'memos-dsh-'));
 try{
  const dshHome=join(home,'custom-dsh');const options={home,cwd:home,dshHome};
  await mkdir(dshHome,{recursive:true});
  const path=join(dshHome,'cordis.patch.yml');
  const original='# user settings\n- insert:\n    - id: example\n      name: example-plugin\n';
  await writeFile(path,original);
  const first=await installNative(profile,options);
  const configured=await readFile(path,'utf8');
  assert.equal(await isDshInstalled(profile,options),true);
  assert.ok(configured.startsWith(original));
  assert.match(configured,/id: memos-project-memory/);
  assert.ok(configured.includes(JSON.stringify(first.files[0])));
  assert.ok(first.files.includes(join(dshHome,'skills','memos-project-memory','SKILL.md')));
  assert.ok(first.instructions.every(value=>!value.includes('--patch')));
  await installNative(profile,options);assert.equal(await readFile(path,'utf8'),configured);
  await writeFile(path,original);assert.equal(await isDshInstalled(profile,options),false);
  await installNative(profile,options);
  assert.equal(await readFile(path,'utf8'),configured);
  await writeFile(path,configured+'# later user edit\n');
  await uninstallNative(profile,options);
  assert.equal(await readFile(path,'utf8'),original+'# later user edit\n');
  assert.equal(await isDshInstalled(profile,options),false);
 }finally{await rm(home,{recursive:true,force:true});}
});

test('DSH installs into an empty YAML list and migrates the old standalone overlay',async()=>{
 const {profile}=await import('../../src/adapters/deepseek-harness/profile.ts');
 const {mkdir}=await import('node:fs/promises');const {createHash}=await import('node:crypto');
 const home=await mkdtemp(join(tmpdir(),'memos-dsh-migration-'));
 try{
  const options={home,cwd:home};const root=join(home,'.memos-project-memory');
  const overlay=join(root,'deepseek-harness','memos-project-memory.patch.yml');
  const manifest=join(root,'adapters','deepseek-harness.json');
  await mkdir(join(root,'deepseek-harness'),{recursive:true});await mkdir(join(root,'adapters'),{recursive:true});
  await writeFile(overlay,'old overlay');
  await writeFile(manifest,JSON.stringify({installed:true,files:[{path:overlay,hash:createHash('sha256').update('old overlay').digest('hex')}]}));
  await mkdir(join(home,'.dsh'),{recursive:true});
  const config=join(home,'.dsh','cordis.patch.yml');await writeFile(config,'# settings\n[]\n');
  assert.equal(await isDshInstalled(profile,options),false);
  await installNative(profile,options);
  assert.match(await readFile(config,'utf8'),/id: memos-project-memory/);
  assert.doesNotMatch(await readFile(config,'utf8'),/^\[\]$/m);
  await assert.rejects(readFile(overlay),{code:'ENOENT'});
  const record=JSON.parse(await readFile(manifest,'utf8'));
  assert.ok(!record.files.some((file:{path:string})=>file.path===config));
  await uninstallNative(profile,options);
  const remaining=await readFile(config,'utf8');
  assert.match(remaining,/# settings/);assert.match(remaining,/^\[\]$/m);
 }finally{await rm(home,{recursive:true,force:true});}
});

test('DSH public installer respects a custom DSH home and protects edited managed configuration',async()=>{
 const {installAdapter,uninstallAdapter}=await import('../../src/adapters/installer.ts');
 const {profile}=await import('../../src/adapters/deepseek-harness/profile.ts');
 const home=await mkdtemp(join(tmpdir(),'memos-dsh-home-'));
 try{
  const dshHome=join(home,'separate-config');const options={home,cwd:home,dshHome};
  await installAdapter(profile.id,options);
  const path=join(dshHome,'cordis.patch.yml');const text=await readFile(path,'utf8');
  await writeFile(path,text.replace('id: memos-project-memory','id: user-edited'));
  assert.equal(await isDshInstalled(profile,options),false);
  await assert.rejects(uninstallAdapter(profile.id,options),/configuration was edited/);
  assert.match(await readFile(path,'utf8'),/user-edited/);
  await writeFile(path,text);await uninstallAdapter(profile.id,options);
 }finally{await rm(home,{recursive:true,force:true});}
});
