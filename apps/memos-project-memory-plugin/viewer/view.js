export function el(tag, text = '', className = '') {
  const element = document.createElement(tag);
  element.textContent = text;
  if (className) element.className = className;
  return element;
}
export function details(title, value) {
  const node = el('details', '', 'detail');
  node.append(el('summary', title), el('pre', typeof value === 'string' ? value : JSON.stringify(value, null, 2)));
  return node;
}
export function statusLabel(value) {
  return ({ blocked: '上传待处理', accepted: '已接收', 'processing-failed': '云端处理失败', prepared: '已准备上下文', returned: '已返回检索结果', pending: '等待上传', waiting_space: '等待空间', creating: '创建空间中', uncertain: '创建结果待确认', uploading: '上传中', received: '已接收', uploaded: '已接收', running: '云端处理中', processing: '云端处理中', completed: '已完成', failed: '失败', stopped: '已停止重试', installed: '已安装', unavailable: '不可用', FOUND: '检索命中', EMPTY: '无匹配结果', UNAVAILABLE: '记忆暂不可用', injected: '已交付上下文', CONTEXT_MISSING: '当前轮标识无效' })[value] ?? value ?? '—';
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
  const unassigned = { id: null, name: '未归属项目', root: '', sessions: [] };
  for (const session of state.sessions ?? []) {
    if (['subagent', 'background', 'unknown'].includes(session.sourceKind)) continue;
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
export function projectTraceCard(group, selected, onOpen) {
  const card = el('button', '', `session-select project-select${selected ? ' selected' : ''}`);
  card.type = 'button'; card.setAttribute('aria-current', String(selected));
  card.append(el('strong', group.name), el('small', group.root || '尚未关联到已登记项目'),
    el('small', `${group.sessions.length} 个会话 · ${group.turnCount} 轮`, 'hint'));
  card.addEventListener('click', onOpen);
  return card;
}
export function sessionTitle(session) {
  if (typeof session.title === 'string' && session.title.trim()) return session.title;
  const id = String(session.nativeSessionId || session.id || '');
  return `未命名会话 · ${(id.startsWith('session-') ? id.slice(8) : id).slice(0, 8)}`;
}
export function sessionTraceCard(session, selected, time, onOpen) {
  const card = el('button', '', `session-select${selected ? ' selected' : ''}`);
  card.type = 'button'; card.setAttribute('aria-current', String(selected));
  card.append(el('strong', sessionTitle(session)),
    el('small', session.agentType), el('small', time), el('small', `${Number(session.turnCount) || 0} 轮`, 'hint'));
  card.addEventListener('click', onOpen);
  return card;
}

export function projectBindingTable(projects, agents, openSpaces) {
  const table = el('table', '', 'binding-table'), head = el('thead'), heading = el('tr'), body = el('tbody');
  for (const title of ['Agent', '项目名称', '已绑定 Space']) { const cell = el('th', title); cell.setAttribute('scope', 'col'); heading.append(cell); }
  head.append(heading);
  const names = new Map(agents.map(agent => [agent.agentId, agent.name]));
  for (const project of projects) {
    const row = el('tr'), agent = el('td'), name = el('td', project.name, 'binding-project-name'), spaces = el('td');
    agent.setAttribute('data-label', 'Agent'); name.setAttribute('data-label', '项目名称'); spaces.setAttribute('data-label', '已绑定 Space');
    const agentTypes = [...new Set(project.agentTypes ?? [])];
    for (const type of agentTypes) agent.append(el('span', names.get(type) ?? type, 'binding-agent'));
    if (!agentTypes.length) agent.append(el('span', '待识别', 'hint'));
    const count = project.spaceIds?.length ?? 0;
    const open = el('button', count ? `${count} 个 Space` : '未绑定 Space', 'text-button space-list-open');
    open.type = 'button'; open.setAttribute('aria-label', `查看 ${project.name} 的 Space 列表`);
    open.addEventListener('click', () => openSpaces(project, open)); spaces.append(open);
    row.append(agent, name, spaces); body.append(row);
  }
  table.append(head, body);
  return table;
}

function spaceAction(kind, label, callback) {
  const button = el('button', '', `space-icon-button${kind === 'unbind' ? ' danger' : ''}`);
  button.type = 'button'; button.title = label; button.setAttribute('aria-label', label);
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('fill', 'none'); svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.7'); svg.setAttribute('stroke-linecap', 'round'); svg.setAttribute('stroke-linejoin', 'round'); svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', kind === 'copy' ? 'M9 9h11v11H9zM15 5V3H3v12h2' : 'M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7');
  svg.append(path); button.append(svg);
  button.addEventListener('click', async () => { button.disabled = true; try { await callback(); } finally { button.disabled = false; } });
  return button;
}

export function spaceBindingItem(space, copy, unbind) {
  const item = el('li', '', 'space-binding-item'), code = el('div', '', 'space-binding-code');
  code.append(el('code', space.spaceId, 'mono'),
    spaceAction('copy', `复制 Space ID ${space.spaceId}`, () => copy(space.spaceId)),
    spaceAction('unbind', `解绑 Space ${space.name || space.spaceId}`, () => unbind(space.spaceId)));
  item.append(el('strong', space.name || '未命名 Space', 'space-binding-name'), code);
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
  const compact = text.replace(/\s+/g, ' ').trim();
  return compact.length > limit ? `${compact.slice(0, limit)}…` : compact;
}
function traceCard(title, time, preview = '') {
  const card = el('details', '', 'task-trace'), heading = el('summary', '', 'trace-heading');
  heading.append(el('strong', title), el('span', compactText(preview), 'trace-preview'), el('time', time, 'hint'));
  card.append(heading);
  return card;
}
const toolIdentity = new WeakMap();
function toolEntry(tool, time, result = false) {
  const call = tool.function ?? tool;
  const name = call.name ?? tool.tool_name ?? tool.toolName;
  const id = tool.tool_call_id ?? tool.tool_use_id ?? tool.toolCallId ?? tool.id;
  const card = traceCard(result ? 'tool result' : 'tool use', time, `${result ? '工具结果' : '工具调用'}${name ? ` · ${name}` : ''}`);
  toolIdentity.set(card, { id, result, error: !!(tool.is_error || tool.isError) });
  if (id) card.append(el('p', `调用标识：${id}`, 'hint'));
  const input = call.arguments ?? call.input ?? tool.tool_input;
  if (input !== undefined) card.append(el('p', '参数', 'trace-label'), el('pre', traceText(input), 'trace-content'));
  if (result) {
    let output = tool.content ?? tool.output ?? tool.result;
    if (typeof output === 'string') {
      try { output = JSON.parse(output); } catch { /* Plain tool output remains literal text. */ }
    }
    card.append(el('p', (tool.is_error || tool.isError) ? '错误结果' : '结果', 'trace-label'), el('pre', traceText(output), 'trace-content'));
  }
  return card;
}
const thinkingTypes = ['thinking', 'reasoning', 'reasoning_text', 'reasoning_summary_text', 'redacted_thinking'];
const toolUseTypes = ['tool_use', 'tool-call', 'tool_call', 'toolCall'];
const toolResultTypes = ['tool_result', 'tool-result'];
function thinkingText(value) {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(thinkingText).filter(Boolean).join('\n');
  if (!value || typeof value !== 'object') return '';
  if (value.type === 'redacted_thinking') return '宿主未提供可读的思考内容。';
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
    const content = text.join('\n'); text.length = 0;
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

export function taskTurnCard(group, number, time, onOpen) {
  const entries = group.traces.flatMap((trace) => taskTraceEntries(trace, ''));
  const task = entries.find(entry => entry.children[0].children[0].textContent === 'user');
  const title = compactText(task?.children[1]?.textContent ?? '', 120) || '查看任务轨迹';
  const card = el('button', '', 'turn-card'); card.type = 'button';
  const heading = el('div', '', 'turn-heading');
  heading.append(el('strong', `第 ${number} 轮`), el('time', time, 'hint'), el('span', '查看详情 →', 'turn-open'));
  const counts = ['user', 'tool use', 'tool result', 'thinking', 'answer'].map((label) => {
    const count = entries.filter((entry) => entry.children[0].children[0].textContent === label).length;
    return count ? `${label} ${count}` : '';
  }).filter(Boolean);
  card.append(heading, el('p', title, 'turn-title'), el('small', counts.join(' · '), 'hint'));
  const execution = { running: '执行中', completed: '执行结束', failed: '执行失败', cancelled: '已取消', interrupted: '已中断' };
  const capture = { catching_up: '历史回填中', collecting: '采集中', awaiting_children: '等待子任务', complete: '采集完整', incomplete: '采集有缺口' };
  const states = [execution[group.executionStatus], capture[group.captureStatus]].filter(Boolean);
  if (states.length) card.append(el('small', states.join(' · '), 'turn-status'));
  card.addEventListener('click', onOpen);
  return card;
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
      const left = sessionStartedAt(a), right = sessionStartedAt(b);
      if (!left) return right ? 1 : String(a.id).localeCompare(String(b.id));
      if (!right) return -1;
      return compareTime(right, left) || String(a.id).localeCompare(String(b.id));
    });
}

/** Keep visible messages and contiguous execution runs in source order. */
export function taskTurnInline(group, number, time) {
  const article = el('article', '', 'trace-turn'), heading = el('div', '', 'trace-turn-heading');
  heading.append(el('strong', `第 ${number} 轮`), el('time', time, 'hint'));
  const executionStates = { running: '执行中', completed: '执行结束', failed: '执行失败', cancelled: '已取消', interrupted: '已中断' };
  const captureStates = { catching_up: '历史回填中', collecting: '采集中', awaiting_children: '等待子任务', complete: '采集完整', incomplete: '采集有缺口' };
  const states = [executionStates[group.executionStatus], captureStates[group.captureStatus]].filter(Boolean);
  if (states.length) heading.append(el('span', states.join(' · '), 'turn-status'));
  article.append(heading);
  let run, runSummary, previousTool;
  let thoughts = 0, calls = 0, results = 0;
  for (const trace of group.traces ?? []) {
    const occurredAt = traceOccurredAt(trace);
    const date = occurredAt ? new Date(occurredAt) : null;
    const traceTime = date && Number.isFinite(date.getTime()) ? date.toLocaleString('zh-CN', { hour12: false }) : '原始时间缺失';
    for (const card of taskTraceEntries(trace, traceTime)) {
      const kind = card.children[0].children[0].textContent;
      if (kind === 'user' || kind === 'answer') {
        run = null; previousTool = null;
        const message = el('section', '', `trace-message ${kind}`);
        const label = el('div', '', 'trace-message-heading');
        label.append(el('span', kind === 'user' ? '你' : '助手'), el('time', traceTime, 'hint'));
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
      const counts = [thoughts ? `${thoughts} 段思考` : '', calls ? `${calls} 次工具调用` : '', results > calls ? `${results} 条工具结果` : ''].filter(Boolean);
      runSummary.textContent = `执行过程 · ${counts.join(' · ')}`;
      const tool = toolIdentity.get(card);
      const scope = JSON.stringify([trace.originSessionId ?? trace.sessionId ?? '', trace.agentPath ?? trace.message?.agent_path ?? '']);
      // Pair only adjacent entries: never move a result across another message or agent step.
      if (tool?.result && tool.id && previousTool?.id === tool.id && previousTool.scope === scope) {
        const paired = previousTool.card;
        paired.className = 'task-trace trace-tool-pair';
        paired.children[0].children[0].textContent = '工具执行';
        paired.children[0].append(el('span', tool.error ? '执行出错' : '已返回结果', tool.error ? 'trace-tool-error' : 'hint'));
        paired.append(el('p', `结果时间：${traceTime}`, 'hint'), ...Array.from(card.children).slice(1));
        previousTool = null;
      } else {
        run.append(card);
        previousTool = tool && !tool.result && tool.id ? { id: tool.id, scope, card } : null;
      }
    }
  }
  return article;
}
