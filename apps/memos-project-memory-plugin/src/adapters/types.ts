export type EventKind = 'session-start' | 'turn-start' | 'trace-available' | 'turn-end' | 'session-end';
export interface Message { role: string; content: string | unknown[]; chat_time?: string; role_id?: string; role_name?: string; tool_calls?: unknown[]; [key: string]: unknown }
export interface TraceInput { sourceId: string; raw: unknown; message?: Message; nativeTurnId?: string }
export interface AgentEvent { agentType: string; nativeSessionId: string; cwd: string; event: EventKind; title?: string; titleRevision?: number; nativeTurnId?: string; turnKey?: string; parentNativeSessionId?: string; records?: TraceInput[]; raw?: unknown }
export interface EventResult { sessionId: string; conversationId: string | null; context: string; overview: string; overviewDelivered?: boolean; identifiers: string }
export interface AdapterProfile { id: string; agentId: string; name: string; kind: 'hook' | 'extension' | 'native-skill'; command: string; versions: string[]; configPath?: string; skillPath: string; retention: 'history' | 'request-view'; sessionStartBlocking?: boolean; limitations?: string[] }
