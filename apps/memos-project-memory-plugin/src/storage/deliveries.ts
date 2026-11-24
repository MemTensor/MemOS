import { messageRequest } from '../cloud/upload.ts';
import { requestBodyBytes } from '../cloud/protocol.ts';
import { uploadMessages, uploadValidationError } from '../adapters/_shared/message-content.ts';
import { randomUUID } from 'node:crypto';
import { chmodSync } from 'node:fs';
import type { Message } from '../adapters/types.ts';
import type { Store, Batch } from './store.ts';
import { filterUploadTraces } from './upload-filter.ts';
import { hasIncompleteSkill } from '../adapters/_shared/skill-records.ts';
import { hasSkillFilter } from '../adapters/skill-filters.ts';
import { orderCursorTraces } from '../adapters/cursor-cli/source.ts';

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
        this.migrateConnections();
        // Import only confirmed legacy targets. No new destination is inferred.
        for (const row of store.rows('SELECT * FROM batches b WHERE uploaded=1 AND NOT EXISTS(SELECT 1 FROM batch_deliveries d WHERE d.batchId=b.id)')) {
            const batch = { ...row, messages: JSON.parse(String(row.messages)), spaceIds: row.spaceIds ? JSON.parse(String(row.spaceIds)) : [], uploaded: true } as Batch;
            if (!batch.spaceIds?.length) continue;
            const baseUrl = store.binding(batch.objectId)?.baseUrl;
            if (!baseUrl) continue;
            this.indexBatch(batch);
            for (const spaceId of batch.spaceIds) store.db.prepare('INSERT OR IGNORE INTO batch_deliveries(batchId,baseUrl,spaceId,kind,status,attempts,taskId,processingStatus,error,connectionId) VALUES(?,?,?,?,?,?,?,?,?,?)')
                .run(batch.id, baseUrl, spaceId, 'live', batch.status, batch.attempts, batch.taskId, batch.processingStatus, batch.error, this.store.binding(batch.objectId)!.connectionId);
        }
        this.migrateUploads();
    }
    private migrateConnections() {
        if (this.store.rows('PRAGMA table_info(batch_deliveries)').some(column => column.name === 'connectionId')) return;
        const path = this.store.row('PRAGMA database_list')?.file;
        if (path && this.store.row('SELECT 1 FROM batch_deliveries LIMIT 1')) {
            const backup = `${path}.before-delivery-connections-${Date.now()}.sqlite`;
            this.store.db.prepare('VACUUM INTO ?').run(backup); chmodSync(backup, 0o600);
        }
        this.store.db.exec('BEGIN');
        try {
            this.store.db.exec("CREATE TABLE batch_deliveries_connection(batchId TEXT NOT NULL REFERENCES batches(id),baseUrl TEXT NOT NULL,connectionId TEXT NOT NULL,spaceId TEXT NOT NULL,kind TEXT NOT NULL,status TEXT NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,taskId TEXT,processingStatus TEXT,error TEXT,userId TEXT,openEpisodeMessages INTEGER,memoryIds TEXT,PRIMARY KEY(batchId,connectionId,spaceId))");
            for (const row of this.store.rows('SELECT * FROM batch_deliveries')) {
                const connectionId = JSON.stringify(['engineering', String(row.baseUrl).replace(/\/+$/, ''), '']);
                this.store.db.prepare('INSERT INTO batch_deliveries_connection(batchId,baseUrl,connectionId,spaceId,kind,status,attempts,taskId,processingStatus,error,userId) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
                    .run(String(row.batchId), String(row.baseUrl), connectionId, String(row.spaceId), String(row.kind), String(row.status), Number(row.attempts), row.taskId === null ? null : String(row.taskId), row.processingStatus === null ? null : String(row.processingStatus), row.error === null ? null : String(row.error), this.store.config?.value.userId ?? null);
            }
            this.store.db.exec('DROP TABLE batch_deliveries; ALTER TABLE batch_deliveries_connection RENAME TO batch_deliveries; COMMIT');
        } catch (error) { this.store.db.exec('ROLLBACK'); throw error; }
    }
    private sourceRows(batch: Batch): Row[] {
        return this.store.rows(`SELECT t.*,s.nativeSessionId,m.sourceId AS canonicalSourceId,m.originSessionId,m.nativeTurnId,m.occurredAt,m.sourceOrdinal FROM traces t JOIN sessions s ON s.id=t.sessionId
LEFT JOIN codex_event_meta m ON m.traceId=t.id WHERE t.sessionId=? AND (t.batchId=? OR t.conversationId=? OR EXISTS(SELECT 1 FROM batch_traces bt WHERE bt.batchId=? AND bt.traceId=t.id))
ORDER BY COALESCE(m.occurredAt,t.createdAt),m.sourceOrdinal,t.id`, batch.sessionId, batch.id, batch.conversationId, batch.id) as Row[];
    }
    private rowsForBatch(batch: Batch): Row[] {
        const rows = this.sourceRows(batch);
        const filtered = filterUploadTraces(rows.map((row): Row => ({ ...row, message: JSON.parse(row.message), sourceId: row.canonicalSourceId ?? row.sourceId })));
        const used = this.matchMessages(filtered, batch.messages);
        const indices = new Map<number, number[]>();
        filtered.forEach((row, index) => { const id = Number(row.id); indices.set(id, [...indices.get(id) ?? [], index]); });
        // Index partial projections too; covered() combines receipts across batches.
        // Proven duplicate wrappers remain indexed without entering the body.
        return orderCursorTraces(rows.filter(row => !indices.has(Number(row.id)) || indices.get(Number(row.id))!.some(index => used.has(index))));
    }
    private matchMessages(rows: Row[], messages: Message[]): Set<number> {
        const used = new Set<number>();
        for (const message of messages.flatMap(uploadMessages)) {
            const frozen = { ...message };
            if (typeof frozen.chat_time === 'string' && Number.isFinite(Date.parse(frozen.chat_time))) frozen.chat_time = new Date(frozen.chat_time).toISOString();
            const at = rows.findIndex((row, index) => {
                if (used.has(index)) return false;
                const candidate = { ...row.message };
                // Old accepted snapshots omitted business metadata. Compare only
                // fields actually present in that request, preserving occurrence order.
                for (const key of ['id', 'chat_time', 'role_id', 'role_name']) if (!(key in frozen)) delete candidate[key];
                return JSON.stringify(candidate) === JSON.stringify(frozen);
            });
            if (at >= 0) used.add(at);
        }
        return used;
    }
    private migrateUploads(): void {
        if (Number(this.store.row('PRAGMA user_version')?.user_version) >= 4) return;
        const path = this.store.row('PRAGMA database_list')?.file;
        if (path && this.store.row("SELECT id FROM batches WHERE uploaded=0 AND status IN ('pending','blocked') LIMIT 1")) {
            const backup = `${path}.before-upload-projection-${Date.now()}.sqlite`;
            this.store.db.prepare('VACUUM INTO ?').run(backup); chmodSync(backup, 0o600);
        }
        this.store.db.exec('BEGIN');
        try {
            this.store.db.prepare("UPDATE batches SET status='blocked',error=? WHERE uploaded=0 AND attempts>0 AND status='pending'")
                .run('上传格式已更新，原请求已尝试发送；请核验结果后显式补传');
            for (const delivery of this.store.rows("SELECT * FROM batch_deliveries WHERE status='pending' AND attempts>0"))
                this.update(delivery, { status: 'blocked', error: '上传格式已更新，原请求已尝试发送；请核验结果后显式补传' });
            for (const batch of this.store.batches().filter(batch => !batch.uploaded && !batch.attempts && ['pending', 'blocked'].includes(batch.status))) {
                if (batch.conversationId && !this.store.row('SELECT id FROM turns WHERE id=? AND completedAt IS NOT NULL', batch.conversationId)) continue;
                const linked = new Set(this.store.rows('SELECT traceId FROM batch_traces WHERE batchId=?', batch.id).map(row => Number(row.traceId)));
                const rows = this.sourceRows(batch).filter(row => !linked.size || linked.has(Number(row.id)));
                const projected = filterUploadTraces(rows.map(row => ({ ...row, message: JSON.parse(row.message), sourceId: row.canonicalSourceId ?? row.sourceId })));
                const frozen = batch.messages.flatMap(uploadMessages);
                // Missing source evidence must never shrink an unsent snapshot.
                const messages = projected.length && this.matchMessages(projected, frozen).size === frozen.length
                    ? projected.map(row => row.message) : frozen;
                const payload = JSON.stringify(messages);
                const error = uploadValidationError(messages) ?? (messages.some(hasIncompleteSkill) ? 'Skill 调用身份或输出边界不完整；正文未采集'
                    : Buffer.byteLength(payload, 'utf8') > this.store.uploadMaxBytes ? '整轮轨迹超出保守上传容量；完整内容已保留' : !messages.length ? '上传轨迹缺少有效任务消息' : null);
                this.store.db.prepare('UPDATE batches SET messages=?,status=?,error=? WHERE id=?').run(payload, error ? 'blocked' : 'pending', error, batch.id);
                this.store.db.prepare("UPDATE batch_deliveries SET status=?,error=? WHERE batchId=? AND attempts=0 AND status IN ('pending','blocked')")
                    .run(error ? 'blocked' : 'pending', error, batch.id);
            }
            this.store.db.exec('PRAGMA user_version=4; COMMIT');
        } catch (error) { this.store.db.exec('ROLLBACK'); throw error; }
    }
    private indexBatch(batch: Batch) {
        if (this.store.row('SELECT 1 FROM batch_traces WHERE batchId=? LIMIT 1', batch.id)) return;
        for (const row of this.rowsForBatch(batch)) this.store.db.prepare('INSERT OR IGNORE INTO batch_traces VALUES(?,?)').run(batch.id, Number(row.id));
    }
    private covered(traceId: number, baseUrl: string, spaceId: string, includeQueued: boolean, acceptedOnly = false, projection?: Row[]) {
        const messages = this.receiptMessages(traceId, baseUrl, spaceId, includeQueued, acceptedOnly);
        let projected = projection;
        if (!projected) {
            const trace = this.store.row('SELECT sessionId,conversationId FROM traces WHERE id=?', traceId);
            if (!trace) return false;
            const rows = this.store.rows(`SELECT t.*,s.nativeSessionId,m.sourceId AS canonicalSourceId,m.originSessionId,m.nativeTurnId FROM traces t JOIN sessions s ON s.id=t.sessionId
    LEFT JOIN codex_event_meta m ON m.traceId=t.id WHERE t.sessionId=? AND t.conversationId IS ? ORDER BY t.id`, String(trace.sessionId), trace.conversationId ? String(trace.conversationId) : null);
            projected = filterUploadTraces(rows.map((row): Row => ({ ...row, message: JSON.parse(String(row.message)), sourceId: row.canonicalSourceId ?? row.sourceId })))
                .filter(row => Number(row.id) === traceId);
        }
        if (!projected.length) return true;
        return this.matchMessages(projected, messages).size === projected.length;
    }
    private projections(scopeId: string) {
        const rows = this.store.rows(`SELECT t.*,s.nativeSessionId,m.sourceId AS canonicalSourceId,m.originSessionId,m.nativeTurnId FROM traces t JOIN sessions s ON s.id=t.sessionId
LEFT JOIN codex_event_meta m ON m.traceId=t.id WHERE s.objectId=? ORDER BY t.id`, scopeId);
        const grouped = new Map<number, Row[]>();
        for (const row of filterUploadTraces(rows.map((row): Row => ({...row,message:JSON.parse(String(row.message)),sourceId:row.canonicalSourceId ?? row.sourceId})))) {
            const id = Number(row.id), group = grouped.get(id) ?? []; group.push(row); grouped.set(id, group);
        }
        return grouped;
    }
    private receiptMessages(traceId: number, baseUrl: string, spaceId: string, includeQueued: boolean, acceptedOnly = false): Message[] {
        const states = ['accepted', 'completed', 'skipped', ...acceptedOnly ? [] : ['processing-failed'], ...includeQueued ? ['pending', 'sending'] : []];
        const batches = this.store.rows(`SELECT b.messages FROM batch_traces t JOIN batch_deliveries d ON d.batchId=t.batchId JOIN batches b ON b.id=t.batchId
WHERE t.traceId=? AND d.baseUrl=? AND d.connectionId=(SELECT connectionId FROM bindings WHERE objectId=b.objectId LIMIT 1) AND d.spaceId=? AND d.status IN (${states.map(() => '?').join(',')})`, traceId, baseUrl, spaceId, ...states);
        return batches.flatMap(row => JSON.parse(String(row.messages)));
    }
    request(sessionId: string, spaceId: string, messages: Message[], userId = this.store.config?.value.userId ?? '') {
        return messageRequest(userId, this.store.session(sessionId)!, spaceId, messages);
    }
    private fits(sessionId: string, spaceId: string, messages: Message[]) {
        const body = this.request(sessionId, spaceId, messages);
        return (this.store.config ? requestBodyBytes(this.store.config.value, body) : Buffer.byteLength(JSON.stringify(body), 'utf8')) <= this.store.uploadMaxBytes;
    }
    private time(row: Row): string {
        if (row.occurredAt) return String(row.occurredAt);
        return this.store.memory.recordTime(JSON.parse(row.raw)) ?? String(row.createdAt);
    }
    queueLive() {
        for (const batch of this.store.batches('pending')) {
            const session = this.store.session(batch.sessionId);
            const scope = session && this.store.memory.forSession(session);
            if (!scope || batch.connectionId !== scope.connectionId || batch.attempts || batch.uploaded) continue;
            if (batch.conversationId && this.store.creation.turnExcluded(batch.sessionId, batch.conversationId)) continue;
            if (this.store.row("SELECT 1 FROM batch_deliveries WHERE batchId=? AND kind='history'", batch.id)) continue;
            this.indexBatch(batch);
            const rows = this.rowsForBatch(batch);
            for (const spaceId of scope.spaceIds) {
                if (!this.store.creation.liveRowsAllowed(batch.sessionId, spaceId, scope.baseUrl, rows)) continue;
                // A newly attached Space receives old content only after the user asks.
                const binding = this.store.row('SELECT boundAt FROM bindings WHERE objectId=? AND spaceId=?', scope.id, spaceId);
                const eligible = rows.filter(row => this.store.memory.allows(scope.id, this.time(row)) && this.time(row) >= String(binding?.boundAt ?? scope.enabledAt));
                const missing = eligible.filter(row => !this.covered(Number(row.id), scope.baseUrl, spaceId, true));
                if (!missing.length || this.store.row('SELECT 1 FROM batch_deliveries WHERE batchId=? AND connectionId=? AND spaceId=?', batch.id, scope.connectionId, spaceId)) continue;
                this.queue(scope.id, batch.sessionId, scope.baseUrl, spaceId, missing, 'live', missing.length === rows.length ? batch : undefined);
            }
        }
    }
    private queue(scopeId: string, sessionId: string, baseUrl: string, spaceId: string, rows: Row[], kind: string, original?: Batch) {
        const messages = filterUploadTraces(orderCursorTraces(rows.map(row => ({ ...row, message: JSON.parse(row.message), sourceId: row.canonicalSourceId ?? row.sourceId })))).map(row => row.message), payload = JSON.stringify(messages);
        if (!messages.length) return undefined;
        const oversized = !this.fits(sessionId, spaceId, messages);
        const error = uploadValidationError(messages) ?? (hasSkillFilter(this.store.session(sessionId)?.agentType ?? '') && messages.some(message => hasIncompleteSkill(message as import('../adapters/types.ts').Message)) ? 'Skill 调用身份或输出边界不完整；正文未采集' : oversized ? '整轮轨迹超出保守上传容量；完整内容已保留' : null);
        const batchId = original?.id ?? randomUUID();
        if (!original) this.store.db.prepare('INSERT INTO batches(id,sessionId,objectId,messages,status,error,createdAt) VALUES(?,?,?,?,?,?,?)')
            .run(batchId, sessionId, scopeId, payload, error ? 'blocked' : 'pending', error, new Date().toISOString());
        else this.store.db.prepare('UPDATE batches SET messages=?,status=?,error=? WHERE id=? AND attempts=0 AND uploaded=0')
            .run(payload, error ? 'blocked' : 'pending', error, batchId);
        for (const row of rows) this.store.db.prepare('INSERT OR IGNORE INTO batch_traces VALUES(?,?)').run(batchId, Number(row.id));
        this.store.db.prepare('INSERT OR IGNORE INTO batch_deliveries(batchId,baseUrl,spaceId,kind,status,error,connectionId) VALUES(?,?,?,?,?,?,?)')
            .run(batchId, baseUrl, spaceId, kind, error ? 'blocked' : 'pending', error, this.store.memory.get(scopeId)!.connectionId);
        return batchId;
    }
    *historyBatches(scopeId: string, targets: string[], catalog: HistoryRecord[]) {
        const scope = this.store.memory.get(scopeId);
        if (!scope?.spaceIds.length || !this.store.matchesConnection(scope.connectionId)) return;
        const bindings = new Map(targets.map(id => [id, this.store.row('SELECT boundAt FROM bindings WHERE objectId=? AND spaceId=? AND baseUrl=?', scopeId, id, scope.baseUrl)?.boundAt]));
        const keyFor = (nativeSessionId: string, sourceId: string) => sourceId.startsWith('codex:v2:') ? sourceId : JSON.stringify([nativeSessionId, sourceId]);
        const wanted = new Set(catalog.map(row => keyFor(row.nativeSessionId, row.sourceId)));
        const rows = this.store.rows(`SELECT t.*,s.nativeSessionId,m.sourceId AS canonicalSourceId,m.originSessionId,m.nativeTurnId,m.occurredAt,m.sourceOrdinal FROM traces t JOIN sessions s ON s.id=t.sessionId
LEFT JOIN codex_event_meta m ON m.traceId=t.id WHERE s.objectId=? ORDER BY COALESCE(m.occurredAt,t.createdAt),m.sourceOrdinal,t.id`, scopeId) as Row[];
        const groups = new Map<string, Row[]>();
        for (const row of rows) {
            if (!wanted.has(keyFor(String(row.nativeSessionId), String(row.sourceId)))) continue;
            if (row.conversationId && this.store.creation.turnExcluded(String(row.sessionId), String(row.conversationId))) continue;
            const group = groups.get(String(row.sessionId)) ?? []; group.push(row); groups.set(String(row.sessionId), group);
        }
        const ordered = [...groups.values()].sort((a, b) => this.time(a[0]!).localeCompare(this.time(b[0]!)) || String(a[0]!.sessionId).localeCompare(String(b[0]!.sessionId)));
        for (const group of ordered) {
            const sessionId = String(group[0]!.sessionId);
            // Retire only never-sent capacity failures. Their full local messages remain available.
            for (const old of this.store.rows("SELECT id FROM batches WHERE sessionId=? AND attempts=0 AND uploaded=0 AND status='blocked' AND error='整轮轨迹超出保守上传容量；完整内容已保留'", sessionId)) {
                this.store.db.prepare("UPDATE batch_deliveries SET status='cancelled',error=NULL WHERE batchId=? AND attempts=0 AND status='blocked'").run(String(old.id));
                this.store.updateBatch(String(old.id), {status:'cancelled',error:null});
            }
            const projected = filterUploadTraces(orderCursorTraces(group.map((row): Row => ({ ...row, message: JSON.parse(row.message), sourceId: row.canonicalSourceId ?? row.sourceId }))));
            for (const spaceId of targets) {
                if (this.store.memory.get(scopeId)?.connectionId !== scope.connectionId || !this.store.matchesConnection(scope.connectionId) || !this.store.memory.get(scopeId)?.spaceIds.includes(spaceId) || this.store.row('SELECT boundAt FROM bindings WHERE objectId=? AND spaceId=? AND baseUrl=?', scopeId, spaceId, scope.baseUrl)?.boundAt !== bindings.get(spaceId)) continue;
                const pending = projected.filter(row => !this.matchMessages([row], this.receiptMessages(Number(row.id), scope.baseUrl, spaceId, true)).size);
                const calls = (row: Row) => (row.message.tool_calls ?? []).map((call: Row) => String(call.id));
                const identity = (row: Row, id: string) => JSON.stringify([row.conversationId ?? '', id]);
                let limit = -1, oversized = new Set<Row>(), index = 0;
                let batch: Row[] = [];
                const boundAt = bindings.get(spaceId);
                while (index < pending.length) {
                    const binding = this.store.row('SELECT boundAt FROM bindings WHERE objectId=? AND spaceId=? AND baseUrl=?', scopeId, spaceId, scope.baseUrl);
                    if (!binding || binding.boundAt !== boundAt || this.store.memory.get(scopeId)?.connectionId !== scope.connectionId || !this.store.matchesConnection(scope.connectionId)) { batch = []; break; }
                    if (limit !== this.store.uploadMaxBytes) {
                        limit = this.store.uploadMaxBytes;
                        oversized = new Set(pending.filter(row => !this.fits(sessionId, spaceId, [row.message])));
                        const omitted = new Set<string>();
                        let changed = true;
                        while (changed) {
                            changed = false;
                            for (const row of pending) {
                                const ids = [...calls(row), ...row.message.tool_call_id ? [String(row.message.tool_call_id)] : []];
                                if (!oversized.has(row) && !ids.some(id => omitted.has(identity(row, id)))) continue;
                                if (!oversized.has(row)) { oversized.add(row); changed = true; }
                                for (const id of ids) if (!omitted.has(identity(row, id))) { omitted.add(identity(row, id)); changed = true; }
                            }
                        }
                    }
                    const row = pending[index]!;
                    if (oversized.has(row)) {
                        if (batch.length) { const id = this.queueHistoryPart(scopeId, sessionId, scope.baseUrl, spaceId, batch); batch = []; yield id; continue; }
                        const id = this.queueHistoryPart(scopeId, sessionId, scope.baseUrl, spaceId, [row], true); index++; yield id; continue;
                    }
                    if (batch.length && !this.fits(sessionId, spaceId, [...batch.map(row => row.message), row.message])) {
                        const id = this.queueHistoryPart(scopeId, sessionId, scope.baseUrl, spaceId, batch); batch = []; yield id; continue;
                    }
                    batch.push(row); index++;
                }
                if (batch.length) yield this.queueHistoryPart(scopeId, sessionId, scope.baseUrl, spaceId, batch);
            }
        }
    }
    queueHistory(scopeId: string, targets: string[], catalog: HistoryRecord[]) {
        for (const _ of this.historyBatches(scopeId, targets, catalog)) { /* Explicit callers can prepare a bounded session's batches. */ }
    }
    private queueHistoryPart(scopeId: string, sessionId: string, baseUrl: string, spaceId: string, rows: Row[], skipped = false) {
        const messages = rows.map(row => row.message);
        const error = skipped ? null : uploadValidationError(messages) ?? (messages.some(message => hasIncompleteSkill(message as Message)) ? 'Skill 调用身份或输出边界不完整；正文未采集' : null);
        const id = randomUUID(), status = skipped ? 'skipped' : error ? 'blocked' : 'pending';
        this.store.db.exec('BEGIN');
        try {
            this.store.db.prepare('INSERT INTO batches(id,sessionId,objectId,messages,status,error,createdAt) VALUES(?,?,?,?,?,?,?)').run(id,sessionId,scopeId,JSON.stringify(messages),status,error,this.time(rows[0]!));
            for (const row of rows) this.store.db.prepare('INSERT OR IGNORE INTO batch_traces VALUES(?,?)').run(id,Number(row.id));
            this.store.db.prepare('INSERT INTO batch_deliveries(batchId,baseUrl,spaceId,kind,status,error,connectionId) VALUES(?,?,?,?,?,?,?)').run(id,baseUrl,spaceId,'history',status,error,this.store.memory.get(scopeId)!.connectionId);
            this.store.db.exec('COMMIT');
        } catch (error) { this.store.db.exec('ROLLBACK'); throw error; }
        return id;
    }
    historyPending(scopeId: string, catalog: HistoryRecord[]) {
        const scope = this.store.memory.get(scopeId);
        if (!scope?.spaceIds.length) return 0;
        let count = 0;
        const projections = this.projections(scopeId);
        const unique = new Map(catalog.map(item => [item.sourceId.startsWith('codex:v2:') ? item.sourceId : JSON.stringify([item.nativeSessionId, item.sourceId]), item]));
        for (const item of unique.values()) {
            const trace = item.sourceId.startsWith('codex:v2:')
                ? this.store.row('SELECT t.id,t.sessionId,t.conversationId FROM traces t JOIN sessions s ON s.id=t.sessionId WHERE s.objectId=? AND t.sourceId=?', scopeId, item.sourceId)
                : this.store.row('SELECT t.id,t.sessionId,t.conversationId FROM traces t JOIN sessions s ON s.id=t.sessionId WHERE s.objectId=? AND s.nativeSessionId=? AND t.sourceId=?', scopeId, item.nativeSessionId, item.sourceId);
            if (trace?.conversationId && this.store.creation.turnExcluded(String(trace.sessionId), String(trace.conversationId))) continue;
            if (scope.spaceIds.some(spaceId => !trace || !this.covered(Number(trace.id), scope.baseUrl, spaceId, false, false, projections.get(Number(trace.id)) ?? []))) count++;
        }
        return count;
    }
    historyRunning(scopeId: string) {
        const scope = this.store.memory.get(scopeId);
        if (!scope?.spaceIds.length) return false;
        return this.store.rows(`SELECT d.spaceId FROM batch_deliveries d JOIN batches b ON b.id=d.batchId WHERE b.objectId=? AND d.connectionId=? AND d.kind='history' AND d.status IN ('pending','sending','accepted')`, scopeId, scope.connectionId)
            .some(row => scope.spaceIds.includes(String(row.spaceId)));
    }
    historyError(scopeId: string, sinceBatchId?: string): string | undefined {
        // Repacking an unsent batch creates newer replacement rows. Include
        // those failures, while excluding failures from an earlier upload.
        const failed = this.store.rows(`SELECT d.* FROM batch_deliveries d JOIN batches b ON b.id=d.batchId
JOIN bindings binding ON binding.objectId=b.objectId AND binding.connectionId=d.connectionId AND binding.spaceId=d.spaceId
WHERE b.objectId=? AND d.kind='history' AND d.status IN ('failed','blocked','processing-failed') AND (? IS NULL OR b.rowid >= (SELECT rowid FROM batches WHERE id=?)) ORDER BY b.createdAt DESC`, scopeId, sinceBatchId ?? null, sinceBatchId ?? null);
        const projections = failed.length ? this.projections(scopeId) : new Map<number, Row[]>();
        for (const delivery of failed) {
            const rows = this.store.rows('SELECT traceId FROM batch_traces WHERE batchId=?', String(delivery.batchId));
            if (rows.every(row => this.covered(Number(row.traceId), String(delivery.baseUrl), String(delivery.spaceId), true, true, projections.get(Number(row.traceId)) ?? []))) continue;
            return `${delivery.spaceId}：${delivery.error || (delivery.status === 'processing-failed' ? '云端处理失败' : '发送失败')}`;
        }
        return undefined;
    }
    pending() {
        return this.store.rows("SELECT d.*,b.sessionId,b.objectId,b.messages FROM batch_deliveries d JOIN batches b ON b.id=d.batchId WHERE d.status='pending' ORDER BY b.createdAt,b.rowid") as Row[];
    }
    ready(delivery: Row): Row | undefined {
        const current = this.store.row(`SELECT d.*,b.sessionId,b.objectId,b.messages FROM batch_deliveries d JOIN batches b ON b.id=d.batchId
WHERE d.batchId=? AND d.connectionId=? AND d.spaceId=? AND d.status='pending'`, delivery.batchId, delivery.connectionId, delivery.spaceId) as Row | undefined;
        if (!current || !this.store.matchesConnection(String(current.connectionId))) return undefined;
        if (Number(current.attempts) >= 2) { this.update(current, { status: 'failed' }); return undefined; }
        const row = this.store.row('SELECT * FROM batches WHERE id=?', current.batchId)!;
        const batch = { ...row, messages: JSON.parse(String(row.messages)), uploaded: !!row.uploaded } as Batch;
        if (batch.connectionId !== current.connectionId) return undefined;
        if (!this.fits(String(current.sessionId), String(current.spaceId), batch.messages)) {
            if (current.kind !== 'history' || Number(current.attempts) > 0) {
                this.update(current, {status:'blocked',error:Number(current.attempts) > 0 ? '当前配置容量小于已尝试请求；保留原快照，请恢复容量后核对' : '整轮轨迹超出保守上传容量；完整内容已保留'});
                return undefined;
            }
            this.update(current, {status:'cancelled',error:null});
            const rows = this.rowsForBatch(batch);
            this.queueHistory(String(current.objectId), [String(current.spaceId)], rows.map(row => ({nativeSessionId:String(row.nativeSessionId),sourceId:String(row.sourceId)})));
            const replacement = this.pending().find(row => row.objectId === current.objectId && row.spaceId === current.spaceId);
            return replacement ? this.ready(replacement) : undefined;
        }
        if (this.rowsForBatch(batch).some(row => row.conversationId && this.store.creation.turnExcluded(String(row.sessionId), String(row.conversationId)))) {
            this.update(current, { status: 'cancelled' }); return undefined;
        }
        if (current.kind === 'live' && !this.store.creation.liveRowsAllowed(batch.sessionId, String(current.spaceId), String(current.baseUrl), this.rowsForBatch(batch))) {
            this.update(current, { status: 'cancelled' }); return undefined;
        }
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
                if (!batchId) return undefined;
                return this.ready({ ...current, batchId });
            }
            this.store.db.prepare('DELETE FROM batch_traces WHERE batchId=?').run(batch.id);
            this.indexBatch(batch);
        }
        return current;
    }
    isPending(delivery: Row) {
        return !!this.store.row("SELECT 1 FROM batch_deliveries WHERE batchId=? AND connectionId=? AND spaceId=? AND status='pending'", delivery.batchId, delivery.connectionId, delivery.spaceId);
    }
    accepted() {
        return this.store.rows("SELECT d.*,b.objectId,b.sessionId FROM batch_deliveries d JOIN batches b ON b.id=d.batchId WHERE d.status='accepted'") as Row[];
    }
    update(delivery: Row, values: Row) {
        const fields = Object.keys(values);
        if (!fields.every(field => ['status', 'attempts', 'taskId', 'processingStatus', 'error', 'userId', 'openEpisodeMessages', 'memoryIds'].includes(field))) throw new Error('非法上传状态字段');
        this.store.db.prepare(`UPDATE batch_deliveries SET ${fields.map(field => field + '=?').join(',')} WHERE batchId=? AND connectionId=? AND spaceId=?`)
            .run(...fields.map(field => field === 'memoryIds' && Array.isArray(values[field]) ? JSON.stringify(values[field]) : values[field]), delivery.batchId, delivery.connectionId, delivery.spaceId);
        const rows = this.store.rows('SELECT * FROM batch_deliveries WHERE batchId=?', delivery.batchId) as Row[];
        const received = rows.every(row => ['accepted', 'completed', 'processing-failed'].includes(row.status));
        const status = rows.every(row => row.status === 'skipped') ? 'skipped' : rows.every(row => row.status === 'cancelled') ? 'cancelled' : rows.every(row => ['completed','skipped'].includes(row.status)) ? 'completed' : received ? rows.some(row => row.status === 'processing-failed') ? 'processing-failed' : 'accepted'
            : rows.some(row => row.status === 'pending' || row.status === 'sending') ? 'pending' : rows.some(row => row.status === 'blocked') ? 'blocked' : 'failed';
        this.store.updateBatch(delivery.batchId, { status, uploaded: received, attempts: Math.max(...rows.map(row => Number(row.attempts))),
            spaceIds: rows.map(row => String(row.spaceId)), taskId: rows.length === 1 ? rows[0]!.taskId : null,
            processingStatus: rows.length === 1 ? rows[0]!.processingStatus : null, error: rows.find(row => row.error)?.error ?? null });
    }
}
