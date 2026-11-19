import { readSessionTitles } from '../adapters/session-titles.ts';
import { stripImages } from '../adapters/_shared/image-content.ts';
import { normalizeTaskTrace } from '../adapters/_shared/task-trace.ts';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { Configuration } from '../config/config.ts';
import { Store, type Session } from '../storage/store.ts';
import { CloudClient } from '../cloud/client.ts';
import { publicTopics, overviewText, identifiers } from '../recall/format.ts';
import type { AgentEvent, EventResult } from '../adapters/types.ts';
import { CodexCapture, type CodexCaptureOptions } from './codex-capture.ts';
import { HistoryService } from './history.ts';
import { Deliveries } from '../storage/deliveries.ts';
import { discoverProjects, type Project } from '../adapters/projects.ts';
import { adapterInstalled, listInstalledAgents } from '../adapters/installer.ts';
import { profiles } from '../adapters/registry.ts';
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
    readonly history: HistoryService;
    readonly deliveries: Deliveries;
    private historyUploads = new Map<string, Promise<void>>();
    private projectCache = new Map<string, Project[]>();
    private projectLoads = new Map<string, Promise<Project[]>>();
    private home?: string;
    constructor(dataDir: string, options: CodexCaptureOptions & { home?: string } = {}) {
        this.home = options.home;
        this.config = new Configuration(dataDir); this.store = new Store(join(dataDir, 'memory.sqlite')); this.cloud = new CloudClient(this.config);
        this.codex = new CodexCapture(this.store, options); this.history = new HistoryService(this.store, options); this.deliveries = new Deliveries(this.store);
    }
    close() { this.history.close(); this.codex.close(); this.store.close(); }
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
                if (!this.store.memory.forSession(this.store.session(String(session.id))!)) continue;
                const title = titles.get(String(session.nativeSessionId));
                if (title) this.store.setSessionTitle(String(session.id), title.title, title.titleRevision);
            }
        }
    }
    configure(value: Parameters<Configuration['update']>[0]) { return this.config.update(value); }
    async activation(input: { agentType: string; cwd: string; nativeSessionId?: string; parentNativeSessionId?: string }) {
        if (!input.agentType || !isAbsolute(input.cwd)) return false;
        if (input.agentType === 'codex-cli') return this.codex.activation(input);
        const known = input.nativeSessionId && this.store.row('SELECT id FROM sessions WHERE agentType=? AND nativeSessionId=?', input.agentType, input.nativeSessionId);
        if (known) return !!this.store.memory.forSession(this.store.session(String(known.id))!);
        const parent = input.parentNativeSessionId && this.store.row('SELECT id FROM sessions WHERE agentType=? AND nativeSessionId=?', input.agentType, input.parentNativeSessionId);
        return parent ? !!this.store.memory.forSession(this.store.session(String(parent.id))!) : !!this.store.memory.resolve(input.agentType, input.cwd);
    }
    state() {
        const state = this.store.state();
        const sessions = state.sessions.filter(session => this.visibleSession(String(session.id)));
        const ids = new Set(sessions.map(session => session.id));
        return { ...state, sessions, batches: state.batches.filter(batch => ids.has(batch.sessionId)), recalls: state.recalls.filter(recall => ids.has(recall.sessionId)), bindings: this.bindingState() };
    }
    bindingState() {
        return this.store.memory.all().map(scope => {
            if (scope.spaceIds.length) void this.history.refresh(scope.id).catch(() => {});
            const pending = this.deliveries.historyPending(scope.id, this.history.catalog(scope.id));
            const queued = this.deliveries.historyRunning(scope.id);
            const uploadError = this.deliveries.historyError(scope.id) || (pending || queued
                ? this.config.value.paused ? '上传已暂停，请在概览或设置中恢复上传'
                    : !this.config.value.apiKey ? '未配置 API Key，请先完成云连接配置'
                    : scope.baseUrl !== this.config.value.baseUrl ? '绑定空间的云连接与当前配置不一致' : undefined
                : undefined);
            return { ...scope, history: { ...this.history.status(scope.id), pending, uploadError,
                uploading: !uploadError && (this.historyUploads.has(scope.id) || queued) } };
        });
    }
    visibleSession(id: string) {
        const session = this.store.session(id);
        return !!session && (!!this.store.binding(session.objectId)
            || !!this.store.row('SELECT 1 FROM capture_windows WHERE scopeId=? LIMIT 1', session.objectId)
            || !!this.store.row('SELECT 1 FROM batches WHERE sessionId=? AND uploaded=1 LIMIT 1', id));
    }
    async uploadHistory(scopeId: string) {
        const running = this.historyUploads.get(scopeId);
        if (running) return running;
        const scope = this.store.memory.get(scopeId);
        if (!scope?.spaceIds.length) throw new Error('当前 Agent 与项目尚未绑定 Space');
        if (scope.baseUrl !== this.config.value.baseUrl) throw new Error('空间所属云连接与当前配置不一致');
        if (this.history.status(scopeId).status !== 'ready') throw new Error('请等待历史扫描完成');
        const targets = [...scope.spaceIds];
        const work = (async () => {
            await this.history.materialize(scopeId);
            this.deliveries.queueHistory(scopeId, targets, this.history.catalog(scopeId));
            await this.sync();
        })();
        this.historyUploads.set(scopeId, work);
        try { await work; } finally { this.historyUploads.delete(scopeId); }
    }
    installedAdapters() { return listInstalledAgents({ home: this.home }); }
    async projects(agentType: string, refresh = false) {
        const agent = profiles.find(profile => profile.agentId === agentType);
        if (!agent || !await adapterInstalled(agent, { home: this.home })) return [];
        if (refresh || !this.projectCache.has(agentType)) {
            let loading = this.projectLoads.get(agentType);
            if (!loading) {
                loading = discoverProjects(agentType, { home: this.home }).then(found => {
                    const merged = new Map((this.projectCache.get(agentType) ?? []).map(project => [project.root, project]));
                    for (const project of found) merged.set(project.root, project);
                    const projects = [...merged.values()]; this.projectCache.set(agentType, projects); return projects;
                }).finally(() => this.projectLoads.delete(agentType));
                this.projectLoads.set(agentType, loading);
            }
            await loading;
        }
        const candidates = [...this.projectCache.get(agentType)!];
        for (const session of this.store.rows('SELECT s.cwd,t.name FROM sessions s JOIN tasks t ON t.id=s.taskId WHERE s.agentType=? ORDER BY s.createdAt', agentType))
            candidates.push({ name: String(session.name), root: String(session.cwd) });
        for (const project of this.store.rows('SELECT p.name,p.root FROM projects p JOIN project_agents a ON a.projectId=p.id WHERE a.agentType=? ORDER BY p.createdAt', agentType))
            candidates.push({ name: String(project.name), root: String(project.root) });
        const projects = new Map<string, { name: string; root: string; id?: string; spaceIds?: string[]; bindingStatus?: string }>();
        const scopes = new Map(this.store.memory.all().filter(scope => scope.agentType === agentType).map(scope => [scope.projectId, scope]));
        const registered = this.store.rows('SELECT * FROM projects ORDER BY length(root) DESC,createdAt,rowid');
        for (const candidate of candidates) {
            const directory = resolve(candidate.root);
            const project = registered.find(project => directory === project.root || directory.startsWith(String(project.root).endsWith(sep) ? String(project.root) : String(project.root) + sep));
            const root = project ? String(project.root) : directory;
            const scope = project && scopes.get(String(project.id));
            const binding = scope ? this.store.binding(scope.id) : undefined;
            projects.set(root, { name: project ? String(project.name) : candidate.name, root, ...(project ? { id: String(project.id) } : {}), ...(binding ? { spaceIds: binding.spaceIds, bindingStatus: binding.status } : {}) });
        }
        return [...projects.values()].sort((a, b) => a.root.localeCompare(b.root));
    }
    async bindProject(input: { name?: string; root?: string; spaceId?: string; spaceName?: string; agentType?: string }) {
        const root = typeof input.root === 'string' ? input.root.trim() : '';
        const agentType = typeof input.agentType === 'string' ? input.agentType.trim() : '';
        const creating = Object.hasOwn(input, 'spaceName');
        const value = creating ? input.spaceName : input.spaceId;
        if (creating && Object.hasOwn(input, 'spaceId'))
            throw new Error('Space 名称与 Space ID 只能提供其一');
        if (!root || !isAbsolute(root) || !agentType || typeof value !== 'string' || !value.trim()
            || (input.name !== undefined && typeof input.name !== 'string'))
            throw new Error('请选择 Agent、项目并输入有效的 Space 名称或 ID');
        const baseUrl = this.config.value.baseUrl;
        const known = this.store.memory.all().find(scope => scope.root === resolve(root) && scope.agentType === agentType);
        const binding = known && this.store.binding(known.id);
        if (binding && binding.baseUrl !== baseUrl)
            throw new Error('绑定所属云连接不可更改');
        if (binding && ['creating', 'uncertain'].includes(binding.status))
            throw new Error('空间创建结果尚待确认');
        let spaceId: string | undefined;
        try {
            const space = creating
                ? await this.cloud.call<{ space_id?: string; space_name?: string }>('create/space', { space_name: value.trim() })
                : await this.cloud.call<{ space_id?: string; space_name?: string }>('get/space', { space_id: value.trim() });
            spaceId = creating ? (typeof space?.space_id === 'string' ? space.space_id.trim() : '') : value.trim();
            if (!spaceId) throw new Error('创建响应缺少有效的 Space ID，请核对云端结果后再创建');
            if (this.config.value.baseUrl !== baseUrl)
                throw new Error('云连接已变更，请重新绑定');
            const spaceName = typeof space?.space_name === 'string' ? space.space_name : creating ? value.trim() : '';
            const project = this.store.bindProject(input.name?.trim() || basename(root) || root, root, spaceId, baseUrl, agentType, spaceName);
            if (!known) void this.history.scan(project.scopeId).catch(() => {});
            return project;
        } catch (error) {
            if (creating && spaceId)
                throw Object.assign(new Error(`Space 已创建，但绑定失败：${this.error(error)}`), { spaceId });
            if (creating)
                throw new Error(`Space 创建失败或结果未确认，请核对后再创建：${this.error(error)}`);
            throw error;
        }
    }
    async projectSpaces(objectId: string) {
        if (!this.store.memory.get(objectId))
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
        if (!await this.activation(event)) return { sessionId: '', conversationId: null, context: '', overview: '', identifiers: '' };
        if (event.agentType === 'codex-cli') {
            const context = await this.codex.context(event);
            if (!context) return { sessionId: '', conversationId: null, context: '', overview: '', identifiers: '' };
            this.store.setSessionTitle(context.sessionId, event.title, event.titleRevision);
            const session = this.store.session(context.sessionId)!;
            const overview = await this.overview(session), ids = identifiers(context.sessionId, context.conversationId);
            if (!this.store.memory.forSession(session)) return { sessionId: '', conversationId: null, context: '', overview: '', identifiers: '' };
            return { ...context, overview, identifiers: ids, overviewDelivered: !!session.overviewDelivered, context: [overview, ids].filter(Boolean).join('\n\n') };
        }
        if (!event.agentType || !event.nativeSessionId || !event.cwd) throw new Error('缺少可靠会话身份或工作目录');
        const turnKey = event.nativeTurnId ?? event.turnKey;
        if (event.event === 'turn-start' && !turnKey?.trim()) throw new Error('需要可靠的用户轮边界');
        const known = this.store.row('SELECT id FROM sessions WHERE agentType=? AND nativeSessionId=?', event.agentType, event.nativeSessionId);
        const parent = event.parentNativeSessionId && this.store.row('SELECT id FROM sessions WHERE agentType=? AND nativeSessionId=?', event.agentType, event.parentNativeSessionId);
        const scope = known ? this.store.memory.forSession(this.store.session(String(known.id))!)
            : parent ? this.store.memory.forSession(this.store.session(String(parent.id))!) : this.store.memory.resolve(event.agentType, event.cwd);
        if (!scope) return { sessionId: '', conversationId: null, context: '', overview: '', identifiers: '' };
        const records = event.records?.filter(record => this.store.memory.allows(scope.id, this.store.memory.recordTime(record.raw)) && normalizeTaskTrace(event.agentType, record)?.message);
        // Lifecycle and naming notifications do not establish a task. A submitted
        // input may reserve its context before the transcript body is flushed.
        if (!known
            && event.event !== 'turn-start'
            && !records?.length)
            return { sessionId: '', conversationId: null, context: '', overview: '', identifiers: '' };
        const session = this.store.registerSession(event);
        if (event.event === 'turn-start')
            this.store.startTurn(session.id, turnKey!);
        if (records?.length)
            this.store.capture(session.id, records.map(record => ({ ...record, nativeTurnId: record.nativeTurnId ?? turnKey })));
        if (event.event === 'turn-end' || event.event === 'session-end') {
            const keys = new Set(records?.map(record => record.nativeTurnId).filter((key): key is string => !!key));
            if (turnKey) keys.add(turnKey);
            if (event.event === 'session-end') for (const turn of this.store.rows('SELECT nativeKey FROM turns WHERE sessionId=? AND completedAt IS NULL', session.id)) keys.add(String(turn.nativeKey));
            for (const key of keys) this.store.finalizeTurn(session.id, key);
            if (!turnKey || event.event === 'session-end') this.store.finalizeTurn(session.id);
        }
        const current = this.store.session(session.id)!;
        const overview = await this.overview(current);
        if (this.store.memory.forSession(current)?.enabledAt !== scope.enabledAt) return { sessionId: '', conversationId: null, context: '', overview: '', identifiers: '' };
        const ids = identifiers(current.id, current.currentTurnId);
        return { sessionId: current.id, conversationId: current.currentTurnId, overview, overviewDelivered: !!current.overviewDelivered, identifiers: ids, context: [overview, ids].filter(Boolean).join('\n\n') };
    }
    async overview(session: Session): Promise<string> {
        const scope = this.store.memory.forSession(session);
        if (!scope) return '';
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
                    if (this.store.memory.forSession(session)?.enabledAt !== scope.enabledAt) return '';
                    const current = this.store.binding(session.objectId);
                    if (current?.baseUrl !== binding.baseUrl || !current.spaceIds.includes(spaceId)) continue;
                    const data = await this.cloud.call<{ topic_detail_list: Record<string, unknown>[] }>('get/memory', { space_id: spaceId, page: 1, size: 10 });
                    perSpace.set(spaceId, data.topic_detail_list);
                }
                const current = this.store.binding(session.objectId);
                if (this.store.memory.forSession(session)?.enabledAt !== scope.enabledAt) return '';
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
                if (this.store.memory.forSession(session)?.enabledAt !== scope.enabledAt) return '';
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
        if (!this.store.memory.get(objectId)) throw new Error('请选择 Agent 与项目绑定关系');
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
        const result = this.store.bind(objectId, spaceId, baseUrl, space.space_name);
        if (!existing) void this.history.scan(objectId).catch(() => {});
        return result;
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
        const scope = this.store.memory.forSession(session);
        if (!scope) return fail('UNAVAILABLE', '当前 Agent 与项目未启用记忆');
        const binding = this.store.binding(session.objectId);
        try {
            if (!binding?.spaceIds.length || binding.baseUrl !== this.config.value.baseUrl)
                throw new Error('无可用空间关联或连接已变更');
            const data = await this.cloud.call<{
                topic_detail_list: Record<string, unknown>[];
            }>('search/memory', { user_id: this.config.value.userId, query: input.query, space_ids: binding.spaceIds, include_memory_view: ['project'] });
            const current = this.store.binding(session.objectId);
            if (this.store.memory.forSession(session)?.enabledAt !== scope.enabledAt) return fail('UNAVAILABLE', '当前 Agent 与项目绑定已变更');
            if (current?.baseUrl !== binding.baseUrl || JSON.stringify(current.spaceIds) !== JSON.stringify(binding.spaceIds))
                throw new Error('检索期间空间关联已变更');
            const topics = publicTopics(data), status = topics.length ? 'FOUND' : 'EMPTY';
            const result: SearchResult = { ok: true, status, data: { topics }, error: null };
            this.store.recall(session.id, input.conversationId, 'search', input.query, data, JSON.stringify(result), 'returned');
            return result;
        }
        catch (error) {
            if (this.store.memory.forSession(session)?.enabledAt !== scope.enabledAt) return fail('UNAVAILABLE', '当前 Agent 与项目未启用记忆');
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
        this.deliveries.queueLive();
        for (let delivery of this.deliveries.pending()) {
            while (true) {
                const current = this.deliveries.ready(delivery);
                if (!current) break;
                delivery = current;
                const scope = this.store.memory.get(String(delivery.objectId));
                if (this.config.value.paused || !scope?.spaceIds.includes(String(delivery.spaceId)) || scope.baseUrl !== delivery.baseUrl || scope.baseUrl !== this.config.value.baseUrl) break;
                delivery.attempts++;
                this.deliveries.update(delivery, { attempts: delivery.attempts });
                try {
                    const session = this.store.session(String(delivery.sessionId))!;
                    const data = await this.cloud.call<{ success: boolean; task_id?: string; status?: string }>('add/message', {
                        user_id: this.config.value.userId, agent_id: session.agentType, space_ids: [delivery.spaceId],
                        messages: stripImages(JSON.parse(String(delivery.messages))), allow_memory_view: ['project'], async_mode: true,
                    });
                    if (data.success !== true || !data.task_id) throw new Error('上传缺少接收确认或task_id');
                    this.deliveries.update(delivery, { status: 'accepted', taskId: data.task_id, processingStatus: data.status ?? 'running', error: null });
                    break;
                } catch (error) {
                    if (!this.deliveries.isPending(delivery)) break;
                    this.deliveries.update(delivery, { status: delivery.attempts >= 2 ? 'failed' : 'pending', error: this.error(error) });
                }
            }
        }
        for (const delivery of this.deliveries.accepted()) {
            const scope = this.store.memory.get(String(delivery.objectId));
            if (this.config.value.paused || !scope?.spaceIds.includes(String(delivery.spaceId)) || scope.baseUrl !== delivery.baseUrl || scope.baseUrl !== this.config.value.baseUrl || !delivery.taskId) continue;
            try {
                const data = await this.cloud.call<{ status: string }>('get/status', { task_id: delivery.taskId });
                this.deliveries.update(delivery, { processingStatus: data.status, status: data.status === 'completed' ? 'completed' : data.status === 'failed' ? 'processing-failed' : 'accepted' });
            } catch (error) { this.deliveries.update(delivery, { error: this.error(error) }); }
        }
    }

    error(error: unknown) { const message = error instanceof Error ? error.message : String(error); return this.config.value.apiKey ? message.replaceAll(this.config.value.apiKey, '[REDACTED]') : message; }
}
