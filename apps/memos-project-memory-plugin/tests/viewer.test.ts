import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

// Minimal DOM checks text-only rendering without adding a browser runtime dependency.
class Node {
  tagName: string; children: Node[] = []; attributes: Record<string, string> = {}; textContent = ''; className = ''; hidden = false;
  listeners: Record<string, (...args: any[]) => any> = {};
  constructor(tag: string) { this.tagName = tag; }
  append(...children: Node[]) { this.children.push(...children); }
  addEventListener(name: string, callback: (...args: any[]) => any) { this.listeners[name] = callback; }
  setAttribute(name: string, value: string) { this.attributes[name] = value; }
  set innerHTML(_value: string) { throw new Error('Unsafe HTML write'); }
  get text(): string { return this.textContent + this.children.map((child) => child.text).join(''); }
}
(globalThis as any).document = { createElement: (tag: string) => new Node(tag), createElementNS: (_namespace: string, tag: string) => new Node(tag) };
// @ts-expect-error viewer is deliberately plain browser JavaScript
const { details, filterSessions, statusLabel, taskTraceEntries, taskTurnCard, projectBindingTable, spaceBindingItem, projectSessionGroups, sessionStartedAt, traceOccurredAt, projectTraceCard, sessionTraceCard } = await import('../viewer/view.js');

test('project bindings show Agent, project name and directory with zero, one or many spaces', async () => {
  const opened: string[] = [];
  const table = projectBindingTable([
    { id: 'empty', name: '用户定义项目甲', root: '/secret/project/path', agentType: 'codex-cli', spaceIds: [] },
    { id: 'one', name: '用户定义项目乙', root: '/secret/other/path', agentType: 'claude-code', spaceIds: ['space-1'] },
    { id: 'many', name: '跨 Agent 项目', root: '/secret/shared/path', agentType: 'codex-cli', spaceIds: ['space-2', 'space-3'] },
  ], [{ agentId: 'codex-cli', name: 'Codex CLI' }, { agentId: 'claude-code', name: 'Claude Code' }], (project: any) => opened.push(project.id)) as Node;
  assert.equal(table.tagName, 'table');
  assert.ok(!table.text.includes('space-1'));
  assert.match(table.text, /Codex CLI.*用户定义项目甲.*未绑定 Space/);
  assert.match(table.text, /Claude Code.*用户定义项目乙.*1 个 Space/);
  assert.match(table.text, /跨 Agent 项目.*2 个 Space/);
  const rows = table.children[1].children;
  assert.deepEqual(rows.map(row => row.children[1].children[0].text), ['/secret/project/path', '/secret/other/path', '/secret/shared/path']);
  await rows[2].children[2].children[0].listeners.click();
  assert.deepEqual(opened, ['many']);
});

test('space detail keeps full code, copy icon, then unbind icon and acts on the selected ID only', async () => {
  const copied: string[] = [], removed: string[] = [];
  const space = { name: '团队知识空间', spaceId: 'space-full-code-甲-very-long' };
  const item = spaceBindingItem(space, (id: string) => copied.push(id), (id: string) => removed.push(id)) as Node;
  assert.equal(item.tagName, 'li');
  assert.equal(item.children[0].text, space.name);
  const [code, copy, remove] = item.children[1].children;
  assert.equal(code.text, space.spaceId);
  assert.equal(copy.tagName, 'button');
  assert.equal(remove.tagName, 'button');
  assert.match(copy.attributes['aria-label'], /复制 Space ID/);
  assert.match(remove.attributes['aria-label'], /解绑/);
  assert.equal(copy.children[0].tagName, 'svg');
  assert.equal(remove.children[0].tagName, 'svg');
  await copy.listeners.click(); await remove.listeners.click();
  assert.deepEqual(copied, [space.spaceId]);
  assert.deepEqual(removed, [space.spaceId]);
});

test('project binding form separates project selection from Space modes and confirmation', async () => {
  const html = await readFile(new URL('../viewer/index.html', import.meta.url), 'utf8');
  const projects = html.slice(html.indexOf('<section id="projects"'), html.indexOf('<section id="sessions"'));
  assert.match(projects, /<form id="project-form">[\s\S]*class="project-selection"[\s\S]*name="agentType"[\s\S]*name="root"[\s\S]*id="project-directory"/);
  assert.ok(projects.indexOf('class="project-selection"') < projects.indexOf('role="tablist"'));
  assert.match(projects, /id="space-mode-create"[^>]*role="tab"[^>]*aria-selected="true"/);
  assert.match(projects, /id="space-mode-bind"[^>]*role="tab"[^>]*aria-selected="false"/);
  assert.match(projects, /id="project-space-panel" role="tabpanel" aria-labelledby="space-mode-create"/);
  assert.match(projects, /id="space-create-field"[\s\S]*name="spaceName"[^>]*required[^>]*disabled/);
  assert.match(projects, /id="space-bind-field" hidden[\s\S]*name="spaceId"[^>]*disabled/);
  assert.match(projects, /class="card binding-relations"[\s\S]*绑定关系[\s\S]*id="project-list"/);
  assert.match(projects, /<dialog id="space-create-dialog"[^>]*aria-labelledby="space-create-title"/);
  for (const id of ['space-confirm-name', 'space-confirm-agent', 'space-confirm-project', 'space-create-cancel', 'space-create-confirm'])
    assert.ok(projects.includes(`id="${id}"`), `confirmation must expose ${id}`);
});

test('trace details preserve full malicious-looking content as text', () => {
  const payload = { message: '<img src=x onerror="alert(1)">', tool: 'complete\n'.repeat(15000), nested: { secretLookingText: '<script>test</script>' } };
  const rendered = details('完整轨迹', payload) as Node;
  assert.equal(rendered.tagName, 'details');
  assert.equal(rendered.children[1].textContent, JSON.stringify(payload, null, 2));
  assert.ok(!rendered.children.some((child) => child.tagName === 'img' || child.tagName === 'script'));
});

test('session filters combine agent, directory, date and upload status without dropping unfiltered sessions', () => {
  const sessions = [{ id: 'a', agentType: 'codex', cwd: '/work/app', createdAt: '2026-11-17T10:00:00Z' }, { id: 'b', agentType: 'claude-code', cwd: '/work/other', createdAt: '2026-11-16T10:00:00Z' }];
  const batches = [{ sessionId: 'a', status: 'failed' }];
  assert.equal(filterSessions(sessions, {}, batches).length, 2);
  assert.deepEqual(filterSessions(sessions, { agent: 'codex', directory: '/work/app', from: '2026-11-17', to: '2026-11-17', status: 'failed' }, batches).map((s: any) => s.id), ['a']);
  assert.equal(filterSessions(sessions, { agent: 'codex', status: 'completed' }, batches).length, 0);
  assert.match(statusLabel('failed'), /失败/);
});

test('viewer exposes all planned management surfaces and key never appears in exported diagnostics', async () => {
  const html = await readFile(new URL('../viewer/index.html', import.meta.url), 'utf8');
  for (const id of ['overview', 'projects', 'sessions', 'agents', 'settings']) assert.ok(html.includes(`data-page="${id}"`));
  assert.match(html, /type="password"/);
  const source = await readFile(new URL('../viewer/app.js', import.meta.url), 'utf8');
  assert.ok(!source.includes('innerHTML'));
  assert.match(source, /JSON\.stringify\(state\.diagnostics/);
});


test('task trajectory shows complete task and reply text without database metadata', () => {
  const text = '<img src=x onerror="alert(1)">\n' + '完整内容\n'.repeat(15000);
  const [task] = taskTraceEntries({ message: { role: 'user', content: text }, raw: { secret: 'internal metadata' }, id: 'database-id' }, '12:00') as Node[];
  assert.match(task.text, /user/);
  assert.ok(task.text.includes(text));
  assert.ok(!task.text.includes('internal metadata'));
  assert.ok(!task.text.includes('database-id'));
  const [reply] = taskTraceEntries({ message: { role: 'assistant', content: [{ type: 'text', text: '任务已完成' }] } }, '12:01') as Node[];
  assert.match(reply.text, /answer/);
  assert.match(reply.text, /任务已完成/);
  assert.deepEqual(taskTraceEntries({ message: { role: 'system', content: 'runtime settings' } }, ''), []);
});

test('task trajectory keeps tool names, full arguments and results readable', () => {
  const entries = taskTraceEntries({ message: { role: 'assistant', content: '先检查目录', tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'shell', arguments: '{"command":"pwd"}' } }] } }, '12:00') as Node[];
  assert.equal(entries.length, 2);
  assert.match(entries[0].text, /answer.*先检查目录/);
  assert.match(entries[1].text, /tool use.*shell.*参数.*pwd/);
  const [result] = taskTraceEntries({ message: { role: 'tool', name: 'shell', tool_call_id: 'call-1', content: '/work/project\n' } }, '12:01') as Node[];
  assert.match(result.text, /tool result.*shell/);
  assert.ok(result.text.includes('/work/project\n'));
  assert.match(result.text, /call-1/);
});

test('content-block tool operations are execution entries rather than user tasks', () => {
  const [call] = taskTraceEntries({ message: { role: 'assistant', content: [{ type: 'tool_use', id: 'call-2', name: 'read_file', input: { path: 'README.md' } }] } }, '') as Node[];
  assert.match(call.text, /tool use.*read_file/);
  assert.match(call.text, /README.md/);
  const [result] = taskTraceEntries({ message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call-2', content: [{ type: 'text', text: 'file content' }] }] } }, '') as Node[];
  assert.match(result.text, /tool result/);
  assert.match(result.text, /file content/);
  assert.ok(!result.text.includes('user'));
});


test('turn list combines a full round into one compact button without exposing full replies', () => {
  const group = { id: 'turn-a', traces: [
    { message: { role: 'user', content: '检查项目' } },
    { message: { role: 'assistant', tool_calls: [{ function: { name: 'shell', arguments: 'pwd' } }] } },
    { message: { role: 'tool', content: '/work/project' } },
    { message: { role: 'assistant', content: '长回复'.repeat(300) } },
  ] };
  const card = taskTurnCard(group, 1, '12:00', () => {}) as Node;
  assert.equal(card.tagName, 'button');
  assert.match(card.text, /第 1 轮/);
  assert.match(card.text, /检查项目/);
  assert.match(card.text, /tool use 1 · tool result 1/);
  assert.ok(!card.text.includes('长回复'));
});

test('trajectory steps start folded with a concise preview and preserve full content', () => {
  const text = '任务已完成。'.repeat(300);
  const [step] = taskTraceEntries({ message: { role: 'assistant', content: text } }, '12:00') as Node[];
  assert.equal(step.tagName, 'details');
  assert.equal(step.children[0].tagName, 'summary');
  assert.equal((step as any).open, undefined);
  assert.ok(step.children[0].text.length < 160);
  assert.ok(step.text.includes(text));
});


test('reasoning and answer blocks stay separate, ordered, complete and folded', () => {
  const entries = taskTraceEntries({message:{role:'assistant',content:[
    {type:'reasoning',text:'思考一'}, {type:'text',text:'回答一'},
    {type:'thinking',thinking:'思考二'}, {type:'tool_use',id:'c1',name:'shell',input:{cmd:'pwd'}},
    {type:'text',text:'回答二'}
  ]}},'12:00') as Node[];
  assert.deepEqual(entries.map(e=>e.children[0].children[0].textContent),['thinking','answer','thinking','tool use','answer']);
  assert.ok(entries[0].text.includes('思考一'));
  assert.ok(!entries[0].text.includes('回答一'));
  assert.ok(entries[1].text.includes('回答一'));
  assert.ok(!entries[1].text.includes('思考一'));
  assert.ok(entries[2].text.includes('思考二'));
  assert.ok(entries.every(e=>e.tagName==='details' && !(e as any).open));
});

test('explicit reasoning fields and analysis channels render as thinking without guessing from prose', () => {
  const entries=taskTraceEntries({message:{role:'assistant',reasoning_content:'推理内容',content:'最终回答'}},'') as Node[];
  assert.deepEqual(entries.map(e=>e.children[0].children[0].textContent),['thinking','answer']);
  const [analysis]=taskTraceEntries({message:{role:'assistant',channel:'analysis',content:'分析过程'}},'') as Node[];
  assert.equal(analysis.children[0].children[0].textContent,'thinking');
  const [answer]=taskTraceEntries({message:{role:'assistant',content:'I am thinking about your question.'}},'') as Node[];
  assert.equal(answer.children[0].children[0].textContent,'answer');
  const [redacted]=taskTraceEntries({message:{role:'assistant',content:[{type:'redacted_thinking',data:'encrypted-secret'}]}},'') as Node[];
  assert.equal(redacted.children[0].children[0].textContent,'thinking');
  assert.ok(!redacted.text.includes('encrypted-secret'));
});

test('tool-role result blocks keep individual call IDs and readable outputs', () => {
  const entries=taskTraceEntries({message:{role:'tool',content:[
    {type:'tool_result',tool_use_id:'call-a',content:'结果甲'},
    {type:'tool_result',tool_use_id:'call-b',content:'结果乙',is_error:true}
  ]}},'') as Node[];
  assert.equal(entries.length,2);
  assert.match(entries[0].text,/tool result.*call-a.*结果甲/);
  assert.match(entries[1].text,/tool result.*call-b.*错误结果.*结果乙/);
});


test('trajectory project groups use explicit project IDs, chronological source time, and a separate unassigned group', () => {
  const projects = [{id:'p1',name:'同名项目',root:'/one'}, {id:'p2',name:'同名项目',root:'/two'}, {id:'empty',name:'空项目',root:'/empty'}];
  const sessions = [
    {id:'new',projectId:'p1',sourceStartedAt:'2026-11-18T12:00:00Z',createdAt:'2026-11-18T08:00:00Z',agentType:'codex-cli',turnCount:2},
    {id:'old',projectId:'p1',sourceStartedAt:'2026-11-18T09:00:00Z',createdAt:'2026-11-18T15:00:00Z',agentType:'claude-code',turnCount:3},
    {id:'other',taskId:'task2',sourceStartedAt:'2026-11-18T10:00:00Z',agentType:'codex-cli'},
    {id:'unassigned',projectId:null,taskId:'task2',sourceStartedAt:'2026-11-18T07:00:00Z',agentType:'codex-cli'},
    {id:'child',projectId:'p1',sourceKind:'subagent',sourceStartedAt:'2026-11-18T08:00:00Z'},
  ];
  const groups = projectSessionGroups({projects,sessions,tasks:[{id:'task2',projectId:'p2'}]});
  assert.deepEqual(groups.map((g:any)=>g.id),['p1','p2','empty',null]);
  assert.deepEqual(groups[0].sessions.map((s:any)=>s.id),['old','new']);
  assert.equal(groups[0].turnCount,5);
  assert.deepEqual(groups[1].sessions.map((s:any)=>s.id),['other']);
  assert.deepEqual(groups[3].sessions.map((s:any)=>s.id),['unassigned']);
});

test('source timestamps drive date filtering and explicit missing times do not masquerade as ingestion time', () => {
  const session = {id:'late-import',sourceStartedAt:'2026-11-10T09:00:00Z',createdAt:'2026-11-18T09:00:00Z'};
  assert.equal(sessionStartedAt(session),'2026-11-10T09:00:00Z');
  assert.equal(filterSessions([session],{from:'2026-11-10',to:'2026-11-10'},[]).length,1);
  assert.equal(sessionStartedAt({sourceStartedAt:null,createdAt:'2026-11-18'}),null);
  assert.equal(traceOccurredAt({occurredAt:null,createdAt:'2026-11-18'}),null);
  assert.equal(traceOccurredAt({createdAt:'legacy-time'}),'legacy-time');
  assert.equal(filterSessions([{sourceStartedAt:null,createdAt:'2026-11-18'}],{to:'2026-11-18'},[]).length,0);
});

test('trajectory navigation cards distinguish project paths and session titles without altering binding cards', async () => {
  const opened:unknown[]=[];
  const group={id:'p1',name:'同名项目',root:'/one',sessions:[{id:'s1'}],turnCount:3};
  const project=projectTraceCard(group,true,()=>opened.push('p1')) as Node;
  assert.match(project.text,/同名项目.*\/one.*1 个会话.*3 轮/);
  assert.equal(project.attributes['aria-current'],'true');
  const session=sessionTraceCard({id:'s1',title:'修复轨迹采集',agentType:'codex-cli',turnCount:3},true,'原始时间',()=>opened.push('s1')) as Node;
  assert.match(session.text,/修复轨迹采集.*codex-cli.*原始时间.*3 轮/);
  await project.listeners.click();await session.listeners.click();
  assert.deepEqual(opened,['p1','s1']);
});

test('complete round card exposes execution and capture states, while child events keep their agent identity', () => {
  const group={id:'round',executionStatus:'completed',captureStatus:'awaiting_children',traces:[{message:{role:'user',content:'检查'},agentPath:'/root'}]};
  const card=taskTurnCard(group,7,'原始开始时间',()=>{}) as Node;
  assert.match(card.text,/第 7 轮.*原始开始时间/);
  assert.match(card.text,/等待子任务/);
  const [child]=taskTraceEntries({agentPath:'/root/worker',originSessionId:'child',message:{role:'tool',content:'子任务结果'}},'09:01') as Node[];
  assert.match(child.children[0].text,/\/root\/worker/);
});


test('session source timestamps compare instants across timezone offsets', () => {
  const [group] = projectSessionGroups({projects:[{id:'p',name:'项目'}],sessions:[
    {id:'later',projectId:'p',sourceStartedAt:'2026-11-18T04:00:00Z'},
    {id:'earlier',projectId:'p',sourceStartedAt:'2026-11-18T09:00:00+08:00'},
  ]});
  assert.deepEqual(group.sessions.map((session:any)=>session.id),['earlier','later']);
});

test('history upload controls follow scan and per-Space delivery state for each Agent binding', async () => {
  const uploads: string[] = [], scans: string[] = [];
  const scopes = [
    { id: 'pending', history: { status: 'pending', pending: 0 } },
    { id: 'scanning', history: { status: 'scanning', pending: 0 } },
    { id: 'available', history: { status: 'ready', pending: 2 } },
    { id: 'complete', history: { status: 'ready', pending: 0, warning: '仅包含插件已采集会话，该 Agent 未提供本地历史读取接口' } },
    { id: 'new-space', history: { status: 'ready', pending: 1 } },
    { id: 'uploading', history: { status: 'ready', pending: 2, uploading: true } },
    { id: 'failed', history: { status: 'failed', error: '扫描失败', pending: 0 } },
  ].map(scope => ({ ...scope, name: '同一项目', agentType: 'codex-cli', spaceIds: ['space'] }));
  const table = projectBindingTable(scopes, [{ agentId: 'codex-cli', name: 'Codex CLI' }], () => {},
    (scope: any) => uploads.push(scope.id), (scope: any) => scans.push(scope.id)) as Node;
  const cells = table.children[1].children.map(row => row.children[3]);
  assert.equal(table.children[0].text, 'Agent项目名称已绑定 Space历史会话上传');
  assert.equal(cells[0].text, '--'); assert.equal(cells[1].text, '--');
  assert.equal(cells[2].children[0].text, '上传历史'); assert.equal((cells[2].children[0] as any).disabled, false);
  assert.equal((cells[3].children[0] as any).disabled, true);assert.match(cells[3].text,/仅包含插件已采集会话/);
  assert.equal((cells[4].children[0] as any).disabled, false);
  assert.equal(cells[5].text, '上传中…'); assert.equal((cells[5].children[0] as any).disabled, true);
  assert.equal(cells[6].text, '重试扫描');
  await cells[2].children[0].listeners.click(); await cells[4].children[0].listeners.click(); await cells[6].children[0].listeners.click();
  assert.deepEqual(uploads, ['available', 'new-space']); assert.deepEqual(scans, ['failed']);
});

test('history completion is visibly final while an empty catalog is not labelled uploaded', () => {
  const records = [
    { status: 'ready', pending: 0, recordCount: 2 },
    { status: 'ready', pending: 0 },
    { status: 'ready', pending: 0, recordCount: 0 },
    { status: 'ready', pending: 1, recordCount: 2 },
  ];
  const table = projectBindingTable(records.map((history, id) => ({ id: String(id), agentType: 'codex-cli', name: '项目', spaceIds: ['space'], history })), [], () => {}) as Node;
  const controls = table.children[1].children.map(row => row.children[3].children[0]);
  assert.deepEqual(controls.map(control => control.text), ['已上传历史', '已上传历史', '上传历史', '上传历史']);
  assert.deepEqual(controls.map(control => (control as any).disabled), [true, true, true, false]);
});

test('a ready history catalog can be rescanned explicitly without triggering upload', async () => {
  const scans: string[] = [], uploads: string[] = [];
  const table = projectBindingTable([{ id: 'scope', name: 'Project', agentType: 'codex-cli', spaceIds: ['A'],
    history: { status: 'ready', pending: 0, recordCount: 0 } }], [], () => {},
    (scope: any) => uploads.push(scope.id), (scope: any) => scans.push(scope.id)) as Node;
  const cell = table.children[1].children[0].children[3];
  const scan = cell.children.find(child => child.text === '扫描历史')!;
  await scan.listeners.click(); assert.deepEqual(scans, ['scope']); assert.deepEqual(uploads, []);
});

test('blocked history upload is disabled red with a visible reason instead of an uploading or successful state', async () => {
  const reasons = ['上传已暂停，请先恢复上传', '未配置 API Key', '云连接已变更', '目标 Space 上传失败：HTTP 500'];
  const records = reasons.map((uploadError, index) => ({ status: 'ready', pending: index === 0 ? 0 : 2, recordCount: 2, uploading: true, uploadError }));
  const table = projectBindingTable(records.map((history, id) => ({ id: String(id), agentType: 'codex-cli', name: '项目', spaceIds: ['space'], history })), [], () => {}) as Node;
  const cells = table.children[1].children.map(row => row.children[3]);
  for (const [index, cell] of cells.entries()) {
    const control = cell.children[0];
    assert.equal(control.text, '上传历史失败');assert.equal((control as any).disabled, true);
    assert.ok(control.className.includes('history-upload-failed'));
    assert.ok(cell.children.slice(1).some(child => child.text === reasons[index]), 'failure reason must be visible, not just a tooltip');
  }
  const stylesheet = await readFile(new URL('../viewer/style.css', import.meta.url), 'utf8');
  assert.match(stylesheet, /\.history-upload-failed:disabled\s*\{[^}]*color:#bd4c4c/);
});
