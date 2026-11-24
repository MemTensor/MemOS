import { readFileSync, mkdirSync, openSync, closeSync, writeFileSync, linkSync, unlinkSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { defaultDataDir } from '../../config/config.ts';
import { LOCAL_API_VERSION, currentRuntimeRevision } from '../../runtime/revision.ts';
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
interface Endpoint { url: string; pid: number }
interface Health { service?: string; apiVersion?: number; runtimeRevision?: string; pid?: number }
interface Running { url: string; health: Health; managedPid?: number }
function localUrl(value: string) {
    const url = new URL(value);
    if (!['127.0.0.1', 'localhost'].includes(url.hostname) || url.protocol !== 'http:')
        throw new Error('本地服务必须使用回环HTTP地址');
    return url.origin;
}
function endpoint(): Endpoint | null {
    try { return JSON.parse(readFileSync(join(defaultDataDir(), 'service.json'), 'utf8')) as Endpoint; }
    catch { return null; }
}
async function running(): Promise<Running | null> {
    try {
        const saved = endpoint();
        const value = process.env.MEMOS_PM_URL || saved?.url;
        if (!value) return null;
        // Capture uses synchronous SQLite; allow a bounded busy cycle before treating the service as unavailable.
        const url = localUrl(value), response = await fetch(url + '/api/health', { signal: AbortSignal.timeout(2000) });
        const health = await response.json() as Health;
        return response.ok && health.service === 'memos-project-memory-plugin' ? { url, health, managedPid: saved?.pid } : null;
    } catch { return null; }
}
function compatible(value: Running): boolean {
    return value.health.apiVersion === LOCAL_API_VERSION && value.health.runtimeRevision === currentRuntimeRevision();
}
function alive(pid: number): boolean {
    try { process.kill(pid, 0); return true; }
    catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH'; }
}
async function stopManaged(value: Running): Promise<void> {
    const saved = endpoint();
    if (!saved || saved.pid !== value.managedPid) return;
    let lock: number;
    try { lock = Number(readFileSync(join(defaultDataDir(), 'service.lock'), 'utf8')); }
    catch { throw new Error('无法核对旧服务归属，请手动重启项目记忆服务'); }
    if (!saved || localUrl(saved.url) !== value.url || !Number.isInteger(saved.pid) || saved.pid <= 1 || saved.pid === process.pid || lock !== saved.pid || value.health.pid !== undefined && value.health.pid !== saved.pid)
        throw new Error('旧服务归属记录不一致，请手动重启项目记忆服务');
    if (alive(saved.pid)) {
        try { process.kill(saved.pid, 'SIGTERM'); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
    }
    for (let i = 0; i < 200; i++) {
        if (!alive(saved.pid)) return;
        await pause(100);
    }
    throw new Error('旧服务尚未退出，请稍后重试；未强制终止或删除服务锁');
}
interface StartupOwner { pid: number; token: string; url?: string }
/** Publish a complete owner record atomically, including the endpoint needed after a crashed restart. */
async function withStartupLock(work: (previousUrl?: string) => Promise<string>): Promise<string> {
    const directory = defaultDataDir();
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const lock = join(directory, 'service.startup.lock'), token = randomUUID();
    const ownerPath = join(directory, `.service-startup-${process.pid}-${token}`);
    let acquired = false, previousUrl: string | undefined;
    const release = () => {
        try {
            const owner = JSON.parse(readFileSync(lock, 'utf8')) as StartupOwner;
            if (acquired && owner.pid === process.pid && owner.token === token) unlinkSync(lock);
        } catch { }
        try { unlinkSync(ownerPath); } catch { }
    };
    try {
        for (let attempt = 0; attempt < 300; attempt++) {
            previousUrl = endpoint()?.url ?? previousUrl;
            const owner: StartupOwner = { pid: process.pid, token, ...(previousUrl ? { url: previousUrl } : {}) };
            // Linking a prewritten file avoids exposing an empty wx-created lock to another client.
            writeFileSync(ownerPath, JSON.stringify(owner), { mode: 0o600 });
            try { linkSync(ownerPath, lock); acquired = true; break; }
            catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
            try {
                const observed = readFileSync(lock, 'utf8'), holder = JSON.parse(observed) as StartupOwner;
                if (!Number.isSafeInteger(holder.pid) || holder.pid <= 1 || typeof holder.token !== 'string')
                    throw new Error('项目记忆启动锁身份无效，无法安全接管');
                if (!alive(holder.pid) && readFileSync(lock, 'utf8') === observed) {
                    previousUrl = holder.url ?? previousUrl;
                    unlinkSync(lock);
                    continue;
                }
            } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
            await pause(100);
        }
        if (!acquired) throw new Error('另一进程正在启动项目记忆服务，请稍后重试');
        process.once('exit', release);
        return await work(previousUrl);
    } finally {
        process.removeListener('exit', release);
        release();
    }
}
let starting: Promise<string> | null = null;
async function startService(): Promise<string> {
    if (process.env.MEMOS_PM_URL) {
        const existing = await running();
        if (existing) return existing.url;
        throw new Error('指定本地服务不可用');
    }
    return withStartupLock(startManagedService);
}
async function startManagedService(previousUrl?: string): Promise<string> {
    const existing = await running();
    if (existing && compatible(existing)) return existing.url;
    const savedUrl = endpoint()?.url ?? previousUrl;
    let port = process.env.MEMOS_PM_PORT ?? (savedUrl ? new URL(localUrl(savedUrl)).port : undefined);
    if (existing) {
        port = new URL(existing.url).port;
        await stopManaged(existing);
    }
    // Another client may have completed the same replacement in the meantime.
    const current = await running();
    if (current && compatible(current)) return current.url;
    const directory = defaultDataDir();
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const output = openSync(join(directory, 'service.log'), 'a', 0o600);
    const child = spawn(process.execPath, [fileURLToPath(new URL('../../runtime/main.ts', import.meta.url))], { detached: true, stdio: ['ignore', output, output], env: { ...process.env, ...(port ? { MEMOS_PM_PORT: port } : {}) } });
    child.on('error', () => { /* Startup is reported by the bounded health check below. */ });
    child.unref(); closeSync(output);
    for (let i = 0; i < 50; i++) {
        await pause(100);
        const value = await running();
        if (value && compatible(value)) return value.url;
    }
    throw new Error('项目记忆本地服务启动失败或版本未更新');
}
export async function ensureService(): Promise<string> {
    if (!starting) starting = startService().finally(() => { starting = null; });
    return starting;
}
export async function serviceRequest<T = any>(path: string, body?: unknown, method?: string): Promise<T> {
    const url = await ensureService();
    const response = await fetch(url + path, { method: method ?? (body === undefined ? 'GET' : 'POST'), headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(20000) });
    const result = await response.json() as T & {
        error?: unknown;
    };
    if (!response.ok)
        throw new Error(typeof result.error === 'string' ? result.error : '本地服务请求失败');
    return result;
}

/** Binding is scoped to this host and workspace; never reuse an activation cache. */
export async function isMemoryActive(agentType: string, cwd: string, nativeSessionId?: string, parentNativeSessionId?: string): Promise<boolean> {
 const query = new URLSearchParams({ agentType, cwd });
 if (nativeSessionId) query.set('nativeSessionId', nativeSessionId);
 if (parentNativeSessionId) query.set('parentNativeSessionId', parentNativeSessionId);
 return (await serviceRequest<{ active: boolean }>(`/api/activation?${query}`)).active === true;
}
