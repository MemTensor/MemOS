import { createReadStream, type Dirent } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, isAbsolute, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { DatabaseSync } from 'node:sqlite';
import { createZstdDecompress } from 'node:zlib';
import { object } from './_shared/transcript.ts';
import { workbuddyConfigDir } from './workbuddy/paths.ts';
import { discoverPrimeProjects } from './prime-agent/projects.ts';

export type Project = { name: string; root: string };

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

/** Extract only the top-level cwd scalar emitted by Copilot's workspace writer. */
function copilotDirectory(text: string): string | undefined {
  const lines = text.split('\n');
  const index = lines.findIndex(line => /^cwd:/.test(line));
  if (index < 0 || index === lines.length - 1) return undefined;
  const value = lines[index]!.slice(4).trim();
  if (value.startsWith('"')) {
    try { const decoded: unknown = JSON.parse(value); return typeof decoded === 'string' ? decoded : undefined; }
    catch { return undefined; }
  }
  if (value.startsWith("'")) return /^'(?:[^']|'')*'$/.test(value) ? value.slice(1, -1).replaceAll("''", "'") : undefined;
  if (/^\|[+-]?$/.test(value)) {
    const content: string[] = [];
    for (const line of lines.slice(index + 1, -1)) {
      if (line && !line.startsWith('  ')) break;
      content.push(line.slice(2));
    }
    const body = content.join('\n') + '\n';
    return value === '|+' ? body : body.replace(/\n+$/, '') + (value === '|' ? '\n' : '');
  }
  return value;
}

/** Discover existing host projects without starting agents or registering local state. */
export async function discoverProjects(agentType: string, options: { home?: string } = {}): Promise<Project[]> {
  if (agentType === 'prime-agent') return discoverPrimeProjects(options);
  const home = options.home ?? homedir();
  const base = (variable: string, fallback: string) => options.home ? join(home, fallback) : process.env[variable] || join(home, fallback);
  const projects = new Map<string, Project>();
  const add = (value: unknown, name?: unknown) => {
    if (typeof value !== 'string' || !isAbsolute(value)) return;
    const root = resolve(value);
    projects.set(root, { name: typeof name === 'string' && name.trim() ? name.trim() : basename(root) || root, root });
  };
  const fromHeader = async (path: string, select: (row: Record<string, unknown>) => unknown) => {
    for (const line of (await header(path)).split('\n')) {
      const cwd = select(parse(line));
      if (typeof cwd === 'string' && isAbsolute(cwd)) { add(cwd); return true; }
    }
    return false;
  };
  const fromHeaders = async (paths: string[], select: (row: Record<string, unknown>) => unknown) => {
    for (const path of paths) await fromHeader(path, select);
  };
  // Claude and Pi group sessions by project directory. One valid header is
  // enough to identify a directory; session enumeration belongs to history.
  const fromDirectories = async (root: string, select: (row: Record<string, unknown>) => unknown) => {
    for (const entry of await entries(root)) {
      const path = join(root, entry.name);
      if (entry.isFile() && entry.name.endsWith('.jsonl')) await fromHeader(path, select);
      else if (entry.isDirectory()) for (const file of await files(path, 0, name => name.endsWith('.jsonl'))) {
        if (await fromHeader(file, select)) break;
      }
    }
  };
  if (agentType === 'claude-code') {
    await fromDirectories(join(base('CLAUDE_CONFIG_DIR', '.claude'), 'projects'), row => row.cwd);
  } else if (agentType === 'copilot-cli') {
    for (const path of await files(join(base('COPILOT_HOME', '.copilot'), 'session-state'), 1, name => name === 'workspace.yaml'))
      add(copilotDirectory(await header(path)));
  } else if (agentType === 'cursor-cli') {
    const chats = join(home, '.cursor/chats'), workspaces = join(home, '.cursor/projects');
    for (const group of await entries(chats)) {
      if (!group.isDirectory()) continue;
      for (const session of await entries(join(chats, group.name))) {
        if (!session.isDirectory()) continue;
        for (const path of await files(join(chats, group.name, session.name), 0, name => name === 'meta.json'))
          add(parse(await readFile(path, 'utf8').catch(() => '{}')).cwd);
      }
    }
    for (const project of await entries(workspaces)) {
      if (!project.isDirectory()) continue;
      for (const path of await files(join(workspaces, project.name), 0, name => name === '.workspace-trusted'))
        add(parse(await readFile(path, 'utf8').catch(() => '{}')).workspacePath);
    }
  } else if (agentType === 'codex-cli') {
    const codexHome = base('CODEX_HOME', '.codex');
    for (const directory of ['sessions', 'archived_sessions']) {
      await fromHeaders(await files(join(codexHome, directory), 3, name => /^rollout-.*\.jsonl$/.test(name)),
        row => row.type === 'session_meta' ? object(row.payload).cwd : undefined);
    }
    // Desktop projects exist before their first session. Read the full state:
    // local-projects may occur beyond the bounded transcript header window.
    const state = parse(await readFile(join(codexHome, '.codex-global-state.json'), 'utf8').catch(() => '{}'));
    for (const value of Object.values(object(state['local-projects']))) {
      const project = object(value);
      if (Array.isArray(project.rootPaths)) {
        for (const root of project.rootPaths) add(root, project.name);
      }
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
        if (logs[0] && await fromHeader(join(directory, logs[0].name), row => row.type === 'session' ? row.cwd : undefined)) break;
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
    const root = await workbuddyConfigDir(options.home);
    await fromDirectories(join(root, 'projects'), row => row.cwd);
    for (const path of await files(join(root, 'projects'), 3, name => name.endsWith('.meta.json'))) {
      add(parse(await header(path)).cwd);
    }
    let db: DatabaseSync | undefined;
    try {
      db = new DatabaseSync(join(root, 'workbuddy.db'), { readOnly: true });
      for (const row of db.prepare("SELECT name,COALESCE(NULLIF(primary_folder_path,''),create_folder_path) AS path FROM spaces WHERE status='active' AND deleted_at=-1 AND transport='local'").all()) add(row.path, row.name);
    } catch { /* Keep transcript discovery when the native index is absent or unavailable. */ }
    finally { db?.close(); }
  } else if (agentType === 'pi') {
    await fromDirectories(join(base('PI_CODING_AGENT_DIR', '.pi/agent'), 'sessions'),
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
