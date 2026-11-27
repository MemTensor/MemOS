import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { installAdapter, installedSkills } from '../../src/adapters/installer.ts';
import { filterCodexSkills } from '../../src/adapters/codex-cli/skill-filter.ts';
import { filterDshSkills } from '../../src/adapters/deepseek-harness/skill-filter.ts';
import { filterClaudeSkills } from '../../src/adapters/claude-code/skill-filter.ts';
import { isTraceControl } from '../../src/adapters/_shared/bind-records.ts';
import type { TraceInput } from '../../src/adapters/types.ts';

async function fixture(t: test.TestContext, agent: 'codex-cli' | 'deepseek-harness' = 'codex-cli') {
  const home = await mkdtemp(join(tmpdir(), 'pm owned filter-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const installed = await installAdapter(agent, { home, cwd: home });
  const skill = installed.files.find(path => path.endsWith('/memos-project-memory/SKILL.md'))!;
  assert.ok(skill);
  return { home, skill, skills: installedSkills(agent, home) };
}
function pair(tool: string, args: unknown, id = 'read'): TraceInput[] {
  return [
    { sourceId: 'call', nativeTurnId: 'turn', raw: { type: 'function_call', private: 'RAW_SKILL_BODY' }, message: { role: 'assistant', content: '', tool_calls: [{ id, type: 'function', function: { name: tool, arguments: typeof args === 'string' ? args : JSON.stringify(args) } }] } },
    { sourceId: 'result', nativeTurnId: 'turn', raw: { type: 'function_call_output', output: 'RAW_SKILL_BODY' }, message: { role: 'tool', tool_call_id: id, content: 'SKILL_BODY' } },
  ];
}
function excluded(records: TraceInput[]) {
  assert.equal(records.length, 2);
  assert.ok(records.every(isTraceControl));
  assert.ok(records.every(record => record.message?.role === 'system' && record.message.content === ''));
  assert.doesNotMatch(JSON.stringify(records), /SKILL_BODY|RAW_SKILL_BODY/);
}

test('Codex excludes direct installed file reads and native Skill invocations', async t => {
  const { skill, skills } = await fixture(t);
  for (const [tool, args] of [
    ['read_file', { file_path: skill }],
    ['read', { path: skill }],
    ['skill', { name: 'memos-project-memory' }],
    ['skill', { skill_name: 'memos-project-memory' }],
    ['get_skill', { skill_name: 'memos-project-memory' }],
    ['exec_command', { cmd: `cat '${skill}'` }],
    ['exec_command', { cmd: `head -60 "${skill}"` }],
  ] as const) {
    const clean = filterCodexSkills(pair(tool, args), skills);
    excluded(clean);
    assert.deepEqual(filterCodexSkills(clean, skills), clean);
  }
});

test('DSH excludes installed reads and its native Skill tool without dropping unrelated tools', async t => {
  const { skill, skills } = await fixture(t, 'deepseek-harness');
  for (const [tool, args] of [
    ['skill', { name: 'memos-project-memory' }],
    ['read', { path: skill }],
    ['str_replace_editor', { command: 'view', path: skill }],
    ['bash', { command: `cat '${skill}' 2>/dev/null | head -60` }],
  ] as const) excluded(filterDshSkills(pair(tool, args), skills));
  const search = pair('bash', { command: 'memos-pm search --query "backup strategy"' }, 'search');
  assert.deepEqual(filterDshSkills(search, skills), search);
});

test('native skill_name is excluded but a projected third-party read is not reclassified', async t => {
  const { skills } = await fixture(t);
  excluded(filterClaudeSkills(pair('Skill', { skill_name: 'memos-project-memory' }), skills));
  const thirdParty = filterCodexSkills(pair('read_file', { path: '/project/memos-project-memory/SKILL.md' }), skills);
  assert.ok(!filterCodexSkills(thirdParty, skills).some(isTraceControl));
});

test('a partial record keeps owned identities while projecting a third-party Skill', async t => {
  const { skill, skills } = await fixture(t);
  const own = pair('read_file', { path: skill }, 'owned');
  const other = pair('read_file', { path: '/project/demo/SKILL.md' }, 'third-party');
  const mixed = { ...own[0]!, message: { role: 'assistant', content: 'KEEP', tool_calls: [...own[0]!.message!.tool_calls!, ...other[0]!.message!.tool_calls!] } };
  const first = filterCodexSkills([mixed], skills);
  assert.deepEqual((first[0]!.raw as { skillCallIds: string[] }).skillCallIds, ['owned']);
  const resumed = filterCodexSkills([...JSON.parse(JSON.stringify(first)), own[1]!], skills);
  assert.ok(isTraceControl(resumed[1]!));
  assert.equal(resumed[0]!.message!.content, 'KEEP');
  assert.equal(resumed[0]!.message!.tool_calls!.length, 1);
});

test('echo, grep, find and search mentioning an installed path remain business records', async t => {
  const { skill, skills } = await fixture(t);
  for (const cmd of [
    `echo '${skill}'`,
    `echo cat '${skill}'`,
    `printf '%s\\n' '${skill}'`,
    `# cat '${skill}'`,
    `grep -F '${skill}' build.log`,
    `find '${dirname(skill)}' -name SKILL.md`,
    `memos-pm search --query 'cat ${skill}'`,
    `memos-pm search --query '${skill}'`,
  ]) {
    const rows = pair('exec_command', { cmd }, 'business');
    assert.deepEqual(filterCodexSkills(rows, skills), rows, cmd);
  }
});

test('a third-party Skill with the same installed directory name keeps its existing projection', async t => {
  const { home, skills } = await fixture(t);
  const path = join(home, 'project/memos-project-memory/SKILL.md');
  await mkdir(dirname(path), { recursive: true }); await writeFile(path, 'THIRD_PARTY_BODY');
  const clean = filterCodexSkills(pair('read_file', { file_path: path }), skills);
  assert.equal(clean[0]!.message!.role, 'assistant');
  assert.equal(clean[1]!.message!.role, 'tool');
  assert.ok(!clean.some(isTraceControl));
  assert.deepEqual(JSON.parse(String(clean[1]!.message!.content)), { skill_name: 'memos-project-memory', call_id: 'read', status: 'unknown' });
  const repeated = filterCodexSkills(clean, skills);
  assert.deepEqual(repeated, clean);
  assert.ok(!repeated.some(isTraceControl));
});

test('unresolved variable paths are not guessed to be installed Skill reads', async t => {
  const { skills } = await fixture(t);
  for (const cmd of ['cat "$SKILL_FILE"', 'cat "${SKILL_ROOT}/SKILL.md"', 'cat "$(locate-skill)"']) {
    const rows = pair('exec_command', { cmd });
    assert.ok(!filterCodexSkills(rows, skills).some(isTraceControl), cmd);
  }
});

test('a redirection destination named cat does not fabricate an owned file read', async t => {
  const { skill, skills } = await fixture(t);
  for (const cmd of [`echo hello > cat '${skill}'`, `echo hello 2> cat '${skill}'`]) {
    const clean = filterCodexSkills(pair('exec_command', { cmd }), skills);
    assert.ok(!clean.some(isTraceControl), cmd);
  }
});

test('sed script arguments are not owned file operands but an actual input file is', async t => {
  const { skill, skills } = await fixture(t);
  for (const cmd of [`sed '${skill}' /app/business.txt`, `sed -n '${skill}' /app/business.txt`]) {
    assert.ok(!filterCodexSkills(pair('exec_command', { cmd }), skills).some(isTraceControl), cmd);
  }
  excluded(filterCodexSkills(pair('exec_command', { cmd: `sed -n '1,60p' '${skill}'` }), skills));
});

test('literal functions.exec wrappers of owned reads are excluded as call/result pairs', async t => {
  const { skill, skills } = await fixture(t);
  const code = `const result = await tools.exec_command(${JSON.stringify({ cmd: `cat '${skill}'` })}); text(result);`;
  excluded(filterCodexSkills(pair('functions.exec', code), skills));
});

test('shell argument arrays identify owned reads without excluding a separate search', async t => {
  const { skill, skills } = await fixture(t);
  const rows = pair('exec_command', { cmd: ['/bin/bash', '-lc', `cat '${skill}'`] });
  const search = pair('exec_command', { cmd: `memos-pm search --query '${skill}'` }, 'search');
  const clean = filterCodexSkills([...rows, ...search], skills);
  excluded(clean.slice(0, 2));
  assert.deepEqual(clean.slice(2), search);
});

test('a separately recorded search survives next to an excluded functions.exec wrapper', async t => {
  const { skill, skills } = await fixture(t);
  const code = `text(await tools.exec_command(${JSON.stringify({ cmd: `cat '${skill}'` })}));`;
  const search = pair('exec_command', { cmd: 'memos-pm search --query "backup"' }, 'search');
  const clean = filterCodexSkills([...pair('functions.exec', code), ...search], skills);
  excluded(clean.slice(0, 2));
  assert.deepEqual(clean.slice(2), search);
});

test('excluding an owned read preserves sibling search calls and assistant text', async t => {
  const { skill, skills } = await fixture(t);
  const rows = pair('read_file', { file_path: skill });
  const searchCall = { id: 'search', type: 'function', function: { name: 'exec_command', arguments: JSON.stringify({ cmd: 'memos-pm search --query "backup"' }) } };
  rows[0]!.message!.content = 'BUSINESS_TEXT';
  rows[0]!.message!.tool_calls!.push(searchCall);
  rows.push({ sourceId: 'search-result', nativeTurnId: 'turn', raw: {}, message: { role: 'tool', tool_call_id: 'search', content: 'SEARCH_RESULT' } });
  const clean = filterCodexSkills(rows, skills);
  assert.equal(clean[0]!.message!.content, 'BUSINESS_TEXT');
  assert.deepEqual(clean[0]!.message!.tool_calls, [searchCall]);
  assert.ok(isTraceControl(clean[1]!));
  assert.deepEqual(clean[2], rows[2]);
  assert.deepEqual((clean[0]!.raw as { skillCallIds?: string[] }).skillCallIds, ['read']);
  assert.doesNotMatch(JSON.stringify(clean), /SKILL_BODY/);
  assert.match(JSON.stringify(clean), /SEARCH_RESULT/);
});
