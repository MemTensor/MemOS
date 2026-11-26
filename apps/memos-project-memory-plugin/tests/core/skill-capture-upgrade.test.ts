import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installAdapter, installedSkills } from '../../src/adapters/installer.ts';
import { filterClaudeSkills } from '../../src/adapters/claude-code/skill-filter.ts';
import { PluginService } from '../../src/server/service.ts';
import type { TraceInput } from '../../src/adapters/types.ts';
import { captureUploads } from '../helpers/capture-uploads.ts';

async function fixture(t: test.TestContext) {
  const home = await mkdtemp(join(tmpdir(), 'pm-skill-upgrade-'));
  const installed = await installAdapter('claude-code', { home, cwd: home });
  const skill = installed.files.find(path => path.endsWith('/memos-project-memory/SKILL.md'))!;
  const service = new PluginService(join(home, 'data'), { home, codexRoots: [] });
  t.after(async () => { service.close(); await rm(home, { recursive: true, force: true }); });
  service.configure({ authMode: 'none' });
  const { uploads, call } = captureUploads(); service.cloud.call = call;
  const project = service.store.bindProject('Fixture', home, 'A', service.config.value.baseUrl, 'claude-code');
  service.store.db.exec("UPDATE capture_windows SET startedAt='2020-01-01T00:00:00.000Z'; UPDATE bindings SET boundAt='2020-01-01T00:00:00.000Z'");
  const identity = { agentType: 'claude-code', nativeSessionId: 'fixture', cwd: home, nativeTurnId: 'turn' };
  const records: TraceInput[] = [
    { sourceId: 'calls', nativeTurnId: 'turn', raw: { timestamp: '2026-01-01T00:00:00.000Z' }, message: { role: 'assistant', content: [
      { type: 'tool_use', id: 'skill', name: 'Read', input: { file_path: skill } },
      { type: 'tool_use', id: 'business', name: 'Bash', input: { command: 'pwd' } },
    ] } },
    { sourceId: 'results', nativeTurnId: 'turn', raw: { timestamp: '2026-01-01T00:00:01.000Z' }, message: { role: 'user', content: [
      { type: 'tool_result', tool_use_id: 'skill', content: 'PRIVATE_SKILL_BODY' },
      { type: 'tool_result', tool_use_id: 'business', content: '/project' },
    ] } },
  ];
  const context = await service.event({ ...identity, event: 'turn-start', records });
  await service.event({ ...identity, event: 'turn-end' });
  const source = service.store.rows('SELECT id,sourceId,raw,message FROM traces ORDER BY id').map(row => ({
    id: Number(row.id), sourceId: String(row.sourceId), nativeTurnId: 'turn', raw: JSON.parse(String(row.raw)), message: JSON.parse(String(row.message)),
  }));
  return { home, service, project, identity, context, source, uploads };
}

test('history projects full context before selecting a result-only source', async t => {
  const { service, project } = await fixture(t);
  service.deliveries.queueHistory(project.scopeId, ['A'], [{ nativeSessionId: 'fixture', sourceId: 'results' }]);
  const historical = service.store.rows("SELECT b.messages FROM batches b JOIN batch_deliveries d ON d.batchId=b.id WHERE d.kind='history'");
  assert.equal(historical.length, 1);
  const messages = JSON.parse(String(historical[0]!.messages));
  assert.deepEqual(messages.map((message: { tool_call_id: string }) => message.tool_call_id), ['business']);
  assert.doesNotMatch(JSON.stringify(messages), /PRIVATE_SKILL_BODY/);
  await service.sync();
  assert.doesNotMatch(JSON.stringify(service.store.batches()), /PRIVATE_SKILL_BODY/);
});

test('native replay restores legacy nested Skill receipts without changing accepted requests', async t => {
  const { service, context, source, uploads } = await fixture(t);
  await service.sync();
  const frozen = service.store.rows('SELECT * FROM batches');
  const receipts = service.store.rows('SELECT * FROM batch_deliveries');
  const legacy = filterClaudeSkills(source);
  assert.doesNotMatch(JSON.stringify(legacy), /PRIVATE_SKILL_BODY/);
  for (const row of legacy) service.store.db.prepare('UPDATE traces SET raw=?,message=? WHERE id=?').run(JSON.stringify(row.raw), JSON.stringify(row.message), Number(row.id));
  service.store.capture(context.sessionId, source);
  const restored = service.store.rows('SELECT id,sourceId,raw,message FROM traces ORDER BY id');
  assert.deepEqual(restored.map(row => JSON.parse(String(row.message))), source.map(row => row.message));
  assert.deepEqual(service.store.rows('SELECT * FROM batches'), frozen);
  assert.deepEqual(service.store.rows('SELECT * FROM batch_deliveries'), receipts);
  await service.sync(); assert.equal(uploads.length, 1);
});

test('native replay restores partial owned controls before legacy metadata is discarded', async t => {
  const { home, service, context, source } = await fixture(t);
  const legacy = filterClaudeSkills(source, installedSkills('claude-code', home));
  assert.ok(legacy.some(row => Array.isArray(row.raw.skillCallIds)));
  for (const row of legacy) service.store.db.prepare('UPDATE traces SET raw=?,message=? WHERE id=?').run(JSON.stringify(row.raw), JSON.stringify(row.message), Number(row.id));
  service.store.capture(context.sessionId, source);
  assert.deepEqual(service.store.rows('SELECT message FROM traces ORDER BY id').map(row => JSON.parse(String(row.message))), source.map(row => row.message));
});
