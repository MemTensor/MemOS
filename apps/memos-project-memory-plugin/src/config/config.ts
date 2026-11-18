import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
export interface Config {
    userId: string;
    installationId: string;
    baseUrl: string;
    apiKey: string;
    paused: boolean;
}
export const defaultDataDir = () => process.env.MEMOS_PM_DATA_DIR ?? join(homedir(), '.memos-project-memory');
export class Configuration {
    value: Config;
    path: string;
    constructor(directory: string) { mkdirSync(directory, { recursive: true, mode: 0o700 }); this.path = join(directory, 'config.json'); this.value = existsSync(this.path) ? JSON.parse(readFileSync(this.path, 'utf8')) : { userId: randomUUID(), installationId: randomUUID(), baseUrl: 'https://memos.memtensor.cn/api/openmem/v1', apiKey: '', paused: false }; this.save(); }
    save() { writeFileSync(this.path, JSON.stringify(this.value, null, 2) + '\n', { mode: 0o600 }); }
    update(input: {
        baseUrl?: string;
        apiKey?: string;
        paused?: boolean;
    }) {
        if (input.baseUrl !== undefined) {
            const url = new URL(input.baseUrl);
            if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
                throw new Error('服务地址必须为HTTP或HTTPS且不能内嵌凭据');
            this.value.baseUrl = input.baseUrl.replace(/\/+$/, '');
        }
        if (input.apiKey !== undefined)
            this.value.apiKey = input.apiKey;
        if (input.paused !== undefined)
            this.value.paused = !!input.paused;
        this.save();
        return this.public();
    }
    public() { const { apiKey, installationId: _installationId, ...rest } = this.value; return { ...rest, keyConfigured: !!apiKey }; }
}
