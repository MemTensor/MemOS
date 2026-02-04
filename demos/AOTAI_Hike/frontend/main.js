const API_BASE = "/api/demo/ao-tai";

const $ = (sel) => document.querySelector(sel);
const chatEl = $("#chat");
const rolesEl = $("#roles");
const statusEl = $("#status");
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
  if (window.__aoTaiMapView) window.__aoTaiMapView.setIndex(worldState.route_node_index || 0);
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
  if (window.__aoTaiMapView) window.__aoTaiMapView.setIndex(worldState.route_node_index);
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
  const VIEW_W = Math.max(480, Math.floor(root?.clientWidth || 640));
  const VIEW_H = Math.max(200, Math.floor(root?.clientHeight || 260));

  // ---- Tunable parameters ----
  const TILE = 48; // base ground tile (grass/brick/fence)
  const TILE_S = 16; // small overlay (leaves/pumpkin)

  const CHUNK_W_T = 10; // 10 * 48 = 480px
  const CHUNK_H_T = 5;  // 5 * 48 = 240px
  const CHUNK_W = CHUNK_W_T * TILE;
  const CHUNK_H = CHUNK_H_T * TILE;

  const KEEP_CHUNKS = 6;
  const AHEAD_CHUNKS = 3;

  // How far one backend index step advances, in tiles.
  const STEP_TILES = 2; // 2*48 = 96px
  const STEP_PX = STEP_TILES * TILE;

  // Deterministic-ish RNG (seed per session)
  const mulberry32 = (seed) => {
    let t = seed >>> 0;
    return () => {
      t += 0x6d2b79f5;
      let r = Math.imul(t ^ (t >>> 15), 1 | t);
      r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
      return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
    };
  };

  class TrailScene extends Phaser.Scene {
    constructor() {
      super({ key: "TrailScene" });
      this._chunks = [];
      this._pool = [];
      this._walker = null;
      this._pathY = 0;
      this._rng = null;
      this._index = 0;
      this._isAdvancing = false;
      this._queuedSteps = 0;
      this._tex = null;
      this.world = null;
    }

    preload() {
      // Uses your local pixel assets under `./assets/`
      this.load.image("grass", "./assets/Dark grass 1.png");
      this.load.image("brick", "./assets/Dark Brick 1.png");
      this.load.image("bush", "./assets/Dark Bush 1.png");
      this.load.image("tree", "./assets/Dark Tree 1.png");
      this.load.image("fence", "./assets/Dark fence 1.png");
      this.load.image("leaves", "./assets/Fallen Leaves 1.png");
      this.load.image("pumpkin", "./assets/Pumpkin 1.png");
    }

    create() {
      const seedStr = (worldState && worldState.session_id) || "seed";
      const seed = Array.from(seedStr).reduce((acc, c) => (acc * 131 + c.charCodeAt(0)) >>> 0, 7);
      this._rng = mulberry32(seed);

      // Base path line is roughly centered vertically inside the chunk
      this._pathY = Math.floor(CHUNK_H_T / 2);

      this.world = this.add.container(0, 0);

      const sizeOf = (key) => {
        const img = this.textures.get(key)?.getSourceImage?.();
        return img ? { w: img.width, h: img.height } : { w: TILE, h: TILE };
      };
      this._tex = {
        grass: sizeOf("grass"),
        brick: sizeOf("brick"),
        bush: sizeOf("bush"),
        tree: sizeOf("tree"),
        fence: sizeOf("fence"),
        leaves: sizeOf("leaves"),
        pumpkin: sizeOf("pumpkin"),
      };

      // Initial chunks
      for (let i = 0; i < KEEP_CHUNKS; i++) {
        const cx = i * CHUNK_W;
        const chunk = this._spawnChunk(cx);
        this._chunks.push(chunk);
      }

      // Walker marker (replace with your sprite later)
      const g = this.add.graphics();
      g.fillStyle(0xffd27c, 1);
      g.fillRect(0, 0, 8, 16);
      const texKey = "walker_marker";
      if (!this.textures.exists(texKey)) {
        g.generateTexture(texKey, 8, 16);
      }
      g.destroy();

      this._walker = this.add.image(0, 0, texKey).setOrigin(0.5, 1);
      this._walker.setPosition(TILE * 3, TILE * (this._pathY + 1));
      this.world.add(this._walker);

      // Camera
      this.cameras.main.setBounds(0, 0, 999999, VIEW_H);
      this.cameras.main.startFollow(this._walker, true, 0.08, 0.08);
      this.cameras.main.setDeadzone(180, 80);
      this.cameras.main.setBackgroundColor("rgba(0,0,0,0)");

      // Expose API to page
      window.__aoTaiMapView = {
        setIndex: (i) => this.setIndex(i),
      };

      this.setIndex(0);
    }

    setIndex(i) {
      const next = Math.max(0, Math.floor(Number(i) || 0));
      const delta = next - this._index;
      this._index = next;
      if (delta > 0) this.advanceSteps(delta);
      if (delta < 0) {
        // Simple reset behavior (e.g. new session)
        if (this._walker) this._walker.x = TILE * 3;
      }
    }

    advanceSteps(steps) {
      if (steps <= 0) return;
      if (this._isAdvancing) {
        this._queuedSteps += steps;
        return;
      }
      this._isAdvancing = true;

      const targetX = this._walker.x + steps * STEP_PX;
      this.tweens.add({
        targets: this._walker,
        x: targetX,
        duration: 420 + steps * 120,
        ease: "Sine.easeInOut",
        onUpdate: () => this._ensureChunks(),
        onComplete: () => {
          this._ensureChunks(true);
          this._isAdvancing = false;
          if (this._queuedSteps > 0) {
            const q = this._queuedSteps;
            this._queuedSteps = 0;
            this.advanceSteps(q);
          }
        },
      });
    }

    _ensureChunks(force = false) {
      const cam = this.cameras.main;
      const camLeft = cam.scrollX;
      const camRight = cam.scrollX + VIEW_W;

      while (
        this._chunks.length < KEEP_CHUNKS ||
        this._lastChunkRight() < camRight + AHEAD_CHUNKS * CHUNK_W
      ) {
        const nextX = this._lastChunkRight();
        const c = this._spawnChunk(nextX);
        this._chunks.push(c);
      }

      while (this._chunks.length > 0) {
        const first = this._chunks[0];
        if (!force && first.x + CHUNK_W > camLeft - CHUNK_W) break;
        if (first.x + CHUNK_W <= camLeft - CHUNK_W || force) {
          const old = this._chunks.shift();
          this._recycleChunk(old);
        } else {
          break;
        }
      }
    }

    _lastChunkRight() {
      if (this._chunks.length === 0) return 0;
      const last = this._chunks[this._chunks.length - 1];
      return last.x + CHUNK_W;
    }

    _spawnChunk(x) {
      const chunk = this._pool.pop() || this._createChunkObject();
      chunk.x = x;
      chunk.rt.setPosition(x, Math.floor((VIEW_H - CHUNK_H) / 2));

      // Slight drift for organic feel
      const drift = this._rng() < 0.4 ? (this._rng() < 0.5 ? -1 : 1) : 0;
      this._pathY = Phaser.Math.Clamp(this._pathY + drift, 2, CHUNK_H_T - 3);

      this._renderChunkToTexture(chunk.rt, this._pathY);

      if (!chunk.added) {
        this.world.add(chunk.rt);
        chunk.added = true;
      }

      return chunk;
    }

    _createChunkObject() {
      const rt = this.add.renderTexture(0, 0, CHUNK_W, CHUNK_H).setOrigin(0, 0);
      rt.setDepth(0);
      return { rt, x: 0, added: false };
    }

    _recycleChunk(chunk) {
      this._pool.push(chunk);
    }

    _renderChunkToTexture(rt, pathY) {
      rt.clear();

      // 1) Ground
      for (let y = 0; y < CHUNK_H_T; y++) {
        for (let x = 0; x < CHUNK_W_T; x++) {
          rt.draw("grass", x * TILE, y * TILE);
        }
      }

      // 2) Sprinkle leaves (lightweight)
      const leavesN = Phaser.Math.Between(18, 42);
      for (let i = 0; i < leavesN; i++) {
        const px = Phaser.Math.Between(0, CHUNK_W - TILE_S);
        const py = Phaser.Math.Between(0, CHUNK_H - TILE_S);
        rt.draw("leaves", px, py);
      }

      // 3) Path
      const pathW = this._rng() < 0.55 ? 2 : 3;
      for (let x = 0; x < CHUNK_W_T; x++) {
        const wobble = this._rng() < 0.25 ? (this._rng() < 0.5 ? -1 : 1) : 0;
        const cy = Phaser.Math.Clamp(pathY + wobble, 2, CHUNK_H_T - 3);
        for (let dy = -Math.floor(pathW / 2); dy <= Math.floor(pathW / 2); dy++) {
          const yy = cy + dy;
          if (yy >= 0 && yy < CHUNK_H_T) rt.draw("brick", x * TILE, yy * TILE);
        }
      }

      // Helper: bottom-anchored placement
      const placeBottomAnchored = (key, px, groundTileY) => {
        const { w, h } = this._tex[key] || { w: TILE, h: TILE };
        const groundY = groundTileY * TILE;
        const topY = Math.floor(groundY - (h - TILE));
        rt.draw(key, px, topY);
      };

      // 4) Trees / bushes / fence
      const treeCount = this._rng() < 0.6 ? 1 : 2;
      for (let i = 0; i < treeCount; i++) {
        const sideLeft = this._rng() < 0.5;
        const xTile = sideLeft ? Phaser.Math.Between(0, 2) : Phaser.Math.Between(CHUNK_W_T - 3, CHUNK_W_T - 1);
        placeBottomAnchored("tree", xTile * TILE, Phaser.Math.Clamp(pathY - 2, 1, CHUNK_H_T - 1));
      }

      const bushCount = Phaser.Math.Between(1, 3);
      for (let i = 0; i < bushCount; i++) {
        const sideLeft = this._rng() < 0.5;
        const xTile = sideLeft ? Phaser.Math.Between(0, 3) : Phaser.Math.Between(CHUNK_W_T - 4, CHUNK_W_T - 1);
        placeBottomAnchored("bush", xTile * TILE, Phaser.Math.Clamp(pathY + 3, 2, CHUNK_H_T - 1));
      }

      if (this._rng() < 0.35) {
        const sideLeft = this._rng() < 0.5;
        const xTile = sideLeft ? 1 : CHUNK_W_T - 2;
        placeBottomAnchored("fence", xTile * TILE, Phaser.Math.Clamp(pathY + 1, 2, CHUNK_H_T - 1));
      }

      // Rare pumpkin
      if (this._rng() < 0.12) {
        const xTile = Phaser.Math.Between(2, CHUNK_W_T - 3);
        placeBottomAnchored("pumpkin", xTile * TILE, Phaser.Math.Clamp(pathY + 2, 2, CHUNK_H_T - 1));
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
    scene: [TrailScene],
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
