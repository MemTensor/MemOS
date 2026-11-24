import { createHash, randomUUID } from 'node:crypto';
import { chmodSync } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';
import type { CloudFailure } from '../cloud/client.ts';

export interface CloudDiagnostic extends CloudFailure {
    id: string;
    createdAt: string;
    lastOccurredAt: string;
    occurrences: number;
}
const endpoints = ['create/space', 'get/space', 'list/domains', 'get/memory', 'search/memory', 'add/message', 'get/status'];
export class CloudDiagnostics {
    private db: DatabaseSync;
    constructor(db: DatabaseSync, path: string) {
        this.db = db;
        if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='cloud_diagnostics'").get()) {
            if (path !== ':memory:' && (db.prepare('SELECT 1 FROM diagnostics LIMIT 1').get() || db.prepare('SELECT 1 FROM sessions LIMIT 1').get() || db.prepare('SELECT 1 FROM projects LIMIT 1').get())) {
                const backup = path + '.before-cloud-diagnostics-' + Date.now() + '.sqlite';
                db.prepare('VACUUM INTO ?').run(backup); chmodSync(backup, 0o600);
            }
            db.exec("CREATE TABLE cloud_diagnostics(id TEXT PRIMARY KEY,fingerprint TEXT NOT NULL,endpoint TEXT NOT NULL,method TEXT NOT NULL,kind TEXT NOT NULL,message TEXT NOT NULL,httpStatus INTEGER,businessCode TEXT,responseBody TEXT,context TEXT NOT NULL,createdAt TEXT NOT NULL,lastOccurredAt TEXT NOT NULL,occurrences INTEGER NOT NULL DEFAULT 1)");
        }
        const columns = db.prepare('PRAGMA table_info(cloud_diagnostics)').all() as { name: string }[];
        if (path !== ':memory:' && !columns.some(column => column.name === 'url') && db.prepare('SELECT 1 FROM cloud_diagnostics LIMIT 1').get()) {
            const backup = `${path}.before-diagnostic-connections-${Date.now()}.sqlite`;
            db.prepare('VACUUM INTO ?').run(backup); chmodSync(backup, 0o600);
        }
        for (const column of ['url', 'apiMode', 'reason']) {
            if (!columns.some(item => item.name === column))
                db.exec(`ALTER TABLE cloud_diagnostics ADD COLUMN ${column} TEXT`);
        }
        db.exec('CREATE INDEX IF NOT EXISTS cloud_diagnostic_recent ON cloud_diagnostics(lastOccurredAt DESC); CREATE INDEX IF NOT EXISTS cloud_diagnostic_fingerprint ON cloud_diagnostics(fingerprint,lastOccurredAt)');
    }
    record(failure: CloudFailure) {
        const fingerprint = createHash('sha256').update(JSON.stringify(failure)).digest('hex'), time = new Date().toISOString();
        const cutoff = new Date(Date.now() - 60000).toISOString();
        const previous = this.db.prepare('SELECT id FROM cloud_diagnostics WHERE fingerprint=? AND lastOccurredAt>=? ORDER BY lastOccurredAt DESC LIMIT 1').get(fingerprint, cutoff);
        if (previous) {
            this.db.prepare('UPDATE cloud_diagnostics SET lastOccurredAt=?,occurrences=occurrences+1 WHERE id=?').run(time, String(previous.id)); return;
        }
        this.db.prepare('INSERT INTO cloud_diagnostics(id,fingerprint,endpoint,method,kind,message,httpStatus,businessCode,responseBody,context,createdAt,lastOccurredAt,url,apiMode,reason) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
            .run(randomUUID(), fingerprint, failure.endpoint, failure.method, failure.kind, failure.message, failure.httpStatus,
                failure.businessCode === null ? null : JSON.stringify(failure.businessCode), failure.responseBody, JSON.stringify(failure.context), time, time, failure.url ?? null, failure.apiMode ?? null, failure.reason ?? null);
    }
    private parse(row: Record<string, unknown>) {
        const { fingerprint: _fingerprint, ...value } = row;
        return { ...value, businessCode: row.businessCode === null ? null : JSON.parse(String(row.businessCode)), context: JSON.parse(String(row.context)) } as unknown as CloudDiagnostic;
    }
    list({ endpoint = '', page = 1, size = 50 }: { endpoint?: string; page?: number; size?: number } = {}) {
        if (endpoint && !endpoints.includes(endpoint)) throw new Error('未知云服务操作');
        page = Number.isFinite(page) ? Math.max(1, Math.floor(page)) : 1;
        size = Number.isFinite(size) ? Math.min(100, Math.max(1, Math.floor(size))) : 50;
        const where = endpoint ? ' WHERE endpoint=?' : '', args = endpoint ? [endpoint] : [];
        const total = Number(this.db.prepare('SELECT count(*) n FROM cloud_diagnostics' + where).get(...args)!.n);
        const rows = this.db.prepare('SELECT id,endpoint,method,kind,message,httpStatus,businessCode,context,createdAt,lastOccurredAt,occurrences,url,apiMode,reason FROM cloud_diagnostics' + where + ' ORDER BY lastOccurredAt DESC,rowid DESC LIMIT ? OFFSET ?').all(...args, size, (page - 1) * size);
        return { items: rows.map(row => this.parse(row)) as Omit<CloudDiagnostic, 'responseBody'>[], total, page, size };
    }
    detail(id: string): CloudDiagnostic | undefined {
        const row = this.db.prepare('SELECT * FROM cloud_diagnostics WHERE id=?').get(id);
        return row ? this.parse(row) : undefined;
    }
    export() {
        return this.db.prepare('SELECT * FROM cloud_diagnostics ORDER BY lastOccurredAt DESC,rowid DESC').all().map(row => this.parse(row));
    }
}
