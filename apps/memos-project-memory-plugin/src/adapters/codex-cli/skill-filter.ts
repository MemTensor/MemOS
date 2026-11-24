import type { TraceInput } from '../types.ts';
import { object } from '../_shared/transcript.ts';
import { filterSkillRecords, parseSkillArgs, skillCommand, skillFileName, type SkillRead } from '../_shared/skill-records.ts';
import { codexRecordRaw } from './content-normalizer.ts';

function commands(code: string): { commands: string[]; calls: number; other: boolean } {
  // Lexical tokens, not execution: strings/comments cannot fabricate a nested
  // tool invocation. Dynamic expressions remain unresolved, never evaluated.
  const tokens = [...code.matchAll(/\/\/[^\n]*|\/\*[\s\S]*?\*\/|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|[A-Za-z_$][\w$]*|[^\s]/g)]
    .map(match => match[0]).filter(token => !token.startsWith('//') && !token.startsWith('/*'));
  const result = { commands: [] as string[], calls: 0, other: false };
  for (let i = 0; i < tokens.length - 3; i++) {
    if (tokens[i] !== 'tools' || tokens[i - 1] === '.' || tokens[i + 1] !== '.' || tokens[i + 3] !== '(') continue;
    result.calls++;
    if (tokens[i + 2] !== 'exec_command') { result.other = true; continue; }
    if (tokens[i + 4] !== '{') continue;
    let depth = 0, properties = 0, spread = false, command: string | undefined;
    for (let j = i + 4; j < tokens.length; j++) {
      const token = tokens[j]!;
      if (token === '{') depth++;
      if (token === '}' && --depth === 0) break;
      if (depth !== 1) continue;
      if (token === '.' && tokens[j + 1] === '.' && tokens[j + 2] === '.') spread = true;
      if (!['{', ','].includes(tokens[j - 1] ?? '') || !['cmd', 'command', '"cmd"', '"command"', "'cmd'", "'command'"].includes(token)) continue;
      properties++;
      if (tokens[j + 1] !== ':' || ![',', '}'].includes(tokens[j + 3] ?? '')) continue;
      const value = tokens[j + 2] ?? '';
      if (value.startsWith('"')) { try { command = JSON.parse(value); } catch { /* Invalid/non-JSON literal stays unresolved. */ } }
      else if (value.startsWith("'")) command = value.slice(1, -1).replace(/\\(['\\])/g, '$1');
    }
    if (!spread && properties === 1 && command !== undefined) result.commands.push(command);
  }
  return result;
}

/** Only Codex's known tools select a Skill read; business tool arguments stay opaque. */
function identify(tool: string, value: unknown): SkillRead | undefined {
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
    return typeof command === 'string' || Array.isArray(command) && command.every(word => typeof word === 'string') ? skillCommand(command) : undefined;
  }
  const code = typeof args.code === 'string' ? args.code : value;
  if (name !== 'exec' || typeof code !== 'string' || !/\btools\.exec_command\s*\(/.test(code)) return;
  const found = commands(code), reads = found.commands.map(command => skillCommand(command)), skill = reads.find(read => read);
  if (!skill) return;
  return { name: skill.name, mixed: reads.some(read => !read || read.mixed || read.name !== skill.name)
    || found.other || found.calls !== found.commands.length };
}

/** Filtering also rebuilds Codex raw payloads so neither source mirrors nor reader caches retain the body. */
export function filterCodexSkills<T extends TraceInput>(records: T[]): T[] {
  return filterSkillRecords(records, identify).map((record, index) => record !== records[index] && record.message
    ? { ...record, raw: codexRecordRaw(record.raw, record.message) } : record);
}
