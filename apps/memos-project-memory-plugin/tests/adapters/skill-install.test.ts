import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { installAdapter, uninstallAdapter } from '../../src/adapters/installer.ts';
import { profiles } from '../../src/adapters/registry.ts';

const root = fileURLToPath(new URL('../../', import.meta.url));
const skills = ['project-memory', 'create-project-space', 'bind-project-space', 'list-project-spaces', 'unbind-project-space'];
async function fixture(t: test.TestContext) {
  const home = await mkdtemp(join(tmpdir(), 'pm-skill-install-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  return { home, cwd: home };
}

test('adapters supporting Space management deploy all five Skills with its native commands and uninstalls owned files', async t => {
  for (const profile of profiles.filter(profile => profile.id !== 'doubao-work')) {
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
