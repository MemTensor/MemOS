import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
const exec=promisify(execFile), root=await mkdtemp(join(tmpdir(),'memos-package-'));
let pid;
try {
 const packed=await exec('npm',['pack','--pack-destination',root,'--json']);
 const archive=JSON.parse(packed.stdout.slice(packed.stdout.indexOf('[')))[0].filename;
 const clean=join(root,'clean');await mkdir(clean);
 await exec('npm',['install','--prefix',clean,'--ignore-scripts','--no-audit','--no-fund',join(root,archive)]);
 const pkg=join(clean,'node_modules','memos-project-memory-plugin');
 const metadata=JSON.parse(await readFile(join(pkg,'package.json'),'utf8'));
 assert.equal(metadata.license,'Apache-2.0');
 assert.match(await readFile(join(pkg,'LICENSE'),'utf8'),/Apache License/);
 const readme=await readFile(join(pkg,'README.md'),'utf8');
 for(const match of readme.matchAll(/\]\(([^)]+)\)/g)){
  const target=match[1].split('#')[0];
  if(target&&!/^[a-z]+:/i.test(target))await readFile(join(pkg,target));
 }

 process.env.MEMOS_PM_DATA_DIR=join(root,'data');process.env.CODEX_HOME=join(root,'codex-home');delete process.env.MEMOS_PM_URL;
 const {ensureService}=await import(pathToFileURL(join(pkg,'dist/adapters/_shared/client.js')));
 const url=await ensureService();pid=JSON.parse(await readFile(join(root,'data/service.json'),'utf8')).pid;
 for(const asset of ['/','/app.js','/view.js','/i18n.js','/style.css'])assert.equal((await fetch(url+asset)).status,200);
 const cli = join(clean, 'node_modules', '.bin', 'memos-pm');
 await assert.rejects(exec(cli, ['search', '--query', 'package check']), error => {
   assert.equal(error.code, 1);
   assert.equal(JSON.parse(error.stdout).status, 'CONTEXT_MISSING');
   return true;
 });
 const {installAdapter,uninstallAdapter}=await import(pathToFileURL(join(pkg,'dist/adapters/installer.js')));
 const home=join(root,'home');await mkdir(home);await installAdapter('claude-code',{home,cwd:root});
 const settings=JSON.parse(await readFile(join(home,'.claude/settings.json'),'utf8'));
 assert.ok(JSON.stringify(settings).includes('dist/adapters/claude-code/index.js'));assert.ok(!JSON.stringify(settings).includes('/src/'));
 await uninstallAdapter('claude-code',{home,cwd:root});
 await installAdapter('opencode-v1',{home,cwd:root});
 const wrapper=await readFile(join(home,'.config/opencode/plugins/memos-project-memory.js'),'utf8');assert.match(wrapper,/dist\/adapters\/opencode-v1\/extension\/index.js/);
 await import(pathToFileURL(join(home,'.config/opencode/plugins/memos-project-memory.js')));
 await uninstallAdapter('opencode-v1',{home,cwd:root});
 const doubao=await installAdapter('doubao-work',{home,cwd:root});
 const skill=await readFile(doubao.files[0],'utf8');
 const command=/```sh\n([^\n]+)\n```/.exec(skill)[1];
 assert.match(command,/dist\/adapters\/doubao-work\/skill-runner\.js/);
 await assert.rejects(exec('/bin/sh',['-c',command],{env:{...process.env,MEMOS_PM_URL:url,MCP_VM_CONVERSATION_ID:'1',DOUBAO_OFFICE_ANSWER_MESSAGE_ID:'2'}}),error=>{
  assert.equal(JSON.parse(error.stdout).status,'CONTEXT_MISSING');return true;
 });
 await uninstallAdapter('doubao-work',{home,cwd:root});
 await assert.rejects(readFile(doubao.files[0]),{code:'ENOENT'});
 console.log('PASS: clean npm install, compiled service, Viewer assets, CLI, hook/native installation and resource paths');
} finally {
 if(pid){try{process.kill(pid,'SIGTERM');}catch{} for(let i=0;i<50;i++){try{process.kill(pid,0);}catch{break;}await new Promise(r=>setTimeout(r,100));}}
 await rm(root,{recursive:true,force:true});
}
