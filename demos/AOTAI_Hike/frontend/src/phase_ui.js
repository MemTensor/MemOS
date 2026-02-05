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

  // Default: free play
  if (phase === "free") {
    setActionButtonsEnabled(true);
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

  if (phase === "camp_meeting_decide") {
    setActionButtonsEnabled(false);
    if (!phasePanel || !hintEl) return;
    phasePanel.style.display = "block";
    hintEl.textContent = "营地会议：选择共识路线、锁强度与明日团长，然后提交。";

    // Clear previous controls (keep hintEl)
    [...phasePanel.children].forEach((c) => {
      if (c !== hintEl) c.remove();
    });

    const row = document.createElement("div");
    row.className = "row";
    row.style.display = "flex";
    row.style.gap = "8px";
    row.style.flexWrap = "wrap";

    const mkSelect = (label, options, value) => {
      const box = document.createElement("div");
      box.style.display = "flex";
      box.style.flexDirection = "column";
      box.style.gap = "4px";
      const lab = document.createElement("div");
      lab.style.fontSize = "12px";
      lab.style.opacity = "0.9";
      lab.textContent = label;
      const sel = document.createElement("select");
      (options || []).forEach((opt) => {
        const o = document.createElement("option");
        o.value = String(opt.value);
        o.textContent = String(opt.text);
        if (String(opt.value) === String(value)) o.selected = true;
        sel.appendChild(o);
      });
      box.appendChild(lab);
      box.appendChild(sel);
      return { box, sel };
    };

    const routeOpts = (ws.camp_meeting?.options_next_node_ids || []).map((id) => ({
      value: id,
      text: id,
    }));
    if (routeOpts.length === 0) routeOpts.push({ value: "", text: "（无可选路线）" });

    const { box: routeBox, sel: routeSel } = mkSelect(
      "共识路线（下一节点）",
      routeOpts,
      ws.consensus_next_node_id || (routeOpts[0] && routeOpts[0].value),
    );

    const { box: lockBox, sel: lockSel } = mkSelect(
      "锁强度",
      [
        { value: "soft", text: "软" },
        { value: "hard", text: "硬" },
        { value: "iron", text: "铁" },
      ],
      ws.lock_strength || "soft",
    );

    const leaderOpts = (ws.roles || []).map((r) => ({ value: r.role_id, text: r.name }));
    if (leaderOpts.length === 0) leaderOpts.push({ value: "", text: "（无角色）" });
    const { box: leaderBox, sel: leaderSel } = mkSelect(
      "明日团长",
      leaderOpts,
      ws.leader_role_id || (leaderOpts[0] && leaderOpts[0].value),
    );

    row.appendChild(routeBox);
    row.appendChild(lockBox);
    row.appendChild(leaderBox);
    phasePanel.appendChild(row);

    submitBtn = document.createElement("button");
    submitBtn.textContent = "提交共识";
    submitBtn.style.marginTop = "8px";
    submitBtn.onclick = async () => {
      const payload = {
        kind: "camp_meeting",
        consensus_next_node_id: String(routeSel.value || ""),
        lock_strength: String(lockSel.value || "soft"),
        leader_role_id: String(leaderSel.value || ""),
      };
      await window.__aoTaiActions.apiAct("DECIDE", payload);
    };
    phasePanel.appendChild(submitBtn);
    return;
  }

  // Unknown phase: be safe and block actions.
  setActionButtonsEnabled(false);
  if (phasePanel && hintEl) {
    phasePanel.style.display = "block";
    hintEl.textContent = `当前阶段：${phase}（动作暂不可用）`;
  }
}
