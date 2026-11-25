import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { object } from '../_shared/transcript.ts';

export async function workbuddyConfigDir(home?: string): Promise<string> {
    if (home === undefined && process.env.WORKBUDDY_CONFIG_DIR) return process.env.WORKBUDDY_CONFIG_DIR;
    home ??= homedir();
    try {
        const manifest = object(JSON.parse(await readFile(join(home, '.memos-project-memory/adapters/workbuddy.json'), 'utf8')));
        if (typeof manifest.configPath === 'string' && isAbsolute(manifest.configPath)) return dirname(manifest.configPath);
    } catch (error) {
        if (!(error instanceof SyntaxError) && (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    return join(home, '.workbuddy');
}
