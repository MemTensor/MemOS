const API_BASE = "/api/demo/ao-tai";

const $ = (sel) => document.querySelector(sel);
const chatEl = $("#chat");
const rolesEl = $("#roles");
const statusEl = $("#status");
const backdropEl = $("#backdrop");
const partyEl = $("#party-status");

let mapNodes = [];
let sessionId = null;
let worldState = null;

const AVATAR_KEYS = ["default", "blue", "red", "green"]; // lightweight presets

function clamp(n, a, b) {
  return Math.max(a, Math.min(b, n));
}

function pct(n) {
  return clamp(Number(n) || 0, 0, 100);
}

function statClass(v) {
  if (v <= 25) return "danger";
  if (v <= 55) return "warn";
  return "ok";
}

function avatarUrl(role) {
  const key = role?.avatar_key || "default";
  return `./assets/avatars/ava_${key}.svg`;
}

function logMsg(msg) {
  const div = document.createElement("div");
  div.className = `msg ${msg.kind}`;
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
  chatEl.scrollTop = chatEl.scrollHeight;
}

function setStatus() {
  if (!worldState) return;
  const node = mapNodes[Math.min(worldState.route_node_index, mapNodes.length - 1)];
  const active = (worldState.roles || []).find((r) => r.role_id === worldState.active_role_id);
  statusEl.textContent = `Session: ${worldState.session_id} | 位置: ${node?.name || "?"} | Day ${
    worldState.day
  }/${worldState.time_of_day} | 天气: ${worldState.weather} | 当前角色: ${active?.name || "-"}`;
}

function renderRoles() {
  rolesEl.innerHTML = "";
  for (const r of worldState.roles || []) {
    const pill = document.createElement("div");
    pill.className = "role-pill" + (r.role_id === worldState.active_role_id ? " active" : "");
    pill.textContent = r.name;
    pill.onclick = async () => {
      await apiSetActiveRole(r.role_id);
    };
    rolesEl.appendChild(pill);
  }
}

function renderPartyStatus() {
  if (!worldState) return;
  partyEl.innerHTML = "";

  const roles = worldState.roles || [];
  if (roles.length === 0) {
    const empty = document.createElement("div");
    empty.className = "party-card";
    empty.style.width = "520px";
    empty.innerHTML = `<div class="party-name">队伍状态</div><div class="party-sub">还没有队员。点击“快速创建 3 角色”。</div>`;
    partyEl.appendChild(empty);
    return;
  }

  for (const r of roles) {
    const card = document.createElement("div");
    card.className = "party-card" + (r.role_id === worldState.active_role_id ? " active" : "");
    card.onclick = async () => {
      await apiSetActiveRole(r.role_id);
    };

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

async function api(path, body, method = "POST") {
  const resp = await fetch(`${API_BASE}${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`${resp.status} ${resp.statusText}: ${text}`);
  }
  return resp.json();
}

async function apiGetMap() {
  const resp = await fetch(`${API_BASE}/map`);
  mapNodes = (await resp.json()).nodes || [];
}

async function apiNewSession() {
  const data = await api("/session/new", { user_id: "demo_user" });
  sessionId = data.session_id;
  worldState = data.world_state;
  logMsg({ kind: "system", content: "已创建新 Session。", timestamp_ms: Date.now() });
  setStatus();
  renderPartyStatus();
}

async function apiUpsertRole(role) {
  const data = await api("/roles/upsert", { session_id: sessionId, role });
  worldState.roles = data.roles;
  worldState.active_role_id = data.active_role_id;
  renderRoles();
  renderPartyStatus();
  setStatus();
}

async function apiSetActiveRole(roleId) {
  const ws = await api(
    "/session/active_role",
    { session_id: sessionId, active_role_id: roleId },
    "PUT",
  );
  worldState = ws;
  renderRoles();
  renderPartyStatus();
  setStatus();
  const active = (worldState.roles || []).find((r) => r.role_id === roleId);
  logMsg({
    kind: "system",
    content: `切换当前角色为：${active?.name || roleId}`,
    timestamp_ms: Date.now(),
  });
}

async function apiAct(action, payload = {}) {
  const data = await api("/act", { session_id: sessionId, action, payload });
  worldState = data.world_state;
  for (const m of data.messages || []) logMsg(m);
  setStatus();
  renderRoles();
  renderPartyStatus();
  updateBackdrop(data.background);
  if (window.__aoTaiMapView) window.__aoTaiMapView.setIndex(worldState.route_node_index);
}

function updateBackdrop(bg) {
  if (!bg) return;
  if (bg.asset_url) {
    backdropEl.style.backgroundImage = `url("${bg.asset_url}")`;
  }
}

function makeRole(name) {
  const id = `r_${Math.random().toString(16).slice(2, 10)}`;
  const avatar_key = AVATAR_KEYS[Math.floor(Math.random() * AVATAR_KEYS.length)];
  return {
    role_id: id,
    name,
    avatar_key,
    persona: `${name}：像素风徒步者。谨慎但乐观。`,
    attrs: { stamina: 70, mood: 60, experience: 10, risk_tolerance: 50 },
  };
}

// Phaser map view (very lightweight)
function initPhaser() {
  const config = {
    type: Phaser.AUTO,
    parent: "game-root",
    width: 640,
    height: 260,
    backgroundColor: "rgba(0,0,0,0)",
    pixelArt: true,
    transparent: true,
    scene: {
      create() {
        const g = this.add.graphics();
        const padX = 40;
        const padY = 120;
        const span = 560;
        const n = Math.max(2, mapNodes.length);
        const points = [];
        for (let i = 0; i < n; i++) {
          const x = padX + (span * i) / (n - 1);
          points.push({ x, y: padY });
        }
        const draw = (idx) => {
          g.clear();
          // route line
          g.lineStyle(4, 0x99aacc, 1);
          g.beginPath();
          g.moveTo(points[0].x, points[0].y);
          for (const p of points.slice(1)) g.lineTo(p.x, p.y);
          g.strokePath();
          // nodes
          for (let i = 0; i < points.length; i++) {
            const p = points[i];
            const done = i <= idx;
            g.fillStyle(done ? 0x7cf2ff : 0x223044, 1);
            g.fillRect(p.x - 6, p.y - 6, 12, 12);
          }
          // marker
          const m = points[Math.min(idx, points.length - 1)];
          g.fillStyle(0xffd27c, 1);
          g.fillRect(m.x - 4, m.y - 24, 8, 16);
        };

        window.__aoTaiMapView = {
          setIndex: (i) => draw(i),
        };
        draw(0);
      },
    },
  };
  new Phaser.Game(config);
}

async function bootstrap() {
  await apiGetMap();
  await apiNewSession();
  initPhaser();

  // Wire action buttons
  $("#actions-panel").addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-act]");
    if (!btn) return;
    apiAct(btn.getAttribute("data-act"));
  });

  $("#btn-say").onclick = async () => {
    const text = ($("#say-input").value || "").trim();
    $("#say-input").value = "";
    await apiAct("SAY", { text });
  };

  $("#btn-add-role").onclick = async () => {
    const name = ($("#new-role-name").value || "").trim();
    if (!name) return;
    $("#new-role-name").value = "";
    await apiUpsertRole(makeRole(name));
    logMsg({ kind: "system", content: `新增角色：${name}`, timestamp_ms: Date.now() });
  };

  $("#btn-quickstart").onclick = async () => {
    const defaults = ["阿鳌", "太白", "小山"];
    for (const n of defaults) await apiUpsertRole(makeRole(n));
    logMsg({ kind: "system", content: "已创建 3 个默认角色。", timestamp_ms: Date.now() });
  };

  // First hint
  logMsg({
    kind: "system",
    content: "点击“快速创建 3 角色”，然后用动作按钮开始徒步。",
    timestamp_ms: Date.now(),
  });
}

bootstrap().catch((err) => {
  console.error(err);
  logMsg({ kind: "system", content: `启动失败：${err.message}`, timestamp_ms: Date.now() });
});
