import type { TraceInput } from '../types.ts';
import { object } from '../_shared/transcript.ts';
import { filterSkillRecords, parseSkillArgs, skillCommand, skillFileName, type SkillRead } from '../_shared/skill-records.ts';
import { codexRecordRaw } from './content-normalizer.ts';

function wrapperCommand(code: string): unknown {
  // Admit only complete, single-call wrappers with JSON-literal arguments.
  // Scanning arbitrary JavaScript can mistake a regexp for a call or miss an
  // aliased search and then discard its result with an unrelated Skill read.
  const direct = /^\s*(?:await\s+tools\.exec_command\s*\(\s*(\{[\s\S]*\})\s*\)|text\s*\(\s*await\s+tools\.exec_command\s*\(\s*(\{[\s\S]*\})\s*\)\s*\))\s*;?\s*$/.exec(code);
  const assigned = /^\s*const\s+([A-Za-z_$][\w$]*)\s*=\s*await\s+tools\.exec_command\s*\(\s*(\{[\s\S]*\})\s*\)\s*;\s*text\s*\(\s*\1\s*\)\s*;?\s*$/.exec(code);
  const literal = direct?.[1] ?? direct?.[2] ?? assigned?.[2];
  if (literal === undefined) return;
  try {
    const args = object(JSON.parse(literal));
    if (Object.hasOwn(args, 'cmd') && Object.hasOwn(args, 'command')) return;
    return args.cmd ?? args.command;
  } catch { /* Unknown wrappers remain intact; never evaluate JavaScript. */ }
}

/** Only Codex's known tools select a Skill read; business tool arguments stay opaque. */
function identify(tool: string, value: unknown, skills?: ReadonlySet<string>): SkillRead | undefined {
  const name = tool.split(/[.:/]/).at(-1)!.toLowerCase(), args = parseSkillArgs(value);
  if (['skill', 'get_skill', 'use_skill'].includes(name)) {
    const skill = args.skill_name ?? args.skill ?? args.name;
    return { name: typeof skill === 'string' ? skill : 'unknown' };
  }
  if (['read', 'read_file'].includes(name)) {
    const skill = skillFileName(args.file_path ?? args.filePath ?? args.path);
    return skill ? { name: skill } : undefined;
  }
  if (['exec_command', 'shell', 'local_shell'].includes(name)) {
    const command = args.cmd ?? args.command ?? (typeof value === 'string' ? value : undefined);
    return typeof command === 'string' || Array.isArray(command) && command.every(word => typeof word === 'string') ? skillCommand(command, skills) : undefined;
  }
  const code = typeof args.code === 'string' ? args.code : value;
  if (name !== 'exec' || typeof code !== 'string') return;
  return skillCommand(wrapperCommand(code), skills);
}

/** Filtering also rebuilds Codex raw payloads so neither source mirrors nor reader caches retain the body. */
export function filterCodexSkills<T extends TraceInput>(records: T[], skills?: ReadonlySet<string>): T[] {
  return filterSkillRecords(records, (tool, args) => identify(tool, args, skills), skills).map((record, index) => {
    if (record === records[index] || !record.message || record.message.role === 'system') return record;
    const raw = codexRecordRaw(record.raw, record.message), source = parseSkillArgs(record.raw);
    for (const field of ['bindCallIds', 'skillCallIds']) if (Array.isArray(source[field])) raw[field] = source[field];
    return { ...record, raw };
  });
}
