import type { Configuration } from '../config/config.ts';
export class CloudClient {
    config: Configuration;
    constructor(config: Configuration) { this.config = config; }
    async call<T = Record<string, unknown>>(endpoint: string, body: unknown): Promise<T> {
        const { baseUrl, apiKey } = this.config.value;
        if (!apiKey)
            throw new Error('尚未配置MemOS Key');
        const response = await fetch(`${baseUrl}/${endpoint}`, { method: 'POST', headers: { Authorization: `Token ${apiKey}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(15000) });
        if (!response.ok)
            throw new Error(`MemOS ${endpoint} HTTP ${response.status}`);
        const result = await response.json() as {
            code: number;
            data: T;
            message?: string;
        };
        if (result.code !== 0)
            throw new Error(`MemOS ${endpoint} 业务错误 ${result.code}`);
        return result.data;
    }
}
