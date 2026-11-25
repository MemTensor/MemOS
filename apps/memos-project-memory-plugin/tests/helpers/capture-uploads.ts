import assert from 'node:assert/strict';
import type { Message } from '../../src/adapters/types.ts';
import type { CloudClient } from '../../src/cloud/client.ts';

export function captureUploads() {
  const uploads: { space_ids: string[]; messages: Message[] }[] = [];
  const call: CloudClient['call'] = async <T>(endpoint: string, body: unknown): Promise<T> => {
    if (endpoint === 'get/status') return { status: 'completed', memory_views: { project: { open_episode_messages: 0 } } } as T;
    assert.equal(endpoint, 'add/message');
    uploads.push(structuredClone(body) as (typeof uploads)[number]);
    return { success: true, task_id: `task-${uploads.length}` } as T;
  };
  return { uploads, call };
}
