import { lstat, readdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { object } from './_shared/transcript.ts';

function parse(value: string): Record<string, unknown> {
  try { return object(JSON.parse(value)); } catch { return {}; }
}

/** Read names from known host metadata; message bodies are never title sources. */
export async function readSessionTitles(agentType: string, directory?: string): Promise<Map<string, { title: string; titleRevision: number }>> {
  const titles = new Map<string, { title: string; titleRevision: number }>();
  if (agentType === 'codex-cli') {
    const index = join(directory ?? process.env.CODEX_HOME ?? join(homedir(), '.codex'), 'session_index.jsonl');
    let content: string;
    try {
      if (!(await lstat(index)).isFile()) return titles;
      content = await readFile(index, 'utf8');
    } catch { return titles; }
    for (const line of content.split('\n')) {
      const row = parse(line);
      if (typeof row.id !== 'string' || !row.id.trim() || typeof row.thread_name !== 'string' || !row.thread_name.trim() || typeof row.updated_at !== 'string') continue;
      const time = Date.parse(row.updated_at);
      if (!Number.isFinite(time) || time < (titles.get(row.id)?.titleRevision ?? -Infinity)) continue;
      titles.set(row.id, { title: row.thread_name, titleRevision: time });
    }
  } else if (agentType === 'deepseek-harness') {
    const path = join(directory ?? process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'storages/session_projcache/sessions');
    let entries;
    try { entries = await readdir(path, { withFileTypes: true }); } catch { return titles; }
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.json') || entry.name === '.json') continue;
      let data: Record<string, unknown>;
      try { data = parse(await readFile(join(path, entry.name), 'utf8')); } catch { continue; }
      const record = object(data.record), identity = object(record.identity), title = object(object(record.rows).title);
      // In the host's per-record cache, the filename is the session ID key;
      // identity contains immutable log-header fields, not another session ID.
      if (data.version !== 7 || typeof identity.cwd !== 'string' || !isAbsolute(identity.cwd) || typeof identity.createdAt !== 'number'
        || title.ver !== 1 || !Number.isSafeInteger(title.seq) || Number(title.seq) < 0 || typeof title.val !== 'string' || !title.val.trim()) continue;
      titles.set(entry.name.slice(0, -5), { title: title.val, titleRevision: Number(title.seq) });
    }
  }
  return titles;
}
