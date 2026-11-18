import { randomUUID, createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join, resolve, sep, basename } from 'node:path';
import { readFile, readdir } from 'node:fs/promises';
import type { AgentEvent, EventResult, Message, TraceInput } from '../types.ts';
import { object, textField, readTranscript } from './transcript.ts';
import { normalizeTaskTrace } from './task-trace.ts';

const standardEvents = ['SessionStart','UserPromptSubmit','PostToolUse','Stop','SessionEnd','PreCompact'];
export const hookEvents: Record<string,string[]> = {
 'claude-code':[...standardEvents,'SubagentStop'], 'codex-cli':[...standardEvents,'PostCompact','Interrupt','SubagentStop'],
 'cursor-cli':['sessionStart','sessionEnd','beforeSubmitPrompt','preToolUse','postToolUse','postToolUseFailure','afterAgentResponse','stop','preCompact'],
 'copilot-cli':['sessionStart','userPromptTransformed','postToolUse','postToolUseFailure','agentStop','sessionEnd'],
 'grok-build':[...standardEvents,'PreToolUse','PostToolUseFailure','SubagentStop'], 'qwen-code':[...standardEvents,'PostToolUseFailure','MessageDisplay'],
 'kimi-code':[...standardEvents,'Interrupt'], 'factory-droid':[...standardEvents,'SubagentStop','Notification'],
 'zcode':['SessionStart','UserPromptSubmit','PostToolUse','PostToolUseFailure','Stop'],
 'trae':['SessionStart','UserPromptSubmit','PostToolUse','Stop','Notification'],
 'antigravity-cli':['SessionStart','PreInvocation','PostInvocation','PostToolUse','Stop'],
 'devin-cli':[...standardEvents.filter(x=>x!=='PreCompact'),'PostCompaction'], 'deepagents-dcode':[...standardEvents,'SubagentStop'],
 'workbuddy':[...standardEvents,'PostToolUseFailure','SubagentStop'], 'codebuddy-cli':[...standardEvents,'PostCompact'],
};
const eventName = (raw: Record<string,unknown>, fallback?: string): string => textField(raw,'hook_event_name','hookEventName') ?? fallback ?? '';
const normalizedName = (name:string):string => name.replace(/_/g,'').toLowerCase();
const isEnd = (name:string):boolean => ['stop','agentstop'].includes(normalizedName(name));
const isStart = (name:string):boolean => normalizedName(name)==='sessionstart';
const isPrompt = (name:string):boolean => ['userpromptsubmit','userpromptsubmitted','userprompttransformed','beforesubmitprompt'].includes(normalizedName(name));

async function kimiTranscript(sessionId: string, env: NodeJS.ProcessEnv): Promise<string | undefined> {
 const base=env.KIMI_CODE_HOME ?? join(env.HOME ?? homedir(),'.kimi-code');
 // Official session index maps sessionId directly to sessionDir, without recency guesses.
 try {
  const index=await readFile(join(base,'session_index.jsonl'),'utf8');
  for(const line of index.trim().split('\n').reverse()){
   if(!line)continue;const record=object(JSON.parse(line));
   if(record.sessionId!==sessionId||typeof record.sessionDir!=='string')continue;
   const directory=resolve(record.sessionDir);const sessions=resolve(base,'sessions');
   if(directory.startsWith(sessions+sep)&&basename(directory)===sessionId)return join(directory,'agents','main','wire.jsonl');
  }
 } catch(error) { if(object(error).code!=='ENOENT')throw error; }
 // Older local index may not yet be flushed; exact ID directory lookup stays unambiguous.
 try { for (const key of await readdir(join(base,'sessions'))) {
   const path=join(base,'sessions',key,sessionId,'agents','main','wire.jsonl');
   try { await readFile(path); return path; } catch(error) { if (object(error).code!=='ENOENT') throw error; }
 } } catch(error) { if (object(error).code!=='ENOENT') throw error; }
 return undefined;
}

export async function normalizeHook(agentType:string,input:unknown,options:{event?:string;env?:NodeJS.ProcessEnv}={}):Promise<AgentEvent> {
 const raw=object(input); const env=options.env ?? process.env; const name=eventName(raw,options.event);
 const camel=['copilot-cli','grok-build','antigravity-cli'].includes(agentType);
 const nativeSessionId=agentType==='cursor-cli' ? textField(raw,'conversation_id','session_id') : camel ? textField(raw,'sessionId','conversationId','session_id') : textField(raw,'session_id','sessionId');
 if (!nativeSessionId) throw new Error(`${agentType}: hook has no native session ID`);
 const roots=raw.workspace_roots ?? raw.workspacePaths;
 const cwd=textField(raw,'cwd','workspaceRoot') ?? env.DEVIN_PROJECT_DIR ?? (Array.isArray(roots)&&roots.length===1&&typeof roots[0]==='string'?roots[0]:undefined);
 if (!cwd) throw new Error(`${agentType}: unambiguous workspace path required`);
 const nativeTurnId=textField(raw,'prompt_id','promptId','generation_id','turn_id','turnId');
 const event:AgentEvent={agentType,nativeSessionId,cwd,event:isStart(name)?'session-start':isPrompt(name)?'turn-start':normalizedName(name)==='sessionend'?'session-end':isEnd(name)?'turn-end':'trace-available',raw};
 if (nativeTurnId) event.nativeTurnId=nativeTurnId;
 // Codex has one durable rollout reader in the local service. A hook is only a
 // wake-up notification: synthesizing messages here duplicates the rollout and
 // assigning the active hook turn to its history splits complete conversations.
 if (agentType === 'codex-cli') {
   const expand = (path: string | undefined) => path?.startsWith('~/') ? join(env.HOME ?? homedir(), path.slice(2)) : path;
   event.raw = { ...raw, hook_event_name: name,
     transcript_path: expand(textField(raw, 'transcript_path', 'transcriptPath')),
     agent_transcript_path: expand(textField(raw, 'agent_transcript_path')) };
   event.records = [];
   return event;
 }
 if (event.event==='turn-start'&&!nativeTurnId) {
   const identity=textField(raw,'message_id','messageId','event_id') ?? (raw.timestamp!==undefined?String(raw.timestamp):undefined);
   event.turnKey=identity ? `${name}:${identity}` : `${name}:${randomUUID()}`;
 }
 const transcriptPath=textField(raw,'transcript_path','transcriptPath') ?? (agentType==='cursor-cli'?env.CURSOR_TRANSCRIPT_PATH:undefined) ?? (agentType==='kimi-code'?await kimiTranscript(nativeSessionId,env):undefined);
 const records:TraceInput[]=[];
 if (transcriptPath) {
   const path=transcriptPath.startsWith('~/')?join(env.HOME ?? homedir(),transcriptPath.slice(2)):transcriptPath;
   try { records.push(...await readTranscript(path,`${agentType}:${nativeSessionId}`)); } catch(error) { if (object(error).code!=='ENOENT') throw error; }
 }
 // Antigravity invokes this hook for each model request. Only an actual source user record establishes a turn.
 if (agentType==='antigravity-cli'&&name==='PreInvocation') {
   const user=records.findLast(record=>normalizeTaskTrace(agentType,record)?.message?.role==='user');
   if (user) { event.event='turn-start';event.turnKey=user.sourceId; }
 }
 attributeTranscriptTurns(records, event, agentType==='antigravity-cli'&&name==='PreInvocation');
 const prompt=textField(raw,'submitted_prompt','prompt');
 const callId=textField(raw,'tool_use_id','toolUseId','tool_call_id') ?? (raw.stepIdx!==undefined?String(raw.stepIdx):undefined);
 const output=raw.tool_response ?? raw.toolResult ?? raw.tool_output;
 let message:Message|undefined;
 if (isPrompt(name)&&prompt!==undefined) message={role:'user',content:prompt};
 else if (normalizedName(name).startsWith('posttooluse')) message={role:'tool',content:typeof output==='string'?output:JSON.stringify(output ?? raw),tool_call_id:callId,...(textField(raw,'tool_name','toolName')?{name:textField(raw,'tool_name','toolName')}:{}),...((raw.tool_input??raw.toolInput)!==undefined?{tool_input:raw.tool_input??raw.toolInput}:{})};
 else {
   const content=textField(raw,'last_assistant_message','lastAssistantMessage','text','displayed_text');
   if(content!==undefined)message={role:'assistant',content};
 }
 let sourceKey=textField(raw,'event_id','message_id','messageId') ?? callId ?? (raw.timestamp!==undefined?String(raw.timestamp):undefined) ?? event.turnKey ?? randomUUID();
 if(name==='MessageDisplay')sourceKey+=`:${createHash('sha256').update(JSON.stringify(raw)).digest('hex')}`;
 // The storage boundary keeps task messages only; lifecycle hooks still establish identity.
 records.push({sourceId:`hook:${nativeSessionId}:${name}:${sourceKey}`,raw,message,nativeTurnId});
 event.records=records;
 return event;
}

/** Preserve prior transcript rounds; latest records use the hook's active user round. */
function attributeTranscriptTurns(records:TraceInput[],event:AgentEvent,latestIsPrompt=false):void {
 const starts=records.flatMap((record,index)=>{
  const message=normalizeTaskTrace(event.agentType,record)?.message;
  return message?.role==='user'?[index]:[];
 });
 const last=starts.at(-1);
 let key:string|undefined;
 for(const [index,record] of records.entries()){
  if(starts.includes(index)) {
   const historical=index!==last || (event.event==='turn-start'&&!latestIsPrompt);
   key=record.nativeTurnId ?? (historical?`transcript:${record.sourceId}`:event.nativeTurnId ?? (latestIsPrompt?event.turnKey:undefined));
  } else if(record.nativeTurnId) key=record.nativeTurnId;
  if(!record.nativeTurnId&&key)record.nativeTurnId=key;
 }
}

export function hookOutput(agentType:string,name:string,result:EventResult,input:unknown={}):unknown {
 if((agentType==='cursor-cli'||agentType==='grok-build')&&normalizedName(name)==='pretooluse'){
  const raw=object(input);const tool=object(raw.tool_input ?? raw.toolInput);const command=textField(tool,'command');const toolName=textField(raw,'tool_name','toolName');
  if(result.conversationId&&command&&['Shell','run_terminal_command'].includes(toolName??'')&&/\bmemos-pm\s+search\b/.test(command)){
   const quote=(value:string)=>`'${value.replace(/'/g,"'\\''")}'`;
   const updated={...tool,command:`export MEMOS_PM_SESSION_ID=${quote(result.sessionId)} MEMOS_PM_CONVERSATION_ID=${quote(result.conversationId)};\n${command}`};
   return agentType==='cursor-cli'?{permission:'allow',updated_input:updated}:{hookSpecificOutput:{hookEventName:'PreToolUse',updatedInput:updated}};
  }
  return agentType==='cursor-cli'?{permission:'allow'}:'';
 }
 if (!result.context) return '';
 if (agentType==='cursor-cli') return name==='sessionStart'?{additional_context:result.context}:'';
 if (agentType==='copilot-cli') {
   if(name==='sessionStart')return {additionalContext:result.context};
   if(name==='userPromptTransformed')return {modifiedTransformedPrompt:`${textField(object(input),'transformedPrompt','prompt') ?? ''}\n\n${result.context}`};
   return '';
 }
 if (agentType==='grok-build') return normalizedName(name).startsWith('posttooluse')?{hookSpecificOutput:{hookEventName:name,additionalContext:result.context}}:'';
 if (agentType==='antigravity-cli') {
   if(name==='SessionStart')return {injectSteps:[{systemMessage:{systemMessage:result.context}}]};
   if(name==='PreInvocation')return {injectSteps:[{ephemeralMessage:result.context}]};
   return '';
 }
 if(agentType==='kimi-code')return isPrompt(name)?result.context:'';
 if(isStart(name)||isPrompt(name)||['PostCompact','PostCompaction'].includes(name))return {hookSpecificOutput:{hookEventName:name,additionalContext:result.context}};
 return '';
}

export async function processHook(agentType:string,input:unknown,options:{event?:string;env?:NodeJS.ProcessEnv;request?:(event:AgentEvent)=>Promise<EventResult>;emit?:(output:unknown)=>void;markDelivered?:(sessionId:string)=>Promise<void>}={}):Promise<unknown> {
 const event=await normalizeHook(agentType,input,options);
 const request=options.request ?? (async(event:AgentEvent)=>{
   const {ensureService,serviceRequest}=await import('./client.ts');await ensureService();
   return serviceRequest<EventResult>('/api/events',event);
 });
 const result=await request(event);
 // Subagent transcripts belong to a different session even when the envelope carries the parent ID.
 const raw=object(input);const childPath=textField(raw,'agent_transcript_path');const childId=textField(raw,'agent_id','agentId');
 if(agentType!=='codex-cli'&&childPath&&childId){
  const child:AgentEvent={...event,event:normalizedName(eventName(raw,options.event))==='subagentstop'?'session-end':'trace-available',nativeSessionId:childId,parentNativeSessionId:event.nativeSessionId,nativeTurnId:undefined,turnKey:undefined,records:await readTranscript(childPath,`${agentType}:${childId}`)};
  attributeTranscriptTurns(child.records!,child);
  await request(child);
 }
 const name=eventName(raw,options.event);
 const requestView=agentType==='antigravity-cli'&&name==='PreInvocation';
 const display=result.overviewDelivered&&!requestView?{...result,context:result.identifiers}:result;
 const output=hookOutput(agentType,name,display,input);
 if(output!==''&&options.emit){
  options.emit(output);
  if(result.overview&&!result.overviewDelivered&&normalizedName(name)!=='pretooluse'){
   const mark=options.markDelivered ?? (async(sessionId:string)=>{const {serviceRequest}=await import('./client.ts');await serviceRequest('/api/context-delivery',{sessionId});});
   await mark(result.sessionId);
  }
 }
 return output;
}

export async function runHook(agentType:string):Promise<void> {
 try {
   const chunks:Buffer[]=[];for await(const chunk of process.stdin)chunks.push(Buffer.from(chunk));
   const input=JSON.parse(Buffer.concat(chunks).toString('utf8'));
   await processHook(agentType,input,{event:process.argv[2],emit:(output)=>{process.stdout.write(typeof output==='string'?output:JSON.stringify(output));}});
 } catch(error) {
   process.stderr.write(`[memos-project-memory] ${error instanceof Error?error.message:String(error)}\n`);
   if(agentType==='cursor-cli'&&normalizedName(process.argv[2]??'')==='pretooluse')process.exitCode=1;
   // Observational integration must never veto a user prompt or tool operation.
 }
}
