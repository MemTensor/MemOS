#!/usr/bin/env node
import { run } from './run.ts';
export { run } from './run.ts';
const result = await run(process.argv.slice(2));
process.stdout.write(JSON.stringify(result) + '\n');
process.exitCode = result.ok ? 0 : 1;
