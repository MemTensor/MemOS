/**
 * Multi-language (zh/en) for AoTai Hike demo.
 * Usage: t("key") returns current language string; setLang("zh"|"en") then refresh UI.
 */

const STORAGE_KEY = "aotai_hike_lang";

const messages = {
  zh: {
    // Page & title
    pageTitle: "鳌太线·像素徒步模拟器（Demo）",
    title: "鳌太线·像素徒步模拟器",
    subtitle: "单人多角色 · 其他角色由生成接口驱动（当前为 mock）",

    // Top bar buttons
    share: "分享",
    shareTitle: "分享游戏记录",
    langZh: "中",
    langEn: "英",

    // Party panel
    partyPanelTitle: "队伍状态（点击卡片切换角色）",
    partyStatus: "队伍状态",
    partyEmpty: "还没有队员。请先在启动弹窗里创建角色。",
    currentPlay: "当前扮演",
    yes: "是",
    no: "否",

    // Stats
    stamina: "体力",
    mood: "心情",
    experience: "经验",
    risk: "冒险",
    supplies: "物资",

    // Interact panel
    interactPanelTitle: "互动（动作 + 像素聊天）",
    moveForward: "前进",
    rest: "休息",
    camp: "扎营",
    observe: "观察",
    campButtonTitle: "扎营（恢复体力，消耗较多物资）",
    sayPlaceholder: "当前角色说点什么…",
    sayPlaceholderDisabled: "队伍行动中…（需要你发言时会提示）",
    sayPlaceholderGameOver: "游戏已结束",
    send: "发送",
    hintSwitchRole: "提示：点击上方「队伍状态」的卡片即可切换当前角色。",

    // Status line
    statusLocation: "位置",
    statusDay: "Day",
    statusWeather: "天气",
    statusCurrentRole: "当前角色",
    statusEnRoute: "路上→",

    // Branch
    nextStep: "下一步",
    junctionChoose: "分岔口：请选择下一步",

    // Chat / system
    system: "系统",
    unknown: "未知",

    // Role setup modal
    setupTitle: "创建队伍角色",
    setupThemeLabel: "路线主题（决定剧情与默认角色设定）：",
    setupThemeAotai: "鳌太线（中文）",
    setupThemeKilimanjaro: "乞力马扎罗（English）",
    setupSub: "先创建 1 个或多个角色（名字 + 角色介绍），创建完成后该弹窗会消失。也可以一键快速创建。",
    setupNameLabel: "名字",
    setupNamePlaceholder: "例如：阿鳌",
    setupPersonaLabel: "角色介绍",
    setupPersonaPlaceholder: "例如：经验丰富的徒步向导，谨慎但乐观。",
    setupAddRole: "加入列表",
    setupQuickstart: "快速创建 3 角色",
    setupPendingTitle: "待创建",
    setupCreate: "创建并开始",
    setupEmptyList: "还没有待创建的角色。可以先填写名字/介绍加入列表，或点击「快速创建 3 角色」。",
    setupRemove: "移除",
    setupErrName: "请先填写名字。",
    setupErrMinOne: "请至少加入 1 个角色，或点击「快速创建 3 角色」。",

    // Night vote
    nightVoteTitle: "夜间票选队长",
    nightVoteSub: "请选择一位队长。选择后将展示全员投票与理由。",
    nightVoteSelectAsLeader: "选择为队长",
    nightVoteDone: "投票完成。",
    nightVoteContinue: "继续出发",

    // Share modal
    shareModalTitle: "分享游戏记录",
    shareDownload: "下载图片",
    shareClose: "关闭",
    shareGenerating: "正在生成分享图片...",
    shareNoSession: "游戏会话不可用",
    shareLoadFailed: "加载失败",

    // Phase hints
    phaseWaitSay: "队伍等待你发言：请在输入框里发一句话（发言后才能继续）。",
    phaseCampDecision: "作为队长，你可以选择扎营恢复体力（消耗较多物资），或继续前进。",
    phaseNightWaitSay: "夜晚到来：请先发言（发送一句话）后才能开始票选队长。",
    phaseNightVote: "夜晚票选：请在弹窗中选择队长。",
    phaseUnknown: "当前阶段：{phase}（动作暂不可用）",

    // System messages
    msgNewSession: "已创建新 Session。",
    msgTalking: "正在与队友对话…",
    msgSwitchRole: "切换当前角色为：",
    msgRoleAdded: "新增角色：",
    msgQuickstartDone: "已创建 3 个默认角色。",
    msgFirstHint: "先创建角色（弹窗里可快速创建），然后用动作按钮开始徒步。",
    msgStartupFailed: "启动失败：",

    // Phaser fallback
    roleLabel: "角色",
  },

  en: {
    pageTitle: "Conquer Kilimanjaro · Pixel Trail Simulator (Demo)",
    title: "Conquer Kilimanjaro · Pixel Trail Simulator",
    subtitle: "Single-player multi-role · Other roles driven by API (mock)",

    share: "Share",
    shareTitle: "Share game record",
    langZh: "中",
    langEn: "EN",

    partyPanelTitle: "Party (click card to switch role)",
    partyStatus: "Party",
    partyEmpty: "No members yet. Create roles in the setup popup first.",
    currentPlay: "Playing",
    yes: "Yes",
    no: "No",

    stamina: "Stamina",
    mood: "Mood",
    experience: "Exp",
    risk: "Risk",
    supplies: "Supplies",

    interactPanelTitle: "Interact (actions + pixel chat)",
    moveForward: "Forward",
    rest: "Rest",
    camp: "Camp",
    observe: "Observe",
    campButtonTitle: "Camp (restore stamina, uses more supplies)",
    sayPlaceholder: "Say something as current role…",
    sayPlaceholderDisabled: "Party on the move… (you'll be prompted when to speak)",
    sayPlaceholderGameOver: "Game over",
    send: "Send",
    hintSwitchRole: "Tip: click a card above to switch the current role.",

    statusLocation: "Location",
    statusDay: "Day",
    statusWeather: "Weather",
    statusCurrentRole: "Role",
    statusEnRoute: "En route→",

    nextStep: "Next",
    junctionChoose: "Junction: choose next step",

    system: "System",
    unknown: "Unknown",

    setupTitle: "Create party roles",
    setupThemeLabel: "Trek theme (sets story & default roles):",
    setupThemeAotai: "AoTai Trail (中文)",
    setupThemeKilimanjaro: "Conquer Kilimanjaro (English)",
    setupSub: "Create one or more roles (name + intro). This popup closes when done. Or quick-create.",
    setupNameLabel: "Name",
    setupNamePlaceholder: "e.g. Ao",
    setupPersonaLabel: "Role intro",
    setupPersonaPlaceholder: "e.g. Experienced trail guide, cautious but optimistic.",
    setupAddRole: "Add to list",
    setupQuickstart: "Quick create 3 roles",
    setupPendingTitle: "Pending",
    setupCreate: "Create & start",
    setupEmptyList: "No pending roles. Add name/intro or click «Quick create 3 roles».",
    setupRemove: "Remove",
    setupErrName: "Please enter a name.",
    setupErrMinOne: "Add at least one role, or click «Quick create 3 roles».",

    nightVoteTitle: "Night vote: choose leader",
    nightVoteSub: "Choose one leader. After that, votes and reasons will be shown.",
    nightVoteSelectAsLeader: "Select as leader",
    nightVoteDone: "Vote complete.",
    nightVoteContinue: "Continue",

    shareModalTitle: "Share game record",
    shareDownload: "Download image",
    shareClose: "Close",
    shareGenerating: "Generating share image...",
    shareNoSession: "Game session not available",
    shareLoadFailed: "Load failed",

    phaseWaitSay: "Party is waiting for you: type a message and send to continue.",
    phaseCampDecision: "As leader, you can camp to restore stamina (uses more supplies) or continue.",
    phaseNightWaitSay: "Night: say something first, then the leader vote will start.",
    phaseNightVote: "Night vote: choose the leader in the popup.",
    phaseUnknown: "Phase: {phase} (actions disabled)",

    msgNewSession: "New session created.",
    msgTalking: "Talking with party…",
    msgSwitchRole: "Switched to: ",
    msgRoleAdded: "Added role: ",
    msgQuickstartDone: "Created 3 default roles.",
    msgFirstHint: "Create roles (quick create in popup), then use actions to start the hike.",
    msgStartupFailed: "Startup failed: ",

    roleLabel: "Role",
  },
};

let currentLang = (typeof localStorage !== "undefined" && localStorage.getItem(STORAGE_KEY)) || "zh";
if (currentLang !== "zh" && currentLang !== "en") currentLang = "zh";

export function getLang() {
  return currentLang;
}

export function setLang(lang) {
  if (lang !== "zh" && lang !== "en") return;
  currentLang = lang;
  try {
    localStorage.setItem(STORAGE_KEY, lang);
  } catch {}
  try {
    window.dispatchEvent(new CustomEvent("aotai:langchange", { detail: { lang } }));
  } catch {}
}

export function t(key) {
  const m = messages[currentLang];
  const s = m && m[key];
  if (s === undefined) return messages.zh[key] || key;
  return s;
}

/** Replace placeholders like {phase} in t("phaseUnknown") */
export function tFormat(key, vars = {}) {
  let s = t(key);
  Object.entries(vars).forEach(([k, v]) => {
    s = s.replace(new RegExp(`\\{${k}\\}`, "g"), String(v));
  });
  return s;
}
