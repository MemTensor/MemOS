import { t as i18nT } from "./i18n.js";
import { clamp } from "./utils.js";
import { mapEdges, mapNodes, mapStartNodeId, nodeById, worldState } from "./state.js";

// Phaser trail view (chunk streaming)
// - Renders an endless-ish forest trail by streaming procedurally generated chunks.
// - Uses pixelArt rendering and fixed tile size for a crisp pixel look.
// - For now, chunks are rendered via RenderTexture + simple pixel primitives.
//   Later you can swap `renderChunkToTexture()` to draw real tiles from your tileset.
export function initPhaser() {
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
    console.info(
      `[ao-tai] scale=${ZOOM} dpr=${GAME_RESOLUTION} view=${VIEW_W}x${VIEW_H} root=${Math.round(
        rect.width,
      )}x${Math.round(rect.height)}`,
    );
  } catch {}

  // Default to a slightly higher internal text resolution for crisp pixel text.
  // (You can still override via ?uiTextRes= / ?bubbleTextRes= / ?nameTextRes=)
  const UI_TEXT_RES = clamp(
    Math.round(Number(qs.get("uiTextRes")) || Math.max(2, window.devicePixelRatio || 1)),
    1,
    4,
  );
  const NAME_TEXT_RES = clamp(Math.round(Number(qs.get("nameTextRes")) || UI_TEXT_RES), 1, 4);
  const BUBBLE_TEXT_RES = clamp(Math.round(Number(qs.get("bubbleTextRes")) || 4), 1, 4);

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

  // Scene layering config (two-copy loop)
  // - Add/remove layers by editing this list (order = render order, bottom -> top).
  // - For each sceneId, assets should exist at:
  //   `./assets/scenes/scene_${sceneId}/scene_0_${layer}.png`
  const SCENE_IDS = ["base"];
  const SCENE_LAYERS = ["base", "props"];
  const sceneKey = (sceneId, layer) => `scene:${sceneId}:${layer}`;
  const sceneFile = (sceneId, layer) => `scenes/scene_${sceneId}/scene_0_${layer}.png`;

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

      // New: N-layer scrolling scene (two-copy loop)
      this.worldLayers = null;
      this.layerImgs = null; // { [layerName]: [imgA, imgB] }
      this._sceneLayers = SCENE_LAYERS.slice();
      this._scrollY = 0;
      this._scrollSpeed = 18; // px/s (slower)
      this._loopH = 0;
      this._sceneId = "base";

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

      // outcome banner (success / fail)
      this._outcomeBanner = null;
      this._outcomeState = null; // "success" | "fail" | null

      // weather effects
      this._rainGfx = null;
      this._rainDrops = [];
      this._rainActive = false;
      this._snowGfx = null;
      this._snowFlakes = [];
      this._snowActive = false;
      this._windGfx = null;
      this._windStreaks = [];
      this._windActive = false;
      this._fogGfx = null;
      this._fogBlobs = [];
      this._fogActive = false;
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

      // Scene templates
      for (const sid of SCENE_IDS) {
        for (const layer of SCENE_LAYERS) {
          loadImg(sceneKey(sid, layer), sceneFile(sid, layer));
        }
      }

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
          this._assetErrors.push(
            file && (file.key || file.src || file.url)
              ? file.key || file.src || file.url
              : "unknown",
          );
        } catch {
          this._assetErrors.push("unknown");
        }
      });
    }

    create() {
      // --- containers ---
      this.world = this.add.container(0, 0);

      // --- main world layers (three layers, two-copy loop) ---
      this.worldLayers = this.add.container(0, 0);
      this.world.add(this.worldLayers);

      this.layerImgs = {};
      for (const layer of this._sceneLayers) {
        const key = sceneKey(this._sceneId, layer);
        const a = this.add.image(0, 0, key).setOrigin(0, 0);
        const b = this.add.image(0, 0, key).setOrigin(0, 0);
        this.layerImgs[layer] = [a, b];
        this.worldLayers.add(a);
        this.worldLayers.add(b);
      }
      this._swapScene(this._sceneId);

      // init animations + nearest filter for pixel art sprites
      this._initRoleAnims();

      // --- overlay for weather/time mood ---
      this.worldOverlay = this.add
        .rectangle(0, 0, VIEW_W, MAIN_H, 0x000000, 0.0)
        .setOrigin(0, 0);
      this.worldOverlay.setDepth(10);
      this.world.add(this.worldOverlay);

      // --- rain layer (code-generated) ---
      this._rainGfx = this.add.graphics();
      this._rainGfx.setDepth(20);
      this.world.add(this._rainGfx);
      this._initRainDrops();

      // --- snow layer ---
      this._snowGfx = this.add.graphics();
      this._snowGfx.setDepth(21);
      this.world.add(this._snowGfx);
      this._initSnowFlakes();

      // --- wind layer ---
      this._windGfx = this.add.graphics();
      this._windGfx.setDepth(22);
      this.world.add(this._windGfx);
      this._initWindStreaks();

      // --- fog layer ---
      this._fogGfx = this.add.graphics();
      this._fogGfx.setDepth(23);
      this.world.add(this._fogGfx);
      this._initFogBlobs();

      // --- cameras ---
      this.mainCam = this.cameras.main;
      this.mainCam.setViewport(0, 0, VIEW_W, MAIN_H);
      this.mainCam.setBackgroundColor("rgba(0,0,0,0)");
      this.mainCam.roundPixels = true;

      // Expose API
      window.__aoTaiMapView = {
        setState: (ws) => this.setState(ws),
        // compat
        setNode: (nodeId, visitedIds) =>
          this.setState({ current_node_id: nodeId, visited_node_ids: visitedIds }),
        // show/update speech bubble for a role
        say: (roleId, text) => this._say(roleId, text),
      };

      // initial paint
      this.setState({
        current_node_id: mapStartNodeId || "start",
        visited_node_ids: [mapStartNodeId || "start"],
        weather: "cloudy",
        time_of_day: "morning",
      });
    }

    _swapScene(id) {
      this._sceneId = String(id || "base");
      if (!this.layerImgs) return;

      // Set NEAREST for the scene textures.
      try {
        for (const layer of this._sceneLayers) {
          const key = sceneKey(this._sceneId, layer);
          if (this.textures.exists(key)) {
            this.textures.get(key).setFilter(Phaser.Textures.FilterMode.NEAREST);
          }
        }
      } catch {}

      for (const layer of this._sceneLayers) {
        const key = sceneKey(this._sceneId, layer);
        const [a, b] = this.layerImgs[layer];
        a.setTexture(key);
        b.setTexture(key);
      }
      this._layoutLoopImages();
    }

    _layoutLoopImages() {
      if (!this.layerImgs) return;
      const refLayer = (this._sceneLayers && this._sceneLayers[0]) || "base";
      const tex = this.layerImgs[refLayer]?.[0]?.texture || this.layerImgs.base?.[0]?.texture;
      const img = tex && tex.getSourceImage ? tex.getSourceImage() : null;
      const nativeW = img && img.width ? img.width : VIEW_W;
      const nativeH = img && img.height ? img.height : MAIN_H;

      // Keep aspect ratio: fit by width, but ensure height covers the viewport.
      let scale = VIEW_W / Math.max(1, nativeW);
      if (nativeH * scale < MAIN_H) scale = MAIN_H / Math.max(1, nativeH);
      const dispW = Math.round(nativeW * scale);
      const dispH = Math.round(nativeH * scale);
      const x0 = Math.round((VIEW_W - dispW) / 2);

      // Force width alignment (best: art exports at VIEW_W px so no scaling occurs)
      for (const k of this._sceneLayers) {
        const [a, b] = this.layerImgs[k];
        a.setDisplaySize(dispW, dispH);
        b.setDisplaySize(dispW, dispH);
        a.x = x0;
        a.y = 0;
        b.x = x0;
        b.y = -dispH;
      }

      this._loopH = Math.max(1, Math.round(dispH));
      this._scrollY = 0;
    }

    update(time, delta) {
      const ws = this._ws || {};
      this._updateRain(delta);
      this._updateSnow(delta);
      this._updateWind(delta);
      this._updateFog(delta);
      const walking = Boolean(ws && ws.in_transit_to_node_id);
      const phase = ws && ws.phase ? String(ws.phase) : "free";
      const modalBlocking = Boolean(window.__aoTaiNightVoteOpen);
      const speed = walking && phase === "free" && !modalBlocking ? this._scrollSpeed : 0;
      if (speed <= 0 || !this.layerImgs || !this._loopH) return;

      const dy = (Number(delta || 0) / 1000) * speed;
      this._scrollY = (this._scrollY + dy) % this._loopH;

      // Scroll DOWN: background moves down (player feels moving forward/up).
      const ay = Math.round(this._scrollY);
      for (const k of this._sceneLayers) {
        const [a, b] = this.layerImgs[k];
        a.y = ay;
        b.y = ay - this._loopH;
      }
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
          for (let i = 0; i < n; i++)
            frames.push({ key: this._frameKey(sk, action, i) });
          this.anims.create({
            key: animKey,
            frames,
            frameRate: Math.max(1, fps),
            repeat: -1,
          });
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
        let minX = w,
          minY = h,
          maxX = -1,
          maxY = -1;
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
        const k =
          spr && spr.__spriteKey && SPRITE_META[String(spr.__spriteKey)]
            ? String(spr.__spriteKey)
            : null;
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
        const leaderId = ws?.leader_role_id ? String(ws.leader_role_id) : null;
        this._upsertNameLabel(rid, r.name, spr, rid === String(activeId), rid === leaderId);

        // keep bubble anchored (respect per-bubble lift)
        const bub = this.roleBubbles.get(rid);
        if (bub) {
          const lift = Math.round(Number(bub.__lift || 0));
          bub.x = Math.round(spr.x);
          bub.y = Math.round(spr.y - 54 - lift);
        }
      }

      // After positioning all labels, resolve overlaps.
      try {
        this._resolveNameLabelOverlaps();
      } catch {}

      for (const [rid, spr] of this.roleSprites.entries()) {
        if (!keep.has(rid)) {
          try {
            spr.destroy();
          } catch {}
          this.roleSprites.delete(rid);
          const lbl = this.roleNameLabels.get(rid);
          if (lbl) {
            try {
              lbl.destroy();
            } catch {}
            this.roleNameLabels.delete(rid);
          }
          const bub = this.roleBubbles.get(rid);
          if (bub) {
            try {
              bub.destroy();
            } catch {}
            this.roleBubbles.delete(rid);
          }
          const t = this._bubbleTimers.get(rid);
          if (t) {
            try {
              t.remove(false);
            } catch {}
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

    _resolveOutcome(ws) {
      const roles = ws?.roles || [];
      const exhausted = roles.length > 0 && roles.every((r) => Number(r?.attrs?.stamina || 0) <= 0);
      if (exhausted) return "fail";
      const terminalIds = new Set(["end_exit", "bailout_2800", "bailout_ridge"]);
      const curId = String(ws?.current_node_id || "");
      if (terminalIds.has(curId)) return "success";
      const node = nodeById(curId);
      const kind = String(node?.kind || "").toLowerCase();
      if (kind === "end" || kind === "exit") return "success";
      return null;
    }

    _updateOutcomeBanner(ws) {
      const outcome = this._resolveOutcome(ws);
      if (outcome === this._outcomeState) return;
      this._outcomeState = outcome;
      if (this._outcomeBanner) {
        try {
          this._outcomeBanner.destroy();
        } catch {}
        this._outcomeBanner = null;
      }
      if (!outcome) return;
      const label = outcome === "success" ? "success" : "fail";
      const color = outcome === "success" ? "#a1ffb9" : "#ff7c7c";
      const textImg = this._makePixelText(label, 18, color, 4);
      textImg.setOrigin(0.5, 0.5);
      const padX = 12;
      const padY = 8;
      const w = Math.ceil(textImg.displayWidth + padX * 2);
      const h = Math.ceil(textImg.displayHeight + padY * 2);
      const bg = this.add.rectangle(0, 0, w, h, 0x061022, 0.82);
      bg.setStrokeStyle(2, 0x3a4a66, 0.95);
      const c = this.add.container(Math.round(VIEW_W / 2), Math.round(MAIN_H * 0.22));
      c.add(bg);
      c.add(textImg);
      c.setDepth(90);
      c.setScrollFactor(0);
      this._outcomeBanner = c;
    }

    _upsertNameLabel(roleId, name, spr, isActive, isLeader) {
      const rid = String(roleId);
      const labelText = String(name || "").trim() || i18nT("roleLabel");
      const color = isActive
        ? (isLeader ? "#ffe6a8" : "#e8f0ff")
        : (isLeader ? "#ffd27c" : "#cfe8ff");
      const needsRecreate = (obj, nextText, nextColor) => {
        if (!obj) return true;
        if (obj.__pixText !== nextText) return true;
        if (obj.__pixColor !== nextColor) return true;
        return false;
      };
      let t = this.roleNameLabels.get(rid);
      if (needsRecreate(t, labelText, color)) {
        if (t) {
          try {
            t.destroy();
          } catch {}
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
        try {
          prev.destroy();
        } catch {}
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
        try {
          prevTimer.remove(false);
        } catch {}
      }
      const timer = this.time.delayedCall(3600, () => {
        const b = this.roleBubbles.get(rid);
        if (!b) return;
        this.tweens.add({
          targets: b,
          alpha: 0,
          duration: 220,
          onComplete: () => {
            try {
              b.destroy();
            } catch {}
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
      const prevTod = this._tod;

      const nodeChanged = nodeId !== this._curNodeId;
      const moodChanged = weather !== this._weather || tod !== this._tod;

      const walkKey = `${nodeId}|${ws?.in_transit_from_node_id || ""}|${ws?.in_transit_to_node_id || ""}|${Number(
        ws?.in_transit_progress_km || 0,
      )}`;
      const walkChanged = walkKey !== this._walkKey;
      this._walkKey = walkKey;

      this._curNodeId = nodeId;
      this._visited = new Set(visited);
      this._weather = weather;
      this._tod = tod;
      this._ws = ws || {};
      this._rainActive = String(weather) === "rainy";
      this._snowActive = String(weather) === "snowy";
      this._windActive = String(weather) === "windy";
      this._fogActive = String(weather) === "foggy";

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
        // Only swap/re-layout when scene id changes (avoid refresh when scene stays the same).
        const nextSceneId = "base";
        if (nextSceneId !== this._sceneId) this._swapScene(nextSceneId);
      }

      this._updateOutcomeBanner(ws);

      // mood overlay can change frequently without re-rendering tiles
      if (moodChanged) {
        // Night arrival: fade to dark gradually
        if (this.worldOverlay && tod === "night" && prevTod !== "night") {
          try {
            this.worldOverlay.fillColor = 0x000000;
            this.tweens.add({
              targets: this.worldOverlay,
              alpha: 0.35,
              duration: 1200,
              ease: "Sine.easeInOut",
            });
          } catch {
            this._applyMoodOverlay(weather, tod);
          }
        } else {
          this._applyMoodOverlay(weather, tod);
        }
      }

      // 3) small "step" animation on move
      if (nodeChanged || walkChanged) {
        // Background is continuously scrolling now (two-copy loop), so no extra world bob here.
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

    _initRainDrops() {
      this._rainDrops = [];
      const count = Math.max(80, Math.floor((VIEW_W * MAIN_H) / 6000));
      for (let i = 0; i < count; i++) {
        this._rainDrops.push({
          x: Math.random() * VIEW_W,
          y: Math.random() * MAIN_H,
          len: 6 + Math.random() * 6,
          speed: 140 + Math.random() * 120,
          drift: -12 + Math.random() * 24,
        });
      }
    }

    _updateRain(delta) {
      if (!this._rainGfx) return;
      if (!this._rainActive) {
        this._rainGfx.clear();
        return;
      }
      const dt = Math.max(0, Number(delta || 0) / 1000);
      this._rainGfx.clear();
      this._rainGfx.lineStyle(1, 0x8ab4ff, 0.6);
      for (const d of this._rainDrops) {
        d.y += d.speed * dt;
        d.x += d.drift * dt;
        if (d.y > MAIN_H + d.len) {
          d.y = -d.len;
          d.x = Math.random() * VIEW_W;
        }
        if (d.x < -20) d.x = VIEW_W + 20;
        if (d.x > VIEW_W + 20) d.x = -20;
        const x1 = Math.round(d.x);
        const y1 = Math.round(d.y);
        const x2 = Math.round(d.x + 1);
        const y2 = Math.round(d.y + d.len);
        this._rainGfx.beginPath();
        this._rainGfx.moveTo(x1, y1);
        this._rainGfx.lineTo(x2, y2);
        this._rainGfx.strokePath();
      }
    }

    _initSnowFlakes() {
      this._snowFlakes = [];
      const count = Math.max(60, Math.floor((VIEW_W * MAIN_H) / 9000));
      for (let i = 0; i < count; i++) {
        this._snowFlakes.push({
          x: Math.random() * VIEW_W,
          y: Math.random() * MAIN_H,
          r: 1 + Math.random() * 1.6,
          speed: 26 + Math.random() * 24,
          drift: -8 + Math.random() * 16,
        });
      }
    }

    _updateSnow(delta) {
      if (!this._snowGfx) return;
      if (!this._snowActive) {
        this._snowGfx.clear();
        return;
      }
      const dt = Math.max(0, Number(delta || 0) / 1000);
      this._snowGfx.clear();
      this._snowGfx.fillStyle(0xe8f0ff, 0.75);
      for (const f of this._snowFlakes) {
        f.y += f.speed * dt;
        f.x += f.drift * dt;
        if (f.y > MAIN_H + 4) {
          f.y = -4;
          f.x = Math.random() * VIEW_W;
        }
        if (f.x < -10) f.x = VIEW_W + 10;
        if (f.x > VIEW_W + 10) f.x = -10;
        this._snowGfx.fillCircle(Math.round(f.x), Math.round(f.y), f.r);
      }
    }

    _initWindStreaks() {
      this._windStreaks = [];
      const count = Math.max(40, Math.floor((VIEW_W * MAIN_H) / 12000));
      for (let i = 0; i < count; i++) {
        this._windStreaks.push({
          x: Math.random() * VIEW_W,
          y: Math.random() * MAIN_H,
          len: 10 + Math.random() * 12,
          speed: 80 + Math.random() * 60,
        });
      }
    }

    _updateWind(delta) {
      if (!this._windGfx) return;
      if (!this._windActive) {
        this._windGfx.clear();
        return;
      }
      const dt = Math.max(0, Number(delta || 0) / 1000);
      this._windGfx.clear();
      this._windGfx.lineStyle(1, 0xc6d0e8, 0.5);
      for (const w of this._windStreaks) {
        w.x += w.speed * dt;
        w.y += (w.speed * 0.12) * dt;
        if (w.x > VIEW_W + w.len) {
          w.x = -w.len;
          w.y = Math.random() * MAIN_H;
        }
        if (w.y > MAIN_H + 10) w.y = -10;
        const x1 = Math.round(w.x);
        const y1 = Math.round(w.y);
        const x2 = Math.round(w.x + w.len);
        const y2 = Math.round(w.y + w.len * 0.15);
        this._windGfx.beginPath();
        this._windGfx.moveTo(x1, y1);
        this._windGfx.lineTo(x2, y2);
        this._windGfx.strokePath();
      }
    }

    _initFogBlobs() {
      this._fogBlobs = [];
      const count = 5;
      for (let i = 0; i < count; i++) {
        this._fogBlobs.push({
          x: Math.random() * VIEW_W,
          y: Math.random() * MAIN_H,
          w: VIEW_W * (0.4 + Math.random() * 0.5),
          h: MAIN_H * (0.12 + Math.random() * 0.18),
          speed: 6 + Math.random() * 6,
        });
      }
    }

    _updateFog(delta) {
      if (!this._fogGfx) return;
      if (!this._fogActive) {
        this._fogGfx.clear();
        return;
      }
      const dt = Math.max(0, Number(delta || 0) / 1000);
      this._fogGfx.clear();
      this._fogGfx.fillStyle(0xc6d0e8, 0.18);
      for (const b of this._fogBlobs) {
        b.x += b.speed * dt;
        if (b.x > VIEW_W + b.w) b.x = -b.w;
        const x = Math.round(b.x);
        const y = Math.round(b.y);
        const w = Math.round(b.w);
        const h = Math.round(b.h);
        this._fogGfx.fillRect(x, y, w, h);
      }
    }

    _renderWorld(nodeId, segFrom, segTo) {
      // Deterministic seed from session + node + mood
      const seedStr =
        String((worldState && worldState.session_id) || "seed") +
        "|" +
        String(nodeId) +
        "|" +
        String(segFrom || "") +
        "|" +
        String(segTo || "");
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
        if (rng() < 0.12)
          this.worldRT.draw(
            "brick",
            (xCenter - Math.floor(pathW / 2) - 1) * TILE,
            y * TILE,
          );
        if (rng() < 0.12)
          this.worldRT.draw(
            "brick",
            (xCenter + Math.floor(pathW / 2) + 1) * TILE,
            y * TILE,
          );
      }

      // Sprinkle leaves
      const leafN = 40 + Math.floor(rng() * 80);
      for (let i = 0; i < leafN; i++) {
        const px = Math.floor(rng() * (VIEW_W - 16));
        const py = Math.floor(rng() * (MAIN_H - 16));
        this.worldRT.draw("leaves", px, py);
      }

      // Trees/bushes/fence depending on kind (favor lining the path sides)
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
        const center = pathCenterByY[yTile] ?? Math.floor(tilesX / 2);
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
        const xTile = sideLeft
          ? Math.floor(rng() * leftBandMax)
          : rightBandMin + Math.floor(rng() * Math.max(1, tilesX - rightBandMin));
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

    // (The Phaser minimap code remains here for compatibility, but is currently disabled via SKIP_PHASER_MINIMAP.)
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
        try {
          t.destroy();
        } catch {}
      }
      this.minimapLabels = [];

      // frame
      this.minimapG.lineStyle(2, 0x3a4a66, 1);
      this.minimapG.strokeRect(1, 1, MINI_W - 2, MINI_H - 2);

      // edges (curved for a softer look)
      const curveSign = (s) => {
        let h = 0;
        for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
        return h & 1 ? 1 : -1;
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
        const bend =
          (8 + (isExit ? 6 : 0) + (visited ? 3 : 0)) *
          curveSign(String(e.from_node_id) + "->" + String(e.to_node_id));
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
        const kColor =
          kind === "exit"
            ? 0xff7c7c
            : kind === "camp"
              ? 0x7cffc6
              : kind === "lake"
                ? 0x7ca8ff
                : kind === "peak"
                  ? 0xffd27c
                  : kind === "start"
                    ? 0x9dff7c
                    : kind === "end"
                      ? 0xb0b6c6
                      : 0x7cf2ff;

        // soft glow + dot
        this.minimapG.fillStyle(0x0b1630, 0.85);
        this.minimapG.fillCircle(p.x, p.y, isCur ? 7 : 6);
        this.minimapG.fillStyle(kColor, isVisited ? 0.95 : 0.55);
        this.minimapG.fillCircle(p.x, p.y, isCur ? 5 : 4);

        // label (only key nodes + current to avoid clutter)
        const isKey =
          isCur ||
          ["start", "camp", "junction", "lake", "peak", "exit", "end"].includes(kind);
        const label = (n.name || n.node_id || "").trim();
        if (isKey && label) {
          const t = this.add.text(p.x + MINI_LABEL_OFF_X, p.y - MINI_LABEL_OFF_Y, label, {
            // Use a CJK-friendly font stack to improve readability for Chinese labels
            fontFamily:
              '"PingFang SC","Hiragino Sans GB","Microsoft YaHei",ui-monospace,Menlo,Monaco,Consolas,monospace',
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
