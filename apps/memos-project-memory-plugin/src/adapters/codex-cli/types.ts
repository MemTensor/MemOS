import type { Message, TraceInput } from '../types.ts';

export type CodexSourceKind = 'user' | 'subagent' | 'background' | 'unknown';
export type CodexTurnStatus = 'running' | 'completed' | 'interrupted' | 'failed' | 'cancelled';
export interface CodexRecord extends TraceInput {
    message: Message;
    occurredAt?: string;
    sourceOrdinal: number;
    originSessionId: string;
    agentPath?: string;
    rootTurnId?: string;
}
export interface CodexExpectedChild {
    callId: string;
    agentId?: string;
    agentPath?: string;
    kind: 'spawn' | 'followup';
    status: 'pending' | 'started' | 'failed';
    occurredAt?: string;
    sourceOrdinal?: number;
}
export interface CodexTurn {
    nativeTurnId: string;
    rootTurnId: string;
    parentTurnId?: string;
    startedAt?: string;
    completedAt?: string;
    status: CodexTurnStatus;
    records: CodexRecord[];
    expectedChildren: CodexExpectedChild[];
    gaps: string[];
    sourceKind?: CodexSourceKind;
}
export interface CodexSnapshot {
    nativeSessionId: string;
    cwd: string;
    parentNativeSessionId?: string;
    agentPath?: string;
    sourceKind: CodexSourceKind;
    startedAt?: string;
    sourcePath: string;
    turns: CodexTurn[];
    gaps: string[];
}
export interface CodexParserState {
    snapshot: CodexSnapshot;
    activeTurnId?: string;
    pending: { raw: unknown; ordinal: number }[];
    lineNumber: number;
    historyStartOrdinal?: number;
}
export interface CodexReaderState {
    version: 2 | 3 | 4;
    byteOffset: number;
    fileIdentity: string;
    observedSize: number;
    modifiedAt: number;
    prefixDigest: string;
    prefixLength: number;
    tailDigest: string;
    tailLength: number;
    parser: CodexParserState;
}
