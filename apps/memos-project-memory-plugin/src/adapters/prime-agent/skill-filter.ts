import type { TraceInput } from '../types.ts';
import { filterSkillRecords, parseSkillArgs, skillCommand, skillFileName, type SkillRead } from '../_shared/skill-records.ts';

function pythonRead(code: string): SkillRead | undefined {
  // Only starts in executable text count. Quoted examples (including triple
  // quotes) and comments are not file reads; no Python code is evaluated here.
  const executable = new Uint8Array(code.length);
  for (let index = 0; index < code.length;) {
    const char = code[index]!;
    if (char === '#') { while (index < code.length && code[index] !== '\n') index++; continue; }
    if (char === '"' || char === "'") {
      const quote = code.startsWith(char.repeat(3), index) ? char.repeat(3) : char;
      index += quote.length;
      while (index < code.length) {
        if (code[index] === '\\') { index += 2; continue; }
        if (code.startsWith(quote, index)) { index += quote.length; break; }
        index++;
      }
    } else executable[index++] = 1;
  }
  const reads = [...code.matchAll(/(?<![\w.])(?:open|(?:pathlib\.)?Path)\(\s*(["'])([^"'\n]+)\1\s*\)\.(?:read|read_text)\([^)]*\)/g)]
    .filter(match => executable[match.index] === 1);
  const skills = reads.flatMap(match => { const name = skillFileName(match[2]); return name ? [{ name, text: match[0] }] : []; });
  if (!skills.length) return undefined;
  // A simple displayed file read has no business output to lose. Other Python
  // statements need explicit reconciliation instead of guessing output spans.
  const expression = code.replace(/^\s*(?:from pathlib import Path|import pathlib)\s*\n/gm, '').trim();
  const read = skills[0]!;
  const simple = skills.length === 1 && [read.text, `print(${read.text})`].includes(expression.replace(/;$/, ''));
  return { name: read.name, ...(!simple ? { mixed: true } : {}) };
}

function identify(tool: string, value: unknown): SkillRead | undefined {
  const args = parseSkillArgs(value);
  if (['skill', 'get_skill'].includes(tool)) return { name: typeof args.name === 'string' ? args.name : typeof args.skill === 'string' ? args.skill : 'unknown' };
  if (['read', 'read_file'].includes(tool)) {
    const name = skillFileName(args.path ?? args.file_path);
    return name ? { name } : undefined;
  }
  if (['shell', 'bash', 'exec_command'].includes(tool)) {
    const command = args.command ?? args.cmd;
    if (typeof command === 'string' || Array.isArray(command) && command.every(part => typeof part === 'string')) return skillCommand(command as string | string[]);
  }
  if (tool === 'python_repl' && typeof args.code === 'string') return pythonRead(args.code);
  return undefined;
}

export function filterPrimeSkills<T extends TraceInput>(records: T[], skills?: ReadonlySet<string>): T[] {
  return filterSkillRecords(records, identify, skills);
}
