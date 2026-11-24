import { basename } from 'node:path';
import type { Project } from '../projects.ts';
import { primeSources } from './sessions.ts';

export async function discoverPrimeProjects(options: { home?: string } = {}): Promise<Project[]> {
  const projects = new Map<string, Project>();
  for (const { cwd } of await primeSources(options.home)) projects.set(cwd, { name: basename(cwd) || cwd, root: cwd });
  return [...projects.values()].sort((a, b) => a.root.localeCompare(b.root));
}
