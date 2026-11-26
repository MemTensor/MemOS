// Read the host's LevelDB files as bytes. Opening the database would take its
// writer lock. Only the journal, SSTable and Snappy encodings used by Chromium
// are recognized; partial or unsupported records never establish a reply.
import { readFile, readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { deserialize } from 'node:v8';
import { object } from '../_shared/transcript.ts';
import type { DoubaoTurn } from './host.ts';

export const doubaoChatCachePath = (home = homedir()) =>
  join(home, 'Library/Application Support/DoubaoWork/Default/IndexedDB/chrome_doubaowork-chat_0.indexeddb.leveldb');

function invalid(): never { throw new RangeError('Incomplete Doubao cache record'); }

class Bytes {
  data: Buffer;
  pos = 0;
  constructor(data: Buffer) { this.data = data; }
  take(length: number): Buffer {
    if (!Number.isSafeInteger(length) || length < 0 || length > this.data.length - this.pos) invalid();
    this.pos += length;
    return this.data.subarray(this.pos - length, this.pos);
  }
  uint(): number {
    let value = 0;
    for (let factor = 1; Number.isSafeInteger(factor); factor *= 128) {
      const byte = this.take(1)[0];
      value += (byte & 127) * factor;
      if (byte < 128 && Number.isSafeInteger(value)) return value;
    }
    return invalid();
  }
  field() { return this.take(this.uint()); }
}

// Raw Snappy blocks, used both by LevelDB tables and Blink's value wrapper.
function snappy(data: Buffer): Buffer {
  const input = new Bytes(data), size = input.uint();
  // A copy tag expands to at most 64 bytes, which bounds even corrupt headers.
  if (size > 64 * (data.length - input.pos)) invalid();
  const output = Buffer.alloc(size);
  let written = 0;
  while (input.pos < data.length) {
    const tag = input.take(1)[0], kind = tag & 3;
    let length = tag >>> 2;
    if (kind === 0) {
      if (length >= 60) { const bytes = input.take(length - 59); length = bytes.readUIntLE(0, bytes.length); }
      length++;
      if (length > size - written) invalid();
      input.take(length).copy(output, written);
    } else {
      const bytes = input.take(kind === 3 ? 4 : kind);
      const offset = bytes.readUIntLE(0, bytes.length) + (kind === 1 ? (tag & 224) << 3 : 0);
      length = kind === 1 ? 4 + (length & 7) : length + 1;
      if (!offset || offset > written || length > size - written) invalid();
      for (let i = 0; i < length; i++) output[written + i] = output[written + i - offset];
    }
    written += length;
  }
  if (written !== size) invalid();
  return output;
}

const crcTable = Uint32Array.from({ length: 256 }, (_, byte) => {
  for (let i = 0; i < 8; i++) byte = (byte >>> 1) ^ ((byte & 1) ? 0x82f63b78 : 0);
  return byte;
});
function checksum(data: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of data) crc = crcTable[(crc ^ byte) & 255] ^ (crc >>> 8);
  crc = ~crc;
  return (((crc >>> 15 | crc << 17) >>> 0) + 0xa282ead8) >>> 0;
}
type Visit = (key: Buffer, sequence: bigint, value?: Buffer) => void;
function batch(data: Buffer, visit: Visit) {
  const input = new Bytes(data), header = input.take(12), sequence = header.readBigUInt64LE();
  for (let i = 0; i < header.readUInt32LE(8); i++) {
    const type = input.take(1)[0], key = input.field();
    if (type !== 0 && type !== 1) invalid();
    visit(key, sequence + BigInt(i), type === 1 ? input.field() : undefined);
  }
  if (input.pos !== data.length) invalid();
}
function journal(data: Buffer, visit: Visit) {
  let parts: Buffer[] | undefined;
  for (let offset = 0; offset < data.length; offset += 32768) {
    const block = data.subarray(offset, offset + 32768);
    let i = 0;
    while (i + 7 <= block.length) {
      const length = block.readUInt16LE(i + 4), type = block[i + 6], end = i + 7 + length;
      if (!type && !length) break;
      if (end > block.length || checksum(block.subarray(i + 6, end)) !== block.readUInt32LE(i)) invalid();
      const record = block.subarray(i + 7, end);
      if (type === 1 && !parts) batch(record, visit);
      else if (type === 2 && !parts) parts = [record];
      else if ((type === 3 || type === 4) && parts) {
        parts.push(record);
        if (type === 4) { batch(Buffer.concat(parts), visit); parts = undefined; }
      } else invalid();
      i = end;
    }
    // Only zero padding may follow complete records at a block boundary.
    if (block.subarray(i).some(byte => byte !== 0)) invalid();
  }
  if (parts) invalid();
}

function tableBlock(file: Buffer, handle: Bytes) {
  const offset = handle.uint(), length = handle.uint(), end = offset + length;
  if (end + 5 > file.length || checksum(file.subarray(offset, end + 1)) !== file.readUInt32LE(end + 1)) invalid();
  const block = file.subarray(offset, end);
  if (file[end] === 0) return block;
  if (file[end] === 1) return snappy(block);
  return invalid();
}
function* entries(block: Buffer) {
  const count = block.readUInt32LE(block.length - 4), end = block.length - (count + 1) * 4;
  if (!count || end < 0) invalid();
  const input = new Bytes(block.subarray(0, end));
  let key: Buffer = Buffer.alloc(0);
  while (input.pos < end) {
    const shared = input.uint(), rest = input.uint(), length = input.uint();
    if (shared > key.length) invalid();
    key = Buffer.concat([key.subarray(0, shared), input.take(rest)]);
    yield { key, value: input.take(length) };
  }
}
function table(data: Buffer, visit: Visit) {
  if (data.length < 48 || data.readBigUInt64LE(data.length - 8) !== 0xdb4775248b80fb57n) invalid();
  const footer = new Bytes(data.subarray(-48, -8));
  footer.uint(); footer.uint(); // metaindex handle precedes the data index
  for (const index of entries(tableBlock(data, footer))) {
    for (const { key, value } of entries(tableBlock(data, new Bytes(index.value)))) {
      const tag = key.readBigUInt64LE(key.length - 8), type = tag & 255n;
      if (type !== 0n && type !== 1n) invalid();
      visit(key.subarray(0, -8), tag >> 8n, type === 1n ? value : undefined);
    }
  }
}

function cacheWire(value: Buffer) {
  const input = new Bytes(value);
  input.uint(); // Blink object-store record version
  let wire = value.subarray(input.pos);
  if (wire[0] === 255 && wire[1] === 17 && wire[2] === 2) wire = snappy(wire.subarray(3));
  return wire;
}

function decodeWire(wire: Buffer) {
  // A Blink version/trailer header may precede the V8 wire header.
  const header = wire.indexOf(Buffer.from([255, 15]));
  if (header >= 0 && header <= 23) return deserialize(wire.subarray(header)) as unknown;
}

function replies(value: Buffer, turn: DoubaoTurn, found: Set<string>) {
  const wire = cacheWire(value);
  if (!wire.includes(Buffer.from(turn.answerId)) && !wire.includes(Buffer.from(turn.answerId, 'utf16le'))) return;
  const stack: unknown[] = [decodeWire(wire)], seen = new Set<object>();
  while (stack.length) {
    const node = stack.pop();
    if (!node || typeof node !== 'object' || seen.has(node) || ArrayBuffer.isView(node)) continue;
    seen.add(node);
    const record = object(node);
    if ('message_id' in record || 'content_blocks_v2' in record) {
      if (record.conversation_id === turn.sessionId && record.reply_id === turn.questionId && record.message_id === turn.answerId
        && object(record.ext).finish_reason_chat === 'succeed:completion' && Array.isArray(record.content_blocks_v2)) {
        const last = object(record.content_blocks_v2.at(-1)), text = object(object(last.content).text_block).text;
        if (last.is_finish === true && typeof text === 'string' && text.trim()) found.add(text);
      }
      continue; // Never descend into message bodies, tool outputs or quoted replies.
    }
    for (const [key, child] of Object.entries(node)) {
      if (['content', 'text', 'tool_calls', 'arguments', 'thinking', 'reasoning', 'reasoning_content', 'ext'].includes(key)) continue;
      if (typeof child === 'object') stack.push(child);
      else if (typeof child === 'string' && ['value', 'data', 'payload'].includes(key) && child.includes(turn.answerId)) {
        try { stack.push(JSON.parse(child)); } catch { /* not a serialized cache container */ }
      }
    }
  }
}

async function readCache(directory: string, collect: Visit) {
  for (const file of await readdir(directory, { withFileTypes: true })) {
    if (!file.isFile() || !/^\d+\.(log|ldb)$/.test(file.name)) continue;
    const data = await readFile(join(directory, file.name));
    if (file.name.endsWith('.log')) journal(data, collect);
    else table(data, collect);
  }
}

export async function cachedDoubaoReply(directory: string, turn: DoubaoTurn): Promise<string | null | undefined> {
  try {
    const latest = new Map<string, { sequence: bigint; texts: Set<string> }>();
    const collect: Visit = (key, sequence, value) => {
      // The observed IndexedDB key prefix encodes a one-byte database and
      // object-store ID followed by the object-store data index (1).
      if (key.length < 5 || key[0] !== 0 || key[3] !== 1) return;
      const id = key.toString('hex'), prior = latest.get(id);
      if (prior && sequence < prior.sequence) return;
      const texts = prior?.sequence === sequence ? prior.texts : new Set<string>();
      if (value?.length) replies(value, turn, texts);
      latest.set(id, { sequence, texts });
    };
    await readCache(directory, collect);
    const found = new Set([...latest.values()].flatMap(item => [...item.texts]));
    if (found.size > 1) return null; // contradictory successful replies for one answer
    return [...found][0];
  } catch { return undefined; } // cache rotation, partial writes or unfamiliar encoding
}

function projectRows(snapshot: unknown) {
  const record = object(snapshot), data = object(record.data);
  if (record.schema !== 'conversation-list-data-project-v4' || data.hasMore !== false || !Array.isArray(data.projects)) invalid();
  const projects = new Map<string, {name: string; root: string} | null>();
  const ids = new Set<string>();
  for (const item of data.projects) {
    const {projectId, name, conversations} = object(item);
    if (typeof projectId !== 'string' || !projectId || ids.has(projectId) || typeof name !== 'string' || !name.trim()) invalid();
    ids.add(projectId);
    if (conversations === undefined) continue;
    if (!Array.isArray(conversations)) invalid();
    const roots = new Set<string>();
    for (const item of conversations) {
      const member = object(item);
      if (object(member.project_reference).project_id !== projectId) continue;
      const extra = typeof member.extra === 'string' ? object(JSON.parse(member.extra)) : object(member.extra);
      const param = extra.agent_task_param;
      const {workspace} = typeof param === 'string' ? object(JSON.parse(param)) : object(param);
      if (typeof workspace !== 'string' || !isAbsolute(workspace) || workspace.includes('\0')) continue;
      roots.add(resolve(workspace));
    }
    for (const root of roots) {
      // A single root must identify exactly one native project in both directions.
      projects.set(root, roots.size === 1 && !projects.has(root) ? {name, root} : null);
    }
  }
  return [...projects.values()].filter(project => project !== null);
}

export async function discoverDoubaoProjects({home}: {home?: string} = {}) {
  const latest = new Map<string, {sequence: bigint; value?: Buffer}>();
  // IndexedDB string key: type, character count, then UTF-16BE characters.
  const keyBytes = Buffer.concat([Buffer.from([1, 7]), Buffer.from('project', 'utf16le').swap16()]);
  try {
    await readCache(doubaoChatCachePath(home), (key, sequence, value) => {
      if (key[0] !== 0 || key[3] !== 1 || !key.subarray(4).equals(keyBytes)) return;
      const id = key.toString('hex'), prior = latest.get(id);
      if (prior?.sequence === sequence && (value ? !prior.value?.equals(value) : prior.value !== undefined)) invalid();
      if (!prior || sequence > prior.sequence) latest.set(id, {sequence, value});
    });
    const active = [...latest.values()].filter(entry => entry.value);
    if (active.length !== 1) invalid();
    return projectRows(decodeWire(cacheWire(active[0]!.value!)));
  } catch {
    throw new Error('未能读取豆包工作完整的本地项目列表，请在豆包工作中打开项目列表后刷新。');
  }
}
