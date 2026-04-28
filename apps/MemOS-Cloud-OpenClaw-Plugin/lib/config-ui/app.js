const APP = {
  token: __CONFIG_UI_TOKEN__,
  fieldGroups: __FIELD_GROUPS__,
  fieldDefinitions: __FIELD_DEFINITIONS__,
};

const knownKeys = new Set(APP.fieldDefinitions.map((field) => field.key));
let remoteState = null;
let draft = null;
let baselineSnapshot = "";



let externalRefreshQueued = false;
let heartbeatBootId = "";
let heartbeatAssetRevision = "";
let heartbeatReloadQueued = false;
let authRecoveryInProgress = false;
let authRecoveryReloadQueued = false;
let authRecoveryRetryAt = 0;
let activeSectionId = "";
let activeSectionObserver = null;
let navCollapsed = false;
const navCollapseMedia = window.matchMedia("(max-width: 720px)");

const elements = {
  eyebrowText: document.getElementById("eyebrowText"),
  heroTitle: document.getElementById("heroTitle"),
  heroSubtitle: document.getElementById("heroSubtitle"),
  activeConfigTitle: document.getElementById("activeConfigTitle"),
  activeConfigText: document.getElementById("activeConfigText"),
  editingModelTitle: document.getElementById("editingModelTitle"),
  editingModelText: document.getElementById("editingModelText"),
  langLabel: document.getElementById("langLabel"),
  languageDropdown: document.getElementById("languageDropdown"),
  languageSelectButton: document.getElementById("languageSelectButton"),
  languageSelectText: document.getElementById("languageSelectText"),
  languageMenu: document.getElementById("languageMenu"),
  languageOptionAuto: document.getElementById("languageOptionAuto"),
  languageOptionEn: document.getElementById("languageOptionEn"),
  languageOptionZh: document.getElementById("languageOptionZh"),
  statusRow: document.getElementById("statusRow"),
  metaRow: document.getElementById("metaRow"),
  banner: document.getElementById("banner"),
  floatingTools: document.getElementById("floatingTools"),
  floatingNavLabel: document.getElementById("floatingNavLabel"),
  floatingNav: document.getElementById("floatingNav"),
  floatingToggleButton: document.getElementById("floatingToggleButton"),
  backTopButton: document.getElementById("backTopButton"),
  pathBox: document.getElementById("pathBox"),
  copyPathButton: document.getElementById("copyPathButton"),
  saveButton: document.getElementById("saveButton"),

  reloadButton: document.getElementById("reloadButton"),
  layout: document.getElementById("layout"),
  overlay: document.getElementById("overlay"),
  overlayTitle: document.getElementById("overlayTitle"),
  overlayText: document.getElementById("overlayText"),
  overlayRefreshButton: document.getElementById("overlayRefreshButton"),
};

const languagePreferenceKey = "memos-config-ui-language";
let languagePreference = localStorage.getItem(languagePreferenceKey) || "auto";
let languageMenuOpen = false;

const UI_TEXT = {
  en: {
    langLabel: "Language",
    auto: "Auto",
    floatingNavLabel: "Navigate",
    collapseNav: "Collapse Navigation",
    expandNav: "Expand Navigation",
    backToTop: "Back To Top",
    eyebrow: "MemOS Cloud OpenClaw Plugin",
    heroTitle: "Config",
    heroSubtitle:
      "This page reads and writes plugins.entries.memos-cloud-openclaw-plugin.config from the active gateway config file and keeps the form synced with on-disk changes.",
    activeConfigTitle: "Active Config File",
    activeConfigText: "The page automatically follows the current runtime profile and local config path.",
    editingModelTitle: "Editing Model",
    editingModelText:
      "Known plugin fields are rendered as typed controls. Unknown keys stay in the extra JSON section so future custom fields are not lost.",
    save: "Save Config",
    restart: "Restart Gateway",
    reload: "Reload From Disk",
    refreshPage: "Refresh Page",
    copyPath: "Copy Config Path",
    overlayTitle: "Restarting Gateway",
    overlayText: "Restart requested. Refresh this page in a few seconds if it does not recover automatically.",
    pluginEnabled: "Plugin Enabled",
    enabledDesc:
      "Saving with this switch off keeps the entry in the config but disables the plugin. The page will disappear after the gateway restarts because the plugin will stop loading.",
    extraTitle: "Extra JSON Fields",
    extraDesc: "Any unknown plugin config keys stay here so future custom fields are preserved instead of being dropped.",
    extraHelper: "Use plain JSON. Leave empty if you do not need extra keys.",
    clear: "Clear",
    reset: "Reset",
    show: "Show",
    hide: "Hide",
    enabled: "Enabled",
    disabled: "Disabled",
    env: "Env",
    inherit: "Default",
    custom: "Custom",
    on: "On",
    off: "Off",
    empty: "empty",
    helperBoolean: "Default means the plugin falls back to env files or runtime defaults.",
    helperJson: "Only JSON objects are accepted here.",
    helperArray: "One value per line. Empty lines are ignored.",
    helperDefault: "Leave this as default to remove the key from plugin config.",
    helperEnvValue: "Using env value: ",
    helperProjectDefault: "Using project default: ",
    helperEmptyValue: "No config value is set for this field.",
    errorInteger: "Enter a valid integer.",
    errorNumber: "Enter a valid number.",
    errorJsonObject: "JSON must be an object.",
    errorJsonInvalid: "Invalid JSON.",
    bannerExternal: "A newer on-disk config is available. Reload from disk to sync before saving.",
    bannerErrors: "Please fix the highlighted field errors before saving.",
    bannerWaiting: "Config saved! Please restart the gateway manually to apply changes.",
    bannerDirty: "You have unsaved changes.",
    bannerInclude: "An $include directive was detected. This page writes overrides to the main config file.",
    bannerSynced: "The page synced a newer on-disk config.",
    bannerRestarted: "Gateway restart completed and the page is live again.",
    bannerHeartbeatRecovered: "Gateway connection restored. Reloading the config page...",
    bannerAuthRecovered: "Config session expired, but the gateway is healthy. Reloading this page...",
    bannerAuthWaiting: "Config session expired. Waiting for the gateway to finish restarting before retrying...",
    bannerAuthFailed: "Config session expired. Refresh this page to reconnect.",
    bannerCopied: "The config file path was copied to your clipboard.",
    bannerClipboardFailed: "Clipboard access failed. Copy the address from your browser bar instead.",
    bannerSaved: "The plugin config was saved.",
    bannerRestartLaunched: "Restart requested. Refresh this page in a few seconds if it does not recover automatically.",
    bannerWaitingStop: "Restart requested. Refresh this page in a few seconds if it does not recover automatically.",
    bannerWaitingBack: "Restart requested. Refresh this page in a few seconds if it does not recover automatically.",
    bannerRestartRefreshHint: "Restart requested. Refresh this page in a few seconds if it does not recover automatically.",
    pillPlugin: "Plugin",
    pillRuntime: "Runtime",
    pillEntry: "Entry",
    pillPageUrl: "Page URL",
    pillRevision: "Revision",
    pillConfigFile: "Config file",
    pillInclude: "Include",
    pillEntryPresent: "present",
    pillEntryMissing: "missing",
    pillConfigFound: "found",
    pillConfigCreate: "will be created",
    pillIncludeValue: "Found $include; this page writes to the main file only",
  },
  zh: {
    langLabel: "语言",
    auto: "跟随浏览器",
    floatingNavLabel: "区域导航",
    collapseNav: "收起导航",
    expandNav: "展开导航",
    backToTop: "返回顶部",
    eyebrow: "MemOS Cloud OpenClaw Plugin",
    heroTitle: "配置页",
    heroSubtitle:
      "这个页面会直接读取并写回当前 gateway 配置文件中的 plugins.entries.memos-cloud-openclaw-plugin.config，并自动同步磁盘变更。",
    activeConfigTitle: "当前配置文件",
    activeConfigText: "页面会自动跟随当前宿主运行时，读取对应的本地配置路径。",
    editingModelTitle: "编辑方式",
    editingModelText: "已知字段会以结构化表单展示；未知字段会保留在额外 JSON 区域，避免未来自定义配置被覆盖丢失。",
    save: "保存配置",
    restart: "重启 Gateway",
    reload: "从磁盘重新加载",
    refreshPage: "刷新页面",
    copyPath: "复制配置文件路径",
    overlayTitle: "正在重启 Gateway",
    overlayText: "已请求重启。如果页面没有自动恢复，请过几秒点击刷新重试。",
    pluginEnabled: "插件启用状态",
    enabledDesc: "关闭后仍会保留插件配置项，但插件会在重启后停用，页面也会随之消失。",
    extraTitle: "额外 JSON 字段",
    extraDesc: "这里会保留当前 schema 之外的自定义键，避免未来字段在保存时丢失。",
    extraHelper: "这里只接受 JSON 对象；如果不需要额外字段可以留空。",
    clear: "清空",
    reset: "重置",
    show: "显示",
    hide: "隐藏",
    enabled: "启用",
    disabled: "停用",
    env: "环境变量",
    inherit: "默认",
    custom: "自定义",
    on: "开",
    off: "关",
    empty: "空",
    helperBoolean: "选择默认时，会回退到环境变量或运行时默认值。",
    helperJson: "这里只接受 JSON 对象。",
    helperArray: "每行一个值，空行会自动忽略。",
    helperDefault: "选择默认后会从插件配置里移除这个字段。",
    helperEnvValue: "当前使用环境变量值：",
    helperProjectDefault: "当前使用项目默认值：",
    helperEmptyValue: "这个字段当前没有配置值。",
    errorInteger: "请输入有效的整数。",
    errorNumber: "请输入有效的数字。",
    errorJsonObject: "这里必须填写 JSON 对象。",
    errorJsonInvalid: "JSON 格式不正确。",
    bannerExternal: "磁盘上的配置已经更新，请先重新加载再决定是否保存。",
    bannerErrors: "请先修正高亮字段的错误，再执行保存。",
    bannerWaiting: "配置已保存，请手动重启 gateway 以使配置生效。",
    bannerDirty: "你有尚未保存的修改。",
    bannerInclude: "检测到 $include 指令，本页面会把覆盖项写入主配置文件。",
    bannerSynced: "页面已经同步到更新后的磁盘配置。",
    bannerRestarted: "Gateway 已重新启动，配置页面也恢复可用。",
    bannerHeartbeatRecovered: "Gateway 连接已恢复，正在重新加载配置页面...",
    bannerAuthRecovered: "配置页会话已过期，但 Gateway 仍然在线，正在自动刷新页面...",
    bannerAuthWaiting: "配置页会话已过期，正在等待 Gateway 完成重启后再恢复...",
    bannerAuthFailed: "配置页会话已过期，请刷新页面后重新连接。",
    bannerCopied: "配置文件路径已复制到剪贴板。",
    bannerClipboardFailed: "复制失败，请直接从浏览器地址栏复制。",
    bannerSaved: "插件配置已保存。",
    bannerRestartLaunched: "已请求重启。如果页面没有自动恢复，请过几秒刷新重试。",
    bannerWaitingStop: "已请求重启。如果页面没有自动恢复，请过几秒刷新重试。",
    bannerWaitingBack: "已请求重启。如果页面没有自动恢复，请过几秒刷新重试。",
    bannerRestartRefreshHint: "已请求重启。如果页面没有自动恢复，请过几秒刷新重试。",
    pillPlugin: "插件",
    pillRuntime: "运行时",
    pillEntry: "配置项",
    pillPageUrl: "页面地址",
    pillRevision: "版本标识",
    pillConfigFile: "配置文件",
    pillInclude: "包含",
    pillEntryPresent: "已存在",
    pillEntryMissing: "不存在",
    pillConfigFound: "已找到",
    pillConfigCreate: "将自动创建",
    pillIncludeValue: "检测到 $include；本页面只会写入主配置文件",
  },
};

const GROUP_TRANSLATIONS = {
  zh: {
    connection: { title: "连接与鉴权", description: "MemOS 地址、鉴权和身份映射相关配置。" },
    session: { title: "会话与召回", description: "会话 ID 策略、召回范围以及上下文注入行为。" },
    capture: { title: "写回与存储", description: "控制每轮结束后写回到 MemOS 的内容。" },
    agent: { title: "Agent 隔离", description: "多 Agent 隔离、App 元数据与共享权限。" },
    filter: { title: "召回过滤器", description: "在记忆注入前，使用模型做二次筛选。" },
    advanced: { title: "高级设置", description: "超时、重试、节流和其他底层控制项。" },
  },
};

const FIELD_TRANSLATIONS = {
  zh: {
    baseUrl: { label: "MemOS 地址", description: "MemOS OpenMem API 的基础地址。" },
    apiKey: { label: "MemOS API Key", description: "Token 鉴权密钥。未在此处填写时，将从 .env 文件中读取。" },
    userId: { label: "用户 ID", description: "消息添加与记忆查询关联的用户唯一标识符。" },
    useDirectSessionUserId: { label: "使用 Direct 会话用户 ID", description: "可用时从 session key 的 direct 段提取用户 ID，覆盖默认 userId。" },
    conversationId: { label: "会话 ID 覆盖", description: "消息添加与记忆查询关联的会话唯一标识符；同一 ID 会被视为同一上下文。" },
    conversationIdPrefix: { label: "会话前缀", description: "追加到自动生成 conversation_id 前面的文本。" },
    conversationIdSuffix: { label: "会话后缀", description: "追加到自动生成 conversation_id 后面的文本。" },
    conversationSuffixMode: { label: "后缀模式", description: "决定 /new 是否递增数字后缀。" },
    resetOnNew: { label: "/new 时重置", description: "在使用 counter 模式时需要 hooks.internal.enabled。" },
    queryPrefix: { label: "查询前缀", description: "附加在 query 前面的文本，用于补充检索上下文。" },
    maxQueryChars: { label: "查询最大长度", description: "限制单次查询文本长度，避免 query 过长。" },
    recallEnabled: { label: "启用召回", description: "控制 before_agent_start 阶段是否执行记忆召回。" },
    recallGlobal: { label: "全局召回", description: "开启后查询不传 conversation_id，不再强调当前会话权重。" },
    maxItemChars: { label: "注入项最大长度", description: "限制单条召回记忆注入上下文时保留的字符数。" },
    memoryLimitNumber: { label: "记忆数量上限", description: "召回事实记忆的最大条数；默认 9，最大 25。" },
    preferenceLimitNumber: { label: "偏好数量上限", description: "召回偏好记忆的最大条数；默认 9，最大 25。" },
    includePreference: { label: "包含偏好", description: "是否启用偏好记忆召回。" },
    includeToolMemory: { label: "包含工具记忆", description: "是否启用工具记忆召回。" },
    toolMemoryLimitNumber: { label: "工具记忆上限", description: "工具记忆返回条数上限，仅在启用工具记忆时生效；默认 6，最大 25。" },
    relativity: { label: "相关度阈值", description: "召回相关性阈值，范围 0 到 1；为 0 时不做相关性过滤。" },
    filter: { label: "搜索过滤器（JSON）", description: "检索前的过滤条件，支持 agent_id、app_id、时间字段和 info 字段，以及 and/or/gte/lte/gt/lt。" },
    knowledgebaseIds: { label: "知识库 ID", description: "限制本次可检索的知识库范围；每行一个 ID，也可填写 all。" },
    addEnabled: { label: "启用写回", description: "控制 agent_end 阶段是否添加消息并写入记忆。" },
    captureStrategy: { label: "捕获策略", description: "决定写入最后一轮消息，还是写入整段会话消息数组。" },
    maxMessageChars: { label: "消息最大长度", description: "限制每条写入消息保留的字符数，用于控制 messages 内容大小。" },
    includeAssistant: { label: "包含助手回复", description: "是否把 assistant 回复也写入 messages 数组。" },
    tags: { label: "标签", description: "自定义标签列表，用于标记消息主题或分类；每行一个。" },
    info: { label: "附加信息（JSON）", description: "自定义结构化元信息，用于记录来源、版本、位置等，并支持后续精确过滤。" },
    asyncMode: { label: "异步模式", description: "是否异步添加记忆；开启后会在后台写入，减少调用链阻塞。" },
    agentId: { label: "固定 Agent ID", description: "消息或检索关联的 Agent 唯一标识符，用于区分某用户与该 Agent 的专属记忆。" },
    multiAgentMode: { label: "多 Agent 模式", description: "按 ctx.agentId 隔离召回与写回数据。" },
    allowedAgents: { label: "允许的 Agent 列表", description: "仅允许列表内 agent 执行召回与写回；留空表示允许全部 agent。" },
    agentOverrides: { label: "Agent 覆盖配置（JSON）", description: "按 agent 维度覆盖配置。键为 agent id，值为可覆盖字段对象。" },
    appId: { label: "App ID", description: "消息或检索关联的应用唯一标识符，用于区分某用户在该 App 下的专属记忆。" },
    allowPublic: { label: "允许公开", description: "是否允许把生成的记忆写入公共记忆库；开启后项目中的其他用户也可能检索到。" },
    allowKnowledgebaseIds: { label: "允许写入的知识库 ID", description: "消息生成的记忆允许写入的知识库范围；每行一个 ID。" },
    recallFilterEnabled: { label: "启用召回过滤器", description: "召回结果在注入前先经过模型二次筛选。" },
    recallFilterBaseUrl: { label: "过滤器地址", description: "用于召回过滤的 OpenAI 兼容接口地址。" },
    recallFilterApiKey: { label: "过滤器 API Key", description: "召回过滤模型接口所需的 Bearer Token。" },
    recallFilterModel: { label: "过滤模型", description: "召回过滤阶段使用的模型名称。" },
    recallFilterTimeoutMs: { label: "过滤超时（毫秒）", description: "召回过滤模型请求的超时时间。" },
    recallFilterRetries: { label: "过滤重试次数", description: "召回过滤请求失败后的重试次数。" },
    recallFilterCandidateLimit: { label: "候选数量上限", description: "每类候选项在过滤前的最大数量。" },
    recallFilterMaxItemChars: { label: "过滤项最大长度", description: "送入过滤模型前，单条候选项允许保留的字符数。" },
    recallFilterFailOpen: { label: "失败时放行", description: "过滤器失败时回退为不过滤，直接使用原始召回结果。" },
    timeoutMs: { label: "MemOS 超时（毫秒）", description: "调用 MemOS API 时使用的超时时间。" },
    retries: { label: "MemOS 重试次数", description: "调用 MemOS API 失败时的重试次数。" },
    throttleMs: { label: "节流时间（毫秒）", description: "两次写回间隔过短时跳过 add/message。" },
  },
};

function getCurrentLanguage() {
  if (languagePreference === "zh" || languagePreference === "en") {
    return languagePreference;
  }
  const browserLanguage = String(navigator.language || "").toLowerCase();
  return browserLanguage.startsWith("zh") ? "zh" : "en";
}

function uiText(key) {
  const lang = getCurrentLanguage();
  return UI_TEXT[lang][key] ?? UI_TEXT.en[key] ?? key;
}

function localizedGroup(group) {
  const lang = getCurrentLanguage();
  const translated = GROUP_TRANSLATIONS[lang]?.[group.id];
  return translated ? { ...group, ...translated } : group;
}

function localizedField(definition) {
  const lang = getCurrentLanguage();
  const translated = FIELD_TRANSLATIONS[lang]?.[definition.key];
  return translated ? { ...definition, ...translated } : definition;
}

function applyLanguageUi() {
  document.documentElement.lang = getCurrentLanguage();
//   document.title = uiText("heroTitle");
  elements.eyebrowText.textContent = uiText("eyebrow");
  elements.heroTitle.textContent = uiText("heroTitle");
  elements.heroSubtitle.innerHTML = escapeHtml(uiText("heroSubtitle")).replace(
    "plugins.entries.memos-cloud-openclaw-plugin.config",
    "<code>plugins.entries.memos-cloud-openclaw-plugin.config</code>",
  );
  elements.activeConfigTitle.textContent = uiText("activeConfigTitle");
  elements.activeConfigText.textContent = uiText("activeConfigText");
  elements.editingModelTitle.textContent = uiText("editingModelTitle");
  elements.editingModelText.textContent = uiText("editingModelText");
  elements.langLabel.textContent = uiText("langLabel");
  elements.floatingNavLabel.textContent = uiText("floatingNavLabel");
  updateFloatingNavToggleUi();
  elements.backTopButton.setAttribute("aria-label", uiText("backToTop"));
  elements.backTopButton.setAttribute("title", uiText("backToTop"));
  elements.copyPathButton.setAttribute("aria-label", uiText("copyPath"));
  elements.copyPathButton.setAttribute("title", uiText("copyPath"));
  elements.saveButton.textContent = uiText("save");

  elements.reloadButton.textContent = uiText("reload");
  elements.overlayTitle.textContent = uiText("overlayTitle");
  elements.overlayText.textContent = uiText("overlayText");
  elements.overlayRefreshButton.setAttribute("aria-label", uiText("refreshPage"));
  elements.overlayRefreshButton.setAttribute("title", uiText("refreshPage"));
  elements.languageOptionAuto.textContent = uiText("auto");
  elements.languageOptionEn.textContent = "EN";
  elements.languageOptionZh.textContent = "中文";
  updateLanguageDropdownUi();
}

function updateFloatingNavToggleUi() {
  elements.floatingToggleButton.setAttribute("aria-expanded", navCollapsed ? "false" : "true");
  elements.floatingToggleButton.setAttribute("aria-label", navCollapsed ? uiText("expandNav") : uiText("collapseNav"));
  elements.floatingToggleButton.setAttribute("title", navCollapsed ? uiText("expandNav") : uiText("collapseNav"));
}

function setNavCollapsed(nextCollapsed) {
  navCollapsed = Boolean(nextCollapsed);
  document.body.classList.toggle("nav-collapsed", navCollapsed);
  updateFloatingNavToggleUi();
}

function syncNavCollapseForViewport() {
  setNavCollapsed(navCollapseMedia.matches);
}

function setLanguagePreference(nextLanguage) {
  languagePreference = nextLanguage;
  localStorage.setItem(languagePreferenceKey, nextLanguage);
  applyLanguageUi();
  if (draft) {
    renderForm();
  }
}

function getLanguageOptionLabel(value) {
  if (value === "en") return "EN";
  if (value === "zh") return "中文";
  return uiText("auto");
}

function setLanguageMenuOpen(nextOpen) {
  languageMenuOpen = nextOpen;
  elements.languageDropdown.classList.toggle("open", nextOpen);
  elements.languageSelectButton.setAttribute("aria-expanded", nextOpen ? "true" : "false");
}

function updateLanguageDropdownUi() {
  const currentValue = languagePreference;
  elements.languageSelectText.textContent = getLanguageOptionLabel(currentValue);

  const options = [
    { element: elements.languageOptionAuto, value: "auto" },
    { element: elements.languageOptionEn, value: "en" },
    { element: elements.languageOptionZh, value: "zh" },
  ];

  for (const option of options) {
    const active = option.value === currentValue;
    option.element.classList.toggle("active", active);
    option.element.setAttribute("aria-selected", active ? "true" : "false");
  }
}

function renderFloatingNav(groups) {
  elements.floatingNav.innerHTML = "";
  for (const group of groups) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "floating-link" + (activeSectionId === group.id ? " active" : "");
    button.textContent = group.title;
    button.addEventListener("click", () => {
      activeSectionId = group.id;
      renderFloatingNav(groups);
      document.getElementById(`section-${group.id}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
    elements.floatingNav.appendChild(button);
  }
}

function updateFloatingVisibility() {
  const visible = window.scrollY > 240;
  elements.backTopButton.classList.toggle("is-visible", visible);
}

function installSectionObserver(groups) {
  if (activeSectionObserver) {
    activeSectionObserver.disconnect();
    activeSectionObserver = null;
  }

  const visibleSections = new Map();
  activeSectionObserver = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        const sectionId = entry.target.dataset.sectionId;
        if (!sectionId) continue;
        if (entry.isIntersecting) {
          visibleSections.set(sectionId, entry.intersectionRatio);
        } else {
          visibleSections.delete(sectionId);
        }
      }

      if (!visibleSections.size) return;

      let nextActive = activeSectionId;
      let maxRatio = -1;
      for (const group of groups) {
        const ratio = visibleSections.get(group.id);
        if (ratio !== undefined && ratio > maxRatio) {
          maxRatio = ratio;
          nextActive = group.id;
        }
      }

      if (nextActive && nextActive !== activeSectionId) {
        activeSectionId = nextActive;
        renderFloatingNav(groups);
      }
    },
    {
      rootMargin: "-12% 0px -55% 0px",
      threshold: [0.15, 0.3, 0.45, 0.6],
    },
  );

  for (const group of groups) {
    const section = document.getElementById(`section-${group.id}`);
    if (section) {
      activeSectionObserver.observe(section);
    }
  }
}

function splitConfig(config) {
  const known = {};
  const extra = {};
  for (const [key, value] of Object.entries(config || {})) {
    if (knownKeys.has(key)) {
      known[key] = value;
    } else {
      extra[key] = value;
    }
  }
  return { known, extra };
}

function createFieldDraft(definition, hasValue, value, meta = null) {
  const inheritedValue = meta?.inheritedValue;
  if (definition.type === "boolean") {
    return {
      mode: hasValue ? (value === false ? "false" : "true") : "inherit",
      text: "",
      inheritedValue,
      inheritedSource: meta?.source || "empty",
      uiDefaultValue: meta?.uiDefaultValue,
    };
  }

  return {
    mode: hasValue ? "set" : "inherit",
    text: hasValue ? toFieldText(definition, value) : toFieldText(definition, inheritedValue),
    inheritedValue,
    inheritedSource: meta?.source || "empty",
    uiDefaultValue: meta?.uiDefaultValue,
  };
}

function toFieldText(definition, value) {
  if (value === undefined || value === null) return "";
  if (definition.type === "json") return JSON.stringify(value, null, 2);
  if (definition.type === "stringArray") return Array.isArray(value) ? value.join("\n") : "";
  return String(value);
}

function createDraftFromRemote(state) {
  const { known, extra } = splitConfig(state.config || {});
  const fields = {};

  for (const definition of APP.fieldDefinitions) {
    const hasValue = Object.prototype.hasOwnProperty.call(known, definition.key);
    fields[definition.key] = createFieldDraft(definition, hasValue, known[definition.key], state.fieldMeta?.[definition.key] || null);
  }

  return {
    enabled: state.enabled !== false,
    fields,
    extraText: Object.keys(extra).length > 0 ? JSON.stringify(extra, null, 2) : "",
  };
}

function getDraftSnapshot() {
  return JSON.stringify(draft);
}

function isDirty() {
  return draft && getDraftSnapshot() !== baselineSnapshot;
}

function parseField(definition, fieldDraft) {
  if (!fieldDraft) return { value: undefined };

  if (definition.type === "boolean") {
    if (fieldDraft.mode === "inherit") return { value: undefined };
    return { value: fieldDraft.mode === "true" };
  }

  if (fieldDraft.mode === "inherit") {
    return { value: undefined };
  }

  const text = String(fieldDraft.text || "");

  if (definition.type === "string" || definition.type === "secret" || definition.type === "textarea") {
    const trimmed = text.trim();
    return { value: trimmed ? text : undefined };
  }

  if (definition.type === "integer") {
    const trimmed = text.trim();
    if (!trimmed) return { value: undefined };
    const parsed = Number(trimmed);
    if (!Number.isInteger(parsed)) return { error: uiText("errorInteger") };
    return { value: parsed };
  }

  if (definition.type === "number") {
    const trimmed = text.trim();
    if (!trimmed) return { value: undefined };
    const parsed = Number(trimmed);
    if (!Number.isFinite(parsed)) return { error: uiText("errorNumber") };
    return { value: parsed };
  }

  if (definition.type === "enum") {
    const trimmed = text.trim();
    return { value: trimmed || undefined };
  }

  if (definition.type === "stringArray") {
    const lines = text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    return { value: lines.length > 0 ? lines : undefined };
  }

  if (definition.type === "json") {
    const trimmed = text.trim();
    if (!trimmed) return { value: undefined };
    try {
      const parsed = JSON.parse(trimmed);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        return { error: uiText("errorJsonObject") };
      }
      return { value: parsed };
    } catch {
      return { error: uiText("errorJsonInvalid") };
    }
  }

  return { value: undefined };
}

function collectDraft() {
  const config = {};
  const errors = {};

  for (const definition of APP.fieldDefinitions) {
    const result = parseField(definition, draft.fields[definition.key]);
    if (result.error) {
      errors[definition.key] = result.error;
      continue;
    }
    if (result.value !== undefined) {
      config[definition.key] = result.value;
    }
  }

  const extraText = String(draft.extraText || "").trim();
  if (extraText) {
    try {
      const parsed = JSON.parse(extraText);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        errors.__extra = uiText("errorJsonObject");
      } else {
        Object.assign(config, parsed);
      }
    } catch {
      errors.__extra = uiText("errorJsonInvalid");
    }
  }

  return { config, errors };
}

function setBanner(kind, message) {
  if (!message) {
    elements.banner.className = "banner";
    elements.banner.textContent = "";
    return;
  }
  elements.banner.className = "banner show " + kind;
  elements.banner.textContent = message;
}

function setOverlay(visible, title, text) {
  elements.overlay.className = visible ? "overlay show" : "overlay";
  if (title) elements.overlayTitle.textContent = title;
  if (text) elements.overlayText.textContent = text;
}

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function createPill(className, label, value) {
  const div = document.createElement("div");
  div.className = "pill " + className;
  div.innerHTML = "<strong>" + escapeHtml(label) + "</strong><span>" + escapeHtml(value) + "</span>";
  return div;
}

function renderSegmentButton(label, active, onClick) {
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = label;
  button.className = active ? "active" : "";
  button.addEventListener("click", onClick);
  return button;
}

function formatInheritedValue(definition, value) {
  if (value === undefined || value === null) return uiText("empty");
  if (definition.type === "boolean") return value ? uiText("on") : uiText("off");
  if (definition.type === "secret") {
    const text = String(value || "");
    if (!text) return uiText("empty");
    if (text.length <= 6) return "••••••";
    return `${text.slice(0, 3)}••••${text.slice(-2)}`;
  }
  if (definition.type === "json") return JSON.stringify(value);
  if (definition.type === "stringArray") return Array.isArray(value) ? (value.length ? value.join(", ") : uiText("empty")) : uiText("empty");
  const text = String(value);
  return text.trim() ? text : uiText("empty");
}

function booleanStateLabel(mode) {
  if (mode === "true") return uiText("on");
  if (mode === "false") return uiText("off");
  return uiText("inherit");
}

function helperText(definition) {
  const fieldDraft = draft?.fields?.[definition.key];
  if (fieldDraft?.mode === "inherit") {
    if (fieldDraft.inheritedSource === "env") {
      return uiText("helperEnvValue") + formatInheritedValue(definition, fieldDraft.inheritedValue);
    }
    if (fieldDraft.inheritedSource === "default") {
      return uiText("helperProjectDefault") + formatInheritedValue(definition, fieldDraft.inheritedValue);
    }
    return uiText("helperEmptyValue");
  }
  if (definition.type === "boolean") return uiText("helperBoolean");
  if (definition.type === "json") return uiText("helperJson");
  if (definition.type === "stringArray") return uiText("helperArray");
  return uiText("helperDefault");
}

function renderStatus() {
  elements.statusRow.innerHTML = "";
  elements.metaRow.innerHTML = "";
  elements.pathBox.textContent = remoteState ? remoteState.configPath : "";
  if (!remoteState) return;

  elements.statusRow.appendChild(
    createPill(remoteState.enabled ? "ok" : "warn", uiText("pillPlugin"), remoteState.enabled ? uiText("enabled") : uiText("disabled")),
  );
  elements.statusRow.appendChild(createPill("", uiText("pillRuntime"), remoteState.runtimeDisplayName));
  elements.statusRow.appendChild(
    createPill(remoteState.entryExists ? "" : "warn", uiText("pillEntry"), remoteState.entryExists ? uiText("pillEntryPresent") : uiText("pillEntryMissing")),
  );
  elements.metaRow.appendChild(createPill("", uiText("pillPageUrl"), window.location.origin));
  elements.metaRow.appendChild(createPill("", uiText("pillRevision"), remoteState.revision));
  elements.metaRow.appendChild(
    createPill(remoteState.fileExists ? "" : "warn", uiText("pillConfigFile"), remoteState.fileExists ? uiText("pillConfigFound") : uiText("pillConfigCreate")),
  );
  if (remoteState.hasInclude) {
    elements.metaRow.appendChild(
      createPill("warn", uiText("pillInclude"), uiText("pillIncludeValue")),
    );
  }
}

function renderEnabledField() {
  const field = document.createElement("div");
  field.className = "field";
  field.innerHTML =
    '<div class="field-head"><div class="field-title">' +
    uiText("pluginEnabled") +
    '</div><div class="field-state">' +
    (draft.enabled ? uiText("enabled") : uiText("disabled")) +
    '</div></div><p class="field-desc">' +
    uiText("enabledDesc") +
    "</p>";

  const segmented = document.createElement("div");
  segmented.className = "segmented";
  segmented.appendChild(
    renderSegmentButton(uiText("enabled"), draft.enabled, () => {
      draft.enabled = true;
      renderForm();
    }),
  );
  segmented.appendChild(
    renderSegmentButton(uiText("disabled"), !draft.enabled, () => {
      draft.enabled = false;
      renderForm();
    }),
  );
  field.appendChild(segmented);
  return field;
}

function resetField(key) {
  const definition = APP.fieldDefinitions.find((field) => field.key === key);
  draft.fields[key] = createFieldDraft(definition, false, undefined, remoteState?.fieldMeta?.[key] || null);
  renderForm();
}

function renderFooter(definition, errorText) {
  const footer = document.createElement("div");
  footer.className = "field-tools";

  const status = document.createElement("div");
  status.className = errorText ? "error" : "helper";
  status.textContent = errorText || helperText(definition);
  footer.appendChild(status);

  const actions = document.createElement("div");
  actions.className = "inline-actions";
  const reset = document.createElement("button");
  reset.type = "button";
  reset.className = "inline-btn";
  reset.textContent = uiText("reset");
  reset.addEventListener("click", () => resetField(definition.key));
  actions.appendChild(reset);
  footer.appendChild(actions);

  return footer;
}

function renderValueControl(definition) {
  if (definition.type === "enum") {
    const select = document.createElement("select");
    select.className = "select";
    for (const option of definition.options || []) {
      const element = document.createElement("option");
      element.value = option.value;
      element.textContent = option.label;
      if (draft.fields[definition.key].text === option.value) {
        element.selected = true;
      }
      select.appendChild(element);
    }
    select.addEventListener("change", (event) => {
      draft.fields[definition.key].text = event.target.value;
      refreshChrome();
    });
    return select;
  }

  if (definition.type === "textarea" || definition.type === "json" || definition.type === "stringArray") {
    const textarea = document.createElement("textarea");
    textarea.className = definition.type === "json" ? "text-area json-font" : "text-area";
    textarea.rows = definition.rows || 5;
    textarea.placeholder = definition.placeholder || "";
    textarea.value = draft.fields[definition.key].text || "";
    textarea.addEventListener("input", (event) => {
      draft.fields[definition.key].text = event.target.value;
      refreshChrome();
    });
    return textarea;
  }

  const wrap = document.createElement("div");
  const input = document.createElement("input");
  input.className = "control";
  input.type = definition.type === "secret" ? "password" : "text";
  input.placeholder = definition.placeholder || "";
  input.value = draft.fields[definition.key].text || "";
  if (definition.type === "integer" || definition.type === "number") {
    input.inputMode = "decimal";
  }
  input.addEventListener("input", (event) => {
    draft.fields[definition.key].text = event.target.value;
    refreshChrome();
  });
  wrap.appendChild(input);

  if (definition.type === "secret") {
    const tools = document.createElement("div");
    tools.className = "field-tools";
    tools.appendChild(document.createElement("div"));

    const actions = document.createElement("div");
    actions.className = "inline-actions";
    const reveal = document.createElement("button");
      reveal.type = "button";
      reveal.className = "inline-btn";
      reveal.textContent = uiText("show");
      reveal.addEventListener("click", () => {
        input.type = input.type === "password" ? "text" : "password";
        reveal.textContent = input.type === "password" ? uiText("show") : uiText("hide");
      });
    actions.appendChild(reveal);
    tools.appendChild(actions);
    wrap.appendChild(tools);
  }

  return wrap;
}

function renderField(definition, errorText) {
  const fieldText = localizedField(definition);
  const field = document.createElement("div");
  field.className = "field";
  const stateText =
    draft.fields[definition.key].mode === "inherit"
      ? (draft.fields[definition.key].inheritedSource === "env"
          ? uiText("env")
          : draft.fields[definition.key].inheritedSource === "default"
            ? uiText("inherit")
            : uiText("empty"))
      : definition.type === "boolean"
        ? booleanStateLabel(draft.fields[definition.key].mode)
        : uiText("custom");

  field.innerHTML =
    '<div class="field-head"><div class="field-title">' +
    escapeHtml(fieldText.label) +
    '</div><div class="field-state">' +
    escapeHtml(stateText) +
    '</div></div><p class="field-desc">' +
    escapeHtml(fieldText.description) +
    "</p>";

  if (definition.type === "boolean") {
    const segmented = document.createElement("div");
    segmented.className = "segmented";
    segmented.appendChild(
      renderSegmentButton(uiText("inherit"), draft.fields[definition.key].mode === "inherit", () => {
        draft.fields[definition.key].mode = "inherit";
        renderForm();
      }),
    );
    segmented.appendChild(
      renderSegmentButton(uiText("on"), draft.fields[definition.key].mode === "true", () => {
        draft.fields[definition.key].mode = "true";
        renderForm();
      }),
    );
    segmented.appendChild(
      renderSegmentButton(uiText("off"), draft.fields[definition.key].mode === "false", () => {
        draft.fields[definition.key].mode = "false";
        renderForm();
      }),
    );
    field.appendChild(segmented);
    field.appendChild(renderFooter(definition, errorText));
    return field;
  }

  const toggle = document.createElement("div");
  toggle.className = "segmented";
  toggle.appendChild(
    renderSegmentButton(uiText("inherit"), draft.fields[definition.key].mode === "inherit", () => {
      draft.fields[definition.key].mode = "inherit";
      renderForm();
    }),
  );
  toggle.appendChild(
    renderSegmentButton(uiText("custom"), draft.fields[definition.key].mode === "set", () => {
      draft.fields[definition.key].mode = "set";
      renderForm();
    }),
  );
  field.appendChild(toggle);

  if (draft.fields[definition.key].mode === "set") {
    field.appendChild(renderValueControl(definition));
  }

  field.appendChild(renderFooter(definition, errorText));
  return field;
}

function renderExtraField(errorText) {
  const field = document.createElement("div");
  field.className = "field";
  field.innerHTML =
    '<div class="field-head"><div class="field-title">' +
    uiText("extraTitle") +
    '</div><div class="field-state">' +
    (String(draft.extraText || "").trim() ? uiText("custom") : uiText("empty")) +
    '</div></div><p class="field-desc">' +
    uiText("extraDesc") +
    "</p>";

  const textarea = document.createElement("textarea");
  textarea.className = "text-area json-font";
  textarea.rows = 10;
  textarea.placeholder = '{\n  "futureField": true\n}';
  textarea.value = draft.extraText || "";
  textarea.addEventListener("input", (event) => {
    draft.extraText = event.target.value;
    refreshChrome();
  });
  field.appendChild(textarea);

  const footer = document.createElement("div");
  footer.className = "field-tools";
  const status = document.createElement("div");
  status.className = errorText ? "error" : "helper";
  status.textContent = errorText || uiText("extraHelper");
  footer.appendChild(status);

  const actions = document.createElement("div");
  actions.className = "inline-actions";
  const clear = document.createElement("button");
  clear.type = "button";
  clear.className = "inline-btn";
  clear.textContent = uiText("clear");
  clear.addEventListener("click", () => {
    draft.extraText = "";
    renderForm();
  });
  actions.appendChild(clear);
  footer.appendChild(actions);
  field.appendChild(footer);

  return field;
}

function renderForm() {
  const groups = APP.fieldGroups.map((item) => localizedGroup(item));
  if (!activeSectionId && groups.length > 0) {
    activeSectionId = groups[0].id;
  }
  renderStatus();
  elements.layout.innerHTML = "";
  const collected = collectDraft();
  const hasErrors = Object.keys(collected.errors).length > 0;

  for (const group of groups) {
    const card = document.createElement("section");
    card.className = "card";
    card.id = `section-${group.id}`;
    card.dataset.sectionId = group.id;

    const head = document.createElement("div");
    head.className = "card-head card-anchor";
    head.innerHTML = "<div><h3>" + escapeHtml(group.title) + "</h3><p>" + escapeHtml(group.description) + "</p></div>";
    card.appendChild(head);

    const stack = document.createElement("div");
    stack.className = "stack";

    if (group.id === "connection") {
      stack.appendChild(renderEnabledField());
    }

    for (const definition of APP.fieldDefinitions.filter((field) => field.group === group.id)) {
      stack.appendChild(renderField(definition, collected.errors[definition.key] || ""));
    }

    if (group.id === "advanced") {
      stack.appendChild(renderExtraField(collected.errors.__extra || ""));
    }

    card.appendChild(stack);
    elements.layout.appendChild(card);
  }

  renderFloatingNav(groups);
  installSectionObserver(groups);

  elements.saveButton.disabled = hasErrors || !isDirty();

  elements.reloadButton.disabled = !remoteState;
  refreshChrome();
}

function refreshChrome() {
  const { errors } = collectDraft();
  elements.saveButton.disabled = Object.keys(errors).length > 0 || !isDirty();

  elements.reloadButton.disabled = !remoteState;
  if (externalRefreshQueued) {
    setBanner("warn", uiText("bannerExternal"));
    return;
  }
  if (Object.keys(errors).length > 0) {
    setBanner("error", uiText("bannerErrors"));
    return;
  }

  if (isDirty()) {
    setBanner("info", uiText("bannerDirty"));
    return;
  }
  if (remoteState && remoteState.hasInclude) {
    setBanner("warn", uiText("bannerInclude"));
    return;
  }
  setBanner("", "");
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      "X-Memos-Config-Token": APP.token,
      ...(options.headers || {}),
    },
  });
  if (!response.ok) {
    const message = (await response.text()) || "Request failed.";
    const error = new Error(message);
    error.status = response.status;
    throw error;
  }
  return response.json();
}

async function checkHeartbeat() {
  const response = await fetch("/api/heartbeat", {
    method: "GET",
    cache: "no-store",
  });
  if (!response.ok) {
    throw new Error((await response.text()) || "Heartbeat failed.");
  }
  return response.json();
}

function handleHeartbeatState(heartbeat) {
  if (!heartbeat || typeof heartbeat !== "object") return;

  const bootChanged = Boolean(heartbeatBootId) && heartbeat.bootId && heartbeat.bootId !== heartbeatBootId;
  const assetChanged =
    Boolean(heartbeatAssetRevision) &&
    heartbeat.assetRevision &&
    heartbeat.assetRevision !== heartbeatAssetRevision;

  heartbeatBootId = heartbeat.bootId || heartbeatBootId;
  heartbeatAssetRevision = heartbeat.assetRevision || heartbeatAssetRevision;

  if ((!bootChanged && !assetChanged) || heartbeatReloadQueued) return;

  if (!isDirty()) {
    heartbeatReloadQueued = true;
    window.location.reload();
    return;
  }

  externalRefreshQueued = true;
  refreshChrome();
}

async function recoverFromAuthError() {
  if (authRecoveryInProgress) return;

  authRecoveryInProgress = true;
  authRecoveryRetryAt = Date.now() + 4000;
  try {
    const heartbeat = await checkHeartbeat();
    handleHeartbeatState(heartbeat);

    if (authRecoveryReloadQueued || heartbeatReloadQueued) return;

    if (heartbeat?.bootId || heartbeat?.assetRevision) {
      authRecoveryReloadQueued = true;
      setBanner("info", uiText("bannerAuthRecovered"));
      setTimeout(() => {
        window.location.reload();
      }, 350);
      return;
    }

    setBanner("info", uiText("bannerAuthWaiting"));
  } catch {
    setBanner("error", uiText("bannerAuthFailed"));
  } finally {
    authRecoveryInProgress = false;
  }
}

async function loadRemote(initial = false) {
  if (authRecoveryReloadQueued || heartbeatReloadQueued || authRecoveryInProgress) {
    return;
  }

  if (!initial && authRecoveryRetryAt > Date.now()) {
    return;
  }

  try {
    const state = await api("/api/state");
    const previousRevision = remoteState ? remoteState.revision : "";
    remoteState = state;
    authRecoveryInProgress = false;
    authRecoveryReloadQueued = false;
    authRecoveryRetryAt = 0;
    handleHeartbeatState(state);

    if (!draft || initial) {
      draft = createDraftFromRemote(state);
      baselineSnapshot = getDraftSnapshot();
      renderForm();
      return;
    }

    if (previousRevision && previousRevision !== state.revision) {
      if (!isDirty()) {
        draft = createDraftFromRemote(state);
        baselineSnapshot = getDraftSnapshot();
        externalRefreshQueued = false;
        renderForm();
        setBanner("info", uiText("bannerSynced"));
        return;
      }
      externalRefreshQueued = true;
        refreshChrome();

    }

    refreshChrome();
  } catch (error) {

    if (error?.status === 403) {
      void recoverFromAuthError();
      return;
    }
    setBanner("error", String(error.message || error));
  }
}

async function saveConfig() {
  const { config, errors } = collectDraft();
  if (Object.keys(errors).length > 0) {
    renderForm();
    return;
  }

  try {
    elements.saveButton.disabled = true;
    const result = await api("/api/save", {
      method: "POST",
      body: JSON.stringify({
        enabled: draft.enabled,
        config,
      }),
    });

    remoteState = result.state;
    draft = createDraftFromRemote(result.state);
    baselineSnapshot = getDraftSnapshot();



    externalRefreshQueued = false;
    renderForm();
    setOverlay(false, "", "");
    setBanner("info", uiText("bannerSaved"));
  } catch (error) {
    setBanner("error", String(error.message || error));
    refreshChrome();
  }
}

async function copyConfigPath() {
  try {
    await navigator.clipboard.writeText(remoteState?.configPath || "");
    setBanner("info", uiText("bannerCopied"));
  } catch {
    setBanner("error", uiText("bannerClipboardFailed"));
  }
}

elements.languageSelectButton.addEventListener("click", () => {
  setLanguageMenuOpen(!languageMenuOpen);
});
for (const option of [elements.languageOptionAuto, elements.languageOptionEn, elements.languageOptionZh]) {
  option.addEventListener("click", () => {
    setLanguagePreference(option.dataset.language || "auto");
    setLanguageMenuOpen(false);
  });
}
document.addEventListener("click", (event) => {
  if (!elements.languageDropdown.contains(event.target)) {
    setLanguageMenuOpen(false);
  }
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    setLanguageMenuOpen(false);
  }
});
elements.saveButton.addEventListener("click", () => void saveConfig());

elements.reloadButton.addEventListener("click", () => {
  if (!remoteState) return;
  draft = createDraftFromRemote(remoteState);
  baselineSnapshot = getDraftSnapshot();
  externalRefreshQueued = false;
  renderForm();
});
elements.overlayRefreshButton.addEventListener("click", () => {
  window.location.reload();
});
elements.copyPathButton.addEventListener("click", () => void copyConfigPath());
elements.floatingToggleButton.addEventListener("click", () => {
  setNavCollapsed(!navCollapsed);
});
elements.backTopButton.addEventListener("click", () => {
  window.scrollTo({ top: 0, behavior: "smooth" });
});

syncNavCollapseForViewport();
applyLanguageUi();
void loadRemote(true);
updateFloatingVisibility();
window.addEventListener("scroll", updateFloatingVisibility, { passive: true });
navCollapseMedia.addEventListener("change", syncNavCollapseForViewport);
setInterval(() => {
  void loadRemote(false);
}, 3000);
