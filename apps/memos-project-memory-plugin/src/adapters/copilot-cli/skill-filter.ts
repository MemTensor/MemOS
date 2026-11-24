import type { TraceInput } from '../types.ts';
import { filterSkillRecords, parseSkillArgs, skillCommand, skillFileName, type SkillRead } from '../_shared/skill-records.ts';

/** Copilot's skill tool and file/shell readers use different argument names. */
function identify(tool: string, value: unknown): SkillRead | undefined {
  const args = parseSkillArgs(value);
  if (tool === 'skill') return { name: typeof args.skill === 'string' ? args.skill : typeof args.name === 'string' ? args.name : 'unknown' };
  if (['view', 'read', 'read_file'].includes(tool)) {
    const name = skillFileName(args.path ?? args.file_path);
    return name ? { name } : undefined;
  }
  if (['bash', 'powershell', 'shell'].includes(tool)) {
    const command = args.command ?? args.cmd;
    if (typeof command === 'string' || Array.isArray(command) && command.every(part => typeof part === 'string')) return skillCommand(command as string | string[]);
  }
  return undefined;
}

export function filterCopilotSkills<T extends TraceInput>(records: T[]): T[] {
  return filterSkillRecords(records, identify);
}
