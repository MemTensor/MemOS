import { sessionId, setMapData, setSessionId, setWorldState, worldState } from "./state.js";
import { logMsg, renderBranchChoices, renderPartyStatus, renderRoles, setStatus, checkAndShowShareButton } from "./render.js";
import { applyPhaseUI, isNightVoteModalBlocking } from "./phase_ui.js";

export const API_BASE = "/api/demo/ao-tai";

let _autoTimer = null;
let _autoInFlight = false;

function _isGameOver(ws) {
  if (!ws) return false;
  const roles = ws.roles || [];
  if (roles.length > 0 && roles.every((r) => Number(r?.attrs?.stamina || 0) <= 0)) return true;
  const terminalIds = new Set(["end_exit", "bailout_2800", "bailout_ridge"]);
  const curId = String(ws.current_node_id || "");
  return terminalIds.has(curId);
}

function _shouldAutoContinue(ws) {
  if (!ws) return false;
  if (_isGameOver(ws)) return false;
  if (!ws.active_role_id) return false;
  const phase = ws.phase || "free";
  if (phase !== "free") return false;
  if (isNightVoteModalBlocking?.()) return false;
  // Stop when reaching a terminal node (no outgoing edges in this demo).
  const terminal = new Set(["end_exit", "bailout_2800", "bailout_ridge"]);
  if (terminal.has(String(ws.current_node_id || ""))) return false;
  return true;
}

function _scheduleAutoContinue() {
  if (_autoTimer) return;
  if (!_shouldAutoContinue(worldState)) return;
  _autoTimer = setTimeout(async () => {
    _autoTimer = null;
    if (_autoInFlight) return;
    if (!_shouldAutoContinue(worldState)) return;
    _autoInFlight = true;
    try {
      await apiAct("CONTINUE");
    } finally {
      _autoInFlight = false;
    }
  }, 900);
}

export function scheduleAutoContinue() {
  _scheduleAutoContinue();
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

export async function apiGetMap() {
  const resp = await fetch(`${API_BASE}/map`);
  const data = await resp.json();
  setMapData(data);
}

function _makeUserId() {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 8);
  return `demo_user_${ts}_${rand}`;
}

export async function apiNewSession() {
  const data = await api("/session/new", { user_id: _makeUserId() });
  setSessionId(data.session_id);
  setWorldState(data.world_state);
  logMsg({ kind: "system", content: "已创建新 Session。", timestamp_ms: Date.now() });
  setStatus();
  renderPartyStatus();
  renderBranchChoices();
  if (window.__aoTaiMapView) window.__aoTaiMapView.setState(worldState);
  if (window.__aoTaiMinimap) window.__aoTaiMinimap.setState(worldState);
  applyPhaseUI(worldState);
  checkAndShowShareButton(data.world_state);
  _scheduleAutoContinue();
}

export async function apiUpsertRole(role) {
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
  applyPhaseUI(worldState);
  _scheduleAutoContinue();
}

export async function apiRolesQuickstart(overwrite = false) {
  const data = await api("/roles/quickstart", { session_id: sessionId, overwrite });
  worldState.roles = data.roles;
  worldState.active_role_id = data.active_role_id;
  renderRoles();
  renderPartyStatus();
  renderBranchChoices();
  setStatus();
  if (window.__aoTaiMinimap) window.__aoTaiMinimap.setState(worldState);
  // ensure Phaser shows the party immediately after creation/update
  if (window.__aoTaiMapView) window.__aoTaiMapView.setState(worldState);
  applyPhaseUI(worldState);
  _scheduleAutoContinue();
}

export async function apiSetActiveRole(roleId) {
  const ws = await api("/session/active_role", { session_id: sessionId, active_role_id: roleId }, "PUT");
  setWorldState(ws);
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
  applyPhaseUI(worldState);
  _scheduleAutoContinue();
}

export async function apiAct(action, payload = {}) {
  if (_isGameOver(worldState)) return null;
  // Show "conversing" hint immediately when moving forward (may trigger NPC chat)
  if (action === "MOVE_FORWARD") {
    logMsg({
      kind: "system",
      content: "正在与队友对话…",
      timestamp_ms: Date.now(),
    });
  }
  const data = await api("/act", { session_id: sessionId, action, payload });
  setWorldState(data.world_state);

  for (const m of data.messages || []) logMsg(m);
  setStatus();
  renderRoles();
  renderPartyStatus();
  renderBranchChoices();
  if (window.__aoTaiMapView) window.__aoTaiMapView.setState(worldState);
  if (window.__aoTaiMinimap) window.__aoTaiMinimap.setState(worldState);
  applyPhaseUI(worldState);

  // 检查并显示分享按钮（随时可见）
  checkAndShowShareButton(data.world_state);

  _scheduleAutoContinue();
  return data;
}

export function installActionsToWindow() {
  window.__aoTaiActions = {
    apiGetMap,
    apiNewSession,
    apiUpsertRole,
    apiSetActiveRole,
    apiAct,
    scheduleAutoContinue,
  };
}
