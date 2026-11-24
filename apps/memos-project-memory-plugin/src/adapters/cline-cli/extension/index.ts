import { observed } from '../../_shared/transcript.ts';
import { Bridge, message, type Data, type Send } from '../../opencode-v1/extension/bridge.ts';
/** Cline CLI AgentPlugin. Runtime snapshot.conversationId is transcript identity, not a user turn. */
export function createPlugin(send?:Send) {
 const sessions=new Map<string,Bridge>();const bindings=new Map<string,string>();
 const resolve=(snapshot:Data)=>{
  let sid=bindings.get(snapshot.agentId);
  if(!sid&&sessions.size===1){sid=sessions.keys().next().value!;bindings.set(snapshot.agentId,sid);}
  const bridge=sid?sessions.get(sid):undefined;
  if(!bridge||!sid)throw new Error('Cline runtime session cannot be resolved unambiguously');
  return {sid,bridge};
 };
 return {name:'memos-project-memory',manifest:{capabilities:['hooks']},
  setup(_api:unknown,ctx:Data){
   const sid=ctx.session?.sessionId,cwd=ctx.workspaceInfo?.rootPath??ctx.cwd;
   if(!sid||!cwd)throw new Error('Cline sessionId and workspace cwd required');
   sessions.set(sid,new Bridge('cline-cli',cwd,send));
  },
  hooks:{
   async beforeRun({snapshot}:{snapshot:Data}){
    const {sid,bridge}=resolve(snapshot);const key=snapshot.runId;
    if(!key)throw new Error('Cline beforeRun requires runId');
    await bridge.prepareCreation(sid,'turn-start',key);
    if(!await bridge.active(sid)){const appendContext=bridge.creationContext(sid);return appendContext?{appendContext}:{};}
    const records=(snapshot.messages??[]).filter((m:Data)=>m.id).map((m:Data)=>({sourceId:`message:${m.id}`,raw:m,message:message(m)}));
    await bridge.turn(sid,key,records);const appendContext=bridge.historyContext(sid);if(!appendContext)return {};await bridge.delivered(sid);return {appendContext};
   },
   async beforeModel({snapshot}:{snapshot:Data}){const {sid,bridge}=resolve(snapshot);await bridge.trace(sid,{type:'beforeModel',snapshot});},
   async afterModel(event:Data){const {sid,bridge}=resolve(event.snapshot);await bridge.trace(sid,observed(event),event.assistantMessage?.id?`message:${event.assistantMessage.id}`:undefined,message(event.assistantMessage??{}),event.snapshot.runId);},
   async afterTool(event:Data){const {sid,bridge}=resolve(event.snapshot);await bridge.trace(sid,observed(event),`tool:${event.toolCall.toolCallId}`,{role:'tool',content:event.result?.content??JSON.stringify(event.result),tool_call_id:event.toolCall.toolCallId,...((event.toolCall.name??event.toolCall.toolName)!==undefined?{name:event.toolCall.name??event.toolCall.toolName}:{}),...((event.toolCall.arguments??event.toolCall.args??event.toolCall.input)!==undefined?{tool_input:event.toolCall.arguments??event.toolCall.args??event.toolCall.input}:{})},event.snapshot.runId);},
   async onEvent(event:Data){if(event.snapshot){const {sid,bridge}=resolve(event.snapshot);await bridge.trace(sid,observed(event));}},
   async afterRun(event:Data){const {sid,bridge}=resolve(event.snapshot),key=event.snapshot.runId;if(!await bridge.active(sid)){await bridge.prepareCreation(sid,'turn-end',key);return;}for(const m of event.result?.messages??[])if(m.id)await bridge.trace(sid,m,`message:${m.id}`,message(m),key);await bridge.dispatch(sid,'turn-end',undefined,key);},
  },
 };
}
export default createPlugin();
