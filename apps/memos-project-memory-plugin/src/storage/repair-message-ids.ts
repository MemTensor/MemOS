import { randomUUID } from 'node:crypto';
import { closeSync, openSync } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';
import { isDeepStrictEqual } from 'node:util';
import type { Message } from '../adapters/types.ts';
import { uploadValidationError } from '../adapters/_shared/message-content.ts';
import { filterUploadTraces, sourceMessageId } from './upload-filter.ts';

type Row = Record<string, any>;
type TraceUpdate = { id: number; before: string; after: string };
type Repair = { batchId: string; previousIds: unknown[]; messageIds: unknown[] };
type Plan = { repair: Repair; messages: Message[]; traces: TraceUpdate[]; previousError: string };
export type MessageIdRepairReport = {
    applied: boolean; backup: string | null; repairs: Repair[]; skipped: { batchId: string; reason: string }[];
};
const rejected = (error: unknown) => typeof error === 'string' && /\b409\b/.test(error)
    && /message IDs must be unique in a request|MESSAGE_ID_CONFLICT/.test(error);
const body = ({ id: _id, ...message }: Message) => message;
const blocked = '重复消息 ID 已修复；原请求被 HTTP 409 拒绝，保留发送次数与来源，请显式补传';

/** Offline maintenance only: never sends, resets attempts, or edits accepted/uncertain evidence. */
export function repairRejectedMessageIds(db: DatabaseSync, options: { apply?: boolean; batchId?: string } = {}): MessageIdRepairReport {
    if (db.isTransaction) throw new Error('消息 ID 修复需要独立事务');
    const version = db.prepare('PRAGMA data_version').get()!.data_version;
    const report: MessageIdRepairReport = { applied: false, backup: null, repairs: [], skipped: [] };
    const plans: Plan[] = [];
    const protectedTraces = new Map<number, boolean>();
    const batches = db.prepare('SELECT * FROM batches WHERE (? IS NULL OR id=?) ORDER BY createdAt,rowid').all(options.batchId ?? null, options.batchId ?? null) as Row[];
    for (const batch of batches) {
        const frozen = JSON.parse(String(batch.messages)) as Message[];
        const ids = frozen.flatMap(message => typeof message.id === 'string' ? [message.id] : []);
        if (ids.length === new Set(ids).size) continue;
        const skip = (reason: string) => report.skipped.push({ batchId: String(batch.id), reason });
        const receipts = db.prepare('SELECT * FROM batch_deliveries WHERE batchId=?').all(batch.id) as Row[];
        if (batch.status !== 'failed' || batch.uploaded || batch.taskId || !Number(batch.attempts) || !rejected(batch.error)
            || receipts.some(row => row.status !== 'failed' || row.taskId || !Number(row.attempts) || !rejected(row.error))) {
            skip('不是所有目标均明确被消息 ID 冲突 409 拒绝的失败批次'); continue;
        }
        const rows = db.prepare(`SELECT t.*,s.nativeSessionId,m.sourceId AS canonicalSourceId,m.originSessionId FROM traces t
JOIN sessions s ON s.id=t.sessionId LEFT JOIN codex_event_meta m ON m.traceId=t.id
WHERE t.sessionId=? AND (t.batchId=? OR t.conversationId=? OR EXISTS(SELECT 1 FROM batch_traces bt WHERE bt.batchId=? AND bt.traceId=t.id)) ORDER BY t.id`)
            .all(batch.sessionId, batch.id, batch.conversationId, batch.id) as Row[];
        const updates = new Map<number, TraceUpdate>();
        const candidates = filterUploadTraces(rows.map(row => {
            const source = { ...row, sourceId: row.canonicalSourceId ?? row.sourceId };
            const message = { ...JSON.parse(String(row.message)), id: sourceMessageId(source) } as Message;
            updates.set(Number(row.id), { id: Number(row.id), before: String(row.message), after: JSON.stringify(message) });
            return { ...source, id: Number(row.id), message };
        }));
        const used = new Set<number>(), selected: typeof candidates = [];
        for (const message of frozen) {
            const index = candidates.findIndex((row, index) => {
                if (used.has(index) || !isDeepStrictEqual(body(row.message), body(message))) return false;
                const originalId = (JSON.parse(updates.get(Number(row.id))!.before) as Message).id;
                return message.id === undefined || message.id === originalId || message.id === row.message.id
                    || typeof originalId === 'string' && typeof message.id === 'string' && message.id.startsWith(`${originalId}:part:`);
            });
            if (index < 0) break;
            used.add(index); selected.push(candidates[index]!);
        }
        const messages = selected.map(row => row.message);
        if (messages.length !== frozen.length || messages.some(message => typeof message.id !== 'string' || !message.id.trim()) || uploadValidationError(messages)) {
            skip('保存的来源无法完整对应原请求，或重建后校验仍失败'); continue;
        }
        const traces = [...new Set(selected.map(row => Number(row.id)))].map(id => updates.get(id)!);
        // A source can be referenced by several frozen snapshots. Do not change
        // its canonical identity if any related request may have been accepted.
        const protectedSource = traces.some(trace => {
            if (protectedTraces.has(trace.id)) return protectedTraces.get(trace.id)!;
            const related = db.prepare(`SELECT DISTINCT b.* FROM batches b JOIN traces t ON t.sessionId=b.sessionId
WHERE t.id=? AND (b.id=t.batchId OR b.conversationId=t.conversationId OR EXISTS(SELECT 1 FROM batch_traces bt WHERE bt.batchId=b.id AND bt.traceId=t.id))`).all(trace.id) as Row[];
            const protectedSource = related.some(row => row.uploaded || row.taskId
                || Number(row.attempts) > 0 && (row.status !== 'failed' || !rejected(row.error))
                || (db.prepare('SELECT * FROM batch_deliveries WHERE batchId=?').all(row.id) as Row[]).some(receipt => receipt.taskId
                    || ['accepted', 'completed', 'processing-failed', 'sending'].includes(receipt.status)
                    || Number(receipt.attempts) > 0 && (receipt.status !== 'failed' || !rejected(receipt.error))));
            protectedTraces.set(trace.id, protectedSource); return protectedSource;
        });
        if (protectedSource) { skip('来源还关联已接收或结果不确定的请求，保持原状'); continue; }
        const repair = { batchId: String(batch.id), previousIds: frozen.map(message => message.id), messageIds: messages.map(message => message.id) };
        report.repairs.push(repair); plans.push({ repair, messages, traces, previousError: String(batch.error) });
    }
    if (!options.apply || !plans.length) return report;
    const path = db.prepare('PRAGMA database_list').get()!.file;
    if (path) {
        report.backup = `${path}.before-message-ids-${Date.now()}-${randomUUID()}.sqlite`;
        closeSync(openSync(report.backup, 'wx', 0o600));
        db.prepare('VACUUM INTO ?').run(report.backup);
    }
    db.exec('BEGIN IMMEDIATE');
    try {
        if (db.prepare('PRAGMA data_version').get()!.data_version !== version) throw new Error('数据库在预览期间发生变化；未修复，请重新运行');
        const traces = new Map(plans.flatMap(plan => plan.traces.map(trace => [trace.id, trace] as const)));
        for (const trace of traces.values()) {
            const changed = db.prepare('UPDATE traces SET message=? WHERE id=? AND message=?').run(trace.after, trace.id, trace.before);
            if (!changed.changes) throw new Error('来源消息已变化；修复已回滚');
        }
        for (const plan of plans) {
            db.prepare("UPDATE batches SET messages=?,status='blocked',error=? WHERE id=?").run(JSON.stringify(plan.messages), blocked, plan.repair.batchId);
            db.prepare("UPDATE batch_deliveries SET status='blocked',error=? WHERE batchId=?").run(blocked, plan.repair.batchId);
            db.prepare('INSERT INTO diagnostics(message,createdAt) VALUES(?,?)').run(JSON.stringify({ event: 'message-id-repair', ...plan.repair,
                previousError: plan.previousError, backup: report.backup, automaticUpload: false }), new Date().toISOString());
        }
        db.exec('COMMIT'); report.applied = true;
    } catch (error) { db.exec('ROLLBACK'); throw error; }
    return report;
}
