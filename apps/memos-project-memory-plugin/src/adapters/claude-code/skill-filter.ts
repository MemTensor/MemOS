import type { TraceInput } from '../types.ts';
import { filterSkillRecords, parseSkillArgs, skillCommand, skillFileName, type SkillRead } from '../_shared/skill-records.ts';

/** Claude's native Skill invocation and explicit reads of its instruction file. */
function identify(tool: string, input: unknown): SkillRead | undefined {
  const args = parseSkillArgs(input);
  if (tool.toLowerCase() === 'skill') {
    const name = args.skill_name ?? args.skill ?? args.name;
    return { name: typeof name === 'string' && name.trim() ? name : 'unknown' };
  }
  if (tool === 'Read') {
    const name = skillFileName(args.file_path ?? args.path);
    return name === undefined ? undefined : { name };
  }
  if (tool === 'Bash') return skillCommand(args.command);
  return undefined;
}

export function filterClaudeSkills<T extends TraceInput>(records: T[]): T[] {
  return filterSkillRecords(records, identify).map((record, index) => {
    if (record === records[index] || record.message?.role !== 'tool'
      || String(parseSkillArgs(record.raw).hook_event_name).toLowerCase() !== 'posttooluse') return record;
    const summary = parseSkillArgs(record.message.content);
    if (typeof summary.skill_name !== 'string' || typeof summary.call_id !== 'string' || summary.status !== 'unknown') return record;
    // This host emits a separate failure Hook; PostToolUse proves completion.
    const message = { ...record.message, content: JSON.stringify({ ...summary, status: 'completed' }) };
    return { ...record, message, raw: { ...parseSkillArgs(record.raw), message } };
  });
}
