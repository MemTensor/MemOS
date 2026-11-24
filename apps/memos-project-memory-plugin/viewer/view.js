import { t, setText, attr, joinText, dateText, errorText } from './i18n.js';
export { t, setText, attr, joinText, dateText, errorText, initTranslations } from './i18n.js';

export function el(tag, text = '', className = '') {
  const element = document.createElement(tag);
  setText(element, text);
  if (className) element.className = className;
  return element;
}
export function statusLabel(value) {
  return ({ manual: t("仅手动上传"), skipped: t("已处理"), blocked: t("上传受阻"), accumulating: t("消息积累中"), unknown: t("整理状态待确认"), accepted: t("已接收"), 'processing-failed': t("云端处理失败"), prepared: t("已准备上下文"), returned: t("已返回检索结果"), pending: t("等待上传"), waiting_space: t("等待空间"), creating: t("创建空间中"), uncertain: t("创建结果待确认"), uploading: t("上传中"), received: t("已接收"), uploaded: t("已接收"), running: t("云端处理中"), processing: t("云端处理中"), completed: t("已完成"), failed: t("失败"), stopped: t("已停止重试"), installed: t("已安装"), unavailable: t("不可用"), FOUND: t("检索命中"), EMPTY: t("无匹配结果"), UNAVAILABLE: t("记忆暂不可用"), injected: t("已交付上下文"), CONTEXT_MISSING: t("当前轮标识无效") })[value] ?? value ?? '—';
}
export function filterSessions(sessions, filter, batches) {
  return sessions.filter((session) => {
    const day = String(sessionStartedAt(session) ?? '').slice(0, 10);
    return (!filter.agent || session.agentType === filter.agent)
      && (!filter.directory || String(session.cwd ?? '').includes(filter.directory))
      && (!(filter.from || filter.to) || !!day)
      && (!filter.from || day >= filter.from) && (!filter.to || day <= filter.to)
      && (!filter.status || batches.some((batch) => batch.sessionId === session.id && batch.status === filter.status));
  });
}

export function sessionStartedAt(session) {
  return Object.hasOwn(session, 'sourceStartedAt') ? session.sourceStartedAt : session.createdAt;
}
export function sessionUpdatedAt(session) {
  return session.updatedAt ?? session.lastOccurredAt ?? sessionStartedAt(session);
}
export function traceOccurredAt(trace) {
  return Object.hasOwn(trace, 'occurredAt') ? trace.occurredAt : trace.createdAt;
}
function compareTime(a, b) {
  if (!a) return b ? 1 : 0;
  if (!b) return -1;
  const left = Date.parse(a), right = Date.parse(b);
  return Number.isFinite(left) && Number.isFinite(right) ? left - right : String(a).localeCompare(String(b));
}
export function projectSessionGroups(state) {
  const groups = (state.projects ?? []).map(project => ({ ...project, sessions: [] }));
  const byId = new Map(groups.map(group => [group.id, group]));
  const byDirectory = new Map();
  const tasks = new Map((state.tasks ?? []).map(task => [task.id, task]));
  const unassigned = { id: null, name: t("未归属项目"), root: '', sessions: [] };
  for (const session of state.sessions ?? []) {
    if (['subagent', 'background', 'unknown'].includes(session.sourceKind)) continue;
    if ((state.bindings ?? []).some(scope => scope.id === session.objectId && !scope.spaceIds?.length)) continue;
    const projectId = Object.hasOwn(session, 'projectId') ? session.projectId : tasks.get(session.taskId)?.projectId;
    let group = byId.get(projectId);
    const root = session.cwd;
    // Local directory identity is available before Space binding. These IDs are
    // display filters only; never rewrite the persisted task or upload scope.
    if (!group && !projectId && typeof root === 'string' && /^(\/|[A-Za-z]:[\\/]|\\\\)/.test(root)) {
      group = byDirectory.get(root);
      if (!group) {
        const name = root.split(root.startsWith('/') ? '/' : /[\\/]/).filter(Boolean).at(-1) || root;
        group = { id: `local-directory:${root}`, name, root, sessions: [] };
        byDirectory.set(root, group);
        groups.push(group);
      }
    }
    (group ?? unassigned).sessions.push(session);
  }
  for (const group of [...groups, unassigned]) {
    group.sessions.sort((a, b) => compareTime(sessionStartedAt(a), sessionStartedAt(b)) || String(a.id).localeCompare(String(b.id)));
    group.earliestOccurredAt = group.earliestOccurredAt ?? sessionStartedAt(group.sessions[0] ?? {});
    group.turnCount = group.sessions.reduce((total, session) => total + (Number(session.turnCount) || 0), 0);
  }
  groups.sort((a, b) => compareTime(a.earliestOccurredAt, b.earliestOccurredAt) || String(a.id).localeCompare(String(b.id)));
  return [...groups, unassigned];
}
export function sessionTitle(session) {
  if (typeof session.title === 'string' && session.title.trim()) return session.title;
  const id = String(session.nativeSessionId || session.id || '');
  return t("未命名会话 · {0}", (id.startsWith('session-') ? id.slice(8) : id).slice(0, 8));
}
export function projectBindingTable(projects, agents, openSpaces, uploadHistory, scanHistory) {
  const table = el('table', '', 'binding-table'), head = el('thead'), heading = el('tr'), body = el('tbody');
  for (const title of ['Agent', t("项目名称"), t("已绑定 Space"), t("历史会话上传")]) { const cell = el('th', title); attr(cell, 'scope', 'col'); heading.append(cell); }
  head.append(heading);
  const names = new Map(agents.map(agent => [agent.agentId, agent.name]));
  for (const project of projects) {
    const row = el('tr'), agent = el('td'), name = el('td', project.name, 'binding-project-name'), spaces = el('td');
    if (project.root) name.append(el('small', project.root, 'mono binding-project-directory'));
    attr(agent, 'data-label', 'Agent'); attr(name, 'data-label', t("项目名称")); attr(spaces, 'data-label', t("已绑定 Space"));
    agent.append(el('span', names.get(project.agentType) ?? project.agentType ?? t("待识别"), 'binding-agent'));
    const count = project.spaceIds?.length ?? 0;
    const open = el('button', count ? t("{0} 个 Space", count) : t("未绑定 Space"), 'text-button space-list-open');
    open.type = 'button'; attr(open, 'title', t("查看名称与 ID；新绑定的 Space 从绑定时刻起接收新内容。")); attr(open, 'data-scope-id', project.id); attr(open, 'aria-label', t("查看 {0} 的 Space 列表", project.name));
    open.addEventListener('click', () => openSpaces(project, open)); spaces.append(open);
    const history = el('td'), progress = project.history;
    attr(history, 'data-label', t("历史会话上传"));
    if (!progress || (!progress.uploadError && ['pending', 'scanning'].includes(progress.status))) history.append(el('span', '--', 'hint'));
    else {
      const scanFailed = progress.status === 'failed', uploadError = !scanFailed && progress.uploadError;
      const paused = typeof uploadError === 'string' && uploadError.startsWith('上传已暂停');
      const complete = progress.status === 'ready' && progress.pending === 0 && progress.recordCount !== 0;
      const label = scanFailed ? t("重试扫描") : progress.uploading ? t("上传中…") : paused ? t("上传暂停") : uploadError ? progress.canUpload ? t("重试上传") : t("上传历史失败") : complete ? t("已完成") : t("上传历史");
      const upload = el('button', label, `secondary history-upload${uploadError && !paused ? ' history-upload-failed' : ''}`);
      upload.type = 'button'; attr(upload, 'title', t("补传已有会话中尚未上传的内容。"));
      upload.disabled = !scanFailed && (!progress.canUpload || progress.uploading || !count);
      if (scanFailed && progress.error) attr(upload, 'title', errorText(progress.error));
      if (!upload.disabled) upload.addEventListener('click', () => (scanFailed ? scanHistory : uploadHistory)?.(project, upload));
      history.append(upload);
      if (uploadError && !paused) history.append(el('p', errorText(uploadError), 'history-upload-error'));
    }
    if (scanHistory && progress?.status === 'ready' && count && !progress.uploading) {
      const scan = el('button', t("扫描历史"), 'text-button'); scan.type = 'button';
      scan.addEventListener('click', () => scanHistory(project, scan)); history.append(scan);
    }
    row.append(agent, name, spaces, history); body.append(row);
  }
  table.append(head, body);
  return table;
}

function spaceAction(kind, label, callback) {
  const button = el('button', '', `space-icon-button${kind === 'unbind' ? ' danger' : ''}`);
  button.type = 'button'; attr(button, 'title', label); attr(button, 'aria-label', label);
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  attr(svg, 'viewBox', '0 0 24 24'); attr(svg, 'fill', 'none'); attr(svg, 'stroke', 'currentColor');
  attr(svg, 'stroke-width', '1.7'); attr(svg, 'stroke-linecap', 'round'); attr(svg, 'stroke-linejoin', 'round'); attr(svg, 'aria-hidden', 'true');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  attr(path, 'd', kind === 'copy' ? 'M9 9h11v11H9zM15 5V3H3v12h2' : 'M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7');
  svg.append(path); button.append(svg);
  button.addEventListener('click', async () => { button.disabled = true; try { await callback(); } finally { button.disabled = false; } });
  return button;
}

export function spaceBindingItem(space, copy, unbind) {
  const item = el('li', '', 'space-binding-item'), code = el('div', '', 'space-binding-code');
  code.append(el('code', space.spaceId, 'mono'),
    spaceAction('copy', t("复制 Space ID {0}", space.spaceId), () => copy(space.spaceId)),
    spaceAction('unbind', t("解绑 Space {0}", space.name || space.spaceId), () => unbind(space.spaceId)));
  item.append(el('strong', space.name || t("未命名 Space"), 'space-binding-name'), code);
  return item;
}


function imageReference(value, position = 1) {
  if (!value || typeof value !== 'object') return undefined;
  if (!['input_image', 'output_image', 'image', 'image_url', 'local_image', 'image_generation_call', 'image_generation'].includes(value.type)
    && !String(value.mimeType ?? value.mime_type ?? value.media_type ?? '').startsWith('image/')) return undefined;
  const path = typeof value.path === 'string' && !value.path.startsWith('data:') ? value.path : '';
  const name = value.name ?? value.filename ?? (path ? `[Image #${position}]` : '');
  return name || path ? `<image${name ? ` name=${name}` : ''}${path ? ` path=${JSON.stringify(path)}` : ''}>` : '[image]';
}
function traceText(value) {
  if (typeof value === 'string') return value;
  if (value == null) return '';
  if (Array.isArray(value)) return value.map(traceText).join('\n');
  const reference = imageReference(value);
  if (reference !== undefined) return reference;
  if (typeof value.text === 'string') return value.text;
  return JSON.stringify(value, (key, part) => imageReference(part) ?? (['image_url', 'imageUrl', 'b64_json', 'image_base64'].includes(key) ? '[image]' : part), 2);
}
function compactText(text, limit = 80) {
  const compact = String(text).replace(/\s+/g, ' ').trim();
  return compact.length > limit ? `${compact.slice(0, limit)}…` : compact;
}
function traceCard(title, time, preview = '') {
  const card = el('details', '', 'task-trace'), heading = el('summary', '', 'trace-heading');
  heading.append(el('strong', title), el('span', preview && typeof preview.render === 'function' ? preview : compactText(preview), 'trace-preview'), el('time', time, 'hint'));
  card.append(heading);
  return card;
}
const toolIdentity = new WeakMap();
function toolEntry(tool, time, result = false) {
  const call = tool.function ?? tool;
  const name = call.name ?? tool.tool_name ?? tool.toolName;
  const id = tool.tool_call_id ?? tool.tool_use_id ?? tool.toolCallId ?? tool.id;
  const card = traceCard(result ? 'tool result' : 'tool use', time, joinText([result ? t('工具结果') : t('工具调用'), ...(name ? [name] : [])]));
  toolIdentity.set(card, { id, result, error: !!(tool.is_error || tool.isError) });
  if (id) card.append(el('p', t("调用标识：{0}", id), 'hint'));
  const input = call.arguments ?? call.input ?? tool.tool_input;
  if (input !== undefined) card.append(el('p', t("参数"), 'trace-label'), el('pre', traceText(input), 'trace-content'));
  if (result) {
    let output = tool.content ?? tool.output ?? tool.result;
    if (typeof output === 'string') {
      try { output = JSON.parse(output); } catch { /* Plain tool output remains literal text. */ }
    }
    card.append(el('p', (tool.is_error || tool.isError) ? t("错误结果") : t("结果"), 'trace-label'), el('pre', traceText(output), 'trace-content'));
  }
  return card;
}
const thinkingTypes = ['thinking', 'reasoning', 'reasoning_text', 'reasoning_summary_text', 'redacted_thinking'];
const toolUseTypes = ['tool_use', 'tool-call', 'tool_call', 'toolCall'];
const toolResultTypes = ['tool_result', 'tool-result'];
function thinkingText(value) {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    const parts = value.map(thinkingText).filter(Boolean);
    return parts.some(part => part && typeof part.render === 'function') ? joinText(parts, '\n') : parts.join('\n');
  }
  if (!value || typeof value !== 'object') return '';
  if (value.type === 'redacted_thinking') return t("宿主未提供可读的思考内容。");
  return thinkingText(value.thinking ?? value.text ?? value.summary ?? value.content);
}
function taskTraceCards(trace, time) {
  const message = trace.message ?? {};
  if (!['user', 'assistant', 'tool'].includes(message.role)) return [];
  const parts = Array.isArray(message.content) ? message.content : [message.content];
  if (message.role === 'tool') {
    if (parts.length && parts.every(part => toolResultTypes.includes(part?.type))) {
      return parts.map(part => toolEntry(part, time, true));
    }
    return [toolEntry(message, time, true)];
  }
  const cards = [], text = [];
  let kind = message.role === 'user' ? 'user' : message.channel === 'analysis' ? 'thinking' : 'answer';
  const flushText = () => {
    if (!text.length) return;
    const content = text.some(value => value && typeof value.render === 'function') ? joinText([...text], '\n') : text.join('\n'); text.length = 0;
    if (!content) return;
    const card = traceCard(kind, time, content);
    card.append(el('pre', content, 'trace-content')); cards.push(card);
  };
  // Structured blocks are authoritative; use separate reasoning fields only when absent.
  if (message.role === 'assistant' && !parts.some(part => thinkingTypes.includes(part?.type))) {
    const reasoning = thinkingText(message.reasoning_content ?? message.thinking ?? message.reasoning);
    if (reasoning) {
      const card = traceCard('thinking', time, reasoning);
      card.append(el('pre', reasoning, 'trace-content')); cards.push(card);
    }
  }
  let imagePosition = 0;
  for (let index = 0; index < parts.length; index++) {
    const part = parts[index];
    const type = part?.type;
    const reference = imageReference(part, imagePosition + 1);
    if (reference !== undefined) {
      imagePosition++;
      const previous = parts[index - 1]?.text;
      const labelled = typeof previous === 'string' && previous.startsWith('<image name=') && previous.endsWith('>') && !previous.includes('\n');
      if (!labelled) text.push(reference);
      if (parts[index + 1]?.text === '</image>') index++;
      continue;
    }
    if (toolUseTypes.includes(type)) { flushText(); cards.push(toolEntry(part, time)); }
    else if (toolResultTypes.includes(type)) { flushText(); cards.push(toolEntry(part, time, true)); }
    else {
      const nextKind = message.role === 'user' ? 'user' : thinkingTypes.includes(type) || message.channel === 'analysis' ? 'thinking' : 'answer';
      if (kind !== nextKind) flushText();
      kind = nextKind;
      text.push(kind === 'thinking' ? thinkingText(part) : traceText(part));
    }
  }
  flushText();
  for (const call of message.tool_calls ?? []) cards.push(toolEntry(call, time));
  return cards;
}


export function taskTraceEntries(trace, time) {
  const cards = taskTraceCards(trace, time);
  const agent = trace.agentPath || trace.message?.agent_path;
  if (agent) for (const card of cards) card.children[0].append(el('span', agent, 'trace-agent'));
  return cards;
}

/** Agent is the outer scope; retain explicit project IDs, including null for unassigned. */
export function traceScopeGroups(state, agent = '') {
  return projectSessionGroups(state).map(group => {
    const sessions = group.sessions.filter(session => !agent || session.agentType === agent);
    return { ...group, sessions, turnCount: sessions.reduce((sum, session) => sum + (Number(session.turnCount) || 0), 0) };
  }).filter(group => group.sessions.length);
}
export function traceScopeSessions(groups, { project = undefined, query = '', from = '', to = '' } = {}) {
  const sessions = groups.filter(group => project === undefined || group.id === project).flatMap(group => group.sessions);
  const needle = query.trim().toLocaleLowerCase();
  return filterSessions(sessions, { from, to }, []).filter(session => !needle ||
    [session.title, session.id, session.nativeSessionId].some(value => String(value ?? '').toLocaleLowerCase().includes(needle)))
    .sort((a, b) => {
      const left = sessionUpdatedAt(a), right = sessionUpdatedAt(b);
      if (!left) return right ? 1 : String(a.id).localeCompare(String(b.id));
      if (!right) return -1;
      return compareTime(right, left) || String(a.id).localeCompare(String(b.id));
    });
}

/** Keep visible messages and contiguous execution runs in source order. */
export function taskTurnInline(group, number, time) {
  const article = el('article', '', 'trace-turn'), heading = el('div', '', 'trace-turn-heading');
  heading.append(el('strong', t("第 {0} 轮", number)), el('time', time, 'hint'));
  const executionStates = { running: t("执行中"), completed: t("执行结束"), failed: t("执行失败"), cancelled: t("已取消"), interrupted: t("已中断") };
  const captureStates = { catching_up: t("历史回填中"), collecting: t("采集中"), awaiting_children: t("等待子任务"), complete: t("采集完整"), incomplete: t("采集有缺口") };
  const states = [executionStates[group.executionStatus], captureStates[group.captureStatus]].filter(Boolean);
  if (states.length) heading.append(el('span', joinText(states), 'turn-status'));
  article.append(heading);
  let run, runSummary, previousTool;
  let thoughts = 0, calls = 0, results = 0;
  for (const trace of group.traces ?? []) {
    const occurredAt = traceOccurredAt(trace);
    const date = occurredAt ? new Date(occurredAt) : null;
    const traceTime = date && Number.isFinite(date.getTime()) ? dateText(date) : t("原始时间缺失");
    for (const card of taskTraceEntries(trace, traceTime)) {
      const kind = card.children[0].children[0].textContent;
      if (kind === 'user' || kind === 'answer') {
        run = null; previousTool = null;
        const message = el('section', '', `trace-message ${kind}`);
        const label = el('div', '', 'trace-message-heading');
        label.append(el('span', kind === 'user' ? t("你") : t("助手")), el('time', traceTime, 'hint'));
        const agent = trace.agentPath || trace.message?.agent_path;
        if (agent) label.append(el('span', agent, 'trace-agent'));
        message.append(label, ...Array.from(card.children).slice(1));
        article.append(message);
        continue;
      }
      if (!run) {
        run = el('details', '', 'trace-execution'); runSummary = el('summary', '', 'trace-execution-summary');
        run.append(runSummary); article.append(run); thoughts = 0; calls = 0; results = 0;
      }
      if (kind === 'thinking') thoughts++;
      if (kind === 'tool use') calls++;
      if (kind === 'tool result') results++;
      const counts = [thoughts ? t("{0} 段思考", thoughts) : '', calls ? t("{0} 次工具调用", calls) : '', results > calls ? t("{0} 条工具结果", results) : ''].filter(Boolean);
      setText(runSummary, t("执行过程 · {0}", joinText(counts)));
      const tool = toolIdentity.get(card);
      const scope = JSON.stringify([trace.originSessionId ?? trace.sessionId ?? '', trace.agentPath ?? trace.message?.agent_path ?? '']);
      // Pair only adjacent entries: never move a result across another message or agent step.
      if (tool?.result && tool.id && previousTool?.id === tool.id && previousTool.scope === scope) {
        const paired = previousTool.card;
        paired.className = 'task-trace trace-tool-pair';
        setText(paired.children[0].children[0], t("工具执行"));
        paired.children[0].append(el('span', tool.error ? t("执行出错") : t("已返回结果"), tool.error ? 'trace-tool-error' : 'hint'));
        paired.append(el('p', t("结果时间：{0}", traceTime), 'hint'), ...Array.from(card.children).slice(1));
        previousTool = null;
      } else {
        run.append(card);
        previousTool = tool && !tool.result && tool.id ? { id: tool.id, scope, card } : null;
      }
    }
  }
  return article;
}

export const cloudOperations = {
  'create/space': t("新建 Space"), 'get/space': t("读取 Space"), 'list/domains': t("读取领域列表"), 'get/memory': t("读取记忆概览"),
  'search/memory': t("记忆检索"), 'add/message': t("轨迹上传"), 'get/status': t("查询处理状态"),
};
export function cloudDiagnosticDetail(record) {
  const root = el('div', '', 'cloud-error-detail'), context = record.context ?? {};
  const summary = el('div', '', 'cloud-error-summary');
  const kind = { http: t("HTTP 错误"), business: t("业务错误"), timeout: t("请求超时"), network: t("连接失败"), response: t("响应异常"), processing: t("云端处理失败") };
  summary.append(el('span', record.httpStatus == null ? kind[record.kind] ?? t("调用失败") : 'HTTP ' + record.httpStatus, 'badge error'),
    el('strong', errorText(record.message)), el('small', t("{0} · {1} 次", (cloudOperations[record.endpoint] ?? record.endpoint), (record.occurrences ?? 1))));
  root.append(summary);
  const section = title => { const node = el('section', '', 'cloud-error-section'); node.append(el('h3', title)); root.append(node); return node; };
  const association = section(t("关联会话与轮次")), ids = el('dl', '', 'cloud-error-ids');
  for (const [name, value] of [
    ['Agent', context.agentType], [t("项目"), context.projectName ?? context.projectId],
    [t("会话 ID"), context.sessionId ?? t("无关联会话")], [t("轮次 ID"), context.conversationId ?? t("无关联轮次")],
    ...(context.batchId ? [[t("批次 ID"), context.batchId]] : []), ...(context.spaceId ? [['Space ID', context.spaceId]] : []),
    ...(context.taskId ? [[t("云端任务 ID"), context.taskId]] : []),
  ]) ids.append(el('dt', name), el('dd', value ?? '—', String(name).includes('ID') ? 'mono' : ''));
  association.append(ids);
  const request = section(t("云服务调用"));
  request.append(el('div', (record.method ?? 'POST') + ' ' + (record.url ?? record.endpoint), 'cloud-error-endpoint mono'));
  if (record.apiMode) request.append(el('p', record.apiMode === 'algorithm' ? t("算法接口") : t("工程接口"), 'hint'));
  const dates = el('dl', '', 'cloud-error-ids');
  for (const [name, value] of [[t("首次发生"), record.createdAt], [t("最近发生"), record.lastOccurredAt]])
    dates.append(el('dt', name), el('dd', value ? dateText(value) : '—'));
  request.append(dates);
  const response = section(t("云服务错误返回"));
  response.append(el('p', record.httpStatus == null ? t("未收到 HTTP 响应") : t("HTTP 状态：{0}{1}", record.httpStatus, (record.businessCode == null ? '' : t(" · 业务返回码：{0}", record.businessCode))), 'hint'));
  response.append(el('pre', record.responseBody == null ? t("无响应体。{0}", record.message) : record.responseBody === '' ? t("响应体为空。") : record.responseBody, 'cloud-error-response'));
  return root;
}
