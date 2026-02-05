export let mapNodes = [];
export let mapEdges = [];
export let mapStartNodeId = "start";
export let sessionId = null;
export let worldState = null;

export function setMapData(data) {
  mapNodes = data?.nodes || [];
  mapEdges = data?.edges || [];
  mapStartNodeId = data?.start_node_id || "start";
}

export function setSessionId(id) {
  sessionId = id;
}

export function setWorldState(ws) {
  worldState = ws;
}

export function nodeById(id) {
  if (!id) return null;
  return (mapNodes || []).find((n) => n.node_id === id) || null;
}

export function edgeByToId(fromId, toId) {
  return (
    (mapEdges || []).find((e) => e.from_node_id === fromId && e.to_node_id === toId) || null
  );
}
