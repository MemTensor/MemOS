import { branchEl, chatEl, partyEl, rolesEl, statusEl } from "./dom.js";
import { edgeByToId, mapNodes, nodeById, worldState } from "./state.js";
import { avatarUrl, pct, statClass } from "./utils.js";

export function logMsg(msg) {
  if (!chatEl) return;
  const isNearBottom = (el, thresholdPx = 32) =>
    el.scrollTop + el.clientHeight >= el.scrollHeight - thresholdPx;
  const stickToBottom = isNearBottom(chatEl);

  if (msg.kind === "action") {
    const last = chatEl.lastElementChild;
    if (last && last.dataset && last.dataset.roleName === (msg.role_name || "")) {
      const contentEl = last.querySelector(".content");
      if (contentEl) {
        const raw = String(msg.content || "");
        const action = raw.includes("：") ? raw.split("：").slice(1).join("：") : raw;
        contentEl.textContent = `${contentEl.textContent}(${action})`;
        if (stickToBottom) {
          const scrollToBottom = () => {
            try {
              chatEl.scrollTop = chatEl.scrollHeight;
            } catch {}
          };
          try {
            requestAnimationFrame(scrollToBottom);
            setTimeout(scrollToBottom, 0);
          } catch {
            scrollToBottom();
          }
        }
        return;
      }
    }
  }

  const div = document.createElement("div");
  div.className = `msg ${msg.kind}`;
  div.dataset.roleName = msg.role_name || "";
  const meta = document.createElement("div");
  meta.className = "meta";
  const who = msg.kind === "system" ? "系统" : msg.role_name || "未知";
  meta.textContent = `[${who}]`;
  const content = document.createElement("div");
  content.className = "content";
  content.textContent = msg.content;
  div.appendChild(meta);
  div.appendChild(content);
  chatEl.appendChild(div);

  // Notify Phaser: show bubble for role speech
  try {
    if (
      msg.kind === "speech" &&
      msg.role_id &&
      window.__aoTaiMapView &&
      typeof window.__aoTaiMapView.say === "function"
    ) {
      window.__aoTaiMapView.say(msg.role_id, msg.content);
    }
  } catch {}

  // Auto-scroll only if user is already near bottom.
  if (stickToBottom) {
    const scrollToBottom = () => {
      try {
        chatEl.scrollTop = chatEl.scrollHeight;
      } catch {}
    };
    try {
      requestAnimationFrame(scrollToBottom);
      setTimeout(scrollToBottom, 0);
    } catch {
      scrollToBottom();
    }
  }
}

export function setStatus() {
  if (!worldState) return;
  const node =
    nodeById(worldState.current_node_id) ||
    mapNodes[Math.min(worldState.route_node_index, mapNodes.length - 1)];
  const active = (worldState.roles || []).find((r) => r.role_id === worldState.active_role_id);
  let locStr = node?.name || "?";
  if (worldState.in_transit_to_node_id) {
    const toN = nodeById(worldState.in_transit_to_node_id);
    const prog = Math.floor(worldState.in_transit_progress_km || 0);
    const tot = Math.floor(worldState.in_transit_total_km || 0);
    locStr = `路上→${toN?.name || worldState.in_transit_to_node_id} (${prog}/${tot}km)`;
  }
  statusEl.textContent = `Session: ${worldState.session_id} | 位置: ${locStr} | Day ${
    worldState.day
  }/${worldState.time_of_day} | 天气: ${worldState.weather} | 当前角色: ${active?.name || "-"}`;
}

export function renderRoles() {
  if (!rolesEl || !worldState) return;
  rolesEl.innerHTML = "";
  for (const r of worldState.roles || []) {
    const pill = document.createElement("div");
    pill.className = "role-pill" + (r.role_id === worldState.active_role_id ? " active" : "");
    pill.textContent = r.name;
    pill.onclick = async () => {
      await window.__aoTaiActions.apiSetActiveRole(r.role_id);
    };
    rolesEl.appendChild(pill);
  }
}

export function renderBranchChoices() {
  if (!branchEl || !worldState) return;
  const fromId = worldState.current_node_id;
  const nextIds = worldState.available_next_node_ids || [];
  if (!nextIds || nextIds.length <= 1) {
    branchEl.style.display = "none";
    branchEl.innerHTML = "";
    return;
  }

  const leader = worldState.leader_role_id;
  const active = worldState.active_role_id;
  if (leader && active && leader !== active) {
    branchEl.style.display = "none";
    branchEl.innerHTML = "";
    return;
  }

  const items = [];
  for (const id of nextIds) {
    const n = nodeById(id);
    const e = edgeByToId(fromId, id);
    const label = e && e.label ? e.label : "下一步";
    const name = n ? n.name : id;
    items.push({ id: id, text: label + "：" + name });
  }

  branchEl.style.display = "block";
  branchEl.innerHTML = "";

  const label = document.createElement("div");
  label.className = "label";
  label.textContent = "分岔口：请选择下一步";

  const box = document.createElement("div");
  box.className = "choices";

  for (const it of items) {
    const btn = document.createElement("button");
    btn.textContent = it.text;
    btn.onclick = () => window.__aoTaiActions.apiAct("MOVE_FORWARD", { next_node_id: it.id });
    box.appendChild(btn);
  }

  branchEl.appendChild(label);
  branchEl.appendChild(box);
}

export function renderPartyStatus() {
  if (!worldState) return;
  partyEl.innerHTML = "";

  const roles = worldState.roles || [];
  if (roles.length === 0) {
    const empty = document.createElement("div");
    empty.className = "party-card";
    empty.style.width = "520px";
    empty.innerHTML = `<div class="party-name">队伍状态</div><div class="party-sub">还没有队员。请先在启动弹窗里创建角色。</div>`;
    partyEl.appendChild(empty);
    return;
  }

  for (const r of roles) {
    const card = document.createElement("div");
    card.className = "party-card" + (r.role_id === worldState.active_role_id ? " active" : "");
    card.onclick = async () => {
      await window.__aoTaiActions.apiSetActiveRole(r.role_id);
    };
    if (r.persona) attachRoleTooltip(card, r.persona);

    const stamina = pct(r?.attrs?.stamina);
    const mood = pct(r?.attrs?.mood);
    const exp = pct(r?.attrs?.experience);
    const risk = pct(r?.attrs?.risk_tolerance);

    const head = document.createElement("div");
    head.className = "party-head";

    const img = document.createElement("img");
    img.className = "party-ava";
    img.alt = `${r.name} avatar`;
    img.src = avatarUrl(r);

    const meta = document.createElement("div");
    meta.innerHTML = `<div class="party-name">${r.name}</div>
      <div class="party-sub">当前扮演：${r.role_id === worldState.active_role_id ? "是" : "否"}</div>`;

    head.appendChild(img);
    head.appendChild(meta);

    const stat = document.createElement("div");
    stat.className = "stat";
    stat.innerHTML = `
      <div class="stat-row">
        <div class="stat-label">体力</div>
        <div class="stat-bar ${statClass(stamina)}"><div style="width:${stamina}%"></div></div>
        <div class="stat-val">${stamina}</div>
      </div>
      <div class="stat-row">
        <div class="stat-label">心情</div>
        <div class="stat-bar ${statClass(mood)}"><div style="width:${mood}%"></div></div>
        <div class="stat-val">${mood}</div>
      </div>
      <div class="stat-row">
        <div class="stat-label">经验</div>
        <div class="stat-bar ok"><div style="width:${exp}%"></div></div>
        <div class="stat-val">${exp}</div>
      </div>
      <div class="stat-row">
        <div class="stat-label">冒险</div>
        <div class="stat-bar warn"><div style="width:${risk}%"></div></div>
        <div class="stat-val">${risk}</div>
      </div>
    `;

    card.appendChild(head);
    card.appendChild(stat);
    partyEl.appendChild(card);
  }
}

let _roleTooltip = null;
let _roleTooltipPinned = false;

function ensureRoleTooltip() {
  if (_roleTooltip) return _roleTooltip;
  const tip = document.createElement("div");
  tip.className = "role-tooltip-float";
  tip.style.display = "none";
  tip.addEventListener("mouseenter", () => {
    _roleTooltipPinned = true;
  });
  tip.addEventListener("mouseleave", () => {
    _roleTooltipPinned = false;
    tip.style.display = "none";
  });
  document.body.appendChild(tip);
  _roleTooltip = tip;
  return tip;
}

function attachRoleTooltip(card, persona) {
  const tip = ensureRoleTooltip();
  const show = () => {
    tip.textContent = persona || "";
    const rect = card.getBoundingClientRect();
    tip.style.left = `${Math.round(rect.left)}px`;
    tip.style.top = `${Math.round(rect.bottom + 6)}px`;
    tip.style.display = "block";
  };
  card.addEventListener("mouseenter", () => {
    _roleTooltipPinned = true;
    show();
  });
  card.addEventListener("mousemove", () => {
    if (_roleTooltipPinned) show();
  });
  card.addEventListener("mouseleave", () => {
    _roleTooltipPinned = false;
    tip.style.display = "none";
  });
}
