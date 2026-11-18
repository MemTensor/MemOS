import { createReadStream, type Dirent } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, isAbsolute, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { DatabaseSync } from 'node:sqlite';
import { createZstdDecompress } from 'node:zlib';
import { object } from './_shared/transcript.ts';

type Project = { name: string; root: string };

async function entries(path: string): Promise<Dirent[]> {
  try { return await readdir(path, { withFileTypes: true }); }
  catch { return []; }
}

/** Only known host storage layouts are traversed; symlinks are never followed. */
async function files(path: string, depth: number, matches: (name: string) => boolean): Promise<string[]> {
  const result: string[] = [];
  for (const entry of await entries(path)) {
    const child = join(path, entry.name);
    if (entry.isFile() && matches(entry.name)) result.push(child);
    else if (entry.isDirectory() && depth > 0) result.push(...await files(child, depth - 1, matches));
  }
  return result;
}

/** Read at most 64 KiB of decoded header, even for compressed session logs. */
async function header(path: string): Promise<string> {
  const source = createReadStream(path, path.endsWith('.zstd') ? {} : { end: 65535 });
  const stream = path.endsWith('.zstd') ? source.pipe(createZstdDecompress()) : source;
  source.on('error', error => stream.destroy(error));
  const chunks: Buffer[] = [];
  let length = 0;
  try {
    for await (const chunk of stream) {
      const part = Buffer.from(chunk).subarray(0, 65536 - length);
      chunks.push(part);
      length += part.length;
      if (length >= 65536) break;
    }
    return Buffer.concat(chunks).toString('utf8');
  } catch { return ''; }
  finally { source.destroy(); stream.destroy(); }
}

function parse(text: string): Record<string, unknown> {
  try { return object(JSON.parse(text)); }
  catch { return {}; }
}

/** Discover existing host projects without starting agents or registering local state. */
export async function discoverProjects(agentType: string, options: { home?: string } = {}): Promise<Project[]> {
  const home = options.home ?? homedir();
  const base = (variable: string, fallback: string) => options.home ? join(home, fallback) : process.env[variable] || join(home, fallback);
  const projects = new Map<string, Project>();
  const add = (value: unknown) => {
    if (typeof value !== 'string' || !isAbsolute(value)) return;
    const root = resolve(value);
    projects.set(root, { name: basename(root) || root, root });
  };
  const fromHeaders = async (paths: string[], select: (row: Record<string, unknown>) => unknown) => {
    for (const path of paths) {
      for (const line of (await header(path)).split('\n')) {
        const cwd = select(parse(line));
        if (typeof cwd === 'string' && isAbsolute(cwd)) { add(cwd); break; }
      }
    }
  };
  if (agentType === 'claude-code') {
    await fromHeaders(await files(join(base('CLAUDE_CONFIG_DIR', '.claude'), 'projects'), 1, name => name.endsWith('.jsonl')),
      row => row.cwd);
  } else if (agentType === 'codex-cli') {
    for (const directory of ['sessions', 'archived_sessions']) {
      await fromHeaders(await files(join(base('CODEX_HOME', '.codex'), directory), 3, name => /^rollout-.*\.jsonl$/.test(name)),
        row => row.type === 'session_meta' ? object(row.payload).cwd : undefined);
    }
  } else if (agentType === 'deepseek-harness') {
    const root = join(base('DSH_HOME', '.dsh'), 'sessions');
    for (const project of await entries(root)) {
      if (!project.isDirectory()) continue;
      for (const session of await entries(join(root, project.name))) {
        if (!session.isDirectory()) continue;
        const directory = join(root, project.name, session.name);
        const logs = (await entries(directory)).filter(entry => entry.isFile() && /^session(?:\.v\d+)?\.jsonl(?:\.zstd)?$/.test(entry.name));
        logs.sort((a, b) => Number(/\.v(\d+)/.exec(b.name)?.[1] ?? 0) - Number(/\.v(\d+)/.exec(a.name)?.[1] ?? 0) || Number(b.name.endsWith('.zstd')) - Number(a.name.endsWith('.zstd')));
        if (logs[0]) await fromHeaders([join(directory, logs[0].name)], row => row.type === 'session' ? row.cwd : undefined);
      }
    }
  } else if (agentType === 'kimi-code') {
    const stream = createReadStream(join(base('KIMI_CODE_HOME', '.kimi-code'), 'session_index.jsonl'));
    const lines = createInterface({ input: stream, crlfDelay: Infinity });
    // Forward file errors into the iterator rather than emitting an unhandled stream error.
    stream.on('error', () => lines.close());
    try { for await (const line of lines) add(parse(line).workDir); }
    catch { /* Missing or malformed indexes simply have no discoverable projects. */ }
    finally { lines.close(); stream.destroy(); }
  } else if (agentType === 'workbuddy') {
    for (const path of await files(join(base('WORKBUDDY_CONFIG_DIR', '.workbuddy'), 'projects'), 3, name => name.endsWith('.meta.json'))) {
      add(parse(await header(path)).cwd);
    }
  } else if (agentType === 'pi') {
    await fromHeaders(await files(join(base('PI_CODING_AGENT_DIR', '.pi/agent'), 'sessions'), 1, name => name.endsWith('.jsonl')),
      row => row.type === 'session' ? row.cwd : undefined);
  } else if (agentType === 'opencode-v1' || agentType === 'opencode-v2') {
    const data = options.home ? join(home, '.local/share') : process.env.XDG_DATA_HOME || join(home, '.local/share');
    let db: DatabaseSync | undefined;
    try {
      db = new DatabaseSync(join(data, 'opencode', 'opencode.db'), { readOnly: true });
      const table = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='session_v2'").get() ? 'session_v2' : 'session';
      for (const row of db.prepare(`SELECT DISTINCT directory FROM ${table}`).all()) add(row.directory);
    } catch { /* No database, an older schema or a temporarily locked host is unavailable. */ }
    finally { db?.close(); }
  }
  return [...projects.values()].sort((a, b) => a.root.localeCompare(b.root));
}
