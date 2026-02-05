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
  if (window.__aoTaiMinimap) window.__aoTaiMinimap.setState(worldState);
}

async function apiUpsertRole(role) {
  const data = await api("/roles/upsert", { session_id: sessionId, role });
  worldState.roles = data.roles;
  worldState.active_role_id = data.active_role_id;
  renderRoles();
  renderPartyStatus();
  renderBranchChoices();
  setStatus();
  if (window.__aoTaiMinimap) window.__aoTaiMinimap.setState(worldState);
  // ensure Phaser shows the party immediately after creation/update
  if (window.__aoTaiMapView) window.__aoTaiMapView.setState(worldState);
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
  if (window.__aoTaiMinimap) window.__aoTaiMinimap.setState(worldState);
  // ensure Phaser updates the active-role animation/pose immediately
  if (window.__aoTaiMapView) window.__aoTaiMapView.setState(worldState);
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
  if (window.__aoTaiMinimap) window.__aoTaiMinimap.setState(worldState);
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
  // Default to scale=2 for a chunkier pixel look. For sharper text without making the world too "fine",
  // bump DPR via ?dpr=2 or ?dpr=3. You can still force more detail with ?scale=1.
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
    // Allow a slightly higher cap; helps keep UI readable while world stays chunky at scale=2.
    Math.min(4, Number(qs.get("dpr")) || (window.devicePixelRatio || 1)),
  );

  try {
    console.info(`[ao-tai] scale=${ZOOM} dpr=${GAME_RESOLUTION} view=${VIEW_W}x${VIEW_H} root=${Math.round(rect.width)}x${Math.round(rect.height)}`);
  } catch {}

  // Default to a slightly higher internal text resolution for crisp pixel text.
  // (You can still override via ?uiTextRes= / ?bubbleTextRes= / ?nameTextRes=)
  const UI_TEXT_RES = clamp(
    Math.round(Number(qs.get("uiTextRes")) || Math.max(2, window.devicePixelRatio || 1)),
    1,
    4,
  );
  const NAME_TEXT_RES = clamp(Math.round(Number(qs.get("nameTextRes")) || UI_TEXT_RES), 1, 4);
  const BUBBLE_TEXT_RES = clamp(
    Math.round(Number(qs.get("bubbleTextRes")) || 4),
    1,
    4,
  );

  // UI font size tunables (final on-screen px). Override via URL: ?nameFontPx=11&bubbleFontPx=14
  const NAME_FONT_PX = clamp(Math.round(Number(qs.get("nameFontPx")) || 11), 6, 28);
  const BUBBLE_FONT_PX = clamp(Math.round(Number(qs.get("bubbleFontPx")) || 14), 8, 40);
  // Minimap is now an independent DOM canvas (#minimap-canvas), not Phaser/overlay.
  const USE_MINIMAP_OVERLAY = false;
  const SKIP_PHASER_MINIMAP = true;
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

  // Main scene only
  const MINI_H = 0;
  const MAIN_H = VIEW_H;

  const TILE = 48; // matches your pixel assets scale

  // Sprite pool for roles (pixel-art PNG sequences)
  // - Quickstart(default) roles map by name to fixed keys
  // - Manually created roles auto-match from this pool by stable hash of role_id
  const SPRITE_POOL = ["ao", "taibai", "xiaoshan"];
  const SPRITE_META = {
    ao: { idle: { frames: 6, fps: 8 }, walk: { frames: 8, fps: 10 } },
    taibai: { idle: { frames: 7, fps: 8 }, walk: { frames: 8, fps: 10 } },
    xiaoshan: { idle: { frames: 3, fps: 6 }, walk: { frames: 3, fps: 8 } },
  };

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

      // minimap removed from Phaser (now DOM canvas)

      this._curNodeId = null;
      this._visited = new Set();
      this._weather = null;
      this._tod = null;
      this._ws = null;
      this._walkKey = "";
      this._sceneKey = "";

      this.mainCam = null;

      // roles rendered on big map
      this.roleSprites = new Map(); // role_id -> Phaser.GameObjects.Sprite
      this._spriteBounds = {}; // spriteKey -> { texW, texH, x, y, w, h }
      this._targetContentH = 38; // non-transparent content height ≈ 38px

      // head UI: name labels + speech bubbles
      this.roleNameLabels = new Map(); // role_id -> Phaser.GameObjects.Text
      this.roleBubbles = new Map(); // role_id -> Phaser.GameObjects.Container
      this._bubbleTimers = new Map(); // role_id -> Phaser.Time.TimerEvent

      // text resolution (sharpness) for UI
      this._nameTextRes = NAME_TEXT_RES;
      this._bubbleTextRes = BUBBLE_TEXT_RES;
      this._nameFontPx = NAME_FONT_PX;
      this._bubbleFontPx = BUBBLE_FONT_PX;
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

      // preload role sprite frames (png sequences)
      const loadFrame = (spriteKey, action, idx) => {
        const k = `spr:${spriteKey}:${action}:${String(idx).padStart(3, "0")}`;
        const file = `sprites/${spriteKey}/${action}/frame_${String(idx).padStart(3, "0")}.png`;
        this.load.image(k, file);
      };
      for (const sk of SPRITE_POOL) {
        const meta = SPRITE_META[sk];
        for (const action of ["idle", "walk"]) {
          const n = Number(meta?.[action]?.frames || 0);
          for (let i = 0; i < n; i++) loadFrame(sk, action, i);
        }
      }

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

      // --- main world render texture ---
      this.worldRT = this.add.renderTexture(0, 0, VIEW_W, MAIN_H).setOrigin(0, 0);
      this.world.add(this.worldRT);

      // init animations + nearest filter for pixel art sprites
      this._initRoleAnims();

      // --- overlay for weather/time mood ---
      this.worldOverlay = this.add.rectangle(0, 0, VIEW_W, MAIN_H, 0x000000, 0.0).setOrigin(0, 0);
      this.worldOverlay.setDepth(10);
      this.world.add(this.worldOverlay);

      // --- cameras ---
      this.mainCam = this.cameras.main;
      this.mainCam.setViewport(0, 0, VIEW_W, MAIN_H);
      this.mainCam.setBackgroundColor("rgba(0,0,0,0)");
      this.mainCam.roundPixels = true;

      // Expose API
      window.__aoTaiMapView = {
        setState: (ws) => this.setState(ws),
        // compat
        setNode: (nodeId, visitedIds) => this.setState({ current_node_id: nodeId, visited_node_ids: visitedIds }),
        // show/update speech bubble for a role
        say: (roleId, text) => this._say(roleId, text),
      };

      // initial paint
      this.setState({ current_node_id: mapStartNodeId || "start", visited_node_ids: [mapStartNodeId || "start"], weather: "cloudy", time_of_day: "morning" });
    }

    _pickSpriteKey(role) {
      const explicit = role && (role.sprite_key || role.spriteKey || role.sprite);
      if (explicit && SPRITE_META[String(explicit)]) return String(explicit);

      const name = String(role?.name || "").trim();
      if (name === "阿鳌") return "ao";
      if (name === "太白") return "taibai";
      if (name === "小山") return "xiaoshan";

      const rid = String(role?.role_id || name || "role");
      const h = hash32(rid);
      return SPRITE_POOL[h % SPRITE_POOL.length];
    }

    _frameKey(spriteKey, action, idx) {
      return `spr:${spriteKey}:${action}:${String(idx).padStart(3, "0")}`;
    }

    _initRoleAnims() {
      // set NEAREST filter
      try {
        for (const sk of SPRITE_POOL) {
          const meta = SPRITE_META[sk];
          for (const action of ["idle", "walk"]) {
            const n = Number(meta?.[action]?.frames || 0);
            for (let i = 0; i < n; i++) {
              const k = this._frameKey(sk, action, i);
              try {
                this.textures.get(k).setFilter(Phaser.Textures.FilterMode.NEAREST);
              } catch {}
            }
          }
        }
      } catch {}

      // create animations
      for (const sk of SPRITE_POOL) {
        const meta = SPRITE_META[sk];
        for (const action of ["idle", "walk"]) {
          const animKey = `anim:${sk}:${action}`;
          if (this.anims.exists(animKey)) continue;
          const n = Number(meta?.[action]?.frames || 0);
          const fps = Number(meta?.[action]?.fps || 8);
          const frames = [];
          for (let i = 0; i < n; i++) frames.push({ key: this._frameKey(sk, action, i) });
          this.anims.create({ key: animKey, frames, frameRate: Math.max(1, fps), repeat: -1 });
        }
      }
    }

    _calcOpaqueBoundsForTexture(texKey) {
      try {
        const tex = this.textures.get(texKey);
        const img = tex && tex.getSourceImage ? tex.getSourceImage() : null;
        if (!img || !img.width || !img.height) return null;
        const w = img.width;
        const h = img.height;
        const c = document.createElement("canvas");
        c.width = w;
        c.height = h;
        const ctx = c.getContext("2d", { willReadFrequently: true });
        if (!ctx) return null;
        ctx.clearRect(0, 0, w, h);
        ctx.drawImage(img, 0, 0);
        const data = ctx.getImageData(0, 0, w, h).data;
        let minX = w, minY = h, maxX = -1, maxY = -1;
        for (let y = 0; y < h; y++) {
          for (let x = 0; x < w; x++) {
            const a = data[(y * w + x) * 4 + 3];
            if (a > 0) {
              if (x < minX) minX = x;
              if (y < minY) minY = y;
              if (x > maxX) maxX = x;
              if (y > maxY) maxY = y;
            }
          }
        }
        if (maxX < 0) return null;
        return { texW: w, texH: h, x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
      } catch {
        return null;
      }
    }

    _ensureSpriteBounds(spriteKey) {
      if (this._spriteBounds[spriteKey]) return this._spriteBounds[spriteKey];
      const k = this._frameKey(spriteKey, "idle", 0);
      if (!this.textures.exists(k)) return null;
      const b = this._calcOpaqueBoundsForTexture(k);
      if (!b) return null;
      this._spriteBounds[spriteKey] = b;
      return b;
    }

    _applySpriteScaleOrigin(spr, spriteKey) {
      const b = this._ensureSpriteBounds(spriteKey);
      if (b && b.h > 0) {
        const s = this._targetContentH / b.h;
        spr.setScale(s);
        const ox = (b.x + b.w * 0.5) / b.texW;
        const oy = (b.y + b.h) / b.texH;
        spr.setOrigin(ox, oy);
      } else {
        spr.setOrigin(0.5, 1);
        if (spr.height > 0) spr.setScale(this._targetContentH / spr.height);
      }
    }

    _syncRolesOnMap(ws) {
      const roles = ws?.roles || [];
      const activeId = ws?.active_role_id || null;
      const inTransit = Boolean(ws?.in_transit_to_node_id);

      // Assign sprite keys with minimal repetition:
      // 1) explicit sprite_key from backend
      // 2) default trio by name
      // 3) keep existing rendered assignment (spr.__spriteKey) if valid
      // 4) pick an unused key from the pool
      // 5) fallback to stable hash
      const assignedKeyByRoleId = new Map();
      const usedKeys = new Set();
      const namePresetKey = (r) => {
        const n = String(r?.name || "").trim();
        if (n === "阿鳌") return "ao";
        if (n === "太白") return "taibai";
        if (n === "小山") return "xiaoshan";
        return null;
      };

      for (const r of roles) {
        const rid = String(r.role_id);
        const explicit = r && (r.sprite_key || r.spriteKey || r.sprite);
        const k = explicit && SPRITE_META[String(explicit)] ? String(explicit) : null;
        if (k) {
          assignedKeyByRoleId.set(rid, k);
          usedKeys.add(k);
        }
      }
      for (const r of roles) {
        const rid = String(r.role_id);
        if (assignedKeyByRoleId.has(rid)) continue;
        const k = namePresetKey(r);
        if (k && SPRITE_META[k]) {
          assignedKeyByRoleId.set(rid, k);
          usedKeys.add(k);
        }
      }
      for (const r of roles) {
        const rid = String(r.role_id);
        if (assignedKeyByRoleId.has(rid)) continue;
        const spr = this.roleSprites.get(rid);
        const k = spr && spr.__spriteKey && SPRITE_META[String(spr.__spriteKey)] ? String(spr.__spriteKey) : null;
        if (k) {
          assignedKeyByRoleId.set(rid, k);
          usedKeys.add(k);
        }
      }
      for (const r of roles) {
        const rid = String(r.role_id);
        if (assignedKeyByRoleId.has(rid)) continue;
        const k = SPRITE_POOL.find((x) => !usedKeys.has(x));
        if (k) {
          assignedKeyByRoleId.set(rid, k);
          usedKeys.add(k);
        } else {
          // pool exhausted: fallback to stable hash (will reuse)
          const h = hash32(rid);
          assignedKeyByRoleId.set(rid, SPRITE_POOL[h % SPRITE_POOL.length]);
        }
      }

      const keep = new Set();
      const n = Math.max(1, roles.length);
      const centerX = Math.floor(VIEW_W * 0.5);
      const baseY = Math.floor(MAIN_H * 0.78);
      // not a straight line: spread + slight arc + deterministic jitter per role
      const maxSpread = Math.min(Math.floor(VIEW_W * 0.62), 340);
      const spread = roles.length <= 1 ? 0 : Math.min(maxSpread, 56 * (roles.length - 1));
      const step = roles.length <= 1 ? 0 : spread / (roles.length - 1);
      const startX = Math.floor(centerX - spread / 2);

      for (let i = 0; i < roles.length; i++) {
        const r = roles[i];
        const rid = String(r.role_id);
        keep.add(rid);
        let spr = this.roleSprites.get(rid);
        const spriteKey = assignedKeyByRoleId.get(rid) || this._pickSpriteKey(r);
        const action = inTransit && rid === String(activeId) ? "walk" : "idle";
        const animKey = `anim:${spriteKey}:${action}`;

        if (!spr) {
          spr = this.add.sprite(0, 0, this._frameKey(spriteKey, "idle", 0));
          spr.__spriteKey = spriteKey;
          spr.__action = null;
          this.world.add(spr);
          this.roleSprites.set(rid, spr);
          this._applySpriteScaleOrigin(spr, spriteKey);
        }

        // deterministic jitter from role_id
        const h = hash32(rid);
        const jx = ((h & 0xff) / 255 - 0.5) * 10; // [-5,5]
        const jy = (((h >>> 8) & 0xff) / 255 - 0.5) * 8; // [-4,4]
        const t = roles.length <= 1 ? 0.5 : i / (roles.length - 1);
        const arc = Math.sin(t * Math.PI) * -10; // lift middle a bit
        const x = Math.round(startX + i * step + jx);
        const y = Math.round(baseY + arc + jy);
        spr.setPosition(x, y);
        spr.setDepth(20 + i);
        spr.setAlpha(rid === String(activeId) ? 1.0 : 0.9);

        if (spr.__spriteKey !== spriteKey) {
          spr.setTexture(this._frameKey(spriteKey, "idle", 0));
          spr.__spriteKey = spriteKey;
          this._applySpriteScaleOrigin(spr, spriteKey);
          spr.__action = null;
        }

        if (spr.__action !== action && this.anims.exists(animKey)) {
          spr.play(animKey, true);
          spr.__action = action;
        }

        // --- name label (always visible) ---
        this._upsertNameLabel(rid, r.name, spr, rid === String(activeId));

        // keep bubble anchored (respect per-bubble lift)
        const bub = this.roleBubbles.get(rid);
        if (bub) {
          const lift = Math.round(Number(bub.__lift || 0));
          bub.x = Math.round(spr.x);
          bub.y = Math.round(spr.y - 54 - lift);
        }
      }

      // After positioning all labels, resolve overlaps.
      try { this._resolveNameLabelOverlaps(); } catch {}

      for (const [rid, spr] of this.roleSprites.entries()) {
        if (!keep.has(rid)) {
          try { spr.destroy(); } catch {}
          this.roleSprites.delete(rid);
          const lbl = this.roleNameLabels.get(rid);
          if (lbl) {
            try { lbl.destroy(); } catch {}
            this.roleNameLabels.delete(rid);
          }
          const bub = this.roleBubbles.get(rid);
          if (bub) {
            try { bub.destroy(); } catch {}
            this.roleBubbles.delete(rid);
          }
          const t = this._bubbleTimers.get(rid);
          if (t) {
            try { t.remove(false); } catch {}
            this._bubbleTimers.delete(rid);
          }
        }
      }
    }

    _resolveNameLabelOverlaps() {
      // Simple vertical push-down to avoid name labels overlapping when party members stand close.
      const items = [];
      for (const [rid, lbl] of this.roleNameLabels.entries()) {
        if (!lbl || !lbl.active) continue;
        items.push({ rid, lbl });
      }
      // Sort by y (top to bottom)
      items.sort((a, b) => (a.lbl.y || 0) - (b.lbl.y || 0));

      const pad = 2;
      for (let i = 0; i < items.length; i++) {
        const a = items[i].lbl;
        const ab = a.getBounds();
        for (let j = i + 1; j < items.length; j++) {
          const b = items[j].lbl;
          const bb = b.getBounds();
          const overlapX = Math.min(ab.right, bb.right) - Math.max(ab.left, bb.left);
          const overlapY = Math.min(ab.bottom, bb.bottom) - Math.max(ab.top, bb.top);
          if (overlapX > 0 && overlapY > 0) {
            // push the lower one down
            const dy = overlapY + pad;
            b.y = Math.round(b.y + dy);
            // update bb for subsequent checks
            bb.y += dy;
            bb.top += dy;
            bb.bottom += dy;
          }
        }
      }
    }

    _makePixelText(text, fontPx = 10, color = "#e8f0ff", pixelScale = 4) {
      // Hard-edge pixel text (baked): render large on a canvas, then downsample with NEAREST into a new canvas,
      // upload as a texture, and display as an Image (no fractional scaling at runtime).
      const scale = clamp(Math.round(Number(pixelScale) || 4), 1, 4);
      // Wrap width in *final* pixels. Keep bubbles readable on narrow viewports.
      const wrapW = clamp(Math.round(VIEW_W * 0.55), 140, 260);
      // Prefer CJK-friendly fonts first; fall back to pixel latin font where available.
      const fontFamily =
        '"PingFang SC","Hiragino Sans GB","Microsoft YaHei","Press Start 2P",ui-monospace,Menlo,Monaco,Consolas,monospace';

      const srcFontPx = Math.round(fontPx * scale);
      const srcWrapW = Math.round(wrapW * scale);

      // Simple wrap (works well for CJK and short phrases)
      const measureCtx = document.createElement("canvas").getContext("2d");
      measureCtx.font = `${srcFontPx}px ${fontFamily}`;
      const raw = String(text ?? "");
      const tokens = raw.split("");
      const lines = [];
      let line = "";
      for (const ch of tokens) {
        if (ch === "\n") {
          lines.push(line);
          line = "";
          continue;
        }
        const test = line + ch;
        const w = measureCtx.measureText(test).width;
        if (w > srcWrapW && line.length > 0) {
          lines.push(line);
          line = ch;
        } else {
          line = test;
        }
      }
      if (line) lines.push(line);

      // More line height so bold stroke text doesn't collide between lines.
      const lineH = Math.round(srcFontPx * 1.45);
      const padX = Math.round(5 * scale);
      const padY = Math.round(4 * scale);
      let maxLineW = 0;
      for (const l of lines) maxLineW = Math.max(maxLineW, Math.ceil(measureCtx.measureText(l).width));
      const srcW = Math.max(1, maxLineW + padX * 2);
      const srcH = Math.max(1, lines.length * lineH + padY * 2);

      const src = document.createElement("canvas");
      src.width = srcW;
      src.height = srcH;
      const sctx = src.getContext("2d", { willReadFrequently: true });
      sctx.imageSmoothingEnabled = false;
      sctx.clearRect(0, 0, srcW, srcH);
      sctx.font = `${srcFontPx}px ${fontFamily}`;
      sctx.textBaseline = "top";
      sctx.fillStyle = color;

      // Thick dark stroke improves readability for small CJK glyphs after downsampling.
      const strokeW = Math.max(1, Math.round(2.0 * scale));
      sctx.lineJoin = "round";
      sctx.miterLimit = 2;
      sctx.lineWidth = strokeW;
      sctx.strokeStyle = "#061022";

      // Draw text at integer coords
      let y = padY;
      for (const l of lines) {
        sctx.strokeText(l, padX, y);
        sctx.fillText(l, padX, y);
        y += lineH;
      }

      // Harden edges: binarize alpha so glyphs don't look "foggy".
      try {
        const imgData = sctx.getImageData(0, 0, srcW, srcH);
        const d = imgData.data;
        const thresh = 96;
        for (let i = 0; i < d.length; i += 4) {
          d[i + 3] = d[i + 3] < thresh ? 0 : 255;
        }
        sctx.putImageData(imgData, 0, 0);
      } catch {}

      // Downsample baked output
      const out = document.createElement("canvas");
      const outW = Math.max(1, Math.round(srcW / scale));
      const outH = Math.max(1, Math.round(srcH / scale));
      out.width = outW;
      out.height = outH;
      const octx = out.getContext("2d", { willReadFrequently: true });
      octx.imageSmoothingEnabled = false;
      octx.clearRect(0, 0, outW, outH);
      octx.drawImage(src, 0, 0, outW, outH);

      const key = `pixtext:${hash32(`${raw}|${fontPx}|${color}|${scale}|${Date.now()}|${Math.random()}`)}`;
      try {
        if (this.textures.exists(key)) this.textures.remove(key);
      } catch {}
      this.textures.addCanvas(key, out);
      try {
        this.textures.get(key).setFilter(Phaser.Textures.FilterMode.NEAREST);
      } catch {}

      const img = this.add.image(0, 0, key);
      img.setOrigin(0.5, 0.5);
      img.setDepth(55);
      // Avoid subpixel blur
      img.x = Math.round(img.x);
      img.y = Math.round(img.y);
      return img;
    }

    _upsertNameLabel(roleId, name, spr, isActive) {
      const rid = String(roleId);
      const labelText = String(name || "").trim() || "角色";
      const color = isActive ? "#e8f0ff" : "#cfe8ff";
      const needsRecreate = (obj, nextText, nextColor) => {
        if (!obj) return true;
        if (obj.__pixText !== nextText) return true;
        if (obj.__pixColor !== nextColor) return true;
        return false;
      };
      let t = this.roleNameLabels.get(rid);
      if (needsRecreate(t, labelText, color)) {
        if (t) {
          try { t.destroy(); } catch {}
          this.roleNameLabels.delete(rid);
        }
        // Names: baked hard-edge pixel text
        t = this._makePixelText(labelText, this._nameFontPx, color, 4);
        t.__pixText = labelText;
        t.__pixColor = color;
        t.setDepth(55);
        this.world.add(t);
        this.roleNameLabels.set(rid, t);
      }
      // Place under feet
      t.setOrigin(0.5, 0);
      t.x = spr.x;
      t.y = spr.y + 4;
      t.setAlpha(isActive ? 1.0 : 0.9);
    }

    _say(roleId, text) {
      const rid = String(roleId || "");
      if (!rid) return;
      const spr = this.roleSprites.get(rid);
      if (!spr) return;

      const msg = String(text || "").trim();
      if (!msg) return;

      // replace existing bubble
      const prev = this.roleBubbles.get(rid);
      if (prev) {
        try { prev.destroy(); } catch {}
        this.roleBubbles.delete(rid);
      }

      const g = this.add.graphics();
      // Speech bubble text: always use the highest supersample for crisp hard edges.
      const t = this._makePixelText(msg, this._bubbleFontPx, "#e8f0ff", 4);
      t.setOrigin(0.5, 1);

      const maxW = 220;
      const w = Math.min(maxW, Math.ceil(t.displayWidth));
      const h = Math.ceil(t.displayHeight);
      const padX = 10;
      const padY = 8;

      // transparent bubble feel
      g.fillStyle(0x0b1630, 0.35);
      g.fillRect(-w / 2 - padX, -h - padY * 1.2, w + padX * 2, h + padY * 1.6);
      g.lineStyle(2, 0x7cf2ff, 0.35);
      g.strokeRect(-w / 2 - padX, -h - padY * 1.2, w + padX * 2, h + padY * 1.6);

      // small tail
      g.fillStyle(0x0b1630, 0.35);
      g.beginPath();
      g.moveTo(0, 0);
      g.lineTo(-6, -10);
      g.lineTo(6, -10);
      g.closePath();
      g.fillPath();

      const lift = Math.round(Math.min(70, Math.max(0, h * 0.6)));
      const c = this.add.container(spr.x, spr.y - 54 - lift);
      c.__lift = lift;
      c.setPosition(Math.round(c.x), Math.round(c.y));
      c.setDepth(60);
      c.add(g);
      t.setPosition(0, -10);
      c.add(t);
      this.world.add(c);
      this.roleBubbles.set(rid, c);

      // reset timer: fade out then destroy
      const prevTimer = this._bubbleTimers.get(rid);
      if (prevTimer) {
        try { prevTimer.remove(false); } catch {}
      }
      const timer = this.time.delayedCall(3600, () => {
        const b = this.roleBubbles.get(rid);
        if (!b) return;
        this.tweens.add({
          targets: b,
          alpha: 0,
          duration: 220,
          onComplete: () => {
            try { b.destroy(); } catch {}
            this.roleBubbles.delete(rid);
          },
        });
      });
      this._bubbleTimers.set(rid, timer);
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

      // render roles on big map
      try {
        this._syncRolesOnMap(ws);
      } catch {}

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
        // tiny bob on active role (if present)
        const activeId = ws?.active_role_id ? String(ws.active_role_id) : null;
        const activeSpr = activeId ? this.roleSprites.get(activeId) : null;
        if (activeSpr) {
          this.tweens.add({
            targets: activeSpr,
            y: activeSpr.y - 6,
            duration: 220,
            yoyo: true,
            ease: "Sine.easeInOut",
          });
        }
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

  new Phaser.Game(config);

}

function initMinimapCanvas() {
  const root = document.getElementById("minimap-root");
  const canvas = document.getElementById("minimap-canvas");
  const ctx = canvas && canvas.getContext ? canvas.getContext("2d") : null;
  if (!root || !canvas || !ctx) return null;

  const fontStack = '"PingFang SC","Hiragino Sans GB","Microsoft YaHei",system-ui,sans-serif';
  const state = { ws: null, dpr: 1 };

  const nodeByIdLocal = (id) => (mapNodes || []).find((n) => String(n.node_id) === String(id));

  const resize = () => {
    const r = root.getBoundingClientRect();
    const dpr = Math.max(1, Math.min(4, window.devicePixelRatio || 1));
    state.dpr = dpr;
    canvas.width = Math.max(1, Math.round(r.width * dpr));
    canvas.height = Math.max(1, Math.round(r.height * dpr));
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.imageSmoothingEnabled = false;
  };

  const draw = () => {
    const ws = state.ws;
    if (!ws) return;
    const r = root.getBoundingClientRect();
    const W = Math.max(1, Math.round(r.width));
    const H = Math.max(1, Math.round(r.height));

    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = "rgba(10,16,28,0.92)";
    ctx.fillRect(0, 0, W, H);
    ctx.strokeStyle = "rgba(124,242,255,0.38)";
    ctx.lineWidth = 2;
    ctx.strokeRect(1, 1, W - 2, H - 2);

    const pad = 14;
    const mapW = Math.max(10, W - pad * 2);
    const mapH = Math.max(10, H - pad * 2);
    const toMini = (n) => {
      const x = pad + (clamp(n.x, 0, 100) / 100) * mapW;
      const y = pad + (clamp(n.y, 0, 100) / 100) * mapH;
      return { x, y };
    };

    const nodeId = ws.current_node_id || mapStartNodeId || "start";
    const visitedSet = new Set((ws.visited_node_ids || [nodeId]).map(String));

    const curveSign = (s) => {
      let h = 0;
      for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
      return (h & 1) ? 1 : -1;
    };

    // edges
    for (const e of mapEdges || []) {
      const a = nodeByIdLocal(e.from_node_id);
      const b = nodeByIdLocal(e.to_node_id);
      if (!a || !b) continue;
      const pa = toMini(a);
      const pb = toMini(b);

      const visited = visitedSet.has(String(e.to_node_id));
      const isExit = e.kind === "exit";
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

      ctx.strokeStyle = `rgba(11,22,48,${Math.min(0.65, alpha)})`;
      ctx.lineWidth = width + 3;
      ctx.beginPath();
      ctx.moveTo(pa.x, pa.y);
      ctx.quadraticCurveTo(cx, cy, pb.x, pb.y);
      ctx.stroke();

      ctx.strokeStyle = isExit ? `rgba(255,124,124,${alpha})` : `rgba(124,242,255,${alpha})`;
      ctx.lineWidth = width;
      ctx.beginPath();
      ctx.moveTo(pa.x, pa.y);
      ctx.quadraticCurveTo(cx, cy, pb.x, pb.y);
      ctx.stroke();
    }

    // nodes + labels
    const fontPx = 12;
    ctx.textBaseline = "middle";
    ctx.font = `${fontPx}px ${fontStack}`;

    for (const n of mapNodes || []) {
      const p = toMini(n);
      const isCur = String(n.node_id) === String(nodeId);
      const isVisited = visitedSet.has(String(n.node_id)) || isCur;
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

      ctx.fillStyle = "rgba(11,22,48,0.85)";
      ctx.beginPath();
      ctx.arc(p.x, p.y, isCur ? 7 : 6, 0, Math.PI * 2);
      ctx.fill();

      ctx.fillStyle = isVisited ? kColor : "rgba(124,242,255,0.55)";
      ctx.beginPath();
      ctx.arc(p.x, p.y, isCur ? 5 : 4, 0, Math.PI * 2);
      ctx.fill();

      const isKey = isCur || ["start", "camp", "junction", "lake", "peak", "exit", "end"].includes(kind);
      const label = (n.name || n.node_id || "").trim();
      if (isKey && label) {
        const x = Math.round(p.x + 8);
        const y = Math.round(p.y - 12);
        const textW = ctx.measureText(label).width;

        ctx.fillStyle = "rgba(6,16,34,0.92)";
        ctx.fillRect(x - 2, y - fontPx / 2 - 4, textW + 10, fontPx + 8);

        ctx.lineWidth = 2;
        ctx.strokeStyle = "rgba(6,16,34,1)";
        ctx.fillStyle = isVisited ? "#d6faff" : "#7aa0b3";
        ctx.strokeText(label, x + 3, y);
        ctx.fillText(label, x + 3, y);
      }
    }

    // marker (transit aware)
    const toId = ws.in_transit_to_node_id;
    const fromId = ws.in_transit_from_node_id;
    const prog = Number(ws.in_transit_progress_km || 0);
    const tot = Number(ws.in_transit_total_km || 0);

    let mp = null;
    if (fromId && toId && tot > 0) {
      const a = nodeByIdLocal(fromId);
      const b = nodeByIdLocal(toId);
      if (a && b) {
        const pa = toMini(a);
        const pb = toMini(b);
        const t = clamp(prog / tot, 0, 1);
        mp = { x: pa.x + (pb.x - pa.x) * t, y: pa.y + (pb.y - pa.y) * t };
      }
    }
    if (!mp) {
      const cur = nodeByIdLocal(nodeId);
      if (cur) mp = toMini(cur);
    }
    if (mp) {
      ctx.fillStyle = "#ffd27c";
      ctx.fillRect(Math.round(mp.x - 4), Math.round(mp.y - 12), 8, 12);
      ctx.strokeStyle = "rgba(0,0,0,0.35)";
      ctx.lineWidth = 1;
      ctx.strokeRect(Math.round(mp.x - 4) + 0.5, Math.round(mp.y - 12) + 0.5, 8, 12);
    }
  };

  const api = {
    setState(ws) {
      state.ws = ws;
      resize();
      draw();
    },
  };

  try {
    new ResizeObserver(() => {
      resize();
      draw();
    }).observe(root);
  } catch {
    window.addEventListener("resize", () => {
      resize();
      draw();
    });
  }

  resize();
  return api;
}

async function bootstrap() {
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
