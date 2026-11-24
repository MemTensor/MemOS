import { observed } from '../../_shared/transcript.ts';
import type { Data, Send } from './bridge.ts';
import { captureBridge, captureRecords } from './capture.ts';
interface Input { directory:string; client?: { session:{messages(input:Data):Promise<{data?:Data[]}>} } }
export async function createHooks(input: Input, send?: Send, agent='opencode-v1') {
 const {bridge,parents}=captureBridge(agent,input.directory,send);
 async function replay(sessionID:string,key=bridge.turns.get(sessionID)) {
  if(!key||!await bridge.active(sessionID))return;
  const result=await input.client?.session.messages({path:{id:sessionID}});
  for(const record of result?.data??[]) {
   const info=record.info;
   if(!info || (info.role==='user' ? info.id!==key : info.parentID!==key))continue;
   for(const row of captureRecords(info,record.parts??[],key))await bridge.trace(sessionID,row.raw,row.sourceId,row.message,key);
  }
 }
 return {
  // Native shell.env is per execution; cwd alone cannot identify a dialog.
  async 'shell.env'(event:{sessionID?:string;cwd:string},output:{env:Record<string,string>}) {
   if(!event.sessionID)return;
   const context=bridge.creationContexts.get(event.sessionID);
   if(context?.createContext)output.env.MEMOS_PM_BIND_CONTEXT=context.createContext;
  },
  async 'chat.message'(event:{sessionID:string;messageID?:string},output:{message:Data;parts:Data[]}) {
   const id=output.message.id??event.messageID;
   if(typeof id!=='string') throw new Error('OpenCode user message ID missing');
   await bridge.turn(event.sessionID,id,captureRecords(observed({...output.message,id}),output.parts,id));
  },
  async 'experimental.chat.system.transform'(event:{sessionID?:string},output:{system:string[]}) {
   if(event.sessionID) {
    const active=await bridge.active(event.sessionID);
    const context=active?bridge.context(event.sessionID):bridge.creationContext(event.sessionID);
    if(context){if(!output.system.includes(context))output.system.push(context);if(active)await bridge.delivered(event.sessionID);}
   }
  },
  async 'tool.execute.after'(event:{sessionID:string;callID:string;tool:string;args:unknown},output:Data) {
   const key=bridge.turns.get(event.sessionID);
   if(!key)return;
   const rows=captureRecords(observed({id:event.callID,role:'assistant'}),[{type:'tool',callID:event.callID,tool:event.tool,
    state:{status:'completed',input:event.args,output:output.output}}],key);
   for(const row of rows)await bridge.trace(event.sessionID,row.raw,row.sourceId,row.message,key);
  },
  async event({event}:{event:Data}) {
   const p=event.properties??{};const sid=p.sessionID??p.info?.sessionID??p.part?.sessionID??(event.type?.startsWith('session.')?p.info?.id:undefined);
   if(!sid)return;
   if((event.type==='session.created'||event.type==='session.updated')&&typeof p.info?.parentID==='string')parents.set(sid,p.info.parentID);
   const key=bridge.turns.get(sid);
   if(event.type==='session.created')await bridge.start(sid);
   if(event.type==='session.idle'||(event.type==='session.status'&&p.status?.type==='idle')){await replay(sid,key);if(key)await bridge.dispatch(sid,'turn-end',undefined,key);}
   if(event.type==='session.deleted'){await bridge.dispatch(sid,'session-end');parents.delete(sid);}
  },
 };
}
export default async function plugin(input:Input) { return createHooks(input); }
