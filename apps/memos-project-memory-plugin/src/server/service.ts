import { object } from '../adapters/_shared/transcript.ts';
import { uploadValidationError } from '../adapters/_shared/message-content.ts';
import { ClaudeCapture } from '../adapters/claude-code/capture.ts';
import { CursorCapture } from '../adapters/cursor-cli/capture.ts';
import { CopilotCapture } from '../adapters/copilot-cli/capture.ts';
import { PrimeCapture } from '../adapters/prime-agent/capture.ts';
import { readSessionTitles } from '../adapters/session-titles.ts';
import { normalizeTaskTrace } from '../adapters/_shared/task-trace.ts';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { Configuration, connectionError, connectionIdentity } from '../config/config.ts';
import { Store, type Session } from '../storage/store.ts';
import { CloudClient, type CloudContext } from '../cloud/client.ts';
import { topicContent, overviewText, identifiers } from '../recall/format.ts';
import type { AgentEvent, EventResult } from '../adapters/types.ts';
import { CodexCapture, type CodexCaptureOptions } from './codex-capture.ts';
import { HistoryService } from './history.ts';
import { Deliveries } from '../storage/deliveries.ts';
import { discoverProjects, type Project } from '../adapters/projects.ts';
import { adapterInstalled, listInstalledAgents } from '../adapters/installer.ts';
import { profiles } from '../adapters/registry.ts';
import type { CreationIdentity } from '../storage/create-contexts.ts';
export type SearchStatus = 'FOUND' | 'EMPTY' | 'INVALID_QUERY' | 'CONTEXT_MISSING' | 'UNAVAILABLE';
export interface SearchResult {
    ok: boolean;
    status: SearchStatus;
    data: { content: string } | null;
    error: {
        message: string;
    } | null;
}
export interface CreateResult {
    ok: boolean;
    status: 'CREATED' | 'INVALID_INPUT' | 'CONTEXT_MISSING' | 'UNAVAILABLE' | 'CREATE_UNCERTAIN' | 'BINDING_FAILED';
    data: { spaceId: string; spaceName: string; agentType: string; root: string; projectId: string; scopeId: string; uploadStartsNextTurn: true; overview: string | null } | null;
    error: { message: string; spaceId?: string } | null;
}
export interface BindResult {
    ok: boolean;
    status: 'BOUND' | 'ALREADY_BOUND' | 'INVALID_INPUT' | 'CONTEXT_MISSING' | 'UNAVAILABLE';
    data: { spaceId: string; spaceName: string; agentType: string; root: string; projectId: string; scopeId: string; uploadStartsNextTurn: true; overview: string | null } | null;
    error: { message: string } | null;
}
export interface SpacesResult {
    ok: boolean;
    status: 'FOUND' | 'EMPTY' | 'INVALID_INPUT' | 'CONTEXT_MISSING' | 'UNAVAILABLE';
    data: { agentType: string; root: string; spaces: { spaceId: string; name: string }[] } | null;
    error: { message: string } | null;
}
export interface UnbindResult {
    ok: boolean;
    status: 'UNBOUND' | 'NOT_BOUND' | 'INVALID_INPUT' | 'CONTEXT_MISSING' | 'UNAVAILABLE';
    data: { agentType: string; root: string; spaceId: string; name: string; spaces: { spaceId: string; name: string }[] } | null;
    error: { message: string } | null;
}
export class PluginService {
    store: Store;
    config: Configuration;
    cloud: CloudClient;
    private syncing: Promise<void> | null = null;
    private overviewLoads = new Map<string, Promise<void>>();
    private closed = false;
    readonly codex: CodexCapture;
    readonly claude: ClaudeCapture;
    readonly cursor: CursorCapture;
    readonly copilot: CopilotCapture;
    readonly prime: PrimeCapture;
    readonly history: HistoryService;
    readonly deliveries: Deliveries;
    private historyUploads = new Map<string, { steps: AsyncGenerator<string>; error?: string; batchId?: string }>();
    private projectCache = new Map<string, Project[]>();
    private projectLoads = new Map<string, Promise<Project[]>>();
    private home?: string;
    private creations = new Map<string, Promise<CreateResult>>();
    constructor(dataDir: string, options: CodexCaptureOptions & { home?: string } = {}) {
        this.home = options.home;
        this.config = new Configuration(dataDir); this.store = new Store(join(dataDir, 'memory.sqlite'), this.config); this.cloud = new CloudClient(this.config, failure => this.store.cloudDiagnostics.record(failure));
        this.claude = new ClaudeCapture(this.store);
        this.cursor = new CursorCapture(this.store, options.home);
        this.copilot = new CopilotCapture(this.store);
        this.prime = new PrimeCapture(this.store, options.home);
        this.codex = new CodexCapture(this.store, options); this.history = new HistoryService(this.store, options); this.deliveries = new Deliveries(this.store);
    }
    private cloudContext(session: Session | undefined, extra: CloudContext = {}): CloudContext {
        const scopeId = session?.objectId ?? extra.scopeId;
        const scope = scopeId ? this.store.memory.get(scopeId) : undefined;
        return { ...(session ? { sessionId: session.id, conversationId: session.currentTurnId, agentType: session.agentType } : {}),
            ...(scope ? { scopeId: scope.id, projectId: scope.projectId, projectName: scope.name, agentType: scope.agentType } : {}), ...extra };
    }
    private deliveryContext(delivery: Record<string, unknown>): CloudContext {
        const batch = this.store.row('SELECT conversationId FROM batches WHERE id=?', String(delivery.batchId));
        const turns = batch?.conversationId ? [batch.conversationId] : this.store.rows('SELECT DISTINCT t.conversationId FROM batch_traces bt JOIN traces t ON t.id=bt.traceId WHERE bt.batchId=? AND t.conversationId IS NOT NULL', String(delivery.batchId)).map(row => row.conversationId);
        return this.cloudContext(this.store.session(String(delivery.sessionId)), { conversationId: turns.length === 1 ? String(turns[0]) : null,
            batchId: String(delivery.batchId), spaceId: String(delivery.spaceId), ...(delivery.taskId ? { taskId: String(delivery.taskId) } : {}) });
    }
    close() { this.closed = true; this.history.close(); this.claude.close(); this.cursor.close(); this.copilot.close(); this.prime.close(); this.codex.close(); this.store.close(); }
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
    configure(value: Parameters<Configuration['update']>[0]) {
        const previous = connectionIdentity(this.config.value);
        const result = this.config.update(value);
        if (connectionIdentity(this.config.value) !== previous) {
            const time = new Date().toISOString();
            for (const scope of this.store.memory.all()) {
                this.store.memory.deactivate(scope.id, time);
                if (scope.spaceIds.length && scope.connectionId === connectionIdentity(this.config.value)) this.store.memory.activate(scope.id, time);
            }
            this.store.db.exec('UPDATE sessions SET overview=NULL,overviewDelivered=0');
        }
        return result;
    }
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
            const job = this.historyUploads.get(scope.id);
            const busy = !!job && !job.error || queued;
            const unavailable = pending || busy
                ? this.config.value.paused ? '上传已暂停，请在概览或设置中恢复上传'
                    : connectionError(this.config.value) ? connectionError(this.config.value)
                    : scope.connectionId !== connectionIdentity(this.config.value) ? '绑定空间的云连接与当前配置不一致' : undefined
                : undefined;
            const uploading = !unavailable && busy;
            const uploadError = unavailable || job?.error || (!uploading ? this.deliveries.historyError(scope.id) : undefined);
            const scan = this.history.status(scope.id);
            return { ...scope, active: !!scope.enabledAt && scope.spaceIds.length > 0 && scope.connectionId === connectionIdentity(this.config.value), history: { ...scan, pending, uploadError, historyUploadConfirmCount: this.config.value.historyUploadConfirmCount,
                uploading, canUpload: !!scope.spaceIds.length && scan.status === 'ready' && pending > 0 && !busy && !unavailable } };
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
        if (running && !running.error) return this.sync();
        const scope = this.store.memory.get(scopeId);
        if (!scope?.spaceIds.length) throw new Error('当前 Agent 与项目尚未绑定 Space');
        if (scope.connectionId !== connectionIdentity(this.config.value)) throw new Error('空间所属云连接与当前配置不一致');
        if (this.history.status(scopeId).status !== 'ready') throw new Error('请等待历史扫描完成');
        const targets = new Map(scope.spaceIds.map(id => [id, this.store.row('SELECT boundAt FROM bindings WHERE objectId=? AND spaceId=? AND baseUrl=?', scopeId, id, scope.baseUrl)?.boundAt]));
        const steps = this.historyUploadSteps(scopeId, targets);
        const job: {steps: AsyncGenerator<string>; error?: string; batchId?: string} = {steps};
        this.historyUploads.set(scopeId, job);
        await this.sync();
        if (job.error) throw new Error(job.error);
    }
    private async *historyUploadSteps(scopeId: string, targets: Map<string, unknown>) {
        const baseUrl = this.store.memory.get(scopeId)!.baseUrl;
        const sessions = this.history.materializeSessions(scopeId);
        try {
            while (true) {
                const current = [...targets].filter(([id, boundAt]) => typeof boundAt === 'string' && this.store.row('SELECT boundAt FROM bindings WHERE objectId=? AND spaceId=? AND baseUrl=?', scopeId, id, baseUrl)?.boundAt === boundAt).map(([id]) => id);
                if (!current.length) return;
                const next = await sessions.next();
                if (next.done) return;
                yield* this.deliveries.historyBatches(scopeId, current, next.value);
            }
        } finally { await sessions.return(undefined); }
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
            const project = registered.find(project => directory === project.root || agentType !== 'prime-agent' && directory.startsWith(String(project.root).endsWith(sep) ? String(project.root) : String(project.root) + sep));
            const root = project ? String(project.root) : directory;
            const scope = project && scopes.get(String(project.id));
            const binding = scope ? this.store.binding(scope.id) : undefined;
            projects.set(root, { name: project ? String(project.name) : candidate.name, root, ...(project ? { id: String(project.id) } : {}), ...(binding ? { spaceIds: binding.spaceIds, bindingStatus: binding.status } : {}) });
        }
        return [...projects.values()].sort((a, b) => a.root.localeCompare(b.root));
    }
    async bindProject(input: { name?: string; root?: string; spaceId?: string; spaceName?: string; agentType?: string; domain?: string }, options: { nextTurnOnly?: boolean } = {}) {
        const root = typeof input.root === 'string' ? input.root.trim() : '';
        const agentType = typeof input.agentType === 'string' ? input.agentType.trim() : '';
        const creating = Object.hasOwn(input, 'spaceName');
        const value = creating ? input.spaceName : input.spaceId;
        if (creating && Object.hasOwn(input, 'spaceId'))
            throw new Error('Space 名称与 Space ID 只能提供其一');
        if (!root || !isAbsolute(root) || !agentType || typeof value !== 'string' || !value.trim()
            || (input.name !== undefined && typeof input.name !== 'string'))
            throw new Error('请选择 Agent、项目并输入有效的 Space 名称或 ID');
        const domain = typeof input.domain === 'string' ? input.domain.trim() : '';
        if (creating && (!domain || Array.from(domain).length > 24))
            throw new Error('请选择 Domain；自定义领域名称须为 1–24 个字符');
        const baseUrl = this.config.value.baseUrl, connectionId = connectionIdentity(this.config.value), revision = this.config.revision;
        const known = this.store.memory.all().find(scope => scope.root === resolve(root) && scope.agentType === agentType);
        const binding = known && this.store.binding(known.id);
        if (binding && binding.connectionId !== connectionId && (binding.spaceIds.length || ['creating', 'uncertain'].includes(binding.status)))
            throw new Error('绑定所属云连接不可更改');
        if (binding && ['creating', 'uncertain'].includes(binding.status))
            throw new Error('空间创建结果尚待确认');
        if (binding && binding.spaceIds.length >= 20 && (creating || !binding.spaceIds.includes(value.trim())))
            throw new Error('单个项目绑定空间不能超过20个');
        let spaceId: string | undefined;
        const context = this.cloudContext(undefined, { agentType, projectName: input.name?.trim() || basename(root), ...(known ? { scopeId: known.id, projectId: known.projectId } : {}) });
        try {
            const space = creating
                ? await this.cloud.call<{ space_id?: string; space_name?: string }>('create/space', { space_name: value.trim(), domains: [{ domain }] }, context)
                : await this.cloud.call<{ space_id?: string; space_name?: string }>('get/space', { space_id: value.trim() }, { ...context, spaceId: value.trim() });
            spaceId = creating ? (typeof space?.space_id === 'string' ? space.space_id.trim() : '') : value.trim();
            if (!spaceId) throw new Error('创建响应缺少有效的 Space ID，请核对云端结果后再创建');
            if (this.config.revision !== revision)
                throw new Error('云连接已变更，请重新绑定');
            if (creating) this.store.setSpaceDomains(baseUrl, spaceId, [domain], connectionId);
            else if (!this.store.spaceDomains(baseUrl, spaceId, connectionId)?.length)
                await this.loadSpaceDomains(spaceId, { ...context, spaceId });
            if (this.config.revision !== revision)
                throw new Error('云连接已变更，请重新绑定');
            const spaceName = typeof space?.space_name === 'string' ? space.space_name : creating ? value.trim() : '';
            const project = this.store.bindProject(input.name?.trim() || basename(root) || root, root, spaceId, baseUrl, agentType, spaceName, options.nextTurnOnly);
            if (!known) void this.history.scan(project.scopeId).catch(() => {});
            await this.refreshOverview(project.scopeId, spaceId);
            return { ...project, spaceId, spaceName, overview: this.cachedOverview(project.scopeId) };
        } catch (error) {
            if (creating && spaceId)
                throw Object.assign(new Error(`Space 已创建，但绑定失败：${this.error(error)}`), { spaceId });
            if (creating)
                throw new Error(`Space 创建失败或结果未确认，请核对后再创建：${this.error(error)}`);
            throw error;
        }
    }
    async createContext(input: CreationIdentity) {
        if (input.agentType === 'codex-cli') {
            const cwd = typeof input.nativeSessionId === 'string' && await this.codex.sessionDirectory(input.nativeSessionId);
            if (!cwd) return { createContext: '', createIdentifiers: '' };
            input = { ...input, cwd };
        }
        return this.store.creation.observe(input);
    }
    async create(input: { context?: unknown; name?: unknown; domain?: unknown }): Promise<CreateResult> {
        const fail = (status: CreateResult['status'], message: string, spaceId?: string): CreateResult => ({ ok: false, status, data: null, error: { message, ...(spaceId ? { spaceId } : {}) } });
        if (typeof input.name !== 'string' || !input.name.trim() || typeof input.domain !== 'string' || !input.domain.trim()
            || Array.from(input.domain.trim()).length > 24 || Object.keys(input).some(key => !['context', 'name', 'domain'].includes(key)))
            return fail('INVALID_INPUT', '请由用户明确 Space 名称和领域（领域为 1–24 个字符）；项目由当前会话确定');
        const context = typeof input.context === 'string' && this.store.creation.get(input.context);
        if (!context) return fail('CONTEXT_MISSING', '缺少有效的当前会话创建上下文');
        const request = JSON.stringify({ name: input.name.trim(), domain: input.domain.trim() });
        if (context.request && context.request !== request) return fail('CONTEXT_MISSING', '当前轮已提交过创建请求，请勿重复创建');
        if (context.result) {
            const result = JSON.parse(context.result) as CreateResult;
            if (!result.data) return result;
            const scope = this.store.memory.get(result.data.scopeId);
            const bound = scope?.connectionId === connectionIdentity(this.config.value) && scope.spaceIds.includes(result.data.spaceId);
            return { ...result, data: { ...result.data, overview: bound ? this.cachedOverview(result.data.scopeId) : null } };
        }
        const running = this.creations.get(context.token);
        if (running) return running;
        if (context.state !== 'ready') return fail('CREATE_UNCERTAIN', '本轮创建请求结果未确认，请核对云端结果；不会自动重试');
        if (connectionError(this.config.value)) return fail('UNAVAILABLE', connectionError(this.config.value)!);
        this.store.db.prepare("UPDATE create_contexts SET state='creating',request=? WHERE token=? AND state='ready'").run(request, context.token);
        const work = (async (): Promise<CreateResult> => {
            let result: CreateResult;
            try {
                const known = this.store.row('SELECT p.root,p.name FROM sessions s JOIN tasks t ON t.id=s.taskId JOIN projects p ON p.id=t.projectId WHERE s.agentType=? AND s.nativeSessionId=?', context.agentType, context.nativeSessionId);
                const root = String(known?.root ?? context.cwd);
                const project = await this.bindProject({ root, name: String(known?.name ?? basename(root)), agentType: context.agentType, spaceName: input.name as string, domain: input.domain as string }, { nextTurnOnly: true });
                result = { ok: true, status: 'CREATED', data: { spaceId: project.spaceId, spaceName: project.spaceName, root: project.root,
                    agentType: context.agentType, projectId: project.id, scopeId: project.scopeId, uploadStartsNextTurn: true, overview: project.overview }, error: null };
                if (project.overview !== null) this.store.markHostContextDelivered(context.agentType, context.nativeSessionId);
            } catch (error) {
                const spaceId = error instanceof Error && 'spaceId' in error && typeof error.spaceId === 'string' ? error.spaceId : undefined;
                result = fail(spaceId ? 'BINDING_FAILED' : 'CREATE_UNCERTAIN', this.error(error), spaceId);
            }
            // Replays read the overview from the current bindings.
            const receipt = result.data ? { ...result, data: { ...result.data, overview: null } } : result;
            this.store.db.prepare('UPDATE create_contexts SET state=?,result=? WHERE token=?').run(result.status, JSON.stringify(receipt), context.token);
            return result;
        })();
        this.creations.set(context.token, work);
        try { return await work; } finally { this.creations.delete(context.token); }
    }
    bindContext(input: { agentType?: unknown; nativeSessionId?: unknown }) {
        if (typeof input.agentType !== 'string' || !input.agentType.trim()
            || typeof input.nativeSessionId !== 'string' || !input.nativeSessionId.trim()
            || Object.keys(input).some(key => !['agentType', 'nativeSessionId'].includes(key))) return { context: '' };
        const current = this.store.row('SELECT token FROM create_contexts WHERE agentType=? AND nativeSessionId=? AND current=1', input.agentType, input.nativeSessionId);
        return { context: current ? String(current.token) : '' };
    }
    async bindDialog(input: { context?: unknown; spaceId?: unknown }): Promise<BindResult> {
        const fail = (status: BindResult['status'], message: string): BindResult => ({ ok: false, status, data: null, error: { message } });
        if (typeof input.spaceId !== 'string' || !input.spaceId.trim()
            || Object.keys(input).some(key => !['context', 'spaceId'].includes(key)))
            return fail('INVALID_INPUT', '请提供 Space ID；项目和 Agent 由当前会话确定');
        const context = typeof input.context === 'string' && this.store.creation.get(input.context);
        if (!context) return fail('CONTEXT_MISSING', '缺少有效的当前会话绑定身份');
        const spaceId = input.spaceId.trim();
        const known = this.store.row('SELECT p.root,p.name FROM sessions s JOIN tasks t ON t.id=s.taskId JOIN projects p ON p.id=t.projectId WHERE s.agentType=? AND s.nativeSessionId=?', context.agentType, context.nativeSessionId);
        const root = String(known?.root ?? context.cwd);
        const scope = this.store.memory.all().find(item => item.root === resolve(root) && item.agentType === context.agentType);
        const binding = scope && this.store.binding(scope.id);
        if (binding && binding.connectionId !== connectionIdentity(this.config.value) && (binding.spaceIds.length || ['creating', 'uncertain'].includes(binding.status)))
            return fail('UNAVAILABLE', '绑定所属云连接不可更改');
        if (scope && binding?.spaceIds.includes(spaceId)) {
            const space = this.store.spaces(scope.id).find(item => item.spaceId === spaceId);
            const overview = this.cachedOverview(scope.id);
            if (overview !== null) this.store.markHostContextDelivered(context.agentType, context.nativeSessionId);
            return { ok: true, status: 'ALREADY_BOUND', data: { spaceId, spaceName: space?.name ?? '', root,
                agentType: context.agentType, projectId: scope.projectId, scopeId: scope.id, uploadStartsNextTurn: true, overview }, error: null };
        }
        try {
            const project = await this.bindProject({ root, name: String(known?.name ?? basename(root)), agentType: context.agentType, spaceId }, { nextTurnOnly: true });
            if (project.overview !== null) this.store.markHostContextDelivered(context.agentType, context.nativeSessionId);
            return { ok: true, status: 'BOUND', data: { spaceId: project.spaceId, spaceName: project.spaceName, root: project.root,
                agentType: context.agentType, projectId: project.id, scopeId: project.scopeId, uploadStartsNextTurn: true, overview: project.overview }, error: null };
        } catch (error) {
            return fail('UNAVAILABLE', this.error(error));
        }
    }
    projectSpacesDialog(input: { context?: unknown }): SpacesResult {
        const fail = (status: SpacesResult['status'], message: string): SpacesResult => ({ ok: false, status, data: null, error: { message } });
        if (Object.keys(input).some(key => key !== 'context'))
            return fail('INVALID_INPUT', '查询无需参数；项目和 Agent 由当前会话确定');
        const context = typeof input.context === 'string' && this.store.creation.get(input.context);
        if (!context) return fail('CONTEXT_MISSING', '缺少有效的当前会话身份');
        const known = this.store.row('SELECT p.root FROM sessions s JOIN tasks t ON t.id=s.taskId JOIN projects p ON p.id=t.projectId WHERE s.agentType=? AND s.nativeSessionId=?', context.agentType, context.nativeSessionId);
        const root = String(known?.root ?? this.store.projectForDirectory(context.cwd)?.root ?? context.cwd);
        const scope = this.store.memory.resolve(context.agentType, root, false);
        const spaces = scope ? this.store.spaces(scope.id) : [];
        return { ok: true, status: spaces.length ? 'FOUND' : 'EMPTY',
            data: { agentType: context.agentType, root: scope?.root ?? root, spaces }, error: null };
    }
    unbindDialog(input: { context?: unknown; spaceId?: unknown }): UnbindResult {
        const fail = (status: UnbindResult['status'], message: string): UnbindResult => ({ ok: false, status, data: null, error: { message } });
        if (typeof input.spaceId !== 'string' || !input.spaceId.trim()
            || Object.keys(input).some(key => !['context', 'spaceId'].includes(key)))
            return fail('INVALID_INPUT', '请提供 Space ID；项目和 Agent 由当前会话确定');
        try {
            const current = this.projectSpacesDialog({ context: input.context });
            if (!current.ok || !current.data)
                return fail(current.status === 'CONTEXT_MISSING' ? 'CONTEXT_MISSING' : 'UNAVAILABLE', current.error?.message ?? '当前项目绑定信息暂不可用');
            const { agentType, root, spaces } = current.data;
            const spaceId = input.spaceId.trim();
            const target = spaces.find(space => space.spaceId === spaceId);
            const scope = target && this.store.memory.resolve(agentType, root, false);
            if (!target || !scope)
                return { ok: true, status: 'NOT_BOUND', data: { agentType, root, spaceId, name: '', spaces }, error: null };
            this.store.unbind(scope.id, spaceId);
            return { ok: true, status: 'UNBOUND', data: { agentType, root, spaceId, name: target.name, spaces: this.store.spaces(scope.id) }, error: null };
        } catch (error) {
            return fail('UNAVAILABLE', this.error(error));
        }
    }
    async projectSpaces(objectId: string) {
        const revision = this.config.revision;
        if (!this.store.memory.get(objectId))
            throw new Error('绑定对象不存在');
        const binding = this.store.binding(objectId);
        if (binding && binding.connectionId !== connectionIdentity(this.config.value))
            throw new Error('空间所属云连接与当前配置不一致');
        for (const space of this.store.spaces(objectId)) {
            if (binding?.connectionId !== connectionIdentity(this.config.value)) throw new Error('云连接已变更，请刷新空间列表');
            if (!this.store.binding(objectId)?.spaceIds.includes(space.spaceId)) continue;
            try {
                const data = await this.cloud.call<{ space_name?: string }>('get/space', { space_id: space.spaceId }, this.cloudContext(undefined, { scopeId: objectId, spaceId: space.spaceId }));
                if (this.config.revision !== revision || this.store.binding(objectId)?.connectionId !== binding?.connectionId
                    || !this.store.binding(objectId)?.spaceIds.includes(space.spaceId)) throw new Error('云连接或空间关联已变更，请刷新空间列表');
                if (data.space_name) this.store.setSpaceName(objectId, space.spaceId, data.space_name);
            } catch (error) { this.store.diagnostic(this.error(error)); }
        }
        if (this.config.revision !== revision) throw new Error('云连接已变更，请刷新空间列表');
        return this.store.spaces(objectId);
    }
    async event(event: AgentEvent): Promise<EventResult> {
        if (this.closed) return { sessionId: '', conversationId: null, context: '', overview: '', identifiers: '' };
        if (!await this.activation(event)) return { sessionId: '', conversationId: null, context: '', overview: '', identifiers: '' };
        if (event.event === 'session-start') return this.sessionStarted(event);
        if (event.agentType === 'copilot-cli' && ['agentStop', 'sessionEnd'].includes(String(object(event.raw).hook_event_name))) this.copilot.enqueue(event);
        if (event.agentType === 'prime-agent' && object(event.raw).primeNative === true || event.agentType === 'cursor-cli' || event.agentType === 'codex-cli' || event.agentType === 'claude-code' && object(event.raw).hook_event_name) {
            const context = await (event.agentType === 'prime-agent' ? this.prime : event.agentType === 'cursor-cli' ? this.cursor : event.agentType === 'claude-code' ? this.claude : this.codex).context(event);
            if (!context) return { sessionId: '', conversationId: null, context: '', overview: '', identifiers: '' };
            this.store.setSessionTitle(context.sessionId, event.title, event.titleRevision);
            const session = this.store.session(context.sessionId)!;
            const overview = await this.overview(session), ids = identifiers(context.sessionId, context.conversationId);
            if (!this.store.memory.forSession(session)) return { sessionId: '', conversationId: null, context: '', overview: '', identifiers: '' };
            return { ...context, overview, identifiers: ids, overviewDelivered: !!session.overviewDelivered || this.store.hostContextDelivered(session.agentType, session.nativeSessionId), context: [overview, ids].filter(Boolean).join('\n\n') };
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
            for (const key of keys) this.store.finalizeTurn(session.id, key, key === turnKey ? this.store.memory.recordTime(event.raw) : undefined);
            if (!turnKey || event.event === 'session-end') this.store.finalizeTurn(session.id, undefined, this.store.memory.recordTime(event.raw));
        }
        const current = this.store.session(session.id)!;
        const overview = await this.overview(current);
        if (this.store.memory.forSession(current)?.enabledAt !== scope.enabledAt) return { sessionId: '', conversationId: null, context: '', overview: '', identifiers: '' };
        const ids = identifiers(current.id, current.currentTurnId);
        return { sessionId: current.id, conversationId: current.currentTurnId, overview, overviewDelivered: !!current.overviewDelivered || this.store.hostContextDelivered(current.agentType, current.nativeSessionId), identifiers: ids, context: [overview, ids].filter(Boolean).join('\n\n') };
    }
    overview(session: Session): string {
        return this.store.memory.forSession(session) ? this.cachedOverview(session.objectId) ?? '' : '';
    }
    private cachedOverview(scopeId: string): string | null {
        if (this.closed) return null;
        const content = this.store.projectOverviewContent(scopeId);
        return content === null ? null : overviewText(content);
    }
    private async refreshOverview(scopeId: string, spaceId: string): Promise<void> {
        if (this.closed) return;
        const scope = this.store.memory.get(scopeId);
        if (!scope || !this.store.matchesConnection(scope.connectionId)) return;
        const binding = this.store.row('SELECT boundAt FROM bindings WHERE objectId=? AND connectionId=? AND spaceId=?', scopeId, scope.connectionId, spaceId);
        if (!binding) return;
        this.store.ensureProjectOverview(scopeId, spaceId);
        const key = JSON.stringify([scopeId, scope.connectionId, spaceId, binding.boundAt]);
        const running = this.overviewLoads.get(key);
        if (running) return running;
        const revision = this.config.revision;
        const work = (async () => {
            try {
                const data = await this.cloud.call<{ topic_detail_list: Record<string, unknown>[] }>('get/memory', { space_id: spaceId, page: 1, size: 10 }, this.cloudContext(undefined, { scopeId, spaceId }));
                if (this.closed || this.config.revision !== revision) return;
                if (!Array.isArray(data.topic_detail_list)) throw new Error('云端概览缺少主题列表');
                this.store.saveProjectOverview(scopeId, scope.connectionId, spaceId, String(binding.boundAt), topicContent(data.topic_detail_list));
            } catch (error) {
                if (!this.closed) this.store.diagnostic(this.error(error));
            }
        })();
        this.overviewLoads.set(key, work);
        try { await work; }
        finally { if (this.overviewLoads.get(key) === work) this.overviewLoads.delete(key); }
    }
    private async sessionStarted(event: AgentEvent): Promise<EventResult> {
        const empty: EventResult = { sessionId: '', conversationId: null, context: '', overview: '', identifiers: '' };
        const known = this.store.row('SELECT id,cwd,objectId,overviewDelivered FROM sessions WHERE agentType=? AND nativeSessionId=?', event.agentType, event.nativeSessionId);
        const parent = event.parentNativeSessionId && this.store.row('SELECT objectId FROM sessions WHERE agentType=? AND nativeSessionId=?', event.agentType, event.parentNativeSessionId);
        const cwd = known ? String(known.cwd) : event.agentType === 'codex-cli' ? await this.codex.sessionDirectory(event.nativeSessionId) : event.cwd;
        const scope = known ? this.store.memory.forSession(this.store.session(String(known.id))!)
            : parent ? this.store.memory.get(String(parent.objectId)) : cwd ? this.store.memory.resolve(event.agentType, cwd) : undefined;
        if (!scope?.spaceIds.length || !this.store.matchesConnection(scope.connectionId)) return empty;
        const profile = profiles.find(item => item.agentId === event.agentType);
        if (profile && cwd) this.store.creation.observe({ agentType: event.agentType, nativeSessionId: event.nativeSessionId, cwd, event: 'session-start', parentNativeSessionId: event.parentNativeSessionId });
        this.store.db.prepare('UPDATE create_hosts SET overviewDelivered=0 WHERE agentType=? AND nativeSessionId=?').run(event.agentType, event.nativeSessionId);
        this.store.db.prepare('UPDATE sessions SET overviewDelivered=0 WHERE agentType=? AND nativeSessionId=?').run(event.agentType, event.nativeSessionId);
        const previous = this.cachedOverview(scope.id) ?? '';
        const refresh = Promise.all(scope.spaceIds.filter(spaceId => {
            this.store.ensureProjectOverview(scope.id, spaceId);
            const fetchedAt = this.store.projectOverview(scope.id, spaceId)?.fetchedAt;
            return !fetchedAt || !Number.isFinite(Date.parse(fetchedAt)) || Date.now() - Date.parse(fetchedAt) > 6 * 60 * 60 * 1000;
        }).map(spaceId => this.refreshOverview(scope.id, spaceId)));
        let overview = previous;
        if (profile?.sessionStartBlocking) { await refresh; overview = this.cachedOverview(scope.id) ?? ''; }
        else void refresh.catch(error => { if (!this.closed) this.store.diagnostic(this.error(error)); });
        if (this.closed || !this.store.matchesConnection(scope.connectionId) || this.store.memory.get(scope.id)?.enabledAt !== scope.enabledAt) return empty;
        return { ...empty, sessionId: known ? String(known.id) : '', overview, context: overview, overviewDelivered: false };
    }
    private async loadSpaceDomains(spaceId: string, context: CloudContext): Promise<string[]> {
        const baseUrl = this.config.value.baseUrl, connectionId = connectionIdentity(this.config.value), revision = this.config.revision;
        const data = await this.cloud.call<{ domains: { domain: string }[] }>('list/domains', { space_id: spaceId }, context);
        if (this.config.revision !== revision) throw new Error('云连接已变更，请重新绑定');
        const domains = [...new Set(data.domains.map(item => item.domain.trim()))];
        this.store.setSpaceDomains(baseUrl, spaceId, domains, connectionId);
        if (!domains.length) throw new Error('该 Space 尚未配置领域，请在云端登记领域后重新绑定');
        return domains;
    }
    async bind(objectId: string, spaceId: string) {
        if (!this.store.memory.get(objectId)) throw new Error('请选择 Agent 与项目绑定关系');
        spaceId = spaceId.trim();
        if (!spaceId) throw new Error('Space ID不能为空');
        const existing = this.store.binding(objectId);
        if (existing && existing.connectionId !== connectionIdentity(this.config.value) && (existing.spaceIds.length || ['creating', 'uncertain'].includes(existing.status)))
            throw new Error('绑定所属云连接不可更改');
        if (existing?.status === 'creating' || existing?.status === 'uncertain')
            throw new Error('空间创建结果尚待确认');
        if (existing && existing.spaceIds.length >= 20 && !existing.spaceIds.includes(spaceId))
            throw new Error('单个项目绑定空间不能超过20个');
        const baseUrl = this.config.value.baseUrl, connectionId = connectionIdentity(this.config.value), revision = this.config.revision;
        const context = this.cloudContext(undefined, { scopeId: objectId, spaceId });
        const space = existing?.spaceIds.includes(spaceId) ? undefined
            : await this.cloud.call<{ space_name?: string }>('get/space', { space_id: spaceId }, context);
        if (this.config.revision !== revision) throw new Error('云连接已变更，请重新绑定');
        if (!this.store.spaceDomains(baseUrl, spaceId, connectionId)?.length) await this.loadSpaceDomains(spaceId, context);
        if (this.config.revision !== revision) throw new Error('云连接已变更，请重新绑定');
        const result = this.store.bind(objectId, spaceId, baseUrl, space?.space_name);
        if (!existing) void this.history.scan(objectId).catch(() => {});
        await this.refreshOverview(objectId, spaceId);
        return { ...result, overview: this.cachedOverview(objectId) };
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
            if (!binding?.spaceIds.length || binding.connectionId !== connectionIdentity(this.config.value))
                throw new Error('无可用空间关联或连接已变更');
            const data = await this.cloud.call<{
                topic_detail_list: Record<string, unknown>[];
            }>('search/memory', { user_id: this.config.value.userId, conversation_id: session.id, query: input.query, space_ids: binding.spaceIds, include_memory_view: ['project'] }, this.cloudContext(session, { conversationId: input.conversationId }));
            const current = this.store.binding(session.objectId);
            if (this.store.memory.forSession(session)?.enabledAt !== scope.enabledAt) return fail('UNAVAILABLE', '当前 Agent 与项目绑定已变更');
            if (current?.connectionId !== binding.connectionId || JSON.stringify(current.spaceIds) !== JSON.stringify(binding.spaceIds))
                throw new Error('检索期间空间关联已变更');
            const content = topicContent(data.topic_detail_list);
            this.store.recall(session.id, input.conversationId, 'search', input.query, content, 'returned');
            return { ok: true, status: content ? 'FOUND' : 'EMPTY', data: { content }, error: null };
        }
        catch (error) {
            if (this.store.memory.forSession(session)?.enabledAt !== scope.enabledAt) return fail('UNAVAILABLE', '当前 Agent 与项目未启用记忆');
            this.store.diagnostic(this.error(error));
            this.store.recall(session.id, input.conversationId, 'search', input.query, '', 'failed');
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
        await this.claude.flush();
        await this.cursor.flush();
        await this.copilot.flush();
        await this.prime.flush();
        await this.captureCodex();
        while (true) {
            let advanced = false;
            for (const [scopeId, job] of this.historyUploads) {
                const scope = this.store.memory.get(scopeId);
                if (!scope?.spaceIds.length) { await job.steps.return(undefined); this.historyUploads.delete(scopeId); continue; }
                if (scope.connectionId !== connectionIdentity(this.config.value) || job.error) continue;
                const failure = job.batchId ? this.deliveries.historyError(scopeId, job.batchId) : undefined;
                if (failure) { job.error = failure; await job.steps.return(undefined); continue; }
                if (this.deliveries.historyRunning(scopeId)) continue;
                try {
                    const next = await job.steps.next();
                    advanced = true;
                    if (next.done) this.historyUploads.delete(scopeId);
                    else job.batchId = next.value;
                } catch (error) { job.error = this.error(error); }
            }
            if (this.config.value.paused || connectionError(this.config.value))
                return;
            this.deliveries.queueLive();
            for (let delivery of this.deliveries.pending()) {
                while (true) {
                    const current = this.deliveries.ready(delivery);
                    if (!current) break;
                    delivery = current;
                    const scope = this.store.memory.get(String(delivery.objectId));
                    if (this.config.value.paused || !scope?.spaceIds.includes(String(delivery.spaceId)) || scope.connectionId !== delivery.connectionId || scope.connectionId !== connectionIdentity(this.config.value)) break;
                    const messages = JSON.parse(String(delivery.messages));
                    const validation = uploadValidationError(messages);
                    if (validation) {
                        this.deliveries.update(delivery, { status: 'blocked', error: validation });
                        break;
                    }
                    delivery.attempts++;
                    this.deliveries.update(delivery, { attempts: delivery.attempts, userId: delivery.userId ?? this.config.value.userId });
                    try {
                        const session = this.store.session(String(delivery.sessionId))!;
                        const data = await this.cloud.call<{ success: boolean; task_id?: string; status?: string }>('add/message', { ...this.deliveries.request(session.id, String(delivery.spaceId), messages), user_id: delivery.userId ?? this.config.value.userId }, this.deliveryContext(delivery));
                        if (data.success !== true || !data.task_id) throw new Error('上传缺少接收确认或task_id');
                        this.deliveries.update(delivery, { status: 'accepted', taskId: data.task_id, processingStatus: data.status ?? 'running', error: null });
                        break;
                    } catch (error) {
                        if (!this.deliveries.isPending(delivery)) break;
                        const failure = error as { uncertain?: boolean; httpStatus?: number; kind?: string };
                        const terminal = failure.uncertain || failure.httpStatus !== undefined && failure.httpStatus >= 400 && failure.httpStatus < 500 && failure.httpStatus !== 429;
                        this.deliveries.update(delivery, { status: failure.uncertain ? 'blocked' : terminal || delivery.attempts >= 2 ? 'failed' : 'pending', error: this.error(error) });
                        if (failure.httpStatus === 429) return;
                    }
                }
            }
            for (const delivery of this.deliveries.accepted()) {
                const scope = this.store.memory.get(String(delivery.objectId));
                if (this.config.value.paused || !scope?.spaceIds.includes(String(delivery.spaceId)) || scope.connectionId !== delivery.connectionId || scope.connectionId !== connectionIdentity(this.config.value) || !delivery.taskId) continue;
                try {
                    const data = await this.cloud.call<{ status: string; memory_views?: { project?: { open_episode_messages?: number; memory_ids?: string[] } } }>('get/status', { task_id: delivery.taskId, user_id: delivery.userId ?? this.config.value.userId }, this.deliveryContext(delivery));
                    const project = data.memory_views?.project;
                    const accumulating = data.status === 'completed' && (project?.open_episode_messages === undefined || project.open_episode_messages > 0);
                    this.deliveries.update(delivery, { processingStatus: accumulating ? project?.open_episode_messages === undefined ? 'unknown' : 'accumulating' : data.status,
                        status: data.status === 'failed' ? 'processing-failed' : data.status === 'completed' && !accumulating ? 'completed' : 'accepted',
                        ...(project?.open_episode_messages !== undefined ? { openEpisodeMessages: project.open_episode_messages } : {}),
                        ...(project?.memory_ids !== undefined ? { memoryIds: project.memory_ids } : {}), error: null });
                } catch (error) { this.deliveries.update(delivery, { error: this.error(error) }); }
            }
            const sendable = this.deliveries.pending().some(delivery => {
                const scope = this.store.memory.get(String(delivery.objectId));
                return scope?.connectionId === connectionIdentity(this.config.value) && scope.connectionId === delivery.connectionId && scope.spaceIds.includes(String(delivery.spaceId));
            });
            if (!advanced && !sendable && ![...this.historyUploads].some(([id, job]) => !job.error && this.store.memory.get(id)?.connectionId === connectionIdentity(this.config.value) && !this.deliveries.historyRunning(id))) break;
        }
    }

    error(error: unknown) { const message = error instanceof Error ? error.message : String(error); return this.config.value.apiKey ? message.replaceAll(this.config.value.apiKey, '[REDACTED]') : message; }
}
