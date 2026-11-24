import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { primePaths } from './sessions.ts';
import { primeSkill } from './skill.ts';

const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const quote = (text: string) => `'${text.replaceAll("'", "'\\''")}'`;
async function read(path: string) {
  try { return await readFile(path, 'utf8'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
}

/** Native Skill installation; migrate only files owned by the old RPC installer. */
export async function installPrime(options: { home?: string } = {}) {
  const home = options.home ?? homedir(), root = join(primePaths(options.home).agent, 'skills/memos-project-memory');
  const manifestPath = join(home, '.memos-project-memory/adapters/prime-agent.json');
  const previous = JSON.parse(await read(manifestPath) ?? '{"files":[]}') as { files: Array<{ path: string; hash: string }> };
  const suffix = import.meta.url.endsWith('.ts') ? 'ts' : 'js';
  const helper = join(root, 'search.mjs');
  const createRoot = join(primePaths(options.home).agent, 'skills/memos-create-project-space');
  const createHelper = join(createRoot, 'create.mjs');
  const base = await readFile(new URL('../../../skills/create-project-space/SKILL.md', import.meta.url), 'utf8');
  const command = `${quote(process.execPath)} ${quote(createHelper)} --name '<user-confirmed name>' --domain '<user-confirmed domain>'`;
  const createSkill = base.replace("memos-pm create --context '<current host-provided creation context>' --name '<user-confirmed name>' --domain '<user-confirmed domain>'", command)
    + "\n## Prime native session identity\n\nThe native wrapper above performs the same memos-pm create operation. Run it only from the current Prime Agent's Python REPL or shell tool and preserve the host-provided RLM_SESSION_ID. The wrapper reads only the exact session's project and current user-turn identity metadata, obtains current-turn creation context, then creates the Space; it also works for unbound projects. Do not set, guess, or copy RLM_SESSION_ID. Do not substitute the most recent session, a tool's working directory, or old search identifiers.\n";
  const writes = [
    { path: helper, text: `await import(${JSON.stringify(new URL(`./skill-runner.${suffix}`, import.meta.url).href)});\n` },
    { path: join(root, 'SKILL.md'), text: primeSkill(`${quote(process.execPath)} ${quote(helper)}`) },
    { path: createHelper, text: `process.argv.splice(2,0,'--create-space');\nawait import(${JSON.stringify(new URL(`./skill-runner.${suffix}`, import.meta.url).href)});\n` },
    { path: join(createRoot, 'SKILL.md'), text: createSkill },
    { path: join(createRoot, 'references/cli-contract.md'), text: await readFile(new URL('../../../skills/create-project-space/references/cli-contract.md', import.meta.url), 'utf8') },
  ];
  for (const [sourceName, installedName] of [['bind-project-space', 'memos-bind-project-space'], ['list-project-spaces', 'memos-list-project-spaces'], ['unbind-project-space', 'memos-unbind-project-space']]) {
    for (const relative of ['SKILL.md', 'references/cli-contract.md']) {
      writes.push({ path: join(primePaths(options.home).agent, 'skills', installedName!, relative),
        text: await readFile(new URL(`../../../skills/${sourceName}/${relative}`, import.meta.url), 'utf8') });
    }
  }
  for (const item of writes) {
    const existing = await read(item.path);
    if (existing !== null && existing !== item.text && !previous.files?.some(file => file.path === item.path && file.hash === hash(existing)))
      throw new Error(`Existing file is not owned by MemOS: ${item.path}`);
  }
  for (const item of writes) { await mkdir(dirname(item.path), { recursive: true }); await writeFile(item.path, item.text); }
  for (const old of previous.files ?? []) {
    if (writes.some(item => item.path === old.path)) continue;
    const existing = await read(old.path);
    if (existing !== null && hash(existing) === old.hash) await rm(old.path);
  }
  await mkdir(dirname(manifestPath), { recursive: true });
  await writeFile(manifestPath, JSON.stringify({ installed: true, files: writes.map(item => ({ path: item.path, hash: hash(item.text) })) }, null, 2) + '\n');
  return { installed: true, files: writes.map(item => item.path), instructions: [
    '请重新启动 Prime Agent 或执行 /reload 加载项目记忆 Skill，按原来的终端方式对话即可。',
    '在 Viewer 中绑定当前 Prime Agent 项目与 Space，并保持本地插件服务运行；本轮结束且原生轨迹完整后自动上传。',
  ] };
}
