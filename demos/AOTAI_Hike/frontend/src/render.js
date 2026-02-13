import { branchEl, chatEl, partyEl, rolesEl, statusEl } from "./dom.js";
import { t } from "./i18n.js";
import { edgeByToId, mapNodes, nodeById, worldState, sessionId } from "./state.js";
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
  const who = msg.kind === "system" ? t("system") : msg.role_name || t("unknown");
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
    locStr = `${t("statusEnRoute")}${toN?.name || worldState.in_transit_to_node_id} (${prog}/${tot}km)`;
  }
  statusEl.textContent = `Session: ${worldState.session_id} | ${t("statusLocation")}: ${locStr} | ${t("statusDay")} ${
    worldState.day
  }/${worldState.time_of_day} | ${t("statusWeather")}: ${worldState.weather} | ${t("statusCurrentRole")}: ${active?.name || "-"}`;
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
    const label = e && e.label ? e.label : t("nextStep");
    const name = n ? n.name : id;
    items.push({ id: id, text: label + "：" + name });
  }

  branchEl.style.display = "block";
  branchEl.innerHTML = "";

  const label = document.createElement("div");
  label.className = "label";
  label.textContent = t("junctionChoose");

  const box = document.createElement("div");
  box.className = "choices";

  for (const it of items) {
    const btn = document.createElement("button");
    btn.textContent = it.text;

    btn.onclick = async () => {

    branchEl.style.display = "none";
    branchEl.innerHTML = "";

    worldState.available_next_node_ids = [];
    worldState.phase = "free";

    await window.__aoTaiActions.apiAct("MOVE_FORWARD", { next_node_id: it.id });
  };

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
    empty.innerHTML = `<div class="party-name">${t("partyStatus")}</div><div class="party-sub">${t("partyEmpty")}</div>`;
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
    const supplies = pct(r?.attrs?.supplies || 80);

    const head = document.createElement("div");
    head.className = "party-head";

    const img = document.createElement("img");
    img.className = "party-ava";
    img.alt = `${r.name} avatar`;
    img.src = avatarUrl(r);

    const meta = document.createElement("div");
    meta.innerHTML = `<div class="party-name">${r.name}</div>
      <div class="party-sub">${t("currentPlay")}：${r.role_id === worldState.active_role_id ? t("yes") : t("no")}</div>`;

    head.appendChild(img);
    head.appendChild(meta);

    const stat = document.createElement("div");
    stat.className = "stat";
    stat.innerHTML = `
      <div class="stat-row">
        <div class="stat-label">${t("stamina")}</div>
        <div class="stat-bar ${statClass(stamina)}"><div style="width:${stamina}%"></div></div>
        <div class="stat-val">${stamina}</div>
      </div>
      <div class="stat-row">
        <div class="stat-label">${t("mood")}</div>
        <div class="stat-bar ${statClass(mood)}"><div style="width:${mood}%"></div></div>
        <div class="stat-val">${mood}</div>
      </div>
      <div class="stat-row">
        <div class="stat-label">${t("experience")}</div>
        <div class="stat-bar ok"><div style="width:${exp}%"></div></div>
        <div class="stat-val">${exp}</div>
      </div>
      <div class="stat-row">
        <div class="stat-label">${t("risk")}</div>
        <div class="stat-bar warn"><div style="width:${risk}%"></div></div>
        <div class="stat-val">${risk}</div>
      </div>
      <div class="stat-row">
        <div class="stat-label">${t("supplies")}</div>
        <div class="stat-bar ${statClass(supplies)}"><div style="width:${supplies}%"></div></div>
        <div class="stat-val">${supplies}</div>
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

// Share button and modal functionality
let shareButton = null;
let shareModal = null;
let shareImagePreview = null;
let shareDownloadBtn = null;
let currentShareImageBlob = null;

function initShareButton() {
  if (shareButton) return;

  shareButton = document.getElementById("share-button");
  if (!shareButton) return;

  shareButton.onclick = async () => {
    await showShareModal();
  };

  // Initialize share modal elements
  shareModal = document.getElementById("share-modal");
  shareImagePreview = document.getElementById("share-image-preview");
  shareDownloadBtn = document.getElementById("share-download-btn");
  const shareCloseBtn = document.getElementById("share-close-btn");

  if (shareDownloadBtn) {
    shareDownloadBtn.onclick = () => {
      // allow async download (canvas 合成多图层再导出)
      downloadShareImage();
    };
  }

  if (shareCloseBtn) {
    shareCloseBtn.onclick = () => {
      hideShareModal();
    };
  }

  // Show button when session is available
  if (worldState?.session_id) {
    shareButton.style.display = "block";
  }
}

async function showShareModal() {
  initShareButton();
  if (!shareModal || !shareImagePreview) return;

  const currentSessionId = sessionId || worldState?.session_id;
  if (!currentSessionId) {
    alert(t("shareNoSession"));
    return;
  }

  // Show loading state
  shareImagePreview.src = "";
  shareImagePreview.style.display = "none";
  const loadingText = shareModal.querySelector(".loading-text");
  if (!loadingText) {
    const loading = document.createElement("div");
    loading.className = "loading-text";
    loading.textContent = t("shareGenerating");
    loading.style.textAlign = "center";
    loading.style.padding = "20px";
    shareImagePreview.parentElement.insertBefore(loading, shareImagePreview);
  } else {
    loadingText.style.display = "block";
  }

  shareModal.style.display = "flex";

  try {
    // Fetch latest share image from API
    const API_BASE = "/api/demo/ao-tai";
    const response = await fetch(`${API_BASE}/session/${currentSessionId}/share_image/current`);
    if (!response.ok) {
      throw new Error(`Failed to fetch share image: ${response.statusText}`);
    }

    const blob = await response.blob();
    currentShareImageBlob = blob;
    const imageUrl = URL.createObjectURL(blob);

    shareImagePreview.src = imageUrl;
    shareImagePreview.style.display = "block";

    const loadingText = shareModal.querySelector(".loading-text");
    if (loadingText) {
      loadingText.style.display = "none";
    }
  } catch (error) {
    console.error("Failed to load share image:", error);
    const loadingText = shareModal.querySelector(".loading-text");
    if (loadingText) {
      loadingText.textContent = `${t("shareLoadFailed")}: ${error.message}`;
      loadingText.style.color = "var(--danger)";
    }
  }
}

function hideShareModal() {
  if (shareModal) {
    shareModal.style.display = "none";
  }
  // Clean up blob URL
  if (shareImagePreview?.src && shareImagePreview.src.startsWith("blob:")) {
    URL.revokeObjectURL(shareImagePreview.src);
  }
}

async function downloadShareImage() {
  if (!currentShareImageBlob) return;

  // 1) 先把后端返回的“分享图”加载为 Image
  const baseUrl = URL.createObjectURL(currentShareImageBlob);
  const baseImg = new Image();
  baseImg.src = baseUrl;

  // 为了避免跨域问题，保持和当前页面同源（assets 也是本地静态资源）
  await new Promise((resolve, reject) => {
    baseImg.onload = () => resolve();
    baseImg.onerror = (e) => reject(e);
  });

  const width = baseImg.naturalWidth || baseImg.width;
  const height = baseImg.naturalHeight || baseImg.height;

  // 2) 创建离屏 canvas，把所有需要的图层按顺序画进去
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    // fallback：直接下载原始分享图
    const link = document.createElement("a");
    link.href = baseUrl;
    link.download = `aotai_hike_${Date.now()}.png`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(baseUrl);
    return;
  }

  // 像素风：禁用平滑缩放
  ctx.imageSmoothingEnabled = false;

  // 底层：原始分享图
  // 为了和前端 modal 中的布局一致，这里按与 CSS 相同的“内缩”绘制：
  // CSS 中：
  //   #share-image-container { inset: 44px 52px 82px; }
  //   #share-card-frame      { inset: 12px; }
  // 也就是分享图相对于外框再往里缩一圈。
  const insetTop = 44;
  const insetRight = 52;
  const insetBottom = 82;
  const insetLeft = 52;
  const innerWidth = Math.max(1, width - insetLeft - insetRight);
  const innerHeight = Math.max(1, height - insetTop - insetBottom);

  ctx.drawImage(baseImg, insetLeft, insetTop, innerWidth, innerHeight);

  // 尝试叠加 PNG 外框与噪点图；若加载失败则忽略。
  // 注意顺序：先画外框，再在最上层叠加噪点，以匹配前端 DOM 的层级。
  const extraLayers = [
    "./assets/share_frame.png",
    "./assets/share_noise.png",
  ];

  for (const src of extraLayers) {
    try {
      const img = new Image();
      img.src = src;
      // 为避免某些浏览器默认平滑，显式关闭
      await new Promise((resolve, reject) => {
        img.onload = () => resolve();
        img.onerror = () => resolve(); // 静默失败：没有这张图就跳过
      });
      if (img.width && img.height) {
        if (src.includes("share_noise")) {
          // 与 CSS 中的 soft-light 类似的叠加效果
          const prevOp = ctx.globalCompositeOperation;
          ctx.globalCompositeOperation = "soft-light";
          ctx.drawImage(img, 0, 0, width, height);
          ctx.globalCompositeOperation = prevOp;
        } else {
          ctx.drawImage(img, 0, 0, width, height);
        }
      }
    } catch {
      // ignore single-layer failure
    }
  }

  URL.revokeObjectURL(baseUrl);

  // 3) 导出最终合成图并触发下载
  canvas.toBlob((blob) => {
    if (!blob) return;
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `aotai_hike_${Date.now()}.png`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  }, "image/png");
}

export function checkAndShowShareButton(ws) {
  initShareButton();
  if (!shareButton) return;

  // Show button whenever session is available
  if (ws?.session_id) {
    shareButton.style.display = "block";
  } else {
    shareButton.style.display = "none";
  }
}
