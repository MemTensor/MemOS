import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { object, textField } from '../_shared/transcript.ts';
import { isInjected } from '../_shared/task-trace.ts';

export interface AntigravityUserIdentity { nativeTurnId: string; occurredAt?: string }

function nativeUser(value: unknown): Record<string, unknown> | undefined {
  const raw = object(value), message = object(raw.message), payload = object(raw.payload);
  const user = [message, raw, payload].find(row => row.role === 'user');
  if (!user || [raw, message, payload, user].some(isInjected)) return;
  // A user-role envelope of tool results is execution output, not a new submission.
  if (Array.isArray(user.content) && user.content.length
    && user.content.every(part => ['tool_result', 'tool-result', 'function_call_output'].includes(String(object(part).type)))) return;
  return user;
}

/** Project IDs, role and source metadata only; task text is never normalized or returned. */
export function antigravityUserIdentity(value: unknown): AntigravityUserIdentity | undefined {
  const raw = object(value), message = object(raw.message), payload = object(raw.payload), user = nativeUser(value);
  if (!user) return;
  const id = textField(raw, 'uuid', 'id', 'message_id', 'messageId') ?? textField(message, 'id') ?? textField(payload, 'id');
  const nativeTurnId = textField(raw, 'turn_id', 'prompt_id', 'generation_id', 'turnId') ?? textField(payload, 'turn_id')
    ?? (id ? `antigravity:user:${id}` : undefined);
  if (!nativeTurnId) return;
  for (const time of [raw.timestamp, raw.occurredAt, raw.createdAt, user.timestamp, user.createdAt]) {
    if (typeof time !== 'string' && typeof time !== 'number') continue;
    const date = new Date(typeof time === 'number' && time < 1e12 ? time * 1000 : time);
    if (Number.isFinite(date.getTime())) return { nativeTurnId, occurredAt: date.toISOString() };
  }
  return { nativeTurnId };
}

/** The Hook supplies the exact source path; no recency discovery or body cache is used. */
export async function readAntigravityIdentity(path: string, nativeSessionId: string): Promise<AntigravityUserIdentity | undefined> {
  const stream = createReadStream(path, { encoding: 'utf8' });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  let latest: AntigravityUserIdentity | undefined;
  try {
    for await (const line of lines) {
      if (!line.trim()) continue;
      const raw = object(JSON.parse(line)), payload = object(raw.payload);
      const headerId = raw.type === 'session' ? textField(raw, 'id', 'session_id')
        : raw.type === 'session_meta' ? textField(payload, 'id', 'session_id') : undefined;
      if (headerId && headerId !== nativeSessionId) return;
      // An unidentifiable newer user invalidates older candidates; no recency guess.
      if (nativeUser(raw)) latest = antigravityUserIdentity(raw);
    }
    return latest;
  } finally { lines.close(); stream.destroy(); }
}
