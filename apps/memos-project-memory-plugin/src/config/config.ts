import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
export interface Config {
    userId: string;
    installationId: string;
    baseUrl: string;
    apiKey: string;
    apiMode: 'algorithm' | 'engineering';
    authMode: 'none' | 'token' | 'bearer';
    cloudProjectId: string;
    paused: boolean;
    uploadMaxBytes: number;
    historyUploadConfirmCount: number;
}
// Required project default for the currently supported algorithm API.
const defaultAlgorithmProjectId = 'test1';
export const defaultUploadMaxBytes = 39000;
export const defaultHistoryUploadConfirmCount = 100;
export const defaultDataDir = () => process.env.MEMOS_PM_DATA_DIR ?? join(homedir(), '.memos-project-memory');
export function connectionIdentity(config: Pick<Config, 'apiMode' | 'baseUrl' | 'cloudProjectId'>): string {
    return JSON.stringify([config.apiMode, config.baseUrl.replace(/\/+$/, ''), config.apiMode === 'algorithm' ? config.cloudProjectId : '']);
}
export function connectionError(config: Config): string | undefined {
    if (!config.baseUrl) return '请配置 MemOS API 基址';
    if (config.apiMode === 'algorithm' && !config.cloudProjectId.trim()) return '请配置算法接口的云服务项目 ID';
    if (config.authMode !== 'none' && !config.apiKey.trim()) return '未配置 API Key，请先完成云连接配置';
    return undefined;
}
export class Configuration {
    value: Config & { uploadPauses?: { start: number; end?: number }[] };
    path: string;
    revision = 0;
    constructor(directory: string) {
        mkdirSync(directory, { recursive: true, mode: 0o700 });
        this.path = join(directory, 'config.json');
        this.value = existsSync(this.path) ? JSON.parse(readFileSync(this.path, 'utf8')) : { userId: randomUUID(), installationId: randomUUID(), baseUrl: 'https://memos.memtensor.cn/api/openmem/v1', apiKey: '', paused: false };
        this.value.apiMode ??= 'engineering';
        this.value.authMode ??= 'token';
        if (!this.value.cloudProjectId) this.value.cloudProjectId = defaultAlgorithmProjectId;
        this.value.uploadMaxBytes ??= defaultUploadMaxBytes;
        this.value.historyUploadConfirmCount ??= defaultHistoryUploadConfirmCount;
        // Older installations stored only the switch. The start of an existing pause is unknown.
        this.value.uploadPauses ??= this.value.paused ? [{ start: 0 }] : [];
        this.save();
    }
    save(value = this.value) {
        const temporary = this.path + '.' + randomUUID() + '.tmp';
        try {
            writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
            renameSync(temporary, this.path);
        } finally { rmSync(temporary, { force: true }); }
    }
    update(input: {
        baseUrl?: string;
        apiKey?: string;
        apiMode?: Config['apiMode'];
        authMode?: Config['authMode'];
        cloudProjectId?: string;
        paused?: boolean;
        uploadMaxBytes?: number;
        historyUploadConfirmCount?: number;
    }) {
        if (input.historyUploadConfirmCount !== undefined && (!Number.isSafeInteger(input.historyUploadConfirmCount) || input.historyUploadConfirmCount <= 0))
            throw new Error('历史上传确认条数须为正整数');
        if (input.uploadMaxBytes !== undefined && (!Number.isSafeInteger(input.uploadMaxBytes) || input.uploadMaxBytes <= 0))
            throw new Error('上传字节上限须为正整数');
        const next = { ...this.value };
        if (input.apiMode !== undefined) {
            if (!['algorithm', 'engineering'].includes(input.apiMode)) throw new Error('未知接口类型');
            next.authMode = input.authMode ?? 'token';
            next.apiMode = input.apiMode;
            if (input.apiMode === 'algorithm' && input.cloudProjectId === undefined && !next.cloudProjectId)
                next.cloudProjectId = defaultAlgorithmProjectId;
        }
        if (input.authMode !== undefined) {
            if (!['none', 'token', 'bearer'].includes(input.authMode)) throw new Error('未知鉴权方式');
            next.authMode = input.authMode;
        }
        if (input.cloudProjectId !== undefined) {
            if (typeof input.cloudProjectId !== 'string') throw new Error('云服务项目 ID 须为字符串');
            next.cloudProjectId = input.cloudProjectId.trim();
        }
        if (input.baseUrl !== undefined) {
            if (typeof input.baseUrl !== 'string') throw new Error('服务地址无效');
            const url = new URL(input.baseUrl);
            if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash)
                throw new Error('服务地址必须为HTTP或HTTPS且不能内嵌凭据、查询或片段');
            next.baseUrl = url.href.replace(/\/+$/, '');
        }
        if (input.apiKey !== undefined) {
            if (typeof input.apiKey !== 'string' || /[\r\n]/.test(input.apiKey)) throw new Error('API Key 无效');
            next.apiKey = input.apiKey;
        }
        if (input.paused !== undefined && !!input.paused !== next.paused) {
            next.paused = !!input.paused;
            const time = Date.now();
            const pauses = next.uploadPauses ?? [];
            if (next.paused) next.uploadPauses = [...pauses, { start: time }];
            else next.uploadPauses = [...pauses.slice(0, -1), { start: pauses.at(-1)?.start ?? 0, end: time }];
        }
        if (input.uploadMaxBytes !== undefined) next.uploadMaxBytes = input.uploadMaxBytes;
        if (input.historyUploadConfirmCount !== undefined) next.historyUploadConfirmCount = input.historyUploadConfirmCount;
        this.save(next);
        this.value = next;
        this.revision++;
        return this.public();
    }
    public() { const { apiKey, installationId: _installationId, uploadPauses: _pauses, ...rest } = this.value; const error = connectionError(this.value); return { ...rest, keyConfigured: !!apiKey, apiKeyLength: Array.from(apiKey).length, connectionConfigured: !error, connectionError: error ?? null }; }
}
