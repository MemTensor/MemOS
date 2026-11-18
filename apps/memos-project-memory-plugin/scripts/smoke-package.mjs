import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { once } from 'node:events';
import { createMockServer, getMockState } from '../dev/memos-mock/server.ts';
const exec=promisify(execFile), root=await mkdtemp(join(tmpdir(),'memos-package-'));
const cloud=createMockServer();let pid;
try {
 cloud.listen(0,'127.0.0.1');await once(cloud,'listening');
 const packed=await exec('npm',['pack','--pack-destination',root,'--json']);
 const archive=JSON.parse(packed.stdout.slice(packed.stdout.indexOf('[')))[0].filename;
 const clean=join(root,'clean');await mkdir(clean);
 await exec('npm',['install','--prefix',clean,'--ignore-scripts','--no-audit','--no-fund',join(root,archive)]);
 const pkg=join(clean,'node_modules','memos-project-memory-plugin');
 process.env.MEMOS_PM_DATA_DIR=join(root,'data');delete process.env.MEMOS_PM_URL;
 const {serviceRequest,ensureService}=await import(pathToFileURL(join(pkg,'dist/adapters/_shared/client.js')));
 const url=await ensureService();pid=JSON.parse(await readFile(join(root,'data/service.json'),'utf8')).pid;
 for(const asset of ['/','/app.js','/view.js','/style.css'])assert.equal((await fetch(url+asset)).status,200);
 await serviceRequest('/api/config',{apiKey:'mock-key',baseUrl:`http://127.0.0.1:${cloud.address().port}/api/openmem/v1`},'PUT');
 const space=await (await fetch(`http://127.0.0.1:${cloud.address().port}/api/openmem/v1/create/space`,{method:'POST',headers:{Authorization:'Token mock-key','Content-Type':'application/json'},body:JSON.stringify({space_name:'Installed'})})).json();
 await serviceRequest('/api/projects',{name:'Installed',root:'/installed-project',spaceId:space.data.space_id});
 const identity=await serviceRequest('/api/events',{agentType:'claude-code',nativeSessionId:'installed-session',cwd:'/installed-project',event:'turn-start',turnKey:'1',records:[{sourceId:'native-1',raw:{role:'user',content:'installed package'},message:{role:'user',content:'installed package'}}]});
 await serviceRequest('/api/events',{agentType:'claude-code',nativeSessionId:'installed-session',cwd:'/installed-project',event:'turn-end',turnKey:'1'});
 await serviceRequest('/api/sync',{});assert.equal(getMockState(cloud).uploads.length,1);
 const sourceRoot=join(root,'codex-sources');await mkdir(sourceRoot);
 const source=join(sourceRoot,'rollout-package.jsonl');
 const rows=[
  {type:'session_meta',payload:{id:'installed-codex',cwd:'/installed-project',source:'cli'}},
  {type:'event_msg',payload:{type:'task_started',turn_id:'installed-turn'}},
  {type:'response_item',payload:{type:'message',id:'user',role:'user',content:'package task'}},
  {type:'response_item',payload:{type:'custom_tool_call',call_id:'tool',name:'apply_patch',input:'package patch'}},
  {type:'response_item',payload:{type:'custom_tool_call_output',call_id:'tool',output:'package result'}},
  {type:'response_item',payload:{type:'message',id:'answer',role:'assistant',content:'package answer',phase:'final_answer'}},
  {type:'event_msg',payload:{type:'task_complete',turn_id:'installed-turn'}},
 ].map((row,index)=>({...row,timestamp:new Date(Date.UTC(2026,0,1,0,0,index)).toISOString()}));
 await writeFile(source,rows.map(row=>JSON.stringify(row)).join('\n')+'\n');
 const {normalizeHook}=await import(pathToFileURL(join(pkg,'dist/adapters/_shared/hooks.js')));
 const codexEvent=await normalizeHook('codex-cli',{session_id:'installed-codex',turn_id:'installed-turn',cwd:'/installed-project',transcript_path:source,hook_event_name:'Stop'});
 const codexIdentity=await serviceRequest('/api/events',codexEvent);
 await serviceRequest('/api/events',codexEvent);await serviceRequest('/api/sync',{});
 assert.equal(getMockState(cloud).uploads.length,2);
 const detail=await serviceRequest('/api/sessions/'+codexIdentity.sessionId+'?unit=turn');
 assert.equal(detail.total,1);assert.equal(detail.groups[0].traces.length,4);
 const preview=await exec(process.execPath,[join(pkg,'dist/runtime/repair-codex.js'),'--data-dir',join(root,'data'),'--source-root',sourceRoot]);
 assert.equal(JSON.parse(preview.stdout).mode,'dry-run');
 const cli=join(pkg,'dist/cli/index.js');
 const result=await exec(process.execPath,[cli,'search','--session-id',identity.sessionId,'--conversation-id',identity.conversationId,'--query','接口']);assert.equal(JSON.parse(result.stdout).status,'FOUND');
 try{await exec(process.execPath,[cli,'upload']);assert.fail('extra command accepted');}catch(error){assert.equal(error.code,1);assert.equal(JSON.parse(error.stdout).status,'INVALID_QUERY');}
 const searchArgs=[cli,'search','--session-id',identity.sessionId,'--conversation-id',identity.conversationId,'--query','接口'];
 for(const space of getMockState(cloud).spaces.keys())getMockState(cloud).topics.set(space,[]);
 assert.equal(JSON.parse((await exec(process.execPath,searchArgs)).stdout).status,'EMPTY');
 for(const [args,status] of [[ [cli,'search','--query','接口'],'CONTEXT_MISSING'],[searchArgs,'UNAVAILABLE']]){
  if(status==='UNAVAILABLE')await serviceRequest('/api/config',{apiKey:''},'PUT');
  try{await exec(process.execPath,args);assert.fail('error status exited zero');}catch(error){assert.equal(error.code,1);assert.equal(JSON.parse(error.stdout).status,status);}
 }
 const {installAdapter,uninstallAdapter}=await import(pathToFileURL(join(pkg,'dist/adapters/installer.js')));
 const home=join(root,'home');await mkdir(home);await installAdapter('claude-code',{home,cwd:root});
 const settings=JSON.parse(await readFile(join(home,'.claude/settings.json'),'utf8'));
 assert.ok(JSON.stringify(settings).includes('dist/adapters/claude-code/index.js'));assert.ok(!JSON.stringify(settings).includes('/src/'));
 await uninstallAdapter('claude-code',{home,cwd:root});
 await installAdapter('opencode-v1',{home,cwd:root});
 const wrapper=await readFile(join(home,'.config/opencode/plugins/memos-project-memory.js'),'utf8');assert.match(wrapper,/dist\/adapters\/opencode-v1\/extension\/index.js/);
 await import(pathToFileURL(join(home,'.config/opencode/plugins/memos-project-memory.js')));
 await uninstallAdapter('opencode-v1',{home,cwd:root});
 console.log('PASS: clean npm install, compiled service and Codex complete-round capture/replay, repair preview, Viewer assets, HTTP upload, CLI, hook/native installation and resource paths');
} finally {
 if(pid){try{process.kill(pid,'SIGTERM');}catch{} for(let i=0;i<50;i++){try{process.kill(pid,0);}catch{break;}await new Promise(r=>setTimeout(r,100));}}
 await new Promise(resolve=>cloud.close(resolve));await rm(root,{recursive:true,force:true});
}
