import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { installedSkills } from '../../src/adapters/installer.ts';

const hash = (text: string) => createHash('sha256').update(text).digest('hex');
async function fixture(t: test.TestContext) {
  const home = await mkdtemp(join(tmpdir(), 'pm-owned-skills-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const manifest = join(home, '.memos-project-memory/adapters/codex-cli.json');
  await mkdir(dirname(manifest), { recursive: true });
  return { home, manifest };
}

test('owned Skills reuse hook, legacy and native installation manifests', async t => {
  for (const kind of ['hook', 'legacy', 'native']) await t.test(kind, async t => {
    const { home, manifest } = await fixture(t);
    const path = join(home, `skills/memos-owned-${kind}/SKILL.md`), body = 'installed instruction';
    await mkdir(dirname(path), { recursive: true }); await writeFile(path, body);
    const entry = { path, hash: hash(body) };
    await writeFile(manifest, JSON.stringify(kind === 'hook' ? { skillFiles: [entry] }
      : kind === 'legacy' ? { skillFile: path, skillHash: entry.hash } : { files: [entry] }));
    const owned = installedSkills('codex-cli', home);
    assert.ok(owned.has(path)); assert.ok(owned.has(await realpath(path)));
    assert.ok(owned.has(`memos-owned-${kind}`));
  });
});

test('owned Skills include the real path of an installer-owned symlink', async t => {
  const { home, manifest } = await fixture(t);
  const target = join(home, 'real/SKILL.md'), path = join(home, 'skills/memos-linked/SKILL.md');
  await mkdir(dirname(target), { recursive: true }); await writeFile(target, 'linked instruction');
  await mkdir(dirname(path), { recursive: true }); await symlink(target, path);
  await writeFile(manifest, JSON.stringify({ skillFiles: [{ path, hash: hash('linked instruction') }] }));
  const owned = installedSkills('codex-cli', home);
  assert.ok(owned.has(path)); assert.ok(owned.has(await realpath(target))); assert.ok(owned.has('memos-linked'));
});

test('modified, missing, unregistered and non-Skill files never establish ownership', async t => {
  const { home, manifest } = await fixture(t);
  const changed = join(home, 'skills/memos-changed/SKILL.md');
  const unknown = join(home, 'project/memos-project-memory/SKILL.md');
  const contract = join(home, 'skills/memos-contract/references/cli-contract.md');
  const missing = join(home, 'skills/memos-missing/SKILL.md');
  for (const path of [changed, unknown, contract]) {
    await mkdir(dirname(path), { recursive: true }); await writeFile(path, 'current text');
  }
  await writeFile(manifest, JSON.stringify({ files: [
    { path: changed, hash: hash('old text') }, { path: missing, hash: hash('current text') },
    { path: contract, hash: hash('current text') }, { path: 'relative/SKILL.md', hash: hash('current text') },
  ] }));
  const owned = installedSkills('codex-cli', home);
  for (const path of [changed, missing, unknown, contract]) assert.ok(!owned.has(path), path);
  for (const name of ['memos-changed', 'memos-missing', 'memos-project-memory', 'memos-contract']) assert.ok(!owned.has(name), name);
});

test('packaged Skills establish only exact paths, never uninstalled tool names', async t => {
  const { home } = await fixture(t);
  const path = fileURLToPath(new URL('../../skills/project-memory/SKILL.md', import.meta.url));
  const owned = installedSkills('codex-cli', home);
  assert.ok(owned.has(path)); assert.ok(owned.has(await realpath(path)));
  assert.ok(!owned.has('project-memory')); assert.ok(!owned.has('memos-project-memory'));
});

test('ownership is refreshed from disk and malformed manifests remain errors', async t => {
  const { home, manifest } = await fixture(t);
  const path = join(home, 'skills/memos-current/SKILL.md');
  await mkdir(dirname(path), { recursive: true }); await writeFile(path, 'first');
  await writeFile(manifest, JSON.stringify({ skillFiles: [{ path, hash: hash('first') }] }));
  assert.ok(installedSkills('codex-cli', home).has(path));
  await writeFile(path, 'edited');
  assert.ok(!installedSkills('codex-cli', home).has(path));
  await writeFile(manifest, '{');
  assert.throws(() => installedSkills('codex-cli', home), SyntaxError);
  assert.equal(await readFile(path, 'utf8'), 'edited');
});
