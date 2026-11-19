import { existsSync, statSync } from 'node:fs';

export const LOCAL_API_VERSION = 5;

/** Source hooks and built CLIs share one package revision to avoid restart loops. */
export function currentRuntimeRevision(): string {
    const built = new URL('../../dist/runtime/main.js', import.meta.url);
    const entry = existsSync(built) ? built : new URL('../../src/runtime/main.ts', import.meta.url);
    const stat = statSync(entry);
    return `${stat.mtimeMs}:${stat.size}`;
}
