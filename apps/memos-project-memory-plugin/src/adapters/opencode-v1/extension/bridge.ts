import { randomUUID } from 'node:crypto';
import { isMemoryActive, serviceRequest } from '../../_shared/client.ts';
import { createIdentity, createOccurredAt, requestCreateContext, type CreateCallContext, type CreateContextRequest } from '../../_shared/create-context.ts';
import type { AgentEvent, EventResult, Message, TraceInput } from '../../types.ts';
export type Send = ((event: AgentEvent) => Promise<EventResult>) & { delivered?: (sessionId:string, identity?: Pick<AgentEvent, 'agentType' | 'nativeSessionId'>)=>Promise<void>; activation?: typeof isMemoryActive; createContext?: CreateContextRequest };
export const sendEvent: Send = Object.assign((event:AgentEvent) => serviceRequest<EventResult>('/api/events', event), {activation:isMemoryActive,createContext:requestCreateContext,delivered:async(sessionId:string,identity?:Pick<AgentEvent,'agentType'|'nativeSessionId'>)=>{await serviceRequest('/api/context-delivery',sessionId?{sessionId}:identity);}});
export type Data = Record<string, any>;
export function message(raw: Data): Message | undefined {
 const role = raw.role === 'toolResult' ? 'tool' : raw.role;
 if (typeof role !== 'string') return undefined;
 return { ...raw, role, content: raw.content ?? raw.parts ?? raw.text ?? '' };
}
/** Shared local transport only. Host entry points own identity and event semantics. */
export class Bridge {
 readonly turns = new Map<string, string>();
 readonly contexts = new Map<string, EventResult>();
 readonly creationContexts = new Map<string, CreateCallContext>();
 private readonly pending = new Map<string, Promise<EventResult>>();
 readonly agent: string; readonly cwd: string; readonly send: Send;
 constructor(agent: string, cwd: string, send: Send = sendEvent) { this.agent=agent;this.cwd=cwd;this.send=send; }
 async active(session: string) {
  try {
   // Injected transports own their activation probe; the production transport always supplies it.
   if (!this.send.activation || await this.send.activation(this.agent,this.cwd,session)) return true;
  } catch (error) { this.clear(session); throw error; }
  this.clear(session); return false;
 }
 private clear(session: string) { this.contexts.delete(session);if(!this.send.createContext)this.turns.delete(session); }
 async start(session: string) { return this.dispatch(session,'session-start'); }
 async prepareCreation(session:string,event:AgentEvent['event'],turnKey?:string,occurredAt=new Date().toISOString()) {
  if(!this.send.createContext)return;
  this.creationContexts.delete(session);
  const creation=await this.send.createContext(createIdentity({agentType:this.agent,nativeSessionId:session,cwd:this.cwd,event,turnKey,occurredAt}));
  if(creation.createContext)this.creationContexts.set(session,creation);
 }
 async turn(session: string, key: string, records: TraceInput[] = []) {
  if (!session || !key) throw new Error('Host session and user input identity are required');
  this.turns.set(session,key);
  return this.dispatch(session,'turn-start',records, key);
 }
 async trace(session: string, raw: unknown, sourceId: string = randomUUID(), normalized?: Message, nativeTurnId = this.turns.get(session)) {
  return this.dispatch(session,'trace-available',[{sourceId,raw,message:normalized,nativeTurnId}],nativeTurnId);
 }
 async dispatch(session: string, event: AgentEvent['event'], records?: TraceInput[], turnKey = this.turns.get(session)) {
  if (!session) throw new Error('Host session identity is required');
  const input:AgentEvent={agentType:this.agent,nativeSessionId:session,cwd:this.cwd,event,turnKey,records};
  // Hosts may fire observers without awaiting them; completion must follow prior captures.
  const previous=this.pending.get(session);
  const dispatch=async():Promise<EventResult>=>{
   if(this.send.createContext&&event!=='trace-available') {
    await this.prepareCreation(session,event,turnKey,createOccurredAt(records?.find(record=>record.message?.role==='user')?.raw));
   }
   if (!await this.active(session)) {const identifiers=this.creationContext(session);return {sessionId:'',conversationId:null,context:identifiers,overview:'',identifiers};}
   const result=await this.send(input);
   if (result.sessionId || event==='session-start'&&result.overview) this.contexts.set(session,result); else this.clear(session);
   return result;
  };
  const result=previous ? previous.then(dispatch) : dispatch();
  this.pending.set(session,result);
  return result;
 }
 creationContext(session:string) { return this.creationContexts.get(session)?.createIdentifiers ?? ''; }
 historyContext(session:string) { const r=this.contexts.get(session);return [r ? (r.overviewDelivered ? r.identifiers : r.context) : '',this.creationContext(session)].filter(Boolean).join('\n\n'); }
 async delivered(session:string) { if(!await this.active(session))return;const r=this.contexts.get(session);if(r?.overview&&r.context&&!r.overviewDelivered){await this.send.delivered?.(r.sessionId,{agentType:this.agent,nativeSessionId:session});r.overviewDelivered=true;} }
 context(session:string) { const r=this.contexts.get(session);return [r?.overview,r?.identifiers,this.creationContext(session)].filter(Boolean).join('\n\n'); }
}
