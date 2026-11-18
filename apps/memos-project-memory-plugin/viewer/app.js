import { el, details, filterSessions, statusLabel, sessionTitle, projectBindingTable, spaceBindingItem, projectSessionGroups, sessionStartedAt, traceOccurredAt, taskTurnInline, traceScopeGroups, traceScopeSessions } from './view.js';

const $ = (selector) => document.querySelector(selector);
let state = { projects: [], tasks: [], sessions: [], batches: [], recalls: [], diagnostics: [] };
let config = {}, adapters = [], page = 'overview', selectedSession = null, tracePage = 1;
let projectOptions = [], projectLoad = 0;
let selectedProject, sessionRequest = 0;
const traceProjectMemory = new Map();
let traceTime = 'all', traceDates = { from: '', to: '' };
let serviceError = '';
const pageInfo = {
  overview: '项目记忆概览',
  projects: '项目与空间',
  sessions: '会话轨迹',
  agents: 'Agent 接入',
  settings: '设置与诊断',
};
function notify(message, error = false) {
  const notice = $('#notice'); notice.textContent = message; notice.hidden = false; notice.className = error ? 'notice error' : 'notice';
}
async function api(path, body, method = 'POST') {
  const response = await fetch(path, body === undefined ? {} : { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error?.message ?? result.error ?? result.message ?? `请求失败：${response.status}`);
  return result;
}
async function action(button, callback) {
  button.disabled = true;
  try { await callback(); } catch (error) { notify(error.message, true); } finally { button.disabled = false; }
}
function clear(selector) { const target = $(selector); target.replaceChildren(); return target; }
function empty(target, message) { target.append(el('div', message, 'empty')); }
function badge(status, override) {
  const tone = ['failed', 'blocked', 'processing-failed', 'UNAVAILABLE', 'unavailable'].includes(status) ? ' error' : ['pending', 'waiting_space', 'uncertain', 'unverified', 'paused'].includes(status) ? ' warning' : '';
  return el('span', override ?? statusLabel(status), `badge${tone}`);
}
function button(text, callback, className = 'secondary') {
  const node = el('button', text, className); node.type = 'button'; node.addEventListener('click', () => action(node, callback)); return node;
}
function info(target, rows) {
  const list = el('dl', '', 'metadata');
  for (const [title, value] of rows) list.append(el('dt', title), el('dd', value == null || value === '' ? '—' : String(value)));
  target.append(list);
}
function formatDate(value) { return value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '—'; }
function showPage(name) {
  if (serviceError) { notify(serviceError, true); return; }
  if (name !== 'sessions') sessionRequest++;
  page = name;
  window.scrollTo({ top: 0 }); $('#notice').hidden = true;
  document.querySelectorAll('.page').forEach((node) => { node.hidden = node.id !== name; });
  document.querySelectorAll('.nav').forEach((node) => { node.classList.toggle('active', node.dataset.page === name); node.setAttribute('aria-current', node.dataset.page === name ? 'page' : 'false'); });
  $('#page-title').textContent = pageInfo[name];
  const resumeTrace = name === 'sessions' && selectedSession && $('#session-detail').textContent === '正在读取轮次…';
  renderPage();
  if (resumeTrace && selectedSession) void openSession(selectedSession, tracePage);
}
function renderPage() {
  if (page === 'overview') renderOverview();
  if (page === 'projects') renderProjects();
  if (page === 'sessions') renderSessions();
  if (page === 'agents') renderAgents();
  if (page === 'settings') renderSettings();
}
async function reload() {
  const health = await api('/api/health');
  if (health.apiVersion !== 3) {
    serviceError = '后台服务版本已过期，请重新打开 Viewer 更新服务。';
    throw new Error(serviceError);
  }
  const [nextState, nextConfig, nextAdapters] = await Promise.all([api('/api/state'), api('/api/config'), api('/api/adapters')]);
  serviceError = '';
  state = nextState; config = nextConfig; adapters = Array.isArray(nextAdapters) ? nextAdapters : nextAdapters.agents ?? nextAdapters.adapters ?? [];
  $('#connection').textContent = config.keyConfigured ? 'Key 已配置' : '待配置云连接'; $('#connection').className = config.keyConfigured ? 'badge' : 'badge warning';
  $('#updated-at').textContent = `更新于 ${new Date().toLocaleTimeString('zh-CN', { hour12: false })}`;
  renderPage();
}
function renderOverview() {
  const metrics = clear('#metrics');
  const pending = state.batches.filter((batch) => !batch.uploaded && !['failed', 'blocked'].includes(batch.status));
  const failed = state.batches.filter((batch) => ['failed', 'blocked', 'processing-failed'].includes(batch.status) || batch.processingStatus === 'failed');
  for (const [title, value] of [['本地项目', state.projects.length], ['采集会话', state.sessions.length], ['待上传批次', pending.length], ['需关注批次', failed.length]]) {
    const card = el('section', '', 'metric'); card.append(el('p', title), el('div', String(value), 'number')); metrics.append(card);
  }
  const recent = clear('#recent-sessions');
  for (const session of state.sessions.slice().sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))).slice(0, 5)) {
    const row = el('div', '', 'row'), label = el('div', '', 'row-main'); label.append(el('strong', session.agentType), el('small', session.cwd));
    row.append(label, button('查看 →', () => openSession(session.id), 'text-button')); recent.append(row);
  }
  if (!state.sessions.length) empty(recent, '暂无会话');
  const summary = clear('#sync-summary'); info(summary, [['服务地址', config.baseUrl], ['云连接', config.keyConfigured ? 'Key 已配置' : '未配置 API Key'], ['Agent 接入', `${adapters.filter((item) => item.installed).length} / ${adapters.length}`], ['上传状态', config.paused ? '已暂停' : '运行中'], ['已接收批次', state.batches.filter((batch) => batch.uploaded).length]]);
  $('#pause-overview').textContent = config.paused ? '恢复上传' : '暂停上传';
  renderDiagnostics('#overview-diagnostics', state.diagnostics.slice().sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))).slice(0, 5));
}
function renderProjects() {
  const select = $('#project-form select[name="agentType"]'), selected = select.value;
  select.replaceChildren();
  const placeholder = el('option', '选择 Agent'); placeholder.value = ''; select.append(placeholder);
  const agents = new Map(adapters.map(agent => [agent.agentId, agent.name]));
  for (const session of state.sessions) if (!agents.has(session.agentType)) agents.set(session.agentType, session.agentType);
  for (const [agentType, name] of agents) { const option = el('option', name); option.value = agentType; select.append(option); }
  select.value = selected;
  void loadProjectOptions().catch(error => notify(error.message, true));
  const list = clear('#project-list');
  if (state.projects.length) list.append(projectBindingTable(state.projects, adapters, openProjectSpaces));
  if (!state.projects.length) empty(list, '暂无项目');
}
function openProjectSpaces(project, trigger) {
  const dialog = el('dialog', '', 'trace-drawer space-drawer'), header = el('header', '', 'drawer-header');
  dialog.setAttribute('aria-labelledby', 'space-detail-title');
  const title = el('h2', project.name); title.id = 'space-detail-title';
  const body = el('div', '', 'drawer-body'), notice = el('p', '', 'notice'); notice.hidden = true; notice.setAttribute('role', 'status'); notice.setAttribute('aria-live', 'polite');
  header.append(title, button('关闭', () => dialog.close(), 'secondary')); dialog.append(header, body);
  let spaces = [], active = true;
  const showNotice = (message, error = false) => { notice.textContent = message; notice.hidden = false; notice.className = error ? 'notice error' : 'notice'; };
  const copySpace = async spaceId => {
    try { await navigator.clipboard.writeText(spaceId); showNotice('Space ID 已复制。'); }
    catch { showNotice('复制失败，请手动选择 Space ID 复制。', true); }
  };
  const unbindSpace = async spaceId => {
    try {
      await api('/api/bind', { objectId: project.id, spaceId }, 'DELETE');
      spaces = spaces.filter(space => space.spaceId !== spaceId);
      if (active) { renderSpaces(); showNotice('已解除该 Space 的绑定。'); }
      await reload();
      if (active) (body.querySelector('.space-icon-button') ?? header.querySelector('button')).focus();
    } catch (error) { if (active) showNotice(error.message, true); }
  };
  function renderSpaces() {
    body.replaceChildren(); body.append(notice);
    const group = el('details', '', 'space-binding-group'); group.open = true;
    group.append(el('summary', `已绑定 ${spaces.length} 个 Space`));
    if (spaces.length) {
      const list = el('ul', '', 'space-binding-list');
      for (const space of spaces) list.append(spaceBindingItem(space, copySpace, unbindSpace));
      group.append(list);
    } else group.append(el('p', '暂无绑定的 Space。', 'empty'));
    body.append(group);
  }
  body.append(el('p', '正在读取 Space 列表…', 'hint'));
  dialog.addEventListener('click', event => { if (event.target === dialog) dialog.close(); });
  dialog.addEventListener('close', () => {
    active = false; dialog.remove();
    const current = [...document.querySelectorAll('.space-list-open')].find(button => button.getAttribute('aria-label') === `查看 ${project.name} 的 Space 列表`);
    (trigger?.isConnected ? trigger : current)?.focus();
  }, { once: true });
  document.body.append(dialog); dialog.showModal();
  api(`/api/projects/${encodeURIComponent(project.id)}/spaces`).then(result => { if (active) { spaces = result; renderSpaces(); } }).catch(error => {
    if (active) { body.replaceChildren(notice); showNotice(error.message, true); }
  });
}
async function loadProjectOptions() {
  const form = $('#project-form'), agentType = form.elements.agentType.value, root = form.elements.root.value;
  const request = ++projectLoad;
  projectOptions = [];
  form.elements.spaceId.value = '';
  form.elements.root.replaceChildren(); form.elements.root.disabled = true;
  const placeholder = el('option', agentType ? '正在读取项目…' : '先选择 Agent'); placeholder.value = ''; form.elements.root.append(placeholder);
  updateProjectSelection();
  if (!agentType) return;
  try {
    const projects = await api(`/api/projects?agentType=${encodeURIComponent(agentType)}`);
    if (request !== projectLoad) return;
    projectOptions = projects;
    placeholder.textContent = projects.length ? '选择本地项目' : '未发现项目';
    for (const project of projects) {
      const option = el('option', `${project.name} · ${project.root}${project.spaceIds?.length ? '（已绑定）' : ''}`);
      option.value = project.root; form.elements.root.append(option);
    }
    form.elements.root.disabled = !projects.length;
    if (projects.some(project => project.root === root)) form.elements.root.value = root;
    updateProjectSelection();
  } catch (error) {
    if (request === projectLoad) { placeholder.textContent = '读取失败，请重新选择 Agent 或刷新'; updateProjectSelection(); throw error; }
  }
}
function updateProjectSelection() {
  const form = $('#project-form'), project = projectOptions.find(project => project.root === form.elements.root.value);
  const blocked = project && ['creating', 'uncertain'].includes(project.bindingStatus);
  form.elements.spaceId.disabled = !project || !!blocked;
  form.querySelector('button[type="submit"]').disabled = !project || !!blocked;
  form.querySelector('button[type="submit"]').textContent = '绑定 Space';
  const notice = $('#project-directory');
  notice.hidden = !blocked;
  notice.textContent = blocked ? '空间创建结果尚待确认，暂不可绑定。' : '';
}
function traceDate(value) { return value ? formatDate(value) : '原始时间缺失'; }
function traceAgent() { return $('#session-filters select[name="agent"]').value; }
function agentName(id) { return adapters.find(agent => agent.agentId === id || agent.id === id)?.name ?? id; }
function traceGroups() { return traceScopeGroups(state, traceAgent()); }
function traceFilter() { return { project: selectedProject, query: $('#trace-search').value, ...traceDates }; }
function renderTraceBreadcrumb(session) {
  const breadcrumb = clear('#trace-breadcrumb');
  breadcrumb.append(el('span', '会话轨迹'));
  if (!session) return;
  const group = projectSessionGroups(state).find(group => group.sessions.some(item => item.id === session.id));
  breadcrumb.append(el('span', '/', 'hint'), el('span', agentName(session.agentType)), el('span', '/', 'hint'), el('span', group?.name ?? '未归属项目'));
}
function clearSelectedSession(message = '此范围暂无符合条件的会话') {
  selectedSession = null; tracePage = 1; sessionRequest++;
  const detail = clear('#session-detail'); detail.className = 'empty'; detail.append(el('p', message));
  detail.append(button('清除时间和搜索条件', () => { traceTime = 'all'; traceDates = { from: '', to: '' }; $('#trace-time').value = 'all'; $('#trace-search').value = ''; $('#trace-date-range').hidden = true; renderSessions(); }, 'text-button'));
  renderTraceBreadcrumb();
}
function renderTraceProjects() {
  const groups = traceGroups(), chosen = groups.find(group => group.id === selectedProject);
  $('#trace-project-label').textContent = chosen?.name ?? '全部项目';
  $('#trace-project-label').title = chosen?.root || chosen?.name || '当前 Agent 的全部项目';
  const options = clear('#trace-project-options'), query = $('#trace-project-search').value.trim().toLocaleLowerCase();
  const add = (id, name, root, count) => {
    const item = button('', () => {
      selectedProject = id; traceProjectMemory.set(traceAgent(), id); $('#trace-project-picker').open = false;
      clearSelectedSession(); renderSessions();
    }, `trace-project-option${selectedProject === id ? ' selected' : ''}`);
    item.setAttribute('aria-pressed', String(selectedProject === id));
    const heading = el('span', '', 'trace-project-option-title'); heading.append(el('strong', name), el('small', `${count} 个会话`)); item.append(heading);
    if (root) item.append(el('small', root)); options.append(item);
  };
  add(undefined, '全部项目', '', groups.reduce((count, group) => count + group.sessions.length, 0));
  const matches = groups.filter(group => `${group.name} ${group.root}`.toLocaleLowerCase().includes(query));
  for (const group of matches) add(group.id, group.name, group.root || '尚未关联到已登记项目', group.sessions.length);
  if (query && !matches.length) empty(options, '未找到匹配的项目');
}
function renderSessions(load = true) {
  const select = $('#session-filters select[name="agent"]'), selectedAgent = select.value;
  const agents = [...new Set(traceScopeGroups(state).flatMap(group => group.sessions.map(session => session.agentType)))].sort();
  select.replaceChildren(); const all = el('option', '全部 Agent'); all.value = ''; select.append(all);
  for (const agent of agents) { const option = el('option', agentName(agent)); option.value = agent; select.append(option); }
  select.value = agents.includes(selectedAgent) ? selectedAgent : '';
  const groups = traceGroups();
  if (selectedProject !== undefined && !groups.some(group => group.id === selectedProject)) { selectedProject = undefined; clearSelectedSession(); }
  renderTraceProjects();
  const sessions = traceScopeSessions(groups, traceFilter()), list = clear('#session-list');
  $('#trace-session-count').textContent = `${sessions.length} 个会话`;
  $('#trace-list-scope').textContent = `${traceAgent() ? agentName(traceAgent()) : '全部 Agent'} / ${groups.find(group => group.id === selectedProject)?.name ?? '全部项目'}`;
  for (const session of sessions) {
    const row = button('', () => openSession(session.id), `trace-session-row${selectedSession === session.id ? ' selected' : ''}`);
    row.setAttribute('aria-current', String(selectedSession === session.id));
    row.append(el('strong', sessionTitle(session)));
    const group = groups.find(group => group.sessions.some(item => item.id === session.id));
    const sources = [!traceAgent() ? agentName(session.agentType) : '', selectedProject === undefined ? group?.name : ''].filter(Boolean);
    if (sources.length) row.append(el('small', sources.join(' · '), 'trace-session-source'));
    const meta = el('small', '', 'trace-session-meta'); meta.append(el('span', `${Number(session.turnCount) || 0} 轮`), el('span', traceDate(sessionStartedAt(session)))); row.append(meta); list.append(row);
  }
  if (!sessions.length) { empty(list, '没有匹配的会话'); clearSelectedSession(); return; }
  if (!sessions.some(session => session.id === selectedSession)) {
    clearSelectedSession();
    if (load) void openSession(sessions[0].id);
  } else renderTraceBreadcrumb(sessions.find(session => session.id === selectedSession));
}
async function openSession(id, pageNumber = 1) {
  const project = projectSessionGroups(state).find(group => group.sessions.some(session => session.id === id));
  if (!project) { clearSelectedSession('该会话已不可用'); return; }
  const session = project.sessions.find(item => item.id === id);
  if (page !== 'sessions') {
    $('#session-filters select[name="agent"]').replaceChildren();
    const option = el('option', agentName(session.agentType)); option.value = session.agentType; $('#session-filters select[name="agent"]').append(option);
    selectedProject = project.id; traceProjectMemory.set(session.agentType, project.id);
    traceTime = 'all'; traceDates = { from: '', to: '' }; $('#trace-time').value = 'all'; $('#trace-search').value = ''; $('#trace-date-range').hidden = true;
    selectedSession = id; showPage('sessions');
  }
  selectedSession = id; tracePage = pageNumber;
  renderSessions(false);
  if (selectedSession !== id) return;
  const request = ++sessionRequest;
  const target = clear('#session-detail'); target.className = 'empty'; target.textContent = '正在读取轮次…';
  try {
    const detail = await api(`/api/sessions/${encodeURIComponent(id)}?page=${pageNumber}&size=10&unit=turn`);
    if (request !== sessionRequest || selectedSession !== id || tracePage !== pageNumber || page !== 'sessions') return;
    renderSessionDetail(detail);
  } catch (error) {
    if (request === sessionRequest && selectedSession === id && page === 'sessions') {
      target.textContent = '读取失败，请刷新重试'; notify(error.message, true);
    }
  }
}
function renderSessionDetail(detail) {
  const target = clear('#session-detail'); target.className = 'trace-reading';
  const session = { ...detail.session };
  const local = state.sessions.find(item => item.id === session.id);
  if (local) {
    local.title = session.title;
    if (Number.isFinite(detail.total)) local.turnCount = detail.total;
    renderSessions(false);
  }
  renderTraceBreadcrumb(session);
  const header = el('div', '', 'trace-reading-heading'), heading = el('div');
  heading.append(el('h2', sessionTitle(session)), el('p', `${agentName(session.agentType)} · ${traceDate(sessionStartedAt(session))} · ${detail.total ?? 0} 轮`, 'hint'));
  const metadata = el('details', '', 'trace-session-info'); metadata.append(el('summary', '会话信息 ⓘ'));
  info(metadata, [['宿主会话 ID', session.nativeSessionId], ['目录', session.cwd], ['原始开始时间', traceDate(sessionStartedAt(session))]]);
  header.append(heading, metadata); target.append(header);
  const toolbar = el('div', '', 'trace-reading-toolbar');
  const expand = button('展开全部执行过程', () => {
    const items = [...target.querySelectorAll('.trace-execution')], open = items.some(item => !item.open);
    for (const item of items) item.open = open;
    expand.textContent = open ? '收起全部执行过程' : '展开全部执行过程';
  }, 'text-button'); toolbar.append(el('span', '对话记录'), expand); target.append(toolbar);
  const total = detail.total ?? 0, size = detail.size ?? 10, current = detail.page ?? tracePage, pages = Math.max(1, Math.ceil(total / size));
  for (const [index, group] of (detail.groups ?? []).entries()) {
    const number = group.roundNumber ?? ((current - 1) * size + index + 1);
    const startedAt = Object.hasOwn(group, 'startedAt') ? group.startedAt : traceOccurredAt(group.traces[0] ?? {});
    target.append(taskTurnInline(group, number, traceDate(startedAt)));
  }
  const syncExpansion = () => { const items = [...target.querySelectorAll('.trace-execution')]; expand.textContent = items.length && items.every(item => item.open) ? '收起全部执行过程' : '展开全部执行过程'; };
  for (const item of target.querySelectorAll('.trace-execution')) item.addEventListener('toggle', syncExpansion);
  expand.hidden = !target.querySelector('.trace-execution');
  if (!detail.groups?.length) empty(target, '此会话暂无可展示轮次。');
  if (pages > 1) {
    const pager = el('div', '', 'pagination'), previous = button('← 上一页', () => openSession(selectedSession, current - 1)), next = button('下一页 →', () => openSession(selectedSession, current + 1));
    previous.disabled = current <= 1; next.disabled = current >= pages;
    pager.append(previous, el('span', `第 ${current} / ${pages} 页 · ${total} 轮`), next); target.append(pager);
  } else if (total) target.append(el('p', '已显示全部轮次', 'trace-end'));
}

function renderAgents() {
  const list = clear('#agent-list');
  for (const agent of adapters) {
    const card = el('section', '', 'card'), heading = el('div', '', 'agent-title'); heading.append(el('h2', agent.name ?? agent.id), badge(agent.installed ? 'installed' : 'unverified', agent.installed ? '已适配' : '未适配')); card.append(heading);
    info(card, [['宿主检测', agent.detected ? '已检测到' : '未检测到'], ['探测版本', agent.version], ['适配版本', Array.isArray(agent.versions) ? agent.versions.join('、') : JSON.stringify(agent.versions ?? null)], ['兼容核对', agent.support === 'version-matched' ? '版本匹配' : agent.support === 'not-detected' ? '未检测到宿主' : '待核实']]);
    if (agent.limitations?.length) {
      const notes = el('details', '', 'detail'), items = el('ul', '', 'agent-notes');
      for (const text of agent.limitations) items.append(el('li', text));
      notes.append(el('summary', '使用提示'), items); card.append(notes);
    }
    const controls = el('div', '', 'actions');
    for (const [label, operation] of agent.installed ? [['修复接入', 'repair'], ['卸载 MemOS 接入', 'uninstall']] : [['安装 MemOS 接入', 'install']]) {
      controls.append(button(label, async () => { const result = await api(`/api/adapters/${encodeURIComponent(agent.id)}/${operation}`, {}); notify(`${agent.name ?? agent.id}：${label}完成。${result.instructions?.length ? result.instructions.join(' ') : result.message ?? '请重新启动 Agent 或重新加载接入配置。'}`); await reload(); }, operation === 'uninstall' ? 'secondary' : ''));
    }
    card.append(controls); list.append(card);
  }
  if (!adapters.length) empty(list, '未加载 Agent 配置');
}
function renderSettings() {
  const form = $('#config-form'); form.elements.baseUrl.value = config.baseUrl ?? ''; form.elements.userId.value = config.userId ?? '';
  $('#key-status').textContent = config.keyConfigured ? 'Key 已配置' : '未配置 Key';
  const runtime = clear('#runtime-state'); info(runtime, [['本地服务', '连接正常'], ['上传状态', config.paused ? '已暂停' : '运行中'], ['失败批次', state.batches.filter((batch) => batch.status === 'failed').length]]);
  $('#pause-settings').textContent = config.paused ? '恢复上传' : '暂停上传'; renderDiagnostics('#diagnostics', state.diagnostics);
}
function renderDiagnostics(selector, records) {
  const target = clear(selector);
  for (const record of records.slice().sort((a, b) => String(b.createdAt ?? b.time).localeCompare(String(a.createdAt ?? a.time)))) target.append(details(`${formatDate(record.createdAt ?? record.time)} · ${record.message ?? record.kind ?? '诊断事件'}`, record));
  if (!records.length) empty(target, '暂无诊断事件。');
}
async function toggleUpload() { await api('/api/config', { paused: !config.paused }, 'PUT'); await reload(); notify(config.paused ? '上传已暂停。采集继续保留在本地。' : '上传已恢复。已停止重试的批次仍保留原状态。'); }

document.querySelectorAll('[data-page]').forEach((node) => node.addEventListener('click', () => showPage(node.dataset.page)));
$('#refresh').addEventListener('click', (event) => action(event.currentTarget, async () => { await reload(); if (page === 'sessions' && selectedSession) await openSession(selectedSession, tracePage); }));
for (const selector of ['#pause-overview', '#pause-settings']) $(selector).addEventListener('click', (event) => action(event.currentTarget, toggleUpload));
$('#sync-now').addEventListener('click', (event) => action(event.currentTarget, async () => { await api('/api/sync', {}); await reload(); notify('待上传批次同步已执行。'); }));
$('#project-form select[name="agentType"]').addEventListener('change', () => { void loadProjectOptions().catch(error => notify(error.message, true)); });
$('#project-form select[name="root"]').addEventListener('change', () => { $('#project-form').elements.spaceId.value = ''; updateProjectSelection(); });
$('#project-form').addEventListener('submit', async (event) => {
  event.preventDefault(); const form = event.currentTarget;
  await action(form.querySelector('button[type="submit"]'), async () => {
    const project = projectOptions.find(project => project.root === form.elements.root.value);
    if (!project) throw new Error('请选择本地项目');
    await api('/api/projects', { name: project.name, root: project.root, spaceId: form.elements.spaceId.value.trim(), agentType: form.elements.agentType.value });
    await reload(); notify('项目与 Space 已绑定并保存到本地。');
  });
  updateProjectSelection();
});
$('#session-filters').addEventListener('submit', event => { event.preventDefault(); });
$('#session-filters select[name="agent"]').addEventListener('change', () => {
  selectedProject = traceProjectMemory.get(traceAgent()); $('#trace-project-search').value = ''; $('#trace-project-picker').open = false;
  clearSelectedSession(); renderSessions();
});
$('#trace-project-search').addEventListener('input', renderTraceProjects);
$('#trace-search').addEventListener('input', () => { renderSessions(); });
function localDay(date) { return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`; }
$('#trace-time').addEventListener('change', () => {
  const value = $('#trace-time').value;
  $('#trace-date-range').hidden = value !== 'custom';
  if (value === 'custom') { $('#session-filters').elements.from.value = traceDates.from; $('#session-filters').elements.to.value = traceDates.to; return; }
  traceTime = value; const today = new Date(), start = new Date(today); if (value === 'week') start.setDate(start.getDate() - 6);
  traceDates = value === 'all' ? { from: '', to: '' } : { from: localDay(start), to: localDay(today) }; clearSelectedSession(); renderSessions();
});
$('#trace-date-apply').addEventListener('click', () => {
  const form = $('#session-filters'), from = form.elements.from.value, to = form.elements.to.value;
  if (!from || !to || from > to) { $('#trace-date-error').textContent = '请选择有效的起止日期'; return; }
  $('#trace-date-error').textContent = ''; traceTime = 'custom'; traceDates = { from, to }; $('#trace-date-range').hidden = true;
  $('#trace-time option[value="custom"]').textContent = `${from} 至 ${to}`; clearSelectedSession(); renderSessions();
});
$('#trace-date-cancel').addEventListener('click', () => { $('#trace-time').value = traceTime; $('#trace-date-range').hidden = true; $('#trace-date-error').textContent = ''; });
document.addEventListener('click', event => { if (!$('#trace-project-picker').contains(event.target)) $('#trace-project-picker').open = false; });
document.addEventListener('keydown', event => { if (event.key === 'Escape') { $('#trace-project-picker').open = false; $('#trace-date-cancel').click(); } });
$('#config-form').addEventListener('submit', (event) => {
  event.preventDefault(); const form = event.currentTarget;
  action(form.querySelector('button'), async () => {
    const body = { baseUrl: form.elements.baseUrl.value.trim() }; if (form.elements.apiKey.value) body.apiKey = form.elements.apiKey.value;
    await api('/api/config', body, 'PUT'); form.elements.apiKey.value = ''; await reload(); notify('连接配置已保存。实际连通性以云端请求结果为准。');
  });
});
$('#export-diagnostics').addEventListener('click', () => {
  const blob = new Blob([JSON.stringify(state.diagnostics, null, 2)], { type: 'application/json' }), url = URL.createObjectURL(blob), link = el('a');
  link.href = url; link.download = 'memos-project-memory-diagnostics.json'; link.click(); URL.revokeObjectURL(url);
});
reload().catch((error) => { $('#connection').textContent = serviceError ? '后台服务需更新' : '本地服务连接失败'; $('#connection').className = 'badge error'; notify(error.message, true); });
