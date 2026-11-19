import { randomUUID } from 'node:crypto';
import type { Store, Batch } from './store.ts';

type Row = Record<string, any>;
export type HistoryRecord = { nativeSessionId: string; sourceId: string };

/** One immutable batch body, with independent receipts for each destination. */
export class Deliveries {
    private store: Store;
    constructor(store: Store) {
        this.store = store;
        store.db.exec(`CREATE TABLE IF NOT EXISTS batch_traces(batchId TEXT NOT NULL REFERENCES batches(id),traceId INTEGER NOT NULL REFERENCES traces(id),PRIMARY KEY(batchId,traceId));
CREATE TABLE IF NOT EXISTS batch_deliveries(batchId TEXT NOT NULL REFERENCES batches(id),baseUrl TEXT NOT NULL,spaceId TEXT NOT NULL,kind TEXT NOT NULL,status TEXT NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,taskId TEXT,processingStatus TEXT,error TEXT,PRIMARY KEY(batchId,baseUrl,spaceId));
CREATE INDEX IF NOT EXISTS delivery_trace ON batch_traces(traceId,batchId);`);
        // Import only confirmed legacy targets. No new destination is inferred.
        for (const row of store.rows('SELECT * FROM batches b WHERE uploaded=1 AND NOT EXISTS(SELECT 1 FROM batch_deliveries d WHERE d.batchId=b.id)')) {
            const batch = { ...row, messages: JSON.parse(String(row.messages)), spaceIds: row.spaceIds ? JSON.parse(String(row.spaceIds)) : [], uploaded: true } as Batch;
            if (!batch.spaceIds?.length) continue;
            const baseUrl = store.binding(batch.objectId)?.baseUrl;
            if (!baseUrl) continue;
            this.indexBatch(batch);
            for (const spaceId of batch.spaceIds) store.db.prepare('INSERT OR IGNORE INTO batch_deliveries VALUES(?,?,?,?,?,?,?,?,?)')
                .run(batch.id, baseUrl, spaceId, 'live', batch.status, batch.attempts, batch.taskId, batch.processingStatus, batch.error);
        }
    }
    private rowsForBatch(batch: Batch): Row[] {
        const rows = this.store.rows(`SELECT t.*,s.nativeSessionId,m.occurredAt,m.sourceOrdinal FROM traces t JOIN sessions s ON s.id=t.sessionId
LEFT JOIN codex_event_meta m ON m.traceId=t.id WHERE t.sessionId=? AND (t.batchId=? OR t.conversationId=? OR EXISTS(SELECT 1 FROM batch_traces bt WHERE bt.batchId=? AND bt.traceId=t.id))
ORDER BY COALESCE(m.occurredAt,t.createdAt),m.sourceOrdinal,t.id`, batch.sessionId, batch.id, batch.conversationId, batch.id) as Row[];
        // Match the frozen body, not any late records added to its turn.
        const used = new Set<number>();
        const matched: Row[] = [];
        for (const message of batch.messages) {
            const at = rows.findIndex((row, index) => !used.has(index) && JSON.stringify(JSON.parse(row.message)) === JSON.stringify(message));
            if (at < 0) continue;
            matched.push(rows[at]!); used.add(at);
        }
        return matched;
    }
    private indexBatch(batch: Batch) {
        if (this.store.row('SELECT 1 FROM batch_traces WHERE batchId=? LIMIT 1', batch.id)) return;
        for (const row of this.rowsForBatch(batch)) this.store.db.prepare('INSERT OR IGNORE INTO batch_traces VALUES(?,?)').run(batch.id, Number(row.id));
    }
    private covered(traceId: number, baseUrl: string, spaceId: string, includeQueued: boolean) {
        return !!this.store.row(`SELECT 1 FROM batch_traces t JOIN batch_deliveries d ON d.batchId=t.batchId
WHERE t.traceId=? AND d.baseUrl=? AND d.spaceId=? AND d.status IN (${includeQueued ? "'pending','sending','accepted','completed','processing-failed'" : "'accepted','completed','processing-failed'"}) LIMIT 1`, traceId, baseUrl, spaceId);
    }
    private time(row: Row): string {
        if (row.occurredAt) return String(row.occurredAt);
        return this.store.memory.recordTime(JSON.parse(row.raw)) ?? String(row.createdAt);
    }
    queueLive() {
        for (const batch of this.store.batches('pending')) {
            const session = this.store.session(batch.sessionId);
            const scope = session && this.store.memory.forSession(session);
            if (!scope || batch.attempts || batch.uploaded) continue;
            if (this.store.row("SELECT 1 FROM batch_deliveries WHERE batchId=? AND kind='history'", batch.id)) continue;
            this.indexBatch(batch);
            const rows = this.rowsForBatch(batch);
            for (const spaceId of scope.spaceIds) {
                // A newly attached Space receives old content only after the user asks.
                const binding = this.store.row('SELECT boundAt FROM bindings WHERE objectId=? AND spaceId=?', scope.id, spaceId);
                const eligible = rows.filter(row => this.store.memory.allows(scope.id, this.time(row)) && this.time(row) >= String(binding?.boundAt ?? scope.enabledAt));
                const missing = eligible.filter(row => !this.covered(Number(row.id), scope.baseUrl, spaceId, true));
                if (!missing.length || this.store.row('SELECT 1 FROM batch_deliveries WHERE batchId=? AND baseUrl=? AND spaceId=?', batch.id, scope.baseUrl, spaceId)) continue;
                this.queue(scope.id, batch.sessionId, scope.baseUrl, spaceId, missing, 'live', missing.length === rows.length ? batch : undefined);
            }
        }
    }
    private queue(scopeId: string, sessionId: string, baseUrl: string, spaceId: string, rows: Row[], kind: string, original?: Batch) {
        const messages = rows.map(row => JSON.parse(row.message)), payload = JSON.stringify(messages);
        const oversized = Buffer.byteLength(payload, 'utf8') > 39000;
        const batchId = original?.id ?? randomUUID();
        if (!original) this.store.db.prepare('INSERT INTO batches(id,sessionId,objectId,messages,status,error,createdAt) VALUES(?,?,?,?,?,?,?)')
            .run(batchId, sessionId, scopeId, payload, oversized ? 'blocked' : 'pending', oversized ? '整轮轨迹超出保守上传容量；完整内容已保留' : null, new Date().toISOString());
        for (const row of rows) this.store.db.prepare('INSERT OR IGNORE INTO batch_traces VALUES(?,?)').run(batchId, Number(row.id));
        this.store.db.prepare('INSERT OR IGNORE INTO batch_deliveries(batchId,baseUrl,spaceId,kind,status,error) VALUES(?,?,?,?,?,?)')
            .run(batchId, baseUrl, spaceId, kind, oversized ? 'blocked' : 'pending', oversized ? '历史轮次超过上传容量' : null);
        return batchId;
    }
    queueHistory(scopeId: string, targets: string[], catalog: HistoryRecord[]) {
        const scope = this.store.memory.get(scopeId);
        if (!scope?.spaceIds.length) return;
        const keyFor = (nativeSessionId: string, sourceId: string) => sourceId.startsWith('codex:v2:') ? sourceId : JSON.stringify([nativeSessionId, sourceId]);
        const wanted = new Set(catalog.map(row => keyFor(row.nativeSessionId, row.sourceId)));
        const rows = this.store.rows(`SELECT t.*,s.nativeSessionId,m.occurredAt,m.sourceOrdinal FROM traces t JOIN sessions s ON s.id=t.sessionId
LEFT JOIN codex_event_meta m ON m.traceId=t.id WHERE s.objectId=? ORDER BY COALESCE(m.occurredAt,t.createdAt),m.sourceOrdinal,t.id`, scopeId) as Row[];
        this.store.db.exec('BEGIN');
        try {
            for (const spaceId of targets.filter(id => scope.spaceIds.includes(id))) {
                const groups = new Map<string, Row[]>();
                for (const row of rows) {
                    if (!wanted.has(keyFor(String(row.nativeSessionId), String(row.sourceId))) || this.covered(Number(row.id), scope.baseUrl, spaceId, true)) continue;
                    const key = JSON.stringify([row.sessionId, row.conversationId]);
                    const group = groups.get(key) ?? []; group.push(row); groups.set(key, group);
                }
                for (const group of groups.values()) this.queue(scopeId, String(group[0]!.sessionId), scope.baseUrl, spaceId, group, 'history');
            }
            this.store.db.exec('COMMIT');
        } catch (error) { this.store.db.exec('ROLLBACK'); throw error; }
    }
    historyPending(scopeId: string, catalog: HistoryRecord[]) {
        const scope = this.store.memory.get(scopeId);
        if (!scope?.spaceIds.length) return 0;
        let count = 0;
        for (const item of catalog) {
            const trace = item.sourceId.startsWith('codex:v2:')
                ? this.store.row('SELECT t.id FROM traces t JOIN sessions s ON s.id=t.sessionId WHERE s.objectId=? AND t.sourceId=?', scopeId, item.sourceId)
                : this.store.row('SELECT t.id FROM traces t JOIN sessions s ON s.id=t.sessionId WHERE s.objectId=? AND s.nativeSessionId=? AND t.sourceId=?', scopeId, item.nativeSessionId, item.sourceId);
            for (const spaceId of scope.spaceIds) if (!trace || !this.covered(Number(trace.id), scope.baseUrl, spaceId, false)) count++;
        }
        return count;
    }
    historyRunning(scopeId: string) {
        const scope = this.store.memory.get(scopeId);
        if (!scope?.spaceIds.length) return false;
        return this.store.rows(`SELECT d.spaceId FROM batch_deliveries d JOIN batches b ON b.id=d.batchId WHERE b.objectId=? AND d.baseUrl=? AND d.kind='history' AND d.status IN ('pending','sending')`, scopeId, scope.baseUrl)
            .some(row => scope.spaceIds.includes(String(row.spaceId)));
    }
    historyError(scopeId: string): string | undefined {
        const failed = this.store.row(`SELECT d.spaceId,d.status,d.error FROM batch_deliveries d
JOIN batches b ON b.id=d.batchId JOIN bindings binding ON binding.objectId=b.objectId AND binding.baseUrl=d.baseUrl AND binding.spaceId=d.spaceId
WHERE b.objectId=? AND d.kind='history' AND d.status IN ('failed','blocked','processing-failed')
AND EXISTS(SELECT 1 FROM batch_traces original WHERE original.batchId=d.batchId AND NOT EXISTS(
SELECT 1 FROM batch_traces replacement JOIN batch_deliveries success ON success.batchId=replacement.batchId
WHERE replacement.traceId=original.traceId AND success.baseUrl=d.baseUrl AND success.spaceId=d.spaceId AND success.status IN ('accepted','completed')))
ORDER BY b.createdAt DESC LIMIT 1`, scopeId);
        if (!failed) return undefined;
        return `${failed.spaceId}：${failed.error || (failed.status === 'processing-failed' ? '云端处理失败' : failed.status === 'blocked' ? '内容超过上传容量' : '发送失败')}`;
    }
    pending() {
        return this.store.rows("SELECT d.*,b.sessionId,b.objectId,b.messages FROM batch_deliveries d JOIN batches b ON b.id=d.batchId WHERE d.status='pending' ORDER BY b.createdAt,b.rowid") as Row[];
    }
    ready(delivery: Row): Row | undefined {
        const current = this.store.row(`SELECT d.*,b.sessionId,b.objectId,b.messages FROM batch_deliveries d JOIN batches b ON b.id=d.batchId
WHERE d.batchId=? AND d.baseUrl=? AND d.spaceId=? AND d.status='pending'`, delivery.batchId, delivery.baseUrl, delivery.spaceId) as Row | undefined;
        if (!current) return undefined;
        if (Number(current.attempts) >= 2) { this.update(current, { status: 'failed' }); return undefined; }
        const row = this.store.row('SELECT * FROM batches WHERE id=?', current.batchId)!;
        const batch = { ...row, messages: JSON.parse(String(row.messages)), uploaded: !!row.uploaded } as Batch;
        if (current.kind === 'live' && !batch.attempts && batch.conversationId) {
            // A different request may have appended content while an earlier upload awaited.
            // Claim the latest body only at the first attempt; retries keep that body frozen.
            const rows = this.rowsForBatch(batch);
            const binding = this.store.row('SELECT boundAt FROM bindings WHERE objectId=? AND spaceId=? AND baseUrl=?', current.objectId, current.spaceId, current.baseUrl);
            const eligible = rows.filter(row => binding && this.store.memory.allows(String(current.objectId), this.time(row)) && this.time(row) >= String(binding.boundAt));
            if (eligible.length !== rows.length || !eligible.length) {
                this.update(current, { status: 'cancelled' });
                if (!eligible.length) return undefined;
                const batchId = this.queue(String(current.objectId), String(current.sessionId), String(current.baseUrl), String(current.spaceId), eligible, 'live');
                return this.ready({ ...current, batchId });
            }
            this.store.db.prepare('DELETE FROM batch_traces WHERE batchId=?').run(batch.id);
            this.indexBatch(batch);
        }
        return current;
    }
    isPending(delivery: Row) {
        return !!this.store.row("SELECT 1 FROM batch_deliveries WHERE batchId=? AND baseUrl=? AND spaceId=? AND status='pending'", delivery.batchId, delivery.baseUrl, delivery.spaceId);
    }
    accepted() {
        return this.store.rows("SELECT d.*,b.objectId FROM batch_deliveries d JOIN batches b ON b.id=d.batchId WHERE d.status='accepted'") as Row[];
    }
    update(delivery: Row, values: Row) {
        const fields = Object.keys(values);
        if (!fields.every(field => ['status', 'attempts', 'taskId', 'processingStatus', 'error'].includes(field))) throw new Error('非法上传状态字段');
        this.store.db.prepare(`UPDATE batch_deliveries SET ${fields.map(field => field + '=?').join(',')} WHERE batchId=? AND baseUrl=? AND spaceId=?`)
            .run(...fields.map(field => values[field]), delivery.batchId, delivery.baseUrl, delivery.spaceId);
        const rows = this.store.rows('SELECT * FROM batch_deliveries WHERE batchId=?', delivery.batchId) as Row[];
        const received = rows.every(row => ['accepted', 'completed', 'processing-failed'].includes(row.status));
        const status = rows.every(row => row.status === 'completed') ? 'completed' : received ? rows.some(row => row.status === 'processing-failed') ? 'processing-failed' : 'accepted'
            : rows.some(row => row.status === 'pending' || row.status === 'sending') ? 'pending' : rows.some(row => row.status === 'blocked') ? 'blocked' : 'failed';
        this.store.updateBatch(delivery.batchId, { status, uploaded: received, attempts: Math.max(...rows.map(row => Number(row.attempts))),
            spaceIds: rows.map(row => String(row.spaceId)), taskId: rows.length === 1 ? rows[0]!.taskId : null,
            processingStatus: rows.length === 1 ? rows[0]!.processingStatus : null, error: rows.find(row => row.error)?.error ?? null });
    }
}
