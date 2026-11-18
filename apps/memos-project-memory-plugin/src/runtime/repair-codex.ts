import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { chmod, copyFile, mkdtemp, open, readFile, realpath, rename, rm, stat, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Store } from '../storage/store.ts';
import { CodexCapture } from '../server/codex-capture.ts';
import { sanitizeStoredContent } from '../storage/sanitize-content.ts';

export interface RepairOptions { dataDir: string; sourceRoots?: string[]; apply?: boolean }
export interface RepairCounts {
    sessions: number;
    rounds: number;
    events: number;
    blockedBatches: number;
    unresolved: { rounds: number; executions: number; receipts: number; sources: number; legacySessions: number };
}
export interface RepairReport {
    ok: true;
    mode: 'dry-run' | 'apply';
    databasePath: string;
    backupPath?: string;
    before: RepairCounts;
    after: RepairCounts;
}

function counts(db: DatabaseSync): RepairCounts {
    const has = (table: string) => !!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table);
    const count = (sql: string) => Number(db.prepare(sql).get()?.n ?? 0);
    const meta = has('codex_source_meta'), canonical = has('codex_rounds');
    const userScope = `s.agentType='codex-cli'${meta ? " AND (NOT EXISTS(SELECT 1 FROM codex_source_meta m WHERE m.nativeSessionId=s.nativeSessionId) OR EXISTS(SELECT 1 FROM codex_source_meta m WHERE m.nativeSessionId=s.nativeSessionId AND m.sourceKind='user'))" : ''}`;
    const legacyOwner = canonical ? ' AND NOT EXISTS(SELECT 1 FROM codex_rounds r WHERE r.ownerSessionId=s.id)' : '';
    const canonicalEvents = has('codex_event_meta') && has('codex_event_sources')
        ? count('SELECT count(DISTINCT m.traceId) AS n FROM codex_event_meta m JOIN traces t ON t.id=m.traceId WHERE EXISTS(SELECT 1 FROM codex_event_sources es WHERE es.sourceId=m.sourceId)') : 0;
    return {
        sessions: count(`SELECT count(*) AS n FROM sessions s WHERE ${userScope}`),
        rounds: count(`SELECT count(*) AS n FROM turns t JOIN sessions s ON s.id=t.sessionId WHERE ${userScope}${legacyOwner}`)
            + (canonical ? count('SELECT count(*) AS n FROM codex_rounds') : 0),
        events: count(`SELECT count(*) AS n FROM traces t JOIN sessions s ON s.id=t.sessionId WHERE ${userScope}${legacyOwner}`) + canonicalEvents,
        blockedBatches: count("SELECT count(*) AS n FROM batches b JOIN sessions s ON s.id=b.sessionId WHERE s.agentType='codex-cli' AND b.status='blocked'"),
        unresolved: {
            rounds: canonical ? count("SELECT count(*) AS n FROM codex_rounds WHERE captureStatus!='complete'") : 0,
            executions: has('codex_execution_sources') && has('codex_execution_map') ? count(`SELECT count(*) AS n FROM (
                SELECT DISTINCT s.nativeSessionId,s.nativeTurnId FROM codex_execution_sources s
                WHERE NOT EXISTS(SELECT 1 FROM codex_execution_map m WHERE m.nativeSessionId=s.nativeSessionId AND m.nativeTurnId=s.nativeTurnId)
            )`) : 0,
            receipts: has('codex_receipts') ? count("SELECT count(*) AS n FROM codex_receipts WHERE status='pending'") : 0,
            sources: has('codex_sources') && meta ? count("SELECT count(*) AS n FROM (SELECT path FROM codex_sources WHERE error IS NOT NULL UNION SELECT sourcePath AS path FROM codex_source_meta WHERE gaps!='[]')") : 0,
            legacySessions: meta ? count("SELECT count(*) AS n FROM sessions s WHERE s.agentType='codex-cli' AND NOT EXISTS(SELECT 1 FROM codex_source_meta m WHERE m.nativeSessionId=s.nativeSessionId)") : count("SELECT count(*) AS n FROM sessions WHERE agentType='codex-cli'"),
        },
    };
}
/** Clone logically into memory: no temporary on-disk copy of image bytes or host wrappers. */
function cleanSnapshot(path: string): { db: DatabaseSync; before: RepairCounts } {
    const source = new DatabaseSync(path, { readOnly: true }), clean = new DatabaseSync(':memory:');
    const quote = (name: unknown) => '"' + String(name).replaceAll('"', '""') + '"';
    try {
        source.exec('BEGIN');
        clean.exec('PRAGMA temp_store=MEMORY; BEGIN');
        const schema = source.prepare("SELECT name,type,sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%'").all();
        const before = counts(source);
        for (const table of schema.filter(row => row.type === 'table')) {
            clean.exec(String(table.sql));
            const columns = source.prepare(`PRAGMA table_xinfo(${quote(table.name)})`).all().filter(row => !row.hidden).map(row => quote(row.name));
            const insert = clean.prepare(`INSERT INTO ${quote(table.name)} (${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`);
            for (const row of source.prepare(`SELECT ${columns.join(',')} FROM ${quote(table.name)}`).iterate()) insert.run(...Object.values(row));
        }
        if (source.prepare("SELECT 1 FROM sqlite_master WHERE name='sqlite_sequence'").get()) {
            clean.exec('DELETE FROM sqlite_sequence');
            for (const row of source.prepare('SELECT name,seq FROM sqlite_sequence').iterate()) clean.prepare('INSERT INTO sqlite_sequence VALUES(?,?)').run(String(row.name), Number(row.seq));
        }
        for (const item of schema.filter(row => row.type !== 'table')) clean.exec(String(item.sql));
        clean.exec(`PRAGMA user_version=${Number(source.prepare('PRAGMA user_version').get()?.user_version ?? 0)}; COMMIT`);
        source.exec('COMMIT');
        sanitizeStoredContent(clean);
        // Remove freed pages before the first disk write, including deleted image overflow pages.
        clean.exec('VACUUM');
        return { db: clean, before };
    } catch (error) { clean.close(); throw error; }
    finally { source.close(); }
}
async function ensureServiceStopped(directory: string): Promise<void> {
    let value: string;
    try { value = await readFile(join(directory, 'service.lock'), 'utf8'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
    const pid = Number(value.trim());
    if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('service.lock 无有效 PID，无法确认服务已停止');
    try { process.kill(pid, 0); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return; throw new Error('无法确认本地服务已停止，请停止服务后再修复', { cause: error }); }
    throw new Error(`本地服务仍在运行（PID ${pid}），请停止服务后再应用修复`);
}
async function replay(path: string, sourceRoots?: string[]): Promise<RepairCounts> {
    const store = new Store(path);
    let capture: CodexCapture | undefined;
    try {
        capture = new CodexCapture(store, sourceRoots === undefined ? {} : { codexRoots: sourceRoots.map(root => resolve(root)) });
        await capture.flush(true); store.prepareCodexUploads(); return counts(store.db);
    } finally { capture?.close(); store.close(); }
}

/** No Configuration/CloudClient: repair reads source rollouts and SQLite only. */
export async function repairCodexHistory(options: RepairOptions): Promise<RepairReport> {
    if (!options.dataDir?.trim()) throw new Error('必须提供 --data-dir <数据目录>');
    const directory = await realpath(resolve(options.dataDir)), databasePath = join(directory, 'memory.sqlite');
    if (!(await stat(databasePath)).isFile()) throw new Error('数据目录中没有 memory.sqlite 文件');
    if (!options.apply) {
        const temporary = await mkdtemp(join(tmpdir(), 'memos-codex-preview-')), copy = join(temporary, 'memory.sqlite');
        try {
            const snapshot = cleanSnapshot(databasePath);
            try { snapshot.db.prepare('VACUUM INTO ?').run(copy); } finally { snapshot.db.close(); }
            await chmod(copy, 0o600);
            const after = await replay(copy, options.sourceRoots);
            return { ok: true, mode: 'dry-run', databasePath, before: snapshot.before, after };
        } finally { await rm(temporary, { recursive: true, force: true }); }
    }
    await ensureServiceStopped(directory);
    const lockPath = join(directory, 'repair.lock');
    const lock = await open(lockPath, 'wx', 0o600).catch(error => {
        if (error.code === 'EEXIST') throw new Error('已有 repair.lock；确认对应修复进程已结束后再处理该锁');
        throw error;
    });
    let backupPath: string | undefined, backupComplete = false;
    try {
        await lock.writeFile(String(process.pid)); await lock.sync();
        await ensureServiceStopped(directory);
        backupPath = join(directory, `memory.sqlite.before-codex-repair-${Date.now()}-${randomUUID().slice(0, 8)}.sqlite`);
        const destination = await open(backupPath, 'wx', 0o600); await destination.close();
        const snapshot = cleanSnapshot(databasePath);
        try { snapshot.db.prepare('VACUUM INTO ?').run(backupPath); } finally { snapshot.db.close(); }
        await chmod(backupPath, 0o600); backupComplete = true;
        const temporary = await mkdtemp(join(directory, '.codex-repair-')), copy = join(temporary, 'memory.sqlite');
        try {
            await copyFile(backupPath, copy);
            const after = await replay(copy, options.sourceRoots);
            await ensureServiceStopped(directory);
            const repaired = new DatabaseSync(copy);
            try {
                sanitizeStoredContent(repaired); repaired.exec('VACUUM; PRAGMA wal_checkpoint(TRUNCATE); PRAGMA journal_mode=DELETE');
            } finally { repaired.close(); }
            // No service may own the database while replacing its inode. Flush and
            // remove the old WAL first, so it cannot replay onto the clean file.
            const original = new DatabaseSync(databasePath);
            try { original.exec('PRAGMA wal_checkpoint(TRUNCATE); PRAGMA journal_mode=DELETE'); } finally { original.close(); }
            await chmod(copy, 0o600);
            await rename(copy, databasePath);
            return { ok: true, mode: 'apply', databasePath, backupPath, before: snapshot.before, after };
        } finally { await rm(temporary, { recursive: true, force: true }); }
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`${message}${backupPath ? backupComplete ? `；备份保留于：${backupPath}。此备份已净化，不能恢复删除的宿主模板或图片；请核验后恢复。` : `；备份未完成：${backupPath}。尚未开始回放，请勿将此文件视为完整备份。` : ''}`, { cause: error });
    } finally {
        await lock.close();
        try { if ((await readFile(lockPath, 'utf8')).trim() === String(process.pid)) await unlink(lockPath); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
}

export async function runRepair(args: string[]): Promise<RepairReport> {
    let dataDir: string | undefined, apply = false;
    const sourceRoots: string[] = [];
    for (let index = 0; index < args.length; index++) {
        const flag = args[index];
        if (flag === '--apply' && !apply) { apply = true; continue; }
        if (flag !== '--data-dir' && flag !== '--source-root') throw new Error(`参数无效：${flag}`);
        const value = args[++index];
        if (!value || value.startsWith('--') || flag === '--data-dir' && dataDir !== undefined) throw new Error(`参数无效：${flag}`);
        if (flag === '--data-dir') dataDir = value; else sourceRoots.push(value);
    }
    if (!dataDir) throw new Error('用法：--data-dir <数据目录> [--source-root <rollout目录>]... [--apply]；默认仅预览');
    return repairCodexHistory({ dataDir, apply, ...(sourceRoots.length ? { sourceRoots } : {}) });
}

export async function repairMain(args = process.argv.slice(2)): Promise<void> {
    try { process.stdout.write(JSON.stringify(await runRepair(args), null, 2) + '\n'); }
    catch (error) { process.stderr.write(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }) + '\n'); process.exitCode = 1; }
}
if (import.meta.main) await repairMain();
