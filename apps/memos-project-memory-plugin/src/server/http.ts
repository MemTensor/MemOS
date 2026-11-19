import { createServer } from 'node:http';
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
            if (req.method === 'GET' && !path.startsWith('/api/')) {
                const name = path === '/' ? 'index.html' : path.slice(1);
                if (!['index.html', 'app.js', 'view.js', 'style.css'].includes(name))
                    return json({ error: 'Not found' }, 404);
                const content = await readFile(fileURLToPath(new URL(`../../viewer/${name}`, import.meta.url)));
                res.writeHead(200, { 'Content-Type': name.endsWith('.css') ? 'text/css' : name.endsWith('.js') ? 'text/javascript' : 'text/html; charset=utf-8', 'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'", 'Cache-Control': 'no-store' });
                res.end(content);
                return;
            }
            let body: Record<string, any> = {};
            if (req.method !== 'GET') {
                if (!req.headers['content-type']?.startsWith('application/json'))
                    return json({ error: 'JSON required' }, 415);
                const chunks: Buffer[] = [];
                for await (const chunk of req)
                    chunks.push(Buffer.from(chunk));
                body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
            }
            if (path === '/api/health')
                return json({ ok: true, service: 'memos-project-memory-plugin', apiVersion: LOCAL_API_VERSION, runtimeRevision, pid: process.pid });
            if (path === '/api/config' && req.method === 'GET')
                return json(service.config.public());
            if (path === '/api/activation' && req.method === 'GET')
                return json({ active: await service.activation({ agentType: url.searchParams.get('agentType') ?? '', cwd: url.searchParams.get('cwd') ?? '',
                    nativeSessionId: url.searchParams.get('nativeSessionId') ?? undefined, parentNativeSessionId: url.searchParams.get('parentNativeSessionId') ?? undefined }) });
            if (path === '/api/config' && req.method === 'PUT')
                return json(service.configure(body));
            if (path === '/api/projects' && req.method === 'GET')
                return json(url.searchParams.has('agentType') ? await service.projects(url.searchParams.get('agentType')!, url.searchParams.get('refresh') === '1') : service.store.state().projects);
            if (path === '/api/projects' && req.method === 'POST')
                return json(Object.hasOwn(body, 'spaceId') || Object.hasOwn(body, 'spaceName') ? await service.bindProject(body) : service.store.createProject(String(body.name ?? ''), String(body.root ?? '')));
            const projectSpaces = path.match(/^\/api\/projects\/([^/]+)\/spaces$/);
            if (projectSpaces && req.method === 'GET')
                return json(await service.projectSpaces(decodeURIComponent(projectSpaces[1]!)));
            const history = path.match(/^\/api\/projects\/([^/]+)\/history(\/scan)?$/);
            if (history && req.method === 'POST') {
                const scopeId = decodeURIComponent(history[1]!);
                if (history[2]) await service.history.scan(scopeId);
                else await service.uploadHistory(scopeId);
                return json(service.history.status(scopeId));
            }
            if (path === '/api/bind' && req.method === 'POST')
                return json(await service.bind(String(body.objectId ?? ''), String(body.spaceId ?? '')));
            if (path === '/api/bind' && req.method === 'GET')
                return json(service.bindingState());
            if (path === '/api/bind' && req.method === 'DELETE')
                return json(service.store.unbind(String(body.objectId ?? ''), String(body.spaceId ?? '')));
            if (req.method === 'GET' && (path === '/api/state' || path === '/api/sessions' || path.startsWith('/api/sessions/')))
                await service.refreshSessionTitles();
            if (path === '/api/state' && req.method === 'GET')
                return json(service.state());
            if (path === '/api/sessions' && req.method === 'GET') {
                const projectId = url.searchParams.get('projectId'), unassigned = url.searchParams.get('scope') === 'unassigned';
                if ((!projectId && !unassigned) || (projectId && unassigned))
                    return json({ error: '请选择项目或未归属范围' }, 400);
                if (projectId && !service.store.row('SELECT id FROM projects WHERE id=?', projectId))
                    return json({ error: '项目不存在' }, 404);
                const sessions = service.store.state().sessions.filter(session => service.visibleSession(String(session.id)) && (projectId ? session.projectId === projectId : !session.projectId))
                    .sort((a, b) => String(a.sourceStartedAt ?? a.createdAt).localeCompare(String(b.sourceStartedAt ?? b.createdAt)) || String(a.id).localeCompare(String(b.id)));
                const page = Math.max(1, Number(url.searchParams.get('page')) || 1), size = Math.min(200, Math.max(1, Number(url.searchParams.get('size')) || 50));
                return json({ projectId: projectId ?? null, sessions: sessions.slice((page - 1) * size, page * size), total: sessions.length, page, size });
            }
            if (path.startsWith('/api/sessions/') && req.method === 'GET') {
                const id = decodeURIComponent(path.slice('/api/sessions/'.length));
                if (!service.visibleSession(id))
                    return json({ error: '会话不存在' }, 404);
                return json(service.store.sessionDetail(id, Math.max(1, Number(url.searchParams.get('page')) || 1), Math.min(200, Math.max(1, Number(url.searchParams.get('size')) || 50)), url.searchParams.get('unit') === 'turn' ? 'turn' : 'trace'));
            }
            if (path === '/api/events' && req.method === 'POST')
                return json(await service.event(body as AgentEvent));
            if (path === '/api/context-delivery' && req.method === 'POST') {
                const session = service.store.session(String(body.sessionId ?? ''));
                if (session && service.store.memory.forSession(session)) service.store.markContextDelivered(session.id);
                return json({ ok: true });
            }
            if (path === '/api/search' && req.method === 'POST')
                return json(await service.search(body));
            if (path === '/api/sync' && req.method === 'POST') {
                await service.sync();
                return json({ ok: true });
            }
            if (path.startsWith('/api/adapters')) {
                if (path === '/api/adapters/installed' && req.method === 'GET')
                    return json(await service.installedAdapters());
                const installer = await import('../adapters/installer.ts');
                if (path === '/api/adapters' && req.method === 'GET')
                    return json(await installer.listAgents());
                const match = path.match(/^\/api\/adapters\/([^/]+)\/(install|repair|uninstall)$/);
                if (match && req.method === 'POST')
                    return json(await (match[2] === 'uninstall' ? installer.uninstallAdapter : installer.installAdapter)(decodeURIComponent(match[1]!)));
            }
            return json({ error: 'Not found' }, 404);
        }
        catch (error) {
            const message = service.error(error);
            service.store.diagnostic(message);
            const spaceId = path === '/api/projects' && req.method === 'POST' && error instanceof Error && 'spaceId' in error && typeof error.spaceId === 'string' ? error.spaceId : undefined;
            return json({ error: message, ...(spaceId ? { spaceId } : {}) }, 400);
        }
    });
}
