import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, mkdir, symlink, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { normalizeHook, hookOutput, processHook } from '../../src/adapters/_shared/hooks.ts';
import { readTranscript } from '../../src/adapters/_shared/transcript.ts';
import { installAdapter, uninstallAdapter, hookNodeExecutable } from '../../src/adapters/installer.ts';

const result = {sessionId:'s',conversationId:'t',context:'memory',overview:'overview',identifiers:'ids',overviewDelivered:false};
test('Claude input retains user and exact tool output; turn events have unique identities',async()=>{
 const first=await normalizeHook('claude-code',{session_id:'abc',cwd:'/repo',hook_event_name:'UserPromptSubmit',prompt:'repeat'});
 const second=await normalizeHook('claude-code',{session_id:'abc',cwd:'/repo',hook_event_name:'UserPromptSubmit',prompt:'repeat'});
 assert.equal(first.event,'turn-start'); assert.notEqual(first.turnKey,second.turnKey);
 assert.equal(first.records?.[0]?.message?.content,'repeat');
 const tool=await normalizeHook('claude-code',{session_id:'abc',cwd:'/repo',hook_event_name:'PostToolUse',tool_use_id:'call1',tool_response:{output:'raw\nresult'}});
 assert.deepEqual(tool.records?.[0]?.raw,{session_id:'abc',cwd:'/repo',hook_event_name:'PostToolUse',tool_use_id:'call1',tool_response:{output:'raw\nresult'}});
 assert.match(JSON.stringify(tool.records),/raw\\nresult/);
});
test('host schemas and output contexts are not interchangeable',async()=>{
 const cursor=await normalizeHook('cursor-cli',{conversation_id:'c',generation_id:'g',workspace_roots:['/repo'],hook_event_name:'beforeSubmitPrompt',prompt:'hi'});
 assert.equal(cursor.nativeSessionId,'c');assert.equal(cursor.nativeTurnId,'g');
 assert.deepEqual(hookOutput('cursor-cli','sessionStart',result),{additional_context:'memory'});
 assert.equal(hookOutput('cursor-cli','beforeSubmitPrompt',result),'');
 assert.deepEqual(hookOutput('copilot-cli','sessionStart',result),{additionalContext:'memory'});
 assert.equal(hookOutput('copilot-cli','userPromptSubmitted',result),'');
 assert.equal(hookOutput('grok-build','SessionStart',result),'');
 assert.deepEqual(hookOutput('antigravity-cli','SessionStart',result),{injectSteps:[{systemMessage:{systemMessage:'memory'}}]});
});
test('transcript preserves tool calls, tool output, metadata and repeated identical text',async()=>{
 const home=await mkdtemp(join(tmpdir(),'memos-hooks-'));const path=join(home,'trace.jsonl');
 await writeFile(path,[{uuid:'u1',message:{role:'user',content:'same'}},{uuid:'u2',message:{role:'user',content:'same'}},{uuid:'a1',message:{role:'assistant',content:[],tool_calls:[{id:'x'}]}},{uuid:'t1',message:{role:'tool',content:'raw',tool_call_id:'x'}},{type:'metadata',unknown:5}].map(x=>JSON.stringify(x)).join('\n')+'\n');
 const rows=await readTranscript(path);assert.equal(rows.length,5);assert.notEqual(rows[0]?.sourceId,rows[1]?.sourceId);assert.equal(rows[3]?.message?.tool_call_id,'x');assert.deepEqual(rows[4]?.raw,{type:'metadata',unknown:5});
 assert.deepEqual(await readTranscript(path),rows);
});
test('temporary ZCode transcript is read before local service acknowledgement',async()=>{
 const home=await mkdtemp(join(tmpdir(),'memos-zcode-'));const path=join(home,'temp.jsonl');await writeFile(path,JSON.stringify({id:'m',message:{role:'assistant',content:'ok'}})+'\n');
 let captured:any;
 await processHook('zcode',{session_id:'s',cwd:'/repo',hook_event_name:'Stop',transcript_path:path},{request:async(event)=>{captured=event;return result;}});
 assert.equal(captured.records[0].message.content,'ok');
});
test('installer is idempotent and removes only its hook entries',async()=>{
 const home=await mkdtemp(join(tmpdir(),'memos-install-'));await mkdir(join(home,'.claude'));
 const path=join(home,'.claude/settings.json');await writeFile(path,JSON.stringify({model:'keep',hooks:{Stop:[{hooks:[{type:'command',command:'other'}]}]}}));
 await installAdapter('claude-code',{home,cwd:home});await installAdapter('claude-code',{home,cwd:home});
 let config=JSON.parse(await readFile(path,'utf8'));assert.equal(config.model,'keep');assert.equal(config.hooks.Stop.length,2);
 await uninstallAdapter('claude-code',{home,cwd:home});config=JSON.parse(await readFile(path,'utf8'));assert.deepEqual(config,{model:'keep',hooks:{Stop:[{hooks:[{type:'command',command:'other'}]}]}});
});

test('all documented hook schemas map native session and turn boundaries',async()=>{
 const ids=['claude-code','codex-cli','qwen-code','kimi-code','factory-droid','zcode','trae','devin-cli','deepagents-dcode','codebuddy-cli'];
 for(const id of ids){
  const input={session_id:`${id}-session`,cwd:'/repo',hook_event_name:'UserPromptSubmit',prompt_id:'native-turn',prompt:'hello'};
  const event=await normalizeHook(id,input,{env:{HOME:'/missing-fixture-home'}});
  assert.equal(event.agentType,id);assert.equal(event.nativeSessionId,input.session_id);assert.equal(event.nativeTurnId,'native-turn');assert.equal(event.event,'turn-start');
 }
 const grok=await normalizeHook('grok-build',{sessionId:'grok',workspaceRoot:'/repo',promptId:'p',hookEventName:'user_prompt_submit',prompt:'hello'});
 assert.equal(grok.nativeTurnId,'p');assert.equal(grok.event,'turn-start');
 const copilot=await normalizeHook('copilot-cli',{sessionId:'copilot',cwd:'/repo',timestamp:123,prompt:'hello',transformedPrompt:'@context hello'},{event:'userPromptTransformed'});
 assert.equal(copilot.event,'turn-start');assert.equal(copilot.turnKey,'userPromptTransformed:123');
 assert.deepEqual(hookOutput('copilot-cli','userPromptTransformed',result,{transformedPrompt:'@context hello'}),{modifiedTransformedPrompt:'@context hello\n\nmemory'});
 await assert.rejects(normalizeHook('claude-code',{cwd:'/repo',prompt:'no identity'}),/native session ID/);
});
test('Antigravity only starts a user turn from a stable transcript identity',async()=>{
 const home=await mkdtemp(join(tmpdir(),'memos-agy-'));const path=join(home,'trace.jsonl');
 await writeFile(path,JSON.stringify({id:'user1',role:'user',content:'hello'})+'\n');
 const first=await normalizeHook('antigravity-cli',{conversationId:'s',workspacePaths:['/repo'],transcriptPath:path,invocationNum:0},{event:'PreInvocation'});
 const toolLoop=await normalizeHook('antigravity-cli',{conversationId:'s',workspacePaths:['/repo'],transcriptPath:path,invocationNum:1},{event:'PreInvocation'});
 assert.equal(first.event,'turn-start');assert.equal(first.turnKey,toolLoop.turnKey);
 const missing=await normalizeHook('antigravity-cli',{conversationId:'s',workspacePaths:['/repo'],lastUserInput:'hello',invocationNum:2},{event:'PreInvocation'});
 assert.equal(missing.event,'trace-available');assert.equal(missing.turnKey,undefined);
});
test('Qwen cumulative message updates retain final content',async()=>{
 const base={session_id:'s',cwd:'/repo',hook_event_name:'MessageDisplay',message_id:'msg'};
 const early=await normalizeHook('qwen-code',{...base,displayed_text:'h',is_final:false});
 const final=await normalizeHook('qwen-code',{...base,displayed_text:'hello',is_final:true});
 assert.notEqual(early.records?.at(-1)?.sourceId,final.records?.at(-1)?.sourceId);assert.equal(final.records?.at(-1)?.message?.content,'hello');
});
test('host-specific installers preserve other entries and Kimi TOML',async()=>{
 for(const id of ['factory-droid','cursor-cli','copilot-cli','grok-build','qwen-code','zcode','trae','antigravity-cli','devin-cli','deepagents-dcode','codebuddy-cli','codex-cli','workbuddy']){
  const home=await mkdtemp(join(tmpdir(),`memos-${id}-`));
  const install=await installAdapter(id,{home,cwd:home});assert.equal(install.installed,true);
  await installAdapter(id,{home,cwd:home});await uninstallAdapter(id,{home,cwd:home});
 }
 const home=await mkdtemp(join(tmpdir(),'memos-kimi-'));await mkdir(join(home,'.kimi-code'));
 const path=join(home,'.kimi-code/config.toml');const original='model = "keep"\n\n[[hooks]]\nevent = "Stop"\ncommand = "other"\n';await writeFile(path,original);
 await installAdapter('kimi-code',{home,cwd:home});await installAdapter('kimi-code',{home,cwd:home});
 assert.equal((await readFile(path,'utf8')).split('# memos-project-memory:start').length,2);
 await uninstallAdapter('kimi-code',{home,cwd:home});assert.equal(await readFile(path,'utf8'),original);
});

test('installed entry executes stdin -> HTTP capture -> host context JSON',async()=>{
 const {createServer}=await import('node:http');const {spawn}=await import('node:child_process');const {once}=await import('node:events');
 const received:unknown[]=[];
 const server=createServer(async(req,res)=>{
  res.setHeader('Content-Type','application/json');
  if(req.url==='/api/health'){res.end(JSON.stringify({service:'memos-project-memory-plugin'}));return;}
  if(req.url==='/api/context-delivery'){res.end('{}');return;}
  const chunks:Buffer[]=[];for await(const chunk of req)chunks.push(Buffer.from(chunk));received.push(JSON.parse(Buffer.concat(chunks).toString()));res.end(JSON.stringify(result));
 });
 server.listen(0,'127.0.0.1');await once(server,'listening');const address=server.address();assert(address&&typeof address==='object');
 try{
  const child=spawn(process.execPath,['src/adapters/claude-code/index.ts','UserPromptSubmit'],{env:{...process.env,MEMOS_PM_URL:`http://127.0.0.1:${address.port}`},stdio:['pipe','pipe','pipe']});
  let output='',errors='';child.stdout.on('data',chunk=>output+=chunk);child.stderr.on('data',chunk=>errors+=chunk);
  child.stdin.end(JSON.stringify({session_id:'process-session',cwd:'/repo',hook_event_name:'UserPromptSubmit',prompt:'hello'}));
  const [code]=await once(child,'close');assert.equal(code,0,errors);assert.equal(received.length,1);assert.equal((received[0] as any).nativeSessionId,'process-session');
  assert.deepEqual(JSON.parse(output),{hookSpecificOutput:{hookEventName:'UserPromptSubmit',additionalContext:'memory'}});
 }finally{await new Promise<void>(resolve=>server.close(()=>resolve()));}
});

test('Kimi locates the exact native session via index, retaining raw context and tool rows',async()=>{
 const home=await mkdtemp(join(tmpdir(),'memos-kimi-source-'));const root=join(home,'.kimi-code');const sessionDir=join(root,'sessions','managed-workspace','selected-session');
 await mkdir(join(sessionDir,'agents','main'),{recursive:true});
 await writeFile(join(root,'session_index.jsonl'),JSON.stringify({sessionId:'selected-session',sessionDir,workDir:'/repo'})+'\n');
 await writeFile(join(sessionDir,'agents','main','wire.jsonl'),[ {type:'context.append_message',message:{role:'user',content:'original'}}, {type:'context.append_message',message:{role:'assistant',content:'reply'}}, {type:'tool.result',turnId:0,toolCallId:'tool-1',result:{output:'exact'}} ].map(row=>JSON.stringify(row)).join('\n')+'\n');
 const event=await normalizeHook('kimi-code',{session_id:'selected-session',cwd:'/repo',hook_event_name:'Stop'},{env:{HOME:home}});
 assert.equal(event.records?.[0]?.message?.content,'original');assert.equal(event.records?.[2]?.message?.role,'tool');assert.equal(event.records?.[2]?.nativeTurnId,'0');
});

test('history hosts emit overview once; Kimi observation does not acknowledge delivery',async()=>{
 const events:string[]=[];const outputs:unknown[]=[];
 const request=async()=>({...result,context:'overview\n\nids'});
 const emit=(value:unknown)=>{events.push('stdout');outputs.push(value);};const markDelivered=async()=>{events.push('ack');};
 await processHook('kimi-code',{session_id:'s',cwd:'/repo',hook_event_name:'SessionStart'},{env:{HOME:'/missing-home'},request,emit,markDelivered});
 assert.deepEqual(events,[]);
 await processHook('kimi-code',{session_id:'s',cwd:'/repo',hook_event_name:'UserPromptSubmit',prompt:'first'},{env:{HOME:'/missing-home'},request,emit,markDelivered});
 assert.deepEqual(events,['stdout','ack']);assert.equal(outputs[0],'overview\n\nids');
 const repeated=await processHook('claude-code',{session_id:'s',cwd:'/repo',hook_event_name:'UserPromptSubmit',prompt:'next'},{request:async()=>({...result,overviewDelivered:true})});
 assert.deepEqual(repeated,{hookSpecificOutput:{hookEventName:'UserPromptSubmit',additionalContext:'ids'}});
 const view=await processHook('antigravity-cli',{conversationId:'s',workspacePaths:['/repo']},{event:'PreInvocation',request:async()=>({...result,overviewDelivered:true})});
 assert.deepEqual(view,{injectSteps:[{ephemeralMessage:'memory'}]});
});

test('Cursor and Grok bind search variables at shell execution without shared per-turn files',()=>{
 const command='memos-pm search --session-id "$MEMOS_PM_SESSION_ID" --conversation-id "$MEMOS_PM_CONVERSATION_ID" --query "history"';
 const cursor=hookOutput('cursor-cli','preToolUse',result,{tool_name:'Shell',tool_input:{command,working_directory:'/repo'}}) as any;
 assert.equal(cursor.permission,'allow');assert.equal(cursor.updated_input.working_directory,'/repo');assert.match(cursor.updated_input.command,/MEMOS_PM_SESSION_ID='s'/);assert.match(cursor.updated_input.command,/MEMOS_PM_CONVERSATION_ID='t'/);assert.ok(cursor.updated_input.command.endsWith(command));
 const grok=hookOutput('grok-build','PreToolUse',result,{toolName:'run_terminal_command',toolInput:{command}}) as any;
 assert.match(grok.hookSpecificOutput.updatedInput.command,/MEMOS_PM_CONVERSATION_ID='t'/);
 assert.deepEqual(hookOutput('cursor-cli','preToolUse',result,{tool_name:'Shell',tool_input:{command:'npm test'}}),{permission:'allow'});
});

test('WorkBuddy desktop 5.3.14 uses its own actual engine settings and native generation identity',async()=>{
 const home=await mkdtemp(join(tmpdir(),'memos-workbuddy-desktop-'));
 await installAdapter('workbuddy',{home,cwd:home});
 const config=JSON.parse(await readFile(join(home,'.workbuddy/settings.json'),'utf8'));
 assert.ok(config.hooks.SessionStart);assert.ok(config.hooks.UserPromptSubmit);assert.ok(config.hooks.PostToolUse);
 const event=await normalizeHook('workbuddy',{session_id:'desktop-session',generation_id:'generation',cwd:'/repo',hook_event_name:'UserPromptSubmit',prompt:'hello'});
 assert.equal(event.nativeTurnId,'generation');assert.equal(event.agentType,'workbuddy');
 assert.deepEqual(hookOutput('workbuddy','UserPromptSubmit',result),{hookSpecificOutput:{hookEventName:'UserPromptSubmit',additionalContext:'memory'}});
});

test('ZCode temporary transcript filenames do not change stable record identity',async()=>{
 const home=await mkdtemp(join(tmpdir(),'memos-zcode-temp-'));const one=join(home,'first.jsonl'),two=join(home,'second.jsonl');
 const line=JSON.stringify({uuid:'native-message',message:{role:'assistant',content:'complete'}})+'\n';await writeFile(one,line);await writeFile(two,line);
 const input={session_id:'s',cwd:'/repo',hook_event_name:'Stop'};
 const first=await normalizeHook('zcode',{...input,transcript_path:one});const second=await normalizeHook('zcode',{...input,transcript_path:two});
 assert.equal(first.records?.[0]?.sourceId,second.records?.[0]?.sourceId);
});

test('tool names remain raw metadata, never an unpaired M03 speaker role_name',async()=>{
 const raw={session_id:'s',cwd:'/repo',hook_event_name:'PostToolUse',tool_name:'Bash',tool_use_id:'call',tool_response:'exact result'};
 const event=await normalizeHook('claude-code',raw);const record=event.records?.at(-1);
 assert.equal(Object.hasOwn(record!.message!,'role_name'),false);
 assert.equal(record?.message?.tool_call_id,'call');assert.deepEqual(record?.raw,raw);
});
test('Kimi tool arguments are JSON strings while existing argument strings remain exact',async()=>{
 const home=await mkdtemp(join(tmpdir(),'memos-kimi-args-'));const path=join(home,'wire.jsonl');
 const existing='{"command": "echo hello"}';
 const raw=[{type:'tool.call.started',toolCallId:'a',name:'Bash',arguments:{command:'echo hello'}},{type:'tool.call.started',toolCallId:'b',name:'Bash',args:existing}];
 await writeFile(path,raw.map(row=>JSON.stringify(row)).join('\n')+'\n');
 const records=await readTranscript(path);
 const calls=records.map(record=>record.message?.tool_calls?.[0] as {function:{arguments:unknown}});
 assert.equal(calls[0]?.function.arguments,JSON.stringify(raw[0]?.arguments));
 assert.equal(calls[1]?.function.arguments,existing);assert.deepEqual(records.map(record=>record.raw),raw);
});

test('only terminal hooks finish user trajectories; model and tool callbacks stay open',async()=>{
 for(const agent of ['claude-code','codex-cli','cursor-cli','grok-build','qwen-code','kimi-code','factory-droid','zcode','trae','antigravity-cli','devin-cli','deepagents-dcode','workbuddy','codebuddy-cli']) {
  const event=await normalizeHook(agent,{session_id:'s',cwd:'/repo',prompt_id:'p',hook_event_name:'Stop'},{env:{HOME:'/missing-fixture-home'}});
  assert.equal(event.event,'turn-end');
 }
 assert.equal((await normalizeHook('copilot-cli',{sessionId:'s',cwd:'/repo'},{event:'agentStop'})).event,'turn-end');
 for(const name of ['PostToolUse','PostInvocation','afterAgentResponse','MessageDisplay','SubagentStop','Interrupt']) {
  assert.equal((await normalizeHook('claude-code',{session_id:'s',cwd:'/repo',hook_event_name:name})).event,'trace-available');
 }
});

test('SubagentStop finishes only the child after its full transcript has been captured',async()=>{
 const home=await mkdtemp(join(tmpdir(),'memos-child-complete-'));const path=join(home,'child.jsonl');
 await writeFile(path,[{id:'u',role:'user',content:'child task'},{id:'a',role:'assistant',content:'done'}].map(x=>JSON.stringify(x)).join('\n'));
 const events:any[]=[];
 await processHook('claude-code',{session_id:'parent',cwd:'/repo',hook_event_name:'SubagentStop',agent_id:'child',agent_transcript_path:path},{request:async event=>{events.push(event);return result;}});
 assert.equal(events[0].event,'trace-available');
 assert.equal(events[1].nativeSessionId,'child');
 assert.equal(events[1].event,'session-end');
 assert.equal(events[1].nativeTurnId,undefined);
 assert.deepEqual(events[1].records.map((r:any)=>r.message.role),['user','assistant']);
});

test('completion transcript separates older rounds while tool results stay in their user round',async()=>{
 const home=await mkdtemp(join(tmpdir(),'memos-hook-rounds-'));const path=join(home,'trace.jsonl');
 const rows=[
  {uuid:'u1',message:{role:'user',content:'first'}},
  {uuid:'t1',message:{role:'user',content:[{type:'tool_result',tool_use_id:'call',content:'output'}]}},
  {uuid:'a1',message:{role:'assistant',content:'first answer'}},
  {uuid:'u2',message:{role:'user',content:'second'}},
  {uuid:'a2',message:{role:'assistant',content:'second answer'}}
 ];
 await writeFile(path,rows.map(x=>JSON.stringify(x)).join('\n'));
 const event=await normalizeHook('claude-code',{session_id:'s',cwd:'/repo',hook_event_name:'Stop',prompt_id:'current',transcript_path:path});
 assert.equal(event.event,'turn-end');
 const records=event.records!;
 assert.match(records[0]!.nativeTurnId!,/^transcript:/);
 assert.equal(records[1]!.nativeTurnId,records[0]!.nativeTurnId);
 assert.equal(records[2]!.nativeTurnId,records[0]!.nativeTurnId);
 assert.equal(records[3]!.nativeTurnId,'current');
 assert.equal(records[4]!.nativeTurnId,'current');
 const prompt=await normalizeHook('claude-code',{session_id:'s',cwd:'/repo',hook_event_name:'UserPromptSubmit',prompt_id:'new',prompt:'third',transcript_path:path});
 assert.match(prompt.records![3]!.nativeTurnId!,/^transcript:/);
 assert.equal(prompt.records!.at(-1)!.nativeTurnId,'new');
});


test('hook Node path uses the matching Homebrew stable link and survives a version switch', async () => {
 const prefix=await mkdtemp(join(tmpdir(),'memos-node-'));
 try {
  const executable=join(prefix,'Cellar/node/26.4.0/bin/node');
  await mkdir(join(prefix,'Cellar/node/26.4.0/bin'),{recursive:true});await writeFile(executable,'node');
  await mkdir(join(prefix,'opt'));await symlink('../Cellar/node/26.4.0',join(prefix,'opt/node'));
  const selected=await hookNodeExecutable(executable);
  assert.equal(selected,join(prefix,'opt/node/bin/node'));
  const updated=join(prefix,'Cellar/node/26.5.0/bin/node');
  await mkdir(join(prefix,'Cellar/node/26.5.0/bin'),{recursive:true});await writeFile(updated,'new node');
  await rm(join(prefix,'opt/node'));await symlink('../Cellar/node/26.5.0',join(prefix,'opt/node'));
  assert.equal(await realpath(selected),await realpath(updated));
  // Never silently choose a different Node when the current runtime has no matching stable link.
  assert.equal(await hookNodeExecutable(executable),executable);
  await mkdir(join(prefix,'bin'));await symlink('../Cellar/node/26.4.0/bin/node',join(prefix,'bin/node'));
  assert.equal(await hookNodeExecutable(executable),join(prefix,'bin/node'));
  assert.equal(await hookNodeExecutable('/custom/bin/node'),'/custom/bin/node');
 } finally {await rm(prefix,{recursive:true,force:true});}
});
