import { sessionId, setMapData, setSessionId, setWorldState, worldState } from "./state.js";
import { logMsg, renderBranchChoices, renderPartyStatus, renderRoles, setStatus } from "./render.js";
import { applyPhaseUI } from "./phase_ui.js";

export const API_BASE = "/api/demo/ao-tai";

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

export async function apiNewSession() {
  const data = await api("/session/new", { user_id: "demo_user" });
  setSessionId(data.session_id);
  setWorldState(data.world_state);
  logMsg({ kind: "system", content: "已创建新 Session。", timestamp_ms: Date.now() });
  setStatus();
  renderPartyStatus();
  renderBranchChoices();
  if (window.__aoTaiMapView) window.__aoTaiMapView.setState(worldState);
  if (window.__aoTaiMinimap) window.__aoTaiMinimap.setState(worldState);
  applyPhaseUI(worldState);
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
}

export async function apiAct(action, payload = {}) {
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
}

export function installActionsToWindow() {
  window.__aoTaiActions = { apiGetMap, apiNewSession, apiUpsertRole, apiSetActiveRole, apiAct };
}
