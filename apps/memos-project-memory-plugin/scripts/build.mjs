import { readdir, readFile, writeFile, mkdir, rm, chmod, mkdtemp, rename } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import ts from 'typescript';
// Compile away from the live tree. A failed build leaves the working runtime intact.
const staging = await mkdtemp('.dist-build-');
const outputs = [];
async function build(dir) {
 for (const entry of await readdir(dir, { withFileTypes: true })) {
  const path = join(dir, entry.name);
  if (entry.isDirectory()) { await build(path); continue; }
  if (!path.endsWith('.ts')) continue;
  const relative = path.slice('src/'.length).replace(/\.ts$/, '.js');
  const target = join(staging, relative);
  const source = await readFile(path, 'utf8');
  const result = ts.transpileModule(source, { reportDiagnostics: true, compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.ESNext } });
  const errors = result.diagnostics?.filter(item => item.category === ts.DiagnosticCategory.Error) ?? [];
  if (errors.length) throw new Error(`${path}: ${errors.map(item => ts.flattenDiagnosticMessageText(item.messageText, '\n')).join('\n')}`);
  const output = result.outputText.replace(/(from\s*['"]|import\(['"]|new URL\(['"])([^'"\n]+)\.ts(['"])/g, '$1$2.js$3');
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, output);
  outputs.push(relative);
 }
}
try {
 await build('src');
 await chmod(join(staging, 'cli/index.js'), 0o755);
 // Atomic file replacement never leaves an absent/partial entrypoint. Publish
 // main last because its mtime is the managed service's runtime revision.
 outputs.sort((a, b) => Number(a === 'runtime/main.js') - Number(b === 'runtime/main.js'));
 for (const relative of outputs) {
  const target = join('dist', relative);
  await mkdir(dirname(target), { recursive: true });
  await rename(join(staging, relative), target);
 }
} finally { await rm(staging, { recursive: true, force: true }); }
