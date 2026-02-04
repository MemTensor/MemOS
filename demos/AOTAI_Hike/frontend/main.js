const API_BASE = "/api/demo/ao-tai";

const $ = (sel) => document.querySelector(sel);
const chatEl = $("#chat");
const rolesEl = $("#roles");
const statusEl = $("#status");
const partyEl = $("#party-status");
const branchEl = $("#branch-choices");

let mapNodes = [];
let mapEdges = [];
let mapStartNodeId = "start";
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

function nodeById(id) {
  if (!id) return null;
  return (mapNodes || []).find((n) => n.node_id === id) || null;
}

function edgeByToId(fromId, toId) {
  return (mapEdges || []).find((e) => e.from_node_id === fromId && e.to_node_id === toId) || null;
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
  const node = nodeById(worldState.current_node_id) || mapNodes[Math.min(worldState.route_node_index, mapNodes.length - 1)];
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

function renderBranchChoices() {
  if (!branchEl || !worldState) return;
  const fromId = worldState.current_node_id;
  const nextIds = worldState.available_next_node_ids || [];
  if (!nextIds || nextIds.length <= 1) {
    branchEl.style.display = "none";
    branchEl.innerHTML = "";
    return;
  }

  const items = [];
  for (const id of nextIds) {
    const n = nodeById(id);
    const e = edgeByToId(fromId, id);
    const label = (e && e.label) ? e.label : "下一步";
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
    btn.onclick = () => apiAct("MOVE_FORWARD", { next_node_id: it.id });
    box.appendChild(btn);
  }

  branchEl.appendChild(label);
  branchEl.appendChild(box);
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
  const data = await resp.json();
  mapNodes = data.nodes || [];
  mapEdges = data.edges || [];
  mapStartNodeId = data.start_node_id || "start";
}


async function apiNewSession() {
  const data = await api("/session/new", { user_id: "demo_user" });
  sessionId = data.session_id;
  worldState = data.world_state;
  logMsg({ kind: "system", content: "已创建新 Session。", timestamp_ms: Date.now() });
  setStatus();
  renderPartyStatus();
  renderBranchChoices();
  if (window.__aoTaiMapView) window.__aoTaiMapView.setState(worldState);
}

async function apiUpsertRole(role) {
  const data = await api("/roles/upsert", { session_id: sessionId, role });
  worldState.roles = data.roles;
  worldState.active_role_id = data.active_role_id;
  renderRoles();
  renderPartyStatus();
  renderBranchChoices();
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
  renderBranchChoices();
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
  renderBranchChoices();
  if (window.__aoTaiMapView) window.__aoTaiMapView.setState(worldState);
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

// Phaser trail view (chunk streaming)
// - Renders an endless-ish forest trail by streaming procedurally generated chunks.
// - Uses pixelArt rendering and fixed tile size for a crisp pixel look.
// - For now, chunks are rendered via RenderTexture + simple pixel primitives.
//   Later you can swap `renderChunkToTexture()` to draw real tiles from your tileset.
function initPhaser() {
  const root = document.getElementById("game-root");
  const VIEW_W = Math.max(860, Math.floor(root?.clientWidth || 960));
  const VIEW_H = Math.max(420, Math.floor(root?.clientHeight || 540));

  const TILE = 48; // matches your pixel assets scale

  const hash32 = (s) => {
    let h = 2166136261 >>> 0;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return h >>> 0;
  };

  const mulberry32 = (seed) => {
    let t = seed >>> 0;
    return () => {
      t += 0x6d2b79f5;
      let r = Math.imul(t ^ (t >>> 15), 1 | t);
      r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
      return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
    };
  };

  class HikeScene extends Phaser.Scene {
    constructor() {
      super({ key: "HikeScene" });
      this.world = null;
      this.worldRT = null;
      this.worldOverlay = null;

      this.minimap = null;
      this.minimapG = null;
      this.minimapMarker = null;

      this._curNodeId = null;
      this._visited = new Set();
      this._weather = null;
      this._tod = null;

      this.mainCam = null;
      this.miniCam = null;
    }

    preload() {
      // Your pixel assets (already in frontend/assets)
      this.load.image("grass", "./assets/Dark grass 1.png");
      this.load.image("brick", "./assets/Dark Brick 1.png");
      this.load.image("bush", "./assets/Dark Bush 1.png");
      this.load.image("tree", "./assets/Dark Tree 1.png");
      this.load.image("fence", "./assets/Dark fence 1.png");
      this.load.image("leaves", "./assets/Fallen Leaves 1.png");
      this.load.image("pumpkin", "./assets/Pumpkin 1.png");
    }

    create() {
      // --- containers ---
      this.world = this.add.container(0, 0);
      this.minimap = this.add.container(0, 0);

      // --- main world render texture ---
      this.worldRT = this.add.renderTexture(0, 0, VIEW_W, VIEW_H).setOrigin(0, 0);
      this.world.add(this.worldRT);

      // --- player marker in main view ---
      const mg = this.add.graphics();
      mg.fillStyle(0xffd27c, 1);
      mg.fillRect(0, 0, 10, 18);
      const pKey = "player_marker";
      if (!this.textures.exists(pKey)) mg.generateTexture(pKey, 10, 18);
      mg.destroy();

      this.player = this.add.image(Math.floor(VIEW_W * 0.52), Math.floor(VIEW_H * 0.58), pKey);
      this.player.setOrigin(0.5, 1);
      this.world.add(this.player);

      // --- overlay for weather/time mood ---
      this.worldOverlay = this.add.rectangle(0, 0, VIEW_W, VIEW_H, 0x000000, 0.0).setOrigin(0, 0);
      this.worldOverlay.setDepth(10);
      this.world.add(this.worldOverlay);

      // --- cameras ---
      this.mainCam = this.cameras.main;
      this.mainCam.setViewport(0, 0, VIEW_W, VIEW_H);
      this.mainCam.setBackgroundColor("rgba(0,0,0,0)");

      // minimap camera (top-right)
      const MINI_W = 280;
      const MINI_H = 180;
      this.miniCam = this.cameras.add(VIEW_W - MINI_W - 10, 10, MINI_W, MINI_H);
      this.miniCam.setBackgroundColor("rgba(10,16,28,0.75)");

      // Make cameras see different containers
      this.mainCam.ignore(this.minimap);
      this.miniCam.ignore(this.world);

      // minimap graphics + marker
      this.minimapG = this.add.graphics();
      this.minimap.add(this.minimapG);

      const mm = this.add.graphics();
      mm.fillStyle(0xffd27c, 1);
      mm.fillRect(0, 0, 8, 12);
      const mKey = "minimap_marker";
      if (!this.textures.exists(mKey)) mm.generateTexture(mKey, 8, 12);
      mm.destroy();
      this.minimapMarker = this.add.image(0, 0, mKey).setOrigin(0.5, 1);
      this.minimap.add(this.minimapMarker);

      // Expose API
      window.__aoTaiMapView = {
        setState: (ws) => this.setState(ws),
        // compat
        setNode: (nodeId, visitedIds) => this.setState({ current_node_id: nodeId, visited_node_ids: visitedIds }),
      };

      // initial paint
      this.setState({ current_node_id: mapStartNodeId || "start", visited_node_ids: [mapStartNodeId || "start"], weather: "cloudy", time_of_day: "morning" });
    }

    setState(ws) {
      const nodeId = ws?.current_node_id || mapStartNodeId || "start";
      const visited = ws?.visited_node_ids || [nodeId];
      const weather = ws?.weather || "cloudy";
      const tod = ws?.time_of_day || "morning";

      const nodeChanged = nodeId !== this._curNodeId;
      const moodChanged = weather !== this._weather || tod !== this._tod;

      this._curNodeId = nodeId;
      this._visited = new Set(visited);
      this._weather = weather;
      this._tod = tod;

      // 1) update minimap always
      this._drawMinimap(nodeId);

      // 2) update main world if needed
      if (nodeChanged || moodChanged) {
        this._renderWorld(nodeId, weather, tod);
      }

      // 3) small "step" animation on move
      if (nodeChanged) {
        this.tweens.add({
          targets: this.player,
          x: Math.floor(VIEW_W * 0.52) + 8,
          duration: 160,
          yoyo: true,
          ease: "Sine.easeInOut",
        });
      }
    }

    _renderWorld(nodeId, weather, tod) {
      // Deterministic seed from session + node + mood
      const seedStr = String((window.worldState && window.worldState.session_id) || "seed") + "|" + String(nodeId) + "|" + String(weather) + "|" + String(tod);
      const rng = mulberry32(hash32(seedStr));

      // Clear
      this.worldRT.clear();

      // Base tiling (grass)
      const tilesX = Math.ceil(VIEW_W / TILE) + 1;
      const tilesY = Math.ceil(VIEW_H / TILE) + 1;
      for (let y = 0; y < tilesY; y++) {
        for (let x = 0; x < tilesX; x++) {
          this.worldRT.draw("grass", x * TILE, y * TILE);
        }
      }

      // Path depending on node kind
      const n = nodeById(nodeId);
      const kind = n?.kind || "main";
      const centerY = Math.floor(tilesY / 2);
      const pathW = kind === "camp" ? 4 : kind === "lake" ? 2 : 3;
      const wobbleAmp = kind === "junction" ? 2 : 1;

      for (let x = 0; x < tilesX; x++) {
        const wobble = rng() < 0.25 ? (rng() < 0.5 ? -wobbleAmp : wobbleAmp) : 0;
        const cy = clamp(centerY + wobble, 2, tilesY - 3);
        for (let dy = -Math.floor(pathW / 2); dy <= Math.floor(pathW / 2); dy++) {
          const yy = cy + dy;
          this.worldRT.draw("brick", x * TILE, yy * TILE);
        }
      }

      // Sprinkle leaves
      const leafN = 40 + Math.floor(rng() * 80);
      for (let i = 0; i < leafN; i++) {
        const px = Math.floor(rng() * (VIEW_W - 16));
        const py = Math.floor(rng() * (VIEW_H - 16));
        this.worldRT.draw("leaves", px, py);
      }

      // Trees/bushes/fence depending on kind
      const bigCount = kind === "lake" ? 2 : 4;
      for (let i = 0; i < bigCount; i++) {
        const left = rng() < 0.5;
        const x = left ? Math.floor(rng() * (VIEW_W * 0.25)) : Math.floor(VIEW_W * 0.75 + rng() * (VIEW_W * 0.25));
        const y = Math.floor(VIEW_H * 0.38 + rng() * (VIEW_H * 0.32));
        this.worldRT.draw("tree", x, y - 64);
      }

      const bushN = 6 + Math.floor(rng() * 6);
      for (let i = 0; i < bushN; i++) {
        const x = Math.floor(rng() * (VIEW_W - 32));
        const y = Math.floor(VIEW_H * 0.45 + rng() * (VIEW_H * 0.45));
        this.worldRT.draw("bush", x, y - 24);
      }

      if (kind === "camp" || rng() < 0.35) {
        const fx = Math.floor(VIEW_W * 0.12);
        this.worldRT.draw("fence", fx, Math.floor(VIEW_H * 0.6));
        this.worldRT.draw("fence", fx + 140, Math.floor(VIEW_H * 0.6));
      }

      if (rng() < 0.18) {
        const x = Math.floor(VIEW_W * 0.45 + rng() * 120);
        const y = Math.floor(VIEW_H * 0.72);
        this.worldRT.draw("pumpkin", x, y);
      }

      // Weather/time overlay
      let overlayColor = 0x000000;
      let overlayAlpha = 0.0;

      if (tod === "evening" || tod === "night") {
        overlayColor = 0x000000;
        overlayAlpha = tod === "night" ? 0.35 : 0.18;
      }
      if (tod === "morning") {
        overlayColor = 0x0b1630;
        overlayAlpha = 0.08;
      }

      if (weather === "foggy") {
        overlayColor = 0xc6d0e8;
        overlayAlpha = 0.18;
      }
      if (weather === "rainy") {
        overlayColor = 0x2b3c66;
        overlayAlpha = 0.16;
      }
      if (weather === "sunny") {
        overlayColor = 0xffd27c;
        overlayAlpha = 0.06;
      }

      this.worldOverlay.fillColor = overlayColor;
      this.worldOverlay.setAlpha(overlayAlpha);
    }

    _drawMinimap(nodeId) {
      const MINI_W = this.miniCam.width;
      const MINI_H = this.miniCam.height;

      const pad = 14;
      const mapW = MINI_W - pad * 2;
      const mapH = MINI_H - pad * 2;

      const toMini = (n) => {
        const x = pad + (clamp(n.x, 0, 100) / 100) * mapW;
        const y = pad + (clamp(n.y, 0, 100) / 100) * mapH;
        return { x: x, y: y };
      };

      this.minimapG.clear();

      // frame
      this.minimapG.lineStyle(2, 0x3a4a66, 1);
      this.minimapG.strokeRect(1, 1, MINI_W - 2, MINI_H - 2);

      // edges
      for (const e of mapEdges || []) {
        const a = nodeById(e.from_node_id);
        const b = nodeById(e.to_node_id);
        if (!a || !b) continue;
        const pa = toMini(a);
        const pb = toMini(b);

        const visited = this._visited.has(e.to_node_id);
        const color = e.kind === "exit" ? 0xff7c7c : 0x7cf2ff;
        const alpha = visited ? 0.9 : 0.25;
        const width = visited ? 3 : 2;

        this.minimapG.lineStyle(width, color, alpha);
        this.minimapG.beginPath();
        this.minimapG.moveTo(pa.x, pa.y);
        this.minimapG.lineTo(pb.x, pb.y);
        this.minimapG.strokePath();
      }

      // nodes
      for (const n of mapNodes || []) {
        const p = toMini(n);
        const isCur = n.node_id === nodeId;
        const isVisited = this._visited.has(n.node_id);

        let fill = 0x223044;
        if (n.kind === "camp") fill = 0x1b2a21;
        if (n.kind === "lake") fill = 0x0e2a3d;
        if (n.kind === "peak") fill = 0x232b45;
        if (n.kind === "exit") fill = 0x301820;
        if (n.kind === "start") fill = 0x1f4b2b;
        if (n.kind === "end") fill = 0x18311f;

        let stroke = 0x3a4a66;
        if (isVisited) stroke = 0x7cf2ff;
        if (isCur) stroke = 0xffd27c;

        this.minimapG.fillStyle(fill, 0.95);
        this.minimapG.fillRect(p.x - 4, p.y - 4, 8, 8);
        this.minimapG.lineStyle(2, stroke, 1);
        this.minimapG.strokeRect(p.x - 4, p.y - 4, 8, 8);
      }

      // marker
      const cur = nodeById(nodeId);
      if (cur) {
        const mp = toMini(cur);
        this.minimapMarker.setPosition(mp.x, mp.y);
      }
    }
  }

  const config = {
    type: Phaser.AUTO,
    parent: "game-root",
    width: VIEW_W,
    height: VIEW_H,
    backgroundColor: "rgba(0,0,0,0)",
    pixelArt: true,
    antialias: false,
    transparent: true,
    scene: [HikeScene],
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
