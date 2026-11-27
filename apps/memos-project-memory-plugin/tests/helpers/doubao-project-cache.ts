import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { serialize } from 'node:v8';
import { doubaoChatCachePath } from '../../src/adapters/doubao-work/capture.ts';

export function varint(value: number): Buffer {
  const bytes: number[] = [];
  while (value >= 128) { bytes.push(value % 128 + 128); value = Math.floor(value / 128); }
  return Buffer.from([...bytes, value]);
}

export function checksum(data: Buffer) {
  let crc = 0xffffffff;
  for (const b of data) {
    crc ^= b;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0x82f63b78 : 0);
  }
  crc = ~crc;
  return (((crc >>> 15 | crc << 17) >>> 0) + 0xa282ead8) >>> 0;
}

export function cacheWrite(key: Buffer, record?: unknown, sequence = 1n) {
  const value = Buffer.concat([Buffer.from([1]), serialize(record)]);
  const batch = Buffer.concat([Buffer.alloc(12), Buffer.from([record === undefined ? 0 : 1]), varint(key.length), key,
    ...(record === undefined ? [] : [varint(value.length), value])]);
  batch.writeBigUInt64LE(sequence);
  batch.writeUInt32LE(1, 8);
  const header = Buffer.alloc(7);
  header.writeUInt16LE(batch.length, 4);
  header[6] = 1;
  header.writeUInt32LE(checksum(Buffer.concat([header.subarray(6), batch])));
  return Buffer.concat([header, batch]);
}

export const projectKey = Buffer.concat([Buffer.from([0, 4, 2, 1, 1, 7]), Buffer.from('project', 'utf16le').swap16()]);
export function projectSnapshot(projects: {name: string; root: string}[], hasMore = false) {
  return { schema: 'conversation-list-data-project-v4', data: { hasMore, projects: projects.map(({name, root}, i) => ({
    name, projectId: String(i + 1), conversations: [{
      project_reference: {project_id: String(i + 1)},
      extra: JSON.stringify({agent_task_param: JSON.stringify({workspace: root})}),
    }],
  })) }};
}
export async function writeDoubaoProjects(home: string, projects: {name: string; root: string}[], hasMore = false) {
  const directory = doubaoChatCachePath(home);
  await mkdir(directory, {recursive: true});
  await writeFile(join(directory, '000001.log'), cacheWrite(projectKey, projectSnapshot(projects, hasMore)));
}
