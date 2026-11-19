import { el, details, filterSessions, statusLabel, sessionTitle, projectBindingTable, spaceBindingItem, projectSessionGroups, sessionStartedAt, traceOccurredAt, taskTurnInline, traceScopeGroups, traceScopeSessions } from './view.js';

const $ = (selector) => document.querySelector(selector);
let state = { bindings: [], projects: [], tasks: [], sessions: [], batches: [], recalls: [], diagnostics: [] };
let config = {}, adapters = [], page = 'overview', selectedSession = null, tracePage = 1;
let projectOptions = [], projectLoad = 0, projectPoll;
const projectCache = new Map(), projectSelections = new Map(), projectRequests = new Map();
let projectAgent = '';
let projectSpaceMode = 'create', projectSaving = false, pendingProjectBinding;
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
  if (!response.ok) {
    const error = new Error(result.error?.message ?? result.error ?? result.message ?? `请求失败：${response.status}`);
    if (typeof result.spaceId === 'string') error.spaceId = result.spaceId;
    throw error;
  }
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
  if (projectPoll) { clearTimeout(projectPoll); projectPoll = undefined; }
  window.scrollTo({ top: 0 }); $('#notice').hidden = true;
  document.querySelectorAll('.page').forEach((node) => { node.hidden = node.id !== name; });
  document.querySelectorAll('.nav').forEach((node) => { node.classList.toggle('active', node.dataset.page === name); node.setAttribute('aria-current', node.dataset.page === name ? 'page' : 'false'); });
  $('#page-title').textContent = pageInfo[name];
  const resumeTrace = name === 'sessions' && selectedSession && $('#session-detail').textContent === '正在读取轮次…';
  renderPage()?.catch(error => notify(error.message, true));
  if (resumeTrace && selectedSession) void openSession(selectedSession, tracePage);
}
function renderPage() {
  if (page === 'overview') renderOverview();
  if (page === 'projects') return renderProjects();
  if (page === 'sessions') renderSessions();
  if (page === 'agents') return renderAgents();
  if (page === 'settings') renderSettings();
}
async function reload() {
  const health = await api('/api/health');
  if (health.apiVersion !== 5) {
    serviceError = '后台服务版本已过期，请重新打开 Viewer 更新服务。';
    throw new Error(serviceError);
  }
  const [nextState, nextConfig, nextAdapters] = await Promise.all([
    page === 'projects' ? api('/api/bind').then(bindings => ({ ...state, bindings })) : api('/api/state'),
    api('/api/config'), api('/api/adapters/installed'),
  ]);
  serviceError = '';
  state = nextState; config = nextConfig; adapters = Array.isArray(nextAdapters) ? nextAdapters : nextAdapters.agents ?? nextAdapters.adapters ?? [];
  $('#connection').textContent = config.keyConfigured ? 'Key 已配置' : '待配置云连接'; $('#connection').className = config.keyConfigured ? 'badge' : 'badge warning';
  await renderPage();
  $('#updated-at').textContent = `更新于 ${new Date().toLocaleTimeString('zh-CN', { hour12: false })}`;
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
  const summary = clear('#sync-summary'); info(summary, [['服务地址', config.baseUrl], ['云连接', config.keyConfigured ? 'Key 已配置' : '未配置 API Key'], ['Agent 接入', `已接入 ${adapters.filter((item) => item.installed).length} 个`], ['上传状态', config.paused ? '已暂停' : '运行中'], ['已接收批次', state.batches.filter((batch) => batch.uploaded).length]]);
  $('#pause-overview').textContent = config.paused ? '恢复上传' : '暂停上传';
  renderDiagnostics('#overview-diagnostics', state.diagnostics.slice().sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))).slice(0, 5));
}
function renderProjects() {
  const select = $('#project-form select[name="agentType"]'), selected = select.value;
  select.replaceChildren();
  const placeholder = el('option', '选择 Agent'); placeholder.value = ''; select.append(placeholder);
  const agents = new Map(adapters.filter(agent => agent.installed).map(agent => [agent.agentId, agent.name]));
  for (const [agentType, name] of agents) { const option = el('option', name); option.value = agentType; select.append(option); }
  select.value = agents.has(selected) ? selected : '';
  const loading = loadProjectOptions().catch(error => notify(error.message, true));
  renderBindings();
  pollProjects();
  return loading;
}
function renderBindings() {
  const list = clear('#project-list'), bindings = state.bindings ?? [];
  $('#binding-count').textContent = bindings.length;
  if (bindings.length) list.append(projectBindingTable(bindings, adapters, openProjectSpaces,
    (scope, trigger) => changeHistory(scope, trigger, false), (scope, trigger) => changeHistory(scope, trigger, true)));
  else empty(list, '暂无绑定关系');
}
function pollProjects() {
  if (projectPoll) clearTimeout(projectPoll);
  projectPoll = undefined;
  if (page !== 'projects' || !(state.bindings ?? []).some(scope => scope.history?.uploading || ['pending', 'scanning'].includes(scope.history?.status))) return;
  projectPoll = setTimeout(async () => {
    projectPoll = undefined;
    try {
      const bindings = await api('/api/bind');
      if (page !== 'projects') return;
      state = { ...state, bindings }; renderBindings();
    } catch (error) { if (page === 'projects') notify(error.message, true); }
    pollProjects();
  }, 2000);
}
async function changeHistory(scope, trigger, scan) {
  await action(trigger, async () => {
    trigger.textContent = scan ? '扫描中…' : '上传中…';
    scope.history = { ...scope.history, ...(scan ? { status: 'scanning' } : { uploading: true }) };
    pollProjects();
    let failure;
    try { await api(`/api/projects/${encodeURIComponent(scope.id)}/history${scan ? '/scan' : ''}`, {}); }
    catch (error) { failure = error.message; }
    try { state = { ...state, bindings: await api('/api/bind') }; }
    catch (error) { failure ??= error.message; }
    const current = state.bindings?.find(item => item.id === scope.id) ?? scope;
    if (failure) current.history = { ...current.history, uploading: false,
      ...(scan ? { status: 'failed', error: failure } : { uploadError: failure }) };
    failure ??= scan ? current.history?.error : current.history?.uploadError;
    notify(failure ?? (scan ? '历史会话扫描已执行。' : '历史上传已提交，仅处理尚未上传的 Space。'), !!failure);
    if (page === 'projects') renderBindings();
    pollProjects();
  });
}
function openProjectSpaces(project, trigger) {
  const dialog = el('dialog', '', 'trace-drawer space-drawer'), header = el('header', '', 'drawer-header');
  dialog.setAttribute('aria-labelledby', 'space-detail-title');
  const title = el('h2', `${agentName(project.agentType)} · ${project.name}`); title.id = 'space-detail-title';
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
    const current = [...document.querySelectorAll('.space-list-open')].find(button => button.getAttribute('data-scope-id') === project.id);
    (trigger?.isConnected ? trigger : current)?.focus();
  }, { once: true });
  document.body.append(dialog); dialog.showModal();
  api(`/api/projects/${encodeURIComponent(project.id)}/spaces`).then(result => { if (active) { spaces = result; renderSpaces(); } }).catch(error => {
    if (active) { body.replaceChildren(notice); showNotice(error.message, true); }
  });
}
function displayProjectOptions(agentType, projects) {
  const form = $('#project-form'), root = projectSelections.get(agentType);
  const bindings = (state.bindings ?? []).filter(scope => scope.agentType === agentType);
  projectOptions = projects.map(project => {
    const binding = bindings.find(scope => scope.root === project.root);
    return binding ? { ...project, name: binding.name, spaceIds: binding.spaceIds, bindingStatus: binding.spaceIds.length ? 'bound' : 'unbound' } : project;
  });
  const options = [el('option', !agentType ? '先选择 Agent' : projects.length ? '选择本地项目' : projectCache.has(agentType) ? '未发现项目' : '正在读取项目…')];
  options[0].value = '';
  for (const project of projectOptions) {
    const option = el('option', `${project.name} · ${project.root}${project.spaceIds?.length ? '（已绑定）' : ''}`);
    option.value = project.root; options.push(option);
  }
  const select = form.elements.root;
  // An ordinary redraw must not clear the list or interrupt the current selection.
  if (select.children.length !== options.length || options.some((option, index) => option.value !== select.children[index]?.value || option.textContent !== select.children[index]?.textContent))
    select.replaceChildren(...options);
  select.disabled = !projectOptions.length;
  select.value = projectOptions.some(project => project.root === root) ? root : '';
  updateProjectSelection();
}
async function loadProjectOptions(refresh = false) {
  const form = $('#project-form'), agentType = form.elements.agentType.value;
  if (projectAgent) projectSelections.set(projectAgent, form.elements.root.value);
  if (agentType !== projectAgent) { form.elements.spaceId.value = ''; form.elements.spaceName.value = ''; }
  projectAgent = agentType;
  const request = ++projectLoad;
  displayProjectOptions(agentType, projectCache.get(agentType) ?? []);
  if (!agentType || (!refresh && projectCache.has(agentType))) return;
  try {
    let loading = projectRequests.get(agentType);
    if (!loading) {
      loading = api(`/api/projects?agentType=${encodeURIComponent(agentType)}${refresh ? '&refresh=1' : ''}`)
        .then(projects => { projectCache.set(agentType, projects); return projects; })
        .finally(() => projectRequests.delete(agentType));
      projectRequests.set(agentType, loading);
    }
    const projects = await loading;
    if (request !== projectLoad || form.elements.agentType.value !== agentType) return;
    projectSelections.set(agentType, form.elements.root.value || projectSelections.get(agentType));
    displayProjectOptions(agentType, projects);
  } catch (error) {
    if (request === projectLoad) {
      if (!projectCache.has(agentType)) form.elements.root.children[0].textContent = '读取失败，请重新选择 Agent 或刷新';
      throw error;
    }
  }
}
function setProjectSpaceMode(mode) {
  if (projectSaving) return;
  projectSpaceMode = mode;
  const create = mode === 'create';
  $('#space-create-field').hidden = !create;
  $('#space-bind-field').hidden = create;
  for (const [id, active] of [['#space-mode-create', create], ['#space-mode-bind', !create]]) {
    $(id).setAttribute('aria-selected', String(active));
    $(id).tabIndex = active ? 0 : -1;
  }
  $('#project-space-panel').setAttribute('aria-labelledby', create ? 'space-mode-create' : 'space-mode-bind');
  updateProjectSelection();
}
function updateProjectSelection() {
  const form = $('#project-form'), project = projectOptions.find(project => project.root === form.elements.root.value);
  const blocked = project && ['creating', 'uncertain'].includes(project.bindingStatus);
  const create = projectSpaceMode === 'create';
  form.elements.agentType.disabled = projectSaving;
  form.elements.root.disabled = projectSaving || !projectOptions.length;
  form.elements.spaceName.disabled = projectSaving || !project || !!blocked || !create;
  form.elements.spaceId.disabled = projectSaving || !project || !!blocked || create;
  form.elements.spaceName.required = create;
  form.elements.spaceId.required = !create;
  for (const id of ['#space-mode-create', '#space-mode-bind']) $(id).disabled = projectSaving;
  const value = create ? form.elements.spaceName.value : form.elements.spaceId.value;
  form.querySelector('button[type="submit"]').disabled = projectSaving || !project || !!blocked || !value.trim();
  $('#project-submit-label').textContent = projectSaving ? create ? '正在创建…' : '正在绑定…' : create ? '新建并绑定' : '绑定 Space';
  $('#project-space-help').textContent = blocked ? '空间创建结果尚待确认，暂不可绑定。' : create
    ? '创建后自动绑定到所选 Agent 与项目，无需手动填写 Space ID。'
    : '绑定已有空间后，新采集的项目记忆将上传至该 Space。';
  $('#project-directory').hidden = !project;
  $('#project-directory').textContent = project?.root ?? '';
  $('#project-target-agent').textContent = agentName(form.elements.agentType.value) || '所选 Agent';
}
async function saveProjectBinding(input) {
  if (projectSaving) return;
  projectSaving = true;
  updateProjectSelection();
  const dialog = $('#space-create-dialog');
  $('#space-create-confirm').disabled = true;
  $('#space-create-cancel').disabled = true;
  $('#space-create-confirm').textContent = '正在创建…';
  try {
    await api('/api/projects', input);
    // Creation is already committed; a failed refresh must not offer to create again.
    if (dialog.open) dialog.close();
    const form = $('#project-form');
    if (input.spaceName !== undefined) form.elements.spaceName.value = '';
    else form.elements.spaceId.value = '';
    await reload().catch(error => { throw new Error(`Space 已绑定并保存到本地，但刷新失败：${error.message}，请点击刷新查看。`); });
    notify(input.spaceName !== undefined ? 'Space 已创建并绑定，已保存到本地。' : '项目与 Space 已绑定并保存到本地。');
  } catch (error) {
    if (dialog.open) dialog.close();
    if (error.spaceId) {
      projectSaving = false;
      $('#project-form').elements.spaceId.value = error.spaceId;
      setProjectSpaceMode('bind');
      notify(`Space 已创建，但未完成绑定：${error.message}。已保留 Space ID：${error.spaceId}，请核对云连接后使用“绑定 Space”，不要重复创建。`, true);
    } else notify(error.message, true);
  } finally {
    projectSaving = false;
    pendingProjectBinding = undefined;
    $('#space-create-confirm').disabled = false;
    $('#space-create-cancel').disabled = false;
    $('#space-create-confirm').textContent = '确认新建并绑定';
    updateProjectSelection();
    const form = $('#project-form'), submit = form.querySelector('button[type="submit"]');
    (submit.disabled ? form.elements[projectSpaceMode === 'create' ? 'spaceName' : 'spaceId'] : submit).focus();
  }
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

async function renderAgents() {
  adapters = await api('/api/adapters');
  if (page !== 'agents') return;
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
    for (const [label, operation] of agent.installed ? [['更新接入配置', 'repair'], ['卸载 MemOS 接入', 'uninstall']] : [['安装 MemOS 接入', 'install']]) {
      controls.append(button(label, async () => { const result = await api(`/api/adapters/${encodeURIComponent(agent.id)}/${operation}`, {}); notify(`${agent.name ?? agent.id}：${label}完成。${result.instructions?.length ? result.instructions.join(' ') : result.message ?? '请重新启动 Agent 或重新加载接入配置。'}`); await reload(); }, operation === 'install' ? '' : 'secondary'));
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
$('#refresh').addEventListener('click', (event) => action(event.currentTarget, async () => { if (page === 'projects') await loadProjectOptions(true); await reload(); if (page === 'sessions' && selectedSession) await openSession(selectedSession, tracePage); }));
for (const selector of ['#pause-overview', '#pause-settings']) $(selector).addEventListener('click', (event) => action(event.currentTarget, toggleUpload));
$('#sync-now').addEventListener('click', (event) => action(event.currentTarget, async () => { await api('/api/sync', {}); await reload(); notify('待上传批次同步已执行。'); }));
$('#project-form select[name="agentType"]').addEventListener('change', () => { void loadProjectOptions().catch(error => notify(error.message, true)); });
$('#project-form select[name="root"]').addEventListener('change', () => {
  const form = $('#project-form'); form.elements.spaceId.value = ''; form.elements.spaceName.value = ''; updateProjectSelection();
});
for (const [id, mode] of [['#space-mode-create', 'create'], ['#space-mode-bind', 'bind']]) {
  $(id).addEventListener('click', () => setProjectSpaceMode(mode));
  $(id).addEventListener('keydown', event => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key) || projectSaving) return;
    event.preventDefault();
    const next = event.key === 'Home' ? 'create' : event.key === 'End' ? 'bind' : mode === 'create' ? 'bind' : 'create';
    setProjectSpaceMode(next); $(next === 'create' ? '#space-mode-create' : '#space-mode-bind').focus();
  });
}
$('#project-form').addEventListener('input', updateProjectSelection);
$('#project-form').addEventListener('submit', async (event) => {
  event.preventDefault(); const form = event.currentTarget;
  const dialog = $('#space-create-dialog');
  if (projectSaving || dialog.open) return;
  const project = projectOptions.find(project => project.root === form.elements.root.value);
  if (!project || !form.elements.agentType.value || ['creating', 'uncertain'].includes(project.bindingStatus)) return;
  const create = projectSpaceMode === 'create', value = (create ? form.elements.spaceName.value : form.elements.spaceId.value).trim();
  if (!value) return;
  const input = { name: project.name, root: project.root, agentType: form.elements.agentType.value, ...(create ? { spaceName: value } : { spaceId: value }) };
  if (!create) return saveProjectBinding(input);
  pendingProjectBinding = input;
  $('#space-confirm-name').textContent = value;
  $('#space-confirm-agent').textContent = agentName(input.agentType);
  $('#space-confirm-project').textContent = `${project.name} · ${project.root}`;
  dialog.showModal(); $('#space-create-cancel').focus();
});
$('#space-create-confirm').addEventListener('click', () => { if (pendingProjectBinding) return saveProjectBinding(pendingProjectBinding); });
$('#space-create-cancel').addEventListener('click', () => $('#space-create-dialog').close());
$('#space-create-dialog').addEventListener('cancel', event => { if (projectSaving) event.preventDefault(); });
$('#space-create-dialog').addEventListener('close', () => {
  if (!projectSaving) { pendingProjectBinding = undefined; $('#project-form').querySelector('button[type="submit"]').focus(); }
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
