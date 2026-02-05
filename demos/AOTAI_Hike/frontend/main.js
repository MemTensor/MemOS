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
  if (!chatEl) return;
  const isNearBottom = (el, thresholdPx = 32) =>
    el.scrollTop + el.clientHeight >= el.scrollHeight - thresholdPx;
  const stickToBottom = isNearBottom(chatEl);

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
  // Auto-scroll to bottom only if user is already near bottom.
  // Use rAF to wait for layout so it works with flex panels / dynamic heights.
  if (stickToBottom) {
    const scrollToBottom = () => {
      try {
        chatEl.scrollTop = chatEl.scrollHeight;
      } catch {}
    };
    try {
      requestAnimationFrame(scrollToBottom);
      // extra microtask for cases where multiple messages append in the same tick
      setTimeout(scrollToBottom, 0);
    } catch {
      scrollToBottom();
    }
  }
}

function setStatus() {
  if (!worldState) return;
  const node = nodeById(worldState.current_node_id) || mapNodes[Math.min(worldState.route_node_index, mapNodes.length - 1)];
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

function renderRoles() {
  if (!rolesEl || !worldState) return;
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
    empty.innerHTML = `<div class="party-name">队伍状态</div><div class="party-sub">还没有队员。请先在启动弹窗里创建角色。</div>`;
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


function makeRole(name, persona) {
  const id = `r_${Math.random().toString(16).slice(2, 10)}`;
  const avatar_key = AVATAR_KEYS[Math.floor(Math.random() * AVATAR_KEYS.length)];
  return {
    role_id: id,
    name,
    avatar_key,
    persona: (persona && String(persona).trim()) ? String(persona).trim() : `${name}：像素风徒步者。谨慎但乐观。`,
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
  const rect = root ? root.getBoundingClientRect() : { width: 960, height: 540 };
  const qs = new URLSearchParams(window.location.search);
  // Integer zoom for crisp pixels/text (avoid CSS non-integer stretching blur)
  const ZOOM = Math.max(1, Math.floor(Number(qs.get("scale")) || 2));
  const VIEW_W = Math.max(160, Math.floor((rect.width || 960) / ZOOM));
  const VIEW_H = Math.max(120, Math.floor((rect.height || 540) / ZOOM));

  // Minimap label clarity tunables
  // - Increase font size to improve readability (defaults to 8px instead of 5px)
  // - Keep text resolution aligned to devicePixelRatio (avoid huge downscale blur)
  // - Also set Phaser canvas resolution to devicePixelRatio for crisp rendering on HiDPI screens
  // URL params:
  // - miniFontPx / mmFontPx: integer px (e.g. ?miniFontPx=9)
  // - miniTextRes: 1..4 (e.g. ?miniTextRes=2)
  // - dpr: 1..3 (e.g. ?dpr=2)
  // - miniOverlay: 1/0 (default 1) render minimap via a separate HiDPI overlay canvas
  // - miniDpr: 1..8 (default ~ max(3, devicePixelRatio*2)) overlay-only pixel density (minimap can be sharper than main view)
  // - miniHidePhaser: 1/0 (default 1) when using overlay, skip drawing the Phaser minimap layer
  const GAME_RESOLUTION = Math.max(
    1,
    Math.min(3, Number(qs.get("dpr")) || (window.devicePixelRatio || 1)),
  );
  const USE_MINIMAP_OVERLAY = (qs.get("miniOverlay") ?? "1") !== "0";
  const SKIP_PHASER_MINIMAP = USE_MINIMAP_OVERLAY && (qs.get("miniHidePhaser") ?? "1") !== "0";
  const MINI_OVERLAY_DPR = Math.max(
    1,
    Math.min(
      8,
      Number(qs.get("miniDpr")) ||
        Math.min(8, Math.max(3, Math.round((window.devicePixelRatio || 1) * 2))),
    ),
  );
  const MINI_LABEL_FONT_PX = Math.max(
    6,
    Math.floor(Number(qs.get("miniFontPx") || qs.get("mmFontPx")) || 14),
  );
  const MINI_TEXT_RESOLUTION = Math.max(
    1,
    Math.min(6, Math.round(Number(qs.get("miniTextRes")) || Math.max(2, GAME_RESOLUTION))),
  );
  const MINI_LABEL_OFF_X = 8;
  const MINI_LABEL_OFF_Y = Math.max(6, Math.round(MINI_LABEL_FONT_PX * 0.95));
  const MINI_LABEL_STROKE_W = Math.max(1, Math.round(MINI_LABEL_FONT_PX / 9));

  // Overlay draw hooks (assigned later if overlay is enabled)
  let __drawMinimapOverlay = null;
  let __minimapOverlayDrew = false;

  // Split the canvas: minimap on top, main scene below
  const MINI_H = Math.max(90, Math.floor(VIEW_H * 0.26));
  const MAIN_H = Math.max(160, VIEW_H - MINI_H);

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
      this.minimapLabels = [];

      this._curNodeId = null;
      this._visited = new Set();
      this._weather = null;
      this._tod = null;
      this._ws = null;
      this._walkKey = "";
      this._sceneKey = "";

      this.mainCam = null;
      this.miniCam = null;
    }

    preload() {
      this._assetErrors = [];
      this.load.setPath("./assets/");

      const loadImg = (key, file) => {
        // encode spaces etc
        this.load.image(key, encodeURI(file));
      };

      loadImg("grass", "Dark grass 1.png");
      loadImg("brick", "Dark Brick 1.png");
      loadImg("bush", "Dark Bush 1.png");
      loadImg("tree", "Dark Tree 1.png");
      loadImg("fence", "Dark fence 1.png");
      loadImg("leaves", "Fallen Leaves 1.png");
      loadImg("pumpkin", "Pumpkin 1.png");

      this.load.on("loaderror", (file) => {
        try {
          this._assetErrors.push(file && (file.key || file.src || file.url) ? (file.key || file.src || file.url) : "unknown");
        } catch {
          this._assetErrors.push("unknown");
        }
      });
    }

    create() {
      // --- containers ---
      this.world = this.add.container(0, 0);
      this.minimap = this.add.container(0, 0);

      // --- main world render texture ---
      this.worldRT = this.add.renderTexture(0, 0, VIEW_W, MAIN_H).setOrigin(0, 0);
      this.world.add(this.worldRT);

      // --- player marker in main view ---
      const mg = this.add.graphics();
      mg.fillStyle(0xffd27c, 1);
      mg.fillRect(0, 0, 10, 18);
      const pKey = "player_marker";
      if (!this.textures.exists(pKey)) mg.generateTexture(pKey, 10, 18);
      mg.destroy();

      this.player = this.add.image(Math.floor(VIEW_W * 0.50), Math.floor(MAIN_H * 0.78), pKey);
      this.player.setOrigin(0.5, 1);
      this.world.add(this.player);

      // --- overlay for weather/time mood ---
      this.worldOverlay = this.add.rectangle(0, 0, VIEW_W, MAIN_H, 0x000000, 0.0).setOrigin(0, 0);
      this.worldOverlay.setDepth(10);
      this.world.add(this.worldOverlay);

      // --- cameras ---
      this.mainCam = this.cameras.main;
      this.mainCam.setViewport(0, MINI_H, VIEW_W, MAIN_H);
      this.mainCam.setBackgroundColor("rgba(0,0,0,0)");

      // minimap camera (top-right)
      const MINI_W = 280;
      this.miniCam = this.cameras.add(0, 0, VIEW_W, MINI_H);
      this.miniCam.setBackgroundColor("rgba(10,16,28,0.75)");
      this.miniCam.roundPixels = true;
      this.mainCam.roundPixels = true;

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

      const walkKey = `${nodeId}|${ws?.in_transit_from_node_id || ""}|${ws?.in_transit_to_node_id || ""}|${Number(ws?.in_transit_progress_km || 0)}`;
      const walkChanged = walkKey !== this._walkKey;
      this._walkKey = walkKey;

      this._curNodeId = nodeId;
      this._visited = new Set(visited);
      this._weather = weather;
      this._tod = tod;
      this._ws = ws || {};

      // If minimap overlay is enabled, draw it here so the initial `this.setState(...)`
      // call during scene `create()` also renders the minimap (otherwise it can stay blank
      // until external callers invoke `window.__aoTaiMapView.setState(...)`).
      if (typeof __drawMinimapOverlay === "function") {
        try {
          __drawMinimapOverlay(this._ws, this._visited, nodeId);
        } catch {}
      }

      // 1) update minimap (skip Phaser minimap if overlay canvas is enabled)
      // only hide Phaser minimap after overlay has successfully drawn at least once,
      // otherwise the minimap area can appear blank.
      if (!(SKIP_PHASER_MINIMAP && __minimapOverlayDrew)) this._drawMinimap(nodeId);
      // 2) update main world: re-render ONLY when location/segment changes (not every km/time tick)
      const segFrom = ws?.in_transit_from_node_id || nodeId;
      const segTo = ws?.in_transit_to_node_id || nodeId;
      const sceneKey = `${nodeId}|${segFrom}|${segTo}`;
      const sceneChanged = sceneKey !== this._sceneKey;
      this._sceneKey = sceneKey;
      if (nodeChanged || sceneChanged) {
        this._renderWorld(nodeId, segFrom, segTo);
      }
      // mood overlay can change frequently without re-rendering tiles
      if (moodChanged) {
        this._applyMoodOverlay(weather, tod);
      }

      // 3) small "step" animation on move
      if (nodeChanged || walkChanged) {
        // Background scroll down a bit => feels like walking up
        this.tweens.add({
          targets: this.worldRT,
          y: 14,
          duration: 220,
          yoyo: true,
          ease: "Sine.easeInOut",
        });
        // tiny player bob
        this.tweens.add({
          targets: this.player,
          y: this.player.y - 6,
          duration: 220,
          yoyo: true,
          ease: "Sine.easeInOut",
        });
      }
    }

    _applyMoodOverlay(weather, tod) {
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

      if (this.worldOverlay) {
        this.worldOverlay.fillColor = overlayColor;
        this.worldOverlay.setAlpha(overlayAlpha);
      }
    }

    _renderWorld(nodeId, segFrom, segTo) {
      // Deterministic seed from session + node + mood
      const seedStr = String((worldState && worldState.session_id) || "seed") + "|" + String(nodeId) + "|" + String(segFrom || "") + "|" + String(segTo || "");
      const rng = mulberry32(hash32(seedStr));

      // Fallback: if assets failed to load, render a simple placeholder
      if (!this.textures.exists("grass") || (this._assetErrors && this._assetErrors.length)) {
        this.worldRT.clear();
        this.worldRT.fill(0x0b1630, 1, 0, 0, VIEW_W, MAIN_H);
        // simple path
        const py = Math.floor(MAIN_H * 0.55);
        this.worldRT.fill(0x223044, 1, 0, py, VIEW_W, 80);
        return;
      }

      // Clear
      this.worldRT.clear();

      // Base tiling (grass)
      const tilesX = Math.ceil(VIEW_W / TILE) + 1;
      const tilesY = Math.ceil(MAIN_H / TILE) + 1;
      for (let y = 0; y < tilesY; y++) {
        for (let x = 0; x < tilesX; x++) {
          this.worldRT.draw("grass", x * TILE, y * TILE);
        }
      }


      // Path depending on node kind (VERTICAL: bottom -> top)
      const n = nodeById(nodeId);
      const kind = n?.kind || "main";

      // center X, with a gentle drift as Y increases
      let cx = Math.floor(tilesX / 2);
      const pathW = kind === "camp" ? 3 : kind === "lake" ? 3 : 2;
      const driftMax = kind === "junction" ? 2 : 1;

      // Track the path center per row so side props can follow the corridor
      const pathCenterByY = new Array(tilesY);

      for (let y = tilesY - 1; y >= 0; y--) {
        // occasional drift
        if (rng() < 0.22) {
          const d = rng() < 0.5 ? -1 : 1;
          cx = clamp(cx + d, 2, tilesX - 3);
        }
        // small wobble around drifted center
        const wobble = rng() < 0.18 ? (rng() < 0.5 ? -driftMax : driftMax) : 0;
        const xCenter = clamp(cx + wobble, 2, tilesX - 3);
        pathCenterByY[y] = xCenter;

        for (let dx = -Math.floor(pathW / 2); dx <= Math.floor(pathW / 2); dx++) {
          this.worldRT.draw("brick", (xCenter + dx) * TILE, y * TILE);
        }

        // slightly rough edges
        if (rng() < 0.12) this.worldRT.draw("brick", (xCenter - Math.floor(pathW / 2) - 1) * TILE, y * TILE);
        if (rng() < 0.12) this.worldRT.draw("brick", (xCenter + Math.floor(pathW / 2) + 1) * TILE, y * TILE);
      }

      // (tilesX/tilesY already computed above)

      // Sprinkle leaves
      const leafN = 40 + Math.floor(rng() * 80);
      for (let i = 0; i < leafN; i++) {
        const px = Math.floor(rng() * (VIEW_W - 16));
        const py = Math.floor(rng() * (MAIN_H - 16));
        this.worldRT.draw("leaves", px, py);
      }


      // Trees/bushes/fence depending on kind (favor lining the path sides)
      const sideMargin = Math.floor(tilesX * 0.18);
      const leftBandMax = Math.max(2, Math.floor(tilesX / 2) - Math.floor(pathW / 2) - 2);
      const rightBandMin = Math.min(tilesX - 3, Math.floor(tilesX / 2) + Math.floor(pathW / 2) + 2);
      // Trees: place props along the path for "forest corridor" feel
      // Keep spacing stable across different PIXEL_SCALE (small tilesY would otherwise over-pack rows).
      const minGapTiles = 2;
      const maxRows = Math.max(3, Math.floor((tilesY - 2) / minGapTiles));
      const targetRows = clamp(4 + Math.floor(rng() * 3), 3, maxRows);

      let lastLX = -999;
      let lastRX = 999;
      let placed = 0;
      for (let yTile = 1; yTile < tilesY - 1 && placed < targetRows; yTile += minGapTiles) {
        // probabilistic skip for variety / less crowd
        if (rng() < 0.35) continue;

        const yPx = yTile * TILE;
        const center = (pathCenterByY[yTile] ?? Math.floor(tilesX / 2));
        const corridorHalf = Math.floor(pathW / 2);
        const maxOffset = Math.max(5, Math.floor(tilesX * 0.32));

        // alternate offsets so trees don't align into a single column
        const alt = (placed % 3) * 2;
        const offL = 4 + alt + Math.floor(rng() * Math.max(2, maxOffset - alt));
        const offR = 4 + (2 - (placed % 3)) * 2 + Math.floor(rng() * Math.max(2, maxOffset));

        let lxTile = clamp(center - corridorHalf - offL, 1, tilesX - 2);
        let rxTile = clamp(center + corridorHalf + offR, 1, tilesX - 2);

        // ensure some horizontal separation from last placed columns
        if (Math.abs(lxTile - lastLX) < 2) lxTile = clamp(lxTile + 2, 1, tilesX - 2);
        if (Math.abs(rxTile - lastRX) < 2) rxTile = clamp(rxTile - 2, 1, tilesX - 2);

        const lx = lxTile * TILE;
        const rx = rxTile * TILE;

        // Not every row needs both sides
        const both = rng() < 0.40;
        if (both || rng() < 0.65) this.worldRT.draw("tree", lx, yPx - 64);
        if (both || rng() < 0.65) this.worldRT.draw("tree", rx, yPx - 64);

        lastLX = lxTile;
        lastRX = rxTile;
        placed += 1;
      }

      // Bushes: sprinkle near bottom and sides
      const bushN = 10 + Math.floor(rng() * 10);
      for (let i = 0; i < bushN; i++) {
        const sideLeft = rng() < 0.5;
        const xTile = sideLeft ? Math.floor(rng() * leftBandMax) : rightBandMin + Math.floor(rng() * Math.max(1, tilesX - rightBandMin));
        const yPx = Math.floor(rng() * (VIEW_H - 32));
        this.worldRT.draw("bush", xTile * TILE, yPx - 24);
      }

      // Fence hints in camp/exits
      if (kind === "camp" || kind === "exit" || rng() < 0.18) {
        const fx = Math.floor(VIEW_W * 0.18);
        const fy = Math.floor(VIEW_H * 0.78);
        this.worldRT.draw("fence", fx, fy);
        this.worldRT.draw("fence", VIEW_W - fx - 160, fy);
      }

      if (rng() < 0.18) {
        const x = Math.floor(VIEW_W * 0.45 + rng() * 120);
        const y = Math.floor(VIEW_H * 0.72);
        this.worldRT.draw("pumpkin", x, y);
      }
    }

    _drawMinimap(nodeId) {
      const ws = this._ws || {};
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

      for (const t of this.minimapLabels || []) {
        try { t.destroy(); } catch {}
      }
      this.minimapLabels = [];

      // frame
      this.minimapG.lineStyle(2, 0x3a4a66, 1);
      this.minimapG.strokeRect(1, 1, MINI_W - 2, MINI_H - 2);

      // edges (curved for a softer look)
      const curveSign = (s) => {
        let h = 0;
        for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
        return (h & 1) ? 1 : -1;
      };

      // Phaser Graphics doesn't support Canvas quadraticCurveTo; draw curves by sampling points.
      const strokeQuad = (g, ax, ay, cx, cy, bx, by, segments = 16) => {
        g.beginPath();
        g.moveTo(ax, ay);
        for (let i = 1; i <= segments; i++) {
          const t = i / segments;
          const mt = 1 - t;
          const x = mt * mt * ax + 2 * mt * t * cx + t * t * bx;
          const y = mt * mt * ay + 2 * mt * t * cy + t * t * by;
          g.lineTo(x, y);
        }
        g.strokePath();
      };

      for (const e of mapEdges || []) {
        const a = nodeById(e.from_node_id);
        const b = nodeById(e.to_node_id);
        if (!a || !b) continue;
        const pa = toMini(a);
        const pb = toMini(b);

        const visited = this._visited.has(e.to_node_id);
        const isExit = e.kind === "exit";

        const baseColor = isExit ? 0xff7c7c : 0x7cf2ff;
        const alpha = visited ? 0.85 : 0.28;
        const width = visited ? 3 : 2;

        const dx = pb.x - pa.x;
        const dy = pb.y - pa.y;
        const len = Math.max(1, Math.hypot(dx, dy));
        const px = -dy / len;
        const py = dx / len;
        const midx = (pa.x + pb.x) * 0.5;
        const midy = (pa.y + pb.y) * 0.5;
        const bend = (8 + (isExit ? 6 : 0) + (visited ? 3 : 0)) * curveSign(String(e.from_node_id) + "->" + String(e.to_node_id));
        const cx = midx + px * bend;
        const cy = midy + py * bend;
        // glow
        this.minimapG.lineStyle(width + 3, 0x0b1630, Math.min(0.65, alpha));
        strokeQuad(this.minimapG, pa.x, pa.y, cx, cy, pb.x, pb.y, 16);
        // main stroke
        this.minimapG.lineStyle(width, baseColor, alpha);
        strokeQuad(this.minimapG, pa.x, pa.y, cx, cy, pb.x, pb.y, 16);
      }

      // nodes + labels
      for (const n of mapNodes || []) {
        const p = toMini(n);
        const isCur = n.node_id === nodeId;
        const isVisited = this._visited.has(n.node_id) || isCur;

        const kind = n.kind || "main";
        const kColor = kind === "exit" ? 0xff7c7c : kind === "camp" ? 0x7cffc6 : kind === "lake" ? 0x7ca8ff : kind === "peak" ? 0xffd27c : kind === "start" ? 0x9dff7c : kind === "end" ? 0xb0b6c6 : 0x7cf2ff;

        // soft glow + dot
        this.minimapG.fillStyle(0x0b1630, 0.85);
        this.minimapG.fillCircle(p.x, p.y, isCur ? 7 : 6);
        this.minimapG.fillStyle(kColor, isVisited ? 0.95 : 0.55);
        this.minimapG.fillCircle(p.x, p.y, isCur ? 5 : 4);

        // label (only key nodes + current to avoid clutter)
        const isKey = isCur || ["start", "camp", "junction", "lake", "peak", "exit", "end"].includes(kind);
        const label = (n.name || n.node_id || "").trim();
        if (isKey && label) {
          const t = this.add.text(p.x + MINI_LABEL_OFF_X, p.y - MINI_LABEL_OFF_Y, label, {
            // Use a CJK-friendly font stack to improve readability for Chinese labels
            fontFamily: '"PingFang SC","Hiragino Sans GB","Microsoft YaHei",ui-monospace,Menlo,Monaco,Consolas,monospace',
            fontSize: `${MINI_LABEL_FONT_PX}px`,
            antialias: false,
            color: isVisited ? "#d6faff" : "#7aa0b3",
          });
          // keep internal text resolution close to actual device pixel ratio
          t.setResolution(MINI_TEXT_RESOLUTION);
          // force nearest-neighbor sampling for the text texture (avoid blur)
          try {
            this.textures.get(t.texture.key).setFilter(Phaser.Textures.FilterMode.NEAREST);
          } catch {}
          t.setStroke("#061022", MINI_LABEL_STROKE_W);
          t.setAlpha(isCur ? 1.0 : 0.86);
          t.setPadding(2, 1, 2, 1);
          t.setBackgroundColor("#061022");
          t.setShadow(1, 1, "#000000", 2, false, true);
          t.setDepth(5);
          // snap label to whole pixels
          t.x = Math.round(t.x);
          t.y = Math.round(t.y);
          this.minimap.add(t);
          this.minimapLabels.push(t);
        }
      }

      // marker
      const cur = nodeById(nodeId);
      const toId = ws && ws.in_transit_to_node_id;
      const fromId = ws && ws.in_transit_from_node_id;
      const prog = (ws && ws.in_transit_progress_km) || 0;
      const tot = (ws && ws.in_transit_total_km) || 0;

      if (fromId && toId && tot > 0) {
        const a = nodeById(fromId);
        const b = nodeById(toId);
        if (a && b) {
          const pa = toMini(a);
          const pb = toMini(b);
          const t = clamp(prog / tot, 0, 1);
          this.minimapMarker.setPosition(pa.x + (pb.x - pa.x) * t, pa.y + (pb.y - pa.y) * t);
          return;
        }
      }

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
    resolution: GAME_RESOLUTION,
    scale: {
      mode: Phaser.Scale.NONE,
      zoom: ZOOM,
      autoCenter: Phaser.Scale.CENTER_BOTH,
    },
    backgroundColor: "rgba(0,0,0,0)",
    pixelArt: true,
    antialias: false,
    transparent: true,
    scene: [HikeScene],
  };

  const game = new Phaser.Game(config);

  // Optional: render minimap on its own overlay canvas (independent resolution from Phaser canvas)
  if (USE_MINIMAP_OVERLAY) {
    // IMPORTANT: create overlay *after* Phaser has created/attached its own canvas.
    // If we pre-create a canvas inside the parent, Phaser may reuse it as the main render canvas.
    let overlay = document.getElementById("minimap-overlay");
    if (!overlay && root) {
      overlay = document.createElement("canvas");
      overlay.id = "minimap-overlay";
      overlay.setAttribute("aria-hidden", "true");
      root.appendChild(overlay);
    }
    const ctx = overlay && overlay.getContext ? overlay.getContext("2d") : null;
    let lastDrawKey = "";

    const nodeById = (id) => (mapNodes || []).find((n) => String(n.node_id) === String(id));

    const curveSign = (s) => {
      let h = 0;
      for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
      return (h & 1) ? 1 : -1;
    };

    const syncOverlayLayout = () => {
      if (!overlay || !root || !game || !game.canvas) return null;
      const rootRect = root.getBoundingClientRect();
      const canvasRect = game.canvas.getBoundingClientRect();
      const miniCssH = (MINI_H / VIEW_H) * canvasRect.height;
      if (canvasRect.width < 2 || canvasRect.height < 2 || miniCssH < 2) return null;

      overlay.style.left = `${canvasRect.left - rootRect.left}px`;
      overlay.style.top = `${canvasRect.top - rootRect.top}px`;
      overlay.style.width = `${canvasRect.width}px`;
      overlay.style.height = `${miniCssH}px`;

      const pxW = Math.max(1, Math.round(canvasRect.width * MINI_OVERLAY_DPR));
      const pxH = Math.max(1, Math.round(miniCssH * MINI_OVERLAY_DPR));
      if (overlay.width !== pxW) overlay.width = pxW;
      if (overlay.height !== pxH) overlay.height = pxH;

      return { cssW: canvasRect.width, cssH: miniCssH };
    };

    const drawOverlay = (ws, visitedSet, nodeId) => {
      if (!overlay || !ctx) return false;
      const layout = syncOverlayLayout();
      if (!layout) return false;

      const cssW = layout.cssW;
      const cssH = layout.cssH;

      // draw in CSS pixel coordinates (ctx scaled by DPR)
      ctx.setTransform(MINI_OVERLAY_DPR, 0, 0, MINI_OVERLAY_DPR, 0, 0);
      ctx.clearRect(0, 0, cssW, cssH);

      // background panel (opaque enough to mask Phaser minimap behind it)
      ctx.fillStyle = "rgba(10,16,28,0.92)";
      ctx.fillRect(0, 0, cssW, cssH);
      ctx.strokeStyle = "rgba(124,242,255,0.38)";
      ctx.lineWidth = 2;
      ctx.strokeRect(1, 1, cssW - 2, cssH - 2);

      const pad = 14;
      const mapW = Math.max(10, cssW - pad * 2);
      const mapH = Math.max(10, cssH - pad * 2);
      const toMini = (n) => {
        const x = pad + (clamp(n.x, 0, 100) / 100) * mapW;
        const y = pad + (clamp(n.y, 0, 100) / 100) * mapH;
        return { x, y };
      };

      // edges (quadratic curves)
      for (const e of mapEdges || []) {
        const a = nodeById(e.from_node_id);
        const b = nodeById(e.to_node_id);
        if (!a || !b) continue;
        const pa = toMini(a);
        const pb = toMini(b);

        const visited = visitedSet && visitedSet.has(String(e.to_node_id));
        const isExit = e.kind === "exit";
        const baseColor = isExit ? "rgba(255,124,124,1)" : "rgba(124,242,255,1)";
        const alpha = visited ? 0.85 : 0.28;
        const width = visited ? 3 : 2;

        const dx = pb.x - pa.x;
        const dy = pb.y - pa.y;
        const len = Math.max(1, Math.hypot(dx, dy));
        const px = -dy / len;
        const py = dx / len;
        const midx = (pa.x + pb.x) * 0.5;
        const midy = (pa.y + pb.y) * 0.5;
        const bend =
          (8 + (isExit ? 6 : 0) + (visited ? 3 : 0)) *
          curveSign(String(e.from_node_id) + "->" + String(e.to_node_id));
        const cx = midx + px * bend;
        const cy = midy + py * bend;

        // glow
        ctx.strokeStyle = `rgba(11,22,48,${Math.min(0.65, alpha)})`;
        ctx.lineWidth = width + 3;
        ctx.beginPath();
        ctx.moveTo(pa.x, pa.y);
        ctx.quadraticCurveTo(cx, cy, pb.x, pb.y);
        ctx.stroke();

        // main stroke
        ctx.strokeStyle = baseColor.replace("1)", `${alpha})`);
        ctx.lineWidth = width;
        ctx.beginPath();
        ctx.moveTo(pa.x, pa.y);
        ctx.quadraticCurveTo(cx, cy, pb.x, pb.y);
        ctx.stroke();
      }

      // nodes + labels
      const font = `"PingFang SC","Hiragino Sans GB","Microsoft YaHei",system-ui,sans-serif`;
      ctx.textBaseline = "middle";
      ctx.font = `${MINI_LABEL_FONT_PX}px ${font}`;

      for (const n of mapNodes || []) {
        const p = toMini(n);
        const isCur = String(n.node_id) === String(nodeId);
        const isVisited = (visitedSet && visitedSet.has(String(n.node_id))) || isCur;

        const kind = n.kind || "main";
        const kColor =
          kind === "exit"
            ? "#ff7c7c"
            : kind === "camp"
              ? "#7cffc6"
              : kind === "lake"
                ? "#7ca8ff"
                : kind === "peak"
                  ? "#ffd27c"
                  : kind === "start"
                    ? "#9dff7c"
                    : kind === "end"
                      ? "#b0b6c6"
                      : "#7cf2ff";

        // glow + dot
        ctx.fillStyle = "rgba(11,22,48,0.85)";
        ctx.beginPath();
        ctx.arc(p.x, p.y, isCur ? 7 : 6, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = isVisited ? kColor : "rgba(124,242,255,0.55)";
        ctx.beginPath();
        ctx.arc(p.x, p.y, isCur ? 5 : 4, 0, Math.PI * 2);
        ctx.fill();

        // label (only key nodes + current)
        const isKey =
          isCur || ["start", "camp", "junction", "lake", "peak", "exit", "end"].includes(kind);
        const label = (n.name || n.node_id || "").trim();
        if (isKey && label) {
          const x = Math.round(p.x + MINI_LABEL_OFF_X);
          const y = Math.round(p.y - MINI_LABEL_OFF_Y);

          const metrics = ctx.measureText(label);
          const textW = metrics.width;
          const bgPadX = 6;
          const bgPadY = 4;

          ctx.fillStyle = "rgba(6,16,34,0.92)";
          ctx.fillRect(x - 2, y - MINI_LABEL_FONT_PX / 2 - bgPadY, textW + bgPadX, MINI_LABEL_FONT_PX + bgPadY * 2);

          ctx.lineWidth = MINI_LABEL_STROKE_W;
          ctx.strokeStyle = "rgba(6,16,34,1)";
          ctx.fillStyle = isVisited ? "#d6faff" : "#7aa0b3";
          ctx.strokeText(label, x + 1, y);
          ctx.fillText(label, x + 1, y);
        }
      }

      // marker (transit aware)
      const toId = ws && ws.in_transit_to_node_id;
      const fromId = ws && ws.in_transit_from_node_id;
      const prog = (ws && ws.in_transit_progress_km) || 0;
      const tot = (ws && ws.in_transit_total_km) || 0;

      let mp = null;
      if (fromId && toId && tot > 0) {
        const a = nodeById(fromId);
        const b = nodeById(toId);
        if (a && b) {
          const pa = toMini(a);
          const pb = toMini(b);
          const t = clamp(prog / tot, 0, 1);
          mp = { x: pa.x + (pb.x - pa.x) * t, y: pa.y + (pb.y - pa.y) * t };
        }
      }
      if (!mp) {
        const cur = nodeById(nodeId);
        if (cur) mp = toMini(cur);
      }
      if (mp) {
        ctx.fillStyle = "#ffd27c";
        ctx.fillRect(Math.round(mp.x - 4), Math.round(mp.y - 12), 8, 12);
        ctx.strokeStyle = "rgba(0,0,0,0.35)";
        ctx.lineWidth = 1;
        ctx.strokeRect(Math.round(mp.x - 4) + 0.5, Math.round(mp.y - 12) + 0.5, 8, 12);
      }
      return true;
    };

    // expose to the scene setState via closure hook
    __drawMinimapOverlay = (ws, visitedSet, nodeId) => {
      // visitedSet may be a Set of ids; normalize if needed
      const vs =
        visitedSet && typeof visitedSet.has === "function"
          ? visitedSet
          : new Set((ws?.visited_node_ids || [nodeId]).map(String));
      const ok = drawOverlay(ws, vs, nodeId);
      if (ok) {
        __minimapOverlayDrew = true;
      } else {
        // layout may not be ready on the first tick; retry next frame
        try {
          requestAnimationFrame(() => {
            const ok2 = drawOverlay(ws, vs, nodeId);
            if (ok2) __minimapOverlayDrew = true;
          });
        } catch {}
      }
    };

    // keep overlay aligned on resize
    try {
      new ResizeObserver(() => {
        // redraw will re-sync layout
        if (window.__aoTaiMapView && window.__aoTaiMapView.__last_ws) {
          const ws = window.__aoTaiMapView.__last_ws;
          const nodeId = ws?.current_node_id || mapStartNodeId || "start";
          const visited = new Set((ws?.visited_node_ids || [nodeId]).map(String));
          drawOverlay(ws, visited, nodeId);
        } else {
          syncOverlayLayout();
        }
      }).observe(root);
    } catch {}

    const attachToMapView = (mv) => {
      if (!mv || typeof mv.setState !== "function") return;
      if (mv.__minimap_overlay_attached) return;
      mv.__minimap_overlay_attached = true;

      const orig = mv.setState;
      mv.setState = (ws) => {
        mv.__last_ws = ws;
        try {
          const nodeId = ws?.current_node_id || mapStartNodeId || "start";
          const visited = new Set((ws?.visited_node_ids || [nodeId]).map(String));
          const key = `${nodeId}|${(ws?.visited_node_ids || []).length}|${ws?.in_transit_from_node_id || ""}|${ws?.in_transit_to_node_id || ""}|${Number(ws?.in_transit_progress_km || 0)}|${Number(ws?.in_transit_total_km || 0)}|${MINI_OVERLAY_DPR}`;
          if (key !== lastDrawKey) {
            lastDrawKey = key;
            drawOverlay(ws, visited, nodeId);
          }
        } catch {}
        return orig(ws);
      };

      // compat path used elsewhere
      if (typeof mv.setNode === "function") {
        const origNode = mv.setNode;
        mv.setNode = (nodeId, visitedIds) => {
          const ws = { current_node_id: nodeId, visited_node_ids: visitedIds || [nodeId] };
          try {
            mv.__last_ws = ws;
            const visited = new Set((ws.visited_node_ids || [nodeId]).map(String));
            drawOverlay(ws, visited, nodeId);
          } catch {}
          return origNode(nodeId, visitedIds);
        };
      }

      // draw at least once if we already have state
      try {
        const ws = mv.__last_ws;
        if (ws) {
          const nodeId = ws?.current_node_id || mapStartNodeId || "start";
          const visited = new Set((ws?.visited_node_ids || [nodeId]).map(String));
          drawOverlay(ws, visited, nodeId);
        } else {
          syncOverlayLayout();
        }
      } catch {}
    };

    // Ensure we attach even if __aoTaiMapView is assigned later by the Phaser scene.
    // This is the key fix: previously we could miss the assignment and never draw overlay.
    try {
      const hasDesc = Object.getOwnPropertyDescriptor(window, "__aoTaiMapView");
      if (!hasDesc || hasDesc.configurable) {
        let _mv = window.__aoTaiMapView;
        Object.defineProperty(window, "__aoTaiMapView", {
          configurable: true,
          enumerable: true,
          get() {
            return _mv;
          },
          set(v) {
            _mv = v;
            try { attachToMapView(_mv); } catch {}
          },
        });
        // attach immediately if it's already present
        if (_mv) attachToMapView(_mv);
      } else {
        // fallback: if non-configurable, do a best-effort immediate attach
        attachToMapView(window.__aoTaiMapView);
      }
    } catch {
      attachToMapView(window.__aoTaiMapView);
    }
  }
}

async function bootstrap() {
  await apiGetMap();
  await apiNewSession();
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
      empty.textContent = "还没有待创建的角色。可以先填写名字/介绍加入列表，或点击“快速创建 3 角色”。";
      setupListEl.appendChild(empty);
      return;
    }
    pending.forEach((r, idx) => {
      const item = document.createElement("div");
      item.className = "setup-item";
      const left = document.createElement("div");
      left.innerHTML = `<div class="name">${r.name}</div><div class="persona">${(r.persona || "").replaceAll("<", "&lt;").replaceAll(">", "&gt;")}</div>`;
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
    try { setupEl.remove(); } catch {}
  };

  const openSetupIfNeeded = () => {
    if (!setupEl) return;
    const roles = (worldState && worldState.roles) ? worldState.roles : [];
    if (roles.length > 0) return; // already has roles, don't block
    setupEl.style.display = "flex";
    showSetupErr("");
    renderPending();
    try { setupNameEl && setupNameEl.focus(); } catch {}
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
    try { setupNameEl && setupNameEl.focus(); } catch {}
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
    const data = await api("/roles/quickstart", { session_id: sessionId });
    worldState.roles = data.roles;
    worldState.active_role_id = data.active_role_id;
    renderRoles();
    renderPartyStatus();
    renderBranchChoices();
    setStatus();
    logMsg({ kind: "system", content: "已创建 3 个默认角色。", timestamp_ms: Date.now() });
    hideAndRemoveSetup();
  });

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

  // Show role setup modal on first open
  openSetupIfNeeded();

  // First hint
  logMsg({
    kind: "system",
    content: "先创建角色（弹窗里可快速创建），然后用动作按钮开始徒步。",
    timestamp_ms: Date.now(),
  });
}

bootstrap().catch((err) => {
  console.error(err);
  logMsg({ kind: "system", content: `启动失败：${err.message}`, timestamp_ms: Date.now() });
});
