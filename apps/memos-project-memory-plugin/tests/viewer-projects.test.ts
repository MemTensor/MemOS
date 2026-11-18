import { test } from 'node:test';
import assert from 'node:assert/strict';
// @ts-expect-error browser module intentionally has no separate declaration file
import { projectSessionGroups, traceScopeGroups, traceScopeSessions } from '../viewer/view.js';

test('unbound sessions show their local directory as a project without changing persisted routing', () => {
  const root = '/work/项目记忆';
  const state = {
    projects: [],
    tasks: [{ id: 't1', projectId: null, objectId: 'scope-1' }, { id: 't2', projectId: null, objectId: 'scope-2' }],
    sessions: [
      { id: 'one', taskId: 't1', projectId: null, cwd: root, agentType: 'codex-cli', sourceKind: 'user', turnCount: 2 },
      { id: 'two', taskId: 't2', projectId: null, cwd: root, agentType: 'codex-cli', sourceKind: 'user', turnCount: 3 },
      { id: 'other', projectId: null, cwd: '/elsewhere/项目记忆', agentType: 'codex-cli', sourceKind: 'user' },
      { id: 'claude', projectId: null, cwd: root, agentType: 'claude-code' },
      { id: 'child', projectId: null, cwd: root, agentType: 'codex-cli', sourceKind: 'subagent' },
      { id: 'unknown', projectId: null, agentType: 'codex-cli' },
    ],
  };
  const original = structuredClone(state);
  const groups = traceScopeGroups(state, 'codex-cli');
  const project = groups.find((group: any) => group.root === root);
  assert.ok(project, 'known local directory must appear before Space binding');
  assert.equal(project.name, '项目记忆');
  assert.deepEqual(project.sessions.map((session: any) => session.id), ['one', 'two']);
  assert.equal(project.turnCount, 5);
  assert.deepEqual(traceScopeSessions(groups, { project: project.id }).map((session: any) => session.id), ['one', 'two']);
  assert.notEqual(project.id, groups.find((group: any) => group.root === '/elsewhere/项目记忆').id);
  assert.deepEqual(groups.find((group: any) => group.id === null).sessions.map((session: any) => session.id), ['unknown']);
  assert.equal(projectSessionGroups(state).find((group: any) => group.root === root).id, project.id);
  assert.deepEqual(state, original, 'display grouping must not rewrite task IDs, project IDs or upload scopes');
});

test('explicit project identity wins and only reliable absolute directories create fallback groups', () => {
  const state = { projects: [{ id: 'registered', name: '用户命名项目', root: '/registered' }], sessions: [
    { id: 'bound', projectId: 'registered', cwd: '/registered/subdir', agentType: 'codex-cli' },
    { id: 'windows', projectId: null, cwd: 'C:\\work\\本地项目', agentType: 'codex-cli' },
    { id: 'relative', projectId: null, cwd: 'relative/path', agentType: 'codex-cli' },
    { id: 'missing', projectId: null, cwd: '', agentType: 'codex-cli' },
  ] };
  const groups = projectSessionGroups(state);
  const registered = groups.find((group: any) => group.id === 'registered');
  assert.equal(registered.name, '用户命名项目');
  assert.deepEqual(registered.sessions.map((session: any) => session.id), ['bound']);
  assert.equal(groups.find((group: any) => group.root === 'C:\\work\\本地项目')?.name, '本地项目');
  assert.deepEqual(groups.find((group: any) => group.id === null).sessions.map((session: any) => session.id), ['missing', 'relative']);
});
