import { homedir } from 'node:os';
import { join } from 'node:path';
import type { AgentEvent } from '../types.ts';
import { object, observed, textField } from '../_shared/transcript.ts';

/** Claude hooks notify the durable reader; only transcript records become task messages. */
export function claudeNotification(event: AgentEvent, name: string, env: NodeJS.ProcessEnv): AgentEvent {
  const raw = object(event.raw);
  const expand = (path: string | undefined) => path?.startsWith('~/') ? join(env.HOME ?? homedir(), path.slice(2)) : path;
  return { ...event, records: [], raw: observed({ ...raw, hook_event_name: name,
    transcript_path: expand(textField(raw, 'transcript_path', 'transcriptPath')),
    agent_transcript_path: expand(textField(raw, 'agent_transcript_path')),
  }) };
}
