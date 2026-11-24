import type { AgentEvent } from '../types.ts';
import { serviceRequest } from './client.ts';

export type CreateIdentity = Pick<AgentEvent, 'agentType' | 'nativeSessionId' | 'cwd' | 'event' | 'nativeTurnId' | 'turnKey' | 'parentNativeSessionId'> & { occurredAt?: string };
export interface CreateCallContext { createContext: string; createIdentifiers: string }
export type CreateContextRequest = (identity: CreateIdentity) => Promise<CreateCallContext>;

export function createOccurredAt(value: unknown): string {
  const row = value && typeof value === 'object' ? value as Record<string, any> : {};
  for (const time of [row.occurredAt, row.timestamp, row.createdAt, row.time?.created, row.time]) {
    if (typeof time !== 'string' && typeof time !== 'number') continue;
    const date = new Date(typeof time === 'number' && time < 1e12 ? time * 1000 : time);
    if (Number.isFinite(date.getTime())) return date.toISOString();
  }
  return new Date().toISOString();
}

/** Unbound hosts may disclose identity metadata, never transcript or prompt bodies. */
export function createIdentity(event: CreateIdentity): CreateIdentity {
  const { agentType, nativeSessionId, cwd, event: kind, nativeTurnId, turnKey, parentNativeSessionId, occurredAt } = event;
  return { agentType, nativeSessionId, cwd, event: kind,
    ...(nativeTurnId ? { nativeTurnId } : {}), ...(turnKey ? { turnKey } : {}),
    ...(parentNativeSessionId ? { parentNativeSessionId } : {}), ...(occurredAt ? { occurredAt } : {}) };
}

export const requestCreateContext: CreateContextRequest = identity => serviceRequest('/api/create-context', createIdentity(identity));
