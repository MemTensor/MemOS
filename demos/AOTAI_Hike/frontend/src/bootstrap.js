import { $ } from "./dom.js";
import { apiAct, apiGetMap, apiNewSession, apiUpsertRole } from "./actions.js";
import { initMinimapCanvas } from "./minimap.js";
import { initPhaser } from "./phaser_view.js";
import { logMsg } from "./render.js";
import { worldState } from "./state.js";
import { makeRole } from "./utils.js";

export async function bootstrap() {
  await apiGetMap();
  await apiNewSession();
  window.__aoTaiMinimap = initMinimapCanvas();
  if (window.__aoTaiMinimap) window.__aoTaiMinimap.setState(worldState);
  initPhaser();

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
      empty.textContent =
        "还没有待创建的角色。可以先填写名字/介绍加入列表，或点击“快速创建 3 角色”。";
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
      btn.textContent = "移除";
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
      showSetupErr("请先填写名字。");
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
      showSetupErr("请至少加入 1 个角色，或点击“快速创建 3 角色”。");
      return;
    }
    showSetupErr("");
    for (const r of pending) {
      await apiUpsertRole(makeRole(r.name, r.persona));
      logMsg({ kind: "system", content: `新增角色：${r.name}`, timestamp_ms: Date.now() });
    }
    hideAndRemoveSetup();
  });

  $("#setup-quickstart")?.addEventListener("click", async () => {
    showSetupErr("");
    const defaults = [
      { name: "阿鳌", persona: "阿鳌：队伍领队，路线熟悉，偏谨慎。" },
      { name: "太白", persona: "太白：装备党，喜欢记录数据与天气变化。" },
      { name: "小山", persona: "小山：乐观的新人徒步者，敢想敢冲但听劝。" },
    ];
    for (const r of defaults) await apiUpsertRole(makeRole(r.name, r.persona));
    logMsg({ kind: "system", content: "已创建 3 个默认角色。", timestamp_ms: Date.now() });
    hideAndRemoveSetup();
  });

  // Wire action buttons
  $("#actions-panel").addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-act]");
    if (!btn) return;
    apiAct(btn.getAttribute("data-act"));
  });

  // New flow: movement/rest/camp/observe are now automatic. Keep buttons for debugging, but hide by default.
  try {
    document.querySelectorAll("#actions-panel button[data-act]").forEach((b) => {
      b.style.display = "none";
    });
  } catch {}

  $("#btn-say").onclick = async () => {
    const text = ($("#say-input").value || "").trim();
    $("#say-input").value = "";
    await apiAct("SAY", { text });
  };

  // Show role setup modal on first open
  openSetupIfNeeded();

  // First hint
  logMsg({
    kind: "system",
    content: "先创建角色（弹窗里可快速创建），然后用动作按钮开始徒步。",
    timestamp_ms: Date.now(),
  });
}
