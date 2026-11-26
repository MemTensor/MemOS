import { createServer, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type { PluginService } from './service.ts';
import type { AgentEvent } from '../adapters/types.ts';
import { LOCAL_API_VERSION, currentRuntimeRevision } from '../runtime/revision.ts';
export function createLocalServer(service: PluginService) {
    const runtimeRevision = currentRuntimeRevision();
    return createServer(async (req, res) => {
        const json = (value: unknown, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(value)); };
        const host = req.headers.host ?? '';
        if (!/^127\.0\.0\.1(?::\d+)?$/.test(host) && !/^localhost(?::\d+)?$/.test(host))
            return json({ error: 'Local access only' }, 403);
        if (req.headers.origin && req.headers.origin !== `http://${host}`)
            return json({ error: 'Cross-origin access denied' }, 403);
        const url = new URL(req.url ?? '/', `http://${host}`), path = url.pathname;
        try {
            if (req.method === 'GET' && !path.startsWith('/api/'))
                return await serveAsset(path, res, json);
            let body: Record<string, any> = {};
            if (req.method !== 'GET') {
                if (!req.headers['content-type']?.startsWith('application/json'))
                    return json({ error: 'JSON required' }, 415);
                const chunks: Buffer[] = [];
                for await (const chunk of req)
                    chunks.push(Buffer.from(chunk));
                body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
            }
            await dispatchApi(service, req.method, url, body, json, runtimeRevision);
        } catch (error) {
            json(requestError(service, error), 400);
        }
    });
}

type JsonResponse = (value: unknown, status?: number) => void;

async function serveAsset(path: string, res: ServerResponse, json: JsonResponse) {
    const name = path === '/' ? 'index.html' : path.slice(1);
    if (!['index.html', 'app.js', 'view.js', 'i18n.js', 'style.css'].includes(name))
        return json({ error: 'Not found' }, 404);
    const content = await readFile(fileURLToPath(new URL(`../../viewer/${name}`, import.meta.url)));
    res.writeHead(200, { 'Content-Type': name.endsWith('.css') ? 'text/css' : name.endsWith('.js') ? 'text/javascript' : 'text/html; charset=utf-8', 'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'", 'Cache-Control': 'no-store' });
    res.end(content);
}

function requestError(service: PluginService, error: unknown, spaceId?: string) {
    const message = service.error(error);
    service.store.diagnostic(message);
    return { error: message, ...(spaceId ? { spaceId } : {}) };
}

function pagination(params: URLSearchParams) {
    return {
        page: Math.max(1, Number(params.get('page')) || 1),
        size: Math.min(200, Math.max(1, Number(params.get('size')) || 50)),
    };
}

async function dispatchApi(service: PluginService, method: string | undefined, url: URL, body: Record<string, any>, json: JsonResponse, runtimeRevision: string) {
    const path = url.pathname;
    if (path === '/api/health')
        return json({ ok: true, service: 'memos-project-memory-plugin', apiVersion: LOCAL_API_VERSION, runtimeRevision, pid: process.pid });
    if (path === '/api/diagnostics' && method === 'GET')
        return json(service.store.cloudDiagnostics.list({ endpoint: url.searchParams.get('endpoint') ?? '', page: Number(url.searchParams.get('page') ?? 1), size: Number(url.searchParams.get('size') ?? 50) }));
    if (path === '/api/diagnostics/export' && method === 'GET')
        return json(service.store.cloudDiagnostics.export());
    const diagnostic = path.match(/^\/api\/diagnostics\/([^/]+)$/);
    if (diagnostic && method === 'GET') {
        const record = service.store.cloudDiagnostics.detail(decodeURIComponent(diagnostic[1]!));
        return record ? json(record) : json({ error: '诊断记录不存在' }, 404);
    }
    if (path === '/api/create-context' && method === 'POST')
        return json(await service.createContext(body as import('../storage/create-contexts.ts').CreationIdentity));
    if (path === '/api/create' && method === 'POST')
        return json(await service.create(body));
    if (path === '/api/bind-project' && method === 'POST')
        return json(await service.bindDialog(body));
    if (path === '/api/unbind-project' && method === 'POST')
        return json(service.unbindDialog(body));
    if (path === '/api/project-spaces' && method === 'POST')
        return json(service.projectSpacesDialog(body));
    if (path === '/api/bind-context' && method === 'POST')
        return json(service.bindContext(body));
    if (path === '/api/config' && method === 'GET')
        return json(service.config.public());
    if (path === '/api/activation' && method === 'GET')
        return json({ active: await service.activation({ agentType: url.searchParams.get('agentType') ?? '', cwd: url.searchParams.get('cwd') ?? '',
            nativeSessionId: url.searchParams.get('nativeSessionId') ?? undefined, parentNativeSessionId: url.searchParams.get('parentNativeSessionId') ?? undefined }) });
    if (path === '/api/config' && method === 'PUT')
        return json(service.configure(body));
    if (path === '/api/connection-test' && method === 'POST') {
        if (body.spaceId !== undefined && typeof body.spaceId !== 'string')
            return json({ error: 'Space ID 须为字符串' }, 400);
        return json(await service.cloud.probe(body.spaceId));
    }
    if (path === '/api/projects' && method === 'GET')
        return json(url.searchParams.has('agentType') ? await service.projects(url.searchParams.get('agentType')!, url.searchParams.get('refresh') === '1') : service.store.state().projects);
    if (path === '/api/projects' && method === 'POST') {
        try {
            return json(Object.hasOwn(body, 'spaceId') || Object.hasOwn(body, 'spaceName') ? await service.bindProject(body) : service.store.createProject(String(body.name ?? ''), String(body.root ?? '')));
        } catch (error) {
            const spaceId = error instanceof Error && 'spaceId' in error && typeof error.spaceId === 'string' ? error.spaceId : undefined;
            return json(requestError(service, error, spaceId), 400);
        }
    }
    const projectSpaces = path.match(/^\/api\/projects\/([^/]+)\/spaces$/);
    if (projectSpaces && method === 'GET')
        return json(await service.projectSpaces(decodeURIComponent(projectSpaces[1]!)));
    const history = path.match(/^\/api\/projects\/([^/]+)\/history(\/scan)?$/);
    if (history && method === 'POST') {
        const scopeId = decodeURIComponent(history[1]!);
        if (history[2]) await service.history.scan(scopeId);
        else await service.uploadHistory(scopeId);
        return json(service.history.status(scopeId));
    }
    if (path === '/api/bind' && method === 'POST')
        return json(await service.bind(String(body.objectId ?? ''), String(body.spaceId ?? '')));
    if (path === '/api/bind' && method === 'GET')
        return json(service.bindingState());
    if (path === '/api/bind' && method === 'DELETE')
        return json(service.unbind(String(body.objectId ?? ''), String(body.spaceId ?? '')));
    if (path === '/api/state' && method === 'GET') {
        await service.refreshSessionTitles();
        return json(service.state());
    }
    if (path === '/api/sessions' && method === 'GET') {
        await service.refreshSessionTitles();
        const projectId = url.searchParams.get('projectId');
        if (Boolean(projectId) === (url.searchParams.get('scope') === 'unassigned'))
            return json({ error: '请选择项目或未归属范围' }, 400);
        const { page, size } = pagination(url.searchParams);
        const result = service.sessionPage(projectId, page, size);
        return result ? json(result) : json({ error: '项目不存在' }, 404);
    }
    if (path.startsWith('/api/sessions/') && method === 'GET') {
        await service.refreshSessionTitles();
        const id = decodeURIComponent(path.slice('/api/sessions/'.length));
        if (!service.visibleSession(id)) return json({ error: '会话不存在' }, 404);
        const { page, size } = pagination(url.searchParams);
        return json(service.store.sessionDetail(id, page, size, url.searchParams.get('unit') === 'turn' ? 'turn' : 'trace'));
    }
    if (path === '/api/events' && method === 'POST')
        return json(await service.event(body as AgentEvent));
    if (path === '/api/context-delivery' && method === 'POST') {
        service.markContextDelivered(body);
        return json({ ok: true });
    }
    if (path === '/api/doubao/search' && method === 'POST')
        return json(await service.searchDoubao(body));
    if (path === '/api/search' && method === 'POST')
        return json(await service.search(body));
    if (path === '/api/sync' && method === 'POST') {
        await service.sync();
        return json({ ok: true });
    }
    if (path.startsWith('/api/adapters')) {
        if (path === '/api/adapters/installed' && method === 'GET')
            return json(await service.installedAdapters());
        const installer = await import('../adapters/installer.ts');
        if (path === '/api/adapters' && method === 'GET')
            return json(await installer.listAgents());
        const match = path.match(/^\/api\/adapters\/([^/]+)\/(install|repair|uninstall)$/);
        if (match && method === 'POST')
            return json(await service.changeAdapter(decodeURIComponent(match[1]!), match[2] === 'uninstall'));
    }
    return json({ error: 'Not found' }, 404);
}
