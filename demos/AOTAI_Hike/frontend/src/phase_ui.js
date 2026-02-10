import { $ } from "./dom.js";
import { avatarUrl } from "./utils.js";

let phasePanel = null;
let hintEl = null;
let submitBtn = null;
let nightVoteBackdrop = null;
let nightVoteRoles = null;
let nightVoteLog = null;
let nightVoteActions = null;
let nightVoteClose = null;
let nightVoteSub = null;
let nightVoteMode = "hidden"; // hidden | select | result
let nightVoteBusy = false;

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

function updateCampButtonState(ws) {
  const actions = $("#actions-panel");
  if (!actions) return;
  const campBtn = actions.querySelector('button[data-act="CAMP"]');
  if (!campBtn) return;

  // Only show CAMP button in AWAIT_CAMP_DECISION phase (after player says something)
  const phase = String(ws?.phase || "free").toLowerCase();
  const isCampDecisionPhase = phase === "await_camp_decision";
  const isLeader = ws?.active_role_id && ws?.active_role_id === ws?.leader_role_id;

  // Show button only in AWAIT_CAMP_DECISION phase and if player is leader
  campBtn.style.display = isCampDecisionPhase && isLeader ? "block" : "none";
  if (isCampDecisionPhase && isLeader) {
    campBtn.disabled = false;
    campBtn.title = "扎营（恢复体力，消耗较多物资）";
  }
}

function ensureNightVoteModal() {
  if (nightVoteBackdrop) return;
  nightVoteBackdrop = $("#night-vote-modal");
  nightVoteRoles = $("#night-vote-roles");
  nightVoteLog = $("#night-vote-log");
  nightVoteActions = $("#night-vote-actions");
  nightVoteClose = $("#night-vote-close");
  nightVoteSub = $("#night-vote-sub");
  if (nightVoteClose) {
    nightVoteClose.onclick = () => {
      hideNightVoteModal();
      window.__aoTaiActions?.scheduleAutoContinue?.();
    };
  }
}

function showNightVoteModal() {
  ensureNightVoteModal();
  if (!nightVoteBackdrop) return;
  nightVoteBackdrop.style.display = "flex";
  window.__aoTaiNightVoteOpen = true;
}

function hideNightVoteModal() {
  if (!nightVoteBackdrop) return;
  nightVoteBackdrop.style.display = "none";
  nightVoteMode = "hidden";
  nightVoteBusy = false;
  window.__aoTaiNightVoteOpen = false;
}

function renderNightVoteSelect(ws) {
  ensureNightVoteModal();
  if (!nightVoteBackdrop || !nightVoteRoles || !nightVoteLog || !nightVoteActions) return;
  nightVoteMode = "select";
  nightVoteBusy = false;
  showNightVoteModal();
  nightVoteLog.style.display = "none";
  nightVoteActions.style.display = "none";
  if (nightVoteSub) {
    nightVoteSub.textContent = "请选择一位队长。选择后将展示全员投票与理由。";
  }

  nightVoteRoles.innerHTML = "";
  const roles = ws?.roles || [];
  roles.forEach((r) => {
    const card = document.createElement("div");
    card.className = "vote-card";
    const img = document.createElement("img");
    img.className = "vote-ava";
    img.src = avatarUrl(r);
    img.alt = `${r.name} avatar`;
    const meta = document.createElement("div");
    meta.innerHTML = `<div class="vote-name">${r.name}</div><div class="vote-sub">选择为队长</div>`;
    card.appendChild(img);
    card.appendChild(meta);
    card.onclick = async () => {
      if (nightVoteBusy) return;
      nightVoteBusy = true;
      nightVoteRoles.querySelectorAll(".vote-card").forEach((el) => {
        el.classList.add("disabled");
      });
      const data = await window.__aoTaiActions?.apiAct?.("DECIDE", {
        kind: "night_vote",
        leader_role_id: r.role_id,
      });
      renderNightVoteResult(data?.messages || []);
    };
    nightVoteRoles.appendChild(card);
  });
}

function renderNightVoteResult(messages) {
  ensureNightVoteModal();
  if (!nightVoteLog || !nightVoteActions) return;
  nightVoteMode = "result";
  showNightVoteModal();
  const lines = [];
  (messages || []).forEach((m) => {
    if (m?.kind === "action" || m?.kind === "system") {
      lines.push(m.content);
    }
  });
  nightVoteLog.innerHTML = lines.length ? lines.map((l) => `<div>${l}</div>`).join("") : "投票完成。";
  nightVoteLog.style.display = "block";
  nightVoteActions.style.display = "block";
}

export function isNightVoteModalBlocking() {
  return nightVoteMode !== "hidden";
}

export function applyPhaseUI(ws) {
  ensurePhasePanel();
  ensureNightVoteModal();
  if (!ws) return;

  const phase = String(ws.phase || "free").toLowerCase();
  const roles = ws.roles || [];
  const exhausted = roles.length > 0 && roles.every((r) => Number(r?.attrs?.stamina || 0) <= 0);
  const terminalIds = new Set(["end_exit", "bailout_2800", "bailout_ridge"]);
  const isGameOver = exhausted || terminalIds.has(String(ws.current_node_id || ""));

  // SAY input is only enabled when the game explicitly asks the player to respond.
  const sayInput = $("#say-input");
  const sayBtn = $("#btn-say");
  const enableSay = (phase === "await_player_say" || phase === "night_wait_player") && !isGameOver;
  if (sayInput) {
    sayInput.disabled = !enableSay;
    sayInput.classList.toggle("input-attn", phase === "night_wait_player" && !isGameOver);
    sayInput.placeholder = isGameOver
      ? "游戏已结束"
      : enableSay
        ? "当前角色说点什么…"
        : "队伍行动中…（需要你发言时会提示）";
  }
  if (sayBtn) sayBtn.disabled = !enableSay;

  // Ensure phasePanel is available
  if (!phasePanel || !hintEl) {
    console.warn("phasePanel or hintEl not initialized", { phasePanel, hintEl });
    return;
  }

  // Default: free play
  if (phase === "free") {
    setActionButtonsEnabled(false);
    updateCampButtonState(ws); // Hide CAMP button
    // Hide MOVE_FORWARD button in FREE phase
    const actions = $("#actions-panel");
    if (actions) {
      const forwardBtn = actions.querySelector('button[data-act="MOVE_FORWARD"]');
      if (forwardBtn) {
        forwardBtn.style.display = "none";
      }
    }
    phasePanel.style.display = "none";
    if (nightVoteMode !== "result") hideNightVoteModal();
    return;
  }

  if (isGameOver) {
    setActionButtonsEnabled(false);
    updateCampButtonState(ws); // Disable CAMP button when game over
    phasePanel.style.display = "none";
    hideNightVoteModal();
    return;
  }

  // Always show phasePanel for non-free phases
  phasePanel.style.display = "block";

  if (phase === "await_player_say") {
    // Block all action buttons; allow user to SAY.
    setActionButtonsEnabled(false);
    updateCampButtonState(ws); // Hide CAMP button
    hintEl.textContent = "队伍等待你发言：请在输入框里发一句话（发言后才能继续）。";
    phasePanel.querySelectorAll("div,select,button").forEach((n) => {
      if (n !== hintEl) n.remove?.();
    });
    return;
  }

  if (phase === "await_camp_decision") {
    // After SAY, leader can choose to camp or continue
    setActionButtonsEnabled(false);
    updateCampButtonState(ws); // Show CAMP button if leader
    // Enable MOVE_FORWARD button (continue without camping)
    const actions = $("#actions-panel");
    if (actions) {
      const forwardBtn = actions.querySelector('button[data-act="MOVE_FORWARD"]');
      if (forwardBtn) {
        forwardBtn.style.display = "block";
        forwardBtn.disabled = false;
      }
    }
    hintEl.textContent = "作为队长，你可以选择扎营恢复体力（消耗较多物资），或继续前进。";
    phasePanel.querySelectorAll("div,select,button").forEach((n) => {
      if (n !== hintEl) n.remove?.();
    });
    return;
  }

  if (phase === "night_wait_player") {
    setActionButtonsEnabled(false);
    updateCampButtonState(ws); // Disable CAMP button
    hintEl.textContent = "夜晚到来：请先发言（发送一句话）后才能开始票选队长。";
    phasePanel.querySelectorAll("div,select,button").forEach((n) => {
      if (n !== hintEl) n.remove?.();
    });
    hideNightVoteModal();
    return;
  }

  if (phase === "night_vote_ready") {
    setActionButtonsEnabled(false);
    updateCampButtonState(ws); // Disable CAMP button
    hintEl.textContent = "夜晚票选：请在弹窗中选择队长。";
    phasePanel.querySelectorAll("div,select,button").forEach((n) => {
      if (n !== hintEl) n.remove?.();
    });
    renderNightVoteSelect(ws);
    return;
  }

  // camp_meeting_decide / junction_decision were for the old manual-decision flow.
  // In the new flow, camp meeting and leader junction picks are automatic.

  // Unknown phase: be safe and block actions.
  setActionButtonsEnabled(false);
  updateCampButtonState(ws); // Disable CAMP button
  hintEl.textContent = `当前阶段：${phase}（动作暂不可用）`;
}
