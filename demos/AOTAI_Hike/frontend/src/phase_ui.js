import { $ } from "./dom.js";

let phasePanel = null;
let hintEl = null;
let submitBtn = null;

function ensurePhasePanel() {
  if (phasePanel) return;
  const actions = $("#actions-panel");
  if (!actions) return;
  phasePanel = document.createElement("div");
  phasePanel.id = "phase-panel";
  phasePanel.className = "phase-panel";
  phasePanel.style.marginTop = "8px";
  phasePanel.style.padding = "8px";
  phasePanel.style.border = "1px solid rgba(124,242,255,0.35)";
  phasePanel.style.background = "rgba(6,16,34,0.55)";
  phasePanel.style.display = "none";

  hintEl = document.createElement("div");
  hintEl.className = "hint";
  hintEl.style.marginBottom = "6px";
  phasePanel.appendChild(hintEl);

  actions.appendChild(phasePanel);
}

function setActionButtonsEnabled(enabled) {
  const actions = $("#actions-panel");
  if (!actions) return;
  actions.querySelectorAll("button[data-act]").forEach((b) => {
    b.disabled = !enabled;
  });
}

export function applyPhaseUI(ws) {
  ensurePhasePanel();
  if (!ws) return;

  const phase = ws.phase || "free";

  // SAY input is only enabled when the game explicitly asks the player to respond.
  const sayInput = $("#say-input");
  const sayBtn = $("#btn-say");
  const enableSay = phase === "await_player_say";
  if (sayInput) {
    sayInput.disabled = !enableSay;
    sayInput.placeholder = enableSay ? "当前角色说点什么…" : "队伍行动中…（需要你发言时会提示）";
  }
  if (sayBtn) sayBtn.disabled = !enableSay;

  // Default: free play
  if (phase === "free") {
    setActionButtonsEnabled(false);
    if (phasePanel) phasePanel.style.display = "none";
    return;
  }

  if (phase === "await_player_say") {
    // Block all action buttons; allow user to SAY.
    setActionButtonsEnabled(false);
    if (phasePanel && hintEl) {
      phasePanel.style.display = "block";
      hintEl.textContent = "队伍等待你发言：请在输入框里发一句话（发言后才能继续）。";
      phasePanel.querySelectorAll("div,select,button").forEach((n) => {
        if (n !== hintEl) n.remove?.();
      });
    }
    return;
  }

  // camp_meeting_decide / junction_decision were for the old manual-decision flow.
  // In the new flow, camp meeting and leader junction picks are automatic.

  // Unknown phase: be safe and block actions.
  setActionButtonsEnabled(false);
  if (phasePanel && hintEl) {
    phasePanel.style.display = "block";
    hintEl.textContent = `当前阶段：${phase}（动作暂不可用）`;
  }
}
