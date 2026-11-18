import { readdir, readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { stripTypeScriptTypes } from 'node:module';
async function check(dir) {
 for (const entry of await readdir(dir, { withFileTypes: true })) {
  const path = join(dir, entry.name);
  if (entry.isDirectory()) { await check(path); continue; }
  if (!/\.(?:ts|js|mjs)$/.test(path)) continue;
  const source = await readFile(path, 'utf8');
  const input = path.endsWith('.ts') ? stripTypeScriptTypes(source) : source;
  const result = spawnSync(process.execPath, ['--input-type=module', '--check'], { encoding: 'utf8', input });
  if (result.status) { process.stderr.write(result.stderr); process.exitCode = 1; }
 }
}
for (const dir of ['src', 'viewer', 'dev', 'scripts']) await check(dir);
