import type { DatabaseSync } from 'node:sqlite';
import type { AgentEvent, Message } from '../adapters/types.ts';
import { stripImages } from '../adapters/_shared/image-content.ts';
import { codexRecordRaw, normalizeCodexContent } from '../adapters/codex-cli/content-normalizer.ts';

const object = (value: unknown): Record<string, any> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : {};
function parse(value: unknown): any {
    try { return JSON.parse(String(value)); } catch { return value; }
}
function cleanMessage(value: unknown, raw?: unknown): { message: Message; unresolved: boolean } {
    const message = object(value) as Message;
    if (message.role !== 'user') return { message: stripImages(message), unresolved: false };
    const envelope = object(raw), payload = object(envelope.payload ?? raw);
    const source = object(payload.item ?? (typeof object(payload.message).role === 'string' ? payload.message : payload));
    const normalized = normalizeCodexContent({ ...source, role: 'user', content: source.content ?? source.message ?? message.content });
    const clean = stripImages({ ...message, content: normalized.content });
    return { message: clean, unresolved: normalized.unresolved || clean.content === '' || Array.isArray(clean.content) && !clean.content.length };
}

/** Hook receipts schedule source reads; their task bodies are not capture evidence. */
export function sanitizeCodexReceipt(event: AgentEvent): AgentEvent {
    const clean: Record<string, unknown> = {};
    for (const key of ['agentType', 'nativeSessionId', 'cwd', 'event', 'nativeTurnId', 'turnKey', 'parentNativeSessionId']) {
        if (typeof event[key as keyof AgentEvent] === 'string') clean[key] = event[key as keyof AgentEvent];
    }
    const raw = object(event.raw), source: Record<string, unknown> = {};
    for (const key of ['transcript_path', 'transcriptPath', 'agent_transcript_path', 'agent_id', 'agentId', 'root_turn_id', 'hook_event_name']) {
        if (typeof raw[key] === 'string') source[key] = raw[key];
    }
    if (typeof object(raw.turn_attribution).root_turn_id === 'string') source.turn_attribution = { root_turn_id: raw.turn_attribution.root_turn_id };
    if (Object.keys(source).length) clean.raw = source;
    return stripImages(clean) as unknown as AgentEvent;
}

/** Idempotent, schema-tolerant boundary repair. Transport identities and counters never reset. */
export function sanitizeStoredContent(db: DatabaseSync): void {
    const has = (table: string) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table);
    if (!has('traces') || !has('batches') || !has('sessions')) return;
    const own = !db.isTransaction;
    const secureDelete = Number(db.prepare('PRAGMA secure_delete').get()?.secure_delete ?? 0);
    const beforeChanges = Number(db.prepare('SELECT total_changes() AS n').get()?.n ?? 0);
    db.exec('PRAGMA secure_delete=ON');
    try {
        if (own) db.exec('BEGIN IMMEDIATE');
        const canonical = has('codex_event_meta'), rounds = has('codex_rounds');
        const changedRounds = new Set<string>(), unresolvedRounds = new Set<string>(), replaySources = new Set<string>();
        const replacements = new Map<string, { message: Message; unresolved: boolean }>();
        const scopeKey = (row: Record<string, unknown>, encoded: string) => JSON.stringify([row.sessionId, row.conversationId, encoded]);
        const rows = db.prepare(`SELECT t.*,s.agentType${canonical ? ',m.sourceId AS canonicalSourceId' : ''} FROM traces t LEFT JOIN sessions s ON s.id=t.sessionId ${canonical ? 'LEFT JOIN codex_event_meta m ON m.traceId=t.id' : ''}`).all();
        for (const row of rows) {
            const codex = row.agentType === 'codex-cli' || row.canonicalSourceId != null;
            const oldMessage = parse(row.message), oldRaw = parse(row.raw);
            const { message, unresolved } = codex ? cleanMessage(oldMessage, oldRaw) : { message: stripImages(oldMessage), unresolved: false };
            const raw = codex ? codexRecordRaw(oldRaw, message) : stripImages(oldRaw);
            const encoded = JSON.stringify(message), encodedRaw = JSON.stringify(raw);
            if (codex) {
                const key = scopeKey(row, String(row.message)), prior = replacements.get(key);
                replacements.set(key, prior && JSON.stringify(prior.message) !== encoded
                    ? { message: { ...message, content: '' }, unresolved: true } : { message, unresolved });
            }
            if (encoded !== row.message || encodedRaw !== row.raw) db.prepare('UPDATE traces SET message=?,raw=? WHERE id=?').run(encoded, encodedRaw, Number(row.id));
            if (encoded !== row.message && row.conversationId) {
                changedRounds.add(String(row.conversationId));
                if (row.canonicalSourceId) unresolvedRounds.add(String(row.conversationId));
            }
            if (unresolved && row.conversationId) unresolvedRounds.add(String(row.conversationId));
            if (canonical && row.canonicalSourceId && encoded !== row.message && has('codex_event_sources')) {
                for (const source of db.prepare('SELECT sourcePath FROM codex_event_sources WHERE sourceId=?').all(String(row.canonicalSourceId))) replaySources.add(String(source.sourcePath));
                // Different sources may have disagreed; do not replace all their
                // fingerprints with the one canonical copy available locally.
                db.prepare('UPDATE codex_event_sources SET messageHash=NULL WHERE sourceId=?').run(String(row.canonicalSourceId));
            }
        }
        if (has('codex_sources')) for (const row of db.prepare('SELECT path,state FROM codex_sources').all()) {
            if (row.state == null && !replaySources.has(String(row.path))) continue;
            const state = parse(row.state);
            // Old parser snapshots contain duplicate raw messages and unparsed bytes.
            // Dropping them also makes the existing reader rebuild from byte zero.
            if (!replaySources.has(String(row.path)) && [2, 3].includes(state?.version) && JSON.stringify(stripImages(state)) === JSON.stringify(state)) continue;
            db.prepare('UPDATE codex_sources SET state=NULL WHERE path=?').run(String(row.path));
            if (has('codex_source_meta')) {
                const prior = db.prepare('SELECT gaps FROM codex_source_meta WHERE sourcePath=?').get(String(row.path));
                if (prior) db.prepare('UPDATE codex_source_meta SET gaps=? WHERE sourcePath=?').run(JSON.stringify([...new Set([...parse(prior.gaps), 'source_requires_replay'])]), String(row.path));
            }
            if (rounds && canonical && has('codex_event_sources')) {
                for (const trace of db.prepare('SELECT DISTINCT t.conversationId FROM traces t JOIN codex_event_meta m ON m.traceId=t.id JOIN codex_event_sources s ON s.sourceId=m.sourceId WHERE s.sourcePath=? AND t.conversationId IS NOT NULL').all(String(row.path))) unresolvedRounds.add(String(trace.conversationId));
            }
        }
        if (has('codex_receipts')) for (const row of db.prepare('SELECT id,event FROM codex_receipts').all()) {
            const event = JSON.stringify(sanitizeCodexReceipt(object(parse(row.event)) as AgentEvent));
            if (event !== row.event) db.prepare('UPDATE codex_receipts SET event=? WHERE id=?').run(event, String(row.id));
        }
        for (const row of db.prepare('SELECT b.*,s.agentType FROM batches b LEFT JOIN sessions s ON s.id=b.sessionId').all()) {
            const old = parse(row.messages);
            let unresolved = false;
            const messages = Array.isArray(old) ? old.map(value => {
                if (row.agentType !== 'codex-cli') return stripImages(value);
                const replacement = replacements.get(scopeKey(row, JSON.stringify(value)));
                if (replacement) { unresolved ||= replacement.unresolved; return replacement.message; }
                const clean = cleanMessage(value); unresolved ||= clean.unresolved; return clean.message;
            }).filter(value => !(object(value).role === 'user' && (object(value).content === '' || Array.isArray(object(value).content) && !object(value).content.length))) : stripImages(old);
            const encoded = JSON.stringify(messages);
            if (encoded !== row.messages) {
                db.prepare('UPDATE batches SET messages=? WHERE id=?').run(encoded, String(row.id));
                if (row.conversationId) changedRounds.add(String(row.conversationId));
                if (Number(row.attempts) > 0 && !row.uploaded) db.prepare("UPDATE batches SET status='blocked',error='历史内容已净化；先核验已有上传结果，禁止自动重发' WHERE id=?").run(String(row.id));
            }
            if (unresolved && row.conversationId) unresolvedRounds.add(String(row.conversationId));
            if (unresolved && !row.uploaded) db.prepare("UPDATE batches SET status='blocked',error='Codex 源内容需重新回放确认' WHERE id=?").run(String(row.id));
            if (!row.uploaded && !Number(row.attempts) && row.conversationId && unresolvedRounds.has(String(row.conversationId))) db.prepare("UPDATE batches SET status='blocked',error='Codex 源内容需重新回放确认' WHERE id=?").run(String(row.id));
        }
        if (rounds) {
            for (const id of changedRounds) db.prepare('UPDATE codex_rounds SET snapshotHash=NULL WHERE conversationId=?').run(id);
            for (const id of unresolvedRounds) {
                const row = db.prepare('SELECT gaps FROM codex_rounds WHERE conversationId=?').get(id);
                if (row) db.prepare("UPDATE codex_rounds SET captureStatus='incomplete',snapshotHash=NULL,gaps=? WHERE conversationId=?").run(JSON.stringify([...new Set([...parse(row.gaps), 'source_requires_replay'])]), id);
            }
        }
        if (own) db.exec('COMMIT');
    } catch (error) { if (own && db.isTransaction) db.exec('ROLLBACK'); throw error; }
    finally { db.exec(`PRAGMA secure_delete=${secureDelete}`); }
    // Existing readers can prevent truncation. Explicit offline repair also
    // rebuilds the database to remove bytes freed before this policy existed.
    if (own && Number(db.prepare('SELECT total_changes() AS n').get()?.n ?? 0) > beforeChanges) {
        try { db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); }
        catch (error) { if (![5, 6].includes(Number(object(error).errcode))) throw error; }
    }
}
