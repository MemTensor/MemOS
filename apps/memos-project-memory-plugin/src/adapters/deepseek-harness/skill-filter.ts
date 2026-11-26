import type { TraceInput } from '../types.ts';
import { filterSkillRecords, parseSkillArgs, skillCommand, skillFileName, type SkillRead } from '../_shared/skill-records.ts';

function identify(tool: string, value: unknown): SkillRead | undefined {
  const args = parseSkillArgs(value);
  if (tool === 'skill') return { name: typeof args.name === 'string' ? args.name : 'unknown' };
  if (tool === 'read' || tool === 'str_replace_editor' && args.command === 'view') {
    const name = skillFileName(args.file_path ?? args.path);
    return name ? { name } : undefined;
  }
  if (['bash', 'pwsh', 'bash_persistent', 'pwsh_persistent'].includes(tool)) {
    const command = args.command;
    if (typeof command === 'string' || Array.isArray(command) && command.every(part => typeof part === 'string')) return skillCommand(command as string | string[]);
  }
  return undefined;
}

export function filterDshSkills<T extends TraceInput>(records: T[], skills?: ReadonlySet<string>): T[] {
  return filterSkillRecords(records, identify, skills);
}
