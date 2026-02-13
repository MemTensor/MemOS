import { $ } from "./dom.js";
import { apiAct, apiGetMap, apiNewSession, apiSetActiveRole, apiSetSessionLang, apiSetSessionTheme, apiUpsertRole, apiRolesQuickstart } from "./actions.js";
import { setLang, getLang, t } from "./i18n.js";
import { initMinimapCanvas } from "./minimap.js";
import { initPhaser } from "./phaser_view.js";
import { applyPhaseUI } from "./phase_ui.js";
import { logMsg, checkAndShowShareButton, setStatus, renderPartyStatus } from "./render.js";
import { worldState } from "./state.js";
import { makeRole } from "./utils.js";

function refreshStaticUI() {
  document.title = t("pageTitle");
  document.documentElement.lang = getLang() === "zh" ? "zh-CN" : "en";
  const set = (id, key, attr = "textContent") => {
    const el = document.getElementById(id);
    if (el) el[attr] = t(key);
  };
  set("i18n-title", "title");
  set("i18n-subtitle", "subtitle");
  set("i18n-party-panel-title", "partyPanelTitle");
  set("i18n-interact-panel-title", "interactPanelTitle");
  set("i18n-btn-forward", "moveForward");
  set("i18n-btn-rest", "rest");
  set("i18n-btn-camp", "camp");
  set("i18n-btn-observe", "observe");
  set("btn-say", "send");
  set("i18n-hint-switch", "hintSwitchRole");
  set("i18n-setup-title", "setupTitle");
  set("i18n-setup-sub", "setupSub");
  set("i18n-setup-name-label", "setupNameLabel");
  set("i18n-setup-persona-label", "setupPersonaLabel");
  set("i18n-setup-pending-title", "setupPendingTitle");
  set("i18n-night-vote-title", "nightVoteTitle");
  set("i18n-share-modal-title", "shareModalTitle");
  const shareBtn = $("#share-button");
  if (shareBtn) {
    shareBtn.textContent = t("share");
    shareBtn.title = t("shareTitle");
  }
  const langBtn = $("#lang-button");
  if (langBtn) {
    langBtn.textContent = getLang() === "zh" ? t("langEn") : t("langZh");
  }
  $("#setup-role-name") && ($("#setup-role-name").placeholder = t("setupNamePlaceholder"));
  $("#setup-role-persona") && ($("#setup-role-persona").placeholder = t("setupPersonaPlaceholder"));
  $("#setup-add-role") && ($("#setup-add-role").textContent = t("setupAddRole"));
  $("#setup-quickstart") && ($("#setup-quickstart").textContent = t("setupQuickstart"));
  $("#setup-create") && ($("#setup-create").textContent = t("setupCreate"));
  $("#night-vote-sub") && ($("#night-vote-sub").textContent = t("nightVoteSub"));
  $("#night-vote-close") && ($("#night-vote-close").textContent = t("nightVoteContinue"));
  $("#share-download-btn") && ($("#share-download-btn").textContent = t("shareDownload"));
  $("#share-close-btn") && ($("#share-close-btn").textContent = t("shareClose"));
  const themeLabel = $("#i18n-setup-theme-label");
  if (themeLabel) themeLabel.textContent = t("setupThemeLabel");
  const themeZh = $("#setup-theme-zh");
  const themeEn = $("#setup-theme-en");
  const currentTheme = worldState?.theme ?? "aotai";
  if (themeZh) {
    themeZh.textContent = t("setupThemeAotai");
    themeZh.classList.toggle("primary", currentTheme === "aotai");
  }
  if (themeEn) {
    themeEn.textContent = t("setupThemeKilimanjaro");
    themeEn.classList.toggle("primary", currentTheme === "kili");
  }
}

export async function refreshAllUIText() {
  refreshStaticUI();
  // Do NOT re-fetch map here: map is tied to theme, not lang. Switching lang must not change map.
  setStatus();
  renderPartyStatus();
  applyPhaseUI(worldState);
  if (window.__aoTaiMinimap && typeof window.__aoTaiMinimap.setState === "function") {
    window.__aoTaiMinimap.setState(worldState);
  }
  if (window.__aoTaiMapView && typeof window.__aoTaiMapView.setState === "function") {
    window.__aoTaiMapView.setState(worldState);
  }
}

export async function bootstrap() {
  await apiNewSession("aotai", getLang());
  await apiGetMap(worldState?.theme ?? "aotai");
  window.__aoTaiMinimap = initMinimapCanvas();
  if (window.__aoTaiMinimap) window.__aoTaiMinimap.setState(worldState);
  initPhaser();

  // Language switcher (left of share button)
  const langBtn = $("#lang-button");
  if (langBtn) {
    langBtn.onclick = async () => {
      const newLang = getLang() === "zh" ? "en" : "zh";
      setLang(newLang);
      await apiSetSessionLang(newLang).catch((e) => console.warn("Failed to set session lang", e));
      await refreshAllUIText();
    };
  }
  refreshStaticUI();

  // Initialize share button
  checkAndShowShareButton(worldState);

  window.addEventListener("aotai:langchange", () => refreshAllUIText());

  // Initial role setup modal (must create at least one role; modal is removed after creation)
  const setupEl = $("#role-setup");
  const setupNameEl = $("#setup-role-name");
  const setupPersonaEl = $("#setup-role-persona");
  const setupListEl = $("#setup-role-list");
  const setupErrEl = $("#setup-error");
  const pending = [];

  const showSetupErr = (msg) => {
    if (!setupErrEl) return;
    setupErrEl.style.display = msg ? "block" : "none";
    setupErrEl.textContent = msg || "";
  };

  const renderPending = () => {
    if (!setupListEl) return;
    setupListEl.innerHTML = "";
    if (pending.length === 0) {
      const empty = document.createElement("div");
      empty.className = "hint";
      empty.textContent = t("setupEmptyList");
      setupListEl.appendChild(empty);
      return;
    }
    pending.forEach((r, idx) => {
      const item = document.createElement("div");
      item.className = "setup-item";
      const left = document.createElement("div");
      left.innerHTML = `<div class="name">${r.name}</div><div class="persona">${(r.persona || "")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")}</div>`;
      const btn = document.createElement("button");
      btn.textContent = t("setupRemove");
      btn.onclick = () => {
        pending.splice(idx, 1);
        renderPending();
      };
      item.appendChild(left);
      item.appendChild(btn);
      setupListEl.appendChild(item);
    });
  };

  const hideAndRemoveSetup = () => {
    if (!setupEl) return;
    setupEl.style.display = "none";
    try {
      setupEl.remove();
    } catch {}
  };

  const openSetupIfNeeded = () => {
    if (!setupEl) return;
    const roles = worldState && worldState.roles ? worldState.roles : [];
    if (roles.length > 0) return; // already has roles, don't block
    setupEl.style.display = "flex";
    showSetupErr("");
    renderPending();
    try {
      setupNameEl && setupNameEl.focus();
    } catch {}
  };

  $("#setup-add-role")?.addEventListener("click", () => {
    const name = (setupNameEl?.value || "").trim();
    const persona = (setupPersonaEl?.value || "").trim();
    if (!name) {
      showSetupErr(t("setupErrName"));
      return;
    }
    showSetupErr("");
    pending.push({ name, persona });
    if (setupNameEl) setupNameEl.value = "";
    if (setupPersonaEl) setupPersonaEl.value = "";
    renderPending();
    try {
      setupNameEl && setupNameEl.focus();
    } catch {}
  });

  $("#setup-create")?.addEventListener("click", async () => {
    if (pending.length === 0) {
      showSetupErr(t("setupErrMinOne"));
      return;
    }
    showSetupErr("");
    for (const r of pending) {
      await apiUpsertRole(makeRole(r.name, r.persona));
      logMsg({ kind: "system", content: t("msgRoleAdded") + r.name, timestamp_ms: Date.now() });
    }
    const roles = worldState?.roles || [];
    const pick = roles[0];
    if (pick?.role_id) await apiSetActiveRole(pick.role_id);
    hideAndRemoveSetup();
  });

  $("#setup-quickstart")?.addEventListener("click", async () => {
    showSetupErr("");
    // Use backend's roles/quickstart endpoint to create default roles with correct attributes
    await apiRolesQuickstart(false);
    logMsg({ kind: "system", content: t("msgQuickstartDone"), timestamp_ms: Date.now() });
    const roles = worldState?.roles || [];
    const pick = roles[0];
    if (pick?.role_id) await apiSetActiveRole(pick.role_id);
    hideAndRemoveSetup();
  });

  // Wire action buttons
  $("#actions-panel").addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-act]");
    if (!btn) return;
    apiAct(btn.getAttribute("data-act"));
  });

  // New flow: movement/rest/observe are now automatic. Hide all action buttons by default.
  // CAMP button will be shown only in AWAIT_CAMP_DECISION phase by phase_ui.js
  try {
    document.querySelectorAll("#actions-panel button[data-act]").forEach((b) => {
      b.style.display = "none"; // Hide all action buttons by default
    });
  } catch {}

  $("#btn-say").onclick = async () => {
    const text = ($("#say-input").value || "").trim();
    $("#say-input").value = "";
    await apiAct("SAY", { text });
  };

  // Theme choice in setup modal: syncs session lang so "Quick create 3 roles" uses the right theme
  $("#setup-theme-zh")?.addEventListener("click", async () => {
    setLang("zh");
    await apiSetSessionTheme("aotai").catch((e) => console.warn("Failed to set session theme", e));
    await apiSetSessionLang("zh").catch((e) => console.warn("Failed to set session lang", e));
    await apiGetMap("aotai").catch((e) => console.warn("Failed to refresh map", e));
    await refreshAllUIText();
  });
  $("#setup-theme-en")?.addEventListener("click", async () => {
    setLang("en");
    await apiSetSessionTheme("kili").catch((e) => console.warn("Failed to set session theme", e));
    await apiSetSessionLang("en").catch((e) => console.warn("Failed to set session lang", e));
    await apiGetMap("kili").catch((e) => console.warn("Failed to refresh map", e));
    await refreshAllUIText();
  });

  // Show role setup modal on first open
  openSetupIfNeeded();

  // First hint
  logMsg({
    kind: "system",
    content: t("msgFirstHint"),
    timestamp_ms: Date.now(),
  });
}
