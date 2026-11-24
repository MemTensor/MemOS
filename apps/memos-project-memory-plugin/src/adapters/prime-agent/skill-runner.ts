import { createPrimeSpace, searchPrimeMemory } from './skill.ts';

try {
  const result = process.argv[2] === '--create-space'
    ? await createPrimeSpace(process.argv.slice(3))
    : await searchPrimeMemory(process.argv.slice(2).join(' '));
  process.stdout.write(JSON.stringify(result) + '\n');
  if (!result.ok) process.exitCode = 1;
} catch (error) {
  process.stdout.write(JSON.stringify({ ok: false, status: 'UNAVAILABLE', data: null,
    error: { message: error instanceof Error ? error.message : String(error) } }) + '\n');
  process.exitCode = 1;
}
