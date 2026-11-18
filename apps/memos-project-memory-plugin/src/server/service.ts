import { readSessionTitles } from '../adapters/session-titles.ts';
import { stripImages } from '../adapters/_shared/image-content.ts';
import { normalizeTaskTrace } from '../adapters/_shared/task-trace.ts';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { Configuration } from '../config/config.ts';
import { Store, type Session } from '../storage/store.ts';
import { CloudClient } from '../cloud/client.ts';
import { publicTopics, overviewText, identifiers } from '../recall/format.ts';
import type { AgentEvent, EventResult } from '../adapters/types.ts';
import { CodexCapture, type CodexCaptureOptions } from './codex-capture.ts';
export type SearchStatus = 'FOUND' | 'EMPTY' | 'INVALID_QUERY' | 'CONTEXT_MISSING' | 'UNAVAILABLE';
export interface SearchResult {
    ok: boolean;
    status: SearchStatus;
    data: {
        topics: ReturnType<typeof publicTopics>;
    } | null;
    error: {
        message: string;
    } | null;
}
export class PluginService {
    store: Store;
    config: Configuration;
    cloud: CloudClient;
    private syncing: Promise<void> | null = null;
    private overviewLoads = new Map<string, Promise<string>>();
    readonly codex: CodexCapture;
    constructor(dataDir: string, options: CodexCaptureOptions = {}) { this.config = new Configuration(dataDir); this.store = new Store(join(dataDir, 'memory.sqlite')); this.cloud = new CloudClient(this.config); this.codex = new CodexCapture(this.store, options); }
    close() { this.codex.close(); this.store.close(); }
    async captureCodex(forceDiscovery = false) {
        await this.codex.flush(forceDiscovery);
        await this.refreshSessionTitles();
    }
    async refreshSessionTitles() {
        for (const agentType of ['codex-cli', 'deepseek-harness']) {
            const sessions = this.store.rows('SELECT id,nativeSessionId FROM sessions WHERE agentType=?', agentType);
            if (!sessions.length) continue;
            const directory = agentType === 'codex-cli' && this.codex.roots[0] ? dirname(this.codex.roots[0]) : undefined;
            const titles = await readSessionTitles(agentType, directory);
            for (const session of sessions) {
                const title = titles.get(String(session.nativeSessionId));
                if (title) this.store.setSessionTitle(String(session.id), title.title, title.titleRevision);
            }
        }
    }
    configure(value: Parameters<Configuration['update']>[0]) { return this.config.update(value); }
    async projects(agentType: string) {
        const { discoverProjects } = await import('../adapters/projects.ts');
        const candidates = await discoverProjects(agentType);
        for (const session of this.store.rows('SELECT s.cwd,t.name FROM sessions s JOIN tasks t ON t.id=s.taskId WHERE s.agentType=? ORDER BY s.createdAt', agentType))
            candidates.push({ name: String(session.name), root: String(session.cwd) });
        for (const project of this.store.rows('SELECT p.name,p.root FROM projects p JOIN project_agents a ON a.projectId=p.id WHERE a.agentType=? ORDER BY p.createdAt', agentType))
            candidates.push({ name: String(project.name), root: String(project.root) });
        const projects = new Map<string, { name: string; root: string; id?: string; spaceIds?: string[]; bindingStatus?: string }>();
        for (const candidate of candidates) {
            const project = this.store.projectForDirectory(candidate.root);
            const root = project?.root ?? resolve(candidate.root);
            const binding = project ? this.store.binding(project.id) : undefined;
            projects.set(root, { name: project?.name ?? candidate.name, root, ...(project ? { id: project.id } : {}), ...(binding ? { spaceIds: binding.spaceIds, bindingStatus: binding.status } : {}) });
        }
        return [...projects.values()].sort((a, b) => a.root.localeCompare(b.root));
    }
    async bindProject(input: { name?: string; root?: string; spaceId?: string; agentType?: string }) {
        const root = input.root?.trim(), spaceId = input.spaceId?.trim();
        if (!root || !isAbsolute(root) || !spaceId)
            throw new Error('请选择项目并输入 Space ID');
        const baseUrl = this.config.value.baseUrl;
        const space = await this.cloud.call<{ space_name?: string }>('get/space', { space_id: spaceId });
        if (this.config.value.baseUrl !== baseUrl)
            throw new Error('云连接已变更，请重新绑定');
        return this.store.bindProject(input.name?.trim() || basename(root) || root, root, spaceId, baseUrl, input.agentType, space.space_name);
    }
    async projectSpaces(objectId: string) {
        if (!this.store.row('SELECT id FROM projects WHERE id=? UNION ALL SELECT id FROM tasks WHERE id=?', objectId, objectId))
            throw new Error('绑定对象不存在');
        const binding = this.store.binding(objectId);
        if (binding && binding.baseUrl !== this.config.value.baseUrl)
            throw new Error('空间所属云连接与当前配置不一致');
        for (const space of this.store.spaces(objectId)) {
            if (binding?.baseUrl !== this.config.value.baseUrl) throw new Error('云连接已变更，请刷新空间列表');
            if (!this.store.binding(objectId)?.spaceIds.includes(space.spaceId)) continue;
            try {
                const data = await this.cloud.call<{ space_name?: string }>('get/space', { space_id: space.spaceId });
                if (data.space_name) this.store.setSpaceName(objectId, space.spaceId, data.space_name);
            } catch (error) { this.store.diagnostic(this.error(error)); }
        }
        return this.store.spaces(objectId);
    }
    async event(event: AgentEvent): Promise<EventResult> {
        if (event.agentType === 'codex-cli') {
            const context = await this.codex.context(event);
            if (!context) return { sessionId: '', conversationId: null, context: '', overview: '', identifiers: '' };
            this.store.setSessionTitle(context.sessionId, event.title, event.titleRevision);
            const session = this.store.session(context.sessionId)!;
            const overview = await this.overview(session), ids = identifiers(context.sessionId, context.conversationId);
            return { ...context, overview, identifiers: ids, overviewDelivered: !!session.overviewDelivered, context: [overview, ids].filter(Boolean).join('\n\n') };
        }
        if (!event.agentType || !event.nativeSessionId || !event.cwd) throw new Error('缺少可靠会话身份或工作目录');
        const turnKey = event.nativeTurnId ?? event.turnKey;
        if (event.event === 'turn-start' && !turnKey?.trim()) throw new Error('需要可靠的用户轮边界');
        // Lifecycle and naming notifications do not establish a task. A submitted
        // input may reserve its context before the transcript body is flushed.
        if (!this.store.row('SELECT id FROM sessions WHERE agentType=? AND nativeSessionId=?', event.agentType, event.nativeSessionId)
            && event.event !== 'turn-start'
            && !event.records?.some(record => normalizeTaskTrace(event.agentType, record)?.message))
            return { sessionId: '', conversationId: null, context: '', overview: '', identifiers: '' };
        const session = this.store.registerSession(event);
        if (event.event === 'turn-start')
            this.store.startTurn(session.id, turnKey!);
        if (event.records?.length)
            this.store.capture(session.id, event.records.map(record => ({ ...record, nativeTurnId: record.nativeTurnId ?? turnKey })));
        if (event.event === 'turn-end' || event.event === 'session-end') {
            const keys = new Set(event.records?.map(record => record.nativeTurnId).filter((key): key is string => !!key));
            if (turnKey) keys.add(turnKey);
            if (event.event === 'session-end') for (const turn of this.store.rows('SELECT nativeKey FROM turns WHERE sessionId=? AND completedAt IS NULL', session.id)) keys.add(String(turn.nativeKey));
            for (const key of keys) this.store.finalizeTurn(session.id, key);
            if (!turnKey || event.event === 'session-end') this.store.finalizeTurn(session.id);
        }
        const current = this.store.session(session.id)!;
        const overview = await this.overview(current);
        const ids = identifiers(current.id, current.currentTurnId);
        return { sessionId: current.id, conversationId: current.currentTurnId, overview, overviewDelivered: !!current.overviewDelivered, identifiers: ids, context: [overview, ids].filter(Boolean).join('\n\n') };
    }
    async overview(session: Session): Promise<string> {
        if (session.overview !== null)
            return session.overview;
        const running = this.overviewLoads.get(session.id);
        if (running)
            return running;
        const work = (async () => {
            const binding = this.store.binding(session.objectId);
            if (!binding?.spaceIds.length) {
                this.store.setOverview(session.id, '');
                return '';
            }
            try {
                if (binding.baseUrl !== this.config.value.baseUrl)
                    throw new Error('固定空间所属云连接与当前配置不一致');
                const perSpace = new Map<string, Record<string, unknown>[]>();
                for (const spaceId of binding.spaceIds) {
                    const current = this.store.binding(session.objectId);
                    if (current?.baseUrl !== binding.baseUrl || !current.spaceIds.includes(spaceId)) continue;
                    const data = await this.cloud.call<{ topic_detail_list: Record<string, unknown>[] }>('get/memory', { space_id: spaceId, page: 1, size: 10 });
                    perSpace.set(spaceId, data.topic_detail_list);
                }
                const current = this.store.binding(session.objectId);
                const activeIds = current?.baseUrl === binding.baseUrl ? current.spaceIds : [];
                const topics = new Map<string, Record<string, unknown>>();
                for (const [spaceId, items] of perSpace) if (activeIds.includes(spaceId)) {
                    for (const [index, topic] of items.entries()) topics.set(typeof topic.id === 'string' ? topic.id : `${spaceId}:${index}`, topic);
                }
                const data = { topic_detail_list: [...topics.values()] };
                const text = overviewText(this.store.objectName(session.objectId), data);
                // An added Space will be read on the next event; never cache a stale scope.
                if (activeIds.every(spaceId => perSpace.has(spaceId))) this.store.setOverview(session.id, text);
                this.store.recall(session.id, session.currentTurnId, 'initial', null, data, text, 'prepared');
                return text;
            }
            catch (error) {
                this.store.diagnostic(this.error(error));
                const current = this.store.binding(session.objectId);
                if (current?.baseUrl === binding.baseUrl && JSON.stringify(current.spaceIds) === JSON.stringify(binding.spaceIds))
                    this.store.setOverview(session.id, '');
                this.store.recall(session.id, session.currentTurnId, 'initial', null, null, '', 'failed');
                return '';
            }
        })();
        this.overviewLoads.set(session.id, work);
        try {
            return await work;
        }
        finally {
            this.overviewLoads.delete(session.id);
        }
    }
    async bind(objectId: string, spaceId: string) {
        spaceId = spaceId.trim();
        if (!spaceId) throw new Error('Space ID不能为空');
        const existing = this.store.binding(objectId);
        if (existing?.status === 'creating' || existing?.status === 'uncertain')
            throw new Error('空间创建结果尚待确认');
        if (existing?.spaceIds.includes(spaceId))
            return this.store.bind(objectId, spaceId, this.config.value.baseUrl);
        const baseUrl = this.config.value.baseUrl;
        const space = await this.cloud.call<{ space_name?: string }>('get/space', { space_id: spaceId });
        if (baseUrl !== this.config.value.baseUrl) throw new Error('云连接已变更，请重新绑定');
        return this.store.bind(objectId, spaceId, baseUrl, space.space_name);
    }
    async search(input: {
        sessionId?: string;
        conversationId?: string;
        query?: string;
    }): Promise<SearchResult> {
        const fail = (status: SearchStatus, message: string): SearchResult => ({ ok: false, status, data: null, error: { message } });
        if (typeof input.query !== 'string' || !input.query.trim())
            return fail('INVALID_QUERY', '查询内容不能为空');
        if (!input.sessionId || !input.conversationId || !this.store.validContext(input.sessionId, input.conversationId))
            return fail('CONTEXT_MISSING', '当前会话或轮次标识无效');
        const session = this.store.session(input.sessionId)!;
        const binding = this.store.binding(session.objectId);
        try {
            if (!binding?.spaceIds.length || binding.baseUrl !== this.config.value.baseUrl)
                throw new Error('无可用空间关联或连接已变更');
            const data = await this.cloud.call<{
                topic_detail_list: Record<string, unknown>[];
            }>('search/memory', { user_id: this.config.value.userId, query: input.query, space_ids: binding.spaceIds, include_memory_view: ['project'] });
            const current = this.store.binding(session.objectId);
            if (current?.baseUrl !== binding.baseUrl || JSON.stringify(current.spaceIds) !== JSON.stringify(binding.spaceIds))
                throw new Error('检索期间空间关联已变更');
            const topics = publicTopics(data), status = topics.length ? 'FOUND' : 'EMPTY';
            const result: SearchResult = { ok: true, status, data: { topics }, error: null };
            this.store.recall(session.id, input.conversationId, 'search', input.query, data, JSON.stringify(result), 'returned');
            return result;
        }
        catch (error) {
            this.store.diagnostic(this.error(error));
            this.store.recall(session.id, input.conversationId, 'search', input.query, null, '', 'failed');
            return fail('UNAVAILABLE', '项目记忆暂不可用');
        }
    }
    sync(): Promise<void> {
        if (this.syncing)
            return this.syncing;
        this.syncing = this.runSync().finally(() => { this.syncing = null; });
        return this.syncing;
    }
    private async runSync() {
        await this.captureCodex();
        if (this.config.value.paused || !this.config.value.apiKey)
            return;
        for (const batch of this.store.batches('pending')) {
            if (this.config.value.paused)
                break;
            const session = this.store.session(batch.sessionId)!;
            let binding = this.store.binding(batch.objectId);
            if (binding && binding.baseUrl !== this.config.value.baseUrl) {
                this.store.updateBatch(batch.id, { error: '固定空间所属连接已变更' });
                continue;
            }
            if (!binding?.spaceIds.length) {
                // Registered projects may intentionally be empty; only a never-bound independent task creates a Space.
                if (binding || this.store.row('SELECT id FROM projects WHERE id=?', batch.objectId))
                    continue;
                this.store.setCreating(batch.objectId, this.config.value.baseUrl);
                try {
                    const result = await this.cloud.call<{
                        space_id: string;
                        space_name?: string;
                    }>('create/space', { space_name: this.store.objectName(batch.objectId) });
                    if (!result.space_id)
                        throw new Error('创建响应缺少Space ID');
                    binding = this.store.bind(batch.objectId, result.space_id, this.config.value.baseUrl, result.space_name);
                }
                catch (error) {
                    this.store.setCreating(batch.objectId, this.config.value.baseUrl, 'uncertain');
                    this.store.updateBatch(batch.id, { error: this.error(error) });
                    continue;
                }
            }
            while (batch.attempts < 2 && !batch.uploaded) {
                const current = this.store.binding(batch.objectId);
                if (!current || current.baseUrl !== this.config.value.baseUrl) break;
                // Capture may have filled late child events while a preceding
                // network request awaited. Claim the current payload, not the
                // stale object in the pending-list snapshot. Once attempts>0,
                // the capture layer preserves this exact body for all retries.
                this.store.db.exec('BEGIN IMMEDIATE');
                let claimed = false;
                try {
                    const fresh = this.store.batches().find(candidate => candidate.id === batch.id);
                    if (fresh?.status === 'pending' && !fresh.uploaded && fresh.attempts < 2) {
                        Object.assign(batch, fresh);
                        const spaceIds = (batch.attempts === 0 ? current.spaceIds : batch.spaceIds ?? current.spaceIds).filter(spaceId => current.spaceIds.includes(spaceId));
                        if (spaceIds.length) {
                            batch.spaceIds = spaceIds;
                            batch.attempts++;
                            this.store.updateBatch(batch.id, { spaceIds, attempts: batch.attempts });
                            claimed = true;
                        }
                    }
                    this.store.db.exec('COMMIT');
                } catch (error) { this.store.db.exec('ROLLBACK'); throw error; }
                if (!claimed) break;
                try {
                    const data = await this.cloud.call<{
                        success: boolean;
                        task_id?: string;
                        status?: string;
                    }>('add/message', { user_id: this.config.value.userId, agent_id: session.agentType, space_ids: batch.spaceIds, messages: stripImages(batch.messages), allow_memory_view: ['project'], async_mode: true });
                    if (data.success !== true || !data.task_id)
                        throw new Error('上传缺少接收确认或task_id');
                    batch.uploaded = true;
                    this.store.updateBatch(batch.id, { uploaded: true, status: 'accepted', taskId: data.task_id, processingStatus: data.status ?? 'running', error: null });
                }
                catch (error) {
                    this.store.updateBatch(batch.id, { status: batch.attempts >= 2 ? 'failed' : 'pending', error: this.error(error) });
                }
            }
            if (!batch.uploaded && batch.attempts >= 2)
                this.store.updateBatch(batch.id, { status: 'failed' });
        }
        for (const batch of this.store.batches('accepted')) {
            if (!batch.taskId || this.store.binding(batch.objectId)?.baseUrl !== this.config.value.baseUrl)
                continue;
            try {
                const data = await this.cloud.call<{
                    status: string;
                }>('get/status', { task_id: batch.taskId });
                this.store.updateBatch(batch.id, { processingStatus: data.status, status: data.status === 'completed' ? 'completed' : data.status === 'failed' ? 'processing-failed' : 'accepted' });
            }
            catch (error) {
                this.store.updateBatch(batch.id, { error: this.error(error) });
            }
        }
    }
    error(error: unknown) { const message = error instanceof Error ? error.message : String(error); return this.config.value.apiKey ? message.replaceAll(this.config.value.apiKey, '[REDACTED]') : message; }
}
