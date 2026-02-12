import { mapEdges, mapNodes, mapStartNodeId } from "./state.js";
import { clamp } from "./utils.js";

export function initMinimapCanvas() {
  const root = document.getElementById("minimap-root");
  const canvas = document.getElementById("minimap-canvas");
  const ctx = canvas && canvas.getContext ? canvas.getContext("2d") : null;
  if (!root || !canvas || !ctx) return null;

  const fontStack =
    '"PingFang SC","Hiragino Sans GB","Microsoft YaHei",system-ui,sans-serif';
  const state = { ws: null, dpr: 1 };

  const nodeByIdLocal = (id) =>
    (mapNodes || []).find((n) => String(n.node_id) === String(id));

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
      return h & 1 ? 1 : -1;
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

      ctx.strokeStyle = isExit
        ? `rgba(255,124,124,${alpha})`
        : `rgba(124,242,255,${alpha})`;
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

      const isKey =
        isCur || ["start", "camp", "junction", "lake", "peak", "exit", "end"].includes(kind);
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
