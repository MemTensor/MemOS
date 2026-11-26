import type { TraceInput } from '../types.ts';
import { filterSkillRecords, parseSkillArgs, skillCommand, skillFileName, type SkillRead } from '../_shared/skill-records.ts';

/** WorkBuddy function events and Hook fallbacks share these explicit tool inputs. */
function identify(tool: string, input: unknown): SkillRead | undefined {
  const args = parseSkillArgs(input);
  if (tool.toLowerCase() === 'skill') {
    const name = args.skill_name ?? args.skill ?? args.name;
    return { name: typeof name === 'string' && name.trim() ? name : 'unknown' };
  }
  if (tool === 'Read' || tool === 'read_file') {
    const name = skillFileName(args.path ?? args.file_path);
    return name === undefined ? undefined : { name };
  }
  if (tool === 'Bash' || tool === 'Shell') return skillCommand(args.command);
  return undefined;
}

export function filterWorkBuddySkills<T extends TraceInput>(records: T[], skills?: ReadonlySet<string>): T[] {
  return filterSkillRecords(records, identify, skills).map((record, index) => {
    if (record === records[index] || record.message?.role !== 'tool'
      || String(parseSkillArgs(record.raw).hook_event_name).toLowerCase() !== 'posttooluse') return record;
    const summary = parseSkillArgs(record.message.content);
    if (typeof summary.skill_name !== 'string' || typeof summary.call_id !== 'string' || summary.status !== 'unknown') return record;
    // This host emits a separate failure Hook; PostToolUse proves completion.
    const message = { ...record.message, content: JSON.stringify({ ...summary, status: 'completed' }) };
    return { ...record, message, raw: { ...parseSkillArgs(record.raw), message } };
  });
}
