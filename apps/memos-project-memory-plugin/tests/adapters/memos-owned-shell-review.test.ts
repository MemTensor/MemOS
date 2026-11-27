import { test } from 'node:test';
import assert from 'node:assert/strict';
import { filterCodexSkills } from '../../src/adapters/codex-cli/skill-filter.ts';
import type { TraceInput } from '../../src/adapters/types.ts';

test('heredoc bodies, shell definitions and POSIX type queries do not fabricate Skill reads', () => {
  const path = '/installed/memos-project-memory/SKILL.md', skills = new Set([path]);
  for (const cmd of [
    `memos-pm search --query x <<'EOF'\ncat ${path}\nEOF`,
    `cat <<'EOF'\ncat ${path}\nEOF`,
    `function helper() {\ncat ${path}\n}\nmemos-pm search --query x`,
    `type '${path}'`,
    `/app/cat '${path}'`,
  ]) {
    const records: TraceInput[] = [
      { sourceId: 'call', raw: {}, message: { role: 'assistant', content: '', tool_calls: [{ id: 'call', type: 'function', function: { name: 'exec_command', arguments: JSON.stringify({ cmd }) } }] } },
      { sourceId: 'result', raw: {}, message: { role: 'tool', tool_call_id: 'call', content: 'SEARCH_RESULT' } },
    ];
    assert.deepEqual(filterCodexSkills(records, skills), records, cmd);
  }
});
