/** Independent HTTP fixture server. Does not perform memory extraction or inference. */
import { createServer, type Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { projectFixtures } from './fixtures.ts';

type Json = Record<string, any>;
export interface MockOptions { apiKey?: string; seedTopics?: boolean; presetProjects?: boolean; spaces?: Json[]; topics?: Json[] }
export interface MockState {
  spaces: Map<string, Json>; topics: Map<string, Json[]>; tasks: Map<string, Json>;
  uploads: Json[]; requests: { path: string; method: string; body: Json }[];
}
const states = new WeakMap<Server, MockState>();
export function getMockState(server: Server): MockState {
  const state = states.get(server); if (!state) throw new Error('Not a MemOS mock server'); return state;
}
export function createMockServer(options: MockOptions = {}): Server {
  const state: MockState = { spaces: new Map(), topics: new Map(), tasks: new Map(), uploads: [], requests: [] };
  const fixtures = options.presetProjects ? projectFixtures() : { spaces: [], topics: [] };
  for (const space of fixtures.spaces) state.spaces.set(space.space_id, space);
  for (const topic of fixtures.topics) state.topics.set(topic.space_id, [...(state.topics.get(topic.space_id) ?? []), topic]);
  for (const space of options.spaces ?? []) state.spaces.set(space.space_id, space);
  for (const topic of options.topics ?? []) state.topics.set(topic.space_id, [...(state.topics.get(topic.space_id) ?? []), topic]);
  const server = createServer(async (request, response) => {
    const send = (httpStatus: number, code: number, message: string, data: unknown = null) => {
      response.writeHead(httpStatus, { 'Content-Type': 'application/json; charset=utf-8' }); response.end(JSON.stringify({ code, message, data }));
    };
    if (request.method !== 'POST') return send(405, 405, 'Mock endpoints use POST');
    if (request.headers.authorization !== `Token ${options.apiKey ?? 'mock-key'}`) return send(401, 401, 'Invalid mock key');
    let body: Json;
    try {
      const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
      body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as Json;
      if (!body || typeof body !== 'object' || Array.isArray(body)) return send(400, 400, 'Expected JSON object');
    } catch { return send(400, 400, 'Invalid JSON'); }
    const path = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
    state.requests.push({ path, method: request.method, body: structuredClone(body) });
    const endpoint = path.replace(/^\/api\/openmem\/v1\//, '');
    if (endpoint === 'create/space') {
      if (typeof body.space_name !== 'string' || !body.space_name.trim()) return send(400, 400, 'space_name required');
      const now = new Date().toISOString(), id = `mock_space_${randomUUID()}`;
      const space = { space_id: id, space_name: body.space_name, instructions: body.instructions ?? null, create_time: now, update_time: now };
      state.spaces.set(id, space);
      state.topics.set(id, options.seedTopics === false ? [] : [{
        id: `mock_topic_${randomUUID()}`, space_id: id, domain: null, topic_name: 'Mock 接口验证',
        topic_summary: 'Mock 固定测试数据，仅用于验证插件链路，不代表云端记忆抽取结果。',
        topic_description: '本主题由 mock 创建空间时预置。上传内容另行完整保留，未执行记忆算法。',
        decisions: [{ content: 'Mock 示例：保留工具调用和完整结果。', time: now, user_ids: ['mock_user'], history: [], conflicts: [] }],
        experiences: [], timeline: [], sources: [], create_time: now, update_time: now,
      }]);
      return send(200, 0, 'ok', space);
    }
    if (endpoint === 'get/space') {
      const space = state.spaces.get(body.space_id); return space ? send(200, 0, 'ok', space) : send(404, 404, 'Mock space not found');
    }
    if (endpoint === 'add/message') {
      if (!Array.isArray(body.space_ids) || !body.space_ids.length || body.space_ids.some((id: unknown) => typeof id !== 'string' || !state.spaces.has(id))) return send(400, 400, 'Existing spaces required');
      if (!Array.isArray(body.messages) || !body.messages.length || !body.user_id) return send(400, 400, 'user_id and messages required');
      state.uploads.push(structuredClone(body));
      const taskId = `mock_task_${randomUUID()}`;
      state.tasks.set(taskId, { task_id: taskId, status: 'completed', memory_views: { added: 0, updated: 0, deleted: 0, project: { memory_ids: [...new Set(body.space_ids.flatMap((id: string) => (state.topics.get(id) ?? []).map(topic => topic.id)))] } } });
      return send(200, 0, 'ok', { success: true, task_id: taskId, status: 'running' });
    }
    if (endpoint === 'get/status') {
      const task = state.tasks.get(body.task_id); return task ? send(200, 0, 'ok', task) : send(404, 404, 'Mock task not found');
    }
    if (endpoint === 'get/memory') {
      if (!state.spaces.has(body.space_id)) return send(404, 404, 'Mock space not found');
      const topics = [...(state.topics.get(body.space_id) ?? [])].sort((a, b) => String(b.update_time).localeCompare(String(a.update_time)));
      const size = Math.min(50, Math.max(1, Number(body.size) || 10)), page = Math.max(1, Number(body.page) || 1);
      return send(200, 0, 'ok', { topic_detail_list: topics.slice((page - 1) * size, page * size), total: topics.length, size, current: page, pages: Math.ceil(topics.length / size) });
    }
    if (endpoint === 'search/memory') {
      if (!body.user_id || typeof body.query !== 'string' || !body.query.trim() || !Array.isArray(body.space_ids) || !body.space_ids.length) return send(400, 400, 'user_id, query and spaces required');
      if (body.space_ids.some((id: unknown) => typeof id !== 'string' || !state.spaces.has(id))) return send(404, 404, 'Mock space not found');
      const selected = new Map<string, Json>();
      for (const id of body.space_ids) for (const topic of state.topics.get(id) ?? []) selected.set(topic.id, topic);
      const topics = [...selected.values()].map(({ sources: _sources, create_time: _created, ...topic }) => ({ ...topic, relativity: 1 }));
      return send(200, 0, 'ok', { topic_detail_list: topics });
    }
    return send(404, 404, 'Unknown mock endpoint');
  });
  states.set(server, state); return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.MEMOS_MOCK_PORT ?? 8711);
  createMockServer({ apiKey: process.env.MEMOS_MOCK_KEY ?? 'mock-key', presetProjects: true }).listen(port, '127.0.0.1', () => {
    process.stdout.write(`MemOS MOCK listening at http://127.0.0.1:${port}; preset projects reload on restart; runtime data resets.\n`);
  });
}
