import { createHash } from 'node:crypto';
import { basename, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { object } from '../_shared/transcript.ts';
import { parseSkillArgs } from '../_shared/skill-records.ts';

export function readKey(tool: unknown, input: unknown): string | undefined {
  if (tool !== 'Read' && tool !== 'read_file') return;
  const args = parseSkillArgs(input);
  const paths = ['path', 'file_path', 'filePath'].filter(key => Object.hasOwn(args, key));
  if (paths.length !== 1 || typeof args[paths[0]!] !== 'string' || !args[paths[0]!]
    || Object.keys(args).some(key => ![...paths, 'offset', 'limit'].includes(key))
    || ['offset', 'limit'].some(key => key in args && !Number.isSafeInteger(args[key]))) return;
  return createHash('sha256').update(JSON.stringify([args[paths[0]!], args.offset, args.limit])).digest('hex');
}

type Call = { id: string; name: string; args: unknown };
export type CursorToolEvidence = { calls: Call[]; results: Map<string, string | undefined> };

/** Cursor CLI's current chat root starts with repeated field 1 (32-byte message blob references).
 * Only the active branch and the user request matching the Hook generation can supply evidence. */
export function cursorToolEvidence(home: string, cwd: string, session: string, generation: string): CursorToolEvidence | undefined {
  if (!session || basename(session) !== session || session === '.' || session === '..') return;
  const workspace = createHash('md5').update(cwd).digest('hex');
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(join(home, '.cursor/chats', workspace, session, 'store.db'), { readOnly: true });
    db.exec('BEGIN');
    const value = db.prepare("SELECT value FROM meta WHERE key='0'").get()?.value;
    if (typeof value !== 'string') return;
    const meta = JSON.parse(Buffer.from(value, 'hex').toString('utf8'));
    if (meta.agentId !== session || typeof meta.latestRootBlobId !== 'string') return;
    const get = db.prepare('SELECT data FROM blobs WHERE id=?');
    const raw = get.get(meta.latestRootBlobId)?.data;
    if (!(raw instanceof Uint8Array)) return;
    const root = Buffer.from(raw);
    const header = db.prepare("SELECT json_extract(CAST(data AS TEXT),'$.role') AS role, json_extract(CAST(data AS TEXT),'$.providerOptions.cursor.requestId') AS request FROM blobs WHERE id=?");
    const calls: Call[] = [], results = new Map<string, string | undefined>();
    let active = false, found = false;
    for (let at = 0; at < root.length && root[at] === 10; at += 34) {
      if (root[at + 1] !== 32 || at + 34 > root.length) return;
      const ref = root.toString('hex', at + 2, at + 34);
      const row = header.get(ref);
      if (!row || !['system', 'user', 'assistant', 'tool'].includes(String(row.role))) return;
      if (row.role === 'user') {
        active = row.request === generation;
        if (active && found) return;
        found ||= active;
      }
      if (!active || (row.role !== 'assistant' && row.role !== 'tool')) continue;
      const bytes = get.get(ref)?.data;
      if (!(bytes instanceof Uint8Array)) return;
      const message = JSON.parse(Buffer.from(bytes).toString('utf8'));
      if (!Array.isArray(message.content)) continue;
      for (const item of message.content.map(object)) {
        if (typeof item.toolName !== 'string' || !item.toolName.trim() || typeof item.toolCallId !== 'string' || !item.toolCallId.trim()) continue;
        if (row.role === 'assistant' && item.type === 'tool-call') calls.push({ id: item.toolCallId, name: item.toolName, args: item.args });
        if (row.role === 'tool' && item.toolName === 'GetDynamicTools' && item.type === 'tool-result') {
          const status = object(object(object(message.providerOptions).cursor).highLevelToolCallResult);
          const usable = !results.has(item.toolCallId) && !item.isError && !item.is_error && !status.isError && typeof item.result === 'string';
          results.set(item.toolCallId, usable ? String(item.result) : undefined);
        }
      }
    }
    if (found && new Set(calls.map(call => call.id)).size === calls.length) return { calls, results };
  } catch { /* Missing, busy or unrecognized native storage cannot establish an identity. */ }
  finally { db?.close(); }
}
