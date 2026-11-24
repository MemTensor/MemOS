import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { installAdapter, uninstallAdapter } from '../../src/adapters/installer.ts';
import { profiles } from '../../src/adapters/registry.ts';

const root = fileURLToPath(new URL('../../', import.meta.url));
const skills = ['project-memory', 'create-project-space', 'bind-project-space', 'list-project-spaces', 'unbind-project-space'];
const documents = ['SKILL.md', 'references/cli-contract.md'];
async function fixture(t: test.TestContext) {
  const home = await mkdtemp(join(tmpdir(), 'pm-skill-install-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  return { home, cwd: home };
}

test('Skill sources have stable names, English instructions, and valid contract links', async () => {
  for (const skill of skills) for (const file of documents) {
    const path = join(root, 'skills', skill, file), text = await readFile(path, 'utf8');
    assert.doesNotMatch(text, /\p{Script=Han}/u, path);
    if (file === 'SKILL.md') assert.match(text, new RegExp(`^---\\nname: memos-${skill}\\ndescription: .+\\n---`));
    for (const match of text.matchAll(/\]\(([^)]+)\)/g)) {
      const link = match[1]!; if (/^[a-z]+:/i.test(link)) continue;
      const [target, anchor] = link.split('#');
      const linked = await readFile(target ? resolve(dirname(path), target) : path, 'utf8');
      if (anchor) {
        const anchors = [...linked.matchAll(/^#+ (.+)$/gm)].map(item => item[1]!.toLowerCase().replace(/[^\w -]/g, '').replace(/ /g, '-'));
        assert.ok(anchors.includes(anchor), `${path}: missing ${link}`);
      }
    }
  }
});

test('every registered adapter deploys all five Skills with its native commands and uninstalls owned files', async t => {
  for (const profile of profiles) {
    const options = await fixture(t), result = await installAdapter(profile.id, options);
    const paths = result.files.filter(path => path.endsWith('.md'));
    assert.deepEqual(paths.filter(path => path.endsWith('/SKILL.md')).map(path => /\/(memos-[^/]+)\/SKILL.md$/.exec(path)![1]).sort(), skills.map(name => `memos-${name}`).sort(), profile.id);
    const contents = new Map(await Promise.all(paths.map(async path => [path, await readFile(path, 'utf8')] as const)));
    for (const [path, text] of contents) assert.doesNotMatch(text, /\p{Script=Han}/u, `${profile.id}: ${path}`);
    for (const skill of skills) {
      const path = paths.find(path => path.endsWith(`/memos-${skill}/SKILL.md`))!;
      // Prime's native search helper has no separate installed contract file.
      if (profile.id !== 'prime-agent' || skill !== 'project-memory') assert.equal(contents.get(join(dirname(path), 'references/cli-contract.md')), await readFile(join(root, 'skills', skill, 'references/cli-contract.md'), 'utf8'), `${profile.id}: ${skill} contract`);
      const text = contents.get(path)!;
      if (['list-project-spaces', 'unbind-project-space'].includes(skill)) assert.doesNotMatch(text, /Host-provided creation identity|MEMOS_PM_CREATE_CONTEXT/);
      if (skill === 'bind-project-space') assert.match(text, /memos-pm bind --space-id/);
      if (skill === 'list-project-spaces') {
        assert.match(text, /memos-pm spaces/);
        for (const term of [/project/i, /space/i, /organization/i]) assert.match(text, term);
      }
      if (skill === 'unbind-project-space') assert.match(text, /memos-pm unbind --space-id/);
    }
    const create = contents.get(paths.find(path => path.endsWith('/memos-create-project-space/SKILL.md'))!)!;
    for (const requirement of [/data\.spaceId/, /error\.spaceId/, /same execution/i, /separate (?:user )?turn/i, /ask only/i]) assert.match(create, requirement);
    if (profile.id === 'prime-agent') {
      const commands = [...create.matchAll(/```sh\n([\s\S]*?)```/g)].map(match => match[1]).join('\n');
      assert.match(commands, /create\.mjs/); assert.doesNotMatch(commands, /memos-pm create --context/);
      assert.match(create, /RLM_SESSION_ID/);
    }
    if (['cursor-cli', 'grok-build'].includes(profile.id)) assert.match(create, /--context "\$MEMOS_PM_CREATE_CONTEXT"/);
    await uninstallAdapter(profile.id, options);
    for (const path of result.files.filter(path => path.endsWith('.md') || /\.(?:mjs|js|ts)$/.test(path))) await assert.rejects(readFile(path), { code: 'ENOENT' }, `${profile.id}: ${path}`);
  }
});

test('shared Skill files stay until the final Agent owner uninstalls', async t => {
  const options = await fixture(t);
  const installed = await installAdapter('codex-cli', options);
  await installAdapter('deepagents-dcode', options);
  const paths = installed.files.filter(path => path.endsWith('.md'));
  const original = await Promise.all(paths.map(path => readFile(path, 'utf8')));
  await uninstallAdapter('codex-cli', options);
  assert.deepEqual(await Promise.all(paths.map(path => readFile(path, 'utf8'))), original);
  await uninstallAdapter('deepagents-dcode', options);
  for (const path of paths) await assert.rejects(readFile(path), { code: 'ENOENT' });
});

test('Hook, native and Prime repairs update owned files while preserving edited Skills and contracts', async t => {
  for (const id of ['codex-cli', 'pi', 'prime-agent']) {
    const options = await fixture(t);
    const initial = await installAdapter(id, options);
    const original = await Promise.all(initial.files.filter(path => path.endsWith('.md')).map(path => readFile(path, 'utf8')));
    const path = join(options.home, '.memos-project-memory/adapters', id + '.json');
    const manifest = JSON.parse(await readFile(path, 'utf8'));
    for (const entry of manifest.skillFiles ?? manifest.files) {
      if (!entry.path.endsWith('.md')) continue;
      const legacy = '# installer-owned content\n'; await writeFile(entry.path, legacy);
      entry.hash = createHash('sha256').update(legacy).digest('hex');
      if (entry.path === manifest.skillFile) manifest.skillHash = entry.hash;
    }
    await writeFile(path, JSON.stringify(manifest));
    const repaired = await installAdapter(id, options), paths = repaired.files.filter(path => path.endsWith('.md'));
    assert.deepEqual(await Promise.all(paths.map(path => readFile(path, 'utf8'))), original, id);
    const edited = paths.filter(path => /memos-create-project-space\/(?:SKILL.md|references\/cli-contract.md)$|memos-(?:bind-project-space|list-project-spaces)\/SKILL.md$|memos-unbind-project-space\/references\/cli-contract.md$/.test(path));
    assert.equal(edited.length, 5);
    for (const doc of edited) await writeFile(doc, '# user-owned edit');
    const before = await Promise.all(paths.map(path => readFile(path, 'utf8')));
    await assert.rejects(installAdapter(id, options), /not owned/i);
    assert.deepEqual(await Promise.all(paths.map(path => readFile(path, 'utf8'))), before);
    await uninstallAdapter(id, options);
    for (const doc of edited) assert.equal(await readFile(doc, 'utf8'), '# user-owned edit');
    for (const doc of repaired.files.filter(path => path.endsWith('.md') || /\.(?:mjs|js|ts)$/.test(path))) if (!edited.includes(doc)) await assert.rejects(readFile(doc), { code: 'ENOENT' });
  }
});
