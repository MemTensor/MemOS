import { test } from 'node:test';
import assert from 'node:assert/strict';
import { filterCodexSkills } from '../../src/adapters/codex-cli/skill-filter.ts';
import { isTraceControl } from '../../src/adapters/_shared/bind-records.ts';
import type { TraceInput } from '../../src/adapters/types.ts';

const path = '/installed/memos-project-memory/SKILL.md';
const skills = new Set([path]);
function pair(code: string): TraceInput[] {
  return [
    { sourceId: 'call', nativeTurnId: 'turn', raw: {}, message: { role: 'assistant', content: '', tool_calls: [{ id: 'wrapper', type: 'function', function: { name: 'functions.exec', arguments: code } }] } },
    { sourceId: 'result', nativeTurnId: 'turn', raw: {}, message: { role: 'tool', tool_call_id: 'wrapper', content: 'SEARCH_AND_BUSINESS_RESULT' } },
  ];
}

test('a regular expression mentioning a tool call does not become a Skill read', () => {
  const code = 'const re = /tools.exec_command({"cmd":"cat \\/installed\\/memos-project-memory\\/SKILL.md"})/; text(re.test("user input"));';
  const rows = pair(code);
  assert.deepEqual(filterCodexSkills(rows, skills), rows);
});

test('an aliased search next to an owned read keeps the whole unknown wrapper', () => {
  const rows = pair(`const search = tools.exec_command; text(await search({cmd:'memos-pm search --query x'})); text(await tools.exec_command(${JSON.stringify({ cmd: `cat ${path}` })}));`);
  assert.deepEqual(filterCodexSkills(rows, skills), rows);
});

test('unproved JavaScript and a mixed search wrapper are not summarized or excluded', () => {
  for (const code of [
    `text(await tools.exec_command(${JSON.stringify({ cmd: `cat ${path}` })})); text(await tools.exec_command(${JSON.stringify({ cmd: 'memos-pm search --query x' })}));`,
    `text(await tools.exec_command(${JSON.stringify({ cmd: `cat ${path}` })})); text(await getBusinessData());`,
    `const result = await tools.exec_command(${JSON.stringify({ cmd: `cat ${path}` })}); text(result); text('BUSINESS');`,
    `if (false) { text(await tools.exec_command(${JSON.stringify({ cmd: `cat ${path}` })})); }`,
  ]) {
    const rows = pair(code);
    assert.deepEqual(filterCodexSkills(rows, skills), rows, code);
  }
});

test('strict literal read wrappers still exclude the call and corresponding result', () => {
  for (const code of [
    `text(await tools.exec_command(${JSON.stringify({ cmd: `cat ${path}` })}));`,
    `const result = await tools.exec_command(${JSON.stringify({ cmd: `cat ${path}` })}); text(result);`,
    `await tools.exec_command(${JSON.stringify({ cmd: `cat ${path}` })});`,
  ]) assert.ok(filterCodexSkills(pair(code), skills).every(isTraceControl), code);
});
