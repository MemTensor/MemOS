import { el, details, filterSessions, statusLabel, sessionTitle, projectBindingTable, spaceBindingItem, projectSessionGroups, sessionStartedAt, sessionUpdatedAt, traceOccurredAt, taskTurnInline, traceScopeGroups, traceScopeSessions, cloudOperations, cloudDiagnosticDetail, t, setText, attr, joinText, dateText, errorText, initTranslations } from './view.js';

const $ = (selector) => document.querySelector(selector);
initTranslations();
let state = { bindings: [], projects: [], tasks: [], sessions: [], batches: [], recalls: [], diagnostics: [] };
let config = {}, adapters = [], selectedSession = null, tracePage = 1;
let reloadRequest = 0;
let projectOptions = [], projectLoad = 0, projectPoll;
const projectCache = new Map(), projectSelections = new Map(), projectRequests = new Map();
let projectAgent = '';
let projectSpaceMode = 'create', projectSaving = false, pendingProjectBinding;
let customProjectDomain = '', projectDomainSelection = '';
let selectedProject, sessionRequest = 0;
const traceProjectMemory = new Map();
let traceTime = 'all', traceDates = { from: '', to: '' };
let serviceError = '';
let overviewTab = 'summary', diagnosticPage = 1, diagnosticListRequest = 0, diagnosticRequest = 0;
let selectedDiagnostic, diagnosticTrigger, settingsTrigger;
let connectionTestRequest = 0;
const pageInfo = {
  overview: t("运行概览"),
  projects: t("项目与空间"),
  sessions: t("会话轨迹"),
  agents: t("Agent 接入"),
};
let noticeGeneration = 0, noticePage = pageName();
function clearNotices() {
  noticeGeneration++; noticePage = pageName();
  for (const selector of ['#notice', '#agent-notice']) {
    const notice = $(selector); setText(notice, ''); notice.hidden = true;
  }
}
function notifyAgent(message, error = false) {
  const notice = $('#agent-notice'); setText(notice, errorText(message)); notice.hidden = false;
  notice.className = error ? 'notice error' : 'notice';
}
function notify(message, error = false) {
  const notice = $('#notice'); setText(notice, errorText(message)); notice.hidden = false; notice.className = error ? 'notice error' : 'notice';
}
function pageNotifier() {
  const generation = noticeGeneration, name = pageName();
  return (message, error = false) => {
    if (generation === noticeGeneration && name === pageName()) notify(message, error);
  };
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
  const report = pageNotifier();
  button.disabled = true;
  try { await callback(); } catch (error) { report(errorText(error.message), true); } finally { button.disabled = false; }
}
function clear(selector) { const target = $(selector); setText(target, ''); target.replaceChildren(); return target; }
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
  for (const [title, value] of rows) list.append(el('dt', title), el('dd', value == null || value === '' ? '—' : value));
  target.append(list);
}
function formatDate(value) { return dateText(value); }
function pageName() {
  const name = window.location.hash.slice(1);
  return Object.hasOwn(pageInfo, name) ? name : 'overview';
}
function showPage(name) {
  if (serviceError) { notify(serviceError, true); return; }
  if (!Object.hasOwn(pageInfo, name)) name = 'overview';
  if (window.location.hash !== `#${name}`) window.location.hash = `#${name}`;
  else { const report = pageNotifier(); return reload().catch(error => report(errorText(error.message), true)); }
}
function renderPage() {
  if (pageName() === 'overview') return renderOverview();
  if (pageName() === 'projects') return renderProjects();
  if (pageName() === 'sessions') {
    if (selectedSession && $('#session-detail').dataset.loading === 'true') void openSession(selectedSession, tracePage);
    else renderSessions();
  }
  if (pageName() === 'agents') return renderAgents();
}
async function reload() {
  const name = pageName(), request = ++reloadRequest;
  if (noticePage !== name) clearNotices();
  if (name !== 'sessions') sessionRequest++;
  if (projectPoll) { clearTimeout(projectPoll); projectPoll = undefined; }
  document.querySelectorAll('.page').forEach(node => { node.hidden = node.id !== name; });
  document.querySelectorAll('.nav').forEach(node => { node.classList.toggle('active', node.dataset.page === name); attr(node, 'aria-current', node.dataset.page === name ? 'page' : 'false'); });
  setText($('#page-title'), pageInfo[name]);
  diagnosticListRequest++;
  try {
    const health = await api('/api/health');
    if (request !== reloadRequest || name !== pageName()) return;
    if (health.apiVersion !== 10) {
      serviceError = '后台服务版本已过期，请重新打开 Viewer 更新服务。';
      throw new Error(serviceError);
    }
    const [nextState, nextConfig, nextAdapters] = await Promise.all([
      name === 'projects' ? api('/api/bind').then(bindings => ({ ...state, bindings })) : api('/api/state'),
      api('/api/config'), api('/api/adapters/installed'),
    ]);
    if (request !== reloadRequest || name !== pageName()) return;
    serviceError = '';
    state = nextState; config = nextConfig; adapters = Array.isArray(nextAdapters) ? nextAdapters : nextAdapters.agents ?? nextAdapters.adapters ?? [];
    setText($('#connection'), config.connectionConfigured ? t("连接已配置") : t("待配置云连接")); $('#connection').className = config.connectionConfigured ? 'badge' : 'badge warning';
    await renderPage();
    if (request === reloadRequest && window.location.hash === '#settings') openSettings();
    if (request === reloadRequest && name === pageName()) setText($('#updated-at'), t("更新于 {0}", dateText(new Date(), true)));
  } catch (error) {
    if (request === reloadRequest && name === pageName()) throw error;
  }
}
function renderOverview() {
  const metrics = clear('#metrics');
  const sessions = projectSessionGroups(state).flatMap(group => group.sessions);
  const pending = state.batches.filter(batch => !batch.uploaded && batch.status === 'pending');
  const failed = state.batches.filter(batch => ['failed', 'blocked', 'processing-failed'].includes(batch.status) || batch.processingStatus === 'failed');
  for (const [title, value] of [[t("已启用绑定"), (state.bindings ?? []).filter(scope => scope.active === true).length], [t("采集会话"), sessions.length], [t("待上传批次"), pending.length], [t("需关注批次"), failed.length]]) {
    const card = el('section', '', 'metric'); card.append(el('p', title), el('div', String(value), 'number')); metrics.append(card);
  }
  setText($('#local-status'), t("运行正常"));
  const processingLabels = [];
  if (state.batches.some(batch => batch.processingStatus === 'accumulating')) processingLabels.push(t("消息积累中"));
  if (state.batches.some(batch => batch.processingStatus === 'unknown')) processingLabels.push(t("整理状态待确认"));
  setText($('#upload-status'), config.paused ? t("已暂停") : joinText([t("自动上传中"), ...processingLabels]));
  setText($('#pause-overview'), config.paused ? t("恢复上传") : t("暂停上传"));
  setText($('#diagnostic-count'), String(state.cloudDiagnosticCount ?? 0));
  const attention = clear('#attention-list');
  for (const batch of failed.slice().reverse().slice(0, 4)) {
    const session = sessions.find(item => item.id === batch.sessionId), row = el('div', '', 'attention-row'), content = el('div', '', 'row-main');
    content.append(badge(batch.status), el('strong', session ? sessionTitle(session) : t("上传批次")), el('small', errorText(batch.error) || (batch.status === 'blocked' ? t("上传受阻，暂未记录具体原因。") : t("云端处理失败，详情见诊断记录。"))));
    row.append(content);
    if (session) row.append(button(t("查看会话 →"), () => openSession(session.id), 'text-button'));
    attention.append(row);
  }
  if (!failed.length) empty(attention, t("暂无需要处理的上传批次。"));
  const recent = clear('#recent-sessions');
  for (const session of sessions.slice().sort((a, b) => String(sessionStartedAt(b) ?? b.createdAt).localeCompare(String(sessionStartedAt(a) ?? a.createdAt))).slice(0, 5)) {
    const row = el('div', '', 'row'), label = el('div', '', 'row-main');
    label.append(el('strong', sessionTitle(session)), el('small', agentName(session.agentType) + ' · ' + session.cwd));
    row.append(label, button(t("查看 →"), () => openSession(session.id), 'text-button')); recent.append(row);
  }
  if (!sessions.length) empty(recent, t("暂无会话"));
  selectOverviewTab(overviewTab, false);
  if (overviewTab === 'diagnostics') return loadDiagnostics(diagnosticPage);
}
function renderProjects() {
  const select = $('#project-form select[name="agentType"]'), selected = select.value;
  select.replaceChildren();
  const placeholder = el('option', t("选择 Agent")); placeholder.value = ''; select.append(placeholder);
  const agents = new Map(adapters.filter(agent => agent.installed).map(agent => [agent.agentId, agent.name]));
  for (const [agentType, name] of agents) { const option = el('option', name); option.value = agentType; select.append(option); }
  select.value = agents.has(selected) ? selected : '';
  const report = pageNotifier();
  const loading = loadProjectOptions().catch(error => report(errorText(error.message), true));
  renderBindings();
  pollProjects();
  return loading;
}
function renderBindings() {
  const list = clear('#project-list'), bindings = (state.bindings ?? []).filter(scope => scope.spaceIds?.length);
  setText($('#binding-count'), bindings.length);
  if (bindings.length) list.append(projectBindingTable(bindings, adapters, openProjectSpaces,
    (scope, trigger) => changeHistory(scope, trigger, false), (scope, trigger) => changeHistory(scope, trigger, true)));
  else empty(list, t("暂无绑定关系"));
}
function pollProjects() {
  if (projectPoll) clearTimeout(projectPoll);
  projectPoll = undefined;
  if (pageName() !== 'projects' || !(state.bindings ?? []).some(scope => scope.history?.uploading || ['pending', 'scanning'].includes(scope.history?.status))) return;
  projectPoll = setTimeout(async () => {
    projectPoll = undefined;
    const request = reloadRequest;
    try {
      const bindings = await api('/api/bind');
      if (pageName() !== 'projects' || request !== reloadRequest) return;
      state = { ...state, bindings }; renderBindings();
    } catch (error) { if (pageName() === 'projects' && request === reloadRequest) notify(errorText(error.message), true); }
    pollProjects();
  }, 2000);
}
function confirmHistoryUpload(scope) {
  const dialog = $('#history-upload-dialog');
  setText($('#history-upload-project'), scope.name);
  setText($('#history-upload-count'), t("{0} 条独立轨迹记录", scope.history.pending));
  dialog.returnValue = '';
  return new Promise(resolve => {
    dialog.addEventListener('close', () => resolve(dialog.returnValue === 'upload'), { once: true });
    dialog.showModal(); $('#history-upload-cancel').focus();
  });
}
async function changeHistory(scope, trigger, scan) {
  const report = pageNotifier();
  await action(trigger, async () => {
    if (!scan) {
      const bindings = await api('/api/bind');
      const current = bindings.find(item => item.id === scope.id);
      if (!current?.spaceIds?.length) throw new Error('当前绑定已变化，请刷新后重试');
      state = { ...state, bindings }; scope = current;
      if (!scope.history?.canUpload || scope.history.uploading) { renderBindings(); return; }
      const confirmCount = scope.history.historyUploadConfirmCount;
      if (!Number.isSafeInteger(confirmCount) || confirmCount <= 0) throw new Error('请重新打开 Viewer 更新后台后再上传');
      if (scope.history.pending > confirmCount && !await confirmHistoryUpload(scope)) { renderBindings(); return; }
    }
    setText(trigger, scan ? t("扫描中…") : t("上传中…"));
    scope.history = { ...scope.history, ...(scan ? { status: 'scanning' } : { uploading: true, canUpload: false, uploadError: undefined }) };
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
    report(failure ?? (scan ? t("历史会话扫描已执行。") : current.history?.uploading ? t("历史正在分批上传。") : t("历史上传已完成。")), !!failure);
    if (pageName() === 'projects') renderBindings();
    pollProjects();
  });
}
function openProjectSpaces(project, trigger) {
  const dialog = el('dialog', '', 'trace-drawer space-drawer'), header = el('header', '', 'drawer-header');
  attr(dialog, 'aria-labelledby', 'space-detail-title');
  const title = el('h2', `${agentName(project.agentType)} · ${project.name}`); title.id = 'space-detail-title';
  const body = el('div', '', 'drawer-body'), notice = el('p', '', 'notice'); notice.hidden = true; attr(notice, 'role', 'status'); attr(notice, 'aria-live', 'polite');
  header.append(title, button(t("关闭"), () => dialog.close(), 'secondary')); dialog.append(header, body);
  let spaces = [], active = true;
  const showNotice = (message, error = false) => { setText(notice, errorText(message)); notice.hidden = false; notice.className = error ? 'notice error' : 'notice'; };
  const copySpace = async spaceId => {
    try { await navigator.clipboard.writeText(spaceId); showNotice(t("Space ID 已复制。")); }
    catch { showNotice(t("复制失败，请手动选择 Space ID 复制。"), true); }
  };
  const unbindSpace = async spaceId => {
    try {
      await api('/api/bind', { objectId: project.id, spaceId }, 'DELETE');
      spaces = spaces.filter(space => space.spaceId !== spaceId);
      if (active) { renderSpaces(); showNotice(t("已解除该 Space 的绑定。")); }
      await reload();
      if (active) (body.querySelector('.space-icon-button') ?? header.querySelector('button')).focus();
    } catch (error) { if (active) showNotice(errorText(error.message), true); }
  };
  function renderSpaces() {
    body.replaceChildren(); body.append(notice);
    const group = el('details', '', 'space-binding-group'); group.open = true;
    group.append(el('summary', t("已绑定 {0} 个 Space", spaces.length)));
    if (spaces.length) {
      const list = el('ul', '', 'space-binding-list');
      for (const space of spaces) list.append(spaceBindingItem(space, copySpace, unbindSpace));
      group.append(list);
    } else group.append(el('p', t("暂无绑定的 Space。"), 'empty'));
    body.append(group);
  }
  body.append(el('p', t("正在读取 Space 列表…"), 'hint'));
  dialog.addEventListener('click', event => { if (event.target === dialog) dialog.close(); });
  dialog.addEventListener('close', () => {
    active = false; dialog.remove();
    const current = [...document.querySelectorAll('.space-list-open')].find(button => button.getAttribute('data-scope-id') === project.id);
    (trigger?.isConnected ? trigger : current)?.focus();
  }, { once: true });
  document.body.append(dialog); dialog.showModal();
  api(`/api/projects/${encodeURIComponent(project.id)}/spaces`).then(result => { if (active) { spaces = result; renderSpaces(); } }).catch(error => {
    if (active) { body.replaceChildren(notice); showNotice(errorText(error.message), true); }
  });
}
function displayProjectOptions(agentType, projects) {
  const form = $('#project-form'), root = projectSelections.get(agentType);
  const bindings = (state.bindings ?? []).filter(scope => scope.agentType === agentType);
  projectOptions = projects.map(project => {
    const binding = bindings.find(scope => scope.root === project.root);
    return binding ? { ...project, name: binding.name, spaceIds: binding.spaceIds, bindingStatus: binding.spaceIds.length ? 'bound' : 'unbound' } : project;
  });
  const options = [el('option', !agentType ? t("先选择 Agent") : projects.length ? t("选择本地项目") : projectCache.has(agentType) ? t("未发现项目") : t("正在读取项目…"))];
  options[0].value = '';
  for (const project of projectOptions) {
    const option = el('option', t('{0} · {1}{2}', project.name, project.root, project.spaceIds?.length ? t('（已绑定）') : ''));
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
  if (agentType !== projectAgent) { form.elements.spaceId.value = ''; form.elements.spaceName.value = ''; resetProjectDomain(); }
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
      if (!projectCache.has(agentType)) setText(form.elements.root.children[0], t("读取失败，请重新选择 Agent 或刷新"));
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
  $('#space-domain-field').hidden = !create;
  $('#project-space-entry').classList.toggle('binding-existing', !create);
  for (const [id, active] of [['#space-mode-create', create], ['#space-mode-bind', !create]]) {
    attr($(id), 'aria-selected', String(active));
    $(id).tabIndex = active ? 0 : -1;
  }
  attr($('#project-space-panel'), 'aria-labelledby', create ? 'space-mode-create' : 'space-mode-bind');
  updateProjectSelection();
}
function projectDomain() {
  const value = $('#project-form').elements.domain.value;
  if (['编程', '办公'].includes(value)) return value;
  return value === 'custom' && customProjectDomain && Array.from(customProjectDomain).length <= 24 ? customProjectDomain : '';
}
function resetProjectDomain() {
  customProjectDomain = ''; projectDomainSelection = '';
  $('#project-form').elements.domain.value = '';
  setText($('#project-domain-custom-option'), t("自定义…"));
}
function updateCustomDomain() {
  const value = $('#domain-custom-name').value.trim();
  const error = !value ? t("请输入 Domain 名称。") : Array.from(value).length > 24 ? t("Domain 名称不能超过 24 个字符。") : '';
  $('#domain-custom-confirm').disabled = !!error;
  setText($('#domain-custom-error'), error);
  $('#domain-custom-error').hidden = !error;
  return error ? '' : value;
}
function openCustomDomain() {
  if (projectSaving || projectSpaceMode !== 'create' || $('#domain-custom-dialog').open) return;
  $('#domain-custom-name').value = customProjectDomain;
  updateCustomDomain();
  $('#domain-custom-dialog').showModal();
  $('#domain-custom-name').focus();
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
  form.elements.domain.disabled = projectSaving || !project || !!blocked || !create;
  form.elements.domain.required = create;
  $('#project-domain-edit').hidden = form.elements.domain.value !== 'custom' || !customProjectDomain;
  $('#project-domain-edit').disabled = form.elements.domain.disabled;
  form.elements.spaceName.required = create;
  form.elements.spaceId.required = !create;
  for (const id of ['#space-mode-create', '#space-mode-bind']) $(id).disabled = projectSaving;
  const value = create ? form.elements.spaceName.value : form.elements.spaceId.value;
  form.querySelector('button[type="submit"]').disabled = projectSaving || !project || !!blocked || !value.trim() || create && (!projectDomain() || $('#domain-custom-dialog').open);
  setText($('#project-submit-label'), projectSaving ? create ? t("正在创建…") : t("正在绑定…") : create ? t("新建并绑定") : t("绑定 Space"));
  setText($('#project-space-help'), blocked ? t("空间创建结果尚待确认，暂不可绑定。") : '');
  $('#project-space-help').hidden = !blocked;
  $('#project-directory').hidden = !project;
  setText($('#project-directory'), project?.root ?? '');
  setText($('#project-target-agent'), agentName(form.elements.agentType.value) || t("所选 Agent"));
}
function projectSpaceLimitReached(input) {
  const binding = state.bindings.find(scope => scope.agentType === input.agentType && scope.root === input.root);
  if (binding?.spaceIds.length >= 20 && !binding.spaceIds.includes(input.spaceId)) {
    window.alert(String(t("单个项目绑定空间不能超过20个")));
    return true;
  }
  return false;
}
async function saveProjectBinding(input) {
  if (projectSaving) return;
  if (projectSpaceLimitReached(input)) {
    if ($('#space-create-dialog').open) $('#space-create-dialog').close();
    return;
  }
  const report = pageNotifier();
  projectSaving = true;
  updateProjectSelection();
  const dialog = $('#space-create-dialog');
  $('#space-create-confirm').disabled = true;
  $('#space-create-cancel').disabled = true;
  setText($('#space-create-confirm'), t("正在创建…"));
  try {
    await api('/api/projects', input);
    // Creation is already committed; a failed refresh must not offer to create again.
    if (dialog.open) dialog.close();
    const form = $('#project-form');
    if (input.spaceName !== undefined) { form.elements.spaceName.value = ''; resetProjectDomain(); }
    else form.elements.spaceId.value = '';
    report(input.spaceName !== undefined ? t("Space 已创建并绑定，已保存到本地。") : t("项目与 Space 已绑定并保存到本地。"));
    void reload().catch(error => {
      if (!projectSaving) report(t("Space 已绑定并保存到本地，但刷新失败：{0}，请点击刷新查看。", errorText(error.message)), true);
    });
  } catch (error) {
    if (dialog.open) dialog.close();
    if (error.message.includes('单个项目绑定空间不能超过20个')) window.alert(String(t("单个项目绑定空间不能超过20个")));
    if (error.spaceId) {
      projectSaving = false;
      $('#project-form').elements.spaceId.value = error.spaceId;
      setProjectSpaceMode('bind');
      report(t("Space 已创建，但未完成绑定：{0}。已保留 Space ID：{1}，请核对云连接后使用“绑定 Space”，不要重复创建。", errorText(error.message), error.spaceId), true);
    } else report(errorText(error.message), true);
  } finally {
    projectSaving = false;
    pendingProjectBinding = undefined;
    $('#space-create-confirm').disabled = false;
    $('#space-create-cancel').disabled = false;
    setText($('#space-create-confirm'), t("确认新建并绑定"));
    updateProjectSelection();
    const form = $('#project-form'), submit = form.querySelector('button[type="submit"]');
    (submit.disabled ? form.elements[projectSpaceMode === 'create' ? 'spaceName' : 'spaceId'] : submit).focus();
  }
}
function traceDate(value) { return value ? formatDate(value) : t("原始时间缺失"); }
function traceAgent() { return $('#session-filters select[name="agent"]').value; }
function agentName(id) { return adapters.find(agent => agent.agentId === id || agent.id === id)?.name ?? id; }
function traceGroups() { return traceScopeGroups(state, traceAgent()); }
function traceFilter() { return { project: selectedProject, query: $('#trace-search').value, ...traceDates }; }
function renderTraceBreadcrumb(session) {
  const breadcrumb = clear('#trace-breadcrumb');
  breadcrumb.append(el('span', t("会话轨迹")));
  if (!session) return;
  const group = projectSessionGroups(state).find(group => group.sessions.some(item => item.id === session.id));
  breadcrumb.append(el('span', '/', 'hint'), el('span', agentName(session.agentType)), el('span', '/', 'hint'), el('span', group?.name ?? t("未归属项目")));
}
function clearSelectedSession(message = t("此范围暂无符合条件的会话")) {
  selectedSession = null; tracePage = 1; sessionRequest++;
  const detail = clear('#session-detail'); delete detail.dataset.loading; detail.className = 'empty'; detail.append(el('p', message));
  detail.append(button(t("清除时间和搜索条件"), () => { traceTime = 'all'; traceDates = { from: '', to: '' }; $('#trace-time').value = 'all'; $('#trace-search').value = ''; $('#trace-date-range').hidden = true; renderSessions(); }, 'text-button'));
  renderTraceBreadcrumb();
}
function renderTraceProjects() {
  const groups = traceGroups(), chosen = groups.find(group => group.id === selectedProject);
  setText($('#trace-project-label'), chosen?.name ?? t("全部项目"));
  attr($('#trace-project-label'), 'title', chosen?.root || chosen?.name || t("当前 Agent 的全部项目"));
  const options = clear('#trace-project-options'), query = $('#trace-project-search').value.trim().toLocaleLowerCase();
  const add = (id, name, root, count) => {
    const item = button('', () => {
      selectedProject = id; traceProjectMemory.set(traceAgent(), id); $('#trace-project-picker').open = false;
      clearSelectedSession(); renderSessions();
    }, `trace-project-option${selectedProject === id ? ' selected' : ''}`);
    attr(item, 'aria-pressed', String(selectedProject === id));
    const heading = el('span', '', 'trace-project-option-title'); heading.append(el('strong', name), el('small', t("{0} 个会话", count))); item.append(heading);
    if (root) item.append(el('small', root)); options.append(item);
  };
  add(undefined, t("全部项目"), '', groups.reduce((count, group) => count + group.sessions.length, 0));
  const matches = groups.filter(group => `${group.name} ${group.root}`.toLocaleLowerCase().includes(query));
  for (const group of matches) add(group.id, group.name, group.root || t("尚未关联到已登记项目"), group.sessions.length);
  if (query && !matches.length) empty(options, t("未找到匹配的项目"));
}
function renderSessions(load = true) {
  const select = $('#session-filters select[name="agent"]'), selectedAgent = select.value;
  const agents = [...new Set(traceScopeGroups(state).flatMap(group => group.sessions.map(session => session.agentType)))].sort();
  select.replaceChildren(); const all = el('option', t("全部 Agent")); all.value = ''; select.append(all);
  for (const agent of agents) { const option = el('option', agentName(agent)); option.value = agent; select.append(option); }
  select.value = agents.includes(selectedAgent) ? selectedAgent : '';
  const groups = traceGroups();
  if (selectedProject !== undefined && !groups.some(group => group.id === selectedProject)) { selectedProject = undefined; clearSelectedSession(); }
  renderTraceProjects();
  const sessions = traceScopeSessions(groups, traceFilter()), list = clear('#session-list');
  setText($('#trace-session-count'), t("{0} 个会话", sessions.length));
  for (const session of sessions) {
    const row = button('', () => openSession(session.id), `trace-session-row${selectedSession === session.id ? ' selected' : ''}`);
    attr(row, 'aria-current', String(selectedSession === session.id));
    row.append(el('strong', sessionTitle(session)));
    const group = groups.find(group => group.sessions.some(item => item.id === session.id));
    const sources = [!traceAgent() ? agentName(session.agentType) : '', selectedProject === undefined ? group?.name : ''].filter(Boolean);
    if (sources.length) row.append(el('small', joinText(sources), 'trace-session-source'));
    const meta = el('small', '', 'trace-session-meta'); meta.append(el('span', t("{0} 轮", Number(session.turnCount) || 0)), el('span', t("最近更新 {0}", traceDate(sessionUpdatedAt(session))))); row.append(meta); list.append(row);
  }
  if (!sessions.length) { empty(list, t("没有匹配的会话")); clearSelectedSession(); return; }
  if (!sessions.some(session => session.id === selectedSession)) {
    clearSelectedSession();
    if (load) void openSession(sessions[0].id);
  } else renderTraceBreadcrumb(sessions.find(session => session.id === selectedSession));
}
async function openSession(id, pageNumber = 1) {
  const project = projectSessionGroups(state).find(group => group.sessions.some(session => session.id === id));
  if (!project) { clearSelectedSession(t("该会话已不可用")); return; }
  const session = project.sessions.find(item => item.id === id);
  if (pageName() !== 'sessions') {
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
  const target = clear('#session-detail'); target.className = 'empty'; target.dataset.loading = 'true'; setText(target, t("正在读取轮次…"));
  try {
    const detail = await api(`/api/sessions/${encodeURIComponent(id)}?page=${pageNumber}&size=10&unit=turn`);
    if (request !== sessionRequest || selectedSession !== id || tracePage !== pageNumber || pageName() !== 'sessions') return;
    renderSessionDetail(detail);
  } catch (error) {
    if (request === sessionRequest && selectedSession === id && pageName() === 'sessions') {
      delete target.dataset.loading; setText(target, t("读取失败，请刷新重试")); notify(errorText(error.message), true);
    }
  }
}
function renderSessionDetail(detail) {
  const target = clear('#session-detail'); delete target.dataset.loading; target.className = 'trace-reading';
  const session = { ...detail.session };
  const local = state.sessions.find(item => item.id === session.id);
  if (local) {
    local.title = session.title;
    if (Number.isFinite(detail.total)) local.turnCount = detail.total;
    renderSessions(false);
  }
  renderTraceBreadcrumb(session);
  const header = el('div', '', 'trace-reading-heading'), heading = el('div');
  heading.append(el('h2', sessionTitle(session)), el('p', t("{0} · {1} · {2} 轮", agentName(session.agentType), traceDate(sessionStartedAt(session)), detail.total ?? 0), 'hint'));
  const metadata = el('details', '', 'trace-session-info'); metadata.append(el('summary', t("会话信息 ⓘ")));
  info(metadata, [[t("宿主会话 ID"), session.nativeSessionId], [t("目录"), session.cwd], [t("原始开始时间"), traceDate(sessionStartedAt(session))]]);
  header.append(heading, metadata); target.append(header);
  const toolbar = el('div', '', 'trace-reading-toolbar');
  const expand = button(t("展开全部执行过程"), () => {
    const items = [...target.querySelectorAll('.trace-execution')], open = items.some(item => !item.open);
    for (const item of items) item.open = open;
    setText(expand, open ? t("收起全部执行过程") : t("展开全部执行过程"));
  }, 'text-button'); toolbar.append(el('span', t("对话记录")), expand); target.append(toolbar);
  const total = detail.total ?? 0, size = detail.size ?? 10, current = detail.page ?? tracePage, pages = Math.max(1, Math.ceil(total / size));
  for (const [index, group] of (detail.groups ?? []).entries()) {
    const number = group.roundNumber ?? ((current - 1) * size + index + 1);
    const startedAt = Object.hasOwn(group, 'startedAt') ? group.startedAt : traceOccurredAt(group.traces[0] ?? {});
    target.append(taskTurnInline(group, number, traceDate(startedAt)));
  }
  const syncExpansion = () => { const items = [...target.querySelectorAll('.trace-execution')]; setText(expand, items.length && items.every(item => item.open) ? t("收起全部执行过程") : t("展开全部执行过程")); };
  for (const item of target.querySelectorAll('.trace-execution')) item.addEventListener('toggle', syncExpansion);
  expand.hidden = !target.querySelector('.trace-execution');
  if (!detail.groups?.length) empty(target, t("此会话暂无可展示轮次。"));
  if (pages > 1) {
    const pager = el('div', '', 'pagination'), previous = button(t("← 上一页"), () => openSession(selectedSession, current - 1)), next = button(t("下一页 →"), () => openSession(selectedSession, current + 1));
    previous.disabled = current <= 1; next.disabled = current >= pages;
    pager.append(previous, el('span', t("第 {0} / {1} 页 · {2} 轮", current, pages, total)), next); target.append(pager);
  }
}

function agentActionMessage(agent, operation) {
  const status = { install: t("已安装"), repair: t("已更新"), uninstall: t("已卸载") }[operation];
  const next = operation === 'uninstall' ? t("请重启 Agent。") : agent.id === 'prime-agent'
    ? t("请重启或执行 /reload。") : agent.id === 'deepseek-harness'
      ? t("重启 DSH 后生效。") : agent.id === 'codex-cli'
      ? t("请重新加载，并在 /hooks 启用 MemOS。") : t("请重新加载 Agent。");
  return t("{0} 接入{1}。{2}", agent.name ?? agent.id, status, next);
}
function agentUsageNotes(agent) {
  const notes = {
    'codex-cli': [t("在 /hooks 中信任并启用 MemOS。")],
    'cursor-cli': [t("需开启 transcripts；首条请求可能没有记忆概览。")],
    'copilot-cli': [t("无法自动注入时，可通过 Skill 检索记忆。")],
    'grok-build': [t("首条请求无记忆概览，可通过 Skill 检索。")],
    'kimi-code': [t("适用于新版 Kimi；Agent 与本地服务须同机运行。")],
    'trae': [t("仅支持国内桌面版；会话记录可能不完整。")],
    'antigravity-cli': [t("空间管理需要宿主提供可验证的当前轮身份。")],
    'devin-cli': [t("会话记录可能不包含完整回复。")],
    'codebuddy-cli': [t("Windows 需安装 Git Bash。")],
    'opencode-v1': [t("需匹配宿主主版本；v1、v2 不能同时启用。")],
    'opencode-v2': [t("需匹配宿主主版本；v1、v2 不能同时启用。")],
    'cline-cli': [t("仅支持单会话 CLI，不支持多会话 Hub。")],
    'prime-agent': [t("原生终端通过 Skill 按需检索记忆。")],
  };
  return agent.limitations?.length ? notes[agent.id] ?? agent.limitations.map(errorText) : [];
}
async function changeAdapter(agent, operation) {
  const generation = noticeGeneration;
  const current = () => pageName() === 'agents' && generation === noticeGeneration;
  const label = { install: t("安装"), repair: t("更新"), uninstall: t("卸载") }[operation];
  try {
    await api(`/api/adapters/${encodeURIComponent(agent.id)}/${operation}`, {});
  } catch (error) {
    if (current()) notifyAgent(t("{0} 接入{1}失败：{2}", agent.name ?? agent.id, label, errorText(error.message)), true);
    return;
  }
  if (current()) notifyAgent(agentActionMessage(agent, operation));
  try { await reload(); }
  catch (error) { if (current()) notifyAgent(t("{0} 接入{1}已完成，刷新失败：{2}", agent.name ?? agent.id, label, errorText(error.message)), true); }
}

async function renderAgents() {
  const request = reloadRequest, available = await api('/api/adapters');
  if (pageName() !== 'agents' || request !== reloadRequest) return;
  adapters = available;
  const list = clear('#agent-list');
  for (const agent of adapters) {
    const card = el('section', '', 'card'), heading = el('div', '', 'agent-title'); heading.append(el('h2', agent.name ?? agent.id), badge(agent.installed ? 'installed' : 'unverified', agent.installed ? t("已适配") : t("未适配"))); card.append(heading);
    info(card, [[t("宿主检测"), agent.detected ? t("已检测到") : t("未检测到")], [t("探测版本"), agent.version], [t("适配版本"), Array.isArray(agent.versions) ? joinText(agent.versions, ', ') : JSON.stringify(agent.versions ?? null)], [t("兼容核对"), agent.support === 'version-matched' ? t("版本匹配") : agent.support === 'not-detected' ? t("未检测到宿主") : t("待核实")]]);
    const usageNotes = agentUsageNotes(agent);
    if (usageNotes.length) {
      const notes = el('details', '', 'detail'), items = el('ul', '', 'agent-notes');
      for (const text of usageNotes) items.append(el('li', text));
      notes.append(el('summary', t("使用提示")), items); card.append(notes);
    }
    const controls = el('div', '', 'actions');
    for (const [label, operation] of agent.installed ? [[t("更新接入配置"), 'repair'], [t("卸载 MemOS 接入"), 'uninstall']] : [[t("安装 MemOS 接入"), 'install']]) {
      controls.append(button(label, () => changeAdapter(agent, operation), operation === 'install' ? '' : 'secondary'));
    }
    card.append(controls); list.append(card);
  }
  if (!adapters.length) empty(list, t("未加载 Agent 配置"));
}
function renderSettings() {
  const form = $('#config-form'); form.elements.baseUrl.value = config.baseUrl ?? ''; form.elements.userId.value = config.userId ?? '';
  form.elements.apiMode.value = config.apiMode ?? 'engineering';
  form.elements.authMode.value = config.authMode ?? 'token';
  form.elements.cloudProjectId.value = config.cloudProjectId ?? '';
  form.elements.apiKey.value = ''; form.elements.clearApiKey.checked = false;
  form.elements.uploadMaxBytes.value = config.uploadMaxBytes ?? '';
  form.elements.historyUploadConfirmCount.value = config.historyUploadConfirmCount ?? '';
  updateConnectionFields();
}
function updateConnectionFields() {
  const form = $('#config-form'), algorithm = form.elements.apiMode.value === 'algorithm', noAuth = form.elements.authMode.value === 'none';
  $('#cloud-project-field').hidden = !algorithm;
  form.elements.cloudProjectId.required = algorithm;
  form.elements.apiKey.disabled = noAuth || form.elements.clearApiKey.checked;
  setText($('#key-status'), noAuth ? t("当前连接无需 Key") : config.keyConfigured ? t("Key 已配置") : t("未配置 Key"));
}
function openSettings(trigger = $('#open-settings')) {
  settingsTrigger = trigger;
  renderSettings(); setText($('#config-notice'), ''); setText($('#connection-test-result'), '');
  if (!$('#settings-dialog').open) $('#settings-dialog').showModal();
}
function selectOverviewTab(name, load = true) {
  overviewTab = name;
  $('#overview-summary').hidden = name !== 'summary'; $('#overview-diagnostics').hidden = name !== 'diagnostics';
  for (const [id, value] of [['#overview-summary-tab', 'summary'], ['#overview-diagnostics-tab', 'diagnostics']]) {
    attr($(id), 'aria-selected', String(value === name)); attr($(id), 'tabindex', value === name ? '0' : '-1');
  }
  if (name !== 'diagnostics') diagnosticListRequest++;
  if (load && name === 'diagnostics') return loadDiagnostics(1);
}
async function loadDiagnostics(page = 1) {
  const request = ++diagnosticListRequest, endpoint = $('#diagnostic-filter').value || '';
  setText($('#diagnostic-total'), t("正在读取…"));
  clear('#diagnostic-pagination');
  const table = clear('#diagnostics'), loading = el('tr'), cell = el('td', t("正在读取云服务调用错误…")); attr(cell, 'colspan', '5'); loading.append(cell); table.append(loading);
  try {
    const result = await api('/api/diagnostics?endpoint=' + encodeURIComponent(endpoint) + '&page=' + page + '&size=20');
    if (request !== diagnosticListRequest || pageName() !== 'overview' || overviewTab !== 'diagnostics') return;
    diagnosticPage = result.page;
    table.replaceChildren(); setText($('#diagnostic-total'), t("共 {0} 条失败记录", result.total));
    for (const record of result.items) {
      const row = el('tr'), operation = el('td'), summary = el('td');
      row.append(el('td', formatDate(record.lastOccurredAt), 'diagnostic-time'));
      operation.append(el('strong', cloudOperations[record.endpoint] ?? record.endpoint));
      summary.append(el('strong', errorText(record.message)), el('small', [record.context?.agentType, record.context?.projectName].filter(Boolean).join(' · ') || t("空间管理操作")));
      row.append(operation, summary, el('td', String(record.occurrences)));
      const actionCell = el('td');
      actionCell.append(button(t("查看 →"), () => openDiagnostic(record.id), 'text-button'));
      row.append(actionCell); table.append(row);
    }
    if (!result.items.length) { const row = el('tr'), td = el('td', t("暂无云服务调用失败记录。"), 'empty'); attr(td, 'colspan', '5'); row.append(td); table.append(row); }
    const pagination = clear('#diagnostic-pagination'), pages = Math.max(1, Math.ceil(result.total / result.size));
    if (pages > 1) {
      const bar = el('div', '', 'pagination'), prev = button(t("← 上一页"), () => loadDiagnostics(page - 1)), next = button(t("下一页 →"), () => loadDiagnostics(page + 1));
      prev.disabled = page <= 1; next.disabled = page >= pages; bar.append(prev, el('span', t("第 {0} / {1} 页", page, pages)), next); pagination.append(bar);
    }
  } catch (error) {
    if (request === diagnosticListRequest && pageName() === 'overview' && overviewTab === 'diagnostics') {
      table.replaceChildren(); const row = el('tr'), td = el('td', t("诊断记录读取失败：{0}", errorText(error.message))); attr(td, 'colspan', '5'); row.append(td); table.append(row);
      setText($('#diagnostic-total'), t("读取失败"));
    }
  }
}
async function openDiagnostic(id) {
  diagnosticTrigger = document.activeElement;
  const dialog = $('#diagnostic-dialog'), target = clear('#diagnostic-detail'), request = ++diagnosticRequest;
  selectedDiagnostic = null; $('#copy-diagnostic').hidden = true;
  target.append(el('p', t("正在读取错误详情…"), 'hint'));
  if (!dialog.open) dialog.showModal();
  try {
    const record = await api('/api/diagnostics/' + encodeURIComponent(id));
    if (request !== diagnosticRequest || !dialog.open) return;
    selectedDiagnostic = record; target.replaceChildren(cloudDiagnosticDetail(record)); $('#copy-diagnostic').hidden = false;
  } catch (error) {
    if (request === diagnosticRequest && dialog.open) target.replaceChildren(el('p', t("错误详情读取失败：{0}", errorText(error.message)), 'notice error'));
  }
}
async function toggleUpload() {
  const report = pageNotifier();
  await api('/api/config', { paused: !config.paused }, 'PUT'); await reload();
  report(config.paused ? t("上传已暂停。采集继续保留在本地。") : t("上传已恢复。已停止重试的批次仍保留原状态。"));
}

window.addEventListener('hashchange', () => {
  clearNotices(); const report = pageNotifier();
  window.scrollTo({ top: 0 }); return reload().catch(error => report(errorText(error.message), true));
});
document.querySelectorAll('[data-page]').forEach((node) => node.addEventListener('click', () => showPage(node.dataset.page)));
$('#refresh').addEventListener('click', (event) => action(event.currentTarget, async () => { if (pageName() === 'projects') await loadProjectOptions(true); await reload(); if (pageName() === 'sessions' && selectedSession) await openSession(selectedSession, tracePage); }));
$('#pause-overview').addEventListener('click', (event) => action(event.currentTarget, toggleUpload));
$('#project-form select[name="agentType"]').addEventListener('change', () => { const report = pageNotifier(); void loadProjectOptions().catch(error => report(errorText(error.message), true)); });
$('#project-form select[name="root"]').addEventListener('change', () => {
  const form = $('#project-form'); form.elements.spaceId.value = ''; form.elements.spaceName.value = ''; resetProjectDomain(); updateProjectSelection();
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
$('#project-form select[name="domain"]').addEventListener('change', () => {
  const selected = $('#project-form').elements.domain.value;
  if (selected === 'custom') openCustomDomain();
  else { projectDomainSelection = selected; updateProjectSelection(); }
});
$('#project-domain-edit').addEventListener('click', openCustomDomain);
$('#domain-custom-name').addEventListener('input', updateCustomDomain);
$('#domain-custom-form').addEventListener('submit', event => {
  event.preventDefault();
  const value = updateCustomDomain();
  if (!value || projectSaving || !$('#domain-custom-dialog').open) return;
  customProjectDomain = value; projectDomainSelection = 'custom';
  $('#project-form').elements.domain.value = 'custom';
  setText($('#project-domain-custom-option'), t("自定义：{0}", value));
  $('#domain-custom-dialog').close();
});
$('#domain-custom-cancel').addEventListener('click', () => $('#domain-custom-dialog').close());
$('#domain-custom-dialog').addEventListener('close', () => {
  $('#project-form').elements.domain.value = projectDomainSelection;
  updateProjectSelection();
  $('#project-form').elements.domain.focus();
});
$('#project-form').addEventListener('input', updateProjectSelection);
$('#project-form').addEventListener('submit', async (event) => {
  event.preventDefault(); const form = event.currentTarget;
  const dialog = $('#space-create-dialog');
  if (projectSaving || dialog.open) return;
  const project = projectOptions.find(project => project.root === form.elements.root.value);
  if (!project || !form.elements.agentType.value || ['creating', 'uncertain'].includes(project.bindingStatus)) return;
  const create = projectSpaceMode === 'create', value = (create ? form.elements.spaceName.value : form.elements.spaceId.value).trim();
  const domain = create ? projectDomain() : '';
  if (!value || create && (!domain || $('#domain-custom-dialog').open)) return;
  const input = { name: project.name, root: project.root, agentType: form.elements.agentType.value, ...(create ? { spaceName: value, domain } : { spaceId: value }) };
  if (projectSpaceLimitReached(input)) return;
  if (!create) return saveProjectBinding(input);
  pendingProjectBinding = input;
  setText($('#space-confirm-name'), value);
  setText($('#space-confirm-domain'), form.elements.domain.value !== 'custom' ? t(domain) : domain);
  setText($('#space-confirm-agent'), agentName(input.agentType));
  setText($('#space-confirm-project'), `${project.name} · ${project.root}`);
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
  if (value === 'custom') {
    const form = $('#session-filters');
    form.elements.from.max = form.elements.to.max = localDay(new Date());
    form.elements.from.value = traceDates.from; form.elements.to.value = traceDates.to; return;
  }
  traceTime = value; const today = new Date(), start = new Date(today); if (value === 'week') start.setDate(start.getDate() - 6);
  traceDates = value === 'all' ? { from: '', to: '' } : { from: localDay(start), to: localDay(today) }; clearSelectedSession(); renderSessions();
});
$('#trace-date-apply').addEventListener('click', () => {
  const form = $('#session-filters'), from = form.elements.from.value, to = form.elements.to.value, today = localDay(new Date());
  if (!from || !to || from > to || from > today || to > today) { setText($('#trace-date-error'), t("请选择有效的起止日期")); return; }
  setText($('#trace-date-error'), ''); traceTime = 'custom'; traceDates = { from, to }; $('#trace-date-range').hidden = true;
  clearSelectedSession(); renderSessions();
});
$('#trace-date-cancel').addEventListener('click', () => { $('#trace-time').value = traceTime; $('#trace-date-range').hidden = true; setText($('#trace-date-error'), ''); });
document.addEventListener('click', event => { if (!$('#trace-project-picker').contains(event.target)) $('#trace-project-picker').open = false; });
document.addEventListener('keydown', event => { if (event.key === 'Escape') { $('#trace-project-picker').open = false; $('#trace-date-cancel').click(); } });
$('#config-form').addEventListener('submit', (event) => {
  event.preventDefault(); const form = event.currentTarget;
  return action(form.querySelector('button[type="submit"]'), async () => {
    try {
      connectionTestRequest++; setText($('#connection-test-result'), '');
      const body = { apiMode: form.elements.apiMode.value, authMode: form.elements.authMode.value, cloudProjectId: form.elements.cloudProjectId.value.trim(), baseUrl: form.elements.baseUrl.value.trim(), uploadMaxBytes: Number(form.elements.uploadMaxBytes.value), historyUploadConfirmCount: Number(form.elements.historyUploadConfirmCount.value) };
      if (form.elements.clearApiKey.checked) body.apiKey = '';
      else if (form.elements.apiKey.value) body.apiKey = form.elements.apiKey.value;
      config = await api('/api/config', body, 'PUT'); form.elements.apiKey.value = ''; await reload(); renderSettings(); setText($('#config-notice'), t("设置已保存。"));
    } catch (error) { setText($('#config-notice'), t("保存失败：{0}", errorText(error.message))); throw error; }
  });
});
$('#config-form').addEventListener('change', event => {
  const form = $('#config-form');
  if (event.target.name === 'apiMode') form.elements.authMode.value = form.elements.apiMode.value === 'algorithm' ? 'none' : 'token';
  if (['apiMode', 'authMode', 'clearApiKey'].includes(event.target.name)) updateConnectionFields();
});
$('#test-connection').addEventListener('click', event => action(event.currentTarget, async () => {
  const request = ++connectionTestRequest, spaceId = $('#config-form').elements.connectionTestSpaceId.value.trim();
  setText($('#connection-test-result'), t("正在测试已保存的连接…"));
  try {
    const result = await api('/api/connection-test', spaceId ? { spaceId } : {});
    if (request !== connectionTestRequest) return;
    setText($('#connection-test-result'), result.verified ? t("读取验证通过：{0}", errorText(result.message))
      : result.reachable ? t("已收到服务响应，业务验证未完成：{0}", errorText(result.message)) : t("连接测试失败：{0}", errorText(result.message)));
  } catch (error) {
    if (request === connectionTestRequest) setText($('#connection-test-result'), t("连接测试失败：{0}", errorText(error.message)));
  }
}));
$('#open-settings').addEventListener('click', event => openSettings(event.currentTarget));
$('#connection-settings').addEventListener('click', event => openSettings(event.currentTarget));
$('#close-settings').addEventListener('click', () => $('#settings-dialog').close());
$('#settings-dialog').addEventListener('close', () => settingsTrigger?.focus());
$('#close-diagnostic').addEventListener('click', () => $('#diagnostic-dialog').close());
$('#diagnostic-dialog').addEventListener('close', () => { diagnosticRequest++; selectedDiagnostic = null; diagnosticTrigger?.focus(); });
for (const [id, name] of [['#overview-summary-tab', 'summary'], ['#overview-diagnostics-tab', 'diagnostics']]) {
  $(id).addEventListener('click', () => { void selectOverviewTab(name); });
  $(id).addEventListener('keydown', event => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault(); const next = event.key === 'Home' ? 'summary' : event.key === 'End' ? 'diagnostics' : name === 'summary' ? 'diagnostics' : 'summary';
    void selectOverviewTab(next); $(next === 'summary' ? '#overview-summary-tab' : '#overview-diagnostics-tab').focus();
  });
}
$('#view-diagnostics').addEventListener('click', () => { void selectOverviewTab('diagnostics'); });
$('#diagnostic-filter').addEventListener('change', () => { void loadDiagnostics(1); });
$('#copy-diagnostic').addEventListener('click', event => action(event.currentTarget, async () => {
  const report = pageNotifier();
  if (selectedDiagnostic) { await navigator.clipboard.writeText(JSON.stringify(selectedDiagnostic, null, 2)); report(t("错误详情已复制。")); }
}));
$('#export-diagnostics').addEventListener('click', event => action(event.currentTarget, async () => {
  const records = await api('/api/diagnostics/export');
  const blob = new Blob([JSON.stringify(records, null, 2)], { type: 'application/json' }), url = URL.createObjectURL(blob), link = el('a');
  link.href = url; link.download = 'memos-project-memory-diagnostics.json'; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}));

reload().catch((error) => { setText($('#connection'), serviceError ? t("后台服务需更新") : t("本地服务连接失败")); $('#connection').className = 'badge error'; notify(errorText(error.message), true); });
