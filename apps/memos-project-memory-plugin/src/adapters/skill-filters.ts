import type { TraceInput } from './types.ts';
import { normalizeTaskTrace } from './_shared/task-trace.ts';
import { filterClaudeSkills } from './claude-code/skill-filter.ts';
import { filterCodexSkills } from './codex-cli/skill-filter.ts';
import { filterCursorSkills } from './cursor-cli/skill-filter.ts';
import { filterCopilotSkills } from './copilot-cli/skill-filter.ts';
import { filterWorkBuddySkills } from './workbuddy/skill-filter.ts';
import { filterPrimeSkills } from './prime-agent/skill-filter.ts';
import { filterDshSkills } from './deepseek-harness/skill-filter.ts';

function skillFilter(agent: string) {
  return agent === 'claude-code' ? filterClaudeSkills : agent === 'codex-cli' ? filterCodexSkills
    : agent === 'cursor-cli' ? filterCursorSkills : agent === 'copilot-cli' ? filterCopilotSkills
    : agent === 'workbuddy' ? filterWorkBuddySkills : agent === 'prime-agent' ? filterPrimeSkills
    : agent === 'deepseek-harness' ? filterDshSkills : undefined;
}
export function hasSkillFilter(agent: string): boolean { return !!skillFilter(agent); }

/** Routing only: host-specific recognition stays in its adapter. */
export function filterAdapterSkills<T extends TraceInput>(agent: string, records: T[], skills?: ReadonlySet<string>): T[] {
  const filter = skillFilter(agent);
  if (!filter) return records;
  // Preserve native completion evidence until the adapter has projected it.
  return filter(records.map(record => {
    const normalized = normalizeTaskTrace(agent, record);
    return normalized ? { ...record, ...normalized, raw: record.raw } : record;
  }), skills);
}
