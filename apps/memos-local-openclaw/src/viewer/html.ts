export function viewerHTML(pluginVersion?: string): string {
const vBadge = pluginVersion ? `<span class="version-badge">v${pluginVersion}</span>` : '';
return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="icon" href="https://statics.memtensor.com.cn/logo/color-m.svg" type="image/svg+xml">
<title>OpenClaw 记忆</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>
*{margin:0;padding:0;box-sizing:border-box}
html{overflow-y:scroll}
:root{
  --bg:#0b0d11;--bg-card:#12141a;--bg-card-hover:#1a1d25;
  --border:rgba(255,255,255,.08);--border-glow:rgba(255,255,255,.14);
  --text:#e8eaed;--text-sec:#8b8fa4;--text-muted:#555a6e;
  --pri:#818cf8;--pri-glow:rgba(129,140,248,.1);--pri-dark:#6366f1;
  --pri-grad:linear-gradient(135deg,#818cf8,#6366f1);
  --accent:#ef4444;--accent-glow:rgba(239,68,68,.1);
  --green:#34d399;--green-bg:rgba(52,211,153,.08);
  --amber:#fbbf24;--amber-bg:rgba(251,191,36,.08);
  --violet:#818cf8;--rose:#ef4444;--rose-bg:rgba(239,68,68,.08);
  --shadow-sm:0 1px 2px rgba(0,0,0,.3);--shadow:0 4px 12px rgba(0,0,0,.35);
  --shadow-lg:0 20px 40px rgba(0,0,0,.45);
  --radius:12px;--radius-lg:14px;--radius-xl:18px;
}
[data-theme="light"]{
  --bg:#f8f9fb;--bg-card:#fff;--bg-card-hover:#f3f4f6;
  --border:#e2e4e9;--border-glow:#cbd0d8;
  --text:#111827;--text-sec:#4b5563;--text-muted:#9ca3af;
  --pri:#4f46e5;--pri-glow:rgba(79,70,229,.06);--pri-dark:#4338ca;
  --pri-grad:linear-gradient(135deg,#4f46e5,#4338ca);
  --accent:#dc2626;--accent-glow:rgba(220,38,38,.06);
  --green:#059669;--green-bg:rgba(5,150,105,.06);
  --amber:#d97706;--amber-bg:rgba(217,119,6,.06);
  --violet:#4f46e5;--rose:#dc2626;--rose-bg:rgba(220,38,38,.06);
  --shadow-sm:0 1px 2px rgba(0,0,0,.04);--shadow:0 4px 12px rgba(0,0,0,.06);
  --shadow-lg:0 20px 40px rgba(0,0,0,.1);
}
[data-theme="light"] .auth-screen{background:linear-gradient(135deg,#f0f4ff 0%,#f8f9fb 50%,#eef2ff 100%)}
[data-theme="light"] .auth-card{box-shadow:0 25px 50px -12px rgba(0,0,0,.08)}
[data-theme="light"] .topbar{background:rgba(255,255,255,.92);border-bottom-color:var(--border);backdrop-filter:blur(8px)}
[data-theme="light"] .session-item .count,[data-theme="light"] .session-tag{background:rgba(0,0,0,.05)}
[data-theme="light"] .owner-tag{background:rgba(99,102,241,.08);border-color:rgba(99,102,241,.18)}
[data-theme="light"] .card-content pre{background:#f3f4f6;border-color:var(--border)}
[data-theme="light"] .vscore-badge{background:rgba(79,70,229,.06);color:#4f46e5}
[data-theme="light"] ::-webkit-scrollbar-thumb{background:rgba(0,0,0,.15)}
[data-theme="light"] .analytics-card{background:#fff;box-shadow:0 1px 3px rgba(0,0,0,.06);border:1px solid var(--border)}
[data-theme="light"] .analytics-card::before{background:none}
[data-theme="light"] .analytics-card::after{display:none}
[data-theme="light"] .analytics-card:hover{box-shadow:0 4px 16px rgba(0,0,0,.08);transform:translateY(-2px)}
[data-theme="light"] .analytics-card.green{background:#fff;border-color:var(--border)}
[data-theme="light"] .analytics-card.green::before{background:none}
[data-theme="light"] .analytics-card.amber{background:#fff;border-color:var(--border)}
[data-theme="light"] .analytics-card.amber::before{background:none}
[data-theme="light"] .analytics-card .ac-value{-webkit-text-fill-color:unset;background:none;color:#111827}
[data-theme="light"] .analytics-card.green .ac-value{color:#059669}
[data-theme="light"] .analytics-card.amber .ac-value{color:#d97706}
[data-theme="light"] .analytics-section{background:#fff;border-color:var(--border);box-shadow:0 1px 3px rgba(0,0,0,.04)}
[data-theme="light"] .analytics-section::before{background:none}
[data-theme="light"] .chart-bar{box-shadow:0 1px 4px rgba(99,102,241,.12)}
[data-theme="light"] .chart-bar:hover{box-shadow:0 3px 12px rgba(79,70,229,.2)}
[data-theme="light"] .chart-bars::before{opacity:.3}
[data-theme="light"] .tool-chart-tooltip{background:rgba(17,24,39,.92);color:#e8eaed;border-color:rgba(99,102,241,.3);box-shadow:0 8px 24px rgba(0,0,0,.2)}
[data-theme="light"] .tool-chart-tooltip .tt-time{color:#a5b4fc}
[data-theme="light"] .tool-chart-tooltip .tt-val{color:#e8eaed}
[data-theme="light"] .tool-agg-table td{background:transparent}
[data-theme="light"] .tool-agg-table tr:hover td{background:rgba(79,70,229,.03)}
[data-theme="light"] .tool-agg-table th{color:#9ca3af}
[data-theme="light"] .range-btn{background:transparent;border-color:var(--border);color:var(--text-sec)}
[data-theme="light"] .range-btn.active{background:rgba(79,70,229,.06);color:#4f46e5;border-color:rgba(79,70,229,.2)}
[data-theme="light"] .range-btn:hover{border-color:#4f46e5;color:#4f46e5}
body{font-family:'Inter',-apple-system,BlinkMacSystemFont,sans-serif;background:var(--bg);color:var(--text);line-height:1.6;transition:background .2s,color .2s}
button{cursor:pointer;font-family:inherit;font-size:inherit}
input,textarea,select{font-family:inherit;font-size:inherit}

/* ─── Auth (Linkify 配色: globals.css .dark + 蓝紫渐变) ─── */
.auth-screen{display:flex;align-items:center;justify-content:center;min-height:100vh;padding:20px;background:linear-gradient(135deg,rgb(36,0,255) 0%,rgb(0,135,255) 35%,rgb(108,39,157) 70%,rgb(105,30,255) 100%);position:relative;overflow:hidden}
.auth-card{background:hsl(0 0% 100%);border:none;border-radius:8px;padding:48px 40px;width:100%;max-width:420px;box-shadow:0 25px 50px -12px rgba(0,0,0,.25);text-align:center;position:relative;z-index:1}
.auth-card .logo{margin:0 auto 20px;text-align:center;line-height:0;background:none;border-radius:0}
.auth-card .logo svg{filter:drop-shadow(0 0 16px rgba(255,77,77,.35));animation:logoFloat 3s ease-in-out infinite}
@keyframes logoFloat{0%,100%{transform:translateY(0);filter:drop-shadow(0 0 16px rgba(255,77,77,.35))}50%{transform:translateY(-6px);filter:drop-shadow(0 0 24px rgba(255,77,77,.55))}}
.auth-card h1{font-size:22px;font-weight:700;margin-bottom:4px;color:hsl(0 0% 3.9%);letter-spacing:-.02em}
.auth-card p{color:hsl(0 0% 45.1%);margin-bottom:24px;font-size:14px}
.auth-card input{width:100%;padding:12px 16px;border:1px solid hsl(0 0% 89.8%);border-radius:8px;font-size:14px;transition:all .2s;margin-bottom:10px;outline:none;background:#fff;color:hsl(0 0% 3.9%)}
.auth-card input::placeholder{color:hsl(0 0% 45.1%)}
.auth-card input:focus{border-color:var(--pri);box-shadow:0 0 0 3px var(--pri-glow)}
.auth-card .btn-auth{width:100%;padding:11px;border:1px solid var(--pri);border-radius:8px;background:rgba(99,102,241,.06);color:var(--pri);font-weight:600;font-size:14px;transition:all .15s}
.auth-card .btn-auth:hover{background:rgba(99,102,241,.12);border-color:var(--pri-dark)}
.auth-card .error-msg{color:hsl(0 84.2% 60.2%);font-size:13px;margin-top:8px;min-height:20px}
.auth-card .btn-text{color:hsl(0 0% 45.1%)}
.auth-card .btn-text:hover{color:var(--pri)}

.reset-guide{text-align:left;margin-bottom:20px}
.reset-step{display:flex;gap:14px;margin-bottom:16px}
.step-num{width:28px;height:28px;border-radius:50%;background:var(--pri);color:#fff;font-size:12px;font-weight:700;display:flex;align-items:center;justify-content:center;flex-shrink:0}
.step-body{flex:1;min-width:0}
.step-title{font-size:14px;font-weight:600;color:hsl(0 0% 3.9%);margin-bottom:2px}
.step-desc{font-size:13px;color:hsl(0 0% 45.1%);line-height:1.5}
.cmd-box{margin-top:8px;background:hsl(0 0% 96.1%);border:1px solid hsl(0 0% 89.8%);border-radius:8px;padding:12px 14px;font-size:12px;font-family:ui-monospace,monospace;cursor:pointer;transition:all .15s;display:flex;align-items:center;justify-content:space-between;gap:8px;word-break:break-all;color:hsl(0 0% 3.9%)}
.cmd-box:hover{border-color:hsl(0 0% 70%);background:hsl(0 0% 96.1%)}
.cmd-box code{flex:1}
.copy-hint{font-size:11px;color:hsl(0 0% 45.1%);white-space:nowrap}
.cmd-box.copied .copy-hint{color:hsl(142 71% 45%)}

/* ─── App Layout (dark dashboard, same as www) ─── */
.app{display:none;flex-direction:column;min-height:100vh}
.topbar{background:rgba(11,13,17,.88);border-bottom:1px solid var(--border);height:56px;display:flex;align-items:center;position:sticky;top:0;z-index:100;backdrop-filter:blur(12px)}
.topbar-inner{display:flex;align-items:center;width:100%;max-width:1400px;margin:0 auto;padding:0 32px}
.topbar .brand{display:flex;align-items:center;gap:8px;font-weight:700;font-size:15px;color:var(--text);letter-spacing:-.02em;flex-shrink:0}
.topbar .brand .icon{width:24px;height:24px;display:flex;align-items:center;justify-content:center;font-size:18px;background:none;border-radius:0}
.topbar .brand .brand-title{font-size:13px;font-weight:500;opacity:.7}
.topbar .brand .brand-col{display:flex;flex-direction:column;gap:0}
.topbar .brand .brand-powered{font-size:9px;font-weight:500;color:var(--text-sec);opacity:.55;letter-spacing:.02em;line-height:1}
.topbar .brand .sub{font-weight:400;color:var(--text-muted);font-size:11px}
.memos-logo{display:inline-flex;align-items:center}
.memos-logo svg{height:28px;width:28px}
.brand-sep{width:1px;height:20px;background:var(--border);opacity:.5;margin:0 2px}
.version-badge{font-size:10px;font-weight:600;color:var(--text-muted);background:rgba(255,255,255,.08);border:1px solid rgba(255,255,255,.1);padding:1px 7px;border-radius:6px;margin-left:6px;letter-spacing:.02em;user-select:all}
[data-theme="light"] .version-badge{background:rgba(0,0,0,.05);border-color:rgba(0,0,0,.08);color:var(--text-sec)}
.topbar-center{flex:1;display:flex;justify-content:center}
.topbar .actions{display:flex;align-items:center;gap:6px;flex-shrink:0}

.main-content{display:flex;flex:1;max-width:1400px;margin:0 auto;width:100%;padding:28px 32px;gap:28px}

/* ─── Sidebar ─── */
.sidebar{width:260px;min-width:260px;flex-shrink:0;position:sticky;top:84px;max-height:calc(100vh - 112px);display:flex;flex-direction:column}
.sidebar > * {flex-shrink:0}
.sidebar .stats-grid{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:20px}
.stat-card{background:var(--bg-card);border:1px solid var(--border);border-radius:var(--radius);padding:14px 16px;transition:all .2s;position:relative;overflow:hidden}
.stat-card::before{content:'';position:absolute;top:0;left:0;bottom:0;width:3px;border-radius:3px 0 0 3px;background:var(--border)}
.stat-card:hover{border-color:var(--border-glow);background:var(--bg-card-hover)}
.stat-card .stat-value{font-size:20px;font-weight:700;color:var(--text);letter-spacing:-.02em}
.stat-card .stat-label{font-size:11px;color:var(--text-sec);margin-top:2px;font-weight:500}
.stat-card.pri{border-left-color:transparent}.stat-card.pri::before{background:var(--pri)}
.stat-card.pri .stat-value{color:var(--pri)}
.stat-card.green{border-left-color:transparent}.stat-card.green::before{background:var(--green)}
.stat-card.green .stat-value{color:var(--green)}
.stat-card.amber{border-left-color:transparent}.stat-card.amber::before{background:var(--amber)}
.stat-card.amber .stat-value{color:var(--amber)}
.stat-card.rose{border-left-color:transparent}.stat-card.rose::before{background:var(--rose)}
.stat-card.rose .stat-value{color:var(--rose)}

.sidebar .section-title{font-size:11px;font-weight:600;color:var(--text-muted);text-transform:uppercase;letter-spacing:.08em;margin:24px 0 12px;padding:0 2px}
.session-item .count{color:var(--text-sec);font-size:11px;font-weight:600;background:rgba(0,0,0,.2);padding:3px 8px;border-radius:8px}

.provider-badge{display:inline-flex;align-items:center;gap:6px;padding:6px 12px;background:var(--green-bg);color:var(--green);border-radius:999px;font-size:11px;font-weight:600;margin-top:10px}
.provider-badge.offline{background:var(--amber-bg);color:var(--amber)}

/* ─── Feed ─── */
.feed{flex:1;min-width:0}
.search-bar{display:flex;gap:10px;margin-bottom:14px;position:relative;align-items:center}
.search-bar input{flex:1;padding:10px 16px 10px 40px;border:1px solid var(--border);border-radius:10px;font-size:14px;outline:none;background:var(--bg-card);color:var(--text);transition:all .2s}
.search-bar input::placeholder{color:var(--text-muted)}
.search-bar input:focus{border-color:var(--pri);box-shadow:0 0 0 3px var(--pri-glow)}
.search-bar .search-icon{position:absolute;left:14px;top:50%;transform:translateY(-50%);color:var(--text-muted);font-size:14px;pointer-events:none}
.search-bar .filter-select{padding:8px 14px;padding-right:30px;border-radius:10px;font-size:13px;background:var(--bg-card);flex-shrink:0}
.search-meta{font-size:12px;color:var(--text-sec);padding:0 2px}.search-meta:not(:empty){margin-bottom:14px}
.scope-select{padding:10px 12px;border:1px solid var(--border);border-radius:10px;background:var(--bg-card);color:var(--text);font-size:13px;min-width:110px;outline:none}
.sharing-inline-meta{font-size:12px;color:var(--text-muted);margin:-8px 0 14px 2px}
.sharing-sidebar-card{margin:14px 0 18px;border:1px solid var(--border);background:var(--bg-card);border-radius:12px;padding:12px;box-shadow:var(--shadow-sm)}
.sharing-sidebar-card .title{font-size:12px;font-weight:700;color:var(--text);margin-bottom:8px;text-transform:uppercase;letter-spacing:.04em}
.sharing-sidebar-card .status{font-size:13px;color:var(--text-sec);line-height:1.5}
.sharing-sidebar-card .status strong{color:var(--text)}
.sharing-sidebar-card .hint{margin-top:8px;font-size:11px;color:var(--text-muted)}
.sharing-sidebar-card .user-row{display:flex;align-items:center;gap:8px;margin-bottom:10px}
.sharing-sidebar-card .user-row .username{font-size:13px;font-weight:600;color:var(--text)}
.sharing-sidebar-card .role-badge{display:inline-block;font-size:10px;font-weight:600;padding:2px 8px;border-radius:9999px;line-height:1.4;letter-spacing:.02em}
.sharing-sidebar-card .role-badge.admin{background:rgba(52,199,89,.15);color:#34c759}
.sharing-sidebar-card .role-badge.client{background:rgba(175,82,222,.15);color:#af52de}
.sharing-sidebar-card .info-grid{display:grid;grid-template-columns:auto 1fr;gap:4px 10px;font-size:12px;margin-bottom:8px}
.sharing-sidebar-card .info-grid .label{color:var(--text-muted);font-weight:500;white-space:nowrap}
.sharing-sidebar-card .info-grid .value{color:var(--text-sec);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.sharing-sidebar-card .api-badge{display:inline-block;font-size:10px;font-weight:600;padding:2px 8px;border-radius:9999px;background:rgba(142,142,147,.12);color:var(--text-muted);letter-spacing:.02em}
[data-theme="light"] .sharing-sidebar-card .role-badge.admin{background:rgba(5,150,105,.1);color:#059669}
[data-theme="light"] .sharing-sidebar-card .role-badge.client{background:rgba(124,58,237,.1);color:#7c3aed}
.result-section{margin-bottom:18px;border:1px solid var(--border);border-radius:14px;background:var(--bg-card);overflow:hidden}
.result-section-header{display:flex;justify-content:space-between;align-items:center;padding:12px 14px;border-bottom:1px solid var(--border);background:rgba(255,255,255,.02)}
.result-section-title{font-size:14px;font-weight:700;color:var(--text)}
.result-section-sub{font-size:12px;color:var(--text-muted)}
.search-hit-list{padding:12px;display:flex;flex-direction:column;gap:10px}
.search-hit-card,.hub-hit-card,.hub-skill-card{border:1px solid var(--border);border-radius:12px;background:var(--bg);padding:12px;box-shadow:var(--shadow-sm)}
.search-hit-card .summary,.hub-hit-card .summary,.hub-skill-card .summary{font-size:14px;font-weight:600;color:var(--text);margin-bottom:6px}
.search-hit-card .excerpt,.hub-hit-card .excerpt,.hub-skill-card .excerpt{font-size:12px;color:var(--text-sec);line-height:1.55;white-space:pre-wrap}
.search-hit-meta,.hub-hit-meta,.hub-skill-meta{display:flex;flex-wrap:wrap;gap:8px;margin-top:8px;font-size:11px;color:var(--text-muted)}
.meta-chip{display:inline-flex;align-items:center;gap:5px;padding:4px 8px;border:1px solid var(--border);border-radius:999px;background:var(--bg-card)}
.hub-hit-actions,.hub-skill-actions,.task-share-actions{display:flex;flex-wrap:wrap;gap:8px;margin-top:10px}
.sharing-settings-grid{display:grid;grid-template-columns:1.1fr .9fr;gap:18px}
.sharing-panel{border:1px solid var(--border);border-radius:14px;background:var(--bg-card);padding:14px;box-shadow:var(--shadow-sm)}
.sharing-panel h4{font-size:14px;font-weight:700;color:var(--text);margin:0 0 10px 0}
.sharing-panel .line{font-size:13px;color:var(--text-sec);margin-bottom:8px;line-height:1.55}
.sharing-panel .line strong{color:var(--text)}
.pending-user-list{display:flex;flex-direction:column;gap:10px}
.pending-user-card{border:1px solid var(--border);border-radius:12px;padding:12px;background:var(--bg)}
.pending-user-name{font-size:14px;font-weight:700;color:var(--text)}
.pending-user-meta{font-size:12px;color:var(--text-sec);margin-top:4px}
.pending-user-actions{display:flex;gap:8px;margin-top:10px}
/* ─── Admin Panel (Cyber) ─── */
@keyframes adminGlow{0%,100%{opacity:.6}50%{opacity:1}}
@keyframes adminPulse{0%{box-shadow:0 0 0 0 rgba(99,102,241,.4)}70%{box-shadow:0 0 0 8px rgba(99,102,241,0)}100%{box-shadow:0 0 0 0 rgba(99,102,241,0)}}
@keyframes adminScanline{0%{background-position:0 0}100%{background-position:0 100%}}
@keyframes adminSlideIn{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:translateY(0)}}
@keyframes adminCountUp{from{opacity:0;transform:translateY(8px) scale(.8)}to{opacity:1;transform:translateY(0) scale(1)}}
@keyframes pendingPulse{0%,100%{border-color:rgba(251,191,36,.3)}50%{border-color:rgba(251,191,36,.7)}}
@keyframes dotBreathe{0%,100%{transform:scale(1);opacity:.8}50%{transform:scale(1.3);opacity:1}}
.admin-header{position:relative;padding:32px 32px 24px;background:linear-gradient(135deg,rgba(99,102,241,.06) 0%,rgba(6,182,212,.04) 50%,rgba(139,92,246,.06) 100%);border:1px solid rgba(99,102,241,.15);border-radius:20px;margin-bottom:24px;overflow:hidden}
.admin-header::before{content:'';position:absolute;top:0;left:0;right:0;height:2px;background:linear-gradient(90deg,transparent,var(--pri),var(--cyan),var(--violet),transparent);animation:adminGlow 3s ease-in-out infinite}
.admin-header::after{content:'';position:absolute;inset:0;background:repeating-linear-gradient(0deg,transparent,transparent 2px,rgba(99,102,241,.015) 2px,rgba(99,102,241,.015) 4px);background-size:100% 8px;animation:adminScanline 8s linear infinite;pointer-events:none}
.admin-header-top{display:flex;justify-content:space-between;align-items:center;position:relative;z-index:1}
.admin-header h2{font-size:18px;font-weight:800;color:var(--text);display:flex;align-items:center;gap:12px;margin:0;letter-spacing:-.01em}
.admin-header h2 .ah-icon{width:40px;height:40px;border-radius:12px;background:linear-gradient(135deg,var(--pri),var(--violet));display:flex;align-items:center;justify-content:center;font-size:20px;box-shadow:0 4px 20px rgba(99,102,241,.3),inset 0 1px 0 rgba(255,255,255,.15);animation:adminPulse 2.5s infinite}
.admin-header-sub{font-size:11px;color:var(--text-muted);margin-top:6px;position:relative;z-index:1;letter-spacing:.02em}
.admin-stat-row{display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:10px;margin-top:20px;position:relative;z-index:1}
.admin-stat-box{position:relative;text-align:center;padding:18px 10px 16px;background:rgba(var(--bg-card-rgb,30,30,40),.6);backdrop-filter:blur(12px);border:1px solid rgba(99,102,241,.12);border-radius:14px;overflow:hidden;transition:all .25s cubic-bezier(.4,0,.2,1)}
.admin-stat-box:hover{border-color:rgba(99,102,241,.35);transform:translateY(-2px);box-shadow:0 8px 24px rgba(99,102,241,.12)}
.admin-stat-box::before{content:'';position:absolute;top:0;left:0;right:0;height:2px;opacity:.8}
.admin-stat-box:nth-child(1)::before{background:linear-gradient(90deg,transparent,#22c55e,transparent)}
.admin-stat-box:nth-child(2)::before{background:linear-gradient(90deg,transparent,#fbbf24,transparent)}
.admin-stat-box:nth-child(3)::before{background:linear-gradient(90deg,transparent,#8b5cf6,transparent)}
.admin-stat-box:nth-child(4)::before{background:linear-gradient(90deg,transparent,#06b6d4,transparent)}
.admin-stat-box:nth-child(5)::before{background:linear-gradient(90deg,transparent,#6366f1,transparent)}
.admin-stat-box:nth-child(6)::before{background:linear-gradient(90deg,transparent,#f43f5e,transparent)}
.admin-stat-box::after{content:'';position:absolute;inset:0;background:radial-gradient(circle at 50% 0%,rgba(99,102,241,.06),transparent 70%);pointer-events:none}
.admin-stat-box .as-icon{font-size:18px;margin-bottom:6px;display:block;filter:drop-shadow(0 2px 4px rgba(0,0,0,.15))}
.admin-stat-box .val{font-size:26px;font-weight:800;color:var(--text);font-variant-numeric:tabular-nums;animation:adminCountUp .4s ease-out;text-shadow:0 0 20px rgba(99,102,241,.15)}
.admin-stat-box .lbl{font-size:10px;color:var(--text-muted);margin-top:4px;letter-spacing:.05em;text-transform:uppercase}
.admin-tabs{display:flex;gap:3px;padding:3px;background:rgba(99,102,241,.03);border:1px solid rgba(99,102,241,.1);border-radius:14px;overflow-x:auto;-webkit-overflow-scrolling:touch;margin-bottom:24px;backdrop-filter:blur(8px)}
.admin-tab{position:relative;display:flex;align-items:center;gap:6px;padding:10px 18px;border:none;background:transparent;color:var(--text-muted);font-size:13px;font-weight:500;cursor:pointer;border-radius:11px;transition:all .25s cubic-bezier(.4,0,.2,1);white-space:nowrap;font-family:inherit}
.admin-tab:hover{background:rgba(99,102,241,.08);color:var(--text)}
.admin-tab.active{background:linear-gradient(135deg,rgba(99,102,241,.12),rgba(139,92,246,.08));color:var(--text);font-weight:600;box-shadow:0 2px 12px rgba(99,102,241,.1),inset 0 1px 0 rgba(255,255,255,.05);border:1px solid rgba(99,102,241,.15)}
.admin-tab .at-icon{font-size:14px;line-height:1}
.admin-tab .at-count{font-size:10px;font-weight:700;padding:2px 7px;border-radius:8px;background:rgba(99,102,241,.12);color:var(--pri);min-width:18px;text-align:center;transition:all .2s}
.admin-tab.active .at-count{background:rgba(99,102,241,.2);box-shadow:0 0 8px rgba(99,102,241,.15)}
.admin-panel{display:none}
.admin-panel.active{display:block;animation:adminSlideIn .3s ease-out}
.admin-card{border:1px solid var(--border);border-radius:14px;padding:18px 20px;background:var(--bg-card);margin-bottom:12px;transition:all .25s cubic-bezier(.4,0,.2,1);position:relative;overflow:hidden}
.admin-card-clickable{cursor:pointer}
.admin-card::before{content:'';position:absolute;top:0;left:0;bottom:0;width:3px;border-radius:3px 0 0 3px;background:var(--pri);opacity:.4;transition:opacity .2s}
.admin-card:hover{border-color:rgba(99,102,241,.25);box-shadow:0 4px 20px rgba(99,102,241,.06);transform:translateY(-1px)}
.admin-card:hover::before{opacity:.8}
.admin-card-header{display:flex;align-items:center;justify-content:space-between;margin-bottom:6px}
.admin-card-title{font-size:14px;font-weight:700;color:var(--text);flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.admin-card-meta{font-size:12px;color:var(--text-muted);line-height:1.5}
.au-contrib{display:flex;gap:20px;padding:12px 0;margin:8px 0;border-top:1px solid rgba(99,102,241,.08);border-bottom:1px solid rgba(99,102,241,.08)}
.au-contrib-item{font-size:12px;color:var(--text-sec);display:flex;align-items:center;gap:5px}
.au-contrib-num{font-size:20px;font-weight:800;line-height:1;font-variant-numeric:tabular-nums}
.au-info{display:flex;flex-wrap:wrap;gap:6px 16px;padding:8px 0;font-size:11px}
.au-info-item{color:var(--text-muted);white-space:nowrap;display:inline-flex;align-items:center;gap:3px}
.au-status-dot{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:5px;vertical-align:middle;flex-shrink:0;transition:all .3s}
.au-status-dot.online{background:#22c55e;box-shadow:0 0 8px rgba(34,197,94,.6),0 0 16px rgba(34,197,94,.2);animation:dotBreathe 2s ease-in-out infinite}
.au-status-dot.offline{background:#6b7280;box-shadow:none}
.au-status-text{font-size:10px;font-weight:600;letter-spacing:.04em;padding:3px 10px;border-radius:6px;white-space:nowrap}
.au-status-text.online{color:#22c55e;background:rgba(34,197,94,.08);border:1px solid rgba(34,197,94,.18);text-shadow:0 0 8px rgba(34,197,94,.2)}
.au-status-text.offline{color:#6b7280;background:rgba(107,114,128,.06);border:1px solid rgba(107,114,128,.1)}
[data-theme="light"] .au-status-text.online{background:rgba(34,197,94,.06);border-color:rgba(34,197,94,.15)}
[data-theme="light"] .au-status-text.offline{background:rgba(0,0,0,.03);border-color:rgba(0,0,0,.06)}
.au-group-header{font-size:13px;font-weight:700;color:var(--text-sec);margin:20px 0 10px;display:flex;align-items:center;gap:8px;letter-spacing:.02em}
.au-group-header:first-child{margin-top:0}
.au-group-header .au-group-dot{display:inline-block;width:8px;height:8px;border-radius:50%}
.au-group-header .au-group-dot.online{background:#22c55e;box-shadow:0 0 6px rgba(34,197,94,.5)}
.au-group-header .au-group-dot.offline{background:#6b7280}
.au-group-header .au-group-count{font-size:12px;font-weight:400;color:var(--text-muted)}
.au-card.au-offline{opacity:.55}
.au-card.au-offline:hover{opacity:.8}
.au-card.au-offline::before{background:#6b7280}
.au-card.au-online::before{background:#22c55e;box-shadow:0 0 8px rgba(34,197,94,.3)}
.admin-pending-section{position:relative;margin-bottom:20px;padding:20px;border-radius:16px;border:1px solid rgba(251,191,36,.25);background:linear-gradient(135deg,rgba(251,191,36,.04),rgba(245,158,11,.02));animation:pendingPulse 3s ease-in-out infinite;overflow:hidden}
.admin-pending-section::before{content:'';position:absolute;top:0;left:0;right:0;height:2px;background:linear-gradient(90deg,transparent,#fbbf24,#f59e0b,transparent)}
.admin-pending-section h3{font-size:14px;font-weight:700;color:#fbbf24;margin:0 0 14px;display:flex;align-items:center;gap:8px}
.admin-pending-section h3 .pending-count{display:inline-flex;align-items:center;justify-content:center;min-width:22px;height:22px;padding:0 6px;border-radius:11px;background:rgba(251,191,36,.2);font-size:12px;font-weight:800;color:#fbbf24}
.admin-pending-card{border:1px solid rgba(251,191,36,.15);border-radius:12px;padding:16px 18px;background:rgba(251,191,36,.03);margin-bottom:8px;transition:all .2s;position:relative;overflow:hidden}
.admin-pending-card::before{content:'';position:absolute;top:0;left:0;bottom:0;width:3px;background:linear-gradient(180deg,#fbbf24,#f59e0b);border-radius:3px 0 0 3px}
.admin-pending-card:hover{border-color:rgba(251,191,36,.35);box-shadow:0 4px 16px rgba(251,191,36,.08)}
.admin-pending-card .apc-name{font-size:14px;font-weight:700;color:var(--text)}
.admin-pending-card .apc-meta{font-size:11px;color:var(--text-muted);margin-top:4px;display:flex;align-items:center;gap:6px}
.admin-pending-card .apc-actions{display:flex;gap:8px;margin-top:12px}
.admin-pending-card .apc-actions .btn-approve{background:linear-gradient(135deg,#22c55e,#16a34a);color:#fff;border:none;padding:6px 18px;border-radius:8px;font-size:12px;font-weight:600;cursor:pointer;transition:all .2s;box-shadow:0 2px 8px rgba(34,197,94,.25)}
.admin-pending-card .apc-actions .btn-approve:hover{transform:translateY(-1px);box-shadow:0 4px 16px rgba(34,197,94,.35)}
.admin-pending-card .apc-actions .btn-reject{background:transparent;color:var(--rose);border:1px solid rgba(244,63,94,.2);padding:6px 14px;border-radius:8px;font-size:12px;font-weight:500;cursor:pointer;transition:all .2s}
.admin-pending-card .apc-actions .btn-reject:hover{background:rgba(244,63,94,.06);border-color:rgba(244,63,94,.4)}
.admin-card-tags{display:flex;gap:5px;margin:8px 0;align-items:center}
.admin-card-tags-left{display:flex;flex-wrap:wrap;gap:5px;align-items:center;flex:1;min-width:0}
.admin-card-tag{display:inline-flex;align-items:center;gap:3px;padding:3px 10px;border-radius:6px;font-size:11px;font-weight:600;letter-spacing:.01em}
.admin-card-tag.tag-role{background:rgba(99,102,241,.1);color:var(--pri)}
.admin-card-tag.tag-kind{background:rgba(245,158,11,.1);color:#f59e0b}
.admin-card-tag.tag-owner{background:rgba(34,197,94,.1);color:#22c55e}
.admin-card-tag.tag-status{background:rgba(6,182,212,.1);color:#06b6d4}
.admin-card-tag.tag-version{background:rgba(139,92,246,.1);color:#8b5cf6}
.admin-card-tag.tag-visibility{background:rgba(99,102,241,.08);color:var(--pri)}
.admin-card-tag.tag-group{background:rgba(139,92,246,.08);color:#8b5cf6}
.admin-card-preview{font-size:12px;color:var(--text-sec);line-height:1.5;margin:8px 0;padding:10px 12px;background:rgba(99,102,241,.02);border-radius:10px;border:1px solid rgba(99,102,241,.08);max-height:120px;overflow:hidden;white-space:pre-wrap;word-break:break-all;position:relative;-webkit-mask-image:linear-gradient(to bottom,#000 88%,transparent 100%);mask-image:linear-gradient(to bottom,#000 88%,transparent 100%)}
.admin-card-actions{display:inline-flex;gap:6px;margin-left:auto;align-items:center;flex-shrink:0}
.admin-card-time{font-size:11px;color:var(--text-muted)}
.admin-card-detail{display:none;margin-top:0;padding:20px 24px 24px;border-top:1px dashed rgba(99,102,241,.12);background:linear-gradient(180deg,rgba(99,102,241,.02) 0%,transparent 60%);animation:adminDetailIn .25s ease}
@keyframes adminDetailIn{from{opacity:0;transform:translateY(-6px)}to{opacity:1;transform:translateY(0)}}
.admin-card.expanded .admin-card-detail{display:block}
.admin-card.expanded{border-color:rgba(99,102,241,.3);box-shadow:0 4px 24px rgba(99,102,241,.1),0 0 0 1px rgba(99,102,241,.08)}
.admin-card-detail-meta{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:18px;font-size:12px;color:var(--text-muted)}
.admin-card-detail-meta .meta-item{display:inline-flex;align-items:center;gap:4px;padding:5px 12px;background:rgba(99,102,241,.03);border:1px solid rgba(99,102,241,.08);border-radius:20px;font-size:11px;color:var(--text-sec);transition:all .2s}
.admin-card-detail-meta .meta-item:hover{border-color:rgba(99,102,241,.25);background:rgba(99,102,241,.06)}
.admin-card-detail-section{margin-top:20px}
.admin-card-detail-section .detail-label{font-size:11px;font-weight:700;color:var(--pri);margin-bottom:12px;text-transform:uppercase;letter-spacing:.06em;display:flex;align-items:center;gap:8px}
.admin-card-detail-section .detail-label::before{content:'';width:3px;height:14px;border-radius:2px;background:linear-gradient(180deg,var(--pri),rgba(99,102,241,.3))}
.admin-card-detail-content{font-size:13px;line-height:1.75;color:var(--text-sec);white-space:pre-wrap;word-break:break-all;max-height:400px;overflow-y:auto;padding:16px 20px;background:var(--bg-card);border-radius:10px;border:1px solid var(--border);scrollbar-width:thin;scrollbar-color:rgba(99,102,241,.2) transparent}
.admin-card-detail-content::-webkit-scrollbar{width:5px}
.admin-card-detail-content::-webkit-scrollbar-thumb{background:rgba(99,102,241,.2);border-radius:4px}
.admin-card-detail-content::-webkit-scrollbar-track{background:transparent}
.admin-task-meta .meta-item .task-status-badge{border:none;padding:0;font-size:11px}
.admin-task-summary-body{font-size:13.5px;line-height:1.8;color:var(--text);padding:16px 20px;background:var(--bg-card);border-radius:10px;border:1px solid var(--border)}
.admin-task-summary-body .summary-section-title{font-size:12px;font-weight:700;color:var(--pri);margin:16px 0 6px;padding-bottom:5px;border-bottom:1px dashed var(--border)}
.admin-task-summary-body .summary-section-title:first-child{margin-top:0}
.admin-task-summary-body ul{margin:6px 0 12px;padding-left:18px}
.admin-task-summary-body li{margin:4px 0;color:var(--text-sec);line-height:1.7;font-size:13px}
.admin-task-summary-body p{margin:6px 0;font-size:13px;line-height:1.7}
.admin-task-chunks{display:flex;flex-direction:column;gap:0;padding:0;border:1px solid var(--border);border-radius:10px;overflow:hidden;background:var(--bg-card)}
.adm-msg{display:flex;gap:0;border-bottom:1px solid var(--border)}
.adm-msg:last-child{border-bottom:none}
.adm-msg-side{width:144px;flex-shrink:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:4px;padding:12px 10px;border-right:1px solid var(--border)}
.adm-msg-side.user{background:rgba(99,102,241,.04)}
.adm-msg-side.assistant{background:rgba(52,211,153,.04)}
.adm-msg-role{font-size:10px;font-weight:700;letter-spacing:.03em;text-transform:uppercase}
.adm-msg-side.user .adm-msg-role{color:var(--pri)}
.adm-msg-side.assistant .adm-msg-role{color:var(--green)}
.adm-msg-time{font-size:9px;color:var(--text-muted)}
.adm-msg-body{flex:1;min-width:0;padding:12px 16px;font-size:13px;line-height:1.75;color:var(--text);white-space:pre-wrap;word-break:break-word}
.adm-msg-body.collapsed{max-height:120px;overflow:hidden;-webkit-mask-image:linear-gradient(180deg,#000 88%,transparent);mask-image:linear-gradient(180deg,#000 88%,transparent)}
.adm-msg-toggle{display:none;padding:0 16px 8px;font-size:11px;color:var(--pri);cursor:pointer;transition:color .15s}
.adm-msg-toggle:hover{color:var(--pri-dark)}
.admin-card-expand-btn{font-size:12px;color:var(--pri);cursor:pointer;background:none;border:none;padding:2px 6px;font-family:inherit}
.admin-card-clickable{cursor:pointer}
.admin-toolbar{display:flex;align-items:center;gap:10px;margin-bottom:14px;flex-wrap:wrap}
.admin-toolbar h3{font-size:14px;font-weight:600;color:var(--text);white-space:nowrap;margin:0;margin-right:auto;line-height:32px}
.admin-toolbar select{box-sizing:border-box;height:32px;font-size:12px;border:1px solid var(--border);border-radius:8px;background:var(--bg-card);color:var(--text);vertical-align:middle;margin:0;padding:0 10px}
.admin-badge{display:inline-flex;align-items:center;gap:4px;font-size:9px;font-weight:700;padding:3px 10px;border-radius:6px;letter-spacing:.06em;text-transform:uppercase;position:relative;backdrop-filter:blur(4px);transition:all .25s}
.admin-badge.admin{background:linear-gradient(135deg,rgba(34,197,94,.12),rgba(16,185,129,.06));color:#22c55e;border:1px solid rgba(34,197,94,.2);box-shadow:0 0 12px rgba(34,197,94,.08),inset 0 1px 0 rgba(255,255,255,.05)}
.admin-badge.admin:hover{box-shadow:0 0 20px rgba(34,197,94,.15),inset 0 1px 0 rgba(255,255,255,.08)}
.admin-badge.member{background:rgba(99,102,241,.06);color:var(--text-muted);border:1px solid rgba(99,102,241,.12)}
.admin-badge.pending{background:linear-gradient(135deg,rgba(251,191,36,.12),rgba(245,158,11,.06));color:#fbbf24;border:1px solid rgba(251,191,36,.2);box-shadow:0 0 12px rgba(251,191,36,.08)}
.admin-badge.public{background:rgba(99,102,241,.08);color:var(--pri);border:1px solid rgba(99,102,241,.15)}
.admin-badge.group{background:rgba(139,92,246,.08);color:#8b5cf6;border:1px solid rgba(139,92,246,.15)}
.admin-badge.owner{background:linear-gradient(135deg,rgba(251,191,36,.12),rgba(245,158,11,.08));color:#f59e0b;border:1px solid rgba(251,191,36,.25);box-shadow:0 0 12px rgba(251,191,36,.1),inset 0 1px 0 rgba(255,255,255,.06)}
.au-badges{display:flex;align-items:center;gap:6px;flex-shrink:0;flex-wrap:wrap;justify-content:flex-end}
.admin-empty{font-size:13px;color:var(--text-muted);padding:48px 24px;text-align:center;border:1px dashed rgba(99,102,241,.15);border-radius:16px;background:rgba(99,102,241,.02)}
.admin-empty .ae-icon{font-size:32px;display:block;margin-bottom:10px;opacity:.4}
[data-theme="light"] .admin-badge.admin{background:rgba(5,150,105,.08);color:#059669;border-color:rgba(5,150,105,.18)}
[data-theme="light"] .admin-badge.member{background:rgba(0,0,0,.04);color:#6b7280;border-color:rgba(0,0,0,.08)}
[data-theme="light"] .admin-badge.pending{background:rgba(245,158,11,.08);color:#d97706;border-color:rgba(245,158,11,.18)}
[data-theme="light"] .admin-badge.owner{background:rgba(245,158,11,.08);color:#b45309;border-color:rgba(245,158,11,.2)}
[data-theme="light"] .admin-header{background:linear-gradient(135deg,rgba(99,102,241,.04) 0%,rgba(6,182,212,.03) 50%,rgba(139,92,246,.04) 100%)}
[data-theme="light"] .admin-stat-box{background:rgba(255,255,255,.8)}
[data-theme="light"] .admin-pending-section{background:linear-gradient(135deg,rgba(251,191,36,.03),rgba(245,158,11,.015))}
.confirm-overlay{display:none;position:fixed;inset:0;align-items:center;justify-content:center;background:rgba(0,0,0,.45);backdrop-filter:blur(4px);z-index:9999;padding:20px}
.confirm-overlay.show{display:flex}
.confirm-panel{width:min(400px,90vw);background:var(--bg-card);border:1px solid var(--border);border-radius:16px;box-shadow:0 20px 60px rgba(0,0,0,.2);overflow:hidden;animation:confirmIn .2s ease}
@keyframes confirmIn{from{opacity:0;transform:scale(.95) translateY(8px)}to{opacity:1;transform:scale(1) translateY(0)}}
.confirm-panel-header{padding:20px 24px 0;font-size:15px;font-weight:700;color:var(--text)}
.confirm-panel-body{padding:14px 24px 20px;font-size:13px;line-height:1.65;color:var(--text-sec);white-space:pre-wrap;word-break:break-word}
.confirm-panel-footer{display:flex;justify-content:flex-end;gap:10px;padding:0 24px 20px}
.confirm-panel-footer .btn-confirm-cancel{padding:8px 20px;border:1px solid var(--border);border-radius:10px;background:var(--bg);color:var(--text-sec);font-size:13px;font-weight:500;cursor:pointer;transition:all .15s;font-family:inherit}
.confirm-panel-footer .btn-confirm-cancel:hover{background:var(--bg-card);border-color:var(--text-muted)}
.confirm-panel-footer .btn-confirm-ok{padding:8px 20px;border:none;border-radius:10px;background:var(--pri);color:#fff;font-size:13px;font-weight:600;cursor:pointer;transition:all .15s;font-family:inherit}
.confirm-panel-footer .btn-confirm-ok:hover{opacity:.9;box-shadow:0 2px 8px rgba(99,102,241,.3)}
.confirm-panel-footer .btn-confirm-ok.danger{background:var(--rose)}
.confirm-panel-footer .btn-confirm-ok.danger:hover{box-shadow:0 2px 8px rgba(244,63,94,.3)}
.task-detail-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.shared-memory-overlay,.shared-memory-overlay.show{display:none}
.shared-memory-overlay.show{display:flex;position:fixed;inset:0;align-items:center;justify-content:center;background:rgba(0,0,0,.55);z-index:1200;padding:24px}
.shared-memory-panel{width:min(860px,95vw);max-height:85vh;overflow:auto;border:1px solid var(--border);border-radius:18px;background:var(--bg-card);box-shadow:var(--shadow-lg);padding:20px}
.shared-memory-panel h3{font-size:18px;color:var(--text);margin-bottom:10px}
.shared-memory-panel .content{font-size:13px;color:var(--text-sec);line-height:1.7;white-space:pre-wrap;background:var(--bg);border:1px solid var(--border);border-radius:12px;padding:14px;margin-top:12px}
.hub-source-badge{display:inline-flex;align-items:center;gap:6px;padding:4px 8px;border-radius:999px;background:rgba(34,197,94,.12);color:var(--green);font-size:11px;font-weight:700;border:1px solid rgba(34,197,94,.22)}
@media (max-width: 960px){.sharing-settings-grid{grid-template-columns:1fr}.search-bar{flex-wrap:wrap}.scope-select{width:100%}.task-detail-actions{width:100%;justify-content:flex-start}}

.filter-bar{display:flex;gap:8px;margin-bottom:12px;flex-wrap:wrap;align-items:center}
.filter-chip{padding:5px 14px;border:1px solid var(--border);border-radius:8px;background:transparent;color:var(--text-sec);font-size:12px;font-weight:500;cursor:pointer;transition:all .15s}
.filter-chip:hover{border-color:var(--pri);color:var(--pri);background:rgba(99,102,241,.04)}
.filter-chip.active{background:rgba(99,102,241,.1);color:var(--pri);border-color:rgba(99,102,241,.3);font-weight:600}

.memory-list{display:flex;flex-direction:column;gap:10px}
.memory-card{background:var(--bg-card);border:1px solid var(--border);border-radius:var(--radius);padding:16px 20px;transition:all .2s}
.memory-card:hover{border-color:var(--border-glow);background:var(--bg-card-hover)}
.memory-card .card-header{display:flex;align-items:center;justify-content:space-between;margin-bottom:12px;flex-wrap:wrap;gap:8px}
.memory-card .meta{display:flex;align-items:center;gap:8px}
.role-tag{padding:4px 10px;border-radius:8px;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.03em}
.role-tag.user{background:var(--pri-glow);color:var(--pri);border:1px solid rgba(99,102,241,.12)}
.role-tag.assistant{background:var(--accent-glow);color:var(--accent);border:1px solid rgba(230,57,70,.2)}
.role-tag.system{background:var(--amber-bg);color:var(--amber);border:1px solid rgba(245,158,11,.2)}
.card-time{font-size:12px;color:var(--text-sec);display:flex;align-items:center;gap:8px}
.session-tag{font-size:11px;font-family:ui-monospace,monospace;color:var(--text-muted);background:rgba(0,0,0,.2);padding:3px 8px;border-radius:6px;cursor:pointer}
.session-tag:hover{filter:brightness(1.12)}
.owner-tag{font-size:11px;font-weight:600;color:var(--pri);background:var(--pri-glow);padding:3px 9px;border-radius:8px;border:1px solid rgba(99,102,241,.15);cursor:default;white-space:nowrap}
.card-summary{font-size:15px;font-weight:600;color:var(--text);margin-bottom:10px;line-height:1.5;letter-spacing:-.01em;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.card-content{font-size:13px;color:var(--text-sec);line-height:1.65;max-height:0;overflow:hidden;transition:max-height .3s ease}
.card-content.show{max-height:600px;overflow-y:auto}
.card-content pre{white-space:pre-wrap;word-break:break-all;background:rgba(0,0,0,.25);padding:14px;border-radius:10px;font-size:12px;font-family:ui-monospace,monospace;margin-top:10px;border:1px solid var(--border);color:var(--text-sec)}
.card-actions{display:flex;align-items:center;gap:8px;margin-top:14px}
.card-actions-inline{display:inline-flex;align-items:center;gap:4px;margin-left:auto;flex-shrink:0}
.btn-warn{color:#f59e0b !important}
.btn-warn:hover{background:rgba(245,158,11,.15) !important}
.btn-danger{color:#ef4444 !important}
.btn-danger:hover{background:rgba(239,68,68,.15) !important}
.btn-success{color:#10b981 !important}
.btn-success:hover{background:rgba(16,185,129,.15) !important}
.skill-card.archived{opacity:0.55;border-style:dashed}
.vscore-badge{display:inline-flex;align-items:center;background:rgba(59,130,246,.15);color:#60a5fa;font-size:10px;font-weight:700;padding:4px 10px;border-radius:8px;margin-left:auto}
.merge-badge{display:inline-flex;align-items:center;gap:4px;background:rgba(16,185,129,.12);color:#10b981;font-size:10px;font-weight:600;padding:3px 10px;border-radius:8px}
.merge-history{margin-top:12px;padding:12px 14px;background:rgba(0,0,0,.15);border-radius:10px;border:1px solid var(--border);font-size:12px;line-height:1.7;color:var(--text-sec);max-height:200px;overflow-y:auto}
.merge-history-item{padding:6px 0;border-bottom:1px dashed rgba(255,255,255,.06)}
.merge-history-item:last-child{border-bottom:none}
.merge-action{font-weight:600;font-size:11px;padding:2px 6px;border-radius:4px}
.merge-action.UPDATE{background:rgba(59,130,246,.15);color:#60a5fa}
.merge-action.DUPLICATE{background:rgba(245,158,11,.15);color:#f59e0b}
.card-updated{font-size:11px;color:var(--text-muted);margin-left:6px}
.dedup-badge{display:inline-flex;align-items:center;gap:4px;font-size:10px;font-weight:600;padding:3px 10px;border-radius:8px}
.dedup-badge.duplicate{background:rgba(245,158,11,.12);color:#f59e0b}
.dedup-badge.merged{background:rgba(59,130,246,.12);color:#60a5fa}
.import-badge{display:inline-flex;align-items:center;gap:4px;background:rgba(236,72,153,.1);color:#ec4899;font-size:10px;font-weight:600;padding:3px 10px;border-radius:8px}
[data-theme="light"] .import-badge{background:rgba(219,39,119,.08);color:#db2777}
.owner-badge{display:inline-flex;align-items:center;gap:3px;font-size:10px;font-weight:600;padding:3px 10px;border-radius:8px}
.owner-badge.public{background:rgba(52,211,153,.12);color:#34d399}
.owner-badge.agent{background:rgba(255,255,255,.06);color:var(--text-sec)}
[data-theme="light"] .owner-badge.public{background:rgba(16,185,129,.08);color:#059669}
[data-theme="light"] .owner-badge.agent{background:rgba(0,0,0,.04);color:var(--text-sec)}
.skill-badge.visibility-public{background:rgba(0,229,255,.12);color:#00bcd4}
[data-theme="light"] .skill-badge.visibility-public{background:rgba(0,172,193,.08);color:#00838f}
.memory-card.dedup-inactive{opacity:.55;border-style:dashed}
.memory-card.dedup-inactive:hover{opacity:.85}
.dedup-target-link{font-size:11px;color:var(--pri);cursor:pointer;text-decoration:underline;margin-left:4px}
.memory-modal-overlay{position:fixed;inset:0;background:rgba(5,8,16,.75);z-index:9999;display:none;align-items:center;justify-content:center;backdrop-filter:blur(12px) saturate(1.2)}
.memory-modal-overlay.show{display:flex}
[data-theme="light"] .memory-modal-overlay{background:rgba(0,0,0,.45)}
.memory-modal{position:relative;background:linear-gradient(160deg,#0d1117 0%,#161b22 50%,#0d1117 100%);border:1px solid rgba(99,102,241,.2);border-radius:20px;width:min(600px,92vw);max-height:82vh;display:flex;flex-direction:column;box-shadow:0 32px 100px rgba(0,0,0,.6),0 0 60px rgba(99,102,241,.08),inset 0 1px 0 rgba(255,255,255,.06);animation:mmSlideIn .35s cubic-bezier(.22,1,.36,1);overflow:hidden}
[data-theme="light"] .memory-modal{background:linear-gradient(160deg,#ffffff 0%,#f8f9fc 50%,#ffffff 100%);border-color:rgba(99,102,241,.15);box-shadow:0 32px 100px rgba(0,0,0,.12),0 0 40px rgba(99,102,241,.06)}
@keyframes mmSlideIn{from{opacity:0;transform:scale(.92) translateY(20px)}to{opacity:1;transform:scale(1) translateY(0)}}
.memory-modal::before{content:'';position:absolute;top:0;left:0;right:0;height:3px;background:linear-gradient(90deg,#6366f1,#8b5cf6,#ec4899,#f43f5e,#6366f1);background-size:200% 100%;animation:mmGradientMove 3s linear infinite;border-radius:20px 20px 0 0;z-index:1}
@keyframes mmGradientMove{0%{background-position:0% 50%}100%{background-position:200% 50%}}
.memory-modal::after{content:'';position:absolute;inset:0;background:radial-gradient(ellipse at 20% 0%,rgba(99,102,241,.06) 0%,transparent 60%),radial-gradient(ellipse at 80% 100%,rgba(236,72,153,.04) 0%,transparent 60%);pointer-events:none;border-radius:20px}
[data-theme="light"] .memory-modal::after{background:radial-gradient(ellipse at 20% 0%,rgba(99,102,241,.04) 0%,transparent 60%),radial-gradient(ellipse at 80% 100%,rgba(236,72,153,.03) 0%,transparent 60%)}
.memory-modal-title{position:relative;z-index:2;display:flex;align-items:center;justify-content:space-between;padding:18px 24px 14px;font-size:12px;font-weight:700;color:var(--text-sec);letter-spacing:.06em;text-transform:uppercase}
.memory-modal-title .mm-tl{display:flex;align-items:center;gap:8px}
.memory-modal-title .mm-tl-icon{width:28px;height:28px;border-radius:8px;background:linear-gradient(135deg,rgba(99,102,241,.15),rgba(139,92,246,.1));display:flex;align-items:center;justify-content:center;font-size:14px;border:1px solid rgba(99,102,241,.2)}
[data-theme="light"] .memory-modal-title .mm-tl-icon{background:linear-gradient(135deg,rgba(99,102,241,.1),rgba(139,92,246,.06));border-color:rgba(99,102,241,.12)}
.memory-modal-title .mm-close{width:30px;height:30px;display:flex;align-items:center;justify-content:center;border-radius:10px;border:1px solid rgba(255,255,255,.06);background:rgba(255,255,255,.04);color:var(--text-sec);cursor:pointer;font-size:16px;transition:all .2s}
.memory-modal-title .mm-close:hover{background:rgba(255,77,77,.12);border-color:rgba(255,77,77,.2);color:#f87171;transform:rotate(90deg)}
[data-theme="light"] .memory-modal-title .mm-close{border-color:rgba(0,0,0,.06);background:rgba(0,0,0,.03)}
[data-theme="light"] .memory-modal-title .mm-close:hover{background:rgba(255,77,77,.08);border-color:rgba(255,77,77,.15)}
.memory-modal-body{position:relative;z-index:2;padding:0;overflow-y:auto;flex:1}
.mm-hero{padding:0 24px 20px}
.mm-hero-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:14px}
.mm-role-chip{display:inline-flex;align-items:center;gap:5px;font-size:10px;font-weight:700;letter-spacing:.05em;text-transform:uppercase;padding:4px 12px;border-radius:20px;background:linear-gradient(135deg,rgba(99,102,241,.15),rgba(139,92,246,.1));color:#a5b4fc;border:1px solid rgba(99,102,241,.2)}
.mm-role-chip.user{background:linear-gradient(135deg,rgba(16,185,129,.15),rgba(52,211,153,.1));color:#6ee7b7;border-color:rgba(16,185,129,.2)}
.mm-role-chip.assistant{background:linear-gradient(135deg,rgba(99,102,241,.15),rgba(139,92,246,.1));color:#a5b4fc;border-color:rgba(99,102,241,.2)}
.mm-role-chip.system{background:linear-gradient(135deg,rgba(251,191,36,.15),rgba(245,158,11,.1));color:#fcd34d;border-color:rgba(251,191,36,.2)}
[data-theme="light"] .mm-role-chip{color:#6366f1}
[data-theme="light"] .mm-role-chip.user{color:#059669}
[data-theme="light"] .mm-role-chip.assistant{color:#6366f1}
[data-theme="light"] .mm-role-chip.system{color:#d97706}
.mm-dedup-chip{display:inline-flex;align-items:center;gap:4px;font-size:10px;font-weight:600;padding:3px 10px;border-radius:20px;text-transform:uppercase;letter-spacing:.04em}
.mm-dedup-chip.duplicate{background:rgba(239,68,68,.12);color:#fca5a5;border:1px solid rgba(239,68,68,.2)}
.mm-dedup-chip.merged{background:rgba(251,191,36,.12);color:#fcd34d;border:1px solid rgba(251,191,36,.2)}
[data-theme="light"] .mm-dedup-chip.duplicate{color:#dc2626}
[data-theme="light"] .mm-dedup-chip.merged{color:#d97706}
.mm-id{font-family:'SF Mono',Consolas,'Courier New',monospace;font-size:10px;color:var(--text-muted);background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.06);padding:3px 10px;border-radius:20px;cursor:pointer;transition:all .2s;display:inline-flex;align-items:center;gap:4px}
.mm-id::before{content:'\u{1F517}';font-size:9px}
.mm-id:hover{background:rgba(99,102,241,.12);border-color:rgba(99,102,241,.25);color:var(--text)}
[data-theme="light"] .mm-id{background:rgba(0,0,0,.03);border-color:rgba(0,0,0,.06)}
[data-theme="light"] .mm-id:hover{background:rgba(99,102,241,.08);border-color:rgba(99,102,241,.15)}
.mm-summary{font-size:15px;font-weight:600;color:var(--text);line-height:1.6;letter-spacing:-.01em;padding:16px 20px;background:rgba(255,255,255,.02);border-radius:12px;border:1px solid rgba(255,255,255,.04);position:relative}
.mm-summary::before{content:'';position:absolute;left:0;top:12px;bottom:12px;width:3px;border-radius:2px;background:linear-gradient(180deg,#6366f1,#8b5cf6)}
[data-theme="light"] .mm-summary{background:rgba(99,102,241,.02);border-color:rgba(99,102,241,.06)}
.mm-section{padding:0 24px 16px}
.mm-section-label{font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.08em;color:var(--text-muted);margin-bottom:8px;display:flex;align-items:center;gap:6px}
.mm-section-label::before{content:'';width:6px;height:6px;border-radius:50%;background:linear-gradient(135deg,#6366f1,#8b5cf6);flex-shrink:0}
.mm-content{font-family:'SF Mono',Consolas,'Courier New',monospace;font-size:12px;line-height:1.75;color:var(--text);white-space:pre-wrap;word-break:break-all;background:rgba(0,0,0,.3);border-radius:12px;padding:16px 18px;max-height:240px;overflow-y:auto;margin:0;border:1px solid rgba(255,255,255,.04);position:relative}
[data-theme="light"] .mm-content{background:rgba(0,0,0,.03);border-color:rgba(0,0,0,.06)}
.mm-meta{display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:8px;padding:16px 24px;border-top:1px solid rgba(255,255,255,.04);background:rgba(0,0,0,.1)}
[data-theme="light"] .mm-meta{border-top-color:rgba(0,0,0,.04);background:rgba(0,0,0,.015)}
.mm-meta-chip{display:flex;flex-direction:column;gap:3px;font-size:11px;color:var(--text-sec);background:rgba(255,255,255,.03);border:1px solid rgba(255,255,255,.04);padding:10px 12px;border-radius:10px;transition:all .2s}
.mm-meta-chip:hover{background:rgba(255,255,255,.06);border-color:rgba(99,102,241,.15)}
[data-theme="light"] .mm-meta-chip{background:rgba(0,0,0,.02);border-color:rgba(0,0,0,.04)}
[data-theme="light"] .mm-meta-chip:hover{background:rgba(99,102,241,.04);border-color:rgba(99,102,241,.1)}
.mm-meta-chip strong{color:var(--text-muted);font-weight:600;font-size:9px;text-transform:uppercase;letter-spacing:.06em}
.mm-meta-chip span{color:var(--text);font-weight:500;font-size:12px;word-break:break-all}
.mm-dedup{padding:0 24px 16px}
.mm-dedup-box{background:linear-gradient(135deg,rgba(251,191,36,.06),rgba(245,158,11,.03));border:1px solid rgba(251,191,36,.12);border-radius:12px;padding:14px 16px;font-size:12px;color:var(--text-sec);line-height:1.6;display:flex;align-items:flex-start;gap:8px}
.mm-dedup-box::before{content:'\u26A0\uFE0F';flex-shrink:0;font-size:14px}
.mm-footer{padding:12px 24px 16px;display:flex;align-items:center;justify-content:center}
.mm-footer .dedup-target-link{font-size:11px;color:#818cf8;cursor:pointer;padding:6px 16px;border-radius:8px;border:1px solid rgba(99,102,241,.2);background:rgba(99,102,241,.06);transition:all .2s;font-weight:500}
.mm-footer .dedup-target-link:hover{background:rgba(99,102,241,.12);border-color:rgba(99,102,241,.3)}
[data-theme="light"] .merge-history{background:rgba(0,0,0,.04)}
[data-theme="light"] .merge-history-item{border-bottom-color:rgba(0,0,0,.06)}
.card-merged-info{margin-top:8px;padding:8px 12px;background:rgba(16,185,129,.06);border:1px dashed rgba(16,185,129,.2);border-radius:8px;font-size:12px;line-height:1.6;color:var(--text-sec)}
.card-merged-label{font-size:10px;font-weight:600;color:#10b981;margin-bottom:4px;display:flex;align-items:center;gap:4px}
[data-theme="light"] .card-merged-info{background:rgba(16,185,129,.04);border-color:rgba(16,185,129,.15)}

/* ─── Buttons ─── */
.btn{padding:7px 14px;border-radius:8px;border:1px solid var(--border);background:var(--bg-card);color:var(--text);font-size:13px;font-weight:500;transition:all .18s ease;display:inline-flex;align-items:center;gap:5px;white-space:nowrap}
.btn:hover{border-color:var(--pri);color:var(--pri)}
.btn-primary{background:rgba(255,255,255,.08);color:var(--text);border:1px solid var(--border);font-weight:600}
.btn-primary:hover{background:rgba(255,255,255,.14);transform:translateY(-1px);border-color:var(--pri);color:var(--pri)}
.btn-ghost{border-color:transparent;background:transparent;color:var(--text-sec)}
.btn-ghost:hover{background:rgba(255,255,255,.06);color:var(--text)}
.btn-danger{color:var(--accent);border-color:rgba(230,57,70,.25)}
.btn-danger:hover{background:rgba(230,57,70,.1);color:var(--accent)}
.btn-sm{padding:5px 12px;font-size:12px}
.btn-icon{padding:5px 7px;font-size:15px;border-radius:8px}
.btn-text{border:none;background:none;color:var(--text-muted);font-size:12px;padding:4px 8px}
.btn-text:hover{color:var(--pri)}
[data-theme="light"] .btn-primary{background:rgba(0,0,0,.05);color:var(--text);border-color:rgba(0,0,0,.12)}
[data-theme="light"] .btn-primary:hover{background:rgba(0,0,0,.08);border-color:var(--pri);color:var(--pri)}
[data-theme="light"] .btn-ghost{color:var(--text-sec)}
[data-theme="light"] .btn-ghost:hover{background:rgba(0,0,0,.04);color:var(--text)}

/* ─── Modal ─── */
.modal-overlay{display:none;position:fixed;inset:0;background:rgba(0,0,0,.6);z-index:500;align-items:center;justify-content:center;backdrop-filter:blur(8px)}
.modal-overlay.show{display:flex}
.modal{background:var(--bg);border:1px solid var(--border);border-radius:var(--radius-xl);padding:32px;width:100%;max-width:520px;box-shadow:var(--shadow-lg);max-height:85vh;overflow-y:auto}
.modal h2{font-size:20px;font-weight:700;margin-bottom:24px;color:var(--text);letter-spacing:-.02em}
.form-group{margin-bottom:18px}
.form-group label{display:block;font-size:13px;font-weight:600;color:var(--text-sec);margin-bottom:6px}
.form-group input,.form-group textarea,.form-group select{width:100%;padding:10px 14px;border:1px solid var(--border);border-radius:10px;font-size:14px;outline:none;transition:all .2s;background:var(--bg-card);color:var(--text)}
.form-group input::placeholder,.form-group textarea::placeholder{color:var(--text-muted)}
.form-group input:focus,.form-group textarea:focus,.form-group select:focus{border-color:var(--pri);box-shadow:0 0 0 3px var(--pri-glow)}
.form-group textarea{min-height:100px;resize:vertical}
.modal-actions{display:flex;gap:10px;justify-content:flex-end;margin-top:28px}


/* ─── Toast ─── */
.emb-banner{display:flex;align-items:center;gap:10px;padding:12px 20px;font-size:13px;font-weight:500;border-radius:10px;margin:0 32px 0;animation:slideIn .3s ease}
.emb-banner.warning{background:rgba(245,158,11,.1);color:#d97706;border:1px solid rgba(245,158,11,.25)}
.emb-banner.error{background:rgba(239,68,68,.1);color:#ef4444;border:1px solid rgba(239,68,68,.25)}
[data-theme="light"] .emb-banner.warning{background:rgba(245,158,11,.08);color:#b45309}
[data-theme="light"] .emb-banner.error{background:rgba(239,68,68,.08);color:#dc2626}
.emb-banner span{flex:1}
.emb-banner-btn{background:none;border:1px solid currentColor;border-radius:6px;padding:4px 12px;font-size:12px;font-weight:600;color:inherit;cursor:pointer;white-space:nowrap;opacity:.85;transition:opacity .15s}
.emb-banner-btn:hover{opacity:1}
.emb-banner-close{background:none;border:none;font-size:18px;color:inherit;cursor:pointer;opacity:.5;padding:0 4px;line-height:1}
.emb-banner-close:hover{opacity:1}
.toast-container{position:fixed;top:80px;right:24px;z-index:1000;display:flex;flex-direction:column;gap:8px}
.toast{padding:14px 20px;border-radius:10px;font-size:13px;font-weight:500;box-shadow:var(--shadow-lg);animation:slideIn .3s ease;display:flex;align-items:center;gap:10px;max-width:360px;border:1px solid}
.toast.success{background:var(--green-bg);color:var(--green);border-color:rgba(16,185,129,.3)}
.toast.error{background:var(--rose-bg);color:var(--rose);border-color:rgba(244,63,94,.3)}
.toast.info{background:var(--pri-glow);color:var(--pri);border-color:rgba(99,102,241,.15)}
.toast.warn{background:rgba(245,158,11,.1);color:#f59e0b;border-color:rgba(245,158,11,.3)}
@keyframes slideIn{from{transform:translateX(100px);opacity:0}to{transform:translateX(0);opacity:1}}

.notif-bell{position:relative;cursor:pointer;font-size:16px;padding:5px 7px;border-radius:8px;background:none;border:1px solid transparent;color:var(--text-sec);transition:all .2s}
.notif-bell:hover{background:var(--bg-card-hover);color:var(--text)}
.notif-bell .notif-badge{position:absolute;top:1px;right:1px;min-width:16px;height:16px;line-height:16px;text-align:center;font-size:10px;font-weight:700;color:#fff;background:var(--rose);border-radius:8px;padding:0 4px;display:none;pointer-events:none}
.notif-bell .notif-badge.show{display:block;animation:notifPop .3s ease}
@keyframes notifPop{0%{transform:scale(0)}60%{transform:scale(1.2)}100%{transform:scale(1)}}
.notif-panel{position:absolute;top:calc(100% + 8px);right:0;width:380px;max-height:440px;background:var(--bg);border:1px solid var(--border);border-radius:var(--radius-lg);box-shadow:var(--shadow-lg);z-index:200;display:none;flex-direction:column;overflow:hidden;backdrop-filter:blur(16px)}
.notif-panel.show{display:flex;animation:notifSlide .2s ease}
@keyframes notifSlide{from{opacity:0;transform:translateY(-8px)}to{opacity:1;transform:translateY(0)}}
.notif-panel-header{display:flex;align-items:center;justify-content:space-between;padding:12px 16px;border-bottom:1px solid var(--border);font-size:13px;font-weight:600;color:var(--text)}
.notif-panel-header .notif-mark-all{font-size:11px;font-weight:500;color:var(--pri);cursor:pointer;background:none;border:none;padding:4px 8px;border-radius:6px;transition:background .15s}
.notif-panel-header .notif-mark-all:hover{background:var(--pri-glow)}
.notif-panel-body{overflow-y:auto;flex:1;max-height:380px}
.notif-item{display:flex;gap:10px;padding:12px 16px;border-bottom:1px solid var(--border);cursor:pointer;transition:background .15s;align-items:flex-start}
.notif-item:last-child{border-bottom:none}
.notif-item:hover{background:var(--bg-card-hover)}
.notif-item.unread{background:rgba(99,102,241,.04)}
.notif-item-icon{font-size:18px;flex-shrink:0;width:28px;height:28px;display:flex;align-items:center;justify-content:center;border-radius:8px;background:rgba(244,63,94,.08)}
.notif-item-body{flex:1;min-width:0}
.notif-item-title{font-size:12px;color:var(--text-sec);margin-bottom:2px}
.notif-item-name{font-size:13px;font-weight:600;color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.notif-item-time{font-size:11px;color:var(--text-muted);margin-top:2px}
.notif-item-dot{flex-shrink:0;width:8px;height:8px;border-radius:50%;background:var(--pri);margin-top:6px;display:none}
.notif-item.unread .notif-item-dot{display:block}
.notif-empty{text-align:center;padding:32px 16px;color:var(--text-muted);font-size:13px}
[data-theme="light"] .notif-panel{background:rgba(255,255,255,.96)}
[data-theme="light"] .notif-item.unread{background:rgba(99,102,241,.06)}

.empty{text-align:center;padding:64px 20px;color:var(--text-sec)}
.empty .icon{font-size:52px;margin-bottom:16px;opacity:.5}
.empty p{font-size:15px;font-weight:500}

.spinner{width:40px;height:40px;border:3px solid var(--border);border-top-color:var(--pri);border-radius:50%;animation:spin .8s linear infinite;margin:48px auto}
@keyframes spin{to{transform:rotate(360deg)}}

::-webkit-scrollbar{width:6px;height:6px}
::-webkit-scrollbar-track{background:transparent}
::-webkit-scrollbar-thumb{background:rgba(255,255,255,.15);border-radius:3px}
::-webkit-scrollbar-thumb:hover{background:rgba(255,255,255,.25)}

.filter-sep{width:1px;height:20px;background:var(--border);margin:0 2px}
.filter-select{padding:5px 14px;border:1px solid var(--border);border-radius:8px;background:transparent;color:var(--text-sec);font-size:12px;font-weight:500;outline:none;cursor:pointer;transition:all .15s;-webkit-appearance:none;appearance:none;background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6'%3E%3Cpath d='M0 0l5 6 5-6z' fill='%236b7280'/%3E%3C/svg%3E");background-repeat:no-repeat;background-position:right 10px center;padding-right:28px}
.filter-select:hover{border-color:var(--pri);color:var(--pri)}
.filter-select:focus{border-color:var(--pri);color:var(--pri);background-color:rgba(99,102,241,.04)}
.date-filter{display:flex;align-items:center;gap:10px;margin-bottom:18px;font-size:13px;color:var(--text-sec)}
.date-filter input[type="datetime-local"]{padding:5px 12px;border:1px solid var(--border);border-radius:8px;font-size:12px;outline:none;background:transparent;color:var(--text-sec);transition:all .15s}
.date-filter input[type="datetime-local"]:focus{border-color:var(--pri)}
.date-filter label{font-weight:500}
.compact-filter-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.compact-date{padding:5px 12px;border:1px solid var(--border);border-radius:8px;font-size:12px;font-weight:500;outline:none;background:transparent;color:var(--text-sec);max-width:180px;transition:all .15s}
.compact-date:hover{border-color:var(--pri);color:var(--pri)}
.compact-date:focus{border-color:var(--pri);color:var(--pri);background:rgba(99,102,241,.04)}

.pagination-row{display:flex;align-items:center;justify-content:center;gap:10px;flex-wrap:wrap;padding:16px 0 8px}
.pagination{display:flex;align-items:center;justify-content:center;gap:4px;padding:0;flex-wrap:wrap}
.pagination .pg-btn{min-width:32px;height:32px;display:flex;align-items:center;justify-content:center;border:1px solid transparent;border-radius:8px;background:transparent;color:var(--text-sec);font-size:12px;font-weight:500;cursor:pointer;transition:all .15s}
.pagination .pg-btn:hover{background:rgba(99,102,241,.06);color:var(--pri);border-color:rgba(99,102,241,.15)}
.pagination .pg-btn.active{background:var(--pri-grad);color:#fff;border-color:transparent;box-shadow:0 2px 8px rgba(99,102,241,.3)}
.pagination .pg-btn.disabled{opacity:.3;pointer-events:none}
.pagination .pg-info{font-size:11px;color:var(--text-muted);padding:0 8px}

/* ─── Tasks 视图 ─── */
.view-container{flex:1;min-width:0}
.view-container>.vp{display:none;flex-direction:column}
.view-container>.vp.show{display:flex}
.tasks-view{flex:1;min-width:0;flex-direction:column}
.tasks-header{display:flex;flex-direction:column;gap:0}
.tasks-stats{display:flex;gap:10px}
.tasks-stat{display:flex;align-items:center;gap:8px;background:var(--bg-card);border:1px solid var(--border);border-radius:var(--radius);padding:10px 16px;flex:1;transition:all .2s;position:relative;overflow:hidden}
.tasks-stat::before{content:'';position:absolute;top:0;left:0;bottom:0;width:3px;border-radius:3px 0 0 3px}
.tasks-stat:hover{border-color:var(--border-glow)}
.tasks-stat-value{font-size:18px;font-weight:700;color:var(--text)}
.tasks-stat-label{font-size:11px;color:var(--text-sec);font-weight:500}
.tasks-filters{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.tasks-list{display:flex;flex-direction:column;gap:10px}
.task-card{background:var(--bg-card);border:1px solid var(--border);border-radius:var(--radius-lg);padding:18px 20px;cursor:pointer;transition:all .25s;position:relative;overflow:hidden}
.task-card:hover{border-color:var(--border-glow);background:var(--bg-card-hover);transform:translateY(-1px);box-shadow:var(--shadow)}
.task-card::before{content:'';position:absolute;top:0;left:0;bottom:0;width:3px;border-radius:3px 0 0 3px}
.task-card.status-active::before{background:var(--green)}
.task-card.status-completed::before{background:var(--pri)}
.task-card.status-skipped::before{background:var(--text-muted)}
.task-card.status-skipped{opacity:.6}
.task-card-top{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;margin-bottom:8px}
.task-card-title{font-size:14px;font-weight:600;color:var(--text);line-height:1.4;flex:1;word-break:break-word}
.task-card-title:empty::after{content:'Untitled Task';color:var(--text-muted);font-style:italic}
.task-status-badge{font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;padding:3px 10px;border-radius:20px;flex-shrink:0}
.task-status-badge.active{color:var(--green);background:var(--green-bg)}
.task-status-badge.completed{color:var(--pri);background:var(--pri-glow)}
.task-status-badge.skipped{color:var(--text-muted);background:rgba(128,128,128,.15)}
.task-card-summary{font-size:13px;color:var(--text-sec);line-height:1.5;margin-bottom:10px;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.task-card-summary:empty{display:none}
.task-card-summary.skipped-reason{background:rgba(128,128,128,.08);border-radius:6px;padding:6px 10px;border-left:3px solid var(--text-muted)}
.task-card-bottom{display:flex;align-items:center;gap:14px;font-size:11px;color:var(--text-muted)}
.task-card-bottom .tag{display:flex;align-items:center;gap:4px}
.task-card-bottom .tag .icon{font-size:12px}

/* ─── Task Detail Overlay ─── */
.task-detail-overlay{display:none;position:fixed;inset:0;background:rgba(0,0,0,.6);z-index:200;align-items:center;justify-content:center;padding:24px;backdrop-filter:blur(4px)}
.task-detail-overlay.show{display:flex}
.task-detail-panel{background:var(--bg);border:1px solid var(--border);border-radius:var(--radius-xl);width:100%;max-width:780px;max-height:85vh;overflow-y:auto;box-shadow:var(--shadow-lg);padding:28px 32px}
.task-detail-header{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;margin-bottom:16px}
.task-detail-header h2{font-size:18px;font-weight:700;color:var(--text);line-height:1.4;flex:1}
.task-detail-meta{display:flex;flex-wrap:wrap;gap:12px;margin-bottom:20px;font-size:12px;color:var(--text-sec)}
.task-detail-meta .meta-item{display:flex;align-items:center;gap:5px;background:var(--bg-card);border:1px solid var(--border);border-radius:8px;padding:5px 12px}
.task-detail-summary{background:var(--bg-card);border:1px solid var(--border);border-radius:var(--radius);padding:20px;margin-bottom:20px;font-size:13px;line-height:1.7;color:var(--text);word-break:break-word}
#taskDetailSummary:empty::after{content:'Summary not yet generated (task still active)';color:var(--text-muted);font-style:italic}
.task-detail-summary .summary-section-title{font-size:14px;font-weight:700;color:var(--text);margin:14px 0 6px 0;padding-bottom:4px;border-bottom:1px solid var(--border)}
.task-detail-summary .summary-section-title:first-child{margin-top:0}
.task-detail-summary ul{margin:4px 0 8px 0;padding-left:20px}
.task-detail-summary li{margin:3px 0;color:var(--text-sec);line-height:1.6}
.task-detail-chunks-title{font-size:12px;font-weight:700;color:var(--text-muted);text-transform:uppercase;letter-spacing:.06em;margin-bottom:12px;display:flex;align-items:center;gap:8px}
.task-detail-chunks-title::before{content:'';width:3px;height:14px;border-radius:2px;background:linear-gradient(180deg,var(--pri),rgba(99,102,241,.3))}
.task-detail-chunks{display:flex;flex-direction:column;gap:12px;padding:8px 0}
.task-chunk-item{display:flex;gap:12px;align-items:flex-start;width:100%;font-size:13px;line-height:1.6}
.task-chunk-item.role-user{flex-direction:row-reverse}
.task-chunk-avatar{width:32px;height:32px;border-radius:10px;display:flex;align-items:center;justify-content:center;font-size:14px;flex-shrink:0;font-weight:700}
.role-user .task-chunk-avatar{background:linear-gradient(135deg,var(--pri),var(--pri-dark));color:#fff}
.role-assistant .task-chunk-avatar{background:linear-gradient(135deg,var(--green),#059669);color:#fff}
.role-tool .task-chunk-avatar{background:linear-gradient(135deg,var(--amber),#d97706);color:#fff}
.task-chunk-body{flex:1;min-width:0;max-width:85%}
.task-chunk-header{display:flex;align-items:center;gap:8px;margin-bottom:4px}
.role-user .task-chunk-header{flex-direction:row-reverse}
.task-chunk-role{font-size:11px;font-weight:700;letter-spacing:.02em}
.task-chunk-role.user{color:var(--pri)}
.task-chunk-role.assistant{color:var(--green)}
.task-chunk-role.tool{color:var(--amber)}
.task-chunk-time{font-size:10px;color:var(--text-muted)}
.task-chunk-bubble{padding:14px 18px;border-radius:12px;white-space:pre-wrap;word-break:break-word;max-height:none;overflow:hidden;position:relative;transition:all .2s}
.task-chunk-bubble.collapsed{max-height:200px}
.task-chunk-expand{display:none;align-items:center;justify-content:center;gap:4px;margin-top:6px;padding:4px 12px;font-size:12px;font-weight:600;color:var(--text-sec);cursor:pointer;user-select:none;border-radius:8px;transition:all .15s}
.task-chunk-expand:hover{color:var(--pri);background:rgba(99,102,241,.08)}
.task-chunk-expand .expand-arrow{display:inline-block;font-size:10px;transition:transform .2s}
.task-chunk-expand.is-expanded .expand-arrow{transform:rotate(180deg)}
.role-user .task-chunk-bubble{background:linear-gradient(135deg,rgba(99,102,241,.12),rgba(99,102,241,.06));border:1px solid rgba(99,102,241,.2);color:var(--text);border-radius:12px 12px 4px 12px}
.role-assistant .task-chunk-bubble{background:var(--bg-card);border:1px solid var(--border);color:var(--text-sec);border-radius:12px 12px 12px 4px}
.role-tool .task-chunk-bubble{background:rgba(245,158,11,.06);border:1px solid rgba(245,158,11,.15);color:var(--text-sec);border-radius:12px 12px 12px 4px;font-family:'SF Mono',Monaco,Consolas,monospace;font-size:12px}
.task-chunk-bubble:hover{border-color:rgba(99,102,241,.3);box-shadow:0 2px 8px rgba(0,0,0,.1)}
[data-theme="light"] .role-user .task-chunk-bubble{background:linear-gradient(135deg,rgba(79,70,229,.08),rgba(79,70,229,.04));border-color:rgba(79,70,229,.15);color:#111827}
[data-theme="light"] .role-assistant .task-chunk-bubble{background:#f8f9fb;border-color:#e2e4e9;color:#4b5563}
[data-theme="light"] .task-detail-panel{background:#fff}
[data-theme="light"] .task-card{background:#fff}
[data-theme="light"] .tasks-stat{background:#fff}

/* ─── Skills ─── */
.skills-view{flex:1;min-width:0;flex-direction:column}
.skill-card{background:var(--bg-card);border:1px solid var(--border);border-radius:var(--radius-lg);padding:18px 20px;cursor:pointer;transition:all .25s;position:relative;overflow:hidden}
.skill-card:hover{border-color:var(--border-glow);background:var(--bg-card-hover);transform:translateY(-1px);box-shadow:var(--shadow)}
.skill-card::before{content:'';position:absolute;top:0;left:0;bottom:0;width:3px;border-radius:3px 0 0 3px;background:var(--violet)}
.skill-card.installed::before{background:var(--green)}
.skill-card.archived{opacity:.5}
.skill-card.archived::before{background:var(--text-muted)}
.skill-card-top{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;margin-bottom:6px}
.skill-card-name{font-size:15px;font-weight:700;color:var(--text);flex:1}
.task-card-badges,.skill-card-badges{display:flex;gap:6px;align-items:center}
.skill-badge{font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.05em;padding:3px 10px;border-radius:20px}
.skill-badge.version{color:var(--violet);background:rgba(139,92,246,.15)}
.skill-badge.installed{color:var(--green);background:var(--green-bg)}
.skill-badge.status-active{color:var(--pri);background:var(--pri-glow)}
.skill-badge.status-archived{color:var(--text-muted);background:rgba(128,128,128,.15)}
.skill-badge.status-draft{color:var(--amber);background:var(--amber-bg)}
.skill-badge.quality{font-size:10px;font-weight:700;padding:3px 10px;border-radius:20px}
.skill-badge.quality.high{color:var(--green);background:var(--green-bg)}
.skill-badge.quality.mid{color:var(--amber);background:var(--amber-bg)}
.skill-badge.quality.low{color:var(--rose);background:var(--rose-bg)}
.skill-card.draft{opacity:.75}
.skill-card.draft::before{background:var(--amber)}
.skill-card-desc{font-size:13px;color:var(--text-sec);line-height:1.5;margin-bottom:10px;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.skill-card-bottom{display:flex;align-items:center;gap:14px;font-size:11px;color:var(--text-muted);flex-wrap:wrap}
.skill-card-bottom .tag{display:flex;align-items:center;gap:4px}
.skill-card-tags{display:flex;gap:4px;flex-wrap:wrap}
.skill-tag{font-size:10px;padding:2px 8px;border-radius:10px;background:rgba(139,92,246,.1);color:var(--violet);font-weight:500}
.selection-toolbar{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
#memorySelectionToolbar{margin-bottom:16px}
.item-select-box{display:inline-flex;align-items:center;justify-content:center;width:18px;height:18px;border-radius:5px;border:1px solid var(--border);background:var(--bg-card);cursor:pointer;margin-right:8px;vertical-align:middle}
.item-select-box input{width:14px;height:14px;cursor:pointer}
.skill-detail-desc{font-size:13px;color:var(--text-sec);line-height:1.6;margin-bottom:16px;padding:12px 16px;background:var(--bg-card);border:1px solid var(--border);border-radius:var(--radius)}
.skill-version-item{background:var(--bg-card);border:1px solid var(--border);border-radius:var(--radius);padding:12px 16px}
.skill-version-header{display:flex;align-items:center;gap:10px;margin-bottom:6px}
.skill-version-badge{font-size:11px;font-weight:700;color:var(--violet);background:rgba(139,92,246,.12);padding:2px 8px;border-radius:8px}
.skill-version-type{font-size:10px;font-weight:600;text-transform:uppercase;color:var(--text-muted);letter-spacing:.04em}
.skill-version-changelog{font-size:12px;color:var(--text);line-height:1.5;font-weight:600}
.skill-version-summary{font-size:12px;color:var(--text-sec);line-height:1.6;margin-top:6px;padding:8px 12px;background:rgba(139,92,246,.04);border-left:2px solid rgba(139,92,246,.2);border-radius:0 6px 6px 0}
.skill-version-time{font-size:10px;color:var(--text-muted);margin-top:4px}
.skill-related-task{display:flex;align-items:center;gap:10px;padding:8px 12px;background:var(--bg-card);border:1px solid var(--border);border-radius:8px;cursor:pointer;transition:all .2s}
.skill-related-task:hover{border-color:var(--border-glow);background:var(--bg-card-hover)}
.skill-related-task .relation{font-size:10px;font-weight:600;text-transform:uppercase;color:var(--text-muted);letter-spacing:.04em;min-width:80px}
.skill-related-task .task-title{font-size:13px;color:var(--text);flex:1}
.skill-files-list{display:flex;flex-direction:column;gap:6px;margin-bottom:16px}
.skill-file-item{display:flex;align-items:center;gap:10px;padding:8px 12px;background:var(--bg-card);border:1px solid var(--border);border-radius:8px;font-size:12px}
.skill-file-icon{font-size:14px;width:20px;text-align:center}
.skill-file-name{flex:1;color:var(--text);font-family:SF Mono,Monaco,Consolas,monospace}
.skill-file-type{font-size:10px;font-weight:600;text-transform:uppercase;color:var(--text-muted);letter-spacing:.04em}
.skill-file-size{font-size:10px;color:var(--text-muted)}
.skill-download-btn{display:inline-flex;align-items:center;gap:6px;padding:6px 14px;border-radius:8px;background:var(--pri-grad);color:#fff;font-size:12px;font-weight:600;border:none;cursor:pointer;transition:all .2s}
.skill-download-btn:hover{opacity:.85;transform:translateY(-1px)}
.skill-vis-btn{display:inline-flex;align-items:center;gap:6px;padding:6px 14px;border-radius:8px;font-size:12px;font-weight:600;border:none;cursor:pointer;transition:all .2s}
.skill-vis-btn:hover{opacity:.85;transform:translateY(-1px)}
.skill-vis-btn.is-public{background:linear-gradient(135deg,#34d399,#10b981);color:#fff}
.skill-vis-btn.is-private{background:var(--pri-grad);color:#fff}
.mem-public-btn{color:var(--pri)!important}
.task-skill-section{margin-bottom:16px;padding:14px 16px;border-radius:var(--radius);border:1px solid var(--border)}
.task-skill-section.status-generated{border-color:var(--green);background:var(--green-bg)}
.task-skill-section.status-generating{border-color:var(--amber);background:var(--amber-bg)}
.task-skill-section.status-not_generated,.task-skill-section.status-skipped{border-color:var(--border);background:var(--bg-card)}
.task-skill-section .skill-status-header{display:flex;align-items:center;gap:8px;margin-bottom:6px;font-size:13px;font-weight:600;color:var(--text)}
.task-skill-section .skill-status-reason{font-size:12px;color:var(--text-sec);line-height:1.5}
.task-skill-section .skill-link-card{margin-top:10px;padding:10px 14px;background:var(--bg-card);border:1px solid var(--border);border-radius:8px;cursor:pointer;transition:all .2s}
.task-skill-section .skill-link-card:hover{border-color:var(--pri);background:var(--bg-card-hover)}
.task-skill-section .skill-link-name{font-size:13px;font-weight:600;color:var(--pri)}
.task-skill-section .skill-link-meta{font-size:11px;color:var(--text-sec);margin-top:4px}
.task-id-full{font-family:monospace;font-size:11px;color:var(--text-muted);word-break:break-all;user-select:all;cursor:text;padding:2px 6px;background:var(--bg-card);border-radius:4px;border:1px solid var(--border)}
[data-theme="light"] .skill-card{background:#fff}
[data-theme="light"] .skill-detail-desc{background:#f8fafc}
[data-theme="light"] .skill-version-item{background:#f8fafc}

/* ─── Analytics / 统计 ─── */
.nav-tabs{display:flex;align-items:center;gap:2px;background:rgba(255,255,255,.06);border-radius:10px;padding:3px}
.nav-tabs .tab{padding:6px 20px;border-radius:8px;font-size:13px;font-weight:600;color:var(--text-sec);background:transparent;border:1px solid rgba(0,0,0,0);cursor:pointer;transition:color .2s,background .2s,box-shadow .2s;white-space:nowrap}
.nav-tabs .tab:hover{color:var(--text)}
.nav-tabs .tab.active{color:var(--text);background:rgba(255,255,255,.1);border-color:var(--border);box-shadow:0 1px 4px rgba(0,0,0,.15)}
[data-theme="light"] .nav-tabs{background:rgba(0,0,0,.05)}
[data-theme="light"] .nav-tabs .tab.active{background:#fff;border-color:rgba(0,0,0,.1);box-shadow:0 1px 3px rgba(0,0,0,.08);color:var(--text)}
.analytics-view,.settings-view,.logs-view,.migrate-view,.admin-view{flex:1;min-width:0;flex-direction:column;gap:20px}
.feed-wrap,.tasks-view,.skills-view,.analytics-view,.logs-view,.migrate-view,.admin-view,.settings-view{max-width:960px}

/* ─── Logs ─── */
.logs-toolbar{display:flex;align-items:center;justify-content:space-between;padding:8px 0}
.logs-toolbar-left{display:flex;align-items:center;gap:8px}
.logs-toolbar-right{display:flex;align-items:center;gap:8px}
.logs-list{display:flex;flex-direction:column;gap:8px;overflow-y:auto;flex:1;min-height:0}
.log-entry{background:var(--bg-card);border:1px solid var(--border);border-radius:var(--radius-lg);overflow:hidden;transition:border-color .2s}
.log-entry:hover{border-color:var(--border-glow)}
.log-header{display:flex;align-items:center;gap:10px;padding:12px 16px;cursor:pointer;user-select:none;transition:background .15s}
.log-header:hover{background:rgba(255,255,255,.03)}
[data-theme="light"] .log-header:hover{background:rgba(0,0,0,.02)}
.log-tool-badge{font-family:'SF Mono',Consolas,monospace;font-size:11px;font-weight:700;padding:3px 8px;border-radius:4px;white-space:nowrap;letter-spacing:.3px}
.log-tool-badge.memory_search{background:rgba(59,130,246,.15);color:#60a5fa}
.log-tool-badge.memory_add{background:rgba(168,85,247,.15);color:#c084fc}
.log-tool-badge.auto_recall{background:rgba(168,85,247,.15);color:#c084fc}
.log-tool-badge.memory_timeline{background:rgba(34,197,94,.15);color:#4ade80}
.log-tool-badge.memory_get{background:rgba(251,146,60,.15);color:#fb923c}
.log-tool-badge.task_summary{background:rgba(245,158,11,.15);color:#fbbf24}
.log-tool-badge.skill_get{background:rgba(236,72,153,.15);color:#f472b6}
.log-tool-badge.skill_install{background:rgba(14,165,233,.15);color:#38bdf8}
.log-tool-badge.memory_viewer{background:rgba(100,116,139,.15);color:#94a3b8}
.log-dur{font-family:'SF Mono',Consolas,monospace;font-size:10px;color:var(--text-sec);opacity:.7}
.log-time{margin-left:auto;font-size:11px;color:var(--text-sec);font-family:'SF Mono',Consolas,monospace;white-space:nowrap}
.log-status{width:7px;height:7px;border-radius:50%;flex-shrink:0}
.log-status.ok{background:#4ade80;box-shadow:0 0 4px rgba(74,222,128,.5)}
.log-status.fail{background:#f87171;box-shadow:0 0 4px rgba(248,113,113,.5)}
.log-summary{padding:8px 16px 10px;font-size:12px;color:var(--text-sec);line-height:1.5}
.log-summary-kv{display:inline-flex;align-items:center;gap:4px;margin-right:12px;font-size:11px}
.log-summary-kv .kv-label{color:var(--text-sec);opacity:.7}
.log-summary-kv .kv-val{color:var(--text);font-family:'SF Mono',Consolas,monospace;font-size:11px}
.log-summary-query{margin-top:4px;padding:6px 10px;background:rgba(59,130,246,.08);border-radius:6px;font-size:12px;color:var(--text);border-left:3px solid rgba(59,130,246,.4);line-height:1.4}
.log-summary-stats{display:flex;gap:6px;flex-wrap:wrap;margin-top:6px}
.log-stat-chip{display:inline-flex;align-items:center;gap:3px;padding:2px 8px;border-radius:10px;font-size:10px;font-weight:600;font-family:'SF Mono',Consolas,monospace}
.log-stat-chip.stored{background:rgba(74,222,128,.12);color:#4ade80}
.log-stat-chip.skipped{background:rgba(100,116,139,.12);color:#94a3b8}
.log-stat-chip.dedup{background:rgba(251,146,60,.12);color:#fb923c}
.log-stat-chip.merged{background:rgba(168,85,247,.12);color:#c084fc}
.log-stat-chip.errors{background:rgba(248,113,113,.12);color:#f87171}
.log-msg-list{margin-top:8px;display:flex;flex-direction:column;gap:4px}
.log-msg-item{display:flex;gap:8px;align-items:flex-start;font-size:11.5px;line-height:1.5;padding:4px 10px;border-radius:6px;background:rgba(255,255,255,.02);overflow:hidden}
.log-msg-item.expanded{flex-wrap:wrap}
.recall-layers{margin-top:8px;display:flex;flex-direction:column;gap:10px}
.recall-layer-title{font-size:11px;font-weight:600;color:var(--text-sec);margin-bottom:4px;display:flex;align-items:center;gap:6px;cursor:pointer;user-select:none}
.recall-layer-title .recall-expand-icon{transition:transform .15s;font-size:9px}
.recall-layer.expanded .recall-layer-title .recall-expand-icon{transform:rotate(90deg)}
.recall-count{font-size:10px;font-weight:700;padding:1px 6px;border-radius:10px;background:rgba(99,102,241,.1);color:var(--pri)}
.recall-items{display:none;flex-direction:column;gap:3px}
.recall-layer.expanded .recall-items{display:flex}
.recall-item{font-size:11px;line-height:1.4;padding:4px 8px;border-radius:5px;background:rgba(255,255,255,.02);cursor:pointer}
.recall-item:hover{background:rgba(99,102,241,.06)}
[data-theme="light"] .recall-item{background:rgba(0,0,0,.02)}
[data-theme="light"] .recall-item:hover{background:rgba(99,102,241,.06)}
.recall-item-head{display:flex;gap:6px;align-items:center}
.recall-idx{flex-shrink:0;font-size:10px;font-weight:600;color:var(--text-muted);min-width:14px;text-align:right}
.recall-score{flex-shrink:0;font-family:'SF Mono',Consolas,monospace;font-size:10px;font-weight:600;padding:1px 5px;border-radius:4px}
.recall-score.high{background:rgba(34,197,94,.12);color:#22c55e}
.recall-score.mid{background:rgba(251,191,36,.12);color:#f59e0b}
.recall-score.low{background:rgba(248,113,113,.1);color:var(--text-muted)}
.recall-origin{flex-shrink:0;font-size:9px;font-weight:600;padding:1px 5px;border-radius:4px}
.recall-origin.local-shared{background:rgba(59,130,246,.12);color:#3b82f6}
.recall-origin.hub-memory{background:rgba(139,92,246,.12);color:#8b5cf6}
.recall-origin.hub-remote{background:rgba(139,92,246,.12);color:#8b5cf6}
.recall-origin.agent-tag{background:rgba(20,184,166,.12);color:#14b8a6}
.recall-summary-short{flex:1;color:var(--text-sec);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.recall-expand-icon{flex-shrink:0;font-size:10px;color:var(--text-muted);transition:transform .15s}
.recall-item.expanded .recall-expand-icon{transform:rotate(90deg)}
.recall-summary-full{display:none;margin-top:4px;padding:6px 8px 4px 28px;font-size:11px;line-height:1.5;color:var(--text);word-break:break-word;border-top:1px dashed var(--border)}
.recall-item.expanded .recall-summary-full{display:block}
.recall-layer.filtered .recall-layer-title{color:var(--pri)}
.recall-layer.filtered.empty .recall-layer-title{color:var(--text-muted)}
.recall-more{font-size:10px;color:var(--text-muted);padding:2px 8px}
.recall-detail{padding:4px 0}
.recall-detail-section{margin-bottom:10px}
.recall-detail-title{font-size:11px;font-weight:600;color:var(--text-sec);margin-bottom:6px;padding-bottom:4px;border-bottom:1px dashed var(--border);cursor:pointer;user-select:none;display:flex;align-items:center;gap:6px}
.recall-detail-title .recall-expand-icon{transition:transform .15s;font-size:9px}
.recall-detail-section.expanded .recall-detail-title .recall-expand-icon{transform:rotate(90deg)}
.recall-detail-section .recall-detail-items{display:none;flex-direction:column;gap:3px}
.recall-detail-section.expanded .recall-detail-items{display:flex}
.recall-detail-section.filtered .recall-detail-title{color:var(--pri)}
[data-theme="light"] .log-msg-item{background:rgba(0,0,0,.02)}
.log-msg-role{flex-shrink:0;font-size:10px;font-weight:600;padding:1px 6px;border-radius:4px;text-transform:uppercase;letter-spacing:.3px}
.log-msg-role.user{background:rgba(59,130,246,.12);color:#60a5fa}
.log-msg-role.assistant{background:rgba(168,85,247,.12);color:#c084fc}
.log-msg-role.system{background:rgba(100,116,139,.12);color:#94a3b8}
.log-msg-action{flex-shrink:0;font-size:10px;font-weight:600;padding:1px 6px;border-radius:4px}
.log-msg-action.stored{color:#4ade80}
.log-msg-action.exact-dup{color:#94a3b8}
.log-msg-action.dedup{color:#fb923c}
.log-msg-action.merged{color:#c084fc}
.log-msg-action.error{color:#f87171}
.log-msg-text{color:var(--text);opacity:.85;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis}
.log-msg-text-short{color:var(--text);opacity:.85;flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.log-msg-text-full{display:none;color:var(--text);opacity:.85;flex:1;min-width:0;word-break:break-word;white-space:pre-wrap}
.log-msg-item.expanded .log-msg-text-short{display:none}
.log-msg-item.expanded .log-msg-text-full{display:block}
.log-msg-item.expanded .recall-expand-icon{transform:rotate(90deg)}
.log-add-detail{display:flex;flex-direction:column;gap:8px}
.log-add-msg{display:flex;gap:8px;align-items:flex-start;font-size:12px;line-height:1.6}
.log-add-msg-role{flex-shrink:0;font-size:10px;font-weight:600;text-transform:uppercase;padding:2px 8px;border-radius:4px;background:rgba(99,102,241,.1);color:var(--pri)}
.log-add-msg-content{flex:1;min-width:0;word-break:break-word;white-space:pre-wrap;color:var(--text)}
.log-detail{display:none;border-top:1px solid var(--border);padding:0}
.log-detail.open{display:block}
.log-expand-btn{font-size:10px;color:var(--text-sec);opacity:.5;margin-left:auto;transition:transform .2s,opacity .15s;display:inline-block}
.log-entry.expanded .log-expand-btn{transform:rotate(180deg);opacity:.8}
.logs-pagination{display:flex;align-items:center;justify-content:center;gap:4px;padding:12px 0;flex-wrap:wrap}
.logs-pagination .btn{min-width:32px;padding:4px 8px;font-size:12px}
.logs-pagination .btn-primary{background:var(--primary);color:#fff;border-color:var(--primary)}
.logs-pagination .page-ellipsis{color:var(--text-sec);font-size:12px;padding:0 4px}
.logs-pagination .page-total{font-size:11px;color:var(--text-sec);margin-left:8px}
.log-io-section{padding:10px 14px}
.log-io-label{font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:1px;color:var(--text-sec);margin-bottom:6px}
.log-io-content{font-family:'SF Mono',Consolas,monospace;font-size:11px;line-height:1.6;color:var(--text);white-space:pre-wrap;word-break:break-all;background:rgba(0,0,0,.2);border-radius:6px;padding:10px 12px;max-height:300px;overflow-y:auto}
.log-io-section+.log-io-section{border-top:1px dashed var(--border)}
[data-theme="light"] .log-io-content{background:rgba(0,0,0,.04)}
[data-theme="light"] .log-summary-query{background:rgba(59,130,246,.06)}
.settings-group{margin-bottom:8px}
.settings-group-title{font-size:15px;font-weight:700;color:var(--text);margin:0 0 12px 0;padding:0;letter-spacing:.02em}
.settings-group .settings-section{margin-bottom:16px}
.settings-group .settings-section:last-child{margin-bottom:0}
.settings-section{background:var(--bg-card);border:1px solid var(--border);border-radius:var(--radius-lg);padding:24px 28px}
.settings-section h3{font-size:13px;font-weight:700;color:var(--text);margin-bottom:16px;display:flex;align-items:center;gap:8px}
.settings-section h3 .icon{font-size:16px;opacity:.8}
.settings-tabs-bar{display:flex;gap:4px;margin-bottom:24px;padding:4px;background:var(--bg);border:1px solid var(--border);border-radius:14px;overflow-x:auto;-webkit-overflow-scrolling:touch}
.settings-tab-btn{position:relative;display:flex;align-items:center;gap:7px;padding:10px 16px;border:none;background:transparent;color:var(--text-muted);font-size:13px;font-weight:500;cursor:pointer;border-radius:10px;transition:all .25s ease;white-space:nowrap;font-family:inherit}
.settings-tab-btn:hover{background:rgba(99,102,241,.06);color:var(--text)}
.settings-tab-btn.active{background:var(--bg-card);color:var(--text);font-weight:600;box-shadow:0 2px 8px rgba(0,0,0,.06),0 0 0 1px rgba(99,102,241,.1)}
.settings-tab-btn .stab-icon{font-size:15px;line-height:1}
.settings-tab-btn .stab-dot{width:6px;height:6px;border-radius:50%;flex-shrink:0}
.settings-tab-btn[data-tab="models"] .stab-dot{background:#6366f1}
.settings-tab-btn[data-tab="hub"] .stab-dot{background:#06b6d4}
.settings-tab-btn[data-tab="general"] .stab-dot{background:#10b981}
.settings-tab-btn.active .stab-dot{box-shadow:0 0 6px currentColor}
[data-theme="light"] .settings-tab-btn.active{box-shadow:0 2px 8px rgba(0,0,0,.05),0 0 0 1px rgba(99,102,241,.08)}
.settings-cards-grid{display:flex;flex-direction:column;gap:24px}
.settings-card[data-stab]{display:none}
.settings-card[data-stab].stab-active{display:block}
.settings-card{position:relative;background:var(--bg-card);border:1px solid var(--border);border-radius:16px;overflow:hidden;transition:border-color .3s,box-shadow .3s}
.settings-card::before{content:'';position:absolute;top:0;left:0;right:0;height:3px;opacity:.5;transition:opacity .3s}
.settings-card:hover{border-color:rgba(99,102,241,.25);box-shadow:0 0 24px rgba(99,102,241,.06),0 8px 32px rgba(0,0,0,.1)}
.settings-card:hover::before{opacity:1}
.settings-card.card-models::before{background:linear-gradient(90deg,#6366f1,#8b5cf6,#f59e0b)}
.settings-card.card-hub::before{background:linear-gradient(90deg,#06b6d4,#22d3ee,#67e8f9)}
.settings-card.card-general::before{background:linear-gradient(90deg,#10b981,#34d399,#6ee7b7)}
.settings-card-header{display:flex;align-items:center;gap:14px;padding:22px 28px 0}
.settings-card-icon{width:44px;height:44px;display:flex;align-items:center;justify-content:center;border-radius:12px;font-size:22px;flex-shrink:0;border:1px solid transparent}
.settings-card-title-wrap{flex:1;min-width:0}
.settings-card-title{font-size:16px;font-weight:700;color:var(--text);letter-spacing:.01em}
.settings-card-desc{font-size:11px;color:var(--text-muted);margin-top:3px;font-weight:400;line-height:1.4}
.settings-card-body{padding:18px 28px 24px}
.settings-card-divider{height:1px;background:var(--border);margin:18px 0;opacity:.6}
.settings-card-subtitle{font-size:12px;font-weight:700;color:var(--text-sec);margin-bottom:10px;letter-spacing:.01em}
.hub-info-card{border:1px solid var(--border);border-radius:12px;padding:14px 16px;background:var(--bg);position:relative;overflow:hidden;margin-bottom:12px}
.hub-info-card::before{content:'';position:absolute;top:0;left:0;bottom:0;width:3px;border-radius:3px 0 0 3px}
.hub-info-card.hic-share{border-color:rgba(99,102,241,.2);background:linear-gradient(135deg,rgba(99,102,241,.04),rgba(139,92,246,.03))}
.hub-info-card.hic-share::before{background:linear-gradient(180deg,var(--pri),var(--violet))}
.hub-info-card.hic-status::before{background:var(--green)}
.hub-info-card.hic-team::before{background:var(--violet)}
.hub-info-card.hic-pending::before{background:var(--amber)}
.hub-info-card .hic-title{display:flex;align-items:center;gap:8px;font-size:12px;font-weight:700;color:var(--text);margin-bottom:10px}
.hub-info-card .hic-title .hic-icon{font-size:14px}
.hub-info-card .hic-grid{display:grid;grid-template-columns:auto 1fr;gap:4px 12px;font-size:12px;align-items:baseline}
.hub-info-card .hic-grid .hic-label{color:var(--text-muted);white-space:nowrap}
.hub-info-card .hic-grid .hic-value{color:var(--text);font-weight:500;word-break:break-all}
.hub-info-card .hic-grid .hic-value.mono{font-family:monospace;font-size:11px;cursor:pointer;user-select:all}
.hub-info-card .hic-grid .hic-value.mono:hover{color:var(--pri)}
.hub-info-card .hic-badge{display:inline-flex;align-items:center;gap:4px;font-size:10px;font-weight:600;padding:2px 8px;border-radius:9999px}
.hub-info-card .hic-badge.connected{background:rgba(52,211,153,.12);color:#34d399}
.hub-info-card .hic-badge.disconnected{background:rgba(239,68,68,.1);color:#ef4444}
.hub-info-card .hic-badge.admin{background:rgba(52,199,89,.12);color:#34c759}
.hub-info-card .hic-badge.pending{background:rgba(251,191,36,.12);color:#fbbf24}
.hub-info-card .hic-dot{width:6px;height:6px;border-radius:50%;display:inline-block}
.hub-info-card .hic-dot.green{background:#34d399;box-shadow:0 0 6px #34d399}
.hub-info-card .hic-dot.red{background:#ef4444}
.hub-info-card .hic-dot.amber{background:#fbbf24;box-shadow:0 0 4px #fbbf24}
.hub-info-card .hic-empty{font-size:12px;color:var(--text-muted);text-align:center;padding:12px 0}
.hub-info-card .hic-actions{display:flex;gap:8px;margin-top:10px}
[data-theme="light"] .hub-info-card.hic-share{background:linear-gradient(135deg,rgba(99,102,241,.03),rgba(139,92,246,.02))}
.settings-card .settings-section{background:none;border:none;padding:0;border-radius:0;margin-bottom:16px}
.settings-card .settings-section:last-child{margin-bottom:0}
.settings-card .settings-section h3{margin-bottom:12px}
[data-theme="light"] .settings-card{box-shadow:0 1px 3px rgba(0,0,0,.04)}
[data-theme="light"] .settings-card:hover{box-shadow:0 0 24px rgba(79,70,229,.05),0 8px 32px rgba(0,0,0,.06)}
.settings-grid{display:grid;grid-template-columns:1fr 1fr;gap:14px}
@media(max-width:800px){.settings-grid{grid-template-columns:1fr}}
.settings-field{display:flex;flex-direction:column;gap:4px}
.settings-field label{font-size:11px;font-weight:600;color:var(--text-muted);text-transform:uppercase;letter-spacing:.04em}
.settings-field input,.settings-field select{background:var(--bg);border:1px solid var(--border);border-radius:8px;padding:8px 12px;color:var(--text);font-size:13px;font-family:inherit;transition:border-color .15s}
.settings-field input:focus,.settings-field select:focus{outline:none;border-color:var(--pri)}
.settings-field input[type="password"]{font-family:'Courier New',monospace;letter-spacing:.05em}
.field-hint{font-size:10px;color:var(--text-muted);line-height:1.5}
.settings-field .field-hint{margin-top:2px}
.settings-field.full-width{grid-column:1/-1}
.settings-toggle{display:flex;align-items:center;gap:10px;padding:4px 0}
.settings-toggle label{font-size:12px;font-weight:500;color:var(--text-sec);text-transform:none;letter-spacing:0}
.toggle-switch{position:relative;width:36px;height:20px;cursor:pointer}
.toggle-switch input{opacity:0;width:0;height:0}
.toggle-slider{position:absolute;inset:0;background:var(--border);border-radius:20px;transition:.2s}
.toggle-slider::before{content:'';position:absolute;height:14px;width:14px;left:3px;bottom:3px;background:#fff;border-radius:50%;transition:.2s}
.toggle-switch input:checked+.toggle-slider{background:var(--pri)}
.toggle-switch input:checked+.toggle-slider::before{transform:translateX(16px)}
.test-conn-row{display:flex;align-items:center;gap:10px;margin-top:12px;padding-top:10px;border-top:1px dashed var(--border)}
.test-conn-row .btn{font-size:11px;padding:5px 14px;border:1px solid var(--border);border-radius:6px}
.test-result{font-size:12px;line-height:1.5;word-break:break-word}
.test-result.ok{color:#22c55e}
.test-result.fail{color:var(--rose)}
.test-result.loading{color:var(--text-muted)}
.settings-actions{display:flex;gap:12px;justify-content:flex-end;align-items:center;margin-top:20px;padding-top:16px;flex-wrap:nowrap}
.settings-actions .btn{flex:0 0 auto;min-width:0;padding:8px 24px;font-size:13px}
.settings-actions .btn-primary{background:rgba(99,102,241,.08);color:var(--pri);border:1px solid rgba(99,102,241,.25);font-weight:600}
.settings-actions .btn-primary:hover{background:rgba(99,102,241,.14);border-color:var(--pri)}
[data-theme="light"] .settings-actions .btn-primary{background:rgba(79,70,229,.06);color:#4f46e5;border:1px solid rgba(79,70,229,.2)}
[data-theme="light"] .settings-actions .btn-primary:hover{background:rgba(79,70,229,.1);border-color:#4f46e5}
.settings-saved{display:inline-flex;align-items:center;gap:6px;color:var(--green);font-size:12px;font-weight:600;opacity:0;transition:opacity .3s}
.settings-saved.show{opacity:1}
.team-guide{margin-bottom:20px;border:1px solid rgba(6,182,212,.2);border-radius:12px;background:linear-gradient(135deg,rgba(6,182,212,.04),rgba(99,102,241,.03));position:relative;overflow:hidden;padding:20px 22px 18px;display:none}
.team-guide::before{content:'';position:absolute;top:0;left:0;right:0;height:3px;background:linear-gradient(90deg,#06b6d4,#6366f1,#8b5cf6);opacity:.6}
.team-guide-title{display:flex;align-items:center;gap:8px;font-size:14px;font-weight:700;color:var(--text);margin-bottom:4px}
.team-guide-subtitle{font-size:11.5px;color:var(--text-muted);line-height:1.6;margin-bottom:16px}
.team-guide-options{display:grid;grid-template-columns:1fr 1fr;gap:14px}
@media(max-width:800px){.team-guide-options{grid-template-columns:1fr}}
.team-guide-opt{border:1px solid var(--border);border-radius:10px;padding:16px;background:var(--bg-card);transition:border-color .2s,box-shadow .2s;cursor:default}
.team-guide-opt:hover{border-color:rgba(99,102,241,.3);box-shadow:0 4px 16px rgba(0,0,0,.06)}
.team-guide-opt-header{display:flex;align-items:center;gap:10px;margin-bottom:8px}
.team-guide-opt-icon{width:32px;height:32px;display:flex;align-items:center;justify-content:center;border-radius:8px;font-size:16px;flex-shrink:0}
.team-guide-opt-title{font-size:13px;font-weight:700;color:var(--text)}
.team-guide-opt-desc{font-size:11px;color:var(--text-sec);line-height:1.7;margin-bottom:12px}
.team-guide-steps{padding:0 0 0 20px;margin:0 0 12px;counter-reset:none}
.team-guide-steps li{font-size:11px;color:var(--text-muted);line-height:1.9}
.team-guide-steps li::marker{color:var(--pri);font-weight:700;font-size:11px}
.team-guide-opt .btn-guide{font-size:11px;padding:5px 14px;border-radius:6px;font-weight:600;border:1px solid rgba(99,102,241,.25);background:rgba(99,102,241,.08);color:var(--pri);cursor:pointer;transition:background .15s,border-color .15s}
.team-guide-opt .btn-guide:hover{background:rgba(99,102,241,.14);border-color:var(--pri)}
[data-theme="light"] .team-guide{background:linear-gradient(135deg,rgba(6,182,212,.03),rgba(79,70,229,.02));border-color:rgba(6,182,212,.15)}
[data-theme="light"] .team-guide-opt{box-shadow:0 1px 3px rgba(0,0,0,.03)}
[data-theme="light"] .team-guide-opt:hover{box-shadow:0 4px 16px rgba(0,0,0,.04)}
.model-health-bar{margin-bottom:20px;border-radius:var(--radius-lg);overflow:visible}
.mh-table{width:100%;border-collapse:separate;border-spacing:0;font-size:12px}
.mh-table th{text-align:left;padding:6px 12px;font-size:10px;font-weight:600;color:var(--text-muted);text-transform:uppercase;letter-spacing:.05em;background:var(--bg);border-bottom:1px solid var(--border)}
.mh-table td{padding:8px 12px;border-bottom:1px solid var(--border);vertical-align:middle}
.mh-table tr:last-child td{border-bottom:none}
.mh-table tr:hover td{background:rgba(99,102,241,.025)}
.mh-table .mh-cell-name{display:flex;align-items:center;gap:8px;font-weight:500;color:var(--text)}
.mh-dot{width:8px;height:8px;border-radius:50%;flex-shrink:0;display:inline-block}
.mh-dot.ok{background:#22c55e;box-shadow:0 0 0 2px rgba(34,197,94,.15)}
.mh-dot.degraded{background:#f59e0b;box-shadow:0 0 0 2px rgba(245,158,11,.15)}
.mh-dot.error{background:#ef4444;box-shadow:0 0 0 2px rgba(239,68,68,.15);animation:healthPulse 2s ease infinite}
.mh-dot.unknown{background:#94a3b8;box-shadow:0 0 0 2px rgba(148,163,184,.15)}
.mh-badge{display:inline-block;padding:2px 7px;border-radius:10px;font-size:10px;font-weight:600;letter-spacing:.02em}
.mh-badge.ok{background:rgba(34,197,94,.1);color:#16a34a}
.mh-badge.degraded{background:rgba(245,158,11,.1);color:#d97706}
.mh-badge.error{background:rgba(239,68,68,.1);color:#dc2626}
.mh-badge.unknown{background:rgba(148,163,184,.1);color:#64748b}
.mh-model-name{color:var(--text-muted);font-size:11px;font-family:var(--font-mono,'SFMono-Regular',Consolas,monospace)}
.mh-err-text{font-size:11px;color:var(--rose);max-width:320px;display:inline-block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;cursor:help}
#mhTooltip{display:none;position:fixed;min-width:280px;max-width:480px;max-height:300px;overflow-y:auto;padding:8px 10px;background:var(--bg-card,#1e1e2e);color:var(--text,#e2e8f0);border:1px solid var(--border,#333);border-radius:6px;font-size:11px;line-height:1.5;white-space:pre-wrap;word-break:break-all;box-shadow:0 4px 12px rgba(0,0,0,.25);z-index:10000;pointer-events:none}
.mh-time{font-size:10px;color:var(--text-muted);white-space:nowrap}
.mh-empty{padding:16px;font-size:12px;color:var(--text-muted);text-align:center}
@keyframes healthPulse{0%,100%{opacity:1}50%{opacity:.4}}
.migrate-log-item{display:flex;align-items:flex-start;gap:10px;padding:8px 14px;border-bottom:1px solid var(--border);animation:migrateFadeIn .3s ease}
.migrate-log-item:last-child{border-bottom:none}
.migrate-log-item .log-icon{flex-shrink:0;width:18px;height:18px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:10px;margin-top:2px}
.migrate-log-item .log-icon.stored{background:rgba(34,197,94,.12);color:#22c55e}
.migrate-log-item .log-icon.skipped{background:rgba(245,158,11,.12);color:#f59e0b}
.migrate-log-item .log-icon.merged{background:rgba(59,130,246,.12);color:#3b82f6}
.migrate-log-item .log-icon.error{background:rgba(239,68,68,.12);color:#ef4444}
.migrate-log-item .log-icon.duplicate{background:rgba(245,158,11,.12);color:#f59e0b}
.migrate-log-item .log-body{flex:1;min-width:0}
.migrate-log-item .log-preview{color:var(--text);font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:100%}
.migrate-log-item .log-meta{display:flex;gap:8px;font-size:9px;color:var(--text-muted);margin-top:2px}
.migrate-log-item .log-meta .tag{padding:1px 6px;border-radius:4px;font-weight:600;letter-spacing:.02em}
.migrate-log-item .log-meta .tag.stored{background:rgba(34,197,94,.1);color:#22c55e}
.migrate-log-item .log-meta .tag.skipped{background:rgba(245,158,11,.1);color:#f59e0b}
.migrate-log-item .log-meta .tag.merged{background:rgba(59,130,246,.1);color:#3b82f6}
.migrate-log-item .log-meta .tag.error{background:rgba(239,68,68,.1);color:#ef4444}
.migrate-log-item .log-meta .tag.duplicate{background:rgba(245,158,11,.1);color:#f59e0b}
@keyframes migrateFadeIn{from{opacity:0;transform:translateY(-4px)}to{opacity:1;transform:translateY(0)}}
.feed-wrap{flex:1;min-width:0;flex-direction:column}
.analytics-view{flex-direction:column;gap:20px}
.analytics-cards{display:grid;grid-template-columns:repeat(4,1fr);gap:14px}
.analytics-card{position:relative;overflow:hidden;border-radius:var(--radius-lg);padding:18px 16px;transition:all .2s ease;border:1px solid var(--border);background:var(--bg-card)}
.analytics-card::before{content:'';position:absolute;top:0;left:0;right:0;height:2px;background:var(--pri);opacity:.5}
.analytics-card::after{display:none}
.analytics-card:hover{transform:translateY(-2px);box-shadow:var(--shadow);border-color:var(--border-glow)}
.analytics-card.green::before{background:var(--green)}
.analytics-card.amber::before{background:var(--amber)}
.analytics-card .ac-value{font-size:24px;font-weight:700;letter-spacing:-.03em;color:var(--text);line-height:1;-webkit-text-fill-color:unset;background:none}
.analytics-card.green .ac-value{color:var(--green);background:none}
.analytics-card.amber .ac-value{color:var(--amber);background:none}
.analytics-card .ac-label{font-size:11px;color:var(--text-muted);margin-top:6px;font-weight:500;text-transform:uppercase;letter-spacing:.06em}
.analytics-section{background:var(--bg-card);border:1px solid var(--border);border-radius:var(--radius-lg);padding:18px 20px;position:relative;overflow:hidden}
.analytics-section::before{display:none}
.analytics-section h3{font-size:11px;font-weight:600;color:var(--text-muted);text-transform:uppercase;letter-spacing:.08em;margin-bottom:16px;display:flex;align-items:center;gap:8px}
.analytics-section h3 .icon{font-size:14px;opacity:.6}
.chart-bars{display:flex;align-items:flex-end;gap:0;padding:12px 0 4px;min-height:200px;position:relative;width:100%}
.chart-bars::before{content:'';position:absolute;left:0;right:0;bottom:24px;height:1px;background:var(--border);opacity:.4}
.chart-bar-wrap{flex:1 1 0;min-width:0;display:flex;flex-direction:column;align-items:center;gap:4px;position:relative;cursor:pointer}
.chart-bar-col{width:100%;height:160px;display:flex;flex-direction:column;justify-content:flex-end;align-items:center}
.chart-bar-wrap:hover .chart-bar{opacity:1;filter:brightness(1.2);transform:scaleY(1.02);transform-origin:bottom}
.chart-bar-wrap:hover .chart-bar-label{color:var(--text)}
.chart-bar-wrap:hover .chart-tip{opacity:1;transform:translateX(-50%) translateY(0)}
.chart-tip{position:absolute;top:-8px;left:50%;transform:translateX(-50%) translateY(6px);background:rgba(15,18,25,.95);border:1px solid rgba(99,102,241,.3);color:#e8eaed;padding:3px 10px;border-radius:8px;font-size:10px;font-weight:600;white-space:nowrap;z-index:5;pointer-events:none;box-shadow:0 4px 16px rgba(0,0,0,.3);opacity:0;transition:all .2s cubic-bezier(.22,1,.36,1)}
[data-theme="light"] .chart-tip{background:rgba(17,24,39,.9)}
.chart-bar{width:100%;max-width:20px;min-width:4px;border-radius:3px 3px 1px 1px;background:linear-gradient(180deg,#818cf8 0%,#6366f1 100%);opacity:.85;transition:all .25s cubic-bezier(.22,1,.36,1);box-shadow:0 1px 4px rgba(99,102,241,.12)}
.chart-bar.violet{background:linear-gradient(180deg,#8b5cf6 0%,#6366f1 100%)}
.chart-bar.green{background:linear-gradient(180deg,#34d399 0%,#10b981 100%);box-shadow:0 1px 4px rgba(16,185,129,.12)}
.chart-bar.zero{width:100%;max-width:20px;min-width:4px;height:2px!important;background:var(--border);opacity:.25;border-radius:1px;box-shadow:none}
.chart-bar-label{font-size:8px;line-height:1;min-height:10px;color:var(--text-muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:40px;text-align:center;transition:color .15s;letter-spacing:0}
.chart-legend{display:flex;gap:14px;margin-top:12px;flex-wrap:wrap;font-size:11px;color:var(--text-sec);font-weight:500}
.chart-legend span{display:inline-flex;align-items:center;gap:5px}
.chart-legend .dot{width:8px;height:8px;border-radius:2px}
.chart-legend .dot.pri{background:var(--pri)}
.tool-chart-svg{width:100%;height:100%;display:block}
.tool-chart-svg .grid-line{stroke:var(--border);stroke-dasharray:3 3;stroke-width:0.5}
.tool-chart-svg .axis-label{fill:var(--text-muted);font-size:10px;font-family:var(--mono)}
.tool-chart-svg .data-line{fill:none;stroke-width:1.5;stroke-linecap:round;stroke-linejoin:round;stroke-dasharray:2000;stroke-dashoffset:2000;animation:lineIn .6s ease forwards}
@keyframes lineIn{to{stroke-dashoffset:0}}
.tool-chart-svg .data-area{opacity:1}
.tool-chart-svg .hover-dot{r:3.5;stroke-width:2;stroke:var(--bg);opacity:0;transition:opacity .1s}
.tool-chart-svg .hover-dot.show{opacity:1}
.tool-chart-tooltip{position:absolute;top:0;left:0;background:var(--bg-card);border:1px solid var(--border-glow);color:var(--text);padding:8px 12px;border-radius:8px;font-size:11px;font-family:var(--mono);pointer-events:none;opacity:0;transition:opacity .1s;z-index:10;box-shadow:var(--shadow-lg);white-space:nowrap}
.tool-chart-tooltip.show{opacity:1}
.tool-chart-tooltip .tt-time{color:var(--text-muted);font-size:10px;margin-bottom:4px;font-weight:500}
.tool-chart-tooltip .tt-row{display:flex;align-items:center;gap:6px;margin:2px 0}
.tool-chart-tooltip .tt-dot{width:6px;height:6px;border-radius:2px;flex-shrink:0}
.tool-chart-tooltip .tt-val{font-weight:600;margin-left:auto;padding-left:12px}
.tool-agg-table{width:100%;border-collapse:collapse;font-size:12px}
.tool-agg-table th{text-align:left;font-weight:500;color:var(--text-muted);text-transform:uppercase;letter-spacing:.06em;font-size:10px;padding:8px 12px;border-bottom:1px solid var(--border)}
.tool-agg-table td{padding:8px 12px;color:var(--text-sec);border-bottom:1px solid var(--border)}
.tool-agg-table tr:hover td{background:rgba(99,102,241,.04);color:var(--text)}
.tool-agg-table .tool-name{font-weight:600;color:var(--text);display:flex;align-items:center;gap:6px}
.tool-agg-table .tool-dot{width:8px;height:8px;border-radius:2px;flex-shrink:0}
.tool-agg-table .ms-val{font-family:var(--mono);font-weight:600}
.tool-agg-table .ms-val.fast{color:var(--green)}
.tool-agg-table .ms-val.medium{color:var(--amber)}
.tool-agg-table .ms-val.slow{color:var(--accent)}
.chart-legend .dot.violet{background:var(--violet)}
.chart-legend .dot.green{background:var(--green)}
.metrics-toolbar{display:flex;align-items:center;gap:8px;margin-bottom:16px;flex-wrap:wrap}
.range-btn{padding:5px 12px;border-radius:6px;border:1px solid var(--border);background:transparent;color:var(--text-sec);font-size:12px;font-weight:500;cursor:pointer;transition:all .15s}
.range-btn:hover{border-color:var(--pri);color:var(--pri)}
.range-btn.active{background:rgba(99,102,241,.08);color:var(--pri);border-color:rgba(99,102,241,.25)}

.theme-toggle{position:relative;width:28px;height:28px;padding:0;display:flex;align-items:center;justify-content:center;font-size:14px;border:none;background:transparent}
.theme-toggle .theme-icon-light{display:none}
.theme-toggle .theme-icon-dark{display:inline}
[data-theme="light"] .theme-toggle .theme-icon-light{display:inline}
[data-theme="light"] .theme-toggle .theme-icon-dark{display:none}

.auth-top-actions{position:absolute;top:16px;right:16px;z-index:10;display:flex;align-items:center;gap:2px}
.auth-theme-toggle{min-width:28px;height:28px;border:none;border-radius:14px;background:rgba(255,255,255,.12);color:rgba(255,255,255,.7);cursor:pointer;display:flex;align-items:center;justify-content:center;font-size:12px;transition:all .2s;padding:0 8px;font-weight:600}
.auth-theme-toggle:hover{background:rgba(255,255,255,.25);color:#fff}
.auth-theme-toggle .theme-icon-light{display:none}
.auth-theme-toggle .theme-icon-dark{display:inline}
[data-theme="light"] .auth-theme-toggle{color:rgba(0,0,0,.4);background:rgba(0,0,0,.05)}
[data-theme="light"] .auth-theme-toggle:hover{background:rgba(0,0,0,.1);color:#0f172a}
[data-theme="light"] .auth-top-actions{background:none}
[data-theme="light"] .auth-theme-toggle .theme-icon-light{display:inline}
[data-theme="light"] .auth-theme-toggle .theme-icon-dark{display:none}

@media(max-width:1100px){.analytics-cards{grid-template-columns:repeat(3,1fr)}}
@media(max-width:900px){.main-content{flex-direction:column;padding:20px}.sidebar{width:100%}.sidebar .stats-grid{grid-template-columns:repeat(4,1fr)}.analytics-cards{grid-template-columns:repeat(2,1fr)}.topbar-inner{padding:0 16px;gap:8px}.topbar .brand .brand-title{display:none}.topbar .brand .brand-powered{display:none}.topbar-center{justify-content:flex-start}}
</style>
</head>
<body>

<!-- ─── Auth: Setup Password ─── -->
<div id="setupScreen" class="auth-screen" style="display:none">
  <div class="auth-top-actions">
    <button class="auth-theme-toggle" onclick="toggleViewerTheme()" title="Toggle light/dark" aria-label="Toggle theme"><span class="theme-icon-dark">\u{1F319}</span><span class="theme-icon-light">\u2600</span></button>
    <button class="auth-theme-toggle" onclick="toggleLang()" aria-label="Switch language"><span data-i18n="lang.switch">EN</span></button>
  </div>
  <div class="auth-card">
    <div class="logo" style="display:flex;flex-direction:column;align-items:center;gap:10px">
      <svg width="56" height="56" viewBox="0 0 120 120" fill="none" xmlns="http://www.w3.org/2000/svg"><defs><linearGradient id="aLG" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="#ff4d4d"/><stop offset="100%" stop-color="#991b1b"/></linearGradient></defs><path d="M60 10C30 10 15 35 15 55C15 75 30 95 45 100L45 110L55 110L55 100C55 100 60 102 65 100L65 110L75 110L75 100C90 95 105 75 105 55C105 35 90 10 60 10Z" fill="url(#aLG)"/><path d="M20 45C5 40 0 50 5 60C10 70 20 65 25 55C28 48 25 45 20 45Z" fill="url(#aLG)"/><path d="M100 45C115 40 120 50 115 60C110 70 100 65 95 55C92 48 95 45 100 45Z" fill="url(#aLG)"/><path d="M45 15Q35 5 30 8" stroke="#ff4d4d" stroke-width="2" stroke-linecap="round"/><path d="M75 15Q85 5 90 8" stroke="#ff4d4d" stroke-width="2" stroke-linecap="round"/><circle cx="45" cy="35" r="6" fill="#050810"/><circle cx="75" cy="35" r="6" fill="#050810"/><circle cx="46" cy="34" r="2" fill="#00e5cc"/><circle cx="76" cy="34" r="2" fill="#00e5cc"/></svg>
    </div>
    <h1 data-i18n="title">OpenClaw Memory</h1>
    <p style="font-size:12px;color:var(--text-sec);margin-bottom:6px" data-i18n="subtitle">Powered by MemOS</p>
    <p data-i18n="setup.desc">Set a password to protect your memories</p>
    <input type="password" id="setupPw" data-i18n-ph="setup.pw" placeholder="Enter a password (4+ characters)" autofocus>
    <input type="password" id="setupPw2" data-i18n-ph="setup.pw2" placeholder="Confirm password">
    <button class="btn-auth" onclick="doSetup()" data-i18n="setup.btn">Set Password & Enter</button>
    <div class="error-msg" id="setupErr"></div>
  </div>
</div>

<!-- ─── Auth: Login ─── -->
<div id="loginScreen" class="auth-screen" style="display:none">
  <div class="auth-top-actions">
    <button class="auth-theme-toggle" onclick="toggleViewerTheme()" title="Toggle light/dark" aria-label="Toggle theme"><span class="theme-icon-dark">\u{1F319}</span><span class="theme-icon-light">\u2600</span></button>
    <button class="auth-theme-toggle" onclick="toggleLang()" aria-label="Switch language"><span data-i18n="lang.switch">EN</span></button>
  </div>
  <div class="auth-card">
    <div class="logo" style="display:flex;flex-direction:column;align-items:center;gap:10px">
      <svg width="56" height="56" viewBox="0 0 120 120" fill="none" xmlns="http://www.w3.org/2000/svg"><defs><linearGradient id="bLG" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="#ff4d4d"/><stop offset="100%" stop-color="#991b1b"/></linearGradient></defs><path d="M60 10C30 10 15 35 15 55C15 75 30 95 45 100L45 110L55 110L55 100C55 100 60 102 65 100L65 110L75 110L75 100C90 95 105 75 105 55C105 35 90 10 60 10Z" fill="url(#bLG)"/><path d="M20 45C5 40 0 50 5 60C10 70 20 65 25 55C28 48 25 45 20 45Z" fill="url(#bLG)"/><path d="M100 45C115 40 120 50 115 60C110 70 100 65 95 55C92 48 95 45 100 45Z" fill="url(#bLG)"/><path d="M45 15Q35 5 30 8" stroke="#ff4d4d" stroke-width="2" stroke-linecap="round"/><path d="M75 15Q85 5 90 8" stroke="#ff4d4d" stroke-width="2" stroke-linecap="round"/><circle cx="45" cy="35" r="6" fill="#050810"/><circle cx="75" cy="35" r="6" fill="#050810"/><circle cx="46" cy="34" r="2" fill="#00e5cc"/><circle cx="76" cy="34" r="2" fill="#00e5cc"/></svg>
    </div>
    <h1 data-i18n="title">OpenClaw Memory</h1>
    <p style="font-size:12px;color:var(--text-sec);margin-bottom:6px" data-i18n="subtitle">Powered by MemOS</p>
    <p data-i18n="login.desc">Enter your password to access memories</p>
    <div id="loginForm">
      <input type="password" id="loginPw" data-i18n-ph="login.pw" placeholder="Password" autofocus>
      <button class="btn-auth" onclick="doLogin()" data-i18n="login.btn">Unlock</button>
      <div class="error-msg" id="loginErr"></div>
      <button class="btn-text" style="margin-top:12px;font-size:13px;color:var(--text-sec)" onclick="showResetForm()" data-i18n="login.forgot">Forgot password?</button>
    </div>
    <div id="resetForm" style="display:none">
      <div class="reset-guide">
        <div class="reset-step">
          <div class="step-num">1</div>
          <div class="step-body">
            <div class="step-title" data-i18n="reset.step1.title">Open Terminal</div>
            <div class="step-desc" data-i18n="reset.step1.desc">Run the following command to get your reset token (use the pattern below so you get the line that contains the token):</div>
            <div class="cmd-box" onclick="copyCmd(this)">
              <code>grep "password reset token:" /tmp/openclaw/openclaw-*.log ~/.openclaw/logs/gateway.log 2>/dev/null | tail -1</code>
              <span class="copy-hint" data-i18n="copy.hint">Click to copy</span>
            </div>
          </div>
        </div>
        <div class="reset-step">
          <div class="step-num">2</div>
          <div class="step-body">
            <div class="step-title" data-i18n="reset.step2.title">Find the token</div>
            <div class="step-desc" id="resetStep2Desc">In the output, find <span style="font-family:monospace;font-size:12px;color:var(--pri)">password reset token: <strong>a1b2c3d4e5f6...</strong></span> (plain line or inside JSON). Copy the 32-character hex string after the colon.</div>
          </div>
        </div>
        <div class="reset-step">
          <div class="step-num">3</div>
          <div class="step-body">
            <div class="step-title" data-i18n="reset.step3.title">Paste & reset</div>
            <div class="step-desc" data-i18n="reset.step3.desc">Paste the token below and set your new password.</div>
          </div>
        </div>
      </div>
      <input type="text" id="resetToken" data-i18n-ph="reset.token" placeholder="Paste reset token here" style="margin-bottom:8px;font-family:monospace">
      <input type="password" id="resetNewPw" data-i18n-ph="reset.newpw" placeholder="New password (4+ characters)">
      <input type="password" id="resetNewPw2" data-i18n-ph="reset.newpw2" placeholder="Confirm new password">
      <button class="btn-auth" onclick="doReset()" data-i18n="reset.btn">Reset Password</button>
      <div class="error-msg" id="resetErr"></div>
      <button class="btn-text" style="margin-top:12px;font-size:13px;color:var(--text-sec)" onclick="showLoginForm()" data-i18n="reset.back">\u2190 Back to login</button>
    </div>
  </div>
</div>

<!-- ─── Main App ─── -->
<div class="app" id="app">
  <div class="topbar">
  <div class="topbar-inner">
    <div class="brand">
      <span class="memos-logo"><svg width="28" height="28" viewBox="0 0 120 120" fill="none" xmlns="http://www.w3.org/2000/svg"><defs><linearGradient id="topLG" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="#ff4d4d"/><stop offset="100%" stop-color="#991b1b"/></linearGradient></defs><path d="M60 10C30 10 15 35 15 55C15 75 30 95 45 100L45 110L55 110L55 100C55 100 60 102 65 100L65 110L75 110L75 100C90 95 105 75 105 55C105 35 90 10 60 10Z" fill="url(#topLG)"/><path d="M20 45C5 40 0 50 5 60C10 70 20 65 25 55C28 48 25 45 20 45Z" fill="url(#topLG)"/><path d="M100 45C115 40 120 50 115 60C110 70 100 65 95 55C92 48 95 45 100 45Z" fill="url(#topLG)"/><path d="M45 15Q35 5 30 8" stroke="#ff4d4d" stroke-width="2" stroke-linecap="round"/><path d="M75 15Q85 5 90 8" stroke="#ff4d4d" stroke-width="2" stroke-linecap="round"/><circle cx="45" cy="35" r="6" fill="#050810"/><circle cx="75" cy="35" r="6" fill="#050810"/><circle cx="46" cy="34" r="2" fill="#00e5cc"/><circle cx="76" cy="34" r="2" fill="#00e5cc"/></svg></span>
      <div class="brand-col"><span data-i18n="title" class="brand-title">OpenClaw 记忆</span><span data-i18n="subtitle" class="brand-powered">Powered by MemOS</span></div>${vBadge}
    </div>
    <div class="topbar-center">
      <nav class="nav-tabs">
        <button class="tab active" data-view="memories" onclick="switchView('memories')" data-i18n="tab.memories">\u{1F4DA} Memories</button>
        <button class="tab" data-view="tasks" onclick="switchView('tasks')" data-i18n="tab.tasks">\u{1F4CB} Tasks</button>
        <button class="tab" data-view="skills" onclick="switchView('skills')" data-i18n="tab.skills">\u{1F9E0} Skills</button>
        <button class="tab" data-view="analytics" onclick="switchView('analytics')" data-i18n="tab.analytics">\u{1F4CA} Analytics</button>
        <button class="tab" data-view="logs" onclick="switchView('logs')" data-i18n="tab.logs">\u{1F4DD} Logs</button>
        <button class="tab" data-view="import" onclick="switchView('import')" data-i18n="tab.import">\u{1F4E5} Import</button>
        <button class="tab" data-view="admin" onclick="switchView('admin')" data-i18n="tab.admin">\u{1F6E1} Admin<span id="adminPendingBadge" style="display:none;background:var(--rose);color:#fff;font-size:10px;font-weight:700;padding:1px 5px;border-radius:8px;margin-left:4px;vertical-align:top"></span></button>
        <button class="tab" data-view="settings" onclick="switchView('settings')" data-i18n="tab.settings">\u2699 Settings</button>
      </nav>
    </div>
    <div class="actions">
      <button class="btn btn-icon" onclick="toggleLang()" aria-label="Switch language" style="font-size:12px;font-weight:700;padding:4px 8px"><span data-i18n="lang.switch">EN</span></button>
      <button class="btn btn-icon theme-toggle" onclick="toggleViewerTheme()" title="Toggle light/dark" aria-label="Toggle theme"><span class="theme-icon-dark">\u{1F319}</span><span class="theme-icon-light">\u2600</span></button>
      <div style="position:relative;display:inline-block" id="notifBellWrap">
        <button class="notif-bell" onclick="toggleNotifPanel(event)" title="Notifications" aria-label="Notifications">\u{1F514}<span class="notif-badge" id="notifBadge"></span></button>
        <div class="notif-panel" id="notifPanel">
          <div class="notif-panel-header"><span data-i18n="notif.title">\u{1F514} Notifications</span><div style="display:flex;gap:6px"><button class="notif-mark-all" onclick="markAllNotifsRead()" data-i18n="notif.markAll">Mark all read</button><button class="notif-mark-all" onclick="clearAllNotifs()" style="color:var(--rose)" data-i18n="notif.clearAll">Clear all</button></div></div>
          <div class="notif-panel-body" id="notifPanelBody"><div class="notif-empty" data-i18n="notif.empty">No notifications</div></div>
        </div>
      </div>
      <button class="btn btn-ghost btn-sm" onclick="doLogout()" data-i18n="logout">Logout</button>
    </div>
    </div>
  </div>

  <div class="main-content">
    <div class="sidebar" id="sidebar">
      <div class="stats-grid" id="statsGrid">
        <div class="stat-card pri"><div class="stat-value" id="statTotal">-</div><div class="stat-label" data-i18n="stat.memories">Memories</div></div>
        <div class="stat-card green"><div class="stat-value" id="statTasks">-</div><div class="stat-label" data-i18n="stat.tasks">Tasks</div></div>
        <div class="stat-card amber"><div class="stat-value" id="statSkills">-</div><div class="stat-label" data-i18n="stat.skills">Skills</div></div>
        <div class="stat-card rose"><div class="stat-value" id="statAgents">-</div><div class="stat-label" data-i18n="stat.agents">Agents</div></div>
      </div>
      <div id="sidebarSharingSection" style="display:none">
        <div class="sharing-sidebar-card">
          <div class="title" style="display:flex;align-items:center;gap:8px"><span data-i18n="sidebar.hub">\u{1F310} Team Sharing</span><span id="sharingSidebarConnBadge"></span></div>
          <div class="status" id="sharingSidebarStatus"></div>
          <div class="hint" id="sharingSidebarHint"></div>
        </div>
      </div>
      <div id="embeddingStatus"></div>
      <button class="btn btn-sm btn-ghost" style="width:100%;margin:20px 0 12px;justify-content:center;color:var(--text-muted);font-size:11px" onclick="clearAll()" data-i18n="sidebar.clear">\u{1F5D1} Clear All Data</button>
    </div>

    <div class="view-container">
    <div class="feed-wrap vp show" id="feedWrap">
    <div class="feed">
      <div class="search-bar">
        <span class="search-icon">\u{1F50D}</span>
        <input type="text" id="searchInput" data-i18n-ph="search.placeholder" placeholder="Search memories (supports semantic search)..." oninput="debounceSearch()">
        <select id="filterOwner" class="filter-select" onchange="onOwnerFilterChange()">
          <option value="" data-i18n="filter.allagents">All agents</option>
        </select>
        <select id="memorySearchScope" class="filter-select" onchange="onMemoryScopeChange()" style="display:none">
          <option value="allLocal" data-i18n="scope.thisDevice">This Device</option>
          <option value="hub" data-i18n="scope.hub">Team</option>
        </select>
      </div>
      <div id="searchMeta" style="display:none"></div>
      <div id="sharingSearchMeta" style="display:none"></div>
      <div class="filter-bar compact-filter-row" id="filterBar" style="flex-wrap:nowrap">
        <button class="filter-chip active" data-role="" onclick="setRoleFilter(this,'')" data-i18n="filter.all">All</button>
        <button class="filter-chip" data-role="user" onclick="setRoleFilter(this,'user')">User</button>
        <button class="filter-chip" data-role="assistant" onclick="setRoleFilter(this,'assistant')">Assistant</button>
        <span class="filter-sep"></span>
        <select id="filterSort" class="filter-select" onchange="applyFilters()">
          <option value="newest" data-i18n="filter.newest">Newest first</option>
          <option value="oldest" data-i18n="filter.oldest">Oldest first</option>
        </select>
        <span style="flex:1"></span>
        <button class="filter-chip" id="memorySelectAllBtn" onclick="toggleSelectAllMemories()" data-i18n="skills.selectAll">Select All</button>
        <button class="filter-chip" id="memoryBulkDeleteBtn" onclick="deleteSelectedMemories()" style="display:none;color:#ef4444;border-color:rgba(239,68,68,.3)" data-i18n="memory.deleteSelected">Delete Selected</button>
      </div>
      <div class="filter-bar compact-filter-row" style="flex-wrap:nowrap;margin-bottom:12px">
        <input type="datetime-local" id="dateFrom" step="1" onchange="applyFilters()" class="compact-date" data-i18n-ph="filter.from" placeholder="From">
        <span style="color:var(--text-muted);font-size:12px">—</span>
        <input type="datetime-local" id="dateTo" step="1" onchange="applyFilters()" class="compact-date" data-i18n-ph="filter.to" placeholder="To">
        <button class="filter-chip" onclick="clearDateFilter()" data-i18n="filter.clear" style="font-size:11px;padding:4px 10px">Clear</button>
      </div>
      <div class="memory-list" id="memoryList"><div class="spinner"></div></div>
      <div class="pagination-row">
        <div class="pagination" id="pagination"></div>
      </div>
    </div>
    </div>
    <div class="tasks-view vp" id="tasksView">
      <div class="search-bar">
        <span class="search-icon">\u{1F50D}</span>
        <input type="text" id="taskSearchInput" data-i18n-ph="tasks.search.placeholder" placeholder="Search tasks..." oninput="debounceTaskSearch()">
        <select id="taskFilterOwner" class="filter-select" onchange="onOwnerFilterChange()">
          <option value="" data-i18n="filter.allagents">All agents</option>
        </select>
        <select id="taskSearchScope" class="scope-select" onchange="onTaskScopeChange()" style="display:none">
          <option value="allLocal" data-i18n="scope.thisDevice">This Device</option>
          <option value="hub" data-i18n="scope.hub">Team</option>
        </select>
      </div>
      <div id="taskSearchMeta" style="display:none"></div>
      <div class="filter-bar compact-filter-row" style="flex-wrap:nowrap">
        <button class="filter-chip active" data-task-status="" onclick="setTaskStatusFilter(this,'')" data-i18n="filter.all">All</button>
        <button class="filter-chip" data-task-status="active" onclick="setTaskStatusFilter(this,'active')" data-i18n="tasks.status.active">Active</button>
        <button class="filter-chip" data-task-status="completed" onclick="setTaskStatusFilter(this,'completed')" data-i18n="tasks.status.completed">Completed</button>
        <button class="filter-chip" data-task-status="skipped" onclick="setTaskStatusFilter(this,'skipped')" data-i18n="tasks.status.skipped">Skipped</button>
        <span style="flex:1"></span>
        <button class="filter-chip" id="taskSelectAllBtn" onclick="toggleSelectAllTasks()" data-i18n="skills.selectAll">Select All</button>
        <button class="filter-chip" id="taskBulkDeleteBtn" onclick="deleteSelectedTasks()" style="display:none;color:#ef4444;border-color:rgba(239,68,68,.3)" data-i18n="task.deleteSelected">Delete Selected</button>
      </div>
      <div class="tasks-list" id="tasksList"><div class="spinner"></div></div>
      <div class="pagination-row">
        <div class="pagination" id="tasksPagination"></div>
      </div>
      <div class="task-detail-overlay" id="taskDetailOverlay" onclick="closeTaskDetail(event)">
        <div class="task-detail-panel" onclick="event.stopPropagation()">
          <div class="task-detail-header">
            <h2 id="taskDetailTitle"></h2>
            <div style="display:flex;gap:8px;align-items:center">
              <div id="taskShareActions" style="display:flex;gap:8px;align-items:center"></div>
              <button class="btn btn-icon" onclick="closeTaskDetail()" title="Close">\u2715</button>
            </div>
          </div>
          <div class="task-detail-meta" id="taskDetailMeta"></div>
          <div class="task-skill-section" id="taskSkillSection"></div>
          <div class="task-detail-summary" id="taskDetailSummary"></div>
          <div class="task-detail-chunks-title" data-i18n="tasks.chunks">Related Memories</div>
          <div class="task-detail-chunks" id="taskDetailChunks"></div>
          <div id="taskDetailActions" style="display:flex;gap:8px;margin-top:16px;padding-top:12px;border-top:1px solid var(--border)"></div>
        </div>
      </div>
    </div>
    <div class="shared-memory-overlay" id="sharedMemoryOverlay" onclick="closeSharedMemoryDetail(event)">
      <div class="shared-memory-panel" onclick="event.stopPropagation()">
        <div class="task-detail-header">
          <h3 id="sharedMemoryTitle">Shared Memory</h3>
          <button class="btn btn-icon" onclick="closeSharedMemoryDetail()" title="Close">✕</button>
        </div>
        <div class="task-detail-meta" id="sharedMemoryMeta"></div>
        <div class="task-detail-summary" id="sharedMemorySummary"></div>
        <div class="content" id="sharedMemoryContent"></div>
      </div>
    </div>
    <div class="skills-view vp" id="skillsView">
      <div class="search-bar">
        <span class="search-icon">🔍</span>
        <input type="text" id="skillSearchInput" placeholder="Search skills..." data-i18n-ph="skills.search.placeholder" oninput="debounceSkillSearch()">
        <select id="skillFilterOwner" class="filter-select" onchange="onOwnerFilterChange()">
          <option value="" data-i18n="filter.allagents">All agents</option>
        </select>
        <select id="skillSearchScope" class="scope-select" onchange="onSkillScopeChange()" style="display:none">
          <option value="allLocal" data-i18n="scope.thisDevice">This Device</option>
          <option value="hub" data-i18n="scope.hub">Team</option>
        </select>
      </div>
      <div id="skillSearchMeta" style="display:none"></div>
      <div class="filter-bar compact-filter-row" style="flex-wrap:nowrap">
        <button class="filter-chip active" data-skill-status="" onclick="setSkillStatusFilter(this,'')" data-i18n="filter.all">All</button>
        <button class="filter-chip" data-skill-status="active" onclick="setSkillStatusFilter(this,'active')" data-i18n="skills.filter.active">Active</button>
        <button class="filter-chip" data-skill-status="draft" onclick="setSkillStatusFilter(this,'draft')" data-i18n="skills.filter.draft">Draft</button>
        <button class="filter-chip" data-skill-status="archived" onclick="setSkillStatusFilter(this,'archived')" data-i18n="skills.filter.archived">Archived</button>
        <select id="skillVisibilityFilter" class="filter-select" onchange="loadSkills()" style="display:none">
          <option value="" data-i18n="filter.allvisibility">All visibility</option>
          <option value="public" data-i18n="filter.public">Public</option>
          <option value="private" data-i18n="filter.private">Private</option>
        </select>
        <span style="flex:1"></span>
        <button class="filter-chip" id="skillSelectAllBtn" onclick="toggleSelectAllSkills()" data-i18n="skills.selectAll">Select All</button>
        <button class="filter-chip" id="skillBulkDeleteBtn" onclick="deleteSelectedSkills()" style="display:none;color:#ef4444;border-color:rgba(239,68,68,.3)" data-i18n="skills.deleteSelected">Delete Selected</button>
      </div>
      <div class="tasks-list" id="skillsList"><div class="spinner"></div></div>
      <div class="pagination-row">
        <div class="pagination" id="skillsPagination"></div>
      </div>
      <div id="hubSkillsSection" style="display:none;margin-top:16px">
        <div class="section-title" style="margin-bottom:12px" data-i18n="skills.hub.title">\u{1F310} Team Skills</div>
        <div class="tasks-list" id="hubSkillsList"></div>
      </div>
    </div>
    <div class="task-detail-overlay" id="skillDetailOverlay" onclick="closeSkillDetail(event)">
      <div class="task-detail-panel" onclick="event.stopPropagation()">
        <div class="task-detail-header">
          <h2 id="skillDetailTitle"></h2>
          <div style="display:flex;gap:8px;align-items:center">
            <span id="skillScopeBadge"></span>
            <button class="skill-vis-btn" id="skillVisibilityBtn" onclick="toggleSkillVisibility()"></button>
            <button class="skill-download-btn" id="skillDownloadBtn" onclick="downloadSkill()" data-i18n="skills.download">\u2B07 Download</button>
            <button class="btn btn-icon" onclick="closeSkillDetail()" title="Close">\u2715</button>
          </div>
        </div>
        <div class="task-detail-meta" id="skillDetailMeta"></div>
        <div class="skill-detail-desc" id="skillDetailDesc"></div>
        <div class="task-detail-chunks-title" data-i18n="skills.files">Skill Files</div>
        <div class="skill-files-list" id="skillFilesList"></div>
        <div class="task-detail-chunks-title" id="skillContentTitle" data-i18n="skills.content">SKILL.md Content</div>
        <div class="task-detail-summary" id="skillDetailContent" style="max-height:50vh;overflow-y:auto"></div>
        <div class="task-detail-chunks-title" data-i18n="skills.versions">Version History</div>
        <div class="task-detail-chunks" id="skillVersionsList" style="gap:10px"></div>
        <div class="task-detail-chunks-title" style="margin-top:16px" data-i18n="skills.related">Related Tasks</div>
        <div class="task-detail-chunks" id="skillRelatedTasks" style="gap:8px"></div>
        <div id="skillDetailActions" style="display:flex;gap:8px;margin-top:16px;padding-top:12px;border-top:1px solid var(--border)"></div>
      </div>
    </div>
    <div class="analytics-view vp" id="analyticsView">
      <div class="metrics-toolbar" style="margin-bottom:0">
        <span style="font-size:12px;color:var(--text-sec);font-weight:600" data-i18n="range">Range</span>
        <button class="range-btn" data-days="7" onclick="setMetricsDays(7)">7 <span data-i18n="range.days">days</span></button>
        <button class="range-btn active" data-days="30" onclick="setMetricsDays(30)">30 <span data-i18n="range.days">days</span></button>
        <button class="range-btn" data-days="90" onclick="setMetricsDays(90)">90 <span data-i18n="range.days">days</span></button>
        <button class="btn btn-sm" onclick="loadMetrics()" style="margin-left:auto" data-i18n="refresh">\u21BB Refresh</button>
      </div>
      <div class="analytics-cards" id="analyticsCards">
        <div class="analytics-card"><div class="ac-value" id="mTotal">-</div><div class="ac-label" data-i18n="analytics.total">Total Memories</div></div>
        <div class="analytics-card green"><div class="ac-value" id="mTodayWrites">-</div><div class="ac-label" data-i18n="analytics.writes">Writes Today</div></div>
        <div class="analytics-card"><div class="ac-value" id="mSessions">-</div><div class="ac-label" data-i18n="analytics.sessions">Sessions</div></div>
        <div class="analytics-card amber"><div class="ac-value" id="mEmbeddings">-</div><div class="ac-label" data-i18n="analytics.embeddings">Embeddings</div></div>
      </div>
      <div class="analytics-section">
        <h3><span class="icon">\u{1F4CA}</span> <span data-i18n="chart.writes">Memory Writes per Day</span></h3>
        <div class="chart-bars" id="chartWrites"></div>
      </div>
      
      <div class="analytics-section" id="toolPerfSection" style="position:relative">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:20px">
          <h3 style="margin-bottom:0"><span class="icon">\u26A1</span> <span data-i18n="chart.toolperf">Tool Response Time</span> <span style="font-size:10px;color:var(--text-muted);font-weight:500;text-transform:none;letter-spacing:0;margin-left:4px">(per minute avg)</span></h3>
          <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap">
            <button class="range-btn tool-range active" data-mins="60" onclick="setToolMinutes(60)">1h</button>
            <button class="range-btn tool-range" data-mins="360" onclick="setToolMinutes(360)">6h</button>
            <button class="range-btn tool-range" data-mins="1440" onclick="setToolMinutes(1440)">24h</button>
            <button class="range-btn tool-range" data-mins="4320" onclick="setToolMinutes(4320)">3d</button>
            <button class="range-btn tool-range" data-mins="10080" onclick="setToolMinutes(10080)">7d</button>
            <button class="range-btn tool-range" data-mins="43200" onclick="setToolMinutes(43200)">30d</button>
            <span style="color:var(--border);margin:0 2px">|</span>
            <input type="datetime-local" id="toolRangeFrom" style="font-size:11px;padding:3px 6px;border:1px solid var(--border);border-radius:6px;background:var(--bg-card);color:var(--text)" title="From">
            <span style="font-size:11px;color:var(--text-muted)">–</span>
            <input type="datetime-local" id="toolRangeTo" style="font-size:11px;padding:3px 6px;border:1px solid var(--border);border-radius:6px;background:var(--bg-card);color:var(--text)" title="To">
            <button class="range-btn" onclick="applyCustomToolRange()" data-i18n="chart.apply">Apply</button>
          </div>
        </div>
        <div id="toolChart" style="width:100%;height:280px;position:relative;overflow:hidden;border-radius:12px"></div>
        <div id="toolLegend" class="chart-legend" style="margin-top:14px;padding:0 4px"></div>
        <div id="toolAggTable" style="margin-top:20px"></div>
      </div>

    </div>

    <!-- ─── Logs View ─── -->
    <div class="logs-view vp" id="logsView">
      <div class="logs-toolbar">
        <div class="logs-toolbar-left">
          <select id="logToolFilter" onchange="onLogFilterChange()" style="font-size:12px;padding:4px 8px;border-radius:6px;border:1px solid var(--border);background:var(--card);color:var(--text);min-width:120px">
            <option value="" data-i18n="logs.allTools">All Tools</option>
          </select>
          
        </div>
        <div class="logs-toolbar-right">
          <input type="checkbox" id="logAutoRefresh" style="display:none">
        </div>
      </div>
      <div class="logs-list" id="logsList"></div>
      <div id="logsPagination"></div>
    </div>

    <!-- ─── Settings View ─── -->
    <div class="settings-view vp" id="settingsView">
      <div class="settings-tabs-bar">
        <button class="settings-tab-btn active" data-tab="models" onclick="switchSettingsTab('models',this)"><span class="stab-dot"></span><span data-i18n="settings.models">AI Models</span></button>
        <button class="settings-tab-btn" data-tab="hub" onclick="switchSettingsTab('hub',this)"><span class="stab-dot"></span><span data-i18n="settings.hub">Team Sharing</span></button>
        <button class="settings-tab-btn" data-tab="general" onclick="switchSettingsTab('general',this)"><span class="stab-dot"></span><span data-i18n="settings.general">General</span></button>
      </div>
      <div class="settings-cards-grid">

        <!-- ══ Card: AI Models (Embedding + Summarizer + Skill) ══ -->
        <div class="settings-card card-models stab-active" data-stab="models">
          <div class="settings-card-header">
            <div class="settings-card-icon" style="background:rgba(99,102,241,.1);border-color:rgba(99,102,241,.15)">\u{1F9E0}</div>
            <div class="settings-card-title-wrap">
              <div class="settings-card-title" data-i18n="settings.models">AI Models</div>
              <div class="settings-card-desc" data-i18n="settings.models.desc">Configure embedding, summarizer and skill evolution models</div>
            </div>
          </div>
          <div class="settings-card-body">
            <!-- Embedding Model section -->
            <div class="settings-card-subtitle">\u{1F4E1} <span data-i18n="settings.embedding">Embedding Model</span></div>
            <div class="field-hint" style="margin-bottom:10px" data-i18n="settings.embedding.desc">Vector embedding model for memory search and retrieval</div>
            <div class="settings-grid">
              <div class="settings-field">
                <label data-i18n="settings.provider">Provider</label>
                <select id="cfgEmbProvider" onchange="onProviderChange('embedding')">
                  <option value="openai_compatible">OpenAI Compatible</option>
                  <option value="openai">OpenAI</option>
                  <option value="siliconflow">SiliconFlow (\u7845\u57FA\u6D41\u52A8)</option>
                  <option value="zhipu">Zhipu AI (\u667A\u8C31)</option>
                  <option value="bailian">Alibaba Bailian (\u767E\u70BC)</option>
                  <option value="gemini">Gemini</option>
                  <option value="azure_openai">Azure OpenAI</option>
                  <option value="cohere">Cohere</option>
                  <option value="mistral">Mistral</option>
                  <option value="voyage">Voyage</option>
                  <option value="local">Local</option>
                  <option value="openclaw">OpenClaw Host</option>
                </select>
              </div>
              <div class="settings-field">
                <label data-i18n="settings.model">Model</label>
                <input type="text" id="cfgEmbModel" placeholder="e.g. bge-m3">
              </div>
              <div class="settings-field full-width">
                <label>Endpoint</label>
                <input type="text" id="cfgEmbEndpoint" placeholder="https://...">
              </div>
              <div class="settings-field">
                <label>API Key</label>
                <input type="password" id="cfgEmbApiKey" placeholder="\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022">
              </div>
            </div>
            <div class="test-conn-row">
              <button class="btn btn-sm btn-ghost" onclick="testModel('embedding')" id="testEmbBtn" data-i18n="settings.test">Test Connection</button>
              <span class="test-result" id="testEmbResult"></span>
        </div>

            <div class="settings-card-divider"></div>

            <!-- Summarizer Model section -->
            <div class="settings-card-subtitle">\u{1F4DD} <span data-i18n="settings.summarizer">Summarizer Model</span></div>
            <div class="field-hint" style="margin-bottom:10px" data-i18n="settings.summarizer.desc">LLM for memory summarization, deduplication and analysis</div>
            <div class="settings-grid">
              <div class="settings-field">
                <label data-i18n="settings.provider">Provider</label>
                <select id="cfgSumProvider" onchange="onProviderChange('summarizer')">
                  <option value="openai_compatible">OpenAI Compatible</option>
                  <option value="openai">OpenAI</option>
                  <option value="siliconflow">SiliconFlow (\u7845\u57FA\u6D41\u52A8)</option>
                  <option value="zhipu">Zhipu AI (\u667A\u8C31)</option>
                  <option value="deepseek">DeepSeek</option>
                  <option value="bailian">Alibaba Bailian (\u767E\u70BC)</option>
                  <option value="moonshot">Moonshot (Kimi)</option>
                  <option value="anthropic">Anthropic</option>
                  <option value="gemini">Gemini</option>
                  <option value="azure_openai">Azure OpenAI</option>
                  <option value="bedrock">Bedrock</option>
                  <option value="openclaw">OpenClaw Host</option>
                </select>
              </div>
              <div class="settings-field">
                <label data-i18n="settings.model">Model</label>
                <input type="text" id="cfgSumModel" placeholder="e.g. gpt-4o-mini">
              </div>
              <div class="settings-field full-width">
                <label>Endpoint</label>
                <input type="text" id="cfgSumEndpoint" placeholder="https://...">
              </div>
              <div class="settings-field">
                <label>API Key</label>
                <input type="password" id="cfgSumApiKey" placeholder="\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022">
              </div>
              <div class="settings-field">
                <label data-i18n="settings.temperature">Temperature</label>
                <input type="number" id="cfgSumTemp" step="0.1" min="0" max="2" placeholder="0">
              </div>
            </div>
            <div class="test-conn-row">
              <button class="btn btn-sm btn-ghost" onclick="testModel('summarizer')" id="testSumBtn" data-i18n="settings.test">Test Connection</button>
              <span class="test-result" id="testSumResult"></span>
        </div>

            <div class="settings-card-divider"></div>

            <!-- Skill Evolution section -->
            <div class="settings-card-subtitle">\u{1F527} <span data-i18n="settings.skill">Skill Evolution</span></div>
            <div class="field-hint" style="margin-bottom:10px" data-i18n="settings.skill.desc">Auto-extract reusable skills from conversation patterns</div>
            <div class="settings-grid">
              <div class="settings-toggle">
                <label class="toggle-switch"><input type="checkbox" id="cfgSkillEnabled"><span class="toggle-slider"></span></label>
                <label data-i18n="settings.skill.enabled">Enable Skill Evolution</label>
              </div>
              <div class="settings-toggle">
                <label class="toggle-switch"><input type="checkbox" id="cfgSkillAutoInstall"><span class="toggle-slider"></span></label>
                <label data-i18n="settings.skill.autoinstall">Auto Install Skills</label>
              </div>
              <div class="settings-field">
                <label data-i18n="settings.skill.confidence">Min Confidence</label>
                <input type="number" id="cfgSkillConfidence" step="0.1" min="0" max="1" placeholder="0.7">
              </div>
              <div class="settings-field">
                <label data-i18n="settings.skill.minchunks">Min Chunks</label>
                <input type="number" id="cfgSkillMinChunks" placeholder="6">
              </div>
            </div>
            <div style="margin-top:14px">
              <div class="settings-card-subtitle" style="margin-bottom:4px" data-i18n="settings.skill.model">Skill Dedicated Model</div>
            <div class="field-hint" style="margin-bottom:12px" data-i18n="settings.skill.model.hint">If not configured, the main Summarizer Model above will be used for skill generation. Configure a dedicated model here for higher quality skill output.</div>
            <div class="settings-grid">
              <div class="settings-field">
                <label data-i18n="settings.provider">Provider</label>
                <select id="cfgSkillProvider" onchange="onProviderChange('skill')">
                  <option value="">\u2014 <span data-i18n="settings.skill.usemain">Use main summarizer</span> \u2014</option>
                  <option value="openai_compatible">OpenAI Compatible</option>
                  <option value="openai">OpenAI</option>
                  <option value="siliconflow">SiliconFlow (\u7845\u57FA\u6D41\u52A8)</option>
                  <option value="zhipu">Zhipu AI (\u667A\u8C31)</option>
                  <option value="deepseek">DeepSeek</option>
                  <option value="bailian">Alibaba Bailian (\u767E\u70BC)</option>
                  <option value="moonshot">Moonshot (Kimi)</option>
                  <option value="anthropic">Anthropic</option>
                  <option value="gemini">Gemini</option>
                  <option value="azure_openai">Azure OpenAI</option>
                  <option value="bedrock">Bedrock</option>
                  <option value="openclaw">OpenClaw Host</option>
                </select>
              </div>
              <div class="settings-field">
                <label data-i18n="settings.model">Model</label>
                <input type="text" id="cfgSkillModel" placeholder="e.g. claude-4.6-opus">
              </div>
              <div class="settings-field full-width">
                <label>Endpoint</label>
                <input type="text" id="cfgSkillEndpoint" placeholder="https://...">
              </div>
              <div class="settings-field">
                <label>API Key</label>
                <input type="password" id="cfgSkillApiKey" placeholder="\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022">
              </div>
            </div>
            <div class="test-conn-row">
              <button class="btn btn-sm btn-ghost" onclick="testModel('skill')" id="testSkillBtn" data-i18n="settings.test">Test Connection</button>
              <span class="test-result" id="testSkillResult"></span>
            </div>
            </div>

            <div class="settings-actions">
              <span class="settings-saved" id="modelsSaved">\u2713 <span data-i18n="settings.saved">Saved</span></span>
              <button class="btn btn-ghost" onclick="loadConfig()" data-i18n="settings.reset">Reset</button>
              <button class="btn btn-primary" onclick="saveModelsConfig()" data-i18n="settings.save">Save Settings</button>
            </div>
            <div style="font-size:11px;color:var(--text-muted);text-align:right;margin-top:4px" data-i18n="settings.restart.hint">Some changes require restarting the OpenClaw gateway to take effect.</div>
          </div>
        </div>

        <!-- ══ Card: Team Sharing ══ -->
        <div class="settings-card card-hub" id="settingsSharingConfig" data-stab="hub">
          <div class="settings-card-header">
            <div class="settings-card-icon" style="background:rgba(6,182,212,.1);border-color:rgba(6,182,212,.15)">\u{1F310}</div>
            <div class="settings-card-title-wrap">
              <div class="settings-card-title" data-i18n="settings.hub">Team Sharing</div>
              <div class="settings-card-desc" data-i18n="settings.hub.desc">Share memories, tasks and skills with your team</div>
            </div>
          </div>
          <div class="settings-card-body">
            <!-- team setup guide (inside Hub card) — always visible when sharing is not configured -->
            <div class="team-guide" id="teamSetupGuide">
              <div class="team-guide-title">\u{1F680} <span data-i18n="guide.title">Get Started with Team Collaboration</span></div>
              <div class="team-guide-subtitle" data-i18n="guide.subtitle">MemOS supports team memory sharing. Choose one of the following options to enable collaboration, or continue using local-only mode.</div>
              <div class="team-guide-options">
                <div class="team-guide-opt">
                  <div class="team-guide-opt-header">
                    <div class="team-guide-opt-icon" style="background:rgba(6,182,212,.1);border:1px solid rgba(6,182,212,.15)">\u{1F310}</div>
                    <div class="team-guide-opt-title" data-i18n="guide.join.title">Join a Remote Team</div>
                  </div>
                  <div class="team-guide-opt-desc" data-i18n="guide.join.desc">Your team already has a server running? Join it to share memories, tasks and skills with team members.</div>
                  <ol class="team-guide-steps">
                    <li><span data-i18n="guide.join.s1">Ask your team admin for the Server Address and Team Token</span></li>
                    <li><span data-i18n="guide.join.s2">Enable sharing above, select "Client" mode</span></li>
                    <li><span data-i18n="guide.join.s3">Fill in Server Address and Team Token, click "Test Connection"</span></li>
                    <li><span data-i18n="guide.join.s4">Click "Save & Apply" — the service restarts automatically (page refreshes)</span></li>
                  </ol>
                  <button class="btn-guide" onclick="guideGoToHub('client')" data-i18n="guide.join.btn">\u2192 Configure Client Mode</button>
                </div>
                <div class="team-guide-opt">
                  <div class="team-guide-opt-header">
                    <div class="team-guide-opt-icon" style="background:rgba(139,92,246,.1);border:1px solid rgba(139,92,246,.15)">\u{1F5A5}\uFE0F</div>
                    <div class="team-guide-opt-title" data-i18n="guide.hub.title">Start Your Own Team Server</div>
                  </div>
                  <div class="team-guide-opt-desc" data-i18n="guide.hub.desc">Be the team server. Run it on this device so others can connect and share memories with you.</div>
                  <ol class="team-guide-steps">
                    <li><span data-i18n="guide.hub.s1">Enable sharing above, select "Server" mode</span></li>
                    <li><span data-i18n="guide.hub.s2">Set a team name, click "Save & Apply" — the service restarts automatically</span></li>
                    <li><span data-i18n="guide.hub.s3">Share the Server Address and Team Token with your team members</span></li>
                    <li><span data-i18n="guide.hub.s4">Approve join requests in the Admin Panel</span></li>
                  </ol>
                  <button class="btn-guide" onclick="guideGoToHub('hub')" data-i18n="guide.hub.btn">\u2192 Configure Server Mode</button>
                </div>
              </div>
            </div>

            <div class="field-hint" style="margin-bottom:12px" data-i18n="settings.hub.enable.hint">Enable to share memories, tasks and skills with your team. When disabled, all features work normally in local-only mode.</div>
            <div class="settings-toggle" style="margin-bottom:16px">
              <label class="toggle-switch">
                <input type="checkbox" id="cfgSharingEnabled" onchange="onSharingToggle()">
                <span class="toggle-slider"></span>
              </label>
              <label data-i18n="settings.hub.enable.label">Enable Team Sharing</label>
            </div>

            <div id="sharingConfigPanel" style="display:none">
              <div style="margin-bottom:14px">
                <label style="font-size:11px;font-weight:600;color:var(--text-muted);text-transform:uppercase;letter-spacing:.04em;display:block;margin-bottom:6px" data-i18n="settings.hub.role">Role</label>
                <div style="display:flex;gap:8px">
                  <button class="btn btn-sm" id="btnRoleHub" onclick="selectSharingRole('hub')" data-i18n="settings.hub.role.hub">Server (Host a team)</button>
                  <button class="btn btn-sm" id="btnRoleClient" onclick="selectSharingRole('client')" data-i18n="settings.hub.role.client">Client (Join a team)</button>
                </div>
                <div class="field-hint" style="margin-top:6px" data-i18n="settings.hub.role.hint">Server = host the team server; Client = join an existing team. These two modes are mutually exclusive.</div>
              </div>

              <div id="hubModeConfig" style="display:none">
                <input type="hidden" id="cfgHubTeamToken" value="">
                <div class="settings-grid">
                  <div class="settings-field">
                    <label data-i18n="settings.hub.port">Server Port</label>
                    <input type="number" id="cfgHubPort" placeholder="18800" value="18800">
                    <div class="field-hint" data-i18n="settings.hub.port.hint">Port for team server. Default: 18800</div>
                  </div>
                  <div class="settings-field">
                    <label data-i18n="settings.hub.teamName">Team Name</label>
                    <input type="text" id="cfgHubTeamName" placeholder="My Team">
                    <div class="field-hint" data-i18n="settings.hub.teamName.hint">Your team display name</div>
                  </div>
                  <div class="settings-field">
                    <label data-i18n="settings.hub.adminName">Admin Name</label>
                    <input type="text" id="cfgHubAdminName" placeholder="" maxlength="32">
                    <div class="field-hint" data-i18n="settings.hub.adminName.hint">Your display name as team admin</div>
                  </div>
                </div>
                <div id="hubShareInfo" style="display:none;margin-top:14px;background:var(--bg);border:1px solid var(--border);border-radius:10px;padding:14px 18px">
                  <div style="font-size:11px;font-weight:600;color:var(--text-muted);text-transform:uppercase;letter-spacing:.04em;margin-bottom:10px" data-i18n="settings.hub.shareInfo.title">Share this info with your team members:</div>
                  <div id="hubShareInfoContent" style="display:grid;grid-template-columns:auto 1fr;gap:6px 12px;font-size:12px;align-items:center"></div>
                </div>
                <div style="margin-top:16px;display:flex;align-items:center;gap:12px">
                  <button class="btn btn-sm btn-primary" onclick="switchView('admin')" id="hubAdminEntryBtn" style="display:none" data-i18n="sharing.openAdmin">\u{1F6E1} Open Admin Panel</button>
                </div>
              </div>

              <div id="clientModeConfig" style="display:none">
                <div style="background:rgba(99,102,241,.08);border:1px solid rgba(99,102,241,.2);border-radius:10px;padding:14px 18px;margin-bottom:14px;font-size:12px;line-height:1.7;color:var(--text-sec)">
                  <div style="font-weight:700;color:var(--text);margin-bottom:4px" data-i18n="settings.hub.clientSteps.title">Quick Setup (3 steps)</div>
                  <div><span style="color:var(--accent)">1.</span> <span data-i18n="settings.hub.clientSteps.s1">Ask your team admin for the Server Address and Team Token</span></div>
                  <div><span style="color:var(--accent)">2.</span> <span data-i18n="settings.hub.clientSteps.s2">Fill them in below, click "Test Connection" to verify</span></div>
                  <div><span style="color:var(--accent)">3.</span> <span data-i18n="settings.hub.clientSteps.s3">Click "Save & Apply" — the service will restart and page refreshes automatically</span></div>
                </div>
                <div class="settings-grid">
                  <div class="settings-field full-width">
                    <label data-i18n="settings.hub.hubAddress">Server Address</label>
                    <input type="text" id="cfgClientHubAddress" placeholder="e.g. 192.168.1.100:18800">
                    <div class="field-hint" data-i18n="settings.hub.hubAddress.hint">Team server address, e.g. 192.168.1.100:18800</div>
                  </div>
                  <div class="settings-field">
                    <label data-i18n="settings.hub.teamTokenClient">Team Token</label>
                    <input type="text" id="cfgClientTeamToken" placeholder="">
                    <div class="field-hint" data-i18n="settings.hub.teamTokenClient.hint">Get this from your team admin to join</div>
                  </div>
                  <div class="settings-field">
                    <label data-i18n="settings.hub.nickname">Nickname</label>
                    <input type="text" id="cfgClientNickname" placeholder="" maxlength="32">
                    <div class="field-hint" data-i18n="settings.hub.nickname.hint">Your display name in the team. If empty, uses system username.</div>
                  </div>
                  <input type="hidden" id="cfgClientUserToken" value="">
                </div>
                <div style="margin-top:12px">
                  <button class="btn btn-sm btn-primary" id="btnTestHubConn" onclick="testHubConnection()" data-i18n="settings.hub.testConnection">Test Connection</button>
                  <span id="hubConnTestResult" style="margin-left:10px;font-size:12px"></span>
                </div>
              </div>
            </div>

            <div id="sharingPanelsWrap" style="display:none">
            <div class="settings-card-divider"></div>
            <div id="sharingStatusPanel"></div>
            <div id="sharingTeamPanel"></div>
            <div id="sharingAdminPanel"></div>
            </div>

            <div class="settings-actions">
              <span class="settings-saved" id="hubSaved">\u2713 <span data-i18n="settings.saved">Saved</span></span>
              <button class="btn btn-ghost" onclick="loadConfig()" data-i18n="settings.reset">Reset</button>
              <button class="btn btn-primary" onclick="saveHubConfig()" data-i18n="settings.save">Save Settings</button>
            </div>
            <div style="font-size:11px;color:var(--text-muted);text-align:right;margin-top:4px" data-i18n="settings.restart.hint">Some changes require restarting the OpenClaw gateway to take effect.</div>
          </div>
        </div>

        <!-- ══ Card: General ══ -->
        <div class="settings-card card-general" id="settingsModelConfig" data-stab="general">
          <div class="settings-card-header">
            <div class="settings-card-icon" style="background:rgba(16,185,129,.1);border-color:rgba(16,185,129,.15)">\u2699\uFE0F</div>
            <div class="settings-card-title-wrap">
              <div class="settings-card-title" data-i18n="settings.general">General</div>
              <div class="settings-card-desc" data-i18n="settings.general.desc">System status, ports and telemetry</div>
            </div>
          </div>
          <div class="settings-card-body">
            <div class="settings-card-subtitle" data-i18n="settings.modelhealth">\u{1F4CA} Model Health</div>
            <div class="model-health-bar" id="modelHealthBar">
              <div style="font-size:12px;color:var(--text-muted);width:100%">Loading model status...</div>
            </div>
            <div class="settings-card-divider"></div>
            <div class="settings-grid">
              <div class="settings-field">
                <label data-i18n="settings.viewerport">Viewer Port</label>
                <input type="number" id="cfgViewerPort" placeholder="18799">
                <div class="field-hint" data-i18n="settings.viewerport.hint">Requires restart to take effect</div>
              </div>
              <div class="settings-field">
                <label data-i18n="settings.taskAutoFinalize">Task Auto-Finalize (hours)</label>
                <input type="number" id="cfgTaskAutoFinalizeHours" placeholder="4" min="0" step="1" style="max-width:120px" onkeydown="if(['-','e','E','+'].includes(event.key))event.preventDefault()" oninput="this.value=this.value.replace(/[^0-9]/g,'')">
                <div class="field-hint" data-i18n="settings.taskAutoFinalize.hint">Active tasks with no new messages beyond this duration will be automatically summarized and completed when the Tasks page is opened. Set to 0 to disable. Default: 4 hours.</div>
              </div>
            </div>
            <div class="settings-card-divider"></div>
            <div class="settings-toggle">
              <label class="toggle-switch"><input type="checkbox" id="cfgTelemetryEnabled" checked><span class="toggle-slider"></span></label>
              <label data-i18n="settings.telemetry.enabled">Enable Anonymous Telemetry</label>
            </div>
            <div class="field-hint" style="margin-top:6px" data-i18n="settings.telemetry.hint">Anonymous usage analytics to help improve the plugin. Only sends tool names, latencies, and version info. No memory content, queries, or personal data is ever sent.</div>

            <div class="settings-actions">
              <span class="settings-saved" id="generalSaved">\u2713 <span data-i18n="settings.saved">Saved</span></span>
              <button class="btn btn-ghost" onclick="loadConfig()" data-i18n="settings.reset">Reset</button>
              <button class="btn btn-primary" onclick="saveGeneralConfig()" data-i18n="settings.save">Save Settings</button>
            </div>
          </div>
        </div>

      </div>


    </div>

    <!-- ─── Admin Page ─── -->
    <div class="admin-view vp" id="adminView">
      <div id="adminNotEnabled" style="display:none"></div>
      <div id="adminMainContent">
      <div class="admin-header">
        <div class="admin-header-top">
            <h2><span class="ah-icon">\u{26A1}</span> <span data-i18n="admin.title">Team Admin Panel</span></h2>
        </div>
          <div class="admin-header-sub" data-i18n="admin.subtitle">Manage team members and shared resources</div>
        <div class="admin-stat-row" id="adminStats"></div>
      </div>
      <div class="admin-tabs" id="adminTabsBar">
        <button class="admin-tab active" onclick="switchAdminTab('users',this)"><span class="at-icon">\u{1F465}</span> <span data-i18n="admin.tab.users">Users</span> <span class="at-count" id="adminTabCountUsers">0</span></button>
          <button class="admin-tab" onclick="switchAdminTab('memories',this)"><span class="at-icon">\u{1F4AD}</span> <span data-i18n="admin.tab.memories">Shared Memories</span> <span class="at-count" id="adminTabCountMemories">0</span></button>
          <button class="admin-tab" onclick="switchAdminTab('tasks',this)"><span class="at-icon">\u{1F4CB}</span> <span data-i18n="admin.tab.tasks">Shared Tasks</span> <span class="at-count" id="adminTabCountTasks">0</span></button>
        <button class="admin-tab" onclick="switchAdminTab('skills',this)"><span class="at-icon">\u{1F9E0}</span> <span data-i18n="admin.tab.skills">Shared Skills</span> <span class="at-count" id="adminTabCountSkills">0</span></button>
      </div>
      <div class="admin-panel active" id="adminUsersPanel"></div>
        <div class="admin-panel" id="adminTasksPanel"></div>
      <div class="admin-panel" id="adminMemoriesPanel"></div>
      <div class="admin-panel" id="adminSkillsPanel"></div>
      </div>
    </div>

    <!-- ─── Import Page ─── -->
    <div class="migrate-view vp" id="migrateView">
      <div class="settings-section" style="border:1px solid rgba(99,102,241,.15)">
        <h3><span class="icon">\u{1F4E5}</span> <span data-i18n="migrate.title">Import OpenClaw Memory</span></h3>
        <p style="font-size:12px;color:var(--text-sec);margin-bottom:12px;line-height:1.6" data-i18n="migrate.desc">Migrate your existing OpenClaw built-in memories and conversation history into this plugin. The import process uses smart deduplication to avoid duplicates.</p>

        <div style="background:var(--bg);border:1px solid var(--border);border-radius:10px;padding:14px 18px;margin-bottom:16px;font-size:12px;line-height:1.7;color:var(--text-sec)">
          <div style="font-weight:700;color:var(--text);margin-bottom:8px" data-i18n="migrate.modes.title">Three ways to use:</div>
          <div style="display:flex;flex-direction:column;gap:6px">
            <div><span style="font-weight:600;color:var(--accent)" data-i18n="migrate.mode1.label">\u2460 Import memories only (fast)</span><span data-i18n="migrate.mode1.desc"> — Click "Start Import" to quickly migrate all memory chunks and conversations. No task/skill generation. Suitable when you just need the raw data.</span></div>
            <div><span style="font-weight:600;color:var(--accent)" data-i18n="migrate.mode2.label">\u2461 Import + generate tasks & skills (slow, serial)</span><span data-i18n="migrate.mode2.desc"> — After importing memories, enable "Generate Tasks" and/or "Trigger Skill Evolution" below to analyze conversations one by one. This takes longer as each session is processed by LLM sequentially.</span></div>
            <div><span style="font-weight:600;color:var(--accent)" data-i18n="migrate.mode3.label">\u2462 Import first, generate later (flexible)</span><span data-i18n="migrate.mode3.desc"> — Import memories now, then come back anytime to start task/skill generation. You can pause the generation at any point and resume later — it will pick up where you left off, only processing sessions that haven't been handled yet.</span></div>
          </div>
        </div>

        <div id="migrateConfigWarn" style="display:none;background:rgba(245,158,11,.08);border:1px solid rgba(245,158,11,.3);border-radius:10px;padding:14px 18px;margin-bottom:16px">
          <div style="font-size:12px;font-weight:600;color:#f59e0b;margin-bottom:6px">\u26A0 <span data-i18n="migrate.config.warn">Configuration Required</span></div>
          <div style="font-size:11px;color:var(--text-sec);line-height:1.5" data-i18n="migrate.config.warn.desc">Please configure both Embedding Model and Summarizer Model in Settings before importing. These are required for processing memories.</div>
        </div>

        <div id="migrateScanResult" style="display:none;margin-bottom:16px">
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
            <div style="background:var(--bg);border:1px solid var(--border);border-radius:10px;padding:14px 18px">
              <div style="font-size:10px;text-transform:uppercase;letter-spacing:.05em;color:var(--text-muted);margin-bottom:6px" data-i18n="migrate.sqlite.label">Memory Index (SQLite)</div>
              <div style="font-size:22px;font-weight:700;color:var(--text)" id="migrateSqliteCount">0</div>
              <div style="font-size:10px;color:var(--text-muted);margin-top:2px" id="migrateSqliteFiles"></div>
            </div>
            <div style="background:var(--bg);border:1px solid var(--border);border-radius:10px;padding:14px 18px">
              <div style="font-size:10px;text-transform:uppercase;letter-spacing:.05em;color:var(--text-muted);margin-bottom:6px" data-i18n="migrate.sessions.label">Conversation History</div>
              <div style="font-size:22px;font-weight:700;color:var(--text)" id="migrateSessionCount">0</div>
              <div style="font-size:10px;color:var(--text-muted);margin-top:2px" id="migrateSessionFiles"></div>
            </div>
          </div>
        </div>

        <div id="migrateActions" style="display:flex;gap:10px 16px;align-items:center;flex-wrap:wrap">
          <button class="btn" onclick="migrateScan(true)" id="migrateScanBtn" style="background:var(--bg);border:1px solid var(--border);color:var(--text);font-weight:600;padding:7px 18px;cursor:pointer" data-i18n="migrate.scan">Scan Data Sources</button>
          <div id="migrateStartConcurrencyWrap" style="display:none;align-items:center;gap:12px;flex-wrap:wrap;flex-shrink:0">
            <button class="btn btn-primary" onclick="migrateStart()" id="migrateStartBtn" style="display:inline-flex" data-i18n="migrate.start">Start Import</button>
            <span id="migrateConcurrencyRow" style="display:flex;align-items:center;gap:8px;flex-shrink:0;min-width:max-content">
              <span style="font-size:11px;color:var(--text-muted);white-space:nowrap" data-i18n="migrate.concurrency.label">Concurrent agents</span>
              <select id="migrateConcurrency" class="filter-select" style="min-width:auto;padding:3px 28px 3px 10px;font-size:11px">
                <option value="1" selected>1</option>
                <option value="2">2</option>
                <option value="4">4</option>
                <option value="8">8</option>
              </select>
            </span>
          </div>
          <span id="migrateStatus" style="font-size:11px;color:var(--text-muted)"></span>
        </div>
        <div id="migrateConcurrencyWarn" style="display:none;margin-top:8px;padding:8px 12px;background:rgba(245,158,11,.06);border:1px solid rgba(245,158,11,.2);border-radius:8px;font-size:11px;color:#f59e0b;line-height:1.5">
          <span data-i18n="migrate.concurrency.warn">\u26A0 Increasing concurrency raises LLM API call frequency, which may trigger rate limits and cause failures.</span>
        </div>

        <!-- Post-process section: shown after import completes -->
        <div id="postprocessSection" style="display:none;margin-top:16px">
          <div class="settings-section" style="border:1px solid var(--border)">
            <div style="font-size:14px;font-weight:700;color:var(--text);margin-bottom:6px" data-i18n="pp.title">\u{1F9E0} Optional: Generate Tasks & Skills</div>
            <div style="font-size:12px;color:var(--text-sec);margin-bottom:14px;line-height:1.6" data-i18n="pp.desc">This step is completely optional. The import above has already stored raw memory data. Here you can further analyze imported conversations to generate structured task summaries and evolve reusable skills. Processing is serial (one session at a time) and may take a while. You can stop at any time and resume later — it will only process sessions not yet handled.</div>
            <div style="display:flex;flex-direction:column;gap:8px;margin-bottom:14px">
              <label style="display:flex;align-items:flex-start;gap:8px;cursor:pointer">
                <input type="checkbox" id="ppEnableTasks" checked style="accent-color:var(--accent);margin-top:2px">
                <div>
                  <div style="font-size:12px;font-weight:600;color:var(--text)" data-i18n="pp.tasks.label">Generate task summaries</div>
                  <div style="font-size:11px;color:var(--text-sec);line-height:1.4" data-i18n="pp.tasks.hint">Group imported messages into tasks and generate a structured summary (title, goal, steps, result) for each one. Makes it easier to search and recall past work.</div>
                </div>
              </label>
              <label style="display:flex;align-items:flex-start;gap:8px;cursor:pointer">
                <input type="checkbox" id="ppEnableSkills" style="accent-color:var(--accent);margin-top:2px">
                <div>
                  <div style="font-size:12px;font-weight:600;color:var(--text)" data-i18n="pp.skills.label">Trigger skill evolution</div>
                  <div style="font-size:11px;color:var(--text-sec);line-height:1.4" data-i18n="pp.skills.hint">Analyze completed tasks and automatically create or upgrade reusable skills (SKILL.md). Requires task summaries to be enabled. May take longer due to LLM evaluation.</div>
                </div>
              </label>
            </div>
            <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">
              <button class="btn btn-primary" id="ppStartBtn" onclick="ppStart()" data-i18n="pp.start">Start Processing</button>
              <button class="btn btn-sm" id="ppStopBtn" onclick="ppStop()" style="display:none;background:rgba(239,68,68,.12);color:#ef4444;border:1px solid rgba(239,68,68,.3);font-size:12px;padding:5px 16px;font-weight:600" data-i18n="migrate.stop">\u25A0 Stop</button>
              <span style="display:inline-flex;align-items:center;gap:6px">
                <span style="font-size:11px;color:var(--text-muted)" data-i18n="pp.concurrency.label">Concurrent agents</span>
                <select id="ppConcurrency" class="filter-select" style="min-width:auto;padding:3px 28px 3px 10px;font-size:11px">
                  <option value="1" selected>1</option>
                  <option value="2">2</option>
                  <option value="4">4</option>
                  <option value="8">8</option>
                </select>
              </span>
              <span id="ppStatus" style="font-size:11px;color:var(--text-muted)"></span>
            </div>
            <div id="ppConcurrencyWarn" style="display:none;margin-top:8px;padding:8px 12px;background:rgba(245,158,11,.06);border:1px solid rgba(245,158,11,.2);border-radius:8px;font-size:11px;color:#f59e0b;line-height:1.5">
              <span data-i18n="pp.concurrency.warn">\u26A0 Increasing concurrency raises LLM API call frequency, which may trigger rate limits and cause failures.</span>
            </div>
            <div id="ppProgress" style="display:none;margin-top:12px">
              <div style="display:flex;align-items:center;gap:12px;margin-bottom:8px">
                <div style="font-size:12px;font-weight:600;color:var(--text)" id="ppPhaseLabel"></div>
                <div style="font-size:11px;color:var(--text-muted);flex:1" id="ppCounter"></div>
              </div>
              <div style="position:relative;height:5px;background:var(--bg);border-radius:3px;overflow:hidden;margin-bottom:12px">
                <div id="ppBar" style="position:absolute;left:0;top:0;height:100%;width:0%;background:linear-gradient(90deg,#f59e0b,#fbbf24);border-radius:3px;transition:width .3s ease"></div>
              </div>
              <div style="display:flex;gap:16px;margin-bottom:12px" id="ppStatsRow">
                <div style="display:flex;align-items:center;gap:5px;font-size:11px">
                  <span style="width:7px;height:7px;border-radius:50%;background:#22c55e;display:inline-block"></span>
                  <span style="color:var(--text-sec)" data-i18n="pp.stat.tasks">Tasks</span>
                  <span style="font-weight:700;color:var(--text)" id="ppStatTasks">0</span>
                </div>
                <div style="display:flex;align-items:center;gap:5px;font-size:11px">
                  <span style="width:7px;height:7px;border-radius:50%;background:#8b5cf6;display:inline-block"></span>
                  <span style="color:var(--text-sec)" data-i18n="pp.stat.skills">Skills</span>
                  <span style="font-weight:700;color:var(--text)" id="ppStatSkills">0</span>
                </div>
                <div style="display:flex;align-items:center;gap:5px;font-size:11px">
                  <span style="width:7px;height:7px;border-radius:50%;background:#ef4444;display:inline-block"></span>
                  <span style="color:var(--text-sec)" data-i18n="pp.stat.errors">Errors</span>
                  <span style="font-weight:700;color:var(--text)" id="ppStatErrors">0</span>
                </div>
                <div style="display:flex;align-items:center;gap:5px;font-size:11px" id="ppSkippedInfo" style="display:none">
                  <span style="width:7px;height:7px;border-radius:50%;background:#3b82f6;display:inline-block"></span>
                  <span style="color:var(--text-sec)" data-i18n="pp.stat.skipped">Skipped</span>
                  <span style="font-weight:700;color:var(--text)" id="ppStatSkipped">0</span>
                </div>
              </div>
              <div id="ppLiveLog" style="background:var(--bg);border:1px solid var(--border);border-radius:8px;max-height:320px;overflow-y:auto;font-family:'SF Mono','Fira Code',monospace;font-size:11px;line-height:1.7;padding:0"></div>
            </div>
            <div id="ppDone" style="display:none;margin-top:12px;padding:10px 14px;border-radius:8px;font-size:12px;color:var(--text-sec);line-height:1.5"></div>
          </div>
        </div>
      </div>

      <!-- Progress Area -->
      <div id="migrateProgress" style="display:none">
        <div class="settings-section">
          <div style="display:flex;align-items:center;gap:12px;margin-bottom:12px">
            <div style="font-size:13px;font-weight:600;color:var(--text)" id="migratePhaseLabel"></div>
            <div style="font-size:12px;color:var(--text-muted);flex:1" id="migrateCounter"></div>
            <button class="btn btn-sm" id="migrateStopBtn" onclick="migrateStop()" style="background:rgba(239,68,68,.12);color:#ef4444;border:1px solid rgba(239,68,68,.3);font-size:12px;padding:5px 16px;font-weight:600;cursor:pointer" data-i18n="migrate.stop">\u25A0 Stop</button>
          </div>

          <div style="position:relative;height:6px;background:var(--bg);border-radius:3px;overflow:hidden;margin-bottom:16px">
            <div id="migrateBar" style="position:absolute;left:0;top:0;height:100%;width:0%;background:linear-gradient(90deg,#6366f1,#8b5cf6);border-radius:3px;transition:width .3s ease"></div>
          </div>

          <div style="display:flex;gap:20px;margin-bottom:16px" id="migrateStatsRow">
            <div style="display:flex;align-items:center;gap:6px;font-size:12px">
              <span style="width:8px;height:8px;border-radius:50%;background:#22c55e;display:inline-block"></span>
              <span style="color:var(--text-sec)" data-i18n="migrate.stat.stored">Stored</span>
              <span style="font-weight:700;color:var(--text)" id="migrateStatStored">0</span>
            </div>
            <div style="display:flex;align-items:center;gap:6px;font-size:12px">
              <span style="width:8px;height:8px;border-radius:50%;background:#f59e0b;display:inline-block"></span>
              <span style="color:var(--text-sec)" data-i18n="migrate.stat.skipped">Skipped</span>
              <span style="font-weight:700;color:var(--text)" id="migrateStatSkipped">0</span>
            </div>
            <div style="display:flex;align-items:center;gap:6px;font-size:12px">
              <span style="width:8px;height:8px;border-radius:50%;background:#3b82f6;display:inline-block"></span>
              <span style="color:var(--text-sec)" data-i18n="migrate.stat.merged">Merged</span>
              <span style="font-weight:700;color:var(--text)" id="migrateStatMerged">0</span>
            </div>
            <div style="display:flex;align-items:center;gap:6px;font-size:12px">
              <span style="width:8px;height:8px;border-radius:50%;background:#ef4444;display:inline-block"></span>
              <span style="color:var(--text-sec)" data-i18n="migrate.stat.errors">Errors</span>
              <span style="font-weight:700;color:var(--text)" id="migrateStatErrors">0</span>
            </div>
          </div>

          <div id="migrateLiveLog" style="background:var(--bg);border:1px solid var(--border);border-radius:10px;max-height:480px;overflow-y:auto;font-family:'SF Mono','Fira Code',monospace;font-size:11px;line-height:1.7;padding:0">
          </div>
        </div>
      </div>

    </div>

    </div>
  </div>
</div>

<!-- ─── Memory Modal ─── -->
<div class="modal-overlay" id="modalOverlay">
  <div class="modal">
    <h2 id="modalTitle" data-i18n="modal.edit">Edit Memory</h2>
    <div class="form-group"><label data-i18n="modal.role">Role</label><select id="mRole"><option value="user">User</option><option value="assistant">Assistant</option><option value="system">System</option></select></div>
    <div class="form-group"><label data-i18n="modal.content">Content</label><textarea id="mContent" rows="4" data-i18n-ph="modal.content.ph" placeholder="Memory content..."></textarea></div>
    <div class="form-group"><label data-i18n="modal.summary">Summary</label><input type="text" id="mSummary" data-i18n-ph="modal.summary.ph" placeholder="Brief summary (optional)"></div>
    <div class="modal-actions">
      <button class="btn btn-ghost" onclick="closeModal()" data-i18n="modal.cancel">Cancel</button>
      <button class="btn btn-primary" id="modalSubmit" onclick="submitModal()" data-i18n="modal.save">Save</button>
    </div>
  </div>
</div>

<!-- ─── Toast ─── -->
<div class="toast-container" id="toasts"></div>

<script>
let activeSession=null,activeRole='',editingId=null,searchTimer=null,memoryCache={},currentPage=1,totalPages=1,totalCount=0,PAGE_SIZE=20,metricsDays=30;
let memorySearchScope='allLocal',skillSearchScope='allLocal',taskSearchScope='allLocal';
let _lastMemoriesFingerprint='',_lastTasksFingerprint='',_lastSkillsFingerprint='';
let selectedMemoryIds=new Set(),currentMemoryIds=[];
let selectedTaskIds=new Set(),currentTaskIds=[];
let _embeddingWarningShown=false;
let _currentAgentOwner='agent:main';
try {
  const urlParams = new URLSearchParams(window.location.search);
  const agentId = urlParams.get('agentId');
  if (agentId) {
    _currentAgentOwner = 'agent:' + agentId;
  }
} catch(e) {}


/* ─── i18n ─── */
const I18N={
  en:{
    'title':'OpenClaw Memory',
    'subtitle':'Powered by MemOS',
    'setup.desc':'Set a password to protect your memories',
    'setup.pw':'Enter a password (4+ characters)',
    'setup.pw2':'Confirm password',
    'setup.btn':'Set Password & Enter',
    'setup.err.short':'Password must be at least 4 characters',
    'setup.err.mismatch':'Passwords do not match',
    'setup.err.fail':'Setup failed',
    'login.desc':'Enter your password to access memories',
    'login.pw':'Password',
    'login.btn':'Unlock',
    'login.err':'Incorrect password',
    'login.forgot':'Forgot password?',
    'reset.step1.title':'Open Terminal',
    'reset.step1.desc':'Run the following command to get your reset token (use the pattern below so you get the line that contains the token):',
    'reset.step2.title':'Find the token',
    'reset.step2.desc.pre':'In the output, find ',
    'reset.step2.desc.post':' (plain line or inside JSON). Copy the 32-character hex string after the colon.',
    'reset.step3.title':'Paste & reset',
    'reset.step3.desc':'Paste the token below and set your new password.',
    'reset.token':'Paste reset token here',
    'reset.newpw':'New password (4+ characters)',
    'reset.newpw2':'Confirm new password',
    'reset.btn':'Reset Password',
    'reset.err.token':'Please enter the reset token',
    'reset.err.short':'Password must be at least 4 characters',
    'reset.err.mismatch':'Passwords do not match',
    'reset.err.fail':'Reset failed',
    'reset.back':'\\u2190 Back to login',
    'copy.hint':'Click to copy',
    'copy.done':'Copied!',
    'tab.memories':'\\u{1F4DA} Memories',
    'tab.tasks':'\\u{1F4CB} Tasks',
    'tab.skills':'\\u{1F9E0} Skills',
    'tab.analytics':'\\u{1F4CA} Analytics',
    'skills.total':'Total Skills',
    'skills.active':'Active',
    'skills.installed':'Installed',
    'skills.public':'Public',
    'skills.search.placeholder':'Search skills...',
    'skills.search.local':'Local',
    'skills.search.noresult':'No matching skills found',
    'skills.load.error':'Failed to load skills',
    'skills.hub.title':'\u{1F310} Team Skills',
    'skills.hub.empty':'No extra team skills to list here — either the hub has none yet, or every hub skill already appears in your local list above (same source skill).',
    'skills.hub.loadError':'Failed to load team skills',
    'skills.hub.timeout':'Team skills request timed out. Check that the Hub is running and connected.',
    'scope.local':'Local',
    'scope.thisAgent':'This Agent Only',
    'scope.thisDevice':'All Local Agents',
    'scope.group':'Group',
    'scope.all':'All',
    'skills.visibility.public':'Shared Locally',
    'skills.visibility.private':'This Agent Only',
    'skills.setPublic':'Share Locally',
    'skills.setPrivate':'This Agent Only',
    'tasks.total':'Total Tasks',
    'tasks.active':'Active',
    'tasks.completed':'Completed',
    'tasks.status.active':'Active',
    'tasks.status.completed':'Completed',
    'tasks.status.skipped':'Skipped',
    'tasks.search.placeholder':'Search tasks...',
    'tasks.search.meta':'Found {0} tasks',
    'tasks.empty':'No tasks yet. Tasks are automatically created as you converse.',
    'tasks.loading':'Loading...',
    'tasks.untitled':'Untitled Task',
    'tasks.chunks':'Related Memories',
    'tasks.nochunks':'No memories in this task yet.',
    'tasks.expand':'Show more',
    'tasks.collapse':'Show less',
    'tasks.skipped.default':'This conversation was too brief to generate a summary. It will not appear in search results.',
    'refresh':'\\u21BB Refresh',
    'logout':'Logout',
    'notif.title':'\\u{1F514} Notifications',
    'notif.markAll':'Mark all read',
    'notif.empty':'No notifications yet',
    'notif.removed.memory':'Your shared memory was removed by admin',
    'notif.removed.task':'Your shared task was removed by admin',
    'notif.removed.skill':'Your shared skill was removed by admin',
    'notif.shared.memory':'A new memory was shared',
    'notif.shared.task':'A new task was shared',
    'notif.shared.skill':'A new skill was shared',
    'notif.unshared.memory':'A memory was unshared',
    'notif.unshared.task':'A task was unshared',
    'notif.unshared.skill':'A skill was unshared',
    'notif.userJoin':'New user requests to join the team',
    'notif.userOnline':'User came online',
    'notif.userOffline':'User went offline',
    'notif.userLeft':'User has left the team',
    'notif.membershipApproved':'Your team join request has been approved',
    'notif.membershipRejected':'Your team join request has been declined',
    'notif.membershipRemoved':'You have been removed from the team by the admin',
    'notif.hubShutdown':'The team server has been shut down',
    'notif.rolePromoted':'You have been promoted to admin',
    'notif.roleDemoted':'You have been changed to member',
    'notif.usernameRenamed':'Your nickname has been changed by the admin',
    'notif.usernameRenamed.detail':'{oldName} → {newName}',
    'notif.clearAll':'Clear all',
    'notif.timeAgo.just':'just now',
    'notif.timeAgo.min':'{n}m ago',
    'notif.timeAgo.hour':'{n}h ago',
    'notif.timeAgo.day':'{n}d ago',
    'stat.memories':'Memories',
    'stat.tasks':'Tasks',
    'stat.skills':'Skills',
    'stat.agents':'Agents',
    'stat.active':'active',
    'stat.deduped':'deduped',
    'sidebar.sessions':'Sessions',
    'sidebar.allsessions':'All Sessions',
    'sidebar.clear':'\\u{1F5D1} Clear All Data',
    'search.placeholder':'Search memories (supports semantic search)...',
    'search.meta.total':' memories total',
    'search.meta.semantic':' semantic',
    'search.meta.text':' text',
    'search.meta.results':' results',
    'filter.all':'All',
    'filter.newest':'Newest first',
    'filter.oldest':'Oldest first',
    'filter.allowners':'All owners',
    'filter.allagents':'All agents',
    'filter.allsessions':'All sessions',
    'filter.public':'Public',
    'filter.private':'Private',
    'filter.allvisibility':'All visibility',
    'filter.from':'From',
    'filter.to':'To',
    'filter.clear':'Clear',
    'empty.text':'No memories found',
    'card.expand':'Expand',
    'card.edit':'Edit',
    'card.delete':'Delete',
    'card.evolved':'Evolved',
    'card.times':'times',
    'card.newMessage':'New message',
    'card.mergedInfo':'Merged memory',
    'card.updated':'updated',
    'card.evolveHistory':'Evolution History',
    'card.oldSummary':'Old',
    'card.dedupDuplicate':'Duplicate',
    'card.dedupMerged':'Merged',
    'card.dedupTarget':'Target: ',
    'card.dedupReason':'Reason: ',
    'card.newSummary':'New',
    'pagination.pageSize':'Items per page',
    'pagination.total':' total',
    'range':'Range',
    'range.days':'days',
    'analytics.total':'Total Memories',
    'analytics.writes':'Writes Today',
    'analytics.calls':'Viewer Calls Today',
    'analytics.sessions':'Sessions',
    'analytics.embeddings':'Embeddings',
    'chart.writes':'Memory Writes per Day',
    'chart.calls':'Viewer API Calls per Day (List / Search)',
    'chart.nodata':'No data in this range',
    'chart.nocalls':'No viewer calls in this range',
    'chart.toolperf':'Tool Response Time',
    'chart.apply':'Apply',
    'chart.selectRange':'Please select a time range',
    'chart.list':'List',
    'chart.search':'Search',
    'modal.edit':'Edit Memory',
    'modal.role':'Role',
    'modal.content':'Content',
    'modal.content.ph':'Memory content...',
    'modal.summary':'Summary',
    'modal.summary.ph':'Brief summary (optional)',
    'modal.cancel':'Cancel',
    'modal.save':'Save',
    'modal.err.empty':'Please enter content',
    'toast.updated':'Memory updated',
    'toast.deleted':'Memory deleted',
    'toast.opfail':'Operation failed',
    'toast.delfail':'Delete failed',
    'toast.setPublic':'Shared locally',
    'toast.setPrivate':'Now visible to this agent only',
    'toast.cleared':'All memories cleared',
    'toast.clearfail':'Clear failed',
    'toast.notfound':'Memory not found in cache',
    'confirm.title':'Confirm',
    'confirm.ok':'Confirm',
    'confirm.cancel':'Cancel',
    'confirm.delete':'Delete this memory?',
    'confirm.clearall':'Delete ALL memories? This cannot be undone.',
    'confirm.clearall2':'Are you absolutely sure?',
    'embed.on':'Embedding: ',
    'embed.off':'No embedding model',
    'embed.warn.local':'Using built-in mini model (384d). Search quality is limited — configure an embedding model in Settings for best results.',
    'embed.err.fail':'Embedding model error detected. Check Settings → Model Health.',
    'embed.banner.goto':'Go to Settings',
    'lang.switch':'中',
    'tab.logs':'\u{1F4DD} Logs',
    'logs.allTools':'All Tools',
    'logs.refresh':'Refresh',
    'logs.autoRefresh':'Auto-refresh',
    'logs.input':'INPUT',
    'logs.output':'OUTPUT',
    'logs.empty':'No logs yet. Logs will appear here when tools are called.',
    'logs.ago':'ago',
    'logs.recall.initial':'Initial Retrieval',
    'logs.recall.hubRemote':'Hub Remote',
    'logs.recall.filtered':'LLM Filtered',
    'logs.recall.noHits':'No matching memories',
    'logs.recall.noneRelevant':'LLM filter: none relevant',
    'logs.recall.more':'{n} more...',
    'recall.origin.localShared':'Local Shared',
    'recall.origin.hubMemory':'Team Cache',
    'recall.origin.hubRemote':'Team',
    'tab.import':'\u{1F4E5} Import',
    'tab.settings':'\u2699 Settings',
    'settings.modelconfig':'Model Configuration',
    'settings.models':'AI Models',
    'settings.models.desc':'Configure embedding, summarizer and skill evolution models',
    'settings.modelhealth':'Model Health',
    'settings.embedding':'Embedding Model',
    'settings.summarizer':'Summarizer Model',
    'settings.skill':'Skill Evolution',
    'settings.general':'General',
    'settings.embedding.desc':'Vector embedding model for memory search and retrieval',
    'settings.summarizer.desc':'LLM for memory summarization, deduplication and analysis',
    'settings.skill.desc':'Auto-extract reusable skills from conversation patterns',
    'settings.hub.desc':'Share memories, tasks and skills with your team',
    'settings.general.desc':'System status, ports and telemetry',
    'settings.hostproxy.embedding':'Use Gateway Model',
    'settings.hostproxy.completion':'Use Gateway Model',
    'settings.hostproxy.skill':'Use Gateway Model',
    'settings.hostproxy.hint.short':'Reuse gateway model config',
    'settings.provider':'Provider',
    'settings.model':'Model',
    'settings.temperature':'Temperature',
    'settings.skill.enabled':'Enable Skill Evolution',
    'settings.skill.autoinstall':'Auto Install Skills',
    'settings.skill.confidence':'Min Confidence',
    'settings.skill.minchunks':'Min Chunks',
    'settings.skill.model':'Skill Dedicated Model',
    'settings.skill.model.hint':'Leave empty to reuse the Summarizer model. Set a dedicated one for higher quality.',
    'settings.optional':'Optional',
    'settings.skill.usemain':'Use Main Summarizer',
    'settings.telemetry':'Telemetry',
    'settings.telemetry.enabled':'Enable Anonymous Telemetry',
    'settings.telemetry.hint':'Only collects tool names, latencies and version info. No memory content or personal data.',
    'settings.viewerport':'Viewer Port',
    'settings.viewerport.hint':'Requires restart to take effect',
    'settings.taskAutoFinalize':'Task Auto-Finalize (hours)',
    'settings.taskAutoFinalize.hint':'Active tasks with no new messages beyond this duration will be automatically summarized and completed when the Tasks page is opened. Set to 0 to disable. Default: 4 hours.',
    'settings.test':'Test Connection',
    'settings.test.loading':'Testing...',
    'settings.test.ok':'Connected',
    'settings.test.fail':'Failed',
    'settings.session.expired':'Session expired, please refresh the page to log in again',
    'settings.save':'Save & Apply',
    'settings.reset':'Reset',
    'settings.saved':'Saved',
    'settings.restart.hint':'Changes will take effect after the service restarts automatically.',
    'settings.restart.autoRefresh':'Service restarting, page will refresh automatically...',
    'settings.restart.waiting':'Configuration saved. Service is restarting...',
    'settings.save.fail':'Failed to save settings',
    'settings.save.emb.required':'Embedding model is required. Please configure an embedding model before saving.',
    'settings.save.emb.fail':'Embedding model test failed, cannot save',
    'settings.save.sum.fail':'Summarizer model test failed, cannot save',
    'settings.save.skill.fail':'Skill model test failed, cannot save',
    'settings.save.sum.fallback':'Summarizer model is not configured — will use OpenClaw native model as fallback.',
    'settings.save.skill.fallback':'Skill dedicated model is not configured — will use OpenClaw native model as fallback.',
    'settings.save.fallback.model':'Fallback model: ',
    'settings.save.fallback.none':'Not available (no OpenClaw native model found)',
    'settings.save.fallback.confirm':'Continue to save?',
    'migrate.title':'Import OpenClaw Memory',
    'migrate.desc':'Migrate your existing OpenClaw built-in memories and conversation history into this plugin. The import process uses smart deduplication to avoid duplicates.',
    'migrate.modes.title':'Three ways to use:',
    'migrate.mode1.label':'\\u2460 Import memories only (fast)',
    'migrate.mode1.desc':' — Click "Start Import" to quickly migrate all memory chunks and conversations. No task/skill generation. Suitable when you just need the raw data.',
    'migrate.mode2.label':'\\u2461 Import + generate tasks & skills (slow, serial)',
    'migrate.mode2.desc':' — After importing memories, enable "Generate Tasks" and/or "Trigger Skill Evolution" below to analyze conversations one by one. This takes longer as each session is processed by LLM sequentially.',
    'migrate.mode3.label':'\\u2462 Import first, generate later (flexible)',
    'migrate.mode3.desc':' — Import memories now, then come back anytime to start task/skill generation. You can pause the generation at any point and resume later — it will pick up where you left off, only processing sessions that haven\\'t been handled yet.',
    'migrate.config.warn':'Configuration Required',
    'migrate.config.warn.desc':'Please configure both Embedding Model and Summarizer Model above before importing. These are required for processing memories.',
    'migrate.sqlite.label':'Memory Index (SQLite)',
    'migrate.sessions.label':'Conversation History',
    'migrate.concurrency.label':'Concurrent agents',
    'migrate.concurrency.warn':'\u26A0 Increasing concurrency raises LLM API call frequency, which may trigger rate limits and cause failures.',
    'migrate.scan':'Scan Data Sources',
    'migrate.start':'Start Import',
    'migrate.scanning':'Scanning...',
    'migrate.scan.required':'Please scan data sources first',
    'migrate.scan.done':'Scan complete \u2014 {n} new items found',
    'migrate.imported.hint':'{n} items already imported',
    'migrate.reconnect.hint':'--- {n} items processed before page reload ---',
    'migrate.stat.stored':'Stored',
    'migrate.stat.skipped':'Skipped',
    'migrate.stat.merged':'Merged',
    'migrate.stat.errors':'Errors',
    'migrate.phase.sqlite':'Importing memory index...',
    'migrate.phase.sessions':'Importing conversation history...',
    'migrate.phase.stopped':'Import stopped',
    'migrate.phase.done':'Import completed',
    'migrate.chunks':'chunks',
    'migrate.sessions.count':'sessions, {n} messages',
    'migrate.nodata':'No OpenClaw data found to import.',
    'migrate.running':'Import in progress...',
    'migrate.error.running':'A migration is already in progress.',
    'migrate.stop':'\\u25A0 Stop',
    'migrate.stopping':'Stopping...',
    'migrate.resume':'Continue Import',
    'pp.title':'\\u{1F9E0} Optional: Generate Tasks & Skills',
    'pp.desc':'This step is completely optional. The import above has already stored raw memory data. Here you can further analyze imported conversations to generate structured task summaries and evolve reusable skills. Processing is serial (one session at a time) and may take a while. You can stop at any time and resume later — it will only process sessions not yet handled.',
    'pp.tasks.label':'Generate task summaries',
    'pp.tasks.hint':'Group imported messages into tasks and generate a structured summary (title, goal, steps, result) for each one. Makes it easier to search and recall past work.',
    'pp.skills.label':'Trigger skill evolution',
    'pp.skills.hint':'Analyze completed tasks and automatically create or upgrade reusable skills (SKILL.md). Requires task summaries to be enabled. May take longer due to LLM evaluation.',
    'pp.concurrency.label':'Concurrent agents',
    'pp.concurrency.warn':'\u26A0 Increasing concurrency raises LLM API call frequency, which may trigger rate limits and cause failures.',
    'pp.start':'Start Processing',
    'pp.resume':'Resume Processing',
    'pp.running':'Processing',
    'pp.stopped':'Processing stopped. You can resume anytime.',
    'pp.failed':'Processing failed — see error message above.',
    'pp.done':'Task & skill generation complete!',
    'pp.select.warn':'Please select at least one option.',
    'pp.skill.created':'Skill created',
    'pp.stat.tasks':'Tasks',
    'pp.stat.skills':'Evolutions',
    'pp.stat.skills.total':'Skills',
    'pp.stat.errors':'Errors',
    'pp.stat.skipped':'Skipped',
    'pp.info.skipped':'{n} sessions already processed, skipping.',
    'pp.info.pending':'Processing {n} sessions...',
    'pp.info.allDone':'All sessions have been processed already. Nothing to do.',
    'pp.action.full':'Task+Skill',
    'pp.action.skillOnly':'Skill only (task exists)',
    'card.imported':'OpenClaw Native',
    'skills.draft':'Draft',
    'skills.filter.active':'Active',
    'skills.filter.draft':'Draft',
    'skills.filter.archived':'Archived',
    'skills.files':'Skill Files',
    'skills.content':'SKILL.md Content',
    'skills.versions':'Version History',
    'skills.related':'Related Tasks',
    'skills.download':'\u2B07 Download',
    'skills.installed.badge':'Installed',
    'skills.empty':'No skills yet. Skills are auto-generated from completed tasks with reusable patterns.',
    'skills.loading':'Loading...',
    'skills.error':'Error loading skill',
    'skills.error.detail':'Failed to load skill: ',
    'skills.nofiles':'No files found',
    'skills.noversions':'No versions recorded',
    'skills.norelated':'No related tasks',
    'skills.nocontent':'No content available',
    'skills.hub.markdownPending':'Full SKILL.md is not included in the team list response. Use “Pull to local”, then open the skill from your local list to view markdown, files, and versions.',
    'skills.nochangelog':'No changelog',
    'skills.status.active':'Active',
    'skills.status.draft':'Draft',
    'skills.status.archived':'Disabled',
    'skills.action.disable':'Disable',
    'skills.action.enable':'Enable',
    'skills.action.delete':'Delete',
    'skills.disable.confirm':'Are you sure you want to disable this skill? It will no longer be used in search or auto-recall, but can be re-enabled later.',
    'skills.disable.error':'Failed to disable skill: ',
    'skills.enable.error':'Failed to enable skill: ',
    'skills.updated':'Updated: ',
    'skills.task.prefix':'Task: ',
    'skills.selectAll':'Select All',
    'skills.unselectAll':'Unselect All',
    'skills.deleteSelected':'Delete Selected',
    'tasks.chunks.label':'chunks',
    'tasks.taskid':'Task ID: ',
    'tasks.role.user':'You',
    'tasks.role.assistant':'Assistant',
    'tasks.error':'Error',
    'tasks.error.detail':'Failed to load task details',
    'tasks.untitled.related':'Untitled',
    'tab.admin':'\u{1F6E1} Admin',
    'settings.hub':'Team Sharing',
    'settings.hub.enable':'Enable Team Sharing',
    'settings.hub.enable.hint':'When off, everything works locally as usual.',
    'settings.hub.enable.label':'Enable Team Sharing',
    'settings.hub.role':'Role',
    'settings.hub.role.hub':'Server (Host a team)',
    'settings.hub.role.client':'Client (Join a team)',
    'settings.hub.role.hint':'Server = host the team server; Client = join an existing team. These two modes are mutually exclusive.',
    'settings.hub.port':'Server Port',
    'settings.hub.port.hint':'Port for team server. Default: 18800',
    'settings.hub.teamName':'Team Name',
    'settings.hub.teamName.hint':'Display name for your team',
    'settings.hub.adminName':'Admin Name',
    'settings.hub.adminName.hint':'Your display name as team admin',
    'settings.hub.teamToken':'Team Token',
    'settings.hub.teamToken.hint':'Auto-generated secret for clients to join. Click to copy. Share this with your team members.',
    'settings.hub.tokenCopied':'Team Token copied!',
    'settings.hub.hubSteps.title':'Quick Setup (3 steps)',
    'settings.hub.hubSteps.s1':'Fill in Team Name below (or keep default)',
    'settings.hub.hubSteps.s2':'Click "Save & Apply" — the service will restart automatically',
    'settings.hub.hubSteps.s3':'Share the Server Address and Team Token below with your team members',
    'settings.hub.clientSteps.title':'Quick Setup (3 steps)',
    'settings.hub.clientSteps.s1':'Ask your team admin for the Server Address and Team Token',
    'settings.hub.clientSteps.s2':'Fill them in below, click "Test Connection" to verify',
    'settings.hub.clientSteps.s3':'Click "Save & Apply" — the service will restart and page refreshes automatically',
    'settings.hub.shareInfo.title':'Share this info with your team members:',
    'settings.hub.shareInfo.yourIP':'your-IP',
    'settings.hub.shareInfo.clickCopy':'Click to copy',
    'settings.hub.restartAlert':'Team sharing config saved! The service will restart automatically to apply changes.',
    'settings.hub.hubAddress':'Server Address',
    'settings.hub.hubAddress.hint':'Team server address, e.g. 192.168.1.100:18800',
    'settings.hub.teamTokenClient':'Team Token',
    'settings.hub.teamTokenClient.hint':'Get this from your team admin to join',
    'settings.hub.nickname':'Nickname',
    'settings.hub.nickname.hint':'Your display name in the team. If empty, uses system username.',
    'settings.hub.userToken':'User Token',
    'settings.hub.userToken.hint':'Usually auto-obtained after joining. Only fill if given by admin.',
    'settings.hub.testConnection':'Test Connection',
    'settings.hub.test.noAddr':'Please enter server address first',
    'settings.hub.teamToken.required':'Please enter team token',
    'settings.hub.test.testing':'Testing...',
    'settings.hub.test.ok':'Connected successfully',
    'settings.hub.test.fail':'Connection failed',
    'settings.hub.connection':'Connection Status',
    'settings.hub.team':'Team & Groups',
    'settings.hub.adminPending':'Admin Pending Users',
    'sidebar.hub':'\u{1F310} Team Sharing',
    'sharing.sidebar.connected':'Connected',
    'sharing.sidebar.disconnected':'Disconnected',
    'sharing.sidebar.hubRunning':'Hub Running',
    'sharing.sidebar.teamName':'Team',
    'sharing.sidebar.members':'Members',
    'sharing.sidebar.online':'online',
    'sharing.sidebar.pending':'Pending Approval',
    'sharing.sidebar.rejected':'Rejected',
    'sharing.sidebar.starting':'Starting...',
    'sharing.sidebar.notConfigured':'Not configured',
    'sharing.sidebar.identity':'Identity:',
    'sharing.sidebar.admin':'Admin',
    'sharing.sidebar.targetHub':'Team Server:',
    'sharing.pendingApproval.hint':'Your join request has been submitted. Please wait for the team admin to approve.',
    'sharing.rejected.hint':'Your join request was rejected by the team admin. Please contact the admin or retry.',
    'sharing.removed.hint':'You have been removed from the team by the admin. You can re-apply to join.',
    'sharing.joinTeam':'Join Team',
    'sharing.joinSent.pending':'Join request sent! Waiting for admin approval.',
    'sharing.joinSent.active':'Successfully joined the team!',
    'sharing.retryJoin':'Retry Join',
    'sharing.retryJoin.hint':'Clears local data and re-submits the join request',
    'sharing.retryJoin.confirm':'This will clear your current connection and re-submit a join request. Continue?',
    'sharing.leaveTeam':'Leave Team',
    'sharing.leaveTeam.confirm':'You are about to leave team "{team}".\\n\\nWhat will happen:\\n\\u2022 You will disconnect from the team server\\n\\u2022 The team admin will be notified that you left\\n\\u2022 You will no longer receive shared memories, tasks, or skills\\n\\u2022 Your local data is preserved and not affected\\n\\u2022 You can rejoin later if the admin approves\\n\\nAre you sure?',
    'sharing.leaveTeam.success':'You have left the team. Sharing has been disabled.',
    'sharing.leaveTeam.fail':'Failed to leave team',
    'sharing.team.default':'the team',
    'sharing.retryJoin.success':'Join request re-submitted. Waiting for admin approval.',
    'sharing.retryJoin.fail':'Failed to retry join',
    'sharing.joinError.hubUnreachable':'Unable to connect to the team server. The server may be offline or the network is unavailable. Please check the server address and try again.',
    'sharing.joinError.usernameTaken':'The username is already taken on this team server. Please go to Settings and change your nickname, then try again.',
    'sharing.joinError.invalidToken':'The team token is invalid. Please check with your team admin and update the token in Settings.',
    'sharing.joinError.blocked':'Your account has been blocked by the team admin. Please contact the admin for assistance.',
    'sharing.ownerRemoved':'(removed)',
    'sharing.cannotJoinSelf':'Cannot join your own server. Please enter a remote server address.',
    'scope.hub':'Team',
    'memory.detail.title':'Memory Detail',
    'memory.detail.loading':'Loading...',
    'memory.detail.notFound':'Memory not found',
    'memory.detail.copyId':'Click to copy ID',
    'memory.detail.created':'Created ',
    'memory.detail.updated':'Updated ',
    'memory.detail.viewTarget':'View target: ',
    'admin.title':'Team Admin Panel',
    'admin.subtitle':'Manage team members and shared resources',
    'admin.subtitle.member':'Browse shared memories, tasks and skills from your team',
    'admin.refresh':'\u21BB Refresh',
    'admin.tab.users':'Users',
    'admin.tab.tasks':'Shared Tasks',
    'admin.tab.groups':'Groups',
    'admin.tab.memories':'Shared Memories',
    'admin.tab.skills':'Shared Skills',
    'admin.stat.activeUsers':'Active Users',
    'admin.stat.pending':'Pending',
    'admin.stat.groups':'Groups',
    'admin.stat.sharedTasks':'Shared Tasks',
    'admin.stat.sharedSkills':'Shared Skills',
    'admin.stat.sharedMemories':'Shared Memories',
    'admin.pendingApproval':'Pending Approval',
    'admin.activeUsers':'Active Users',
    'admin.noActiveUsers':'No active users.',
    'admin.onlineUsers':'Online',
    'admin.offlineUsers':'Offline',
    'admin.online':'Online',
    'admin.offline':'Offline',
    'admin.offlineFor':'Offline for {time}',
    'admin.onlineNow':'Online now',
    'admin.approve':'Approve',
    'admin.reject':'Reject',
    'admin.device':'Device: ',
    'admin.joined':'Joined: ',
    'admin.approved':'Approved: ',
    'admin.lastActive':'Last Active: ',
    'admin.ip':'IP: ',
    'admin.contrib.memories':'Memories',
    'admin.contrib.tasks':'Tasks',
    'admin.contrib.skills':'Skills',
    'admin.groups':'Groups: ',
    'admin.neverActive':'Never',
    'admin.promoteAdmin':'Promote to Admin',
    'admin.demoteMember':'Demote to Member',
    'admin.editName':'Edit Name',
    'admin.lastAdminHint':'Last admin — cannot remove or demote',
    'admin.ownerHint':'Hub owner — cannot be demoted or removed',
    'admin.selfHint':'This is you',
    'admin.editNamePrompt':'Enter new username:',
    'confirm.promoteAdmin':'Promote this user to admin? They will be able to manage all team members and resources.',
    'confirm.demoteMember':'Demote this admin to member?',
    'toast.roleChanged':'Role updated',
    'toast.roleChangeFail':'Role change failed',
    'toast.usernameChanged':'Username updated',
    'toast.renameFail':'Rename failed',
    'toast.invalidUsername':'Username must be 2-32 characters',
    'admin.filterAll':'All Users',
    'admin.filterAllValues':'All',
    'admin.filter.owner':'All Users',
    'admin.filter.visibility':'Visibility',
    'admin.filter.group':'Group',
    'admin.search.placeholder':'Search...',
    'admin.sort.newest':'Newest first',
    'admin.sort.oldest':'Oldest first',
    'admin.filter.role':'Role',
    'admin.filter.status':'Status',
    'admin.expand':'Expand',
    'admin.collapse':'Collapse',
    'admin.noContent':'No content',
    'admin.summary':'Summary',
    'admin.description':'Description',
    'admin.contentLabel':'Content',
    'admin.groups':'Groups',
    'admin.newGroup':'+ New Group',
    'admin.groupName':'Group name',
    'admin.groupDesc':'Description (optional)',
    'admin.create':'Create',
    'admin.cancel':'Cancel',
    'admin.delete':'Delete',
    'admin.members':'Members',
    'admin.noGroups':'No groups created yet.',
    'admin.noMembers':'No members.',
    'admin.add':'Add',
    'admin.remove':'Remove',
    'admin.sharedTasks':'Shared Tasks',
    'admin.noSharedTasks':'No shared tasks in team.',
    'admin.owner':'Owner: ',
    'admin.group':'Group: ',
    'admin.kind':'Kind: ',
    'admin.role':'Role: ',
    'admin.visibility':'Visibility: ',
    'admin.session':'Session',
    'admin.content':'Content',
    'admin.chunks':'{n} memory segments',
    'admin.updated':'Updated: ',
    'admin.sharedSkills':'Shared Skills',
    'admin.noSharedSkills':'No shared skills in team.',
    'admin.sharedMemories':'Shared Memories',
    'admin.noSharedMemories':'No shared memories in team.',
    'admin.version':'v',
    'admin.quality':'Quality: ',
    'admin.membersCount':'Members ({n}):',
    'admin.noMembersYet':'No members yet.',
    'admin.loadFailed':'Failed to load admin data: ',
    'admin.noPermission':'You do not have admin permissions to access this panel.',
    'admin.groupsFailed':'Failed to load groups: ',
    'toast.userApproved':'User approved',
    'sharing.approved.toast':'Your join request has been approved!',
    'sharing.rejected.toast':'Your join request was rejected by the admin.',
    'sharing.hubOffline.toast':'Team server is offline. Will reconnect automatically when it comes back.',
    'sharing.hubReconnected.toast':'Team server is back online! Connection restored.',
    'toast.userRejected':'User rejected',
    'toast.approveFail':'Approve failed',
    'toast.rejectFail':'Reject failed',
    'toast.groupCreated':'Group created',
    'toast.groupDeleted':'Group deleted',
    'toast.memberAdded':'Member added',
    'toast.memberRemoved':'Member removed',
    'toast.taskRemoved':'Task removed',
    'toast.skillRemoved':'Skill removed',
    'toast.memoryRemoved':'Memory removed',
    'toast.createFail':'Create failed',
    'toast.deleteFail':'Delete failed',
    'toast.addFail':'Add failed',
    'toast.removeFail':'Remove failed',
    'toast.groupNameRequired':'Group name is required',
    'confirm.rejectUser':'Reject this user?',
    'confirm.removeUser':'Remove this user from the team? This will revoke their access.',
    'confirm.cleanResources':'Also delete all shared resources (tasks, skills, memories) from this user?',
    'toast.userRemoved':'User removed',
    'toast.removeFail':'Remove failed',
    'admin.remove':'Remove',
    'confirm.removeGroupMember':'Remove this member from the group?',
    'confirm.removeMember':'Remove this member?',
    'confirm.deleteGroup':'Delete group "{name}"? Members will be removed.',
    'confirm.deleteGroupShort':'Delete group "{name}"?',
    'confirm.removeTask':'Remove shared task "{name}" from team? This cannot be undone.',
    'confirm.removeSkill':'Remove shared skill "{name}" from team? This cannot be undone.',
    'confirm.removeMemory':'Remove shared memory "{name}" from team? This cannot be undone.',
    'sharing.disabled':'Sharing disabled',
    'sharing.disabled.hint':'Enable sharing in settings to connect a team.',
    'sharing.hubAdmin':'Team Admin',
    'sharing.client':'Client',
    'sharing.hubMode':'Server mode',
    'sharing.hubMode.status':'Status: not connected to self',
    'sharing.hubMode.hint':'Configure sharing.client with hubAddress and userToken pointing to this server to enable admin UI.',
    'sharing.clientConfigured':'Client configured',
    'sharing.clientDisconnected':'Status: disconnected',
    'sharing.clientDisconnected.hint':'Viewer will keep showing local data; team actions may fail until the connection is restored.',
    'sharing.clientNotConfigured':'Client not configured',
    'sharing.clientNotConfigured.hint':'Set hubAddress and userToken in sharing.client to enable team features.',
    'sharing.settingsDisabled':'Sharing is disabled.',
    'sharing.settingsDisabled.hint':'Enable sharing in settings to use team memory and skill collaboration.',
    'sharing.noTeam':'No team connection.',
    'sharing.adminUnavailable':'Admin tools unavailable.',
    'sharing.adminEnabled':'Admin controls enabled',
    'sharing.adminPendingHint':'Pending users will appear below.',
    'sharing.notAdmin':'Current user is not an admin.',
    'sharing.pendingLoadFail':'Failed to load pending users: ',
    'sharing.noPending':'No pending users.',
    'sharing.manageGroups':'Manage Groups',
    'sharing.openAdmin':'Open Admin Panel',
    'sharing.saveUsername':'Save',
    'sharing.username.invalid':'Username must be 2-32 characters',
    'sharing.username.taken':'Username already taken',
    'sharing.username.updated':'Username updated',
    'sharing.username.error':'Failed to update username',
    'sharing.hubNotConfigured':'Server is running but client connection is not configured.',
    'sharing.hubNotConfigured.hint':'Add sharing.client.hubAddress and sharing.client.userToken pointing to this server to enable the admin interface.',
    'sharing.notConnected':'Not connected to team server.',
    'sharing.role':'Role:',
    'sharing.mode':'Mode:',
    'sharing.role.hub':'Server (hosting the team)',
    'sharing.role.client':'Member (connected to team)',
    'sharing.clientConfiguredLabel':'Client configured:',
    'sharing.configuredHub':'Team Server:',
    'sharing.connected':'Connected:',
    'sharing.yes':'yes',
    'sharing.no':'no',
    'sharing.user':'User:',
    'sharing.team':'Team:',
    'sharing.groups':'Groups:',
    'sharing.loading':'Loading...',
    'sharing.loadingGroups':'Loading groups...',
    'sharing.noGroupsYet':'No groups yet.',
    'search.localResults':'Local Results',
    'search.hubResults':'Team Results',
    'search.noLocal':'No local results.',
    'search.noHub':'No team results.',
    'search.viewDetail':'View Detail',
    'search.sharedMemory':'Shared Memory',
    'search.loadFailed':'Failed to load shared memory',
    'share.alreadyShared':'Shared',
    'share.shareBtn':'Share',
    'share.updateBtn':'Update',
    'share.unshareBtn':'Unshare',
    'share.hub.sharedBadge':'Shared to Team',
    'share.hub.shareBtn':'Share to Team',
    'share.hub.unshareBtn':'Remove from Team',
    'share.status.thisAgent':'This Agent',
    'share.status.agents':'Local',
    'share.status.hub':'Team',
    'share.scope.title':'Sharing Scope',
    'share.scope.private':'Private',
    'share.scope.local':'Local Shared',
    'share.scope.team':'Team Shared',
    'share.scope.current':'Current',
    'share.scope.teamDisabled':'Not connected to team server',
    'share.scope.teamIncludes':'Includes visibility to all local agents',
    'share.scope.confirm':'Confirm',
    'share.scope.cancel':'Cancel',
    'share.scope.shrinkToLocal':'This will remove the content from team. Team members will no longer be able to find it. Continue?',
    'share.scope.shrinkToPrivate':'This will remove the content from team and local sharing. Continue?',
    'share.scope.shrinkLocalToPrivate':'This will stop sharing with other local agents. Continue?',
    'share.scope.changed':'Sharing scope updated',
    'share.scope.changeFail':'Failed to update sharing scope',
    'share.scope.inactiveDisabled':'Merged/duplicate memories cannot be shared (not included in search results)',
    'share.scope.taskNotCompleted':'Only completed tasks can be shared (active/skipped tasks are excluded)',
    'share.scope.skillNotActive':'Only active skills can be shared (draft/archived skills are excluded)',
    'skill.pullToLocal':'Pull to Local',
    'toast.taskShared':'Task shared to team',
    'toast.taskShareFail':'Task share failed',
    'toast.taskUnshared':'Task removed from team',
    'toast.taskUnshareFail':'Task unshare failed',
    'toast.memoryShared':'Memory shared to team',
    'toast.memoryShareFail':'Memory share failed',
    'toast.memoryUnshared':'Memory removed from team',
    'toast.memoryUnshareFail':'Memory unshare failed',
    'toast.skillShared':'Skill shared to team',
    'toast.skillShareFail':'Skill share failed',
    'toast.skillUnshared':'Skill removed from team',
    'toast.skillUnshareFail':'Skill unshare failed',
    'share.memoryVisibilityPrompt':'Share visibility (public or group):',
    'share.memoryUnshareConfirm':'Remove this memory from team?',
    'share.memoryLocalUnshareConfirm':'Stop sharing this memory locally?',
    'share.localUnshareConfirm':'Stop sharing locally?',
    'share.teamUnshareConfirm':'Remove from team sharing?',
    'share.local.originalOwnerMissing':'This shared memory has no recorded original owner, so it cannot be restored automatically.',
    'share.group':'Group',
    'share.public':'Public',
    'toast.skillPulled':'Skill pulled to local storage',
    'toast.skillPullFail':'Skill pull failed',
    'task.edit':'Edit',
    'task.delete':'Delete',
    'task.save':'Save',
    'task.cancel':'Cancel',
    'task.delete.confirm':'Are you sure you want to delete this task? This cannot be undone.',
    'task.delete.error':'Failed to delete task: ',
    'task.deleteSelected':'Delete Selected',
    'task.delete.selected.confirm':'Delete {count} selected tasks? This action cannot be undone.',
    'task.delete.success':'Deleted {count} tasks.',
    'task.delete.partial':'Deleted {ok} tasks, failed {fail}.',
    'task.save.error':'Failed to save task: ',
    'task.retrySkill':'Retry Skill Generation',
    'task.retrySkill.short':'Retry Skill',
    'task.retrySkill.confirm':'Re-trigger skill generation for this task?',
    'task.retrySkill.error':'Failed to retry skill generation: ',
    'skill.edit':'Edit',
    'skill.delete':'Delete',
    'skill.save':'Save',
    'skill.cancel':'Cancel',
    'skill.delete.confirm':'Are you sure you want to delete this skill? This will also remove all associated files and cannot be undone.',
    'skill.delete.selected.confirm':'Delete {count} selected skills? This action cannot be undone.',
    'skill.delete.error':'Failed to delete skill: ',
    'skill.delete.partial':'Deleted {ok} skills, failed {fail}.',
    'skill.delete.success':'Deleted {count} skills.',
    'memory.deleteSelected':'Delete Selected',
    'memory.delete.selected.confirm':'Delete {count} selected memories? This action cannot be undone.',
    'memory.delete.success':'Deleted {count} memories.',
    'memory.delete.partial':'Deleted {ok} memories, failed {fail}.',
    'skill.save.error':'Failed to save skill: ',
    'update.available':'New version available',
    'update.run':'Run',
    'update.btn':'Update',
    'update.installing':'Installing...',
    'update.success':'Updated!',
    'update.failed':'Update failed',
    'update.restarting':'Restarting service, page will refresh automatically...',
    'update.dismiss':'Dismiss',
    'sharing.disable.confirm.hub':'You are about to shut down the team server.\\n\\nWhat will happen:\\n\\u2022 All connected team members will be disconnected\\n\\u2022 They will no longer be able to sync memories, tasks, or skills\\n\\u2022 Shared data is preserved and will be available when you re-enable\\n\\nAre you sure?',
    'sharing.disable.confirm.client':'You are about to disconnect from the team.\\n\\nWhat will happen:\\n\\u2022 You will no longer receive shared memories, tasks, or skills from the team\\n\\u2022 Your local data is preserved and will not be affected\\n\\u2022 You can reconnect later by re-enabling sharing\\n\\nAre you sure?',
    'sharing.disable.restartAlert':'Sharing has been disabled. The service will restart automatically to apply the change.',
    'sharing.switch.hubToClient':'You are about to switch from Server to Client mode.\\n\\nWhat will happen:\\n\\u2022 The Hub server will shut down after the service restarts\\n\\u2022 All connected team members will be disconnected\\n\\u2022 Shared data on the Hub is preserved for future use\\n\\u2022 You will join the specified remote team as a client\\n\\nAre you sure?',
    'sharing.switch.clientToHub':'You are about to switch from Client to Server mode.\\n\\nWhat will happen:\\n\\u2022 You will disconnect from the current team\\n\\u2022 A new Hub server will start after the service restarts\\n\\u2022 Your local data is not affected\\n\\nAre you sure?',
    'sharing.switch.hubAddress':'You are about to leave the current team and join a different one.\\n\\nWhat will happen:\\n\\u2022 You will disconnect from the current team server\\n\\u2022 The current team admin will be notified that you left\\n\\u2022 You will join the new team server as a new member\\n\\u2022 Your local data is not affected\\n\\nAre you sure?',
    'admin.notEnabled.title':'Team sharing is not enabled',
    'admin.notEnabled.desc':'The Admin Panel is used to manage team members, shared memories, tasks, and skills. To use this feature, you need to enable team sharing first.',
    'admin.notEnabled.setupHub':'Set Up as Team Server',
    'admin.notEnabled.joinTeam':'Join an Existing Team',
    'admin.notEnabled.hint':'If you have previously configured sharing, your data is still preserved. Re-enabling sharing will restore access to all shared content.',
    'sharing.disconnected.hint':'Unable to reach the team server. The server may be offline or the network is unavailable.',
    'sharing.retryConnection':'Retry Connection',
    'sharing.retryConnection.loading':'Connecting...',
    'sharing.retryConnection.success':'Connected successfully!',
    'sharing.retryConnection.fail':'Still unable to connect. Check if the team server is online.',
    'guide.title':'Get Started with Team Collaboration',
    'guide.subtitle':'MemOS supports team memory sharing. Choose one of the following options to enable collaboration, or continue using local-only mode.',
    'guide.join.title':'Join a Remote Team',
    'guide.join.desc':'Your team already has a server running? Join it to share memories, tasks and skills with team members.',
    'guide.join.s1':'Ask your team admin for the Server Address and Team Token',
    'guide.join.s2':'Go to Settings \u2192 Team Sharing, enable sharing, select "Client" mode',
    'guide.join.s3':'Fill in Server Address and Team Token, click "Test Connection"',
    'guide.join.s4':'Click "Save & Apply" — the service restarts automatically (page refreshes)',
    'guide.join.btn':'\u2192 Configure Client Mode',
    'guide.hub.title':'Start Your Own Team Server',
    'guide.hub.desc':'Be the team server. Run it on this device so others can connect and share memories with you.',
    'guide.hub.s1':'Go to Settings \u2192 Team Sharing, enable sharing, select "Server" mode',
    'guide.hub.s2':'Set a team name, click "Save & Apply" — the service restarts automatically',
    'guide.hub.s3':'Share the Server Address and Team Token with your team members',
    'guide.hub.s4':'Approve join requests in the Admin Panel',
    'guide.hub.btn':'\u2192 Configure Server Mode'
  },
  zh:{
    'title':'OpenClaw 记忆',
    'subtitle':'由 MemOS 驱动',
    'setup.desc':'设置密码以保护你的记忆数据',
    'setup.pw':'输入密码（至少4位）',
    'setup.pw2':'确认密码',
    'setup.btn':'设置密码并进入',
    'setup.err.short':'密码至少需要4个字符',
    'setup.err.mismatch':'两次密码不一致',
    'setup.err.fail':'设置失败',
    'login.desc':'输入密码以访问记忆',
    'login.pw':'密码',
    'login.btn':'解锁',
    'login.err':'密码错误',
    'login.forgot':'忘记密码？',
    'reset.step1.title':'打开终端',
    'reset.step1.desc':'运行以下命令获取重置令牌：',
    'reset.step2.title':'找到令牌',
    'reset.step2.desc.pre':'在输出中找到 ',
    'reset.step2.desc.post':'（纯文本行或 JSON 内）。复制冒号后的32位十六进制字符串。',
    'reset.step3.title':'粘贴并重置',
    'reset.step3.desc':'将令牌粘贴到下方并设置新密码。',
    'reset.token':'在此粘贴重置令牌',
    'reset.newpw':'新密码（至少4位）',
    'reset.newpw2':'确认新密码',
    'reset.btn':'重置密码',
    'reset.err.token':'请输入重置令牌',
    'reset.err.short':'密码至少需要4个字符',
    'reset.err.mismatch':'两次密码不一致',
    'reset.err.fail':'重置失败',
    'reset.back':'\\u2190 返回登录',
    'copy.hint':'点击复制',
    'copy.done':'已复制！',
    'tab.memories':'\\u{1F4DA} 记忆',
    'tab.tasks':'\\u{1F4CB} 任务',
    'tab.skills':'\\u{1F9E0} 技能',
    'tab.analytics':'\\u{1F4CA} 分析',
    'skills.total':'技能总数',
    'skills.active':'生效中',
    'skills.installed':'已安装',
    'skills.public':'公开',
    'skills.search.placeholder':'搜索技能...',
    'skills.search.local':'本地',
    'skills.search.noresult':'未找到匹配的技能',
    'skills.load.error':'加载技能失败',
    'skills.hub.title':'\u{1F310} 团队共享技能',
    'skills.hub.empty':'下方只列出「Hub 上有、但上方本机列表尚未包含」的技能；若 Hub 条目已与本机同源同步，则只会在上方显示，此处为空属正常。',
    'skills.hub.loadError':'加载团队技能失败',
    'skills.hub.timeout':'加载团队技能超时，请确认团队服务已启动且已连接。',
    'scope.local':'本地',
    'scope.thisAgent':'仅本智能体',
    'scope.thisDevice':'本机所有智能体',
    'scope.group':'团队',
    'scope.all':'全部',
    'skills.visibility.public':'本机共享',
    'skills.visibility.private':'仅本智能体',
    'skills.setPublic':'共享给本机智能体',
    'skills.setPrivate':'仅本智能体',
    'tasks.total':'任务总数',
    'tasks.active':'进行中',
    'tasks.completed':'已完成',
    'tasks.status.active':'进行中',
    'tasks.status.completed':'已完成',
    'tasks.status.skipped':'已跳过',
    'tasks.search.placeholder':'搜索任务...',
    'tasks.search.meta':'找到 {0} 个任务',
    'tasks.empty':'暂无任务。任务会随着对话自动创建。',
    'tasks.loading':'加载中...',
    'tasks.untitled':'未命名任务',
    'tasks.chunks':'关联记忆',
    'tasks.nochunks':'此任务暂无关联记忆。',
    'tasks.expand':'展开全文',
    'tasks.collapse':'收起',
    'tasks.skipped.default':'对话内容过少，未生成摘要。该任务不会出现在检索结果中。',
    'refresh':'\\u21BB 刷新',
    'logout':'退出',
    'notif.title':'\\u{1F514} 通知',
    'notif.markAll':'全部已读',
    'notif.empty':'暂无通知',
    'notif.removed.memory':'你共享的记忆被管理员移除',
    'notif.removed.task':'你共享的任务被管理员移除',
    'notif.removed.skill':'你共享的技能被管理员移除',
    'notif.shared.memory':'有新的记忆被共享',
    'notif.shared.task':'有新的任务被共享',
    'notif.shared.skill':'有新的技能被共享',
    'notif.unshared.memory':'有记忆取消了共享',
    'notif.unshared.task':'有任务取消了共享',
    'notif.unshared.skill':'有技能取消了共享',
    'notif.userJoin':'有新用户申请加入团队',
    'notif.userOnline':'用户上线了',
    'notif.userOffline':'用户下线了',
    'notif.userLeft':'用户已退出团队',
    'notif.membershipApproved':'你的团队加入申请已通过',
    'notif.membershipRejected':'你的团队加入申请已被拒绝',
    'notif.membershipRemoved':'你已被管理员移出团队',
    'notif.hubShutdown':'团队服务已关闭',
    'notif.rolePromoted':'你已被提升为管理员',
    'notif.roleDemoted':'你已被设为普通成员',
    'notif.usernameRenamed':'你的昵称已被管理员修改',
    'notif.usernameRenamed.detail':'{oldName} → {newName}',
    'notif.clearAll':'清除全部',
    'notif.timeAgo.just':'刚刚',
    'notif.timeAgo.min':'{n}分钟前',
    'notif.timeAgo.hour':'{n}小时前',
    'notif.timeAgo.day':'{n}天前',
    'stat.memories':'记忆',
    'stat.tasks':'任务',
    'stat.skills':'技能',
    'stat.agents':'智能体',
    'stat.active':'活跃',
    'stat.deduped':'已去重',
    'sidebar.sessions':'会话列表',
    'sidebar.allsessions':'全部会话',
    'sidebar.clear':'\\u{1F5D1} 清除所有数据',
    'search.placeholder':'搜索记忆（支持语义搜索）...',
    'search.meta.total':' 条记忆',
    'search.meta.semantic':' 语义',
    'search.meta.text':' 文本',
    'search.meta.results':' 条结果',
    'filter.all':'全部',
    'filter.newest':'最新优先',
    'filter.oldest':'最早优先',
    'filter.allowners':'所有归属',
    'filter.allagents':'全部智能体',
    'filter.allsessions':'全部会话',
    'filter.public':'公开',
    'filter.private':'私有',
    'filter.allvisibility':'所有可见性',
    'filter.from':'起始',
    'filter.to':'截止',
    'filter.clear':'清除',
    'empty.text':'暂无记忆',
    'card.expand':'展开',
    'card.edit':'编辑',
    'card.delete':'删除',
    'card.evolved':'已演化',
    'card.times':'次',
    'card.newMessage':'新消息',
    'card.mergedInfo':'合并记忆',
    'card.updated':'更新于',
    'card.evolveHistory':'演化记录',
    'card.oldSummary':'旧摘要',
    'card.dedupDuplicate':'重复',
    'card.dedupMerged':'已合并',
    'card.dedupTarget':'关联: ',
    'card.dedupReason':'原因: ',
    'card.newSummary':'新摘要',
    'pagination.pageSize':'每页数量',
    'pagination.total':' 条',
    'range':'范围',
    'range.days':'天',
    'analytics.total':'总记忆数',
    'analytics.writes':'今日写入',
    'analytics.calls':'今日查看器调用',
    'analytics.sessions':'会话数',
    'analytics.embeddings':'嵌入数',
    'chart.writes':'每日记忆写入',
    'chart.calls':'每日查看器 API 调用（列表 / 搜索）',
    'chart.nodata':'此范围内暂无数据',
    'chart.nocalls':'此范围内暂无查看器调用',
    'chart.toolperf':'工具响应耗时',
    'chart.apply':'应用',
    'chart.selectRange':'请选择时间范围',
    'chart.list':'列表',
    'chart.search':'搜索',
    'modal.edit':'编辑记忆',
    'modal.role':'角色',
    'modal.content':'内容',
    'modal.content.ph':'记忆内容...',
    'modal.summary':'摘要',
    'modal.summary.ph':'简要摘要（可选）',
    'modal.cancel':'取消',
    'modal.save':'保存',
    'modal.err.empty':'请输入内容',
    'toast.updated':'记忆已更新',
    'toast.deleted':'记忆已删除',
    'toast.opfail':'操作失败',
    'toast.delfail':'删除失败',
    'toast.setPublic':'已共享给本机智能体',
    'toast.setPrivate':'现在仅本智能体可见',
    'toast.cleared':'所有记忆已清除',
    'toast.clearfail':'清除失败',
    'toast.notfound':'缓存中未找到此记忆',
    'confirm.title':'确认',
    'confirm.ok':'确定',
    'confirm.cancel':'取消',
    'confirm.delete':'确定要删除这条记忆吗？',
    'confirm.clearall':'确定要删除所有记忆？此操作不可撤销。',
    'confirm.clearall2':'你真的确定吗？',
    'embed.on':'嵌入模型：',
    'embed.off':'无嵌入模型',
    'embed.warn.local':'当前使用内置迷你模型（384维），搜索效果有限。强烈建议在「设置」中配置专用 Embedding 模型以获得最佳效果。',
    'embed.err.fail':'Embedding 模型调用异常，请前往「设置 → 模型健康」检查。',
    'embed.banner.goto':'前往设置',
    'lang.switch':'EN',
    'tab.logs':'\u{1F4DD} 日志',
    'logs.allTools':'全部工具',
    'logs.refresh':'刷新',
    'logs.autoRefresh':'自动刷新',
    'logs.input':'输入',
    'logs.output':'输出',
    'logs.empty':'暂无日志。当工具被调用时日志会显示在这里。',
    'logs.ago':'前',
    'logs.recall.initial':'初始检索',
    'logs.recall.hubRemote':'远程召回',
    'logs.recall.filtered':'LLM 过滤后',
    'logs.recall.noHits':'未匹配到记忆',
    'logs.recall.noneRelevant':'LLM 过滤：无相关记忆',
    'logs.recall.more':'还有 {n} 条...',
    'recall.origin.localShared':'本机共享',
    'recall.origin.hubMemory':'团队缓存',
    'recall.origin.hubRemote':'团队',
    'tab.import':'\u{1F4E5} 导入',
    'tab.settings':'\u2699 设置',
    'settings.modelconfig':'模型配置',
    'settings.models':'AI 模型',
    'settings.models.desc':'配置嵌入模型、摘要模型和技能进化模型',
    'settings.modelhealth':'模型健康',
    'settings.embedding':'嵌入模型',
    'settings.summarizer':'摘要模型',
    'settings.skill':'技能进化',
    'settings.general':'通用设置',
    'settings.embedding.desc':'向量嵌入模型，用于记忆检索和语义搜索',
    'settings.summarizer.desc':'大语言模型，用于记忆摘要、去重和分析',
    'settings.skill.desc':'从对话模式中自动提取可复用的技能',
    'settings.hub.desc':'与团队共享记忆、任务和技能',
    'settings.general.desc':'系统状态、端口和数据统计',
    'settings.hostproxy.embedding':'复用网关模型',
    'settings.hostproxy.completion':'复用网关模型',
    'settings.hostproxy.skill':'复用网关模型',
    'settings.hostproxy.hint.short':'复用网关已有的模型配置',
    'settings.provider':'服务商',
    'settings.model':'模型',
    'settings.temperature':'温度',
    'settings.skill.enabled':'启用技能进化',
    'settings.skill.autoinstall':'自动安装技能',
    'settings.skill.confidence':'最低置信度',
    'settings.skill.minchunks':'最少记忆片段',
    'settings.skill.model':'技能专用模型',
    'settings.skill.model.hint':'不配置则复用摘要模型。如需更高质量可单独指定。',
    'settings.optional':'可选',
    'settings.skill.usemain':'使用主摘要模型',
    'settings.telemetry':'数据统计',
    'settings.telemetry.enabled':'启用匿名数据统计',
    'settings.telemetry.hint':'仅收集工具名称、响应时间和版本号，不涉及任何记忆内容或个人数据。',
    'settings.viewerport':'Viewer 端口',
    'settings.viewerport.hint':'修改后需重启网关生效',
    'settings.taskAutoFinalize':'任务自动完结（小时）',
    'settings.taskAutoFinalize.hint':'处于进行中的任务如果超过设定时间没有新消息，打开任务页面时会自动生成总结并标记为已完成。设为 0 则关闭此功能。默认：4 小时。',
    'settings.test':'测试连接',
    'settings.test.loading':'测试中...',
    'settings.test.ok':'连接成功',
    'settings.test.fail':'连接失败',
    'settings.session.expired':'登录已过期，请刷新页面重新登录',
    'settings.save':'保存并应用',
    'settings.reset':'重置',
    'settings.saved':'已保存',
    'settings.restart.hint':'修改将在服务自动重启后生效。',
    'settings.restart.autoRefresh':'服务重启中，页面将自动刷新...',
    'settings.restart.waiting':'配置已保存，服务正在重启...',
    'settings.save.fail':'保存设置失败',
    'settings.save.emb.required':'嵌入模型为必填项，请先配置嵌入模型再保存。',
    'settings.save.emb.fail':'嵌入模型测试失败，无法保存',
    'settings.save.sum.fail':'摘要模型测试失败，无法保存',
    'settings.save.skill.fail':'技能模型测试失败，无法保存',
    'settings.save.sum.fallback':'摘要模型未配置 — 将使用 OpenClaw 原生模型作为降级方案。',
    'settings.save.skill.fallback':'技能专用模型未配置 — 将使用 OpenClaw 原生模型作为降级方案。',
    'settings.save.fallback.model':'降级模型：',
    'settings.save.fallback.none':'不可用（未检测到 OpenClaw 原生模型）',
    'settings.save.fallback.confirm':'是否继续保存？',
    'migrate.title':'导入 OpenClaw 记忆',
    'migrate.desc':'将 OpenClaw 内置的记忆数据和对话历史迁移到本插件中。导入过程使用智能去重，避免重复导入。',
    'migrate.modes.title':'三种使用方式：',
    'migrate.mode1.label':'\u2460 仅导入记忆（快速）',
    'migrate.mode1.desc':'——点击「开始导入」即可快速迁移所有记忆片段和对话历史，不进行任务/技能生成。适合只需要原始数据的场景。',
    'migrate.mode2.label':'\u2461 导入 + 生成任务与技能（较慢，串行）',
    'migrate.mode2.desc':'——导入记忆后，在下方勾选「生成任务摘要」和/或「触发技能进化」，系统会逐个会话分析。由于每个会话都需要 LLM 处理，耗时较长。',
    'migrate.mode3.label':'\u2462 先导入，随时再生成（灵活）',
    'migrate.mode3.desc':'——先导入记忆，之后随时可以回来开启任务/技能生成。生成过程可以随时暂停，下次继续时会从上次停下的地方接着处理，已处理的会话会自动跳过。',
    'migrate.config.warn':'需要配置',
    'migrate.config.warn.desc':'请先在上方配置好 Embedding 模型和 Summarizer 模型，这两项是处理记忆所必需的。',
    'migrate.sqlite.label':'记忆索引 (SQLite)',
    'migrate.sessions.label':'对话历史',
    'migrate.concurrency.label':'并行 Agent 数',
    'migrate.concurrency.warn':'\u26A0 提高并行数会增加 LLM API 调用频率，可能触发限流而导致失败。',
    'migrate.scan':'扫描数据源',
    'migrate.start':'开始导入',
    'migrate.scanning':'扫描中...',
    'migrate.scan.required':'请先扫描数据源',
    'migrate.scan.done':'扫描完成 — 发现 {n} 条新数据可导入',
    'migrate.imported.hint':'已导入 {n} 条记忆',
    'migrate.reconnect.hint':'--- 页面刷新前已处理 {n} 条 ---',
    'migrate.stat.stored':'已存储',
    'migrate.stat.skipped':'已跳过',
    'migrate.stat.merged':'已合并',
    'migrate.stat.errors':'错误',
    'migrate.phase.sqlite':'正在导入记忆索引...',
    'migrate.phase.sessions':'正在导入对话历史...',
    'migrate.phase.stopped':'导入已停止',
    'migrate.phase.done':'导入完成',
    'migrate.chunks':'条记忆',
    'migrate.sessions.count':'个会话，{n} 条消息',
    'migrate.nodata':'未找到可导入的 OpenClaw 数据。',
    'migrate.running':'导入进行中...',
    'migrate.error.running':'已有迁移任务正在进行。',
    'migrate.stop':'\\u25A0 停止',
    'migrate.stopping':'正在停止...',
    'migrate.resume':'继续导入',
    'pp.title':'\\u{1F9E0} 可选：生成任务与技能',
    'pp.desc':'此步骤完全可选。上面的导入已经存储了原始记忆数据。在这里可以进一步分析已导入的对话，生成结构化的任务摘要或进化可复用的技能。处理过程是串行的（逐个会话），可能需要较长时间。你可以随时停止，下次继续时只会处理尚未完成的会话。',
    'pp.tasks.label':'生成任务摘要',
    'pp.tasks.hint':'将导入的消息按任务分组，为每个任务生成结构化摘要（标题、目标、步骤、结果），方便日后搜索和回忆。',
    'pp.skills.label':'触发技能进化',
    'pp.skills.hint':'分析已完成的任务，自动创建或升级可复用的技能（SKILL.md）。需要先启用任务摘要。由于需要 LLM 评估，耗时较长。',
    'pp.concurrency.label':'并行 Agent 数',
    'pp.concurrency.warn':'\u26A0 提高并行数会增加 LLM API 调用频率，可能触发限流而导致失败。',
    'pp.start':'开始处理',
    'pp.resume':'继续处理',
    'pp.running':'正在处理',
    'pp.stopped':'处理已停止，你可以随时继续。',
    'pp.failed':'处理失败，请查看上方的错误提示。',
    'pp.done':'任务与技能生成完成！',
    'pp.select.warn':'请至少选择一个选项。',
    'pp.skill.created':'技能已创建',
    'pp.stat.tasks':'任务',
    'pp.stat.skills':'进化',
    'pp.stat.skills.total':'技能',
    'pp.stat.errors':'错误',
    'pp.stat.skipped':'已跳过',
    'pp.info.skipped':'已有 {n} 个会话处理过，自动跳过。',
    'pp.info.pending':'正在处理 {n} 个会话...',
    'pp.info.allDone':'所有会话均已处理过，无需重复处理。',
    'pp.action.full':'任务+技能',
    'pp.action.skillOnly':'仅技能（任务已存在）',
    'card.imported':'OpenClaw 原生记忆',
    'skills.draft':'草稿',
    'skills.filter.active':'生效中',
    'skills.filter.draft':'草稿',
    'skills.filter.archived':'已归档',
    'skills.files':'技能文件',
    'skills.content':'SKILL.md 内容',
    'skills.versions':'版本历史',
    'skills.related':'关联任务',
    'skills.download':'\u2B07 下载',
    'skills.installed.badge':'已安装',
    'skills.empty':'暂无技能。技能会从已完成的任务中自动提炼生成。',
    'skills.loading':'加载中...',
    'skills.error':'加载技能失败',
    'skills.error.detail':'加载技能失败：',
    'skills.nofiles':'暂无文件',
    'skills.noversions':'暂无版本记录',
    'skills.norelated':'暂无关联任务',
    'skills.nocontent':'暂无内容',
    'skills.hub.markdownPending':'团队列表未返回完整 SKILL.md 正文。请先「拉取到本地」，再在本机技能里打开该技能即可查看正文、文件与版本。',
    'skills.nochangelog':'暂无变更记录',
    'skills.status.active':'生效中',
    'skills.status.draft':'草稿',
    'skills.status.archived':'已禁用',
    'skills.action.disable':'禁用',
    'skills.action.enable':'启用',
    'skills.action.delete':'删除',
    'skills.disable.confirm':'确定要禁用此技能吗？禁用后不再参与检索和自动召回，但可以随时重新启用。',
    'skills.disable.error':'禁用技能失败：',
    'skills.enable.error':'启用技能失败：',
    'skills.updated':'更新于：',
    'skills.task.prefix':'任务：',
    'skills.selectAll':'全选',
    'skills.unselectAll':'取消全选',
    'skills.deleteSelected':'删除选中',
    'tasks.chunks.label':'条记忆',
    'tasks.taskid':'任务 ID：',
    'tasks.role.user':'你',
    'tasks.role.assistant':'助手',
    'tasks.error':'出错了',
    'tasks.error.detail':'加载任务详情失败',
    'tasks.untitled.related':'未命名',
    'tab.admin':'\u{1F6E1} 管理',
    'settings.hub':'团队共享',
    'settings.hub.enable':'启用团队共享',
    'settings.hub.enable.hint':'关闭时仅本地使用，不影响其他功能。',
    'settings.hub.enable.label':'启用团队共享',
    'settings.hub.role':'角色',
    'settings.hub.role.hub':'服务端（托管团队）',
    'settings.hub.role.client':'客户端（加入团队）',
    'settings.hub.role.hint':'服务端 = 本机托管团队；客户端 = 加入别人的团队。两种模式互斥，不能同时使用。',
    'settings.hub.port':'服务端口',
    'settings.hub.port.hint':'团队服务端口，默认 18800',
    'settings.hub.teamName':'团队名称',
    'settings.hub.teamName.hint':'你的团队显示名称',
    'settings.hub.adminName':'管理员名称',
    'settings.hub.adminName.hint':'你在团队中的显示名称',
    'settings.hub.teamToken':'团队令牌',
    'settings.hub.teamToken.hint':'自动生成的密钥，点击可复制。请将此令牌分享给团队成员。',
    'settings.hub.tokenCopied':'团队令牌已复制！',
    'settings.hub.hubSteps.title':'快速配置（3 步）',
    'settings.hub.hubSteps.s1':'填写下方团队名称（或保持默认）',
    'settings.hub.hubSteps.s2':'点击「保存并应用」，服务将自动重启',
    'settings.hub.hubSteps.s3':'将下方的服务器地址和团队令牌分享给团队成员',
    'settings.hub.clientSteps.title':'快速配置（3 步）',
    'settings.hub.clientSteps.s1':'向团队管理员获取服务器地址和团队令牌',
    'settings.hub.clientSteps.s2':'填入下方，点击"测试连接"验证连通性',
    'settings.hub.clientSteps.s3':'点击「保存并应用」，服务将自动重启（页面会自动刷新）',
    'settings.hub.shareInfo.title':'请将以下信息分享给团队成员：',
    'settings.hub.shareInfo.yourIP':'你的IP',
    'settings.hub.shareInfo.clickCopy':'点击复制',
    'settings.hub.restartAlert':'团队共享配置已保存！服务将自动重启以应用更改。',
    'settings.hub.hubAddress':'服务器地址',
    'settings.hub.hubAddress.hint':'团队服务器地址，如 192.168.1.100:18800',
    'settings.hub.teamTokenClient':'团队令牌',
    'settings.hub.teamTokenClient.hint':'向团队管理员获取此令牌以加入团队',
    'settings.hub.nickname':'昵称',
    'settings.hub.nickname.hint':'你在团队中的显示名称。留空则使用系统用户名。',
    'settings.hub.userToken':'用户令牌',
    'settings.hub.userToken.hint':'通常在加入团队后自动获取，无需手动填写。',
    'settings.hub.testConnection':'测试连接',
    'settings.hub.test.noAddr':'请先输入服务器地址',
    'settings.hub.teamToken.required':'请输入团队令牌',
    'settings.hub.test.testing':'测试中...',
    'settings.hub.test.ok':'连接成功',
    'settings.hub.test.fail':'连接失败',
    'settings.hub.connection':'连接状态',
    'settings.hub.team':'团队与分组',
    'settings.hub.adminPending':'管理员待审用户',
    'sidebar.hub':'\u{1F310} 团队共享',
    'sharing.sidebar.connected':'已连接',
    'sharing.sidebar.disconnected':'已断开',
    'sharing.sidebar.hubRunning':'服务运行中',
    'sharing.sidebar.teamName':'团队',
    'sharing.sidebar.members':'成员',
    'sharing.sidebar.online':'在线',
    'sharing.sidebar.pending':'等待审核',
    'sharing.sidebar.rejected':'已拒绝',
    'sharing.sidebar.starting':'启动中...',
    'sharing.sidebar.notConfigured':'未配置',
    'sharing.sidebar.identity':'身份：',
    'sharing.sidebar.admin':'管理员',
    'sharing.sidebar.targetHub':'团队服务器：',
    'sharing.pendingApproval.hint':'加入申请已提交，请等待团队管理员审核通过。',
    'sharing.rejected.hint':'您的加入申请已被团队管理员拒绝，请联系管理员或重新申请。',
    'sharing.removed.hint':'您已被管理员从团队中移除，可以重新申请加入。',
    'sharing.joinTeam':'加入团队',
    'sharing.joinSent.pending':'加入申请已发送，等待管理员审批。',
    'sharing.joinSent.active':'成功加入团队！',
    'sharing.retryJoin':'重新申请',
    'sharing.retryJoin.hint':'清除本地连接数据并重新提交加入申请',
    'sharing.retryJoin.confirm':'这将清除当前连接数据并重新提交加入申请，是否继续？',
    'sharing.leaveTeam':'退出团队',
    'sharing.leaveTeam.confirm':'你即将退出团队「{team}」。\\n\\n退出后将会：\\n\\u2022 断开与团队服务器的连接\\n\\u2022 团队管理员会收到你退出的通知\\n\\u2022 你将无法再接收团队共享的记忆、任务和技能\\n\\u2022 你的本地数据不受影响，会完整保留\\n\\u2022 之后可以重新申请加入（需管理员审批）\\n\\n确定要退出吗？',
    'sharing.leaveTeam.success':'你已退出团队，团队共享已关闭。',
    'sharing.leaveTeam.fail':'退出团队失败',
    'sharing.team.default':'该团队',
    'sharing.retryJoin.success':'加入申请已重新提交，请等待管理员审核。',
    'sharing.retryJoin.fail':'重新申请失败',
    'sharing.joinError.hubUnreachable':'无法连接到团队服务器，服务器可能已下线或网络不可用。请检查服务器地址后重试。',
    'sharing.joinError.usernameTaken':'该用户名在团队服务器上已被占用，请到设置中修改昵称后再重试。',
    'sharing.joinError.invalidToken':'团队令牌无效，请向管理员确认令牌并在设置中更新。',
    'sharing.joinError.blocked':'您的账号已被团队管理员封禁，请联系管理员处理。',
    'sharing.ownerRemoved':'(已移除)',
    'sharing.cannotJoinSelf':'不能加入自己的服务端，请输入远程服务器地址。',
    'scope.hub':'团队',
    'memory.detail.title':'记忆详情',
    'memory.detail.loading':'加载中...',
    'memory.detail.notFound':'未找到该记忆',
    'memory.detail.copyId':'点击复制 ID',
    'memory.detail.created':'创建于 ',
    'memory.detail.updated':'更新于 ',
    'memory.detail.viewTarget':'查看目标: ',
    'admin.title':'团队管理面板',
    'admin.subtitle':'管理团队成员和共享资源',
    'admin.subtitle.member':'浏览团队共享的记忆、任务和技能',
    'admin.refresh':'\u21BB 刷新',
    'admin.tab.users':'用户',
    'admin.tab.tasks':'共享任务',
    'admin.tab.groups':'分组',
    'admin.tab.memories':'共享记忆',
    'admin.tab.skills':'共享技能',
    'admin.stat.activeUsers':'活跃用户',
    'admin.stat.pending':'待审核',
    'admin.stat.groups':'分组',
    'admin.stat.sharedTasks':'共享任务',
    'admin.stat.sharedSkills':'共享技能',
    'admin.stat.sharedMemories':'共享记忆',
    'admin.pendingApproval':'待审批',
    'admin.activeUsers':'活跃用户',
    'admin.noActiveUsers':'暂无活跃用户。',
    'admin.onlineUsers':'在线',
    'admin.offlineUsers':'离线',
    'admin.online':'在线',
    'admin.offline':'离线',
    'admin.offlineFor':'离线 {time}',
    'admin.onlineNow':'当前在线',
    'admin.approve':'批准',
    'admin.reject':'拒绝',
    'admin.device':'设备：',
    'admin.joined':'加入：',
    'admin.approved':'审批：',
    'admin.lastActive':'最后活跃：',
    'admin.ip':'IP：',
    'admin.contrib.memories':'记忆',
    'admin.contrib.tasks':'任务',
    'admin.contrib.skills':'技能',
    'admin.groups':'分组：',
    'admin.neverActive':'从未',
    'admin.promoteAdmin':'提升为管理员',
    'admin.demoteMember':'降为成员',
    'admin.editName':'编辑名称',
    'admin.lastAdminHint':'唯一管理员 — 无法删除或降级',
    'admin.ownerHint':'Hub 创建者 — 不可降级或移除',
    'admin.selfHint':'这是你自己',
    'admin.editNamePrompt':'请输入新用户名：',
    'confirm.promoteAdmin':'确定要将此用户提升为管理员吗？管理员可以管理所有团队成员和资源。',
    'confirm.demoteMember':'确定要将此管理员降为普通成员吗？',
    'toast.roleChanged':'角色已更新',
    'toast.roleChangeFail':'角色更新失败',
    'toast.usernameChanged':'用户名已更新',
    'toast.renameFail':'重命名失败',
    'toast.invalidUsername':'用户名长度需为 2-32 个字符',
    'admin.filterAll':'全部用户',
    'admin.filterAllValues':'全部',
    'admin.filter.owner':'全部用户',
    'admin.filter.visibility':'可见性',
    'admin.filter.group':'团队',
    'admin.search.placeholder':'搜索...',
    'admin.sort.newest':'最新优先',
    'admin.sort.oldest':'最早优先',
    'admin.filter.role':'角色',
    'admin.filter.status':'状态',
    'admin.expand':'展开',
    'admin.collapse':'收起',
    'admin.noContent':'暂无内容',
    'admin.summary':'摘要',
    'admin.description':'描述',
    'admin.contentLabel':'内容',
    'admin.groups':'分组',
    'admin.newGroup':'+ 新建分组',
    'admin.groupName':'分组名称',
    'admin.groupDesc':'描述（可选）',
    'admin.create':'创建',
    'admin.cancel':'取消',
    'admin.delete':'删除',
    'admin.members':'成员',
    'admin.noGroups':'暂无分组。',
    'admin.noMembers':'暂无成员。',
    'admin.add':'添加',
    'admin.remove':'移除',
    'admin.sharedTasks':'共享任务',
    'admin.noSharedTasks':'团队暂无共享任务。',
    'admin.owner':'归属：',
    'admin.group':'分组：',
    'admin.kind':'类型：',
    'admin.role':'角色：',
    'admin.visibility':'可见性：',
    'admin.session':'会话',
    'admin.content':'内容',
    'admin.chunks':'{n}段记忆片段',
    'admin.updated':'更新于：',
    'admin.sharedSkills':'共享技能',
    'admin.noSharedSkills':'团队暂无共享技能。',
    'admin.sharedMemories':'共享记忆',
    'admin.noSharedMemories':'团队暂无共享记忆。',
    'admin.version':'v',
    'admin.quality':'质量：',
    'admin.membersCount':'成员（{n}）：',
    'admin.noMembersYet':'暂无成员。',
    'admin.loadFailed':'加载管理数据失败：',
    'admin.noPermission':'您没有管理员权限，无法访问此面板。',
    'admin.groupsFailed':'加载分组失败：',
    'toast.userApproved':'用户已批准',
    'sharing.approved.toast':'您的加入申请已通过审核！',
    'sharing.rejected.toast':'您的加入申请已被管理员拒绝。',
    'sharing.hubOffline.toast':'团队服务已离线，恢复后将自动重新连接。',
    'sharing.hubReconnected.toast':'团队服务已恢复上线，连接已自动恢复！',
    'toast.userRejected':'用户已拒绝',
    'toast.approveFail':'批准失败',
    'toast.rejectFail':'拒绝失败',
    'toast.groupCreated':'分组已创建',
    'toast.groupDeleted':'分组已删除',
    'toast.memberAdded':'成员已添加',
    'toast.memberRemoved':'成员已移除',
    'toast.taskRemoved':'任务已移除',
    'toast.skillRemoved':'技能已移除',
    'toast.memoryRemoved':'记忆已移除',
    'toast.createFail':'创建失败',
    'toast.deleteFail':'删除失败',
    'toast.addFail':'添加失败',
    'toast.removeFail':'移除失败',
    'toast.groupNameRequired':'请输入分组名称',
    'confirm.rejectUser':'确定要拒绝此用户吗？',
    'confirm.removeUser':'确定要移除此用户吗？移除后该用户将无法访问团队资源。',
    'confirm.cleanResources':'是否同时删除该用户共享的所有资源（任务、技能、记忆）？',
    'toast.userRemoved':'用户已移除',
    'toast.removeFail':'移除失败',
    'admin.remove':'移除',
    'confirm.removeGroupMember':'确定要将此成员移出分组吗？',
    'confirm.removeMember':'确定要移除此成员吗？',
    'confirm.deleteGroup':'确定要删除分组「{name}」吗？成员将被移除。',
    'confirm.deleteGroupShort':'确定要删除分组「{name}」吗？',
    'confirm.removeTask':'确定要从团队移除共享任务「{name}」吗？此操作不可撤销。',
    'confirm.removeSkill':'确定要从团队移除共享技能「{name}」吗？此操作不可撤销。',
    'confirm.removeMemory':'确定要从团队移除共享记忆「{name}」吗？此操作不可撤销。',
    'sharing.disabled':'共享已禁用',
    'sharing.disabled.hint':'在设置中启用共享以连接团队。',
    'sharing.hubAdmin':'团队管理员',
    'sharing.client':'客户端',
    'sharing.hubMode':'服务端模式',
    'sharing.hubMode.status':'状态：未连接到自身',
    'sharing.hubMode.hint':'配置 sharing.client 的 hubAddress 和 userToken 指向此服务端以启用管理界面。',
    'sharing.clientConfigured':'客户端已配置',
    'sharing.clientDisconnected':'状态：已断开',
    'sharing.clientDisconnected.hint':'查看器将继续显示本地数据；团队操作可能在连接恢复前失败。',
    'sharing.clientNotConfigured':'客户端未配置',
    'sharing.clientNotConfigured.hint':'设置 sharing.client 中的 hubAddress 和 userToken 以启用团队功能。',
    'sharing.settingsDisabled':'共享已禁用。',
    'sharing.settingsDisabled.hint':'在设置中启用共享以使用团队记忆和技能协作。',
    'sharing.noTeam':'无团队连接。',
    'sharing.adminUnavailable':'管理工具不可用。',
    'sharing.adminEnabled':'管理控制已启用',
    'sharing.adminPendingHint':'待审用户将显示在下方。',
    'sharing.notAdmin':'当前用户不是管理员。',
    'sharing.pendingLoadFail':'加载待审用户失败：',
    'sharing.noPending':'暂无待审用户。',
    'sharing.manageGroups':'管理分组',
    'sharing.openAdmin':'打开管理面板',
    'sharing.saveUsername':'保存',
    'sharing.username.invalid':'用户名需 2-32 个字符',
    'sharing.username.taken':'用户名已被占用',
    'sharing.username.updated':'用户名已更新',
    'sharing.username.error':'更新用户名失败',
    'sharing.hubNotConfigured':'服务端正在运行，但客户端连接未配置。',
    'sharing.hubNotConfigured.hint':'添加 sharing.client.hubAddress 和 sharing.client.userToken 指向此服务端以启用管理界面。',
    'sharing.notConnected':'未连接到团队服务器。',
    'sharing.role':'角色：',
    'sharing.mode':'身份：',
    'sharing.role.hub':'服务端（托管团队）',
    'sharing.role.client':'成员（连接到团队）',
    'sharing.clientConfiguredLabel':'客户端已配置：',
    'sharing.configuredHub':'团队服务器：',
    'sharing.connected':'已连接：',
    'sharing.yes':'是',
    'sharing.no':'否',
    'sharing.user':'用户：',
    'sharing.team':'团队：',
    'sharing.groups':'分组：',
    'sharing.loading':'加载中...',
    'sharing.loadingGroups':'正在加载分组...',
    'sharing.noGroupsYet':'暂无分组。',
    'search.localResults':'本地结果',
    'search.hubResults':'团队结果',
    'search.noLocal':'无本地结果。',
    'search.noHub':'无团队结果。',
    'search.viewDetail':'查看详情',
    'search.sharedMemory':'共享记忆',
    'search.loadFailed':'加载共享记忆失败',
    'share.alreadyShared':'已共享',
    'share.shareBtn':'共享',
    'share.updateBtn':'更新共享',
    'share.unshareBtn':'取消共享',
    'share.hub.sharedBadge':'已共享到团队',
    'share.hub.shareBtn':'共享到团队',
    'share.hub.unshareBtn':'从团队移除',
    'share.status.thisAgent':'当前智能体',
    'share.status.agents':'本机',
    'share.status.hub':'团队',
    'share.scope.title':'共享范围',
    'share.scope.private':'私有',
    'share.scope.local':'本机共享',
    'share.scope.team':'团队共享',
    'share.scope.current':'当前',
    'share.scope.teamDisabled':'未连接团队服务器',
    'share.scope.teamIncludes':'包含本机所有智能体的可见性',
    'share.scope.confirm':'确认',
    'share.scope.cancel':'取消',
    'share.scope.shrinkToLocal':'将从团队中移除此内容，团队成员将无法搜索到。确认？',
    'share.scope.shrinkToPrivate':'将从团队和本机共享中移除此内容。确认？',
    'share.scope.shrinkLocalToPrivate':'将停止共享给其他智能体。确认？',
    'share.scope.changed':'共享范围已更新',
    'share.scope.changeFail':'更新共享范围失败',
    'share.scope.inactiveDisabled':'已合并/重复的记忆无法共享（不会出现在检索结果中）',
    'share.scope.taskNotCompleted':'仅已完成的任务可以共享（进行中/已跳过的任务无法共享）',
    'share.scope.skillNotActive':'仅活跃的技能可以共享（草稿/已归档的技能无法共享）',
    'skill.pullToLocal':'拉取到本地',
    'toast.taskShared':'任务已共享到团队',
    'toast.taskShareFail':'任务共享失败',
    'toast.taskUnshared':'任务已从团队移除',
    'toast.taskUnshareFail':'取消共享失败',
    'toast.memoryShared':'记忆已共享到团队',
    'toast.memoryShareFail':'记忆共享失败',
    'toast.memoryUnshared':'记忆已从团队移除',
    'toast.memoryUnshareFail':'记忆取消共享失败',
    'toast.skillShared':'技能已共享到团队',
    'toast.skillShareFail':'技能共享失败',
    'toast.skillUnshared':'技能已从团队移除',
    'toast.skillUnshareFail':'技能取消共享失败',
    'share.memoryVisibilityPrompt':'共享范围（public 或 group）：',
    'share.memoryUnshareConfirm':'从团队移除该记忆？',
    'share.memoryLocalUnshareConfirm':'停止本机共享该记忆？',
    'share.localUnshareConfirm':'停止本机共享？',
    'share.teamUnshareConfirm':'从团队共享中移除？',
    'share.local.originalOwnerMissing':'该共享记忆没有记录原始所有者，无法自动恢复。',
    'share.group':'团队',
    'share.public':'公开',
    'toast.skillPulled':'技能已拉取到本地',
    'toast.skillPullFail':'技能拉取失败',
    'task.edit':'编辑',
    'task.delete':'删除',
    'task.save':'保存',
    'task.cancel':'取消',
    'task.delete.confirm':'确定要删除此任务吗？此操作不可撤销。',
    'task.delete.error':'删除任务失败：',
    'task.deleteSelected':'删除选中',
    'task.delete.selected.confirm':'确定删除选中的 {count} 个任务吗？此操作不可撤销。',
    'task.delete.success':'已删除 {count} 个任务。',
    'task.delete.partial':'已删除 {ok} 个任务，失败 {fail} 个。',
    'task.save.error':'保存任务失败：',
    'task.retrySkill':'重新生成技能',
    'task.retrySkill.short':'重试技能',
    'task.retrySkill.confirm':'确定要为此任务重新触发技能生成吗？',
    'task.retrySkill.error':'重新生成技能失败：',
    'skill.edit':'编辑',
    'skill.delete':'删除',
    'skill.save':'保存',
    'skill.cancel':'取消',
    'skill.delete.confirm':'确定要删除此技能吗？关联的文件也会被删除，此操作不可撤销。',
    'skill.delete.selected.confirm':'确定删除选中的 {count} 个技能吗？此操作不可撤销。',
    'skill.delete.error':'删除技能失败：',
    'skill.delete.partial':'已删除 {ok} 个技能，失败 {fail} 个。',
    'skill.delete.success':'已删除 {count} 个技能。',
    'memory.deleteSelected':'删除选中',
    'memory.delete.selected.confirm':'确定删除选中的 {count} 条记忆吗？此操作不可撤销。',
    'memory.delete.success':'已删除 {count} 条记忆。',
    'memory.delete.partial':'已删除 {ok} 条记忆，失败 {fail} 条。',
    'skill.save.error':'保存技能失败：',
    'update.available':'发现新版本',
    'update.run':'执行命令',
    'update.btn':'更新',
    'update.installing':'安装中...',
    'update.success':'更新完成',
    'update.failed':'更新失败',
    'update.restarting':'正在重启服务，页面将自动刷新...',
    'update.dismiss':'关闭',
    'sharing.disable.confirm.hub':'你即将关闭团队服务。\\n\\n关闭后将会：\\n\\u2022 所有已连接的团队成员将断开连接\\n\\u2022 他们将无法继续同步记忆、任务和技能\\n\\u2022 已共享的数据会保留，重新开启后仍可使用\\n\\n确定要关闭吗？',
    'sharing.disable.confirm.client':'你即将断开与团队的连接。\\n\\n断开后将会：\\n\\u2022 你将无法再接收团队共享的记忆、任务和技能\\n\\u2022 你的本地数据不受影响，会完整保留\\n\\u2022 之后可以随时重新开启共享来恢复连接\\n\\n确定要断开吗？',
    'sharing.disable.restartAlert':'共享已关闭，服务将自动重启以应用更改。',
    'sharing.switch.hubToClient':'你即将从服务端模式切换为客户端模式。\\n\\n切换后将会：\\n\\u2022 Hub 服务将在服务重启后关闭\\n\\u2022 所有已连接的团队成员将断开连接\\n\\u2022 Hub 上的共享数据会保留，以后可恢复使用\\n\\u2022 你将作为客户端加入指定的远程团队\\n\\n确定要切换吗？',
    'sharing.switch.clientToHub':'你即将从客户端模式切换为服务端模式。\\n\\n切换后将会：\\n\\u2022 你将断开与当前团队的连接\\n\\u2022 服务重启后将启动新的 Hub 服务\\n\\u2022 你的本地数据不受影响\\n\\n确定要切换吗？',
    'sharing.switch.hubAddress':'你即将离开当前团队并加入新的团队。\\n\\n操作后将会：\\n\\u2022 你将断开与当前团队服务器的连接\\n\\u2022 当前团队管理员会收到你离开的通知\\n\\u2022 你将作为新成员加入新的团队服务器\\n\\u2022 你的本地数据不受影响\\n\\n确定要切换吗？',
    'admin.notEnabled.title':'团队共享尚未开启',
    'admin.notEnabled.desc':'管理面板用于管理团队成员、共享的记忆、任务和技能。使用此功能前，需要先开启团队共享。',
    'admin.notEnabled.setupHub':'配置为团队服务端',
    'admin.notEnabled.joinTeam':'加入已有团队',
    'admin.notEnabled.hint':'如果之前配置过共享，你的数据仍然保留。重新开启共享即可恢复访问所有共享内容。',
    'sharing.disconnected.hint':'无法连接到团队服务器，服务器可能已下线或网络不可用。',
    'sharing.retryConnection':'重试连接',
    'sharing.retryConnection.loading':'连接中...',
    'sharing.retryConnection.success':'连接成功！',
    'sharing.retryConnection.fail':'仍然无法连接，请检查团队服务器是否在线。',
    'guide.title':'开始团队协作',
    'guide.subtitle':'MemOS 支持团队记忆共享。选择以下方式之一开启协作，或继续使用纯本地模式。',
    'guide.join.title':'加入远程团队',
    'guide.join.desc':'你的团队已有服务器在运行？加入即可与团队成员共享记忆、任务和技能。',
    'guide.join.s1':'向团队管理员索取服务器地址和团队令牌',
    'guide.join.s2':'前往「设置 → 团队共享」，开启共享，选择「客户端」模式',
    'guide.join.s3':'填写服务器地址和团队令牌，点击「测试连接」',
    'guide.join.s4':'点击「保存并应用」，服务将自动重启（页面会自动刷新）',
    'guide.join.btn':'\u2192 配置客户端模式',
    'guide.hub.title':'自建团队服务',
    'guide.hub.desc':'将本机作为团队服务端，让其他成员连接过来共享记忆。',
    'guide.hub.s1':'前往「设置 → 团队共享」，开启共享，选择「服务端」模式',
    'guide.hub.s2':'设置团队名称，点击「保存并应用」，服务将自动重启',
    'guide.hub.s3':'将服务器地址和团队令牌分享给团队成员',
    'guide.hub.s4':'在管理面板中审批加入请求',
    'guide.hub.btn':'\u2192 配置服务端模式'
  }
};
const LANG_KEY='memos-viewer-lang';
let curLang=localStorage.getItem(LANG_KEY)||(navigator.language.startsWith('zh')?'zh':'en');
function t(key){return (I18N[curLang]||I18N.en)[key]||key;}
function setLang(lang){curLang=lang;localStorage.setItem(LANG_KEY,lang);applyI18n();}
function toggleLang(){setLang(curLang==='zh'?'en':'zh');}

function applyI18n(){
  document.querySelectorAll('[data-i18n]').forEach(el=>{
    const key=el.getAttribute('data-i18n');
    if(key) el.textContent=t(key);
  });
  document.querySelectorAll('[data-i18n-ph]').forEach(el=>{
    const key=el.getAttribute('data-i18n-ph');
    if(key) el.placeholder=t(key);
  });
  const step2=document.getElementById('resetStep2Desc');
  if(step2) step2.innerHTML=t('reset.step2.desc.pre')+'<span style="font-family:monospace;font-size:12px;color:var(--pri)">password reset token: <strong>a1b2c3d4e5f6...</strong></span>'+t('reset.step2.desc.post');
  document.title=t('title')+' - OpenClaw';
  if(typeof loadStats==='function' && document.getElementById('app').style.display==='flex'){loadStats();}
  if(document.querySelector('.analytics-view.show') && typeof loadMetrics==='function'){loadMetrics();}
}

/* ─── Auth flow ─── */
async function checkAuth(){
  const r=await fetch('/api/auth/status');
  const d=await r.json();
  if(d.needsSetup){
    document.getElementById('setupScreen').style.display='flex';
    document.getElementById('setupPw').addEventListener('keydown',e=>{if(e.key==='Enter')document.getElementById('setupPw2').focus()});
    document.getElementById('setupPw2').addEventListener('keydown',e=>{if(e.key==='Enter')doSetup()});
  } else if(!d.loggedIn){
    document.getElementById('loginScreen').style.display='flex';
    document.getElementById('loginPw').addEventListener('keydown',e=>{if(e.key==='Enter')doLogin()});
  } else {
    enterApp();
  }
}

async function doSetup(){
  const pw=document.getElementById('setupPw').value;
  const pw2=document.getElementById('setupPw2').value;
  const err=document.getElementById('setupErr');
  if(pw.length<4){err.textContent=t('setup.err.short');return}
  if(pw!==pw2){err.textContent=t('setup.err.mismatch');return}
  const r=await fetch('/api/auth/setup',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:pw})});
  const d=await r.json();
  if(d.ok){document.getElementById('setupScreen').style.display='none';enterApp();}
  else{err.textContent=d.error||t('setup.err.fail')}
}

async function doLogin(){
  const pw=document.getElementById('loginPw').value;
  const err=document.getElementById('loginErr');
  const r=await fetch('/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:pw})});
  const d=await r.json();
  if(d.ok){document.getElementById('loginScreen').style.display='none';enterApp();}
  else{err.textContent=t('login.err');document.getElementById('loginPw').value='';document.getElementById('loginPw').focus();}
}

async function doLogout(){
  await fetch('/api/auth/logout',{method:'POST'});
  location.reload();
}

function showResetForm(){
  document.getElementById('loginForm').style.display='none';
  document.getElementById('resetForm').style.display='block';
  document.getElementById('resetToken').focus();
}

function showLoginForm(){
  document.getElementById('resetForm').style.display='none';
  document.getElementById('loginForm').style.display='block';
  document.getElementById('loginPw').focus();
}

function copyCmd(el){
  const code=el.querySelector('code').textContent;
  navigator.clipboard.writeText(code).then(()=>{
    el.classList.add('copied');
    el.querySelector('.copy-hint').textContent=t('copy.done');
    setTimeout(()=>{el.classList.remove('copied');el.querySelector('.copy-hint').textContent=t('copy.hint')},2000);
  });
}

async function doReset(){
  const token=document.getElementById('resetToken').value.trim();
  const pw=document.getElementById('resetNewPw').value;
  const pw2=document.getElementById('resetNewPw2').value;
  const err=document.getElementById('resetErr');
  if(!token){err.textContent=t('reset.err.token');return}
  if(pw.length<4){err.textContent=t('reset.err.short');return}
  if(pw!==pw2){err.textContent=t('reset.err.mismatch');return}
  const r=await fetch('/api/auth/reset',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token,newPassword:pw})});
  const d=await r.json();
  if(d.ok){document.getElementById('loginScreen').style.display='none';enterApp();}
  else{err.textContent=d.error||t('reset.err.fail')}
}

var _sharingRole='client';
var _loadedClientHubAddress='';
function _genToken(len){
  var a=new Uint8Array(len||18);crypto.getRandomValues(a);
  return btoa(String.fromCharCode.apply(null,a)).replace(/\\+/g,'-').replace(/\\//g,'_').replace(/=+$/,'');
}
async function onSharingToggle(){
  var chk=document.getElementById('cfgSharingEnabled');
  var on=chk.checked;
  if(!on && sharingStatusCache && sharingStatusCache.enabled){
    var prevRole=sharingStatusCache.role;
    var confirmMsg=prevRole==='hub'?t('sharing.disable.confirm.hub'):t('sharing.disable.confirm.client');
    if(!(await confirmModal(confirmMsg,{danger:true}))){
      chk.checked=true;
      return;
    }
    var cfg={sharing:{enabled:false,role:prevRole}};
    chk.disabled=true;
    var result=await doSaveConfig(cfg, null, 'hubSaved');
    chk.disabled=false;
    if(!result){chk.checked=true;return;}
    return;
  }
  document.getElementById('sharingConfigPanel').style.display=on?'block':'none';
  var pw=document.getElementById('sharingPanelsWrap');
  if(pw) pw.style.display=on?'':'none';
  var tg=document.getElementById('teamSetupGuide');
  if(tg) tg.style.display=on?'none':'';
  if(on) selectSharingRole(_sharingRole);
}
function selectSharingRole(role){
  _sharingRole=role;
  document.getElementById('btnRoleHub').className='btn btn-sm'+(role==='hub'?' btn-primary':'');
  document.getElementById('btnRoleClient').className='btn btn-sm'+(role==='client'?' btn-primary':'');
  document.getElementById('hubModeConfig').style.display=role==='hub'?'block':'none';
  document.getElementById('clientModeConfig').style.display=role==='client'?'block':'none';
  var sp=document.getElementById('sharingStatusPanel');
  var tp=document.getElementById('sharingTeamPanel');
  var ap=document.getElementById('sharingAdminPanel');
  if(role==='client'){
    if(sp) { sp.style.display='none'; sp.innerHTML=''; }
    if(tp) tp.style.display='none';
    if(ap) ap.style.display='none';
  }else{
    if(sp) { sp.style.display='none'; sp.innerHTML=''; }
    if(tp) tp.style.display='';
    if(ap) ap.style.display='';
  }
  _lastSettingsFingerprint='';
  setTimeout(function(){ loadSharingStatus(true); },200);
  if(role==='hub'){
    var tk=document.getElementById('cfgHubTeamToken');
    if(!tk.value.trim()) tk.value=_genToken(18);
    var tn=document.getElementById('cfgHubTeamName');
    if(!tn.value.trim()) tn.value='My Team';
  }
  var card=document.getElementById('settingsSharingConfig');
  var saveBtn=card&&card.querySelector('.settings-actions .btn-primary');
  if(saveBtn&&typeof _hubSaveBtnLabel==='function') saveBtn.textContent=_hubSaveBtnLabel();
}
var _cachedLocalIP='';
function updateHubShareInfo(){
  var panel=document.getElementById('hubShareInfo');
  var content=document.getElementById('hubShareInfoContent');
  if(!panel||!content) return;
  var tokenEl=document.getElementById('cfgHubTeamToken');
  var token=tokenEl?tokenEl.value.trim():'';
  var port=document.getElementById('cfgHubPort').value.trim()||'18800';
  if(!token||_sharingRole!=='hub'){panel.style.display='none';return;}
  panel.style.display='block';
  var cpStyle='cursor:pointer;background:rgba(99,102,241,.06);border:1px solid rgba(99,102,241,.15);border-radius:6px;padding:4px 10px;font-family:var(--mono);font-size:12px;color:var(--text);transition:all .15s;user-select:all';
  var renderShare=function(ip){
    var addr=ip?(ip+':'+esc(port)):('&lt;'+t('settings.hub.shareInfo.yourIP')+'&gt;:'+esc(port));
    var tip=t('settings.hub.shareInfo.clickCopy');
    content.innerHTML=
      '<span style="font-size:11px;color:var(--text-muted);font-weight:500">'+t('settings.hub.hubAddress')+'</span>'+
      '<span style="'+cpStyle+'" onclick="navigator.clipboard.writeText(this.textContent);toast(t(&#39;copy.done&#39;),&#39;success&#39;)" title="'+tip+'">'+addr+'</span>'+
      '<span style="font-size:11px;color:var(--text-muted);font-weight:500">Team Token</span>'+
      '<span style="'+cpStyle+'" onclick="navigator.clipboard.writeText(this.textContent);toast(t(&#39;copy.done&#39;),&#39;success&#39;)" title="'+tip+'">'+esc(token)+'</span>';
  };
  if(_cachedLocalIP){renderShare(_cachedLocalIP);return;}
  renderShare('');
  fetch('/api/local-ips').then(function(r){return r.json()}).then(function(d){
    if(d.ips&&d.ips.length>0){_cachedLocalIP=d.ips[0];renderShare(_cachedLocalIP);}
  }).catch(function(){});
}
async function testHubConnection(){
  var btn=document.getElementById('btnTestHubConn');
  var result=document.getElementById('hubConnTestResult');
  var addr=document.getElementById('cfgClientHubAddress').value.trim();
  if(!addr){result.innerHTML='<span style="color:var(--rose)">\u274C '+t('settings.hub.test.noAddr')+'</span>';return;}
  var tokenEl=document.getElementById('cfgClientTeamToken');
  var teamToken=tokenEl?tokenEl.value.trim():'';
  if(!teamToken){result.innerHTML='<span style="color:var(--rose)">\u274C '+t('settings.hub.teamToken.required')+'</span>';return;}
  var nicknameEl=document.getElementById('cfgClientNickname');
  var nickname=nicknameEl?nicknameEl.value.trim():'';
  btn.disabled=true;result.innerHTML=t('settings.hub.test.testing');
  try{
    var url=addr.match(/^https?:\\/\\//)?addr:'http://'+addr;
    url=url.replace(/\\/+$/,'');
    var r=await fetch('/api/sharing/test-hub',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({hubUrl:url,teamToken:teamToken,nickname:nickname})});
    var d=await r.json();
    if(d.ok){
      result.innerHTML='<span style="color:var(--green)">\u2705 '+t('settings.hub.test.ok')+(d.teamName?' — '+esc(d.teamName):'')+'</span>';
    }else{
      var errMsg;
      if(d.error==='cannot_join_self') errMsg=t('sharing.cannotJoinSelf');
      else if(d.error==='username_taken') errMsg=t('sharing.joinError.usernameTaken');
      else if(d.error==='invalid_team_token') errMsg=t('sharing.joinError.invalidToken');
      else errMsg=d.error||t('settings.hub.test.fail');
      result.innerHTML='<span style="color:var(--rose)">\u274C '+errMsg+'</span>';
    }
  }catch(e){
    result.innerHTML='<span style="color:var(--rose)">\u274C '+esc(String(e))+'</span>';
  }finally{btn.disabled=false;}
}

function enterApp(){
  document.getElementById('app').style.display='flex';
  loadAll();
}

function switchSettingsTab(tab,btn){
  document.querySelectorAll('.settings-tab-btn').forEach(function(b){b.classList.remove('active')});
  if(btn){btn.classList.add('active')}
  else{var b=document.querySelector('.settings-tab-btn[data-tab="'+tab+'"]');if(b)b.classList.add('active')}
  document.querySelectorAll('.settings-card[data-stab]').forEach(function(c){
    if(c.dataset.stab===tab){c.classList.add('stab-active')}else{c.classList.remove('stab-active')}
  });
}

var _activeView='memories';
function switchView(view){
  _activeView=view;
  document.querySelectorAll('.nav-tabs .tab').forEach(t=>t.classList.toggle('active',t.dataset.view===view));
  var viewMap={memories:'feedWrap',tasks:'tasksView',skills:'skillsView',analytics:'analyticsView',logs:'logsView',settings:'settingsView',import:'migrateView',admin:'adminView'};
  for(var k in viewMap){
    var el=document.getElementById(viewMap[k]);
    if(el) el.classList.toggle('show',k===view);
  }
  var sessionSection=document.getElementById('sidebarSessionSection');
  if(sessionSection){
    if(view==='memories'||view==='tasks'||view==='skills'){sessionSection.style.visibility='';sessionSection.style.pointerEvents='';}
    else{sessionSection.style.visibility='hidden';sessionSection.style.pointerEvents='none';}
  }
  if(view==='memories'||view==='tasks'||view==='skills'){
    loadStats();
  }
  if(view==='tasks') loadTasks();
  else if(view==='skills') loadSkills();
  else if(view==='analytics') loadMetrics();
  else if(view==='logs') loadLogs();
  else if(view==='settings'){loadConfig().then(function(){
    var sharingOn=document.getElementById('cfgSharingEnabled');
    var sharingNotEnabled=!sharingOn||!sharingOn.checked;
    if(sharingNotEnabled){
      switchSettingsTab('hub',document.querySelector('.settings-tab-btn[data-tab="hub"]'));
    }
  });loadModelHealth();}
  else if(view==='import'){if(!window._migrateRunning) migrateScan(false);}
  else if(view==='admin'){_lastAdminFingerprint='';loadAdminData();}
}

function onMemoryScopeChange(){
  memorySearchScope=document.getElementById('memorySearchScope')?.value||'allLocal';
  try{localStorage.setItem('memos_memorySearchScope',memorySearchScope);}catch(e){}
  currentPage=1;
  activeSession=null;activeRole='';
  _lastMemoriesFingerprint='';
  if(memorySearchScope==='hub') selectedMemoryIds.clear();
  var isHub=memorySearchScope==='hub';
  var ownerSel=document.getElementById('filterOwner');
  var filterBar=document.getElementById('filterBar');
  var dateFilter=document.querySelector('.date-filter');
  if(ownerSel){ownerSel.style.display=isHub?'none':'';if(isHub)ownerSel.value='';}
  if(filterBar) filterBar.style.display=isHub?'none':'';
  if(dateFilter) dateFilter.style.display=isHub?'none':'';
  updateMemorySelectionToolbar();
  if(document.getElementById('searchInput').value.trim()) doSearch(document.getElementById('searchInput').value);
  else if(isHub) { document.getElementById('sharingSearchMeta').textContent=''; loadHubMemories(); }
  else {
    document.getElementById('sharingSearchMeta').textContent='';
    var ownerArg=undefined;
    loadStats(ownerArg); loadMemories();
  }
}

function normalizePageSize(value,fallback){
  const v=Number(value);
  return v===10||v===20||v===40?v:fallback;
}

function applyPageSizeFromSelect(selectId,storageKey,fallback,onApply){
  const el=document.getElementById(selectId);
  const next=normalizePageSize(el?.value,fallback);
  onApply(next);
  try{localStorage.setItem(storageKey,String(next));}catch(e){}
  return next;
}

function restorePageSizeSetting(storageKey,selectId,fallback,onApply){
  let next=fallback;
  try{
    const raw=localStorage.getItem(storageKey);
    next=normalizePageSize(raw||String(fallback),fallback);
  }catch(e){}
  onApply(next);
  const el=document.getElementById(selectId);
  if(el) el.value=String(next);
  return next;
}

function onMemoryPageSizeChange(){
  applyPageSizeFromSelect('memoryPageSize','memos_memoryPageSize',20,function(next){PAGE_SIZE=next;});
  currentPage=1;
  if(memorySearchScope==='hub') loadHubMemories();
  else loadMemories();
}

function onSkillScopeChange(){
  skillSearchScope=document.getElementById('skillSearchScope')?.value||'allLocal';
  skillsPage=0;
  loadSkills();
}

function onSkillsPageSizeChange(){
  applyPageSizeFromSelect('skillsPageSize','memos_skillsPageSize',20,function(next){skillsPageSize=next;});
  skillsPage=0;
  loadSkills();
}

function onTasksPageSizeChange(){
  applyPageSizeFromSelect('tasksPageSize','memos_tasksPageSize',20,function(next){tasksPageSize=next;});
  tasksPage=0;
  loadTasks();
}

function onTaskScopeChange(){
  taskSearchScope=document.getElementById('taskSearchScope')?.value||'allLocal';
  if(taskSearchScope==='hub') selectedTaskIds.clear();
  tasksPage=0;
  updateTaskSelectionToolbar();
  loadTasks();
}

var _clientPendingPollTimer=null;
var _lastSharingConnStatus='';
function _updateScopeSelectorsVisibility(hubAvailable){
  var ids=['memorySearchScope','taskSearchScope','skillSearchScope'];
  for(var i=0;i<ids.length;i++){
    var el=document.getElementById(ids[i]);
    if(el) el.style.display=hubAvailable?'':'none';
  }
  if(!hubAvailable){
    if(memorySearchScope==='hub'){memorySearchScope='allLocal';try{localStorage.setItem('memos_memorySearchScope','allLocal');}catch(e){}}
    if(taskSearchScope==='hub'){taskSearchScope='allLocal';try{localStorage.setItem('memos_taskSearchScope','allLocal');}catch(e){}}
    if(skillSearchScope==='hub'){skillSearchScope='allLocal';try{localStorage.setItem('memos_skillSearchScope','allLocal');}catch(e){}}
  }
}
async function loadSharingStatus(forcePending){
  try{
    const r=await fetch('/api/sharing/status');
    const d=await r.json();
    sharingStatusCache=d;
    renderSharingSidebar(d);
    renderSharingSettings(d);
    updateTeamGuide(d);
    if(forcePending && d && d.admin && d.admin.canManageUsers) loadSharingPendingUsers();
    if(!d||!d.enabled){
      if(_clientPendingPollTimer){clearInterval(_clientPendingPollTimer);_clientPendingPollTimer=null;}
      _lastSharingConnStatus='';
      _updateScopeSelectorsVisibility(false);
      return;
    }
    var conn=d.connection||{};
    var curStatus=conn.rejected?'rejected':conn.pendingApproval?'pending':conn.connected?'connected':'none';
    var hubActive=d.role==='hub'||curStatus==='connected';
    _updateScopeSelectorsVisibility(hubActive);
    if(_lastSharingConnStatus==='pending'&&curStatus==='rejected'&&d.role==='client'){
      toast(t('sharing.rejected.toast'),'error');
    }
    if(_lastSharingConnStatus==='pending'&&curStatus==='connected'&&d.role==='client'){
      toast(t('sharing.approved.toast'),'success');
      loadMemories();loadTasks();loadSkills();
      if(_notifSSE){_notifSSE.close();_notifSSE=null;_notifSSEConnected=false;}
      connectNotifSSE();
      loadNotifications();
    }
    if(_lastSharingConnStatus==='connected'&&curStatus==='none'&&d.role==='client'){
      toast(t('sharing.hubOffline.toast'),'error');
    }
    if(_lastSharingConnStatus==='none'&&curStatus==='connected'&&d.role==='client'){
      toast(t('sharing.hubReconnected.toast'),'success');
      loadMemories();loadTasks();loadSkills();
      if(_notifSSE){_notifSSE.close();_notifSSE=null;_notifSSEConnected=false;}
      connectNotifSSE();
      loadNotifications();
    }
    _lastSharingConnStatus=curStatus;
    if(curStatus==='pending'&&!_clientPendingPollTimer){
      _clientPendingPollTimer=setInterval(function(){loadSharingStatus(false);},5000);
    }
    if(curStatus!=='pending'&&_clientPendingPollTimer){
      clearInterval(_clientPendingPollTimer);
      _clientPendingPollTimer=null;
    }
  }catch(e){
    renderSharingSidebar(null);
    renderSharingSettings(null);
    updateTeamGuide(null);
    _updateScopeSelectorsVisibility(false);
  }
}

var _lastSidebarFingerprint='';
function renderSharingSidebar(data){
  var section=document.getElementById('sidebarSharingSection');
  var statusEl=document.getElementById('sharingSidebarStatus');
  var hintEl=document.getElementById('sharingSidebarHint');
  var badgeEl=document.getElementById('sharingSidebarConnBadge');
  if(!statusEl||!hintEl) return;
  var conn=data&&data.connection||{};
  var hs=data&&data.hubStats||{};
  var fp=JSON.stringify({e:!!data&&!!data.enabled,r:data&&data.role,pa:!!conn.pendingApproval,rj:!!conn.rejected,c:!!conn.connected,u:conn.user&&conn.user.username,tn:conn.teamName,cc:!!data&&!!data.clientConfigured,hu:data&&data.hubUrl,tm:hs.totalMembers,om:hs.onlineMembers,pm:hs.pendingMembers});
  if(fp===_lastSidebarFingerprint) return;
  _lastSidebarFingerprint=fp;
  if(!data||!data.enabled){
    if(section) section.style.display='none';
    window._isHubAdmin=false;
    return;
  }
  if(section) section.style.display='block';
  var conn=data.connection||{};
  function setBadge(color,text,glow){
    if(!badgeEl)return;
    badgeEl.innerHTML='<span style="display:inline-flex;align-items:center;gap:4px;font-size:10px;font-weight:600;padding:2px 8px;border-radius:9999px;background:'+color+'15;color:'+color+'"><span style="display:inline-block;width:6px;height:6px;border-radius:50%;background:'+color+(glow?';box-shadow:0 0 4px '+color:'')+'"></span>'+esc(text)+'</span>';
  }
  if(data.role==='hub'){
    setBadge('#34d399',t('sharing.sidebar.hubRunning'),true);
    var hs=data.hubStats||{};
    var html='<div class="info-grid">';
    if(conn.teamName) html+='<span class="label">'+t('sharing.sidebar.teamName')+'</span><span class="value" style="font-weight:600">'+esc(conn.teamName)+'</span>';
    html+='<span class="label">'+t('sharing.sidebar.members')+'</span><span class="value">'+(hs.totalMembers||0)+' <span style="opacity:.5;font-size:10px">/ '+t('sharing.sidebar.online')+' '+(hs.onlineMembers||0)+'</span></span>';
    if(hs.pendingMembers>0){
      html+='<span class="label">'+t('sharing.sidebar.pending')+'</span><span class="value" style="color:var(--yellow,#fbbf24);font-weight:600">'+hs.pendingMembers+'</span>';
    }
    html+='</div>';
    statusEl.innerHTML=html;
    hintEl.textContent='';
  }else if(conn.pendingApproval&&conn.user){
    setBadge('#fbbf24',t('sharing.sidebar.pending'),false);
    var html='<div class="info-grid">';
    html+='<span class="label">'+t('sharing.sidebar.identity')+'</span><span class="value">'+esc(conn.user.username)+'</span>';
    if(conn.teamName) html+='<span class="label">'+t('sharing.team')+'</span><span class="value">'+esc(conn.teamName)+'</span>';
    html+='</div>';
    statusEl.innerHTML=html;
    hintEl.textContent=t('sharing.pendingApproval.hint');
  }else if(conn.rejected&&conn.user){
    setBadge('#ef4444',t('sharing.sidebar.rejected'),false);
    var html='<div class="info-grid">';
    html+='<span class="label">'+t('sharing.sidebar.identity')+'</span><span class="value">'+esc(conn.user.username||'-')+'</span>';
    if(conn.teamName) html+='<span class="label">'+t('sharing.team')+'</span><span class="value">'+esc(conn.teamName)+'</span>';
    html+='</div>';
    html+='<div style="margin-top:8px"><button class="btn btn-sm btn-primary" onclick="retryHubJoin()" style="font-size:11px">'+t('sharing.retryJoin')+'</button></div>';
    statusEl.innerHTML=html;
    hintEl.textContent=t('sharing.rejected.hint');
  }else if(conn.removed&&conn.user){
    setBadge('#ef4444',t('sharing.sidebar.disconnected'),false);
    var html='<div class="info-grid">';
    html+='<span class="label">'+t('sharing.sidebar.identity')+'</span><span class="value">'+esc(conn.user.username||'-')+'</span>';
    if(conn.teamName) html+='<span class="label">'+t('sharing.team')+'</span><span class="value">'+esc(conn.teamName)+'</span>';
    html+='</div>';
    html+='<div style="margin-top:8px"><button class="btn btn-sm btn-primary" onclick="retryHubJoin()" style="font-size:11px">'+t('sharing.retryJoin')+'</button></div>';
    statusEl.innerHTML=html;
    hintEl.textContent=t('sharing.removed.hint');
  }else if(conn.connected&&conn.user){
    var isAdmin=conn.user.role==='admin';
    setBadge('#34d399',t('sharing.sidebar.connected'),true);
    var html='<div class="info-grid">';
    html+='<span class="label">'+t('sharing.sidebar.identity')+'</span><span class="value">'+esc(conn.user.username)+(isAdmin?' <span class="role-badge admin">'+t('sharing.sidebar.admin')+'</span>':'')+'</span>';
    html+='<span class="label">'+t('sharing.team')+'</span><span class="value">'+esc(conn.teamName||'-')+'</span>';
    html+='</div>';
    statusEl.innerHTML=html;
    hintEl.innerHTML='';
  }else if(data.clientConfigured){
    setBadge('#ef4444',t('sharing.sidebar.disconnected'),false);
    statusEl.innerHTML='<div style="font-size:11px;color:var(--text-muted)">'+t('sharing.sidebar.targetHub')+' '+esc(data.hubUrl||'')+'</div>';
    hintEl.innerHTML=esc(t('sharing.clientDisconnected.hint'))+'<br><a href="#" onclick="retryConnection();return false;" style="color:var(--pri);font-size:11px;text-decoration:none">'+t('sharing.retryConnection')+'</a>';
  }else{
    setBadge('#888',t('sharing.sidebar.notConfigured'),false);
    statusEl.innerHTML='';
    hintEl.textContent=t('sharing.clientNotConfigured.hint');
  }
}

var _lastSettingsFingerprint='';
function renderSharingSettings(data){
  var statusEl=document.getElementById('sharingStatusPanel');
  var teamEl=document.getElementById('sharingTeamPanel');
  var adminEl=document.getElementById('sharingAdminPanel');
  var panelsWrap=document.getElementById('sharingPanelsWrap');
  if(!statusEl||!teamEl||!adminEl) return;
  var conn2=data&&data.connection||{};
  var fp2=JSON.stringify({e:!!data&&!!data.enabled,r:data&&data.role,pa:!!conn2.pendingApproval,rj:!!conn2.rejected,c:!!conn2.connected,u:conn2.user&&conn2.user.username,ur:conn2.user&&conn2.user.role,tn:conn2.teamName,cc:!!data&&!!data.clientConfigured,cm:data&&data.admin&&data.admin.canManageUsers});
  if(fp2===_lastSettingsFingerprint) return;
  _lastSettingsFingerprint=fp2;
  if(!data||!data.enabled){
    statusEl.innerHTML='';teamEl.innerHTML='';adminEl.innerHTML='';
    if(panelsWrap) panelsWrap.style.display='none';
    var adminNavTab0=document.querySelector('.tab[data-view="admin"]');
    if(adminNavTab0) adminNavTab0.style.display='none';
    if(_activeView==='admin') switchView('memories');
    return;
  }
  if(panelsWrap) panelsWrap.style.display='';
  var conn=data.connection||{};
  var user=conn.user||{};
  var actualRole=data.role||_sharingRole||'client';
  var prevIsAdmin=!!window._isHubAdmin;
  var isAdmin=(data.admin&&data.admin.canManageUsers)||(conn.connected&&user.role==='admin')||(actualRole==='hub');
  window._isHubAdmin=isAdmin;
  if(isAdmin) startAdminPoll();
  var adminNavTab=document.querySelector('.tab[data-view="admin"]');
  if(adminNavTab){
    var showTab=(actualRole==='hub')||(conn.connected);
    adminNavTab.style.display=showTab?'':'none';
    if(!showTab&&_activeView==='admin') switchView('memories');
  }
  if(prevIsAdmin&&!isAdmin&&_activeView==='admin'){
    _lastAdminFingerprint='';
    loadAdminData();
  }
  var hubAdminBtn=document.getElementById('hubAdminEntryBtn');

  if(actualRole==='hub'){
    teamEl.innerHTML='';adminEl.innerHTML='';statusEl.innerHTML='';statusEl.style.display='none';
    if(hubAdminBtn) hubAdminBtn.style.display=isAdmin?'':'none';
    var hubUser=conn.user||{};
    var hubName=hubUser.username||'admin';
    var adminNameInput=document.getElementById('cfgHubAdminName');
    if(adminNameInput) adminNameInput.value=hubName;
    return;
  }

  if(actualRole==='client'){
    statusEl.style.display='none';teamEl.style.display='none';adminEl.style.display='none';
    if(hubAdminBtn) hubAdminBtn.style.display='none';

    var connBadge;
    if(conn.pendingApproval){
      connBadge='<span class="hic-badge pending"><span class="hic-dot amber"></span>'+t('sharing.sidebar.pending')+'</span>';
    }else if(conn.rejected){
      connBadge='<span class="hic-badge disconnected"><span class="hic-dot red"></span>'+t('sharing.sidebar.rejected')+'</span>';
    }else if(conn.removed){
      connBadge='<span class="hic-badge disconnected"><span class="hic-dot red"></span>'+t('sharing.sidebar.disconnected')+'</span>';
    }else if(conn.connected){
      connBadge='<span class="hic-badge connected"><span class="hic-dot green"></span>'+t('sharing.sidebar.connected')+'</span>';
    }else{
      connBadge='<span class="hic-badge disconnected"><span class="hic-dot red"></span>'+t('sharing.sidebar.disconnected')+'</span>';
    }
    statusEl.style.display='';
    var sh='<div class="hub-info-card hic-status"><div class="hic-title"><span class="hic-icon">\u{1F517}</span>'+t('settings.hub.connection')+' '+connBadge+'</div><div class="hic-grid">';
    if(conn.pendingApproval&&user.username){
      sh+='<span class="hic-label">'+t('sharing.user')+'</span><span class="hic-value">'+esc(user.username)+'</span>';
      sh+='</div><div class="hic-empty" style="color:#f59e0b">'+t('sharing.pendingApproval.hint')+'</div></div>';
    }else if(conn.rejected){
      if(user.username) sh+='<span class="hic-label">'+t('sharing.user')+'</span><span class="hic-value">'+esc(user.username)+'</span>';
      sh+='</div><div class="hic-empty" style="color:#ef4444">'+t('sharing.rejected.hint')+'</div>'+
        '<div style="margin-top:10px;padding:0 16px 14px"><button class="btn btn-sm btn-primary" onclick="retryHubJoin()">'+t('sharing.retryJoin')+'</button>'+
        '<span style="font-size:11px;color:var(--text-muted);margin-left:8px">'+t('sharing.retryJoin.hint')+'</span></div></div>';
    }else if(conn.removed){
      if(user.username) sh+='<span class="hic-label">'+t('sharing.user')+'</span><span class="hic-value">'+esc(user.username)+'</span>';
      sh+='</div><div class="hic-empty" style="color:#ef4444">'+t('sharing.removed.hint')+'</div>'+
        '<div style="margin-top:10px;padding:0 16px 14px"><button class="btn btn-sm btn-primary" onclick="retryHubJoin()">'+t('sharing.retryJoin')+'</button>'+
        '<span style="font-size:11px;color:var(--text-muted);margin-left:8px">'+t('sharing.retryJoin.hint')+'</span></div></div>';
    }else if(conn.connected&&user.username){
      sh+='<span class="hic-label">'+t('sharing.user')+'</span><span class="hic-value" style="display:flex;align-items:center;gap:6px">'+
        '<input type="text" id="hubUsernameInput" value="'+esc(user.username)+'" style="border:1px solid var(--border);border-radius:6px;padding:3px 8px;font-size:12px;background:var(--bg);color:var(--text);width:120px;font-family:inherit" />'+
        '<button class="btn btn-sm" onclick="updateHubUsername()" style="padding:2px 10px;font-size:11px">'+t('sharing.saveUsername')+'</button>'+
      '</span>';
      sh+='<span class="hic-label">'+t('sharing.team')+'</span><span class="hic-value">'+esc(conn.teamName||'-')+'</span>';
      sh+='</div>'+
        '<div style="border-top:1px solid var(--border);margin-top:10px;padding:10px 16px 6px;display:flex;align-items:center;justify-content:flex-end">'+
        '<button class="btn btn-sm" onclick="leaveTeam()" style="color:#ef4444;border-color:rgba(239,68,68,.3);font-size:11px;padding:4px 12px">'+t('sharing.leaveTeam')+'</button>'+
        '</div></div>';
    }else{
      sh+='</div><div class="hic-empty" style="color:var(--text-muted)">'+t('sharing.disconnected.hint')+'</div>'+
        '<div style="margin-top:10px;padding:0 16px 14px"><button class="btn btn-sm btn-primary" id="btnRetryConn" onclick="retryConnection()">'+t('sharing.retryConnection')+'</button>'+
        '<span id="retryConnResult" style="margin-left:10px;font-size:11px"></span></div></div>';
    }
    statusEl.innerHTML=sh;
    teamEl.innerHTML='';adminEl.innerHTML='';
    return;
  }

  statusEl.innerHTML='';teamEl.innerHTML='';adminEl.innerHTML='';
}

async function retryConnection(){
  var btn=document.getElementById('btnRetryConn');
  var result=document.getElementById('retryConnResult');
  if(btn){btn.disabled=true;btn.textContent=t('sharing.retryConnection.loading');}
  if(result) result.innerHTML='<span style="color:var(--text-muted)">'+t('sharing.retryConnection.loading')+'</span>';
  toast(t('sharing.retryConnection.loading'),'info');
  try{
    await loadSharingStatus(false);
    var d=sharingStatusCache;
    if(d&&d.connection&&d.connection.connected){
      toast(t('sharing.retryConnection.success'),'success');
      if(result) result.innerHTML='<span style="color:#22c55e">\\u2705 '+t('sharing.retryConnection.success')+'</span>';
    }else{
      toast(t('sharing.retryConnection.fail'),'error');
      if(result) result.innerHTML='<span style="color:#ef4444">'+t('sharing.retryConnection.fail')+'</span>';
    }
  }catch(e){
    toast(t('sharing.retryConnection.fail'),'error');
    if(result) result.innerHTML='<span style="color:#ef4444">'+t('sharing.retryConnection.fail')+'</span>';
  }
  if(btn){btn.disabled=false;btn.textContent=t('sharing.retryConnection');}
}

async function retryHubJoin(){
  if(!(await confirmModal(t('sharing.retryJoin.confirm')))) return;
  try{
    var r=await fetch('/api/sharing/retry-join',{method:'POST',headers:{'Content-Type':'application/json'}});
    var d=await r.json();
    if(d.ok){
      toast(t('sharing.retryJoin.success'),'success');
      _lastSidebarFingerprint='';_lastSettingsFingerprint='';_lastSharingConnStatus='';
      setTimeout(function(){loadSharingStatus(true);},800);
    }else{
      var code=d.errorCode||'';
      if(code==='hub_unreachable'){
        alertModal(t('sharing.joinError.hubUnreachable'));
      }else if(code==='username_taken'){
        alertModal(t('sharing.joinError.usernameTaken'));
      }else if(code==='invalid_team_token'){
        alertModal(t('sharing.joinError.invalidToken'));
      }else if(code==='blocked'){
        alertModal(t('sharing.joinError.blocked'));
      }else{
        toast(d.error||t('sharing.retryJoin.fail'),'error');
      }
    }
  }catch(e){toast(t('sharing.retryJoin.fail')+': '+e.message,'error');}
}

async function leaveTeam(){
  var teamName=(sharingStatusCache&&sharingStatusCache.connection&&sharingStatusCache.connection.teamName)||'';
  var msg=t('sharing.leaveTeam.confirm').replace('{team}',teamName||t('sharing.team.default'));
  if(!(await confirmModal(msg,{danger:true}))) return;
  try{
    var r=await fetch('/api/sharing/leave',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});
    var d=await r.json();
    if(d.ok){
      toast(t('sharing.leaveTeam.success'),'success');
      showRestartOverlay(t('settings.restart.waiting'));
    }else{
      toast(d.error||t('sharing.leaveTeam.fail'),'error');
    }
  }catch(e){toast(t('sharing.leaveTeam.fail')+': '+e.message,'error');}
}

async function updateHubUsername(){
  var input=document.getElementById('hubUsernameInput');
  if(!input) return;
  var newName=input.value.trim();
  if(!newName||newName.length<2||newName.length>32){
    alertModal(t('sharing.username.invalid'));
    return;
  }
  try{
    var r=await fetch('/api/sharing/update-username',{
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({username:newName})
    });
    var d=await r.json();
    if(d.error==='username_taken'){
      alertModal(t('sharing.username.taken'),{danger:true});
      return;
    }
    if(d.error){
      alertModal(d.error,{danger:true});
      return;
    }
    toast(t('sharing.username.updated'),'success');
    loadSharingStatus(false);
  }catch(e){
    alertModal(t('sharing.username.error'),{danger:true});
  }
}

async function loadSharingPendingUsers(){
  if(_sharingRole==='client') return;
  var el=document.getElementById('sharingAdminPanel');
  if(!el) return;
  el.innerHTML=t('sharing.loading');
  try{
    const r=await fetch('/api/sharing/pending-users');
    const d=await r.json();
    const users=Array.isArray(d.users)?d.users:[];
    renderSharingPendingUsers(users, d.error, sharingStatusCache&&sharingStatusCache.admin?sharingStatusCache.admin.rejectSupported:false);
  }catch(e){
    el.innerHTML='<div class="line">'+t('sharing.pendingLoadFail')+esc(String(e))+'</div>';
  }
}

function renderSharingPendingUsers(users, error, rejectSupported){
  var el=document.getElementById('sharingAdminPanel');
  if(!el) return;
  var wrap='<div class="hub-info-card hic-pending"><div class="hic-title"><span class="hic-icon">\u{1F6E1}</span>'+t('settings.hub.adminPending')+' <span class="hic-badge pending"><span class="hic-dot amber"></span>'+(users?users.length:0)+'</span></div>';
  if(error){
    el.innerHTML=wrap+'<div class="hic-empty">'+esc(error)+'</div></div>';
    return;
  }
  if(!users||users.length===0){
    el.innerHTML=wrap+'<div class="hic-empty">'+t('sharing.noPending')+'</div></div>';
    return;
  }
  el.innerHTML=wrap+users.map(function(user){
    return '<div style="display:flex;align-items:center;justify-content:space-between;padding:8px 0;border-top:1px solid var(--border)">'+
      '<div><div style="font-size:13px;font-weight:600;color:var(--text)">'+esc(user.username||user.id||'')+'</div>'+
      '<div style="font-size:11px;color:var(--text-muted)">'+t('admin.device')+esc(user.deviceName||'unknown')+'</div></div>'+
      '<div class="hic-actions" style="margin:0">'+
        '<button class="btn btn-sm btn-primary" onclick="approveSharingUser(&quot;'+escAttr(user.id)+'&quot;,&quot;'+escAttr(user.username||'')+'&quot;)">'+t('admin.approve')+'</button>'+
        (rejectSupported?'<button class="btn btn-sm btn-ghost" style="color:var(--rose)" onclick="rejectSharingUser(&quot;'+escAttr(user.id)+'&quot;,&quot;'+escAttr(user.username||'')+'&quot;)">'+t('admin.reject')+'</button>':'')+
      '</div></div>';
  }).join('')+'</div>';
}

async function approveSharingUser(userId,username){
  try{
    const r=await fetch('/api/sharing/approve-user',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({userId:userId,username:username})});
    const d=await r.json();
    if(d.ok){toast(t('toast.userApproved'),'success');loadSharingPendingUsers();loadSharingStatus(true);_lastAdminFingerprint='';loadAdminData();} else {toast(d.error||t('toast.approveFail'),'error');}
  }catch(e){toast(t('toast.approveFail')+': '+e.message,'error');}
}

async function rejectSharingUser(userId,username){
  try{
    const r=await fetch('/api/sharing/reject-user',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({userId:userId,username:username})});
    const d=await r.json();
    if(d.ok){toast(t('toast.userRejected'),'success');loadSharingPendingUsers();_lastAdminFingerprint='';loadAdminData();} else {toast(d.error||t('toast.rejectFail'),'error');}
  }catch(e){toast(t('toast.rejectFail')+': '+e.message,'error');}
}

/* ─── Team Setup Guide ─── */
function updateTeamGuide(sharingData){
  var el=document.getElementById('teamSetupGuide');
  if(!el) return;
  el.style.display='block';
}
function guideGoToHub(role){
  switchSettingsTab('hub',document.querySelector('.settings-tab-btn[data-tab="hub"]'));
  var chk=document.getElementById('cfgSharingEnabled');
  if(chk&&!chk.checked){chk.checked=true;onSharingToggle();}
  selectSharingRole(role);
  var card=document.getElementById('settingsSharingConfig');
  if(card) card.scrollIntoView({behavior:'smooth',block:'start'});
}


/* ─── Hub Admin Panel ─── */
var adminDataCache={users:[],groups:[],tasks:[],skills:[],memories:[]};
var _lastAdminFingerprint='';
var hubTasksCache=[];
var hubSkillsCache=[];
var ADMIN_PAGE_SIZE=20;
var adminPage={users:0,tasks:0,skills:0,memories:0};

function adminPaginateHtml(total,page,refilterFn){
  var pages=Math.ceil(total/ADMIN_PAGE_SIZE);
  if(pages<=1) return '';
  var html='<div class="pagination" style="padding:16px 0">';
  html+='<button class="pg-btn'+(page===0?' disabled':'')+'" onclick="'+refilterFn+'Page(-1)">\\u2190</button>';
  var start=Math.max(0,page-2),end=Math.min(pages,page+3);
  if(start>0) html+='<button class="pg-btn" onclick="'+refilterFn+'Page(0)">1</button>'+(start>1?'<span class="pg-info">...</span>':'');
  for(var i=start;i<end;i++){
    html+='<button class="pg-btn'+(i===page?' active':'')+'" onclick="'+refilterFn+'Page('+i+')">'+(i+1)+'</button>';
  }
  if(end<pages) html+=(end<pages-1?'<span class="pg-info">...</span>':'')+'<button class="pg-btn" onclick="'+refilterFn+'Page('+(pages-1)+')">'+pages+'</button>';
  html+='<button class="pg-btn'+(page>=pages-1?' disabled':'')+'" onclick="'+refilterFn+'Page('+(page+1)+')">\\u2192</button>';
  html+='<span class="pg-info">'+total+' '+t('pagination.total')+'</span>';
    html+='</div>';
  return html;
}

var _adminPollTimer=null;
function startAdminPoll(){ startLivePoller(); }
async function pollAdminPending(){
  if(!window._isHubAdmin) return;
  try{
    var r=await fetch('/api/sharing/pending-users');
    var d=await r.json();
    var count=Array.isArray(d.users)?d.users.length:0;
    var badge=document.getElementById('adminPendingBadge');
    if(badge){
      if(count>0){badge.textContent=count;badge.style.display='inline';}
      else{badge.style.display='none';}
    }
  }catch(e){}
}

function switchAdminTab(tab,btn){
  document.querySelectorAll('.admin-tabs .admin-tab').forEach(function(t){t.classList.remove('active');});
  btn.classList.add('active');
  document.querySelectorAll('.admin-panel').forEach(function(p){p.classList.remove('active');});
  var panel=document.getElementById('admin'+tab.charAt(0).toUpperCase()+tab.slice(1)+'Panel');
  if(panel) panel.classList.add('active');
}

function adminGoSetup(role){
  switchView('settings');
  setTimeout(function(){guideGoToHub(role);},200);
}

async function loadAdminData(){
  var notEnabledEl=document.getElementById('adminNotEnabled');
  var mainEl=document.getElementById('adminMainContent');
  var sharingOn=sharingStatusCache&&sharingStatusCache.enabled;
  if(!sharingOn){
    if(mainEl) mainEl.style.display='none';
    if(notEnabledEl){
      notEnabledEl.style.display='block';
      notEnabledEl.innerHTML=
        '<div style="text-align:center;padding:60px 32px;max-width:520px;margin:0 auto">'+
        '<div style="font-size:48px;margin-bottom:16px">\u{1F6E1}</div>'+
        '<div style="font-size:18px;font-weight:700;color:var(--text);margin-bottom:8px">'+t('admin.notEnabled.title')+'</div>'+
        '<div style="font-size:13px;color:var(--text-sec);line-height:1.7;margin-bottom:24px">'+t('admin.notEnabled.desc')+'</div>'+
        '<div style="display:flex;gap:12px;justify-content:center;flex-wrap:wrap">'+
        '<button class="btn btn-primary" style="padding:8px 20px;font-size:13px" onclick="adminGoSetup(&quot;hub&quot;)">'+t('admin.notEnabled.setupHub')+'</button>'+
        '<button class="btn btn-ghost" style="padding:8px 20px;font-size:13px" onclick="adminGoSetup(&quot;client&quot;)">'+t('admin.notEnabled.joinTeam')+'</button>'+
        '</div>'+
        '<div style="font-size:11px;color:var(--text-muted);margin-top:20px;line-height:1.6">'+t('admin.notEnabled.hint')+'</div>'+
        '</div>';
    }
    return;
  }
  if(notEnabledEl) notEnabledEl.style.display='none';
  if(mainEl) mainEl.style.display='';
  var isAdmin=!!window._isHubAdmin;
  try{
    var fetches;
    if(isAdmin){
      fetches=await Promise.all([
      fetch('/api/sharing/users').then(function(r){return r.json();}),
      fetch('/api/admin/shared-tasks').then(function(r){return r.json();}),
      fetch('/api/admin/shared-skills').then(function(r){return r.json();}),
      fetch('/api/sharing/pending-users').then(function(r){return r.json();}),
      fetch('/api/admin/shared-memories').then(function(r){return r.json();})
    ]);
    }else{
      fetches=await Promise.all([
        Promise.resolve({users:[]}),
        fetch('/api/sharing/tasks/list?limit=500').then(function(r){return r.json();}),
        fetch('/api/sharing/skills/list?limit=500').then(function(r){return r.json();}),
        Promise.resolve({users:[]}),
        fetch('/api/sharing/memories/list?limit=500').then(function(r){return r.json();})
      ]);
    }
    var usersR=fetches[0],tasksR=fetches[1],skillsR=fetches[2],pendingR=fetches[3],memoriesR=fetches[4];
    var _newUsers=Array.isArray(usersR.users)?usersR.users:[];
    var _newTasks=Array.isArray(tasksR.tasks)?tasksR.tasks:[];
    var _newSkills=Array.isArray(skillsR.skills)?skillsR.skills:[];
    var _newMemories=Array.isArray(memoriesR.memories)?memoriesR.memories:[];
    var pending=isAdmin?(Array.isArray(pendingR.users)?pendingR.users:[]):[];
    var _fp=_newUsers.length+':'+_newTasks.length+':'+_newSkills.length+':'+_newMemories.length+':'+pending.length
      +':'+_newUsers.map(function(u){return u.id+'|'+(u.isOnline?1:0)+'|'+(u.role||'')+'|'+(u.status||'')+'|'+(u.username||'')+'|'+(u.memoryCount||0)+'|'+(u.taskCount||0)+'|'+(u.skillCount||0)}).join(',')
      +':'+_newMemories.map(function(m){return m.id}).join(',')
      +':'+_newTasks.map(function(t){return t.id+'|'+(t.status||'')}).join(',')
      +':'+_newSkills.map(function(s){return s.id+'|'+(s.status||'')}).join(',')
      +':'+pending.map(function(p){return p.id}).join(',');
    if(_fp===_lastAdminFingerprint) return;
    _lastAdminFingerprint=_fp;
    adminDataCache.users=_newUsers;
    adminDataCache.tasks=_newTasks;
    adminDataCache.skills=_newSkills;
    adminDataCache.memories=_newMemories;
    adminDataCache._pending=pending;
    var badge=document.getElementById('adminPendingBadge');
    if(badge){if(pending.length>0){badge.textContent=pending.length;badge.style.display='inline';}else{badge.style.display='none';}}
    renderAdminStats(pending.length);
    renderAdminUsers(adminDataCache.users, pending);
    renderAdminTasks(adminDataCache.tasks);
    renderAdminSkills(adminDataCache.skills);
    renderAdminMemories(adminDataCache.memories);
    updateAdminTabsVisibility();
  }catch(e){
    var statsEl=document.getElementById('adminStats');
    if(statsEl) statsEl.innerHTML='<div class="admin-empty">'+t('admin.loadFailed')+esc(String(e))+'</div>';
  }
}
function updateAdminTabsVisibility(){
  var bar=document.getElementById('adminTabsBar');
  if(!bar) return;
  var tabs=bar.querySelectorAll('.admin-tab');
  var isAdmin=!!window._isHubAdmin;
  tabs.forEach(function(tab){
    var onclick=tab.getAttribute('onclick')||'';
    if(onclick.indexOf("'users'")!==-1){
      tab.style.display=isAdmin?'':'none';
    }
  });
  if(!isAdmin){
    var usersPanel=document.getElementById('adminUsersPanel');
    if(usersPanel&&usersPanel.classList.contains('active')){
      usersPanel.classList.remove('active');
      var memPanel=document.getElementById('adminMemoriesPanel');
      if(memPanel) memPanel.classList.add('active');
      tabs.forEach(function(tab){
        tab.classList.remove('active');
        var onclick=tab.getAttribute('onclick')||'';
        if(onclick.indexOf("'memories'")!==-1) tab.classList.add('active');
      });
    }
  }
  var subEl=document.querySelector('.admin-header-sub');
  if(subEl) subEl.textContent=isAdmin?t('admin.subtitle'):t('admin.subtitle.member');
}

var _lastAdminStatsFp='';
function renderAdminStats(pendingCount){
  var el=document.getElementById('adminStats');
  if(!el) return;
  var isAdmin=!!window._isHubAdmin;
  var onlineCount=adminDataCache.users.filter(function(u){return !!u.isOnline;}).length;
  var sfp=onlineCount+':'+adminDataCache.users.length+':'+pendingCount+':'+(adminDataCache.memories||[]).length+':'+adminDataCache.tasks.length+':'+adminDataCache.skills.length+':'+isAdmin;
  if(sfp===_lastAdminStatsFp) return;
  _lastAdminStatsFp=sfp;
  el.innerHTML=
    (isAdmin?'<div class="admin-stat-box"><span class="as-icon">\u{1F465}</span><div class="val">'+onlineCount+' / '+adminDataCache.users.length+'</div><div class="lbl">'+t('admin.stat.activeUsers')+'</div></div>'+
    '<div class="admin-stat-box"><span class="as-icon">\u{23F3}</span><div class="val">'+pendingCount+'</div><div class="lbl">'+t('admin.stat.pending')+'</div></div>':'')+
    '<div class="admin-stat-box"><span class="as-icon">\u{1F4AD}</span><div class="val">'+(adminDataCache.memories||[]).length+'</div><div class="lbl">'+t('admin.stat.sharedMemories')+'</div></div>'+
    '<div class="admin-stat-box"><span class="as-icon">\u{1F4CB}</span><div class="val">'+adminDataCache.tasks.length+'</div><div class="lbl">'+t('admin.stat.sharedTasks')+'</div></div>'+
    '<div class="admin-stat-box"><span class="as-icon">\u{1F9E0}</span><div class="val">'+adminDataCache.skills.length+'</div><div class="lbl">'+t('admin.stat.sharedSkills')+'</div></div>';
  var tc=document.getElementById('adminTabCountUsers');if(tc)tc.textContent=adminDataCache.users.length+pendingCount;
  tc=document.getElementById('adminTabCountMemories');if(tc)tc.textContent=(adminDataCache.memories||[]).length;
  tc=document.getElementById('adminTabCountTasks');if(tc)tc.textContent=adminDataCache.tasks.length;
  tc=document.getElementById('adminTabCountSkills');if(tc)tc.textContent=adminDataCache.skills.length;
}

function auRelativeTime(ts){
  if(!ts) return t('admin.neverActive');
  var diff=Date.now()-ts;
  if(diff<60000) return t('notif.timeAgo.just');
  if(diff<3600000) return t('notif.timeAgo.min').replace('{n}',Math.floor(diff/60000));
  if(diff<86400000) return t('notif.timeAgo.hour').replace('{n}',Math.floor(diff/3600000));
  return t('notif.timeAgo.day').replace('{n}',Math.floor(diff/86400000));
}

function renderAdminUserCard(u,adminCount,myUserId){
  var uid=escAttr(u.id);
  var uname=escAttr(u.username||'');
  var isSelf=!!(myUserId&&u.id===myUserId);
  var online=!!u.isOnline;
  var statusCls=online?'online':'offline';

  var statusIndicator='<span class="au-status-dot '+statusCls+'"></span>';
  var statusLabel=online
    ?'<span class="au-status-text online">'+t('admin.onlineNow')+'</span>'
    :'<span class="au-status-text offline">'+auRelativeTime(u.lastActiveAt)+'</span>';

  var titleDisplay='<span class="admin-card-title" id="au_name_'+uid+'">'+statusIndicator+esc(u.username||u.id)+
    ' <button onclick="adminStartEditName(this,&quot;'+uid+'&quot;,&quot;'+uname+'&quot;)" style="background:none;border:none;cursor:pointer;color:var(--text-muted);padding:2px;font-size:13px;vertical-align:middle;opacity:.5;transition:opacity .15s" onmouseenter="this.style.opacity=1" onmouseleave="this.style.opacity=.5" title="'+t('admin.editName')+'">\u270E</button></span>';

  var editRow='<div id="au_edit_'+uid+'" style="display:none;align-items:center;gap:6px">'+
    '<input id="au_input_'+uid+'" type="text" value="'+uname+'" style="flex:1;padding:5px 10px;border:1px solid var(--pri);border-radius:8px;font-size:13px;font-weight:600;background:var(--bg);color:var(--text);outline:none;min-width:0" onkeydown="if(event.key===&quot;Enter&quot;)adminSaveEditName(&quot;'+uid+'&quot;);if(event.key===&quot;Escape&quot;)adminCancelEditName(&quot;'+uid+'&quot;)">'+
    '<button onclick="adminSaveEditName(&quot;'+uid+'&quot;)" class="btn btn-sm btn-primary" style="padding:4px 12px;font-size:11px;white-space:nowrap">\u2713</button>'+
    '<button onclick="adminCancelEditName(&quot;'+uid+'&quot;)" class="btn btn-sm btn-ghost" style="padding:4px 8px;font-size:11px;color:var(--text-muted)">\u2717</button></div>';

  var mc=u.memoryCount||0, tc=u.taskCount||0, sc=u.skillCount||0;
  var contribHtml='<div class="au-contrib">'+
    '<span class="au-contrib-item"><span class="au-contrib-num" style="color:var(--pri)">'+mc+'</span> '+t('admin.contrib.memories')+'</span>'+
    '<span class="au-contrib-item"><span class="au-contrib-num" style="color:var(--green)">'+tc+'</span> '+t('admin.contrib.tasks')+'</span>'+
    '<span class="au-contrib-item"><span class="au-contrib-num" style="color:var(--amber)">'+sc+'</span> '+t('admin.contrib.skills')+'</span>'+
  '</div>';

  var infoRows=[];
  if(u.deviceName) infoRows.push('<span class="au-info-item">\u{1F4BB} '+t('admin.device')+esc(u.deviceName)+'</span>');
  if(u.lastIp) infoRows.push('<span class="au-info-item">\u{1F310} '+t('admin.ip')+esc(u.lastIp)+'</span>');
  if(u.createdAt) infoRows.push('<span class="au-info-item">\u{1F4C5} '+t('admin.joined')+formatDateTimeSeconds(u.createdAt)+'</span>');
  if(u.approvedAt) infoRows.push('<span class="au-info-item">\u2705 '+t('admin.approved')+formatDateTimeSeconds(u.approvedAt)+'</span>');
  var lastAct=u.lastActiveAt||u.approvedAt||u.createdAt;
  infoRows.push('<span class="au-info-item">\u{1F552} '+t('admin.lastActive')+(lastAct?formatDateTimeSeconds(lastAct):t('admin.neverActive'))+'</span>');
  var infoHtml='<div class="au-info">'+infoRows.join('')+'</div>';

  var actions='';
  if(isSelf){
    actions+='<span style="font-size:11px;color:var(--text-muted);padding:4px 0">'+t('admin.selfHint')+'</span>';
  }else if(u.isOwner){
    actions+='<span style="font-size:11px;color:var(--text-muted);padding:4px 0">'+t('admin.ownerHint')+'</span>';
  }else if(u.role!=='admin'){
    actions+='<button class="btn btn-sm btn-ghost" onclick="adminToggleRole(&quot;'+uid+'&quot;,&quot;admin&quot;)" style="color:var(--accent)">'+t('admin.promoteAdmin')+'</button>';
    actions+='<button class="btn btn-sm btn-ghost" onclick="adminRemoveUser(&quot;'+uid+'&quot;,&quot;'+uname+'&quot;)" style="color:var(--rose)">'+t('admin.remove')+'</button>';
  }else if(adminCount>1){
    actions+='<button class="btn btn-sm btn-ghost" onclick="adminToggleRole(&quot;'+uid+'&quot;,&quot;member&quot;)">'+t('admin.demoteMember')+'</button>';
    actions+='<button class="btn btn-sm btn-ghost" onclick="adminRemoveUser(&quot;'+uid+'&quot;,&quot;'+uname+'&quot;)" style="color:var(--rose)">'+t('admin.remove')+'</button>';
  }else{
    actions+='<span style="font-size:11px;color:var(--text-muted);padding:4px 0">'+t('admin.lastAdminHint')+'</span>';
  }
  var badgesHtml='<div class="au-badges">'+statusLabel+
    '<span class="admin-badge '+(u.role==='admin'?'admin':'member')+'">'+esc(u.role||'member').toUpperCase()+'</span>'+
    (u.isOwner?'<span class="admin-badge owner">OWNER</span>':'')+
    '</div>';

  return '<div class="admin-card au-card au-'+statusCls+'"><div class="admin-card-header"><div style="flex:1;min-width:0">'+titleDisplay+editRow+'</div>'+
    badgesHtml+'</div>'+
    contribHtml+infoHtml+
    (actions?'<div class="admin-card-actions" style="border-top:1px solid rgba(99,102,241,.08);padding-top:12px;margin-top:6px">'+actions+'</div>':'')+
    '</div>';
}

function renderAdminUsers(users,pending){
  var el=document.getElementById('adminUsersPanel');
  if(!el) return;
  var isAdmin=!!window._isHubAdmin;
  if(!isAdmin){
    el.innerHTML='<div class="admin-empty" style="padding:32px;text-align:center;color:var(--text-sec)">'+t('admin.noPermission')+'</div>';
    return;
  }
  var html='';
  if(pending&&pending.length>0){
    html+='<div class="admin-pending-section"><h3>'+t('admin.pendingApproval')+' <span class="pending-count">'+pending.length+'</span></h3>';
    for(var p=0;p<pending.length;p++){
      var pu=pending[p];
      html+='<div class="admin-pending-card">'+
        '<div class="apc-name">'+esc(pu.username||pu.id||'Unknown')+'</div>'+
        '<div class="apc-meta"><span>\u{1F4BB} '+esc(pu.deviceName||'unknown')+'</span>'+(pu.createdAt?'<span>\u{1F552} '+formatDateTimeSeconds(pu.createdAt)+'</span>':'')+'</div>'+
        '<div class="apc-actions">'+
          '<button class="btn-approve" onclick="adminApproveUser(&quot;'+escAttr(pu.id)+'&quot;,&quot;'+escAttr(pu.username||'')+'&quot;)">'+t('admin.approve')+'</button>'+
          '<button class="btn-reject" onclick="adminRejectUser(&quot;'+escAttr(pu.id)+'&quot;)">'+t('admin.reject')+'</button>'+
        '</div></div>';
    }
    html+='</div>';
  }

  var onlineUsers=users.filter(function(u){return !!u.isOnline;});
  var offlineUsers=users.filter(function(u){return !u.isOnline;});
  offlineUsers.sort(function(a,b){return (b.lastActiveAt||0)-(a.lastActiveAt||0);});
  var sorted=onlineUsers.concat(offlineUsers);
  var adminCount=users.filter(function(x){return x.role==='admin';}).length;
  var myUserId=sharingStatusCache&&sharingStatusCache.connection&&sharingStatusCache.connection.user?sharingStatusCache.connection.user.id:null;

  if(sorted.length===0){
    html+='<div class="admin-empty"><span class="ae-icon">\u{1F465}</span>'+t('admin.noActiveUsers')+'</div>';
  }else{
    html+='<div class="au-group-header"><span class="au-group-dot online"></span>'+t('admin.onlineUsers')+' <span class="au-group-count">('+onlineUsers.length+')</span></div>';
    if(onlineUsers.length===0){
      html+='<div style="font-size:12px;color:var(--text-muted);padding:8px 0 12px">\u2014</div>';
    }else{
      for(var i=0;i<onlineUsers.length;i++) html+=renderAdminUserCard(onlineUsers[i],adminCount,myUserId);
    }
    html+='<div class="au-group-header"><span class="au-group-dot offline"></span>'+t('admin.offlineUsers')+' <span class="au-group-count">('+offlineUsers.length+')</span></div>';
    if(offlineUsers.length===0){
      html+='<div style="font-size:12px;color:var(--text-muted);padding:8px 0 12px">\u2014</div>';
    }else{
      for(var j=0;j<offlineUsers.length;j++) html+=renderAdminUserCard(offlineUsers[j],adminCount,myUserId);
    }
  }
  el.innerHTML=html;
}
function adminUsersPage(p){renderAdminUsers(adminDataCache.users,adminDataCache._pending||[]);}

async function adminApproveUser(userId,username){
  try{
    var r=await fetch('/api/sharing/approve-user',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({userId:userId,username:username})});
    var d=await r.json();
    if(d.ok){toast(t('toast.userApproved'),'success');_lastAdminFingerprint='';loadAdminData();}else{toast(d.error||t('toast.approveFail'),'error');}
  }catch(e){toast(t('toast.approveFail')+': '+e.message,'error');}
}
async function adminRejectUser(userId){
  if(!(await confirmModal(t('confirm.rejectUser'),{danger:true}))) return;
  try{
    var r=await fetch('/api/sharing/reject-user',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({userId:userId})});
    var d=await r.json();
    if(d.ok){toast(t('toast.userRejected'),'success');_lastAdminFingerprint='';loadAdminData();}else{toast(d.error||t('toast.rejectFail'),'error');}
  }catch(e){toast(t('toast.rejectFail')+': '+e.message,'error');}
}
async function adminToggleRole(userId,newRole){
  var msg=newRole==='admin'?t('confirm.promoteAdmin'):t('confirm.demoteMember');
  if(!(await confirmModal(msg))) return;
  try{
    var r=await fetch('/api/sharing/change-role',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({userId:userId,role:newRole})});
    var d=await r.json();
    if(d.ok){
      toast(t('toast.roleChanged'),'success');
      _lastAdminFingerprint='';
      _lastSettingsFingerprint='';
      _lastSidebarFingerprint='';
      await loadSharingStatus(false);
      loadAdminData();
    }
    else if(d.error==='cannot_demote_owner'){toast(t('admin.ownerHint'),'error');}
    else{toast(d.error||t('toast.roleChangeFail'),'error');}
  }catch(e){toast(t('toast.roleChangeFail')+': '+e.message,'error');}
}
function adminStartEditName(btn,userId,currentName){
  var nameEl=document.getElementById('au_name_'+userId);
  var editEl=document.getElementById('au_edit_'+userId);
  var inputEl=document.getElementById('au_input_'+userId);
  if(!nameEl||!editEl||!inputEl) return;
  nameEl.style.display='none';
  editEl.style.display='flex';
  inputEl.value=currentName;
  inputEl.focus();
  inputEl.select();
}
function adminCancelEditName(userId){
  var nameEl=document.getElementById('au_name_'+userId);
  var editEl=document.getElementById('au_edit_'+userId);
  if(nameEl) nameEl.style.display='';
  if(editEl) editEl.style.display='none';
}
async function adminSaveEditName(userId){
  var inputEl=document.getElementById('au_input_'+userId);
  if(!inputEl) return;
  var newName=inputEl.value.trim();
  if(!newName||newName.length<2||newName.length>32){
    alertModal(t('toast.invalidUsername'),{title:t('admin.editName')});
    return;
  }
  inputEl.disabled=true;
  try{
    var r=await fetch('/api/sharing/rename-user',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({userId:userId,username:newName})});
    var d=await r.json();
    if(d.ok){toast(t('toast.usernameChanged'),'success');adminCancelEditName(userId);loadAdminData();}
    else{
      inputEl.disabled=false;
      if(d.error==='username_taken'){
        alertModal(t('sharing.username.taken'),{title:t('admin.editName'),danger:true});
      }else{
        alertModal(d.error||t('toast.renameFail'),{title:t('admin.editName'),danger:true});
      }
    }
  }catch(e){inputEl.disabled=false;alertModal(t('toast.renameFail'),{title:t('admin.editName'),danger:true});}
}

async function adminRemoveUser(userId,username){
  if(!(await confirmModal(t('confirm.removeUser'),{danger:true}))) return;
  var clean=await confirmModal(t('confirm.cleanResources'));
  try{
    var r=await fetch('/api/sharing/remove-user',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({userId:userId,cleanResources:clean})});
    var d=await r.json();
    if(d.ok){toast(t('toast.userRemoved'),'success');_lastAdminFingerprint='';loadAdminData();}
    else if(d.error==='cannot_remove_owner'){toast(t('admin.ownerHint'),'error');}
    else{toast(d.error||t('toast.removeFail'),'error');}
  }catch(e){toast(t('toast.removeFail')+': '+e.message,'error');}
}


function adminToolbarHtml(items,keyFn,filterId,searchId,onchangeFn,opts){
  opts=opts||{};
  var owners={};
  for(var i=0;i<items.length;i++){var n=keyFn(items[i]);if(n)owners[n]=1;}
  var names=Object.keys(owners).sort();
  var html='';
  if(names.length>=1){
    html+='<select id="'+filterId+'" onchange="'+onchangeFn+'()" class="admin-toolbar select"><option value="">'+t('admin.filter.owner')+'</option>';
    for(var j=0;j<names.length;j++) html+='<option value="'+escAttr(names[j])+'">'+esc(names[j])+'</option>';
    html+='</select>';
  }
  if(opts.sortId){
    html+='<select id="'+opts.sortId+'" onchange="'+onchangeFn+'()" class="admin-toolbar select">'+
      '<option value="newest">'+t('admin.sort.newest')+'</option>'+
      '<option value="oldest">'+t('admin.sort.oldest')+'</option></select>';
  }
  if(opts.extraFilters){
    for(var ef=0;ef<opts.extraFilters.length;ef++){
      var f=opts.extraFilters[ef];
      var vals={};
      for(var fi=0;fi<items.length;fi++){var fv=f.keyFn(items[fi]);if(fv)vals[fv]=1;}
      var fkeys=Object.keys(vals).sort();
      if(fkeys.length>=1){
        html+='<select id="'+f.id+'" onchange="'+onchangeFn+'()" class="admin-toolbar select"><option value="">'+esc(f.label)+'</option>';
        for(var fk=0;fk<fkeys.length;fk++) html+='<option value="'+escAttr(fkeys[fk])+'">'+esc(fkeys[fk])+'</option>';
        html+='</select>';
      }
    }
  }
  return html;
}
function renderAdminTasks(tasks){
  var el=document.getElementById('adminTasksPanel');
  if(!el) return;
  adminTasksCache=tasks;
  var filterVal=document.getElementById('adminTaskFilter')?document.getElementById('adminTaskFilter').value:'';
  var sortVal=document.getElementById('adminTaskSort')?document.getElementById('adminTaskSort').value:'newest';
  var statusVal=document.getElementById('adminTaskStatusFilter')?document.getElementById('adminTaskStatusFilter').value:'';
  var filtered=tasks;
  if(filterVal) filtered=filtered.filter(function(tk){return (tk.ownerName||tk.sourceUserId||'')===filterVal;});
  if(statusVal) filtered=filtered.filter(function(tk){return (tk.status||'')===statusVal;});
  filtered=filtered.slice().sort(function(a,b){var ta=a.updatedAt||a.createdAt||0,tb=b.updatedAt||b.createdAt||0;return sortVal==='oldest'?ta-tb:tb-ta;});
  var html='<div class="admin-toolbar"><h3>'+t('admin.sharedTasks')+' ('+filtered.length+'/'+tasks.length+')</h3>'+
    adminToolbarHtml(tasks,function(tk){return tk.ownerName||tk.sourceUserId||'';},'adminTaskFilter','adminTaskSearch','refilterAdminTasks',{sortId:'adminTaskSort',extraFilters:[
      {id:'adminTaskStatusFilter',label:t('admin.filter.status'),keyFn:function(tk){return tk.status||''}}
    ]})+'</div>';
  if(filtered.length===0){
    html+='<div class="admin-empty"><span class="ae-icon">\u{1F4CB}</span>'+t('admin.noSharedTasks')+'</div>';
  }else{
    var tPages=Math.ceil(filtered.length/ADMIN_PAGE_SIZE);
    if(adminPage.tasks>=tPages) adminPage.tasks=Math.max(0,tPages-1);
    var tStart=adminPage.tasks*ADMIN_PAGE_SIZE,tEnd=Math.min(tStart+ADMIN_PAGE_SIZE,filtered.length);
    for(var i=tStart;i<tEnd;i++){
      var tk=filtered[i];
      var cardId='adminTaskCard_'+i;
      var timeRange='';
      if(tk.startedAt) timeRange+=formatTime(tk.startedAt);
      if(tk.endedAt) timeRange+=' \u2192 '+formatTime(tk.endedAt);
      html+='<div class="admin-card admin-card-clickable" id="'+cardId+'" onclick="toggleAdminTaskCard(&quot;'+cardId+'&quot;,'+i+')">'+
        '<div class="admin-card-header"><div class="admin-card-title">'+esc(tk.title||tk.id)+'</div></div>'+
        '<div class="admin-card-tags">'+
          '<div class="admin-card-tags-left">'+
            '<span class="admin-card-tag tag-owner">\u{1F464} '+fmtOwner(tk)+'</span>'+
            (tk.status?'<span class="admin-card-tag tag-status">'+esc(tk.status)+'</span>':'')+
            (tk.chunkCount!=null?'<span class="admin-card-tag tag-kind">\u{1F4DD} '+t('admin.chunks').replace('{n}',String(tk.chunkCount))+'</span>':'')+
        '</div>'+
          '<span class="admin-card-actions" onclick="event.stopPropagation()">'+
            (window._isHubAdmin?'<button class="btn btn-sm btn-ghost" onclick="adminDeleteTask(&quot;'+escAttr(tk.id)+'&quot;,&quot;'+escAttr(tk.title||tk.id)+'&quot;)" style="color:var(--rose)">'+t('admin.remove')+'</button>':'')+
            '<button class="btn btn-sm btn-ghost admin-card-expand-btn" onclick="toggleAdminTaskCard(&quot;'+cardId+'&quot;,'+i+')">'+t('admin.expand')+'</button>'+
            '<span class="admin-card-time">'+(timeRange||formatDateTimeSeconds(tk.updatedAt||tk.createdAt))+'</span>'+
          '</span>'+
        '</div>'+
        (tk.summary?'<div class="admin-card-preview">'+esc(tk.summary.slice(0,120))+'</div>':'')+
        '<div class="admin-card-detail" id="'+cardId+'_detail" onclick="event.stopPropagation()"></div>'+
      '</div>';
    }
    html+=adminPaginateHtml(filtered.length,adminPage.tasks,'adminTasks');
  }
  el.innerHTML=html;
  if(filterVal){var sel=document.getElementById('adminTaskFilter');if(sel)sel.value=filterVal;}
  if(sortVal!=='newest'){var so=document.getElementById('adminTaskSort');if(so)so.value=sortVal;}
  if(statusVal){var sf=document.getElementById('adminTaskStatusFilter');if(sf)sf.value=statusVal;}
}
function refilterAdminTasks(){adminPage.tasks=0;renderAdminTasks(adminTasksCache||[]);}
function adminTasksPage(p){if(p<0){adminPage.tasks=Math.max(0,adminPage.tasks-1);}else{adminPage.tasks=p;}renderAdminTasks(adminTasksCache||[]);}

async function adminDeleteTask(taskId,taskTitle){
  if(!(await confirmModal(t('confirm.removeTask').replace('{name}',taskTitle),{danger:true}))) return;
  try{
    var r=await fetch('/api/admin/shared-tasks/'+encodeURIComponent(taskId),{method:'DELETE'});
    var d=await r.json();
    if(d.ok){toast(t('toast.taskRemoved'),'success');loadAdminData();}else{toast(d.error||t('toast.removeFail'),'error');}
  }catch(e){toast(t('toast.removeFail')+': '+e.message,'error');}
}

function renderAdminSkills(skills){
  var el=document.getElementById('adminSkillsPanel');
  if(!el) return;
  adminSkillsCache=skills;
  var filterVal=document.getElementById('adminSkillFilter')?document.getElementById('adminSkillFilter').value:'';
  var sortVal=document.getElementById('adminSkillSort')?document.getElementById('adminSkillSort').value:'newest';
  var statusVal=document.getElementById('adminSkillStatusFilter')?document.getElementById('adminSkillStatusFilter').value:'';
  var filtered=skills;
  if(filterVal) filtered=filtered.filter(function(s){return (s.ownerName||s.sourceUserId||'')===filterVal;});
  if(statusVal) filtered=filtered.filter(function(s){return (s.status||'')===statusVal;});
  filtered=filtered.slice().sort(function(a,b){var ta=a.updatedAt||a.createdAt||0,tb=b.updatedAt||b.createdAt||0;return sortVal==='oldest'?ta-tb:tb-ta;});
  var html='<div class="admin-toolbar"><h3>'+t('admin.sharedSkills')+' ('+filtered.length+'/'+skills.length+')</h3>'+
    adminToolbarHtml(skills,function(s){return s.ownerName||s.sourceUserId||'';},'adminSkillFilter','adminSkillSearch','refilterAdminSkills',{sortId:'adminSkillSort',extraFilters:[
      {id:'adminSkillStatusFilter',label:t('admin.filter.status'),keyFn:function(s){return s.status||''}}
    ]})+'</div>';
  if(filtered.length===0){
    html+='<div class="admin-empty"><span class="ae-icon">\u{1F9E0}</span>'+t('admin.noSharedSkills')+'</div>';
  }else{
    var sPages=Math.ceil(filtered.length/ADMIN_PAGE_SIZE);
    if(adminPage.skills>=sPages) adminPage.skills=Math.max(0,sPages-1);
    var sStart=adminPage.skills*ADMIN_PAGE_SIZE,sEnd=Math.min(sStart+ADMIN_PAGE_SIZE,filtered.length);
    for(var i=sStart;i<sEnd;i++){
      var s=filtered[i];
      var cardId='adminSkillCard_'+i;
      var qs=s.qualityScore;
      html+='<div class="admin-card admin-card-clickable" id="'+cardId+'" onclick="toggleAdminSkillCard(&quot;'+cardId+'&quot;,'+i+')">'+
        '<div class="admin-card-header"><div class="admin-card-title">'+esc(s.name||s.id)+'</div></div>'+
        '<div class="admin-card-tags">'+
          '<div class="admin-card-tags-left">'+
            '<span class="admin-card-tag tag-owner">\u{1F464} '+fmtOwner(s)+'</span>'+
            (s.status?'<span class="admin-card-tag tag-status">'+esc(s.status)+'</span>':'')+
            (s.version!=null?'<span class="admin-card-tag tag-version">v'+s.version+'</span>':'')+
            (qs!=null?'<span class="admin-card-tag tag-kind">\u2605 '+Number(qs).toFixed(1)+'</span>':'')+
        '</div>'+
          '<span class="admin-card-actions" onclick="event.stopPropagation()">'+
            (window._isHubAdmin?'<button class="btn btn-sm btn-ghost" onclick="adminDeleteSkill(&quot;'+escAttr(s.id)+'&quot;,&quot;'+escAttr(s.name||s.id)+'&quot;)" style="color:var(--rose)">'+t('admin.remove')+'</button>':'')+
            '<button class="btn btn-sm btn-ghost admin-card-expand-btn" onclick="toggleAdminSkillCard(&quot;'+cardId+'&quot;,'+i+')">'+t('admin.expand')+'</button>'+
            (s.sourceSkillId?'<button class="btn btn-sm btn-ghost" onclick="window.open(&quot;/api/skill/'+encodeURIComponent(s.sourceSkillId)+'/download&quot;,&quot;_blank&quot;)" style="color:var(--pri)">\u2B07</button>':'')+
            '<span class="admin-card-time">'+formatDateTimeSeconds(s.updatedAt||s.createdAt)+'</span>'+
          '</span>'+
        '</div>'+
        (s.description?'<div class="admin-card-preview">'+esc(s.description.slice(0,150))+'</div>':'')+
        '<div class="admin-card-detail" id="'+cardId+'_detail" onclick="event.stopPropagation()"></div>'+
      '</div>';
    }
    html+=adminPaginateHtml(filtered.length,adminPage.skills,'adminSkills');
  }
  el.innerHTML=html;
  if(filterVal){var sel=document.getElementById('adminSkillFilter');if(sel)sel.value=filterVal;}
  if(sortVal!=='newest'){var so=document.getElementById('adminSkillSort');if(so)so.value=sortVal;}
  if(statusVal){var sf=document.getElementById('adminSkillStatusFilter');if(sf)sf.value=statusVal;}
}
function refilterAdminSkills(){adminPage.skills=0;renderAdminSkills(adminSkillsCache||[]);}
function adminSkillsPage(p){if(p<0){adminPage.skills=Math.max(0,adminPage.skills-1);}else{adminPage.skills=p;}renderAdminSkills(adminSkillsCache||[]);}

async function adminDeleteSkill(skillId,skillName){
  if(!(await confirmModal(t('confirm.removeSkill').replace('{name}',skillName),{danger:true}))) return;
  try{
    var r=await fetch('/api/admin/shared-skills/'+encodeURIComponent(skillId),{method:'DELETE'});
    var d=await r.json();
    if(d.ok){toast(t('toast.skillRemoved'),'success');loadAdminData();}else{toast(d.error||t('toast.removeFail'),'error');}
  }catch(e){toast(t('toast.removeFail')+': '+e.message,'error');}
}

function renderAdminMemories(memories){
  var el=document.getElementById('adminMemoriesPanel');
  if(!el) return;
  adminMemoriesCache=memories||[];
  var all=memories||[];
  var filterVal=document.getElementById('adminMemoryFilter')?document.getElementById('adminMemoryFilter').value:'';
  var sortVal=document.getElementById('adminMemorySort')?document.getElementById('adminMemorySort').value:'newest';
  var roleVal=document.getElementById('adminMemoryRoleFilter')?document.getElementById('adminMemoryRoleFilter').value:'';
  var filtered=all;
  if(filterVal) filtered=filtered.filter(function(m){return (m.ownerName||m.sourceUserId||'')===filterVal;});
  if(roleVal) filtered=filtered.filter(function(m){return (m.role||'')===roleVal;});
  filtered=filtered.slice().sort(function(a,b){var ta=a.updatedAt||a.createdAt||0,tb=b.updatedAt||b.createdAt||0;return sortVal==='oldest'?ta-tb:tb-ta;});
  var html='<div class="admin-toolbar"><h3>'+t('admin.sharedMemories')+' ('+filtered.length+'/'+all.length+')</h3>'+
    adminToolbarHtml(all,function(m){return m.ownerName||m.sourceUserId||'';},'adminMemoryFilter','adminMemorySearch','refilterAdminMemories',{sortId:'adminMemorySort',extraFilters:[
      {id:'adminMemoryRoleFilter',label:t('admin.filter.role'),keyFn:function(m){return m.role||''}}
    ]})+'</div>';
  if(filtered.length===0){
    html+='<div class="admin-empty"><span class="ae-icon">\u{1F4AD}</span>'+t('admin.noSharedMemories')+'</div>';
  }else{
    var mPages=Math.ceil(filtered.length/ADMIN_PAGE_SIZE);
    if(adminPage.memories>=mPages) adminPage.memories=Math.max(0,mPages-1);
    var mStart=adminPage.memories*ADMIN_PAGE_SIZE,mEnd=Math.min(mStart+ADMIN_PAGE_SIZE,filtered.length);
    for(var i=mStart;i<mEnd;i++){
      var m=filtered[i];
      var cardId='adminMemCard_'+i;
      var preview=m.content?esc(m.content.slice(0,120)):'';
      html+='<div class="admin-card" id="'+cardId+'">'+
        '<div class="admin-card-header"><div class="admin-card-title">'+esc(m.summary||m.content?.slice(0,80)||m.id)+'</div></div>'+
        '<div class="admin-card-tags">'+
          '<div class="admin-card-tags-left">'+
            '<span class="admin-card-tag tag-owner">\u{1F464} '+fmtOwner(m)+'</span>'+
            (m.role?'<span class="admin-card-tag tag-role">'+esc(m.role)+'</span>':'')+
            (m.kind?'<span class="admin-card-tag tag-kind">'+esc(m.kind)+'</span>':'')+
        '</div>'+
          '<span class="admin-card-actions">'+
          (window._isHubAdmin?'<button class="btn btn-sm btn-ghost" onclick="event.stopPropagation();adminDeleteMemory(&quot;'+escAttr(m.id)+'&quot;,&quot;'+escAttr(m.summary||m.id)+'&quot;)" style="color:var(--rose)">'+t('admin.remove')+'</button>':'')+
            '<button class="btn btn-sm btn-ghost admin-card-expand-btn" onclick="event.stopPropagation();toggleAdminMemoryCard(&quot;'+cardId+'&quot;,'+i+')">'+t('admin.expand')+'</button>'+
            '<span class="admin-card-time">'+formatDateTimeSeconds(m.updatedAt||m.createdAt)+'</span>'+
          '</span>'+
        '</div>'+
        (preview?'<div class="admin-card-preview">'+preview+'</div>':'')+
        '<div class="admin-card-detail" id="'+cardId+'_detail"></div>'+
      '</div>';
    }
    html+=adminPaginateHtml(filtered.length,adminPage.memories,'adminMemories');
  }
  el.innerHTML=html;
  if(filterVal){var sel=document.getElementById('adminMemoryFilter');if(sel)sel.value=filterVal;}
  if(sortVal!=='newest'){var so=document.getElementById('adminMemorySort');if(so)so.value=sortVal;}
  if(roleVal){var rf=document.getElementById('adminMemoryRoleFilter');if(rf)rf.value=roleVal;}
}
function refilterAdminMemories(){adminPage.memories=0;renderAdminMemories(adminMemoriesCache||[]);}
function adminMemoriesPage(p){if(p<0){adminPage.memories=Math.max(0,adminPage.memories-1);}else{adminPage.memories=p;}renderAdminMemories(adminMemoriesCache||[]);}

function toggleAdminMemoryCard(cardId,idx){
  var card=document.getElementById(cardId);
  if(!card) return;
  var detail=document.getElementById(cardId+'_detail');
  var btn=card.querySelector('.admin-card-expand-btn');
  if(card.classList.contains('expanded')){
    card.classList.remove('expanded');
    if(btn) btn.textContent=t('admin.expand');
    return;
  }
  card.classList.add('expanded');
  if(btn) btn.textContent=t('admin.collapse');
  if(detail.getAttribute('data-loaded')) return;
  detail.setAttribute('data-loaded','1');
  var m=(adminMemoriesCache||[])[idx];
  if(!m){detail.innerHTML='<div style="color:var(--text-muted);font-size:13px">'+t('admin.noContent')+'</div>';return;}
  var metaHtml='<div class="admin-card-detail-meta">'+
    (m.kind?'<span class="meta-item">'+t('admin.kind')+esc(m.kind)+'</span>':'')+
    (m.role?'<span class="meta-item">'+t('admin.role')+esc(m.role)+'</span>':'')+
    (m.visibility?'<span class="meta-item">'+t('admin.visibility')+esc(m.visibility)+'</span>':'')+
    '<span class="meta-item">'+t('admin.owner')+fmtOwner(m)+'</span>'+
    (m.groupName?'<span class="meta-item">'+t('admin.group')+esc(m.groupName)+'</span>':'')+
    '<span class="meta-item">'+new Date(m.updatedAt||m.createdAt||0).toLocaleString(dateLoc())+'</span>'+
  '</div>';
  var summaryHtml=m.summary?'<div class="admin-card-detail-section"><div class="detail-label">'+t('admin.summary')+'</div><div style="font-size:13px;color:var(--text);line-height:1.6">'+esc(m.summary)+'</div></div>':'';
  var contentHtml='<div class="admin-card-detail-section"><div class="detail-label">'+t('admin.contentLabel')+'</div><div class="admin-card-detail-content" id="'+cardId+'_content">'+
    (m.content?esc(m.content):t('sharing.loading'))+'</div></div>';
  detail.innerHTML=metaHtml+summaryHtml+contentHtml;
  if(!m.content&&(m.remoteHitId||m.id)){
    fetch('/api/sharing/memory-detail',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({remoteHitId:m.remoteHitId||m.id})})
    .then(function(r){return r.json();}).then(function(d){
      var ce=document.getElementById(cardId+'_content');
      if(!ce) return;
      if(!d.error&&d.content){ce.textContent=d.content;}
      else{ce.textContent=t('admin.noContent');}
    }).catch(function(){
      var ce=document.getElementById(cardId+'_content');
      if(ce) ce.textContent=t('admin.noContent');
    });
  }
}

async function toggleAdminTaskCard(cardId,idx){
  var card=document.getElementById(cardId);
  if(!card) return;
  var detail=document.getElementById(cardId+'_detail');
  var btn=card.querySelector('.admin-card-expand-btn');
  if(card.classList.contains('expanded')){
    card.classList.remove('expanded');
    if(btn) btn.textContent=t('admin.expand');
    return;
  }
  card.classList.add('expanded');
  if(btn) btn.textContent=t('admin.collapse');
  if(detail.getAttribute('data-loaded')) return;
  detail.setAttribute('data-loaded','1');
  var tk=(adminTasksCache||[])[idx];
  if(!tk){detail.innerHTML='<div style="color:var(--text-muted);font-size:14px;padding:12px">'+t('admin.noContent')+'</div>';return;}
  var localTaskId=tk.sourceTaskId||tk.id;
  var hubTaskId=tk.id;
  detail.innerHTML='<div class="spinner"></div>';
  var task=null;
  try{
    var r=await fetch('/api/task/'+encodeURIComponent(localTaskId));
    if(r.ok) task=await r.json();
  }catch(e){}
  if(!task){
    try{
      var r2=await fetch('/api/admin/shared-tasks/'+encodeURIComponent(hubTaskId)+'/detail');
      if(r2.ok) task=await r2.json();
    }catch(e2){}
  }
  if(!task){detail.innerHTML='<div style="color:var(--text-muted);font-size:14px;padding:12px">'+t('admin.noContent')+'</div>';return;}
  var metaHtml='<div class="admin-card-detail-meta admin-task-meta">'+
    (tk.status?'<span class="meta-item"><span class="task-status-badge '+tk.status+'">'+esc(tk.status)+'</span></span>':'')+
    (tk.visibility?'<span class="meta-item">'+t('admin.visibility')+esc(tk.visibility)+'</span>':'')+
    '<span class="meta-item">'+t('admin.owner')+fmtOwner(tk)+'</span>'+
    (tk.groupName?'<span class="meta-item">'+t('admin.group')+esc(tk.groupName)+'</span>':'')+
    (task.chunks&&task.chunks.length?'<span class="meta-item">\u{1F4AC} '+task.chunks.length+' '+t('tasks.chunks.label')+'</span>':'')+
    (task.startedAt?'<span class="meta-item">\u{1F4C5} '+formatDateTimeSeconds(task.startedAt)+'</span>':'')+
    (task.endedAt?'<span class="meta-item">\u2192 '+formatDateTimeSeconds(task.endedAt)+'</span>':'')+
    '<span class="meta-item">'+t('admin.updated')+new Date(tk.updatedAt||tk.createdAt||0).toLocaleString(dateLoc())+'</span>'+
  '</div>';
  var summaryHtml=(task.summary||tk.summary)?
    '<div class="admin-card-detail-section admin-task-summary"><div class="detail-label">'+t('admin.summary')+'</div><div class="admin-task-summary-body">'+renderSummaryHtml(task.summary||tk.summary)+'</div></div>':
    '<div class="admin-card-detail-section"><div style="color:var(--text-muted);font-size:14px">'+t('admin.noContent')+'</div></div>';
  var chunksHtml='';
  if(task.chunks&&task.chunks.length>0){
    var safeId=cardId.replace(/[^a-zA-Z0-9_-]/g,'_');
    chunksHtml='<div class="admin-card-detail-section"><div class="detail-label">'+t('tasks.chunks')+' ('+task.chunks.length+')</div><div class="admin-task-chunks">'+
      task.chunks.map(function(c,i){
        var role=c.role||'assistant';
        var roleLabel=role==='user'?t('tasks.role.user'):role==='assistant'?t('tasks.role.assistant'):role.toUpperCase();
        var bid='admchunk_b_'+safeId+'_'+i;
        var eid='admchunk_e_'+safeId+'_'+i;
        return '<div class="adm-msg">'+
          '<div class="adm-msg-side '+role+'"><div class="adm-msg-role">'+roleLabel+'</div><div class="adm-msg-time">'+formatDateTimeSeconds(c.createdAt)+'</div></div>'+
          '<div style="flex:1;min-width:0"><div class="adm-msg-body collapsed" id="'+bid+'">'+esc(c.content||'')+'</div>'+
          '<div class="adm-msg-toggle" id="'+eid+'" onclick="event.stopPropagation();toggleAdminChunkExpand(&quot;'+cardId.replace(/"/g,'&amp;quot;')+'&quot;,'+i+')">'+t('tasks.expand')+'</div></div></div>';
      }).join('')+'</div></div>';
  }else{
    chunksHtml='<div class="admin-card-detail-section"><div class="detail-label">'+t('tasks.chunks')+'</div><div style="color:var(--text-muted);font-size:13px;padding:8px 0">'+t('tasks.nochunks')+'</div></div>';
  }
  detail.innerHTML=metaHtml+summaryHtml+chunksHtml;
  if(task.chunks&&task.chunks.length>0) setTimeout(function(){initAdminChunkExpanders(cardId,task.chunks.length)},50);
}
function toggleAdminChunkExpand(cardId,i){
  var safeId=cardId.replace(/[^a-zA-Z0-9_-]/g,'_');
  var b=document.getElementById('admchunk_b_'+safeId+'_'+i);
  var e=document.getElementById('admchunk_e_'+safeId+'_'+i);
  if(!b||!e)return;
  if(b.classList.contains('collapsed')){b.classList.remove('collapsed');e.textContent=t('tasks.collapse');}
  else{b.classList.add('collapsed');e.textContent=t('tasks.expand');}
}
function initAdminChunkExpanders(cardId,count){
  var safeId=cardId.replace(/[^a-zA-Z0-9_-]/g,'_');
  for(var i=0;i<count;i++){
    var b=document.getElementById('admchunk_b_'+safeId+'_'+i);
    var e=document.getElementById('admchunk_e_'+safeId+'_'+i);
    if(b&&b.scrollHeight>b.clientHeight+4&&e)e.style.display='block';
    else if(b)b.classList.remove('collapsed');
  }
}

async function toggleAdminSkillCard(cardId,idx){
  var card=document.getElementById(cardId);
  if(!card) return;
  var detail=document.getElementById(cardId+'_detail');
  var btn=card.querySelector('.admin-card-expand-btn');
  if(card.classList.contains('expanded')){
    card.classList.remove('expanded');
    if(btn) btn.textContent=t('admin.expand');
    return;
  }
  card.classList.add('expanded');
  if(btn) btn.textContent=t('admin.collapse');
  if(detail.getAttribute('data-loaded')) return;
  detail.setAttribute('data-loaded','1');
  var sk=(adminSkillsCache||[])[idx];
  if(!sk){detail.innerHTML='<div style="color:var(--text-muted);font-size:13px">'+t('admin.noContent')+'</div>';return;}
  detail.innerHTML='<div class="spinner"></div>';
  var localSkillId=sk.sourceSkillId||sk.id;
  var hubSkillId=sk.id;
  var localData=null;
  try{
    var lr=await fetch('/api/skill/'+encodeURIComponent(localSkillId));
    if(lr.ok) localData=await lr.json();
  }catch(e){}
  if(!localData){
    try{
      var hr=await fetch('/api/admin/shared-skills/'+encodeURIComponent(hubSkillId)+'/detail');
      if(hr.ok) localData=await hr.json();
    }catch(e2){}
  }
  var localSkill=localData&&localData.skill?localData.skill:sk;
  var files=localData&&localData.files?localData.files:[];
  var versions=localData&&localData.versions?localData.versions:[];
  var qs=localSkill.qualityScore!=null?localSkill.qualityScore:sk.qualityScore;
  var metaHtml='<div class="admin-card-detail-meta">'+
    (localSkill.version!=null?'<span class="meta-item"><span class="skill-badge version">v'+localSkill.version+'</span></span>':'')+
    (localSkill.status?'<span class="meta-item"><span class="skill-badge status-'+localSkill.status+'">'+esc(localSkill.status)+'</span></span>':'')+
    (sk.visibility?'<span class="meta-item">'+t('admin.visibility')+esc(sk.visibility||'hub')+'</span>':'')+
    (qs!=null?'<span class="meta-item"><span class="skill-badge quality '+(qs>=7?'high':qs>=5?'mid':'low')+'">\u2605 '+Number(qs).toFixed(1)+'/10</span></span>':'')+
    '<span class="meta-item">'+t('admin.owner')+fmtOwner(sk)+'</span>'+
    (sk.groupName?'<span class="meta-item">'+t('admin.group')+esc(sk.groupName)+'</span>':'')+
    '<span class="meta-item">'+t('admin.updated')+new Date(sk.updatedAt||sk.createdAt||0).toLocaleString(dateLoc())+'</span>'+
  '</div>';
  var descHtml=(localSkill.description||sk.description)?'<div class="admin-card-detail-section"><div class="detail-label">'+t('admin.description')+'</div><div style="font-size:13px;color:var(--text);line-height:1.6">'+esc(localSkill.description||sk.description)+'</div></div>':'';
  var filesHtml='';
  if(files.length>0){
    var fileIcons={'skill':'\u{1F4D6}','script':'\u{2699}','reference':'\u{1F4CE}','file':'\u{1F4C4}'};
    filesHtml='<div class="admin-card-detail-section"><div class="detail-label" style="display:flex;align-items:center;justify-content:space-between">'+t('skills.files')+
      '<button class="btn btn-sm btn-ghost" onclick="event.stopPropagation();window.open(\\x27/api/skill/'+encodeURIComponent(localSkillId)+'/download\\x27,\\x27_blank\\x27)" style="font-size:11px">'+t('skills.download')+'</button>'+
      '</div><div class="skill-files-list">'+
      files.map(function(f){return '<div class="skill-file-item">'+
        '<span class="skill-file-icon">'+(fileIcons[f.type]||'\u{1F4C4}')+'</span>'+
        '<span class="skill-file-name">'+esc(f.path)+'</span>'+
        '<span class="skill-file-type">'+f.type+'</span>'+
        '<span class="skill-file-size">'+(f.size>1024?(f.size/1024).toFixed(1)+'KB':f.size+'B')+'</span>'+
      '</div>';}).join('')+
    '</div></div>';
  }
  var contentHtml='';
  if(versions.length>0&&versions[0].content){
    contentHtml='<div class="admin-card-detail-section"><div class="detail-label">SKILL.md (v'+versions[0].version+')</div><div class="admin-card-detail-content">'+renderSkillMarkdown(versions[0].content)+'</div></div>';
  }else if(localSkill.content||sk.content){
    contentHtml='<div class="admin-card-detail-section"><div class="detail-label">'+t('admin.contentLabel')+'</div><div class="admin-card-detail-content"><pre style="margin:0;white-space:pre-wrap">'+esc(localSkill.content||sk.content)+'</pre></div></div>';
  }
  detail.innerHTML=metaHtml+descHtml+filesHtml+contentHtml;
  if(!descHtml&&!filesHtml&&!contentHtml){
    detail.innerHTML+=('<div style="color:var(--text-muted);font-size:13px;padding:8px 0">'+t('admin.noContent')+'</div>');
  }
}

async function adminDeleteMemory(memoryId,memoryTitle){
  if(!(await confirmModal(t('confirm.removeMemory').replace('{name}',memoryTitle),{danger:true}))) return;
  try{
    var r=await fetch('/api/admin/shared-memories/'+encodeURIComponent(memoryId),{method:'DELETE'});
    var d=await r.json();
    if(d.ok){toast(t('toast.memoryRemoved'),'success');loadAdminData();}else{toast(d.error||t('toast.removeFail'),'error');}
  }catch(e){toast(t('toast.removeFail')+': '+e.message,'error');}
}

function renderSharingMemorySearchResults(data,query){
  const list=document.getElementById('memoryList');
  const localHits=(data&&data.local&&Array.isArray(data.local.hits))?data.local.hits:[];
  const hubHits=(data&&data.hub&&Array.isArray(data.hub.hits))?data.hub.hits:[];
  setPageSizeVisible('memoryPageSize',(localHits.length+hubHits.length)>0);
  document.getElementById('searchMeta').textContent='Search results for "'+query+'"';
  document.getElementById('sharingSearchMeta').textContent=t('scope.local')+' '+localHits.length+' · '+t('scope.hub')+' '+hubHits.length;
  document.getElementById('pagination').innerHTML='';
  list.innerHTML=''+
    '<div class="result-section">'+
      '<div class="result-section-header"><div class="result-section-title">'+t('search.localResults')+'</div><div class="result-section-sub">'+localHits.length+' hit(s)</div></div>'+
      '<div class="search-hit-list">'+(localHits.length?localHits.map(function(hit,idx){
        var agentName='';if(hit.owner){var ap=(hit.owner||'').split(':');agentName=ap.length>=3?ap[ap.length-1]:(ap.length>=2?ap[1]:hit.owner);}
        return '<div class="search-hit-card">'+
          '<div class="summary">'+(idx+1)+'. '+esc(hit.summary||'(no summary)')+'</div>'+
          '<div class="excerpt">'+esc(hit.excerpt||'')+'</div>'+
          '<div class="search-hit-meta">'+
            '<span class="meta-chip">role: '+esc(hit.role||'unknown')+'</span>'+
            (agentName?'<span class="meta-chip" style="background:rgba(20,184,166,.12);color:#14b8a6">'+esc(agentName)+'</span>':'')+
            (hit.score!=null?'<span class="meta-chip">score: '+Math.round(hit.score*100)+'%</span>':'')+
            (hit.taskId?'<span class="meta-chip">task: '+esc(hit.taskId)+'</span>':'')+
          '</div>'+
        '</div>';
      }).join(''):'<div class="search-hit-card"><div class="excerpt">'+t('search.noLocal')+'</div></div>')+'</div>'+
    '</div>'+
    '<div class="result-section">'+
      '<div class="result-section-header"><div class="result-section-title">'+t('search.hubResults')+'</div><div class="result-section-sub">'+hubHits.length+' hit(s)</div></div>'+
      '<div class="search-hit-list">'+(hubHits.length?hubHits.map(function(hit,idx){
        var hubAgentName='';if(hit.sourceAgent){var hap=(hit.sourceAgent||'').split(':');hubAgentName=hap.length>=3?hap[hap.length-1]:(hap.length>=2?hap[1]:hit.sourceAgent);}
        return '<div class="hub-hit-card">'+
          '<div class="summary">'+(idx+1)+'. '+esc(hit.summary||'(no summary)')+'</div>'+
          '<div class="excerpt">'+esc(hit.excerpt||'')+'</div>'+
          '<div class="hub-hit-meta">'+
            '<span class="meta-chip">owner: '+fmtOwner(hit)+'</span>'+
            (hubAgentName?'<span class="meta-chip" style="background:rgba(20,184,166,.12);color:#14b8a6">'+esc(hubAgentName)+'</span>':'')+
            (hit.groupName?'<span class="meta-chip">group: '+esc(hit.groupName)+'</span>':'')+
            '<span class="meta-chip">visibility: '+esc(hit.visibility||'hub')+'</span>'+
          '</div>'+
          '<div class="hub-hit-actions">'+
            '<button class="btn btn-sm" onclick="openSharedMemoryDetail(&quot;'+escAttr(hit.remoteHitId)+'&quot;,&quot;'+escAttr(hit.summary||t('search.sharedMemory'))+'&quot;,&quot;'+escAttr(hit.ownerName||'')+'&quot;,&quot;'+escAttr(hit.groupName||'')+'&quot;)">'+t('search.viewDetail')+'</button>'+
          '</div>'+
        '</div>';
      }).join(''):'<div class="hub-hit-card"><div class="excerpt">'+t('search.noHub')+'</div></div>')+'</div>'+
    '</div>';
}

async function openSharedMemoryDetail(remoteHitId,title,owner,groupName){
  currentSharedMemoryHitId=remoteHitId;
  document.getElementById('sharedMemoryOverlay').classList.add('show');
  document.getElementById('sharedMemoryTitle').textContent=title||t('search.sharedMemory');
  document.getElementById('sharedMemoryMeta').innerHTML='<span class="meta-item">'+t('scope.hub')+'</span>'+(owner?'<span class="meta-item">'+t('admin.owner')+esc(owner)+'</span>':'')+(groupName?'<span class="meta-item">'+t('admin.group')+esc(groupName)+'</span>':'');
  document.getElementById('sharedMemorySummary').textContent=t('sharing.loading');
  document.getElementById('sharedMemoryContent').textContent='';
  try{
    const r=await fetch('/api/sharing/memory-detail',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({remoteHitId:remoteHitId})});
    const d=await r.json();
    if(d.error) throw new Error(d.error);
    document.getElementById('sharedMemorySummary').textContent=d.summary||'';
    document.getElementById('sharedMemoryContent').textContent=d.content||'';
  }catch(e){
    document.getElementById('sharedMemorySummary').textContent=t('search.loadFailed');
    document.getElementById('sharedMemoryContent').textContent=String(e.message||e);
  }
}

function closeSharedMemoryDetail(event){
  if(event && event.target!==document.getElementById('sharedMemoryOverlay')) return;
  document.getElementById('sharedMemoryOverlay').classList.remove('show');
}

async function openHubMemoryDetail(cacheKey,idx){
  var arr=cacheKey==='admin'?adminMemoriesCache:hubMemoriesCache;
  var m=arr[idx];
  if(!m) return;
  var overlay=document.getElementById('sharedMemoryOverlay');
  overlay.classList.add('show');
  var titleText=m.summary||m.content?.slice(0,80)||'(no summary)';
  document.getElementById('sharedMemoryTitle').textContent=titleText;
  var metaHtml='<span class="meta-item">\\u{1F310} '+t('scope.hub')+'</span>'+
    (m.ownerName?'<span class="meta-item">'+t('admin.owner')+esc(m.ownerName)+'</span>':'')+
    (m.groupName?'<span class="meta-item">'+t('admin.group')+esc(m.groupName)+'</span>':'')+
    (m.kind?'<span class="meta-item">'+t('admin.kind')+esc(m.kind)+'</span>':'')+
    (m.role?'<span class="meta-item">'+t('admin.role')+esc(m.role)+'</span>':'')+
    (m.visibility?'<span class="meta-item">'+t('admin.visibility')+esc(m.visibility)+'</span>':'')+
    '<span class="meta-item">'+new Date(m.updatedAt||m.createdAt||0).toLocaleString(dateLoc())+'</span>';
  document.getElementById('sharedMemoryMeta').innerHTML=metaHtml;
  document.getElementById('sharedMemorySummary').textContent=m.summary||'';
  var hasContent=m.content&&m.content.length>0;
  document.getElementById('sharedMemoryContent').textContent=hasContent?m.content:t('sharing.loading');
  var remoteId=m.remoteHitId||m.id;
  if(remoteId){
    try{
      var r=await fetch('/api/sharing/memory-detail',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({remoteHitId:remoteId})});
      var d=await r.json();
      if(!d.error&&(d.content||d.summary)){
        if(d.summary) document.getElementById('sharedMemorySummary').textContent=d.summary;
        document.getElementById('sharedMemoryContent').textContent=d.content||m.content||'';
      }else if(!hasContent){
        document.getElementById('sharedMemoryContent').textContent=m.content||t('memory.detail.notFound');
      }
    }catch(e){
      if(!hasContent) document.getElementById('sharedMemoryContent').textContent=m.content||t('memory.detail.notFound');
    }
  }else if(!hasContent){
    document.getElementById('sharedMemoryContent').textContent=t('memory.detail.notFound');
  }
}

function openHubTaskDetailFromCache(cacheKey,idx){
  var arr=cacheKey==='admin'?adminTasksCache:hubTasksCache;
  var task=arr[idx];
  if(!task) return;
  var overlay=document.getElementById('taskDetailOverlay');
  overlay.classList.add('show');
  document.getElementById('taskDetailTitle').textContent=task.title||'(no title)';
  document.getElementById('taskShareActions').innerHTML='';
  var meta=[
    '<span class="meta-item">\\u{1F310} '+t('scope.hub')+'</span>',
    task.status?'<span class="meta-item"><span class="task-status-badge '+task.status+'">'+esc(task.status)+'</span></span>':'',
    '<span class="meta-item">'+t('admin.owner')+fmtOwner(task)+'</span>',
    task.groupName?'<span class="meta-item">'+t('admin.group')+esc(task.groupName)+'</span>':'',
    task.visibility?'<span class="meta-item">'+t('admin.visibility')+esc(task.visibility)+'</span>':'',
    task.chunkCount!=null?'<span class="meta-item">\\u{1F4DD} '+esc(String(task.chunkCount))+' '+t('tasks.chunks.label')+'</span>':'',
    task.startedAt?'<span class="meta-item">\\u{1F4C5} '+formatTime(task.startedAt)+'</span>':'',
    task.endedAt?'<span class="meta-item">\\u2192 '+formatTime(task.endedAt)+'</span>':'',
    (task.updatedAt||task.createdAt)?'<span class="meta-item">'+t('admin.updated')+new Date(task.updatedAt||task.createdAt).toLocaleString(dateLoc())+'</span>':'',
    task.sourceTaskId?'<div style="width:100%;margin-top:4px"><span class="meta-item" style="width:100%">'+t('tasks.taskid')+'<span class="task-id-full">'+esc(task.sourceTaskId)+'</span></span></div>':'',
  ].filter(Boolean);
  document.getElementById('taskDetailMeta').innerHTML=meta.join('');
  document.getElementById('taskSkillSection').innerHTML='';
  document.getElementById('taskSkillSection').className='task-skill-section';
  document.getElementById('taskDetailSummary').innerHTML=task.summary?renderSummaryHtml(task.summary):'<div style="color:var(--text-muted);font-size:13px">'+t('tasks.nochunks')+'</div>';
  document.getElementById('taskDetailChunks').innerHTML='<div style="color:var(--text-muted);padding:12px;font-size:13px">'+t('tasks.nochunks')+'</div>';
}

function openHubSkillDetailFromCache(cacheKey,idx){
  var arr=cacheKey==='admin'?adminSkillsCache:hubSkillsCache;
  var skill=arr[idx];
  if(!skill) return;
  var overlay=document.getElementById('skillDetailOverlay');
  overlay.classList.add('show');
  document.getElementById('skillDetailTitle').textContent='\\u{1F9E0} '+(skill.name||'(no name)');
  var qs=skill.qualityScore;
  var qsBadge=(qs!==null&&qs!==undefined)?'<span class="meta-item"><span class="skill-badge quality '+(qs>=7?'high':qs>=5?'mid':'low')+'">\\u2605 '+(+qs).toFixed(1)+'/10</span></span>':'';
  var meta=[
    '<span class="meta-item">\\u{1F310} '+t('scope.hub')+'</span>',
    skill.version!=null?'<span class="meta-item"><span class="skill-badge version">v'+skill.version+'</span></span>':'',
    skill.status?'<span class="meta-item"><span class="skill-badge status-'+skill.status+'">'+esc(skill.status)+'</span></span>':'',
    '<span class="meta-item">visibility: '+esc(skill.visibility||'hub')+'</span>',
    qsBadge,
    '<span class="meta-item">'+t('admin.owner')+fmtOwner(skill)+'</span>',
    skill.groupName?'<span class="meta-item">'+t('admin.group')+esc(skill.groupName)+'</span>':'',
    (skill.updatedAt||skill.createdAt)?'<span class="meta-item">'+t('admin.updated')+new Date(skill.updatedAt||skill.createdAt).toLocaleString(dateLoc())+'</span>':'',
  ].filter(Boolean);
  document.getElementById('skillDetailMeta').innerHTML=meta.join('');
  document.getElementById('skillDetailDesc').textContent=skill.description||'';
  document.getElementById('skillFilesList').innerHTML='';
  document.getElementById('skillDetailContent').innerHTML=skill.content?renderSkillMarkdown(skill.content):('<span style="color:var(--text-muted);font-size:13px;line-height:1.6">'+t('skills.hub.markdownPending')+'</span>');
  document.getElementById('skillVersionsList').innerHTML='';
  document.getElementById('skillRelatedTasks').innerHTML='';
  var visBtn=document.getElementById('skillVisibilityBtn');
  if(visBtn) visBtn.style.display='none';
  var dlBtn=document.getElementById('skillDownloadBtn');
  if(dlBtn) dlBtn.style.display='none';
  var scopeBadge=document.getElementById('skillScopeBadge');
  if(scopeBadge) scopeBadge.innerHTML='';
}

function escAttr(s){return String(s||'').replace(/&/g,'&amp;').replace(/'/g,'&#39;').replace(/"/g,'&quot;').replace(/</g,'&lt;').replace(/>/g,'&gt;');}

function fmtAgentName(owner){
  if(!owner||owner==='public') return '';
  var s=String(owner);
  if(s.startsWith('agent:')) s=s.slice(6);
  return s;
}

function fmtSessionDisplay(sid){
  if(!sid) return '';
  if(sid.startsWith('agent:')){
    var parts=sid.split(':');
    // agent:{agentId}:import → "📥 import"
    if(parts.length===3 && parts[2]==='import') return '\\u{1F4E5} import';
    // agent:{agentId}:{sessionKey} (exactly 3 segments) → show agent:{agentId} only (UI label; DB keeps full key)
    if(parts.length===3) return 'agent:'+parts[1];
    // agent:{agentId}:session:{sessionId} → badge shows agent:{agentId} only; full key stays in data-session-key for copy
    if(parts.length>=4 && parts[2]==='session'){
      return 'agent:'+parts[1];
    }
    // agent:{agentId}:... (5+ segments, e.g. IM: discord/slack channel peer id) → agent:{agentId} only
    if(parts.length>=5) return 'agent:'+parts[1];
    // agent:{agentId}:{other} → show from second part (e.g. "work:main")
    return parts.slice(1).join(':');
  }
  // Legacy formats
  if(sid.startsWith('openclaw-import-')) return '\\u{1F4E5} '+sid.slice(16);
  if(sid.startsWith('openclaw-session-')){
    var id=sid.slice(17);
    return id.length>12?id.slice(0,6)+'..'+id.slice(-4):id;
  }
  if(sid.length>20) return sid.slice(0,8)+'..'+sid.slice(-6);
  return sid;
}

function copySessionKeyFromEl(el){
  var k=el&&el.getAttribute('data-session-key');
  if(!k) return;
  navigator.clipboard.writeText(k).then(function(){
    toast(t('copy.done'),'success');
  }).catch(function(){
    toast('Copy failed','error');
  });
}

function isImportedSession(sid){
  if(!sid) return false;
  return sid.startsWith('openclaw-import-')||sid.startsWith('openclaw-session-')||/^agent:[^:]+:(import|session:)/.test(sid);
}

/* ─── Unified Sharing Scope Selector ─── */

function getScopeLabel(scope){
  if(scope==='team') return t('share.scope.team');
  if(scope==='local') return t('share.scope.local');
  return t('share.scope.private');
}
function getScopeIcon(scope){
  if(scope==='team') return '\\u{1F310}';
  if(scope==='local') return '\\u{1F465}';
  return '\\u{1F512}';
}
function getScopeColor(scope){
  if(scope==='team') return '#22c55e';
  if(scope==='local') return '#3b82f6';
  return '#f59e0b';
}

function renderScopeBadge(scope){
  var color=getScopeColor(scope);
  var icon=getScopeIcon(scope);
  var label=getScopeLabel(scope);
  if(scope==='private') return '<span style="display:inline-flex;align-items:center;gap:3px;padding:2px 8px;background:'+color+'14;border:1px solid '+color+'33;border-radius:10px;font-size:11px;color:'+color+'">'+icon+' '+label+'</span>';
  return '<span style="display:inline-flex;align-items:center;gap:3px;padding:2px 8px;background:'+color+'18;border:1px solid '+color+'44;border-radius:10px;font-size:11px;color:'+color+'">'+icon+' '+label+'</span>';
}

function openScopeSelectorModal(resourceType, resourceId, currentScope, onConfirm){
  var existing=document.getElementById('scopeSelectorOverlay');
  if(existing) existing.remove();
  var teamEnabled=sharingStatusCache&&sharingStatusCache.enabled;
  var teamConnected=teamEnabled&&sharingStatusCache.connection&&sharingStatusCache.connection.connected;
  var overlay=document.createElement('div');
  overlay.id='scopeSelectorOverlay';
  overlay.style.cssText='position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.5);backdrop-filter:blur(6px);z-index:10000;display:flex;align-items:center;justify-content:center;animation:fadeIn 0.12s ease';
  var scopeDescs={private:'',local:'',team:t('share.scope.teamIncludes')};
  var scopes=['private','local','team'];
  var h='<div style="background:var(--bg-card);border:1px solid var(--border-glow);border-radius:12px;padding:0;width:340px;box-shadow:0 16px 48px rgba(0,0,0,0.35);overflow:hidden">';
  h+='<div style="padding:14px 18px 10px;border-bottom:1px solid var(--border)">';
  h+='<div style="font-size:14px;font-weight:600;color:var(--text)">'+t('share.scope.title')+'</div>';
  h+='</div>';
  h+='<div style="padding:6px 8px">';
  for(var i=0;i<scopes.length;i++){
    var sc=scopes[i];
    var isCurrent=sc===currentScope;
    var isDisabled=sc==='team'&&(!teamEnabled||!teamConnected);
    var color=getScopeColor(sc);
    var cursor=isDisabled?'not-allowed':'pointer';
    var opacity=isDisabled?'0.4':'1';
    var selBg=isCurrent?color+'16':'transparent';
    var selBorder=isCurrent?'2px solid '+color+'55':'2px solid transparent';
    h+='<div class="scope-option'+(isCurrent?' selected':'')+'" data-scope="'+sc+'" data-color="'+color+'" style="display:flex;align-items:center;gap:12px;padding:10px 12px;margin:3px 0;border:'+selBorder+';border-radius:10px;background:'+selBg+';cursor:'+cursor+';opacity:'+opacity+';transition:all 0.12s ease"';
    if(!isDisabled) h+=' onclick="selectScopeOption(this,\\''+sc+'\\')"';
    h+='>';
    h+='<div style="width:34px;height:34px;border-radius:9px;background:'+color+'22;display:flex;align-items:center;justify-content:center;font-size:17px;flex-shrink:0">'+getScopeIcon(sc)+'</div>';
    h+='<div style="flex:1;min-width:0">';
    h+='<div style="font-size:13px;font-weight:600;color:var(--text);display:flex;align-items:center;gap:6px">'+getScopeLabel(sc);
    if(isCurrent) h+='<span style="font-size:10px;font-weight:600;color:#fff;background:'+color+';padding:1px 7px;border-radius:4px">'+t('share.scope.current')+'</span>';
    h+='</div>';
    var desc=isDisabled?t('share.scope.teamDisabled'):(scopeDescs[sc]||'');
    if(desc) h+='<div style="font-size:11px;color:var(--text-sec);margin-top:2px;line-height:1.3">'+desc+'</div>';
    h+='</div></div>';
  }
  h+='</div>';
  h+='<div style="padding:8px 14px 12px;border-top:1px solid var(--border);display:flex;gap:8px;justify-content:flex-end">';
  h+='<button class="btn btn-sm btn-ghost" onclick="closeScopeSelectorModal()" style="font-size:13px">'+t('share.scope.cancel')+'</button>';
  h+='<button class="btn btn-sm" id="scopeConfirmBtn" onclick="confirmScopeSelection()" disabled style="font-size:13px;min-width:56px">'+t('share.scope.confirm')+'</button>';
  h+='</div></div>';
  overlay.innerHTML=h;
  overlay.addEventListener('click',function(e){if(e.target===overlay)closeScopeSelectorModal();});
  document.body.appendChild(overlay);
  window._scopeSelectionState={resourceType:resourceType,resourceId:resourceId,currentScope:currentScope,selectedScope:currentScope,onConfirm:onConfirm};
}
function selectScopeOption(el,scope){
  if(!window._scopeSelectionState)return;
  var overlay=document.getElementById('scopeSelectorOverlay');
  if(!overlay)return;
  var color=getScopeColor(scope);
  var options=overlay.querySelectorAll('.scope-option');
  options.forEach(function(opt){opt.classList.remove('selected');opt.style.border='2px solid transparent';opt.style.background='transparent';});
  el.classList.add('selected');
  el.style.border='2px solid '+color+'55';
  el.style.background=color+'16';
  window._scopeSelectionState.selectedScope=scope;
  document.getElementById('scopeConfirmBtn').disabled=(scope===window._scopeSelectionState.currentScope);
}
function closeScopeSelectorModal(){
  var overlay=document.getElementById('scopeSelectorOverlay');
  if(overlay) overlay.remove();
  window._scopeSelectionState=null;
}
async function confirmScopeSelection(){
  if(!window._scopeSelectionState)return;
  var st=Object.assign({},window._scopeSelectionState);
  var newScope=st.selectedScope;
  var oldScope=st.currentScope;
  if(newScope===oldScope){closeScopeSelectorModal();return;}
  closeScopeSelectorModal();
  var shrinking=(oldScope==='team'&&newScope!=='team')||(oldScope==='local'&&newScope==='private');
  if(shrinking){
    var msg=oldScope==='team'&&newScope==='local'?t('share.scope.shrinkToLocal'):
            oldScope==='team'&&newScope==='private'?t('share.scope.shrinkToPrivate'):
            t('share.scope.shrinkLocalToPrivate');
    if(!(await confirmModal(msg,{danger:true})))return;
  }
  try{
    var url='/api/'+st.resourceType+'/'+st.resourceId+'/scope';
    var r=await fetch(url,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({scope:newScope})});
    var d=await r.json();
    if(d.ok){
      toast(t('share.scope.changed'),'success');
      if(st.onConfirm) st.onConfirm(newScope);
      else loadAll();
    }else{
      var errMsg=d.error==='inactive_memory'?t('share.scope.inactiveDisabled'):(d.message||d.error||t('share.scope.changeFail'));
      toast(errMsg,'error');
    }
  }catch(e){toast(t('share.scope.changeFail')+': '+e.message,'error');}
}

function renderTaskShareActions(task){
  currentTaskDetail=task||null;
  const el=document.getElementById('taskShareActions');
  if(!el){return;}
  if(!task||!task.id){el.innerHTML='';return;}
  var isLocalShared=task.owner==='public';
  var isTeamShared=!!(task.sharingVisibility||task.hubTaskId);
  var currentScope=isTeamShared?'team':isLocalShared?'local':'private';
  if(task.status==='completed'){
    el.innerHTML=renderScopeBadge(currentScope)+
      '<button class="btn btn-sm btn-ghost" onclick="openTaskScopeModal()">\u270F '+t('share.shareBtn')+'</button>';
  }else{
    el.innerHTML=renderScopeBadge(currentScope)+
      '<button class="btn btn-sm btn-ghost" style="opacity:0.45;cursor:not-allowed" onclick="toast(t(\\x27share.scope.taskNotCompleted\\x27),\\x27warn\\x27)">\u270F '+t('share.shareBtn')+'</button>';
  }
}
function openTaskScopeModal(){
  if(!currentTaskDetail) return;
  var task=currentTaskDetail;
  var isLocalShared=task.owner==='public';
  var isTeamShared=!!(task.sharingVisibility||task.hubTaskId);
  var cs=isTeamShared?'team':isLocalShared?'local':'private';
  openScopeSelectorModal('task',task.id,cs,function(s){
    if(s==='team'){task.sharingVisibility='public';task.hubTaskId=true;}
    else if(s==='local'){task.sharingVisibility=null;task.hubTaskId=false;task.owner='public';}
    else{task.sharingVisibility=null;task.hubTaskId=false;task.owner=task._origOwner||'agent:main';}
    renderTaskShareActions(task);
    updateTaskCardBadge(task.id,s);
  });
}
function openTaskScopeModalFromList(taskId,currentScope){
  openScopeSelectorModal('task',taskId,currentScope,function(s){
    updateTaskCardBadge(taskId,s);
  });
}

async function shareCurrentTask(){
  if(!currentTaskDetail) return;
  const visibility='public';
  try{
    const r=await fetch('/api/sharing/tasks/share',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({taskId:currentTaskDetail.id,visibility:visibility})});
    const d=await r.json();
    if(d.ok||d.shared){toast(t('toast.taskShared'),'success');currentTaskDetail.sharingVisibility=visibility;currentTaskDetail.hubTaskId=true;renderTaskShareActions(currentTaskDetail);} else {toast(d.error||t('toast.taskShareFail'),'error');}
  }catch(e){toast(t('toast.taskShareFail')+': '+e.message,'error');}
}

async function unshareCurrentTask(){
  if(!currentTaskDetail) return;
  try{
    const r=await fetch('/api/sharing/tasks/unshare',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({taskId:currentTaskDetail.id})});
    const d=await r.json();
    if(d.ok||d.unshared){toast(t('toast.taskUnshared'),'success');currentTaskDetail.sharingVisibility=null;currentTaskDetail.hubTaskId=false;renderTaskShareActions(currentTaskDetail);} else {toast(d.error||t('toast.taskUnshareFail'),'error');}
  }catch(e){toast(t('toast.taskUnshareFail')+': '+e.message,'error');}
}

function renderSkillShareActions(skill){
  var el=document.getElementById('skillScopeBadge');
  if(!el){return;}
  if(!skill||!skill.id){el.innerHTML='';return;}
  var isLocalShared=skill.visibility==='public';
  var isTeamShared=!!(skill.sharingVisibility);
  var currentScope=isTeamShared?'team':isLocalShared?'local':'private';
  el.innerHTML=renderScopeBadge(currentScope);
}
function openSkillScopeModal(){
  if(!currentSkillDetail) return;
  if(currentSkillDetail.status!=='active'){
    toast(t('share.scope.skillNotActive'),'warn');
    return;
  }
  var skill=currentSkillDetail;
  var isLocalShared=skill.visibility==='public';
  var isTeamShared=!!skill.sharingVisibility;
  var cs=isTeamShared?'team':isLocalShared?'local':'private';
  openScopeSelectorModal('skill',skill.id,cs,function(s){
    if(s==='team'){skill.sharingVisibility='public';}
    else if(s==='local'){skill.sharingVisibility=null;skill.visibility='public';}
    else{skill.sharingVisibility=null;skill.visibility='private';}
    renderSkillShareActions(skill);
    var scopeBadgeEl=document.getElementById('skillScopeBadge');
    if(scopeBadgeEl) scopeBadgeEl.innerHTML=renderScopeBadge(s);
    updateSkillCardBadge(skill.id,s);
  });
}
function openSkillScopeModalFromList(skillId,currentScope){
  openScopeSelectorModal('skill',skillId,currentScope,function(s){
    updateSkillCardBadge(skillId,s);
  });
}

async function shareCurrentSkill(){
  if(!currentSkillDetail) return;
  const visibility='public';
  try{
    const r=await fetch('/api/sharing/skills/share',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({skillId:currentSkillDetail.id,visibility:visibility})});
    const d=await r.json();
    if(d.ok){toast(t('toast.skillShared'),'success');currentSkillDetail.sharingVisibility=visibility;renderSkillShareActions(currentSkillDetail);} else {toast(d.error||t('toast.skillShareFail'),'error');}
  }catch(e){toast(t('toast.skillShareFail')+': '+e.message,'error');}
}

async function unshareCurrentSkill(){
  if(!currentSkillDetail) return;
  try{
    const r=await fetch('/api/sharing/skills/unshare',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({skillId:currentSkillDetail.id})});
    const d=await r.json();
    if(d.ok){toast(t('toast.skillUnshared'),'success');currentSkillDetail.sharingVisibility=null;renderSkillShareActions(currentSkillDetail);} else {toast(d.error||t('toast.skillUnshareFail'),'error');}
  }catch(e){toast(t('toast.skillUnshareFail')+': '+e.message,'error');}
}

async function shareMemoryPrompt(chunkId){
  try{
    const r=await fetch('/api/sharing/memories/share',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({chunkId:chunkId,visibility:'public'})});
    const d=await r.json();
    if(d.ok){
      toast(t('toast.memoryShared'),'success');
      if(memoryCache[chunkId]){memoryCache[chunkId].sharingVisibility='public';}
      updateMemoryCardBadge(chunkId,'team');
    } else {toast(d.error||t('toast.memoryShareFail'),'error');}
  }catch(e){toast(t('toast.memoryShareFail')+': '+e.message,'error');}
}

async function unshareMemory(chunkId){
  if(!(await confirmModal(t('share.memoryUnshareConfirm'),{danger:true}))) return;
  try{
    const r=await fetch('/api/sharing/memories/unshare',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({chunkId:chunkId})});
    const d=await r.json();
    if(d.ok){
      toast(t('toast.memoryUnshared'),'success');
      if(memoryCache[chunkId]){memoryCache[chunkId].sharingVisibility=null;}
      var m=memoryCache[chunkId];
      var newScope=(m&&m.owner==='public')?'local':'private';
      updateMemoryCardBadge(chunkId,newScope);
    } else {toast(d.error||t('toast.memoryUnshareFail'),'error');}
  }catch(e){toast(t('toast.memoryUnshareFail')+': '+e.message,'error');}
}

function localMemoryErrorMessage(err){
  if(err==='original_owner_missing') return t('share.local.originalOwnerMissing');
  return err||t('toast.opfail');
}

function debounceSkillSearch(){
  clearTimeout(skillSearchTimer);
  skillsPage=0;
  skillSearchTimer=setTimeout(function(){loadSkills();},300);
}

async function pullHubSkill(skillId){
  try{
    const r=await fetch('/api/sharing/skills/pull',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({skillId:skillId})});
    const d=await r.json();
    if(d.ok||d.pulled||d.details){toast(t('toast.skillPulled'),'success');loadSkills();} else {toast(d.error||t('toast.skillPullFail'),'error');}
  }catch(e){toast(t('toast.skillPullFail')+': '+e.message,'error');}
}

// ─── Logs ───
let logAutoTimer=null;
let logPage=1;
const LOG_PAGE_SIZE=20;
async function loadLogs(page){
  if(typeof page==='number') logPage=page;
  try{
    const toolFilter=document.getElementById('logToolFilter').value;
    const offset=(logPage-1)*LOG_PAGE_SIZE;
    const url='/api/logs?limit='+LOG_PAGE_SIZE+'&offset='+offset+(toolFilter?'&tool='+encodeURIComponent(toolFilter):'');
    const [logsRes,toolsRes]=await Promise.all([fetch(url),fetch('/api/log-tools')]);
    if(!logsRes.ok) return;
    const logsData=await logsRes.json();
    const toolsData=await toolsRes.json();
    renderLogToolFilter(toolsData.tools||[],toolFilter);
    renderLogs(logsData.logs||[]);
    renderLogPagination(logsData.page||1,logsData.totalPages||1,logsData.total||0);
    startLogAutoRefresh();
  }catch(e){console.error('loadLogs',e)}
}
function onLogFilterChange(){logPage=1;loadLogs(1);}
function renderLogPagination(page,totalPages,total){
  const el=document.getElementById('logsPagination');
  if(!el||totalPages<=1){if(el)el.innerHTML='';return;}
  const pages=[];
  const range=2;
  for(let i=1;i<=totalPages;i++){
    if(i===1||i===totalPages||Math.abs(i-page)<=range){
      pages.push(i);
    }else if(pages[pages.length-1]!=='...'){
      pages.push('...');
    }
  }
  let html='<div class="logs-pagination">';
  html+='<button class="btn btn-sm btn-ghost" '+(page<=1?'disabled':'')+' onclick="loadLogs('+(page-1)+')">\u2039</button>';
  pages.forEach(p=>{
    if(p==='...'){html+='<span class="page-ellipsis">\u2026</span>';}
    else{html+='<button class="btn btn-sm '+(p===page?'btn-primary':'btn-ghost')+'" onclick="loadLogs('+p+')">'+p+'</button>';}
  });
  html+='<button class="btn btn-sm btn-ghost" '+(page>=totalPages?'disabled':'')+' onclick="loadLogs('+(page+1)+')">\u203A</button>';
  html+='<span class="page-total">'+total+' total</span>';
  html+='</div>';
  el.innerHTML=html;
}

function renderLogToolFilter(tools,current){
  const sel=document.getElementById('logToolFilter');
  const opts=['<option value="">'+t('logs.allTools')+'</option>'];
  tools.forEach(tn=>{
    opts.push('<option value="'+tn+'"'+(tn===current?' selected':'')+'>'+tn+'</option>');
  });
  sel.innerHTML=opts.join('');
}

function formatLogTime(ts){
  const d=new Date(ts);
  const time=d.toLocaleTimeString(dateLoc(),{hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false});
  const y=d.getFullYear();
  const m=String(d.getMonth()+1).padStart(2,'0');
  const day=String(d.getDate()).padStart(2,'0');
  return y+'-'+m+'-'+day+' '+time;
}

function parseMemoryAddEntries(out){
  var lines=out.split('\\n');
  var results=[];
  for(var i=0;i<lines.length;i++){
    var line=lines[i].trim();
    if(!line) continue;
    if(line.startsWith('{')){
      try{
        var obj=JSON.parse(line);
        if(obj.role&&obj.action){results.push({role:obj.role,action:obj.action,summary:obj.summary||'',content:obj.content||'',reason:obj.reason||''});continue;}
      }catch(e){}
    }
    var rm=line.match(/^\\[(\\w+)\\]\\s*([^\u2192]+)\u2192/);
    if(rm){
      var role=rm[1],actionRaw=rm[2].trim();
      var action='stored';
      if(actionRaw.indexOf('exact-dup')>=0||actionRaw.indexOf('\u23ED')>=0) action='exact-dup';
      else if(actionRaw.indexOf('dedup')>=0||actionRaw.indexOf('\uD83D\uDD01')>=0) action='dedup';
      else if(actionRaw.indexOf('merged')>=0||actionRaw.indexOf('\uD83D\uDD00')>=0) action='merged';
      else if(actionRaw.indexOf('error')>=0||actionRaw.indexOf('\u274C')>=0) action='error';
      var afterArrow=line.replace(/^\\[\\w+\\]\\s*[^\u2192]+\u2192\\s*/,'');
      var contentLines=[afterArrow];
      while(i+1<lines.length&&!lines[i+1].trim().startsWith('[')&&!lines[i+1].trim().startsWith('{')){
        i++;
        if(lines[i].trim()) contentLines.push(lines[i]);
        else contentLines.push('');
      }
      results.push({role:role,action:action,summary:'',content:contentLines.join('\\n'),reason:''});
    }
  }
  return results;
}

function recallOriginBadge(origin){
  if(origin==='local-shared') return '<span class="recall-origin local-shared">'+t('recall.origin.localShared')+'</span>';
  if(origin==='hub-memory') return '<span class="recall-origin hub-memory">'+t('recall.origin.hubMemory')+'</span>';
  if(origin==='hub-remote') return '<span class="recall-origin hub-remote">'+t('recall.origin.hubRemote')+'</span>';
  return '';
}
function agentBadge(owner){
  if(!owner) return '';
  var parts=(owner||'').split(':');
  var name=parts.length>=3?parts[parts.length-1]:(parts.length>=2?parts[1]:owner);
  if(!name) return '';
  return '<span class="recall-origin agent-tag">\u{1F916} '+escapeHtml(name)+'</span>';
}

function buildLogSummary(lg){
  let inputObj=null;
  try{inputObj=JSON.parse(lg.input);}catch(_){}
  let html='';
  const tn=lg.toolName;
  if(tn==='memory_search'&&inputObj){
    const q=inputObj.query||'';
    if(q) html+='<div class="log-summary-query">'+escapeHtml(q)+'</div>';
    var recallData=null;
    try{recallData=JSON.parse(lg.output);}catch(_){}
    if(recallData&&recallData.candidates){
      var cands=recallData.candidates||[];
      var filtered=recallData.filtered||[];
      if(cands.length===0){
        html+='<div style="margin-top:4px;font-size:11px;color:var(--text-sec)">\u2205 '+t('logs.recall.noHits')+'</div>';
      }else{
        html+='<div class="recall-layers">';
        html+='<div class="recall-layer" onclick="this.classList.toggle(\\\'expanded\\\')">';
        html+='<div class="recall-layer-title"><span class="recall-expand-icon">\u25B6</span>\u{1F50D} '+t('logs.recall.initial')+' <span class="recall-count">'+cands.length+'</span></div>';
        html+='<div class="recall-items">';
        cands.forEach(function(c,i){
          var scoreClass=c.score>=0.7?'high':c.score>=0.5?'mid':'low';
          var shortText=escapeHtml(c.summary||c.content||c.original_excerpt||'');
          var fullText=escapeHtml(c.content||c.original_excerpt||c.summary||'');
          var oBadge=recallOriginBadge(c.origin);
          var aBadge2=agentBadge(c.owner);
          html+='<div class="recall-item" onclick="event.stopPropagation();this.classList.toggle(\\\'expanded\\\')">';
          html+='<div class="recall-item-head"><span class="recall-score '+scoreClass+'">'+c.score.toFixed(2)+'</span><span class="log-msg-role '+(c.role||'user')+'">'+(c.role||'user')+'</span>'+oBadge+aBadge2+'<span class="recall-summary-short">'+shortText+'</span><span class="recall-expand-icon">\u25B6</span></div>';
          html+='<div class="recall-summary-full">'+fullText+'</div>';
          html+='</div>';
        });
        html+='</div></div>';
        var hubCands=recallData.hubCandidates||[];
        html+='<div class="recall-layer hub-recall" onclick="this.classList.toggle(\\\'expanded\\\')">';
        html+='<div class="recall-layer-title"><span class="recall-expand-icon">\u25B6</span>\u{1F310} '+t('logs.recall.hubRemote')+' <span class="recall-count">'+hubCands.length+'</span></div>';
        if(hubCands.length>0){
          html+='<div class="recall-items">';
          hubCands.forEach(function(c){
            var scoreClass=c.score>=0.7?'high':c.score>=0.5?'mid':'low';
            var shortText=escapeHtml(c.summary||c.original_excerpt||'');
            var fullText=escapeHtml(c.original_excerpt||c.summary||'');
            var owner=c.ownerName?' ['+escapeHtml(c.ownerName)+']':'';
            var haBadge2=agentBadge(c.sourceAgent||'');
            html+='<div class="recall-item" onclick="event.stopPropagation();this.classList.toggle(\\\'expanded\\\')">';
            html+='<div class="recall-item-head"><span class="recall-score '+scoreClass+'">'+c.score.toFixed(2)+'</span><span class="log-msg-role '+(c.role||'assistant')+'">'+(c.role||'assistant')+'</span><span class="recall-origin hub-remote">'+t('recall.origin.hubRemote')+'</span>'+owner+haBadge2+'<span class="recall-summary-short">'+shortText+'</span><span class="recall-expand-icon">\u25B6</span></div>';
            html+='<div class="recall-summary-full">'+fullText+'</div>';
            html+='</div>';
          });
          html+='</div>';
        }
        html+='</div>';
        if(filtered.length>0){
          html+='<div class="recall-layer filtered" onclick="this.classList.toggle(\\\'expanded\\\')">';
          html+='<div class="recall-layer-title"><span class="recall-expand-icon">\u25B6</span>\u2705 '+t('logs.recall.filtered')+' <span class="recall-count">'+filtered.length+'</span></div>';
          html+='<div class="recall-items">';
          filtered.forEach(function(f){
            var scoreClass=f.score>=0.7?'high':f.score>=0.5?'mid':'low';
            var shortText=escapeHtml(f.summary||f.content||f.original_excerpt||'');
            var fullText=escapeHtml(f.content||f.original_excerpt||f.summary||'');
            var oBadge=recallOriginBadge(f.origin);
            var faBadge2=agentBadge(f.owner);
            html+='<div class="recall-item" onclick="event.stopPropagation();this.classList.toggle(\\\'expanded\\\')">';
            html+='<div class="recall-item-head"><span class="recall-score '+scoreClass+'">'+f.score.toFixed(2)+'</span><span class="log-msg-role '+(f.role||'user')+'">'+(f.role||'user')+'</span>'+oBadge+faBadge2+'<span class="recall-summary-short">'+shortText+'</span><span class="recall-expand-icon">\u25B6</span></div>';
            html+='<div class="recall-summary-full">'+fullText+'</div>';
            html+='</div>';
          });
          html+='</div></div>';
        }else{
          html+='<div style="font-size:10px;color:var(--text-muted);margin-top:2px">\u26A0 '+t('logs.recall.noneRelevant')+'</div>';
        }
        html+='</div>';
      }
    }else{
      var outLines=(lg.output||'').split('\\n');
      var memCount=outLines.filter(function(l){return l.match(/^\\d+\\.\\s*\\[/)}).length;
      if(memCount>0) html+='<div style="margin-top:4px;font-size:11px;color:var(--text-sec)">\u{1F4CE} '+memCount+' memories retrieved</div>';
      else if(lg.output&&lg.output.includes('no hits')) html+='<div style="margin-top:4px;font-size:11px;color:var(--text-sec)">\u2205 No matching memories</div>';
    }
  }else if(tn==='memory_add'&&inputObj){
    const out=lg.output||'';
    const statsMatch=out.match(/^([^\\n]+)/);
    if(statsMatch){
      html+='<div class="log-summary-stats">';
      const pairs=statsMatch[1].split(',').map(s=>s.trim());
      pairs.forEach(p=>{
        const m=p.match(/^(\\w+)=(\\d+)/);
        if(m){html+='<span class="log-stat-chip '+m[1]+'">'+m[1]+' '+m[2]+'</span>';}
      });
      html+='</div>';
    }
    var parsed=parseMemoryAddEntries(out);
    if(parsed.length>0){
      html+='<div class="log-msg-list">';
      parsed.forEach(function(e){
        var actionCls=e.action==='exact-dup'?'exact-dup':e.action==='dedup'?'dedup':e.action==='merged'?'merged':e.action==='error'?'error':'stored';
        var actionLabel={'stored':'\u2713 stored','exact-dup':'\u23ED skip','dedup':'\uD83D\uDD01 dedup','merged':'\uD83D\uDD00 merged','error':'\u2717 error'}[actionCls]||actionCls;
        var displayText=e.content.split('\\n')[0].trim();
        html+='<div class="log-msg-item">'+
          '<span class="log-msg-role '+e.role+'">'+e.role+'</span>'+
          '<span class="log-msg-action '+actionCls+'">'+actionLabel+'</span>'+
          '<span class="log-msg-text">'+escapeHtml(displayText)+'</span>'+
        '</div>';
      });
      html+='</div>';
    }
  }else if(inputObj){
    const keys=Object.keys(inputObj);
    keys.slice(0,4).forEach(k=>{
      const v=String(inputObj[k]);
      html+='<span class="log-summary-kv"><span class="kv-label">'+escapeHtml(k)+':</span><span class="kv-val">'+escapeHtml(v)+'</span></span>';
    });
  }
  return html;
}
function buildRecallDetailHtml(rd){
  var html='<div class="recall-detail">';
  var cands=rd.candidates||[];
  var hubCands=rd.hubCandidates||[];
  var filtered=rd.filtered||[];
  if(cands.length>0){
    html+='<div class="recall-detail-section" onclick="this.classList.toggle(\\\'expanded\\\')">';
    html+='<div class="recall-detail-title"><span class="recall-expand-icon">\u25B6</span>\u{1F50D} '+t('logs.recall.initial')+' ('+cands.length+')</div>';
    html+='<div class="recall-detail-items">';
    cands.forEach(function(c,i){
      var scoreClass=c.score>=0.7?'high':c.score>=0.5?'mid':'low';
      var shortText=escapeHtml(c.summary||c.content||c.original_excerpt||'');
      var fullText=escapeHtml(c.content||c.original_excerpt||c.summary||'');
      var oBadge=recallOriginBadge(c.origin);
      var aBadge=agentBadge(c.owner);
      html+='<div class="recall-item" onclick="event.stopPropagation();this.classList.toggle(\\\'expanded\\\')">';
      html+='<div class="recall-item-head"><span class="recall-idx">'+(i+1)+'</span><span class="recall-score '+scoreClass+'">'+c.score.toFixed(3)+'</span><span class="log-msg-role '+(c.role||'user')+'">'+(c.role||'user')+'</span>'+oBadge+aBadge+'<span class="recall-summary-short">'+shortText+'</span><span class="recall-expand-icon">\u25B6</span></div>';
      html+='<div class="recall-summary-full">'+fullText+'</div>';
      html+='</div>';
    });
    html+='</div></div>';
  }
  html+='<div class="recall-detail-section hub-recall" onclick="this.classList.toggle(\\\'expanded\\\')">';
  html+='<div class="recall-detail-title"><span class="recall-expand-icon">\u25B6</span>\u{1F310} '+t('logs.recall.hubRemote')+' ('+hubCands.length+')</div>';
  if(hubCands.length>0){
    html+='<div class="recall-detail-items">';
    hubCands.forEach(function(c,i){
      var scoreClass=c.score>=0.7?'high':c.score>=0.5?'mid':'low';
      var shortText=escapeHtml(c.summary||c.original_excerpt||'');
      var fullText=escapeHtml(c.original_excerpt||c.summary||'');
      var owner=c.ownerName?' ['+escapeHtml(c.ownerName)+']':'';
      var haBadge=agentBadge(c.sourceAgent||'');
      html+='<div class="recall-item" onclick="event.stopPropagation();this.classList.toggle(\\\'expanded\\\')">';
      html+='<div class="recall-item-head"><span class="recall-idx">'+(i+1)+'</span><span class="recall-score '+scoreClass+'">'+c.score.toFixed(2)+'</span><span class="log-msg-role '+(c.role||'assistant')+'">'+(c.role||'assistant')+'</span><span class="recall-origin hub-remote">'+t('recall.origin.hubRemote')+'</span>'+owner+haBadge+'<span class="recall-summary-short">'+shortText+'</span><span class="recall-expand-icon">\u25B6</span></div>';
      html+='<div class="recall-summary-full">'+fullText+'</div>';
      html+='</div>';
    });
    html+='</div>';
  }
  html+='</div>';
  if(filtered.length>0){
    html+='<div class="recall-detail-section filtered" onclick="this.classList.toggle(\\\'expanded\\\')">';
    html+='<div class="recall-detail-title"><span class="recall-expand-icon">\u25B6</span>\u2705 '+t('logs.recall.filtered')+' ('+filtered.length+')</div>';
    html+='<div class="recall-detail-items">';
    filtered.forEach(function(f,i){
      var scoreClass=f.score>=0.7?'high':f.score>=0.5?'mid':'low';
      var shortText=escapeHtml(f.summary||f.content||f.original_excerpt||'');
      var fullText=escapeHtml(f.content||f.original_excerpt||f.summary||'');
      var oBadge=recallOriginBadge(f.origin);
      var faBadge=agentBadge(f.owner);
      html+='<div class="recall-item" onclick="event.stopPropagation();this.classList.toggle(\\\'expanded\\\')">';
      html+='<div class="recall-item-head"><span class="recall-idx">'+(i+1)+'</span><span class="recall-score '+scoreClass+'">'+f.score.toFixed(3)+'</span><span class="log-msg-role '+(f.role||'user')+'">'+(f.role||'user')+'</span>'+oBadge+faBadge+'<span class="recall-summary-short">'+shortText+'</span><span class="recall-expand-icon">\u25B6</span></div>';
      html+='<div class="recall-summary-full">'+fullText+'</div>';
      html+='</div>';
    });
    html+='</div></div>';
  }else if(cands.length>0||hubCands.length>0){
    html+='<div style="font-size:10px;color:var(--text-muted);margin-top:4px">\u26A0 '+t('logs.recall.noneRelevant')+'</div>';
  }
  if(rd.status==='error'&&rd.error){
    html+='<div style="margin-top:8px;color:var(--accent);font-size:12px">\u274C '+escapeHtml(rd.error)+'</div>';
  }
  html+='</div>';
  return html;
}
function renderLogs(logs){
  const el=document.getElementById('logsList');
  if(!logs.length){
    el.innerHTML='<div style="text-align:center;padding:60px 20px;color:var(--text-sec)">'+
      '<div style="font-size:32px;margin-bottom:12px;opacity:.5">\u{1F4CB}</div>'+
      '<div style="font-size:13px">'+t('logs.empty')+'</div></div>';
    return;
  }
  el.innerHTML=logs.map((lg,i)=>{
    const toolCls=lg.toolName.replace(/[^a-zA-Z0-9_]/g,'_');
    const dur=lg.durationMs<1000?Math.round(lg.durationMs)+'ms':(lg.durationMs/1000).toFixed(1)+'s';
    let inputDisplay='';
    let inputHtml='';
    let outputHtml='';
    try{
      const parsed=JSON.parse(lg.input);
      if(lg.toolName==='memory_add'){
        var addEntries=parseMemoryAddEntries(lg.output||'');
        if(addEntries.length>0){
          inputHtml='<div class="log-add-detail">';
          addEntries.forEach(function(e){
            inputHtml+='<div class="log-add-msg"><div class="log-add-msg-role">'+escapeHtml(e.role)+'</div><div class="log-add-msg-content">'+escapeHtml(e.content).replace(/\\n/g,'<br>')+'</div></div>';
          });
          inputHtml+='</div>';
        }
      }else if(parsed.type==='auto_recall'||parsed.type==='tool_call'){
        inputDisplay=JSON.stringify({query:parsed.query},null,2);
      }else{
        inputDisplay=JSON.stringify(parsed,null,2);
      }
    }catch(_){inputDisplay=lg.input;}
    try{
      var rd2=null;try{rd2=JSON.parse(lg.output);}catch(_e){}
      if(rd2&&rd2.candidates){outputHtml=buildRecallDetailHtml(rd2);}
    }catch(_){}
    const summary=buildLogSummary(lg);
    return '<div class="log-entry" id="log-'+i+'">'+
      '<div class="log-header" onclick="toggleLog('+i+')">'+
        '<span class="log-status '+(lg.success?'ok':'fail')+'"></span>'+
        '<span class="log-tool-badge '+toolCls+'">'+lg.toolName+'</span>'+
        '<span class="log-dur">'+dur+'</span>'+
        '<span class="log-expand-btn" style="margin-left:4px">\u25BC</span>'+
        '<span class="log-time">'+formatLogTime(lg.calledAt)+'</span>'+
      '</div>'+
      (summary?'<div class="log-summary">'+summary+'</div>':'')+
      '<div class="log-detail" id="log-detail-'+i+'">'+
        '<div class="log-io-section">'+
          '<div class="log-io-label">\u25B6 '+t('logs.input')+'</div>'+
          (inputHtml?inputHtml:'<pre class="log-io-content">'+escapeHtml(inputDisplay)+'</pre>')+
        '</div>'+
        '<div class="log-io-section">'+
          '<div class="log-io-label">\u25C0 '+t('logs.output')+'</div>'+
          (outputHtml?outputHtml:'<pre class="log-io-content">'+escapeHtml(lg.output)+'</pre>')+
        '</div>'+
      '</div>'+
    '</div>';
  }).join('');
}

function toggleLog(i){
  const entry=document.getElementById('log-'+i);
  const d=document.getElementById('log-detail-'+i);
  if(d) d.classList.toggle('open');
  if(entry) entry.classList.toggle('expanded');
}

function startLogAutoRefresh(){
  if(logAutoTimer) clearInterval(logAutoTimer);
  logAutoTimer=setInterval(()=>{
    const cb=document.getElementById('logAutoRefresh');
    const logsView=document.getElementById('logsView');
    if(cb&&cb.checked&&logsView&&logsView.classList.contains('show')){
      loadLogs();
    }
  },5000);
}

function escapeHtml(s){
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function setPageSizeVisible(selectId,visible){
  var sel=document.getElementById(selectId);
  if(sel&&sel.parentElement){ sel.parentElement.style.display=visible?'inline-flex':'none'; }
}

function setMetricsDays(d){
  metricsDays=d;
  document.querySelectorAll('.metrics-toolbar .range-btn').forEach(btn=>btn.classList.toggle('active',Number(btn.dataset.days)===d));
  loadMetrics();
}

async function loadMetrics(){
  try{
  const r=await fetch('/api/metrics?days='+metricsDays);
  const d=await r.json();
  document.getElementById('mTotal').textContent=formatNum(d.totals.memories);
  document.getElementById('mTodayWrites').textContent=formatNum(d.totals.todayWrites);
  document.getElementById('mSessions').textContent=formatNum(d.totals.sessions);
  document.getElementById('mEmbeddings').textContent=formatNum(d.totals.embeddings);
  renderChartWrites(d.writesPerDay);
  loadToolMetrics();
  }catch(e){console.error('loadMetrics',e)}
}

function _st(id,v){var e=document.getElementById(id);if(e)e.textContent=v;}
function formatNum(n){return n>=1e6?(n/1e6).toFixed(1)+'M':n>=1e3?(n/1e3).toFixed(1)+'k':String(n);}
function dateLoc(){return curLang==='zh'?'zh-CN':'en-US';}

/* ─── Tasks View Logic ─── */
let tasksStatusFilter='';
let tasksPage=0;
let tasksPageSize=20;

function setTaskStatusFilter(btn,status){
  document.querySelectorAll('.tasks-view .filter-bar .filter-chip[data-task-status]').forEach(c=>c.classList.remove('active'));
  btn.classList.add('active');
  tasksStatusFilter=status;
  tasksPage=0;
  loadTasks();
}

function updateTaskSelectionToolbar(){
  var toolbar=document.getElementById('taskSelectionToolbar');
  var selectAllBtn=document.getElementById('taskSelectAllBtn');
  var bulkDeleteBtn=document.getElementById('taskBulkDeleteBtn');
  var isHub=taskSearchScope==='hub';
  var total=document.querySelectorAll('#tasksList .task-select-check').length;
  var selected=selectedTaskIds.size;
  if(toolbar) toolbar.style.display=isHub?'none':'flex';
  if(selectAllBtn){
    selectAllBtn.textContent=t(selected>0&&selected===total&&total>0?'skills.unselectAll':'skills.selectAll');
    selectAllBtn.disabled=total===0;
    selectAllBtn.style.display=total===0?'none':'';
  }
  if(bulkDeleteBtn){
    var base=t('task.deleteSelected');
    bulkDeleteBtn.style.display=selected>0?'':'none';
    bulkDeleteBtn.textContent=selected>0?(base+' ('+selected+')'):base;
  }
}

function toggleTaskSelection(taskId,checked){
  if(checked) selectedTaskIds.add(taskId);
  else selectedTaskIds.delete(taskId);
  updateTaskSelectionToolbar();
}

function toggleSelectAllTasks(){
  var total=currentTaskIds.length;
  if(total===0) return;
  if(selectedTaskIds.size===total){
    selectedTaskIds.clear();
  }else{
    selectedTaskIds=new Set(currentTaskIds);
  }
  var checks=document.querySelectorAll('#tasksList .task-select-check');
  checks.forEach(function(cb){cb.checked=selectedTaskIds.has(cb.value);});
  updateTaskSelectionToolbar();
}

async function deleteSelectedTasks(){
  var ids=Array.from(selectedTaskIds);
  if(ids.length===0) return;
  var msg=t('task.delete.selected.confirm').replace('{count}',String(ids.length));
  if(!(await confirmModal(msg,{danger:true}))) return;
  var ok=0;
  var fail=0;
  for(var i=0;i<ids.length;i++){
    try{
      var r=await fetch('/api/task/'+ids[i],{method:'DELETE'});
      var d=await r.json();
      if(!r.ok) throw new Error(d.error||'unknown');
      ok++;
    }catch(e){
      fail++;
    }
  }
  selectedTaskIds.clear();
  updateTaskSelectionToolbar();
  loadTasks();
  if(fail>0) toast(t('task.delete.partial').replace('{ok}',String(ok)).replace('{fail}',String(fail)),'warn');
  else toast(t('task.delete.success').replace('{count}',String(ok)),'success');
}

var taskSearchQuery='';
var _taskSearchTimer=null;
function debounceTaskSearch(){
  clearTimeout(_taskSearchTimer);
  _taskSearchTimer=setTimeout(function(){
    taskSearchQuery=(document.getElementById('taskSearchInput')||{}).value||'';
    tasksPage=0;
    loadTasks();
  },350);
}

function renderTaskCards(tasks,container){
  currentTaskIds=tasks.map(function(task){return task.id;});
  selectedTaskIds=new Set(Array.from(selectedTaskIds).filter(function(id){return currentTaskIds.includes(id);}));
  if(!tasks||tasks.length===0){
    container.innerHTML='<div style="text-align:center;padding:48px;color:var(--text-muted);font-size:14px" data-i18n="tasks.empty">'+t('tasks.empty')+'</div>';
    updateTaskSelectionToolbar();
    return;
  }
  container.innerHTML=tasks.map(function(task){
    var timeStr=formatTime(task.startedAt);
    var durationStr=task.endedAt?formatDuration(task.endedAt-task.startedAt):'';
    var taskIsLocalShared=task.owner==='public';
    var taskIsTeamShared=!!task.sharingVisibility;
    var taskScope=taskIsTeamShared?'team':taskIsLocalShared?'local':'private';
    var selectedAttr=selectedTaskIds.has(task.id)?' checked':'';
    return '<div class="task-card status-'+task.status+'" onclick="openTaskDetail(\\''+task.id+'\\')">'+
      '<div class="task-card-top">'+
        '<div class="task-card-title"><label class="item-select-box" onclick="event.stopPropagation()"><input class="task-select-check" type="checkbox" value="'+escAttr(task.id)+'"'+selectedAttr+' onchange="event.stopPropagation();toggleTaskSelection(&quot;'+escAttr(task.id)+'&quot;,this.checked)"></label>'+esc(task.title)+'</div>'+
        '<div class="task-card-badges">'+renderScopeBadge(taskScope)+'<span class="task-status-badge '+task.status+'">'+t('tasks.status.'+task.status)+'</span></div>'+
      '</div>'+
      (task.summary?'<div class="task-card-summary'+(task.status==='skipped'?' skipped-reason':'')+'">'+esc(task.summary)+'</div>':'')+
      '<div class="task-card-bottom">'+
        '<span class="tag"><span class="icon">\\u{1F4C5}</span> '+timeStr+'</span>'+
        (durationStr?'<span class="tag"><span class="icon">\\u23F1</span> '+durationStr+'</span>':'')+
        '<span class="tag"><span class="icon">\\u{1F4DD}</span> '+(task.chunkCount||0)+' '+t('tasks.chunks.label')+'</span>'+
        '<span class="tag"><span class="icon">\\u{1F4C2}</span> '+(task.sessionKey||'')+'</span>'+
      '</div>'+
      '<div class="card-actions" onclick="event.stopPropagation()">'+
        '<button class="btn btn-sm btn-ghost" onclick="openTaskDetail(\\''+task.id+'\\')">'+t('card.expand')+'</button>'+
        (task.status==='completed'&&(!task.skillStatus||task.skillStatus==='not_generated'||task.skillStatus==='skipped')?'<button class="btn btn-sm btn-ghost" onclick="retrySkillGen(\\''+task.id+'\\')">'+t('task.retrySkill.short')+'</button>':'')+
        (task.status==='completed'
          ?'<button class="btn btn-sm btn-ghost" onclick="openTaskScopeModalFromList(\\''+task.id+'\\',\\''+taskScope+'\\')">\\u270F '+t('share.shareBtn')+'</button>'
          :'<button class="btn btn-sm btn-ghost" style="opacity:0.45;cursor:not-allowed" onclick="toast(t(\\x27share.scope.taskNotCompleted\\x27),\\x27warn\\x27)">\\u270F '+t('share.shareBtn')+'</button>')+
        '<button class="btn btn-sm btn-ghost" style="color:var(--accent)" onclick="deleteTask(\\''+task.id+'\\')">'+t('task.delete')+'</button>'+
      '</div>'+
    '</div>';
  }).join('');
  updateTaskSelectionToolbar();
}

async function loadTasks(silent){
  const scope=document.getElementById('taskSearchScope')?document.getElementById('taskSearchScope').value:taskSearchScope;
  taskSearchScope=scope||'allLocal';
  if(taskSearchScope==='hub'){ return loadHubTasks(); }
  const list=document.getElementById('tasksList');
  if(!silent) list.innerHTML='<div class="spinner"></div>';
  try{
    var ownerSel=document.getElementById('taskFilterOwner')||document.getElementById('filterOwner');
    var ownerVal=ownerSel?ownerSel.value:'';

    if(taskSearchQuery&&taskSearchQuery.trim()){
      var sp=new URLSearchParams({q:taskSearchQuery.trim(),limit:String(tasksPageSize)});
      if(ownerVal) sp.set('owner',ownerVal);
      var sr=await fetch('/api/task-search?'+sp).then(function(r){return r.json()});
      var tasks=sr.tasks||[];
      document.getElementById('taskSearchMeta').style.display='block';
      document.getElementById('taskSearchMeta').textContent=t('tasks.search.meta').replace('{0}',tasks.length);
      _st('tasksTotalCount',tasks.length);
      _st('tasksActiveCount',tasks.filter(function(tk){return tk.status==='active'}).length);
      _st('tasksCompletedCount',tasks.filter(function(tk){return tk.status==='completed'}).length);
      _st('tasksSkippedCount',tasks.filter(function(tk){return tk.status==='skipped'}).length);
      if(tasksStatusFilter) tasks=tasks.filter(function(tk){return tk.status===tasksStatusFilter});
      renderTaskCards(tasks,list);
      document.getElementById('tasksPagination').innerHTML='';
      return;
    }
    document.getElementById('taskSearchMeta').style.display='none';

    const params=new URLSearchParams({limit:String(tasksPageSize),offset:String(tasksPage*tasksPageSize)});
    if(tasksStatusFilter) params.set('status',tasksStatusFilter);
    if(activeSession) params.set('session',activeSession);
    if(ownerVal) params.set('owner',ownerVal);
    var baseP=new URLSearchParams();
    if(activeSession) baseP.set('session',activeSession);
    if(ownerVal) baseP.set('owner',ownerVal);
    var baseQuery=baseP.toString();
    const [data,allD,activeD,compD,skipD]=await Promise.all([
      fetch('/api/tasks?'+params).then(r=>r.json()),
      fetch('/api/tasks?limit=1&offset=0'+(baseQuery?'&'+baseQuery:'')).then(r=>r.json()),
      fetch('/api/tasks?status=active&limit=1&offset=0'+(baseQuery?'&'+baseQuery:'')).then(r=>r.json()),
      fetch('/api/tasks?status=completed&limit=1&offset=0'+(baseQuery?'&'+baseQuery:'')).then(r=>r.json()),
      fetch('/api/tasks?status=skipped&limit=1&offset=0'+(baseQuery?'&'+baseQuery:'')) .then(r=>r.json())
    ]);
    if(silent){
      var fp=JSON.stringify((data.tasks||[]).map(function(tk){return tk.id+'|'+tk.status+'|'+(tk.updatedAt||tk.startedAt)}));
      fp+=':'+allD.total+':'+activeD.total+':'+compD.total+':'+skipD.total;
      if(fp===_lastTasksFingerprint) return;
      _lastTasksFingerprint=fp;
    }else{
      _lastTasksFingerprint='';
    }
    _st('tasksTotalCount',formatNum(allD.total));
    _st('tasksActiveCount',formatNum(activeD.total));
    _st('tasksCompletedCount',formatNum(compD.total));
    _st('tasksSkippedCount',formatNum(skipD.total));

    renderTaskCards(data.tasks||[],list);

    if(!data.tasks||data.tasks.length===0){
      document.getElementById('tasksPagination').innerHTML='';
    } else {
      renderTasksPagination(data.total);
    }
  }catch(e){
    console.error('loadTasks error:',e);
    currentTaskIds=[];
    selectedTaskIds.clear();
    setPageSizeVisible('tasksPageSize',false);
    updateTaskSelectionToolbar();
    list.innerHTML='<div style="text-align:center;padding:24px;color:var(--rose)">Failed to load tasks: '+String(e)+'</div>';
  }
}

function updateTaskCardBadge(taskId,newScope){
  var cards=document.querySelectorAll('.task-card');
  for(var i=0;i<cards.length;i++){
    var onclick=cards[i].getAttribute('onclick')||'';
    if(onclick.indexOf(taskId)===-1) continue;
    var badges=cards[i].querySelector('.task-card-badges');
    if(!badges) continue;
    var oldBadge=badges.querySelectorAll('span[style*="border-radius:10px"]');
    for(var j=0;j<oldBadge.length;j++) oldBadge[j].remove();
    badges.insertAdjacentHTML('afterbegin',renderScopeBadge(newScope));
    break;
  }
}

function renderTasksPagination(total){
  const el=document.getElementById('tasksPagination');
  const pages=Math.ceil(total/tasksPageSize);
  if(pages<=1){el.innerHTML='';return;}
  let html='<button class="pg-btn'+(tasksPage===0?' disabled':'')+'" onclick="tasksPage=Math.max(0,tasksPage-1);loadTasks()">\\u2190</button>';
  const start=Math.max(0,tasksPage-2),end=Math.min(pages,tasksPage+3);
  for(let i=start;i<end;i++){
    html+='<button class="pg-btn'+(i===tasksPage?' active':'')+'" onclick="tasksPage='+i+';loadTasks()">'+(i+1)+'</button>';
  }
  html+='<button class="pg-btn'+(tasksPage>=pages-1?' disabled':'')+'" onclick="tasksPage=Math.min('+(pages-1)+',tasksPage+1);loadTasks()">\\u2192</button>';
  html+='<span class="pg-info">'+total+' '+t('pagination.total')+'</span>';
  el.innerHTML=html;
}

var _currentTaskId=null;
var _currentTaskData=null;
async function openTaskDetail(taskId){
  _currentTaskId=taskId;
  const overlay=document.getElementById('taskDetailOverlay');
  overlay.classList.add('show');
  document.getElementById('taskDetailTitle').textContent=t('tasks.loading');
  document.getElementById('taskDetailMeta').innerHTML='';
  document.getElementById('taskSkillSection').innerHTML='';
  document.getElementById('taskSkillSection').className='task-skill-section';
  document.getElementById('taskDetailSummary').textContent='';
  document.getElementById('taskDetailChunks').innerHTML='<div class="spinner"></div>';
  document.getElementById('taskShareActions').innerHTML='';
  document.getElementById('taskDetailActions').innerHTML='';

  try{
    const r=await fetch('/api/task/'+taskId);
    const task=await r.json();
    currentTaskDetail=task;

    document.getElementById('taskDetailTitle').textContent=task.title||t('tasks.untitled');
    renderTaskShareActions(task);

    const meta=[
      '<span class="meta-item"><span class="task-status-badge '+task.status+'">'+t('tasks.status.'+task.status)+'</span></span>',
      '<span class="meta-item">\\u{1F4C5} '+formatDateTimeSeconds(task.startedAt)+'</span>',
    ];
    if(task.endedAt) meta.push('<span class="meta-item">\\u2192 '+formatDateTimeSeconds(task.endedAt)+'</span>');
    meta.push('<span class="meta-item">\\u{1F4C2} '+task.sessionKey+'</span>');
    meta.push('<span class="meta-item">\\u{1F4DD} '+task.chunks.length+' '+t('tasks.chunks.label')+'</span>');
    meta.push('<div style="width:100%;margin-top:4px"><span class="meta-item" style="width:100%">'+t('tasks.taskid')+'<span class="task-id-full">'+esc(task.id)+'</span></span></div>');
    document.getElementById('taskDetailMeta').innerHTML=meta.join('');

    _currentTaskData=task;

    // ── Skill status section ──
    renderTaskSkillSection(task);

    document.getElementById('taskDetailActions').innerHTML='';

    var summaryEl=document.getElementById('taskDetailSummary');
    if(task.status==='skipped'){
      summaryEl.innerHTML='<div style="color:var(--text-muted);font-style:italic;display:flex;align-items:flex-start;gap:8px"><span style="font-size:18px">\\u26A0\\uFE0F</span><span>'+esc(task.summary||t('tasks.skipped.default'))+'</span></div>';
    }else{
      summaryEl.innerHTML=renderSummaryHtml(task.summary);
    }

    if(task.chunks.length===0){
      document.getElementById('taskDetailChunks').innerHTML='<div style="color:var(--text-muted);padding:12px;font-size:13px">'+t('tasks.nochunks')+'</div>';
    }else{
      document.getElementById('taskDetailChunks').innerHTML=task.chunks.map(function(c,i){
        var roleLabel=c.role==='user'?t('tasks.role.user'):c.role==='assistant'?t('tasks.role.assistant'):c.role.toUpperCase();
        var avatarIcon=c.role==='user'?'U':c.role==='assistant'?'A':'T';
        return '<div class="task-chunk-item role-'+c.role+'">'+
          '<div class="task-chunk-avatar">'+avatarIcon+'</div>'+
          '<div class="task-chunk-body">'+
            '<div class="task-chunk-header">'+
          '<div class="task-chunk-role '+c.role+'">'+roleLabel+'</div>'+
              '<div class="task-chunk-time">'+formatDateTimeSeconds(c.createdAt)+'</div>'+
            '</div>'+
          '<div class="task-chunk-bubble collapsed" id="chunk_b_'+i+'">'+esc(c.content)+'</div>'+
          '<div class="task-chunk-expand" id="chunk_e_'+i+'" onclick="toggleChunkExpand('+i+')"><span class="expand-arrow">▼</span> <span class="expand-label">'+t('tasks.expand')+'</span></div>'+
          '</div>'+
        '</div>';
      }).join('');
      setTimeout(function(){initChunkExpanders(task.chunks.length)},50);
    }
  }catch(e){
    document.getElementById('taskDetailTitle').textContent=t('tasks.error');
    document.getElementById('taskDetailChunks').innerHTML='<div style="color:var(--rose)">'+t('tasks.error.detail')+'</div>';
  }
}

function renderTaskSkillSection(task){
  const section=document.getElementById('taskSkillSection');
  const ss=task.skillStatus;
  const links=task.skillLinks||[];

  if(links.length>0){
    section.className='task-skill-section status-generated';
    var html='<div class="skill-status-header">\\u{1F527} \u5DF2\u751F\u6210\u6280\u80FD</div>';
    html+=links.map(function(lk){
      var relLabel={'generated_from':'\u7531\u6B64\u4EFB\u52A1\u751F\u6210','evolved_from':'\u7531\u6B64\u4EFB\u52A1\u5347\u7EA7','applied_to':'\u5173\u8054\u4F7F\u7528'}[lk.relation]||lk.relation;
      var statusLabel={'active':'\u6D3B\u8DC3','draft':'\u8349\u7A3F','archived':'\u5DF2\u5F52\u6863'}[lk.status]||lk.status;
      return '<div class="skill-link-card" onclick="event.stopPropagation();closeTaskDetail();switchView(\\'skills\\');setTimeout(function(){openSkillDetail(\\''+lk.skillId+'\\')},300)">'+
        '<div class="skill-link-name">'+esc(lk.skillName)+' <span style="font-size:11px;color:var(--text-sec)">('+relLabel+', v'+lk.versionAt+')</span></div>'+
        '<div class="skill-link-meta">'+
          '\u72B6\u6001: <span class="task-status-badge '+(lk.status||'active')+'">'+statusLabel+'</span>'+
          (lk.qualityScore!=null?' &middot; \u8D28\u91CF\u5206: '+lk.qualityScore+'/10':'')+
        '</div>'+
        '<div style="margin-top:4px"><span class="task-id-full">Skill ID: '+esc(lk.skillId)+'</span></div>'+
      '</div>';
    }).join('');
    section.innerHTML=html;
  }else if(ss==='generating'){
    section.className='task-skill-section status-generating';
    section.innerHTML='<div class="skill-status-header">\\u23F3 \u6280\u80FD\u751F\u6210\u4E2D...</div>'+
      '<div class="skill-status-reason">'+esc(task.skillReason||'')+'</div>';
  }else if(ss==='not_generated'){
    section.className='task-skill-section status-not_generated';
    section.innerHTML='<div class="skill-status-header">\\u274C \u672A\u751F\u6210\u6280\u80FD</div>'+
      '<div class="skill-status-reason">\u539F\u56E0\uFF1A'+esc(task.skillReason||'\u7ECF LLM \u8BC4\u4F30\uFF0C\u8BE5\u4EFB\u52A1\u4E0D\u9002\u5408\u63D0\u70BC\u4E3A\u53EF\u590D\u7528\u6280\u80FD\u3002')+'</div>'+
      (task.status==='completed'?'<button class="btn btn-primary" onclick="retrySkillGen(\\''+esc(task.id)+'\\')" style="margin-top:8px;font-size:12px">'+t('task.retrySkill')+'</button>':'');
  }else if(ss==='skipped'){
    section.className='task-skill-section status-skipped';
    section.innerHTML='<div class="skill-status-header">\\u23ED \u8DF3\u8FC7\u6280\u80FD\u8BC4\u4F30</div>'+
      '<div class="skill-status-reason">\u539F\u56E0\uFF1A'+esc(task.skillReason||'')+'</div>'+
      (task.status==='completed'?'<button class="btn btn-primary" onclick="retrySkillGen(\\''+esc(task.id)+'\\')" style="margin-top:8px;font-size:12px">'+t('task.retrySkill')+'</button>':'');
  }else if(ss==='queued'){
    section.className='task-skill-section status-generating';
    section.innerHTML='<div class="skill-status-header">\\u{1F4CB} \u6392\u961F\u4E2D</div>'+
      '<div class="skill-status-reason">'+esc(task.skillReason||'\u7B49\u5F85\u6280\u80FD\u8BC4\u4F30\uFF0C\u524D\u65B9\u4EFB\u52A1\u5904\u7406\u5B8C\u6210\u540E\u81EA\u52A8\u5F00\u59CB\u3002')+'</div>';
  }else if(task.status==='active'){
    section.className='task-skill-section status-skipped';
    section.innerHTML='<div class="skill-status-header">\\u23F8 \u4EFB\u52A1\u8FDB\u884C\u4E2D</div>'+
      '<div class="skill-status-reason">\u6280\u80FD\u8BC4\u4F30\u5728\u4EFB\u52A1\u5B8C\u6210\u540E\u81EA\u52A8\u8FD0\u884C\u3002</div>';
  }else if(task.status==='completed'){
    section.className='task-skill-section status-generating';
    section.innerHTML='<div class="skill-status-header">\\u23F3 \u7B49\u5F85\u8BC4\u4F30</div>'+
      '<div class="skill-status-reason">\u4EFB\u52A1\u5DF2\u5B8C\u6210\uFF0C\u6280\u80FD\u8BC4\u4F30\u5373\u5C06\u5F00\u59CB\u3002</div>'+
      '<button class="btn btn-primary" onclick="retrySkillGen(\\''+esc(task.id)+'\\')" style="margin-top:8px;font-size:12px">'+t('task.retrySkill')+'</button>';
  }else{
    section.className='task-skill-section status-skipped';
    section.innerHTML='<div class="skill-status-header">\\u2014 \u65E0\u6280\u80FD\u4FE1\u606F</div>'+
      '<div class="skill-status-reason">\u8BE5\u4EFB\u52A1\u672A\u8FDB\u884C\u6280\u80FD\u8BC4\u4F30\u3002</div>'+
      (task.status==='completed'?'<button class="btn btn-primary" onclick="retrySkillGen(\\''+esc(task.id)+'\\')" style="margin-top:8px;font-size:12px">'+t('task.retrySkill')+'</button>':'');
  }
}

function initChunkExpanders(count){
  for(var i=0;i<count;i++){
    var b=document.getElementById('chunk_b_'+i);
    var e=document.getElementById('chunk_e_'+i);
    if(b && b.scrollHeight > b.clientHeight + 4){
      e.style.display='flex';
    } else if(b) {
      b.classList.remove('collapsed');
    }
  }
}
function toggleChunkExpand(i){
  var b=document.getElementById('chunk_b_'+i);
  var e=document.getElementById('chunk_e_'+i);
  if(!b||!e)return;
  var expanding=b.classList.contains('collapsed');
  if(expanding){
    b.classList.remove('collapsed');
    e.classList.add('is-expanded');
    e.querySelector('.expand-label').textContent=t('tasks.collapse');
  }else{
    b.classList.add('collapsed');
    e.classList.remove('is-expanded');
    e.querySelector('.expand-label').textContent=t('tasks.expand');
  }
}
function closeTaskDetail(event){
  if(event && event.target!==document.getElementById('taskDetailOverlay')) return;
  document.getElementById('taskDetailOverlay').classList.remove('show');
}

async function retrySkillGen(taskId){
  if(!(await confirmModal(t('task.retrySkill.confirm')))) return;
  try{
    const r=await fetch('/api/task/'+taskId+'/retry-skill',{method:'POST'});
    const d=await r.json();
    if(!r.ok) throw new Error(d.error||'unknown');
    openTaskDetail(taskId);
  }catch(e){ alert(t('task.retrySkill.error')+e.message); }
}

async function deleteTask(taskId){
  if(!(await confirmModal(t('task.delete.confirm'),{danger:true}))) return;
  try{
    const r=await fetch('/api/task/'+taskId,{method:'DELETE'});
    const d=await r.json();
    if(!r.ok) throw new Error(d.error||'unknown');
    selectedTaskIds.delete(taskId);
    updateTaskSelectionToolbar();
    closeTaskDetail();
    document.getElementById('taskDetailOverlay').classList.remove('show');
    loadTasks();
  }catch(e){ alert(t('task.delete.error')+e.message); }
}


/* ─── Skills View Logic ─── */
let skillsStatusFilter='';
let skillsPage=0;
let skillsPageSize=20;
let selectedSkillIds=new Set();
let currentLocalSkills=[];
let skillsFilterSignature='';

function setSkillStatusFilter(btn,status){
  document.querySelectorAll('.skills-view .filter-bar .filter-chip[data-skill-status]').forEach(c=>c.classList.remove('active'));
  btn.classList.add('active');
  skillsStatusFilter=status;
  skillsPage=0;
  loadSkills();
}

function updateSkillSelectionToolbar(){
  var selectAllBtn=document.getElementById('skillSelectAllBtn');
  var bulkDeleteBtn=document.getElementById('skillBulkDeleteBtn');
  var total=document.querySelectorAll('#skillsList .skill-select-check').length;
  var selected=selectedSkillIds.size;
  if(selectAllBtn){
    selectAllBtn.textContent=t(selected>0&&selected===total&&total>0?'skills.unselectAll':'skills.selectAll');
    selectAllBtn.style.display=total===0?'none':'';
  }
  if(bulkDeleteBtn){
    var base=t('skills.deleteSelected');
    bulkDeleteBtn.style.display=selected>0?'':'none';
    bulkDeleteBtn.textContent=selected>0?(base+' ('+selected+')'):base;
  }
}

function toggleSkillSelection(skillId,checked){
  if(checked) selectedSkillIds.add(skillId);
  else selectedSkillIds.delete(skillId);
  updateSkillSelectionToolbar();
}

function toggleSelectAllSkills(){
  var total=currentLocalSkills.length;
  if(total===0) return;
  if(selectedSkillIds.size===total){
    selectedSkillIds.clear();
  }else{
    selectedSkillIds=new Set(currentLocalSkills.map(function(s){return s.id;}));
  }
  var checks=document.querySelectorAll('#skillsList .skill-select-check');
  checks.forEach(function(cb){cb.checked=selectedSkillIds.has(cb.value);});
  updateSkillSelectionToolbar();
}

function updateSkillCardBadge(skillId,newScope){
  var cards=document.querySelectorAll('.skill-card');
  for(var i=0;i<cards.length;i++){
    var onclick=cards[i].getAttribute('onclick')||'';
    if(onclick.indexOf(skillId)===-1) continue;
    var badges=cards[i].querySelector('.skill-card-badges');
    if(!badges) continue;
    var oldBadge=badges.querySelectorAll('span[style*="border-radius:10px"]');
    for(var j=0;j<oldBadge.length;j++) oldBadge[j].remove();
    var versionBadge=badges.querySelector('.version');
    if(versionBadge) versionBadge.insertAdjacentHTML('afterend',renderScopeBadge(newScope));
    else badges.insertAdjacentHTML('afterbegin',renderScopeBadge(newScope));
    break;
  }
}

function renderSkillsPagination(total){
  const el=document.getElementById('skillsPagination');
  if(!el) return;
  const pages=Math.ceil(total/skillsPageSize);
  if(pages<=1){el.innerHTML='';return;}
  let html='<button class="pg-btn'+(skillsPage===0?' disabled':'')+'" onclick="skillsPage=Math.max(0,skillsPage-1);loadSkills()">\\u2190</button>';
  const start=Math.max(0,skillsPage-2),end=Math.min(pages,skillsPage+3);
  for(let i=start;i<end;i++){
    html+='<button class="pg-btn'+(i===skillsPage?' active':'')+'" onclick="skillsPage='+i+';loadSkills()">'+(i+1)+'</button>';
  }
  html+='<button class="pg-btn'+(skillsPage>=pages-1?' disabled':'')+'" onclick="skillsPage=Math.min('+(pages-1)+',skillsPage+1);loadSkills()">\\u2192</button>';
  html+='<span class="pg-info">'+total+' '+t('pagination.total')+'</span>';
  el.innerHTML=html;
}

async function loadSkills(silent){
  const list=document.getElementById('skillsList');
  const hubList=document.getElementById('hubSkillsList');
  if(!silent) list.innerHTML='<div class="spinner"></div>';
  var hubSection=document.getElementById('hubSkillsSection');
  if(hubList){
    if(skillSearchScope==='allLocal'){
      if(hubSection) hubSection.style.display='none';
    }else{
      if(hubSection) hubSection.style.display='block';
      if(!silent) hubList.innerHTML='<div class="spinner"></div>';
    }
  }

  const query=(document.getElementById('skillSearchInput')?.value||'').trim();
  const scope=document.getElementById('skillSearchScope') ? document.getElementById('skillSearchScope').value : skillSearchScope;
  skillSearchScope=scope||'allLocal';

  try{
    const params=new URLSearchParams();
    if(skillsStatusFilter) params.set('status',skillsStatusFilter);
    if(activeSession) params.set('session',activeSession);
    var skillOwnerSel=document.getElementById('skillFilterOwner')||document.getElementById('filterOwner');
    var skillOwnerVal=skillOwnerSel?skillOwnerSel.value:'';
    if(skillOwnerVal) params.set('owner',skillOwnerVal);
    const visFilter=document.getElementById('skillVisibilityFilter')?.value;
    if(visFilter) params.set('visibility',visFilter);
    const filterSignature=[query,skillSearchScope,skillsStatusFilter,visFilter||'',skillOwnerVal].join('|');
    if(!silent&&filterSignature!==skillsFilterSignature){
      skillsPage=0;
    }
    skillsFilterSignature=filterSignature;

    const localRes=await fetch('/api/skills?'+params.toString());
    const localData=await localRes.json();
    let localSkills=Array.isArray(localData.skills)?localData.skills:[];
    currentLocalSkills=localSkills.slice();
    if(query){
      const q=query.toLowerCase();
      localSkills=localSkills.filter(skill=>{
        const haystack=[skill.name,skill.description,skill.tags].filter(Boolean).join(' ').toLowerCase();
        return haystack.includes(q);
      });
      currentLocalSkills=localSkills.slice();
    }
    var localIdSet=new Set(localSkills.map(function(s){return s.id;}));
    selectedSkillIds=new Set(Array.from(selectedSkillIds).filter(function(id){return localIdSet.has(id);}));
    if(silent){
      var fp=JSON.stringify(localSkills.map(function(s){return s.id+'|'+s.status+'|'+s.version+'|'+(s.visibility||'')}));
      if(fp===_lastSkillsFingerprint) return;
      _lastSkillsFingerprint=fp;
    }else{
      _lastSkillsFingerprint='';
    }

    const renderLocalCards=function(skills){
      if(!skills||skills.length===0){
        return '<div style="text-align:center;padding:48px;color:var(--text-muted);font-size:14px">'+(query?t('skills.search.noresult'):t('skills.empty'))+'</div>';
      }
      return skills.map(skill=>{
        const timeStr=formatTime(skill.createdAt);
        const tags=parseTags(skill.tags);
        const installedClass=skill.installed?'installed':'';
        const statusClass=skill.status==='archived'?'archived':(skill.status==='draft'?'draft':'');
        const sourceLabel=tags.includes('hub-import')?'hub-import':skill.sourceType;
        const qs=skill.qualityScore;
        const qsBadge=qs!==null&&qs!==undefined?'<span class="skill-badge quality '+(qs>=7?'high':qs>=5?'mid':'low')+'">★ '+qs.toFixed(1)+'</span>':'';
        const skillIsLocalShared=skill.visibility==='public';
        const skillIsTeamShared=!!skill.sharingVisibility;
        const skillScope=skillIsTeamShared?'team':skillIsLocalShared?'local':'private';
        const selectedAttr=selectedSkillIds.has(skill.id)?' checked':'';
        return '<div class="skill-card '+installedClass+' '+statusClass+'" onclick="openSkillDetail(&quot;'+escAttr(skill.id)+'&quot;)">'+
          '<div class="skill-card-top">'+
            '<div class="skill-card-name"><label class="item-select-box" onclick="event.stopPropagation()"><input class="skill-select-check" type="checkbox" value="'+escAttr(skill.id)+'"'+selectedAttr+' onchange="event.stopPropagation();toggleSkillSelection(&quot;'+escAttr(skill.id)+'&quot;,this.checked)"></label>🧠 '+esc(skill.name)+'</div>'+
            '<div class="skill-card-badges">'+
              qsBadge+
              '<span class="skill-badge version">v'+skill.version+'</span>'+
              renderScopeBadge(skillScope)+
              (skill.installed?'<span class="skill-badge installed">'+t('skills.installed.badge')+'</span>':'')+
              '<span class="skill-badge status-'+skill.status+'">'+t('skills.status.'+skill.status)+'</span>'+
            '</div>'+
          '</div>'+
          '<div class="skill-card-desc">'+esc(skill.description)+'</div>'+
          '<div class="skill-card-bottom">'+
            '<span class="tag"><span class="icon">📅</span> '+timeStr+'</span>'+
            '<span class="tag"><span class="icon">📦</span> '+sourceLabel+'</span>'+
            (tags.length>0?'<div class="skill-card-tags">'+tags.map(tg=>'<span class="skill-tag">'+esc(tg)+'</span>').join('')+'</div>':'')+
            '<span class="card-actions-inline" onclick="event.stopPropagation()">'+
              '<button class="btn btn-sm btn-ghost" onclick="openSkillDetail(&quot;'+escAttr(skill.id)+'&quot;)">'+t('card.expand')+'</button>'+
              (skill.status==='active'
                ?'<button class="btn btn-sm btn-ghost" onclick="openSkillScopeModalFromList(&quot;'+escAttr(skill.id)+'&quot;,&quot;'+skillScope+'&quot;)">\\u270F '+t('share.shareBtn')+'</button>'
                :'<button class="btn btn-sm btn-ghost" style="opacity:0.45;cursor:not-allowed" onclick="toast(t(\\x27share.scope.skillNotActive\\x27),\\x27warn\\x27)">\\u270F '+t('share.shareBtn')+'</button>')+
              (skill.status==='active'
                ?'<button class="btn btn-sm btn-ghost btn-warn" onclick="disableSkill(&quot;'+escAttr(skill.id)+'&quot;)">'+t('skills.action.disable')+'</button>'
                :'')+
              (skill.status==='archived'
                ?'<button class="btn btn-sm btn-ghost btn-success" onclick="enableSkill(&quot;'+escAttr(skill.id)+'&quot;)">'+t('skills.action.enable')+'</button>'
                :'')+
              '<button class="btn btn-sm btn-ghost btn-danger" onclick="deleteSkill(&quot;'+escAttr(skill.id)+'&quot;)">'+t('skills.action.delete')+'</button>'+
            '</span>'+
          '</div>'+
        '</div>';
      }).join('');
    };

    const totalLocalSkills=localSkills.length;
    const localPages=Math.ceil(totalLocalSkills/skillsPageSize)||1;
    if(skillsPage>=localPages) skillsPage=Math.max(0,localPages-1);
    const startIndex=skillsPage*skillsPageSize;
    const pageSkills=localSkills.slice(startIndex,startIndex+skillsPageSize);
    list.innerHTML=renderLocalCards(pageSkills);
    renderSkillsPagination(totalLocalSkills);
    setPageSizeVisible('skillsPageSize',totalLocalSkills>0);
    updateSkillSelectionToolbar();

    if(skillSearchScope==='allLocal'){
      if(hubSection) hubSection.style.display='none';
      _st('skillsTotalCount',formatNum(localSkills.length));
      _st('skillsActiveCount',formatNum(localSkills.filter(s=>s.status==='active').length));
      _st('skillsDraftCount',formatNum(localSkills.filter(s=>s.status==='draft').length));
      _st('skillsInstalledCount',formatNum(localSkills.filter(s=>s.installed).length));
      _st('skillsPublicCount',formatNum(localSkills.filter(s=>s.visibility==='public').length));
      return;
    }

    if(!query){
      if(hubSection) hubSection.style.display='block';
      var localIds=new Set(localSkills.map(function(s){return s.id;}));
      if(hubList){ await loadHubSkills(hubList, localIds); }
      _st('skillsTotalCount',formatNum(localSkills.length));
      _st('skillsActiveCount',formatNum(localSkills.filter(s=>s.status==='active').length));
      _st('skillsDraftCount',formatNum(localSkills.filter(s=>s.status==='draft').length));
      _st('skillsInstalledCount',formatNum(localSkills.filter(s=>s.installed).length));
      _st('skillsPublicCount',formatNum(localSkills.filter(s=>s.visibility==='public').length));
      return;
    }

    const sharingParams=new URLSearchParams();
    sharingParams.set('query',query);
    sharingParams.set('scope',skillSearchScope);
    sharingParams.set('maxResults','20');
    const r=await fetch('/api/sharing/search/skills?'+sharingParams.toString());
    const data=await r.json();
    const localSkillIdSet=new Set(currentLocalSkills.map(function(skill){return skill.id;}));
    const localHitsRaw=(data.local&&Array.isArray(data.local.hits))?data.local.hits:[];
    const localHits=localHitsRaw.filter(function(skill){return localSkillIdSet.has(skill.skillId);});
    const hubHits=(data.hub&&Array.isArray(data.hub.hits))?data.hub.hits:[];

    const sp=document.getElementById('skillsPagination');
    if(sp) sp.innerHTML='';
    list.innerHTML=localHits.length?localHits.map(function(skill){
      return '<div class="hub-skill-card" onclick="openSkillDetail(&quot;'+escAttr(skill.skillId)+'&quot;)">'+
        '<div class="summary">'+esc(skill.name)+'</div>'+
        '<div class="excerpt">'+esc(skill.description||'')+'</div>'+
        '<div class="hub-skill-meta"><span class="meta-chip">visibility: '+esc(skill.visibility||'private')+'</span><span class="meta-chip">owner: '+esc(skill.owner||'agent:main')+'</span></div>'+
      '</div>';
    }).join(''):'<div style="text-align:center;padding:48px;color:var(--text-muted);font-size:14px">'+t('skills.search.noresult')+'</div>';

    if(hubList){
      if(hubSection) hubSection.style.display=hubHits.length?'block':'none';
      hubList.innerHTML=hubHits.length?hubHits.map(function(skill){
        return '<div class="hub-skill-card">'+
          '<div class="summary">'+esc(skill.name)+'</div>'+
          '<div class="excerpt">'+esc(skill.description||'')+'</div>'+
          '<div class="hub-skill-meta">'+
            '<span class="meta-chip">owner: '+fmtOwner(skill)+'</span>'+
            (skill.groupName?'<span class="meta-chip">group: '+esc(skill.groupName)+'</span>':'')+
            '<span class="meta-chip">visibility: '+esc(skill.visibility||'hub')+'</span>'+
            (skill.version!=null?'<span class="meta-chip">v'+skill.version+'</span>':'')+
          '</div>'+
          '<div class="hub-skill-actions"><button class="btn btn-sm" onclick="event.stopPropagation();pullHubSkill(&quot;'+escAttr(skill.skillId)+'&quot;)">'+t('skill.pullToLocal')+'</button></div>'+
        '</div>';
      }).join(''):'';
    }

    _st('skillsTotalCount',formatNum(localHits.length+hubHits.length));
    _st('skillsActiveCount',formatNum(localHits.length));
    _st('skillsDraftCount','0');
    _st('skillsInstalledCount','-');
    _st('skillsPublicCount',formatNum(hubHits.filter(function(s){return s.visibility==='public';}).length));
    setPageSizeVisible('skillsPageSize',(localHits.length+hubHits.length)>0);
    updateSkillSelectionToolbar();
  }catch(e){
    list.innerHTML='<div style="text-align:center;padding:24px;color:var(--rose)">'+t('skills.load.error')+': '+esc(String(e))+'</div>';
    const sp=document.getElementById('skillsPagination');
    if(sp) sp.innerHTML='';
    setPageSizeVisible('skillsPageSize',false);
    if(hubList){
      hubList.innerHTML='<div style="text-align:center;padding:24px;color:var(--rose)">'+t('skills.load.error')+'</div>';
    }
  }
}

async function loadHubTasks(){
  var list=document.getElementById('tasksList');
  if(!list) return;
  currentTaskIds=[];
  selectedTaskIds.clear();
  updateTaskSelectionToolbar();
  list.innerHTML='<div class="spinner"></div>';
  try{
    var r=await fetch('/api/sharing/tasks/list?limit='+tasksPageSize);
    var d=await r.json();
    var tasks=Array.isArray(d.tasks)?d.tasks:[];
    if(activeSession){
      tasks=tasks.filter(function(task){
        return (task.sessionKey||task.session_key||'')===activeSession;
      });
    }
    hubTasksCache=tasks;
    _st('tasksTotalCount',formatNum(tasks.length));
    _st('tasksActiveCount','-');
    _st('tasksCompletedCount','-');
    _st('tasksSkippedCount','-');
    if(!tasks.length){
      list.innerHTML='<div style="text-align:center;padding:48px;color:var(--text-muted);font-size:14px">'+t('tasks.empty')+'</div>';
      document.getElementById('tasksPagination').innerHTML='';
      setPageSizeVisible('tasksPageSize',false);
      return;
    }
    list.innerHTML=tasks.map(function(task,idx){
      var timeStr=task.updatedAt?formatTime(task.updatedAt):(task.createdAt?formatTime(task.createdAt):'');
      return '<div class="task-card" onclick="openHubTaskDetailFromCache(\\x27hub\\x27,'+idx+')" style="cursor:pointer">'+
        '<div class="task-card-top">'+
          '<div class="task-card-title">'+esc(task.title||'(no title)')+'</div>'+
          '<div class="task-card-badges">'+renderScopeBadge('team')+'</div>'+
        '</div>'+
        (task.summary?'<div class="task-card-summary">'+esc(task.summary)+'</div>':'')+
        '<div class="task-card-bottom">'+
          (timeStr?'<span class="tag"><span class="icon">\\u{1F4C5}</span> '+timeStr+'</span>':'')+
          '<span class="tag"><span class="icon">\\u{1F464}</span> '+fmtOwner(task)+'</span>'+
          (task.chunkCount!=null?'<span class="tag"><span class="icon">\\u{1F4DD}</span> '+task.chunkCount+' '+t('tasks.chunks.label')+'</span>':'')+
        '</div>'+
      '</div>';
    }).join('');
    document.getElementById('tasksPagination').innerHTML='';
    setPageSizeVisible('tasksPageSize',true);
  }catch(e){
    list.innerHTML='<div style="text-align:center;padding:48px;color:var(--text-muted);font-size:14px">'+t('tasks.empty')+'</div>';
    document.getElementById('tasksPagination').innerHTML='';
    setPageSizeVisible('tasksPageSize',false);
  }
}

async function loadHubSkills(hubList, localIds){
  if(!hubList) hubList=document.getElementById('hubSkillsList');
  if(!hubList) return;
  var hubSection=document.getElementById('hubSkillsSection');
  hubList.innerHTML='<div class="spinner"></div>';
  if(hubSection) hubSection.style.display='block';
  try{
    var ctrl=new AbortController();
    var to=setTimeout(function(){try{ctrl.abort();}catch(x){}},25000);
    var r;
    try{
      r=await fetch('/api/sharing/skills/list?limit=40',{signal:ctrl.signal});
    }finally{
      clearTimeout(to);
    }
    if(!r.ok){
      var errBody='';
      try{errBody=await r.text();}catch(x2){errBody=r.statusText;}
      throw new Error(errBody||String(r.status));
    }
    const d=await r.json();
    var allSkills=Array.isArray(d.skills)?d.skills:[];
    const skills=localIds?allSkills.filter(function(s){return !localIds.has(s.sourceSkillId);}):allSkills;
    hubSkillsCache=skills;
    if(!skills.length){
      hubList.innerHTML='<div style="text-align:center;padding:32px;color:var(--text-muted);font-size:14px">'+t('skills.hub.empty')+'</div>';
      return;
    }
    hubList.innerHTML=skills.map(function(skill,idx){
      return '<div class="hub-skill-card" onclick="openHubSkillDetailFromCache(\\x27hub\\x27,'+idx+')" style="cursor:pointer">'+
        '<div class="summary">'+esc(skill.name)+'</div>'+
        '<div class="excerpt">'+esc(skill.description||'')+'</div>'+
        '<div class="hub-skill-meta">'+
          '<span class="meta-chip">owner: '+fmtOwner(skill)+'</span>'+
          (skill.groupName?'<span class="meta-chip">group: '+esc(skill.groupName)+'</span>':'')+
          '<span class="meta-chip">visibility: '+esc(skill.visibility||'hub')+'</span>'+
          (skill.version!=null?'<span class="meta-chip">v'+skill.version+'</span>':'')+
        '</div>'+
        '<div class="hub-skill-actions"><button class="btn btn-sm" onclick="event.stopPropagation();pullHubSkill(\\''+escAttr(skill.id)+'\\')">'+t('skill.pullToLocal')+'</button></div>'+
      '</div>';
    }).join('');
  }catch(e){
    var msg=String((e&&e.name==='AbortError')?t('skills.hub.timeout'):(e&&e.message)||e);
    hubList.innerHTML='<div style="text-align:center;padding:32px;color:var(--rose);font-size:13px">'+esc(t('skills.hub.loadError')+': '+msg)+'</div>';
  }
}

function parseTags(tagsStr){
  try{ const arr=JSON.parse(tagsStr||'[]'); return Array.isArray(arr)?arr:[]; }catch{ return []; }
}

let currentSkillId='';
let currentSkillDetail=null;

async function openSkillDetail(skillId){
  currentSkillId=skillId;
  const overlay=document.getElementById('skillDetailOverlay');
  overlay.classList.add('show');
  document.getElementById('skillDetailTitle').textContent=t('skills.loading');
  document.getElementById('skillDetailMeta').innerHTML='';
  document.getElementById('skillDetailDesc').textContent='';
  document.getElementById('skillFilesList').innerHTML='';
  document.getElementById('skillDetailContent').innerHTML='<div class="spinner"></div>';
  document.getElementById('skillVersionsList').innerHTML='<div class="spinner"></div>';
  document.getElementById('skillRelatedTasks').innerHTML='';
  var vb=document.getElementById('skillVisibilityBtn');if(vb)vb.style.display='';
  var db=document.getElementById('skillDownloadBtn');if(db)db.style.display='';
  var sb=document.getElementById('skillScopeBadge');if(sb)sb.innerHTML='';
  document.getElementById('skillDetailActions').innerHTML='';

  try{
    const r=await fetch('/api/skill/'+skillId);
    if(!r.ok){
      const errText=await r.text();
      throw new Error('API '+r.status+': '+errText);
    }
    const data=await r.json();
    if(!data.skill){
      throw new Error('No skill data in response: '+JSON.stringify(data).slice(0,200));
    }
    const skill=data.skill;
    const versions=data.versions||[];
    const relatedTasks=data.relatedTasks||[];
    const files=data.files||[];

    document.getElementById('skillDetailTitle').textContent='\\u{1F9E0} '+skill.name;

    const qs=skill.qualityScore;
    const qsBadge=qs!==null&&qs!==undefined?'<span class="meta-item"><span class="skill-badge quality '+(qs>=7?'high':qs>=5?'mid':'low')+'">\\u2605 '+qs.toFixed(1)+'/10</span></span>':'';
    const detailSkillIsLocalShared=skill.visibility==='public';
    const detailSkillIsTeamShared=!!skill.sharingVisibility;
    const detailSkillScope=detailSkillIsTeamShared?'team':detailSkillIsLocalShared?'local':'private';
    document.getElementById('skillDetailMeta').innerHTML=[
      '<span class="meta-item"><span class="skill-badge version">v'+skill.version+'</span></span>',
      '<span class="meta-item"><span class="skill-badge status-'+skill.status+'">'+t('skills.status.'+skill.status)+'</span></span>',
      qsBadge,
      skill.installed?'<span class="meta-item"><span class="skill-badge installed">'+t('skills.installed.badge')+'</span></span>':'',
      '<span class="meta-item">\\u{1F4C5} '+formatTime(skill.createdAt)+'</span>',
      '<span class="meta-item">\\u270F '+t('skills.updated')+formatTime(skill.updatedAt)+'</span>',
    ].filter(Boolean).join('');

    var scopeBadgeEl=document.getElementById('skillScopeBadge');
    if(scopeBadgeEl) scopeBadgeEl.innerHTML=renderScopeBadge(detailSkillScope);

    const visBtn=document.getElementById('skillVisibilityBtn');
    visBtn.className='skill-vis-btn';
    visBtn.textContent='\\u270F '+t('share.shareBtn');
    visBtn.dataset.vis=detailSkillScope;
    visBtn.style.opacity='';
    visBtn.style.cursor='';
    visBtn.style.pointerEvents='';
    if(skill.status==='active'){
      visBtn.onclick=function(){openSkillScopeModal();};
    }else{
      visBtn.style.opacity='0.45';
      visBtn.style.cursor='not-allowed';
      visBtn.style.pointerEvents='auto';
      visBtn.onclick=function(e){e.stopPropagation();toast(t('share.scope.skillNotActive'),'warn');};
    }

    document.getElementById('skillDetailDesc').textContent=skill.description;
    currentSkillDetail=skill;

    if(files.length>0){
      const fileIcons={'skill':'\\u{1F4D6}','script':'\\u{2699}','reference':'\\u{1F4CE}','file':'\\u{1F4C4}'};
      document.getElementById('skillFilesList').innerHTML=files.map(f=>
        '<div class="skill-file-item">'+
          '<span class="skill-file-icon">'+(fileIcons[f.type]||'\\u{1F4C4}')+'</span>'+
          '<span class="skill-file-name">'+esc(f.path)+'</span>'+
          '<span class="skill-file-type">'+f.type+'</span>'+
          '<span class="skill-file-size">'+(f.size>1024?(f.size/1024).toFixed(1)+'KB':f.size+'B')+'</span>'+
        '</div>'
      ).join('');
    } else {
      document.getElementById('skillFilesList').innerHTML='<div style="color:var(--text-muted);font-size:12px">'+t('skills.nofiles')+'</div>';
    }

    const latestVersion=versions[0];
    document.getElementById('skillContentTitle').textContent=latestVersion?'SKILL.md (v'+latestVersion.version+')':t('skills.content');
    document.getElementById('skillDetailContent').innerHTML=latestVersion?renderSkillMarkdown(latestVersion.content):'<span style="color:var(--text-muted)">'+t('skills.nocontent')+'</span>';

    if(versions.length===0){
      document.getElementById('skillVersionsList').innerHTML='<div style="color:var(--text-muted);font-size:13px">'+t('skills.noversions')+'</div>';
    } else {
      document.getElementById('skillVersionsList').innerHTML=versions.map(v=>{
        const vqs=v.qualityScore;
        const vqsBadge=vqs!==null&&vqs!==undefined?'<span class="skill-badge quality '+(vqs>=7?'high':vqs>=5?'mid':'low')+'">\\u2605 '+vqs.toFixed(1)+'</span>':'';
        const summaryHtml=v.changeSummary?'<div class="skill-version-summary">'+esc(v.changeSummary)+'</div>':'';
        return '<div class="skill-version-item">'+
          '<div class="skill-version-header">'+
            '<span class="skill-version-badge">v'+v.version+'</span>'+
            '<span class="skill-version-type">'+v.upgradeType+'</span>'+
            vqsBadge+
          '</div>'+
          '<div class="skill-version-changelog">'+esc(v.changelog||t('skills.nochangelog'))+'</div>'+
          summaryHtml+
          '<div class="skill-version-time">'+formatTime(v.createdAt)+(v.sourceTaskId?' \\u2022 '+t('skills.task.prefix')+v.sourceTaskId.slice(0,8)+'...':'')+'</div>'+
        '</div>';
      }).join('');
    }

    if(relatedTasks.length===0){
      document.getElementById('skillRelatedTasks').innerHTML='<div style="color:var(--text-muted);font-size:13px">'+t('skills.norelated')+'</div>';
    } else {
      document.getElementById('skillRelatedTasks').innerHTML=relatedTasks.map(rt=>
        '<div class="skill-related-task" onclick="event.stopPropagation();closeSkillDetail();switchView(\\'tasks\\');setTimeout(()=>openTaskDetail(\\''+rt.task.id+'\\'),300)">'+
          '<span class="relation">'+rt.relation+'</span>'+
          '<span class="task-title">'+esc(rt.task.title||t('tasks.untitled.related'))+'</span>'+
          '<span style="font-size:11px;color:var(--text-muted)">'+formatTime(rt.task.startedAt)+'</span>'+
        '</div>'
      ).join('');
    }

    window._currentSkillData=skill;
    var detailActionsHtml='';
    if(skill.status==='active'){
      detailActionsHtml+='<button class="btn btn-sm btn-warn" onclick="disableSkill(&quot;'+escAttr(skill.id)+'&quot;)">'+t('skills.action.disable')+'</button>';
    }else if(skill.status==='archived'){
      detailActionsHtml+='<button class="btn btn-sm btn-success" onclick="enableSkill(&quot;'+escAttr(skill.id)+'&quot;)">'+t('skills.action.enable')+'</button>';
    }
    detailActionsHtml+='<button class="btn btn-sm btn-danger" onclick="deleteSkill(&quot;'+escAttr(skill.id)+'&quot;)">'+t('skills.action.delete')+'</button>';
    document.getElementById('skillDetailActions').innerHTML=detailActionsHtml;

  }catch(e){
    document.getElementById('skillDetailTitle').textContent=t('skills.error');
    document.getElementById('skillDetailContent').innerHTML='<div style="color:var(--rose);padding:16px">'+t('skills.error.detail')+esc(String(e))+'</div>';
    document.getElementById('skillFilesList').innerHTML='';
    document.getElementById('skillVersionsList').innerHTML='';
    document.getElementById('skillRelatedTasks').innerHTML='';
  }
}

function downloadSkill(){
  if(!currentSkillId) return;
  window.open('/api/skill/'+currentSkillId+'/download','_blank');
}

async function toggleSkillVisibility(){
  if(!currentSkillId) return;
  const btn=document.getElementById('skillVisibilityBtn');
  const newVis=btn.dataset.vis==='public'?'private':'public';
  try{
    const r=await fetch('/api/skill/'+currentSkillId+'/visibility',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({visibility:newVis})});
    if(!r.ok){var errBody='';try{var ej=await r.json();errBody=ej.error||JSON.stringify(ej);}catch(x){errBody=await r.text();}throw new Error(r.status+': '+errBody);}
    openSkillDetail(currentSkillId);
    loadSkills();
  }catch(e){
    toast('Error: '+e.message,'error');
  }
}

async function toggleSkillPublic(id,setPublic){
  const newVis=setPublic?'public':'private';
  try{
    const r=await fetch('/api/skill/'+id+'/visibility',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({visibility:newVis})});
    if(!r.ok){var errBody='';try{var ej=await r.json();errBody=ej.error||JSON.stringify(ej);}catch(x){errBody=await r.text();}throw new Error(r.status+': '+errBody);}
    toast(setPublic?t('toast.setPublic'):t('toast.setPrivate'),'success');
    loadSkills();
  }catch(e){
    toast('Error: '+e.message,'error');
  }
}

/* ─── Model Health Status ─── */

const HEALTH_ROLE_LABELS={
  'embedding':'Embedding',
  'summarize':'Summarizer',
  'filterRelevant':'Memory Filter',
  'judgeDedup':'Dedup Judge',
  'summarizeTask':'Task Summarizer',
  'judgeNewTopic':'Topic Judge'
};

function classifyError(msg){
  if(!msg) return '';
  if(msg.indexOf('\u989D\u5EA6\u5DF2\u7528\u5C3D')>=0||msg.indexOf('quota')>=0||msg.indexOf('RemainQuota')>=0) return 'API quota exhausted';
  if(msg.indexOf('401')>=0||msg.indexOf('Unauthorized')>=0) return 'Auth failed (401)';
  if(msg.indexOf('timeout')>=0||msg.indexOf('Timeout')>=0) return 'Request timed out';
  if(msg.indexOf('429')>=0) return 'Rate limited (429)';
  if(msg.indexOf('ECONNREFUSED')>=0) return 'Connection refused';
  if(msg.indexOf('ENOTFOUND')>=0) return 'DNS resolution failed';
  if(msg.indexOf('403')>=0) return 'Forbidden (403)';
  if(msg.indexOf('503')>=0||msg.indexOf('upstream connect error')>=0||msg.indexOf('Service Unavailable')>=0) return 'Service unavailable (503)';
  if(msg.indexOf('502')>=0||msg.indexOf('Bad Gateway')>=0) return 'Bad gateway (502)';
  if(msg.indexOf('500')>=0||msg.indexOf('Internal Server Error')>=0) return 'Server error (500)';
  if(msg.indexOf('404')>=0||msg.indexOf('Not Found')>=0) return 'Not found (404)';
  if(msg.indexOf('fetch failed')>=0||msg.indexOf('ETIMEDOUT')>=0) return 'Network error';
  if(msg.indexOf('Unknown')>=0&&msg.indexOf('provider')>=0) return 'Unknown provider';
  var m=msg.match(/\((\d{3})\)/); if(m) return 'HTTP error ('+m[1]+')';
  return msg.length>80?msg.substring(0,77)+'...':msg;
}

function shortenModel(s){return s?s.replace('openai_compatible/','').replace('openai/',''):'\u2014';}

async function loadModelHealth(){
  var bar=document.getElementById('modelHealthBar');
  if(!bar) return;
  try{
    var r=await fetch('/api/model-health');
    if(!r.ok){bar.innerHTML='<div class="mh-empty">Health data unavailable</div>';return;}
    var d=await r.json();
    var models=d.models||[];
    if(models.length===0){
      bar.innerHTML='<div class="mh-empty">No model calls recorded yet</div>';
      return;
    }
    var order=['embedding','summarize','filterRelevant','judgeDedup','summarizeTask','judgeNewTopic'];
    models.sort(function(a,b){var ai=order.indexOf(a.role),bi=order.indexOf(b.role);if(ai<0)ai=99;if(bi<0)bi=99;return ai-bi;});

    var h='<table class="mh-table"><thead><tr>';
    h+='<th style="width:30px"></th><th>Role</th><th>Status</th><th>Model</th><th>Issue</th><th style="text-align:right">Updated</th>';
    h+='</tr></thead><tbody>';

    for(var i=0;i<models.length;i++){
      var m=models[i];
      var st=m.status||'unknown';
      var label=HEALTH_ROLE_LABELS[m.role]||m.role;
      var badgeText=st==='ok'?'OK':st==='degraded'?'Degraded':st==='error'?'Error':'\u2014';
      var ago='';
      if(st==='ok'&&m.lastSuccess) ago=timeAgo(m.lastSuccess);
      else if(m.lastError) ago=timeAgo(m.lastError);

      h+='<tr>';
      h+='<td><span class="mh-dot '+st+'"></span></td>';
      h+='<td><span style="font-weight:500">'+escapeHtml(label)+'</span></td>';
      h+='<td><span class="mh-badge '+st+'">'+badgeText+'</span></td>';
      h+='<td><span class="mh-model-name">'+escapeHtml(shortenModel(m.model))+'</span></td>';

      var issue='';
      if((st==='error'||st==='degraded')&&m.lastErrorMessage){
        var shortErr=classifyError(m.lastErrorMessage);
        if(m.failedModel&&m.failedModel!==m.model) issue=shortenModel(m.failedModel)+': ';
        issue+=shortErr;
        if(m.consecutiveErrors>1) issue+=' ('+m.consecutiveErrors+'x)';
      }
      if(issue) h+='<td><span class="mh-err-text" data-err="'+escapeHtml(m.lastErrorMessage||'')+'">'+escapeHtml(issue)+'</span></td>';
      else h+='<td><span style="color:var(--text-muted);font-size:11px">\u2014</span></td>';

      h+='<td style="text-align:right"><span class="mh-time">'+(ago||'\u2014')+'</span></td>';
      h+='</tr>';
    }
    h+='</tbody></table>';
    bar.innerHTML=h;
    initMhTooltips();
  }catch(e){
    bar.innerHTML='<div class="mh-empty">Failed to load model health</div>';
  }
}

function initMhTooltips(){
  var tip=document.getElementById('mhTooltip');
  if(!tip){tip=document.createElement('div');tip.id='mhTooltip';document.body.appendChild(tip);}
  document.querySelectorAll('.mh-err-text[data-err]').forEach(function(el){
    el.addEventListener('mouseenter',function(e){
      var msg=el.getAttribute('data-err');
      if(!msg)return;
      tip.textContent=msg;
      tip.style.display='block';
      var rect=el.getBoundingClientRect();
      tip.style.left=Math.max(0,Math.min(rect.left,window.innerWidth-490))+'px';
      tip.style.top=(rect.bottom+6)+'px';
    });
    el.addEventListener('mouseleave',function(){tip.style.display='none';});
  });
}

function timeAgo(ts){
  var diff=Date.now()-ts;
  if(diff<60000) return 'just now';
  if(diff<3600000) return Math.floor(diff/60000)+'m ago';
  if(diff<86400000) return Math.floor(diff/3600000)+'h ago';
  return Math.floor(diff/86400000)+'d ago';
}

/* ─── Settings / Config ─── */
function syncHostToggles(){}
function onProviderChange(){}

async function loadConfig(){
  try{
    const r=await fetch('/api/config');
    if(!r.ok) return;
    const cfg=await r.json();
    const emb=cfg.embedding||{};
    document.getElementById('cfgEmbProvider').value=emb.provider||'openai_compatible';
    document.getElementById('cfgEmbModel').value=emb.model||'';
    document.getElementById('cfgEmbEndpoint').value=emb.endpoint||'';
    document.getElementById('cfgEmbApiKey').value=emb.apiKey||'';

    const sum=cfg.summarizer||{};
    document.getElementById('cfgSumProvider').value=sum.provider||'openai_compatible';
    document.getElementById('cfgSumModel').value=sum.model||'';
    document.getElementById('cfgSumEndpoint').value=sum.endpoint||'';
    document.getElementById('cfgSumApiKey').value=sum.apiKey||'';
    document.getElementById('cfgSumTemp').value=sum.temperature!=null?sum.temperature:'';

    const sk=cfg.skillEvolution||{};
    document.getElementById('cfgSkillEnabled').checked=sk.enabled!==false;
    document.getElementById('cfgSkillAutoInstall').checked=!!sk.autoInstall;
    document.getElementById('cfgSkillConfidence').value=sk.minConfidence||'';
    document.getElementById('cfgSkillMinChunks').value=sk.minChunksForEval||'';

    const skSum=sk.summarizer||{};
    document.getElementById('cfgSkillProvider').value=skSum.provider||'';
    document.getElementById('cfgSkillModel').value=skSum.model||'';
    document.getElementById('cfgSkillEndpoint').value=skSum.endpoint||'';
    document.getElementById('cfgSkillApiKey').value=skSum.apiKey||'';

    document.getElementById('cfgViewerPort').value=cfg.viewerPort||'';
    document.getElementById('cfgTaskAutoFinalizeHours').value=cfg.taskAutoFinalizeHours!=null?cfg.taskAutoFinalizeHours:'';

    const tel=cfg.telemetry||{};
    document.getElementById('cfgTelemetryEnabled').checked=tel.enabled!==false;

    const sharing=cfg.sharing||{};
    const caps=sharing.capabilities||{};
    const embProv=(cfg.embedding||{}).provider;
    const sumProv=(cfg.summarizer||{}).provider;
    const skProv=((cfg.skillEvolution||{}).summarizer||{}).provider;
    

    document.getElementById('cfgSharingEnabled').checked=!!sharing.enabled;
    _sharingRole=sharing.role||'client';
    var hub=sharing.hub||{};
    var client=sharing.client||{};
    document.getElementById('cfgHubPort').value=hub.port||18800;
    document.getElementById('cfgHubTeamName').value=hub.teamName||'';
    document.getElementById('cfgHubTeamToken').value=hub.teamToken||'';
    document.getElementById('cfgClientHubAddress').value=client.hubAddress||'';
    _loadedClientHubAddress=client.hubAddress||'';
    document.getElementById('cfgClientTeamToken').value=client.teamToken||'';
    var hubUsername=sharingStatusCache&&sharingStatusCache.connection&&sharingStatusCache.connection.user&&sharingStatusCache.connection.user.username;
    document.getElementById('cfgClientNickname').value=hubUsername||client.nickname||'';
    document.getElementById('cfgClientUserToken').value=client.userToken||'';
    onSharingToggle();
    updateHubShareInfo();
  }catch(e){
    console.error('loadConfig error',e);
  }
}

var _providerDefaults={
  siliconflow:{endpoint:'https://api.siliconflow.cn/v1',embModel:'BAAI/bge-m3',chatModel:'Qwen/Qwen2.5-7B-Instruct'},
  openai:{endpoint:'https://api.openai.com/v1',embModel:'text-embedding-3-small',chatModel:'gpt-4o-mini'},
  anthropic:{endpoint:'https://api.anthropic.com/v1/messages',chatModel:'claude-3-haiku-20240307'},
  cohere:{endpoint:'https://api.cohere.com/v2',embModel:'embed-english-v3.0'},
  mistral:{endpoint:'https://api.mistral.ai/v1',embModel:'mistral-embed'},
  voyage:{endpoint:'https://api.voyageai.com/v1',embModel:'voyage-3'},
  gemini:{endpoint:'',embModel:'text-embedding-004',chatModel:'gemini-2.0-flash'},
  zhipu:{endpoint:'https://open.bigmodel.cn/api/paas/v4',embModel:'embedding-3',chatModel:'glm-4-flash'},
  deepseek:{endpoint:'https://api.deepseek.com/v1',chatModel:'deepseek-chat'},
  bailian:{endpoint:'https://dashscope.aliyuncs.com/compatible-mode/v1',embModel:'text-embedding-v3',chatModel:'qwen-max'},
  moonshot:{endpoint:'https://api.moonshot.cn/v1',chatModel:'moonshot-v1-8k'}
};
function onProviderChange(section){
  var map={embedding:['cfgEmbEndpoint','cfgEmbModel','emb'],summarizer:['cfgSumEndpoint','cfgSumModel','chat'],skill:['cfgSkillEndpoint','cfgSkillModel','chat']};
  var m=map[section];if(!m)return;
  var sel=document.getElementById(section==='embedding'?'cfgEmbProvider':section==='summarizer'?'cfgSumProvider':'cfgSkillProvider');
  var pv=sel.value;
  var def=_providerDefaults[pv];
  if(!def)return;
  var epEl=document.getElementById(m[0]);
  var mdEl=document.getElementById(m[1]);
  if(def.endpoint&&!epEl.value.trim()) epEl.value=def.endpoint;
  if(m[2]==='emb'&&def.embModel&&!mdEl.value.trim()) mdEl.value=def.embModel;
  if(m[2]==='chat'&&def.chatModel&&!mdEl.value.trim()) mdEl.value=def.chatModel;
}

function flashSaved(id){
  var el=document.getElementById(id);
  if(!el)return;
  el.classList.add('show');
  setTimeout(function(){el.classList.remove('show');},2500);
}

async function doSaveConfig(cfg, btnEl, savedId){
  if(btnEl){btnEl.disabled=true;btnEl.textContent=t('settings.test.loading');}
  function done(){if(btnEl){btnEl.disabled=false;btnEl.textContent=t('settings.save');}}
  try{
    const r=await fetch('/api/config',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(cfg)});
    if(r.status===401){done();toast(t('settings.session.expired'),'error');return null;}
    if(!r.ok) throw new Error(await r.text());
    var data=await r.json().catch(function(){return {ok:true};});
    flashSaved(savedId);
    if(data&&data.restart){
      showRestartOverlay(t('settings.restart.waiting'));
    }else{
      done();
    }
    return data;
  }catch(e){
    toast(t('settings.save.fail')+': '+e.message,'error');
    done();
    return null;
  }
}

async function saveModelsConfig(){
  var card=document.querySelector('.card-models');
  var saveBtn=card.querySelector('.settings-actions .btn-primary');
  saveBtn.disabled=true;saveBtn.textContent=t('settings.test.loading');
  function done(){saveBtn.disabled=false;saveBtn.textContent=t('settings.save');}

  const cfg={};
  const embP=document.getElementById('cfgEmbProvider').value;
  if(embP){
    cfg.embedding={provider:embP};
    const v=document.getElementById('cfgEmbModel').value.trim();if(v) cfg.embedding.model=v;
    const e=document.getElementById('cfgEmbEndpoint').value.trim();if(e) cfg.embedding.endpoint=e;
    const k=document.getElementById('cfgEmbApiKey').value.trim();if(k) cfg.embedding.apiKey=k;
  }
  const sumP=document.getElementById('cfgSumProvider').value;
  const sumModel=document.getElementById('cfgSumModel').value.trim();
  const sumEndpoint=document.getElementById('cfgSumEndpoint').value.trim();
  const sumApiKey=document.getElementById('cfgSumApiKey').value.trim();
  var hasSumConfig=!!(sumModel||sumEndpoint||sumApiKey);
  if(hasSumConfig&&sumP){
    cfg.summarizer={provider:sumP};
    if(sumModel) cfg.summarizer.model=sumModel;
    if(sumEndpoint) cfg.summarizer.endpoint=sumEndpoint;
    if(sumApiKey) cfg.summarizer.apiKey=sumApiKey;
    const tp=document.getElementById('cfgSumTemp').value.trim();if(tp!=='') cfg.summarizer.temperature=Number(tp);
  }
  cfg.skillEvolution={
    enabled:document.getElementById('cfgSkillEnabled').checked,
    autoInstall:document.getElementById('cfgSkillAutoInstall').checked
  };
  const mc=document.getElementById('cfgSkillConfidence').value.trim();if(mc) cfg.skillEvolution.minConfidence=Number(mc);
  const mk=document.getElementById('cfgSkillMinChunks').value.trim();if(mk) cfg.skillEvolution.minChunksForEval=Number(mk);

  const skP=document.getElementById('cfgSkillProvider').value;
  const skModel=document.getElementById('cfgSkillModel').value.trim();
  const skEndpoint=document.getElementById('cfgSkillEndpoint').value.trim();
  const skApiKey=document.getElementById('cfgSkillApiKey').value.trim();
  var hasSkillConfig=!!(skP&&(skModel||skEndpoint||skApiKey));
  if(hasSkillConfig){
    cfg.skillEvolution.summarizer={provider:skP};
    if(skModel) cfg.skillEvolution.summarizer.model=skModel;
    if(skEndpoint) cfg.skillEvolution.summarizer.endpoint=skEndpoint;
    if(skApiKey) cfg.skillEvolution.summarizer.apiKey=skApiKey;
  }

  if(!embP||embP===''){done();toast(t('settings.save.emb.required'),'error');return;}

  try{
    var er=await fetch('/api/test-model',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({type:'embedding',provider:cfg.embedding.provider,model:cfg.embedding.model||'',endpoint:cfg.embedding.endpoint||'',apiKey:cfg.embedding.apiKey||''})});
    if(er.status===401){done();toast(t('settings.session.expired'),'error');return;}
    var ed=await er.json();
    if(!ed.ok){done();toast(t('settings.save.emb.fail')+': '+ed.error,'error');document.getElementById('testEmbResult').className='test-result fail';document.getElementById('testEmbResult').innerHTML='\\u274C '+ed.error;return;}
    document.getElementById('testEmbResult').className='test-result ok';document.getElementById('testEmbResult').innerHTML='\\u2705 '+t('settings.test.ok');
  }catch(e){done();toast(t('settings.save.emb.fail')+': '+e.message,'error');return;}

  if(hasSumConfig&&cfg.summarizer){
    try{
      var sr=await fetch('/api/test-model',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({type:'summarizer',provider:cfg.summarizer.provider,model:cfg.summarizer.model||'',endpoint:cfg.summarizer.endpoint||'',apiKey:cfg.summarizer.apiKey||''})});
      if(sr.status===401){done();toast(t('settings.session.expired'),'error');return;}
      var sd=await sr.json();
      if(!sd.ok){done();toast(t('settings.save.sum.fail')+': '+sd.error,'error');document.getElementById('testSumResult').className='test-result fail';document.getElementById('testSumResult').innerHTML='\\u274C '+sd.error;return;}
      document.getElementById('testSumResult').className='test-result ok';document.getElementById('testSumResult').innerHTML='\\u2705 '+t('settings.test.ok');
    }catch(e){done();toast(t('settings.save.sum.fail')+': '+e.message,'error');return;}
  }

  if(hasSkillConfig&&cfg.skillEvolution.summarizer){
    try{
      var kr=await fetch('/api/test-model',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({type:'summarizer',provider:cfg.skillEvolution.summarizer.provider,model:cfg.skillEvolution.summarizer.model||'',endpoint:cfg.skillEvolution.summarizer.endpoint||'',apiKey:cfg.skillEvolution.summarizer.apiKey||''})});
      if(kr.status===401){done();toast(t('settings.session.expired'),'error');return;}
      var kd=await kr.json();
      if(!kd.ok){done();toast(t('settings.save.skill.fail')+': '+kd.error,'error');document.getElementById('testSkillResult').className='test-result fail';document.getElementById('testSkillResult').innerHTML='\\u274C '+kd.error;return;}
      document.getElementById('testSkillResult').className='test-result ok';document.getElementById('testSkillResult').innerHTML='\\u2705 '+t('settings.test.ok');
    }catch(e){done();toast(t('settings.save.skill.fail')+': '+e.message,'error');return;}
  }

  if(!hasSumConfig||!hasSkillConfig){
    try{
      var fr=await fetch('/api/fallback-model');
      var fb=await fr.json();
      var msgs=[];
      if(!hasSumConfig){msgs.push(t('settings.save.sum.fallback'));}
      if(!hasSkillConfig){msgs.push(t('settings.save.skill.fallback'));}
      var fbInfo=fb.available?(fb.model+' ('+fb.baseUrl+')'):t('settings.save.fallback.none');
      var confirmMsg=msgs.join('\\n')+'\\n\\n'+t('settings.save.fallback.model')+fbInfo+'\\n\\n'+t('settings.save.fallback.confirm');
      if(!(await confirmModal(confirmMsg))){done();return;}
    }catch(e){}
  }

  await doSaveConfig(cfg, saveBtn, 'modelsSaved');
}

function _hubSaveBtnLabel(){
  var on=document.getElementById('cfgSharingEnabled');
  if(on&&on.checked&&_sharingRole==='client'){
    var prevClient=sharingStatusCache&&sharingStatusCache.enabled&&sharingStatusCache.role==='client';
    return prevClient?t('settings.save'):t('sharing.joinTeam');
  }
  return t('settings.save');
}
async function saveHubConfig(){
  var card=document.getElementById('settingsSharingConfig');
  var saveBtn=card.querySelector('.settings-actions .btn-primary');
  saveBtn.disabled=true;saveBtn.textContent=t('settings.test.loading');
  function done(){saveBtn.disabled=false;saveBtn.textContent=_hubSaveBtnLabel();}

  const cfg={};
  var sharingEnabled=document.getElementById('cfgSharingEnabled').checked;
  cfg.sharing={
    enabled:sharingEnabled,
    role:_sharingRole,
    capabilities:{}
  };
  if(sharingEnabled&&_sharingRole==='hub'){
    var hubPort=document.getElementById('cfgHubPort').value.trim();
    var hubTeamName=document.getElementById('cfgHubTeamName').value.trim();
    var hubTeamToken=document.getElementById('cfgHubTeamToken').value.trim();
    var hubAdminName=document.getElementById('cfgHubAdminName').value.trim();
    if(hubPort) cfg.sharing.hub={port:Number(hubPort)}; else cfg.sharing.hub={};
    if(hubTeamName) cfg.sharing.hub.teamName=hubTeamName;
    if(hubTeamToken) cfg.sharing.hub.teamToken=hubTeamToken;
    cfg.sharing.client={hubAddress:'',userToken:'',teamToken:''};
  }
  if(sharingEnabled&&_sharingRole==='client'){
    var clientAddr=document.getElementById('cfgClientHubAddress').value.trim();
    var clientTeamToken=document.getElementById('cfgClientTeamToken').value.trim();
    var clientUserToken=document.getElementById('cfgClientUserToken').value.trim();
    var clientNickname=document.getElementById('cfgClientNickname').value.trim();
    if(!clientAddr){done();toast(t('settings.hub.test.noAddr'),'error');return;}
    if(!clientTeamToken){done();toast(t('settings.hub.teamToken.required'),'error');return;}
    cfg.sharing.client={};
    if(clientAddr) cfg.sharing.client.hubAddress=clientAddr;
    if(clientNickname) cfg.sharing.client.nickname=clientNickname;
    if(clientTeamToken) cfg.sharing.client.teamToken=clientTeamToken;
    if(clientUserToken) cfg.sharing.client.userToken=clientUserToken;
    cfg.sharing.hub={teamName:'',teamToken:''};
    if(clientAddr){
      try{
        var testUrl=clientAddr.indexOf('://')>-1?clientAddr:'http://'+clientAddr;
        testUrl=testUrl.replace(/\\/+$/,'');
        var tr=await fetch('/api/sharing/test-hub',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({hubUrl:testUrl,teamToken:clientTeamToken,nickname:clientNickname})});
        var td=await tr.json();
        if(!td.ok){
          if(td.error==='cannot_join_self'){done();alertModal(t('sharing.cannotJoinSelf'));return;}
          if(td.error==='username_taken'){done();alertModal(t('sharing.joinError.usernameTaken'));return;}
          if(td.error==='invalid_team_token'){done();alertModal(t('sharing.joinError.invalidToken'));return;}
          done();alertModal(td.error||t('settings.hub.test.fail'));return;
        }
      }catch(e){
        done();alertModal(t('sharing.joinError.hubUnreachable'));return;
      }
    }
  }

  var prevSharingEnabled=sharingStatusCache&&sharingStatusCache.enabled;
  var prevRole=sharingStatusCache&&sharingStatusCache.role;
  if(prevSharingEnabled&&!sharingEnabled){
    var confirmMsg=prevRole==='hub'?t('sharing.disable.confirm.hub'):t('sharing.disable.confirm.client');
    if(!(await confirmModal(confirmMsg,{danger:true}))){done();return;}
  }
  if(prevSharingEnabled&&sharingEnabled&&prevRole&&prevRole!==_sharingRole){
    var switchMsg=prevRole==='hub'?t('sharing.switch.hubToClient'):t('sharing.switch.clientToHub');
    if(!(await confirmModal(switchMsg,{danger:true}))){done();return;}
  }
  if(prevSharingEnabled&&sharingEnabled&&prevRole==='client'&&_sharingRole==='client'){
    var newAddr=(document.getElementById('cfgClientHubAddress').value||'').trim();
    if(_loadedClientHubAddress&&newAddr&&newAddr!==_loadedClientHubAddress){
      if(!(await confirmModal(t('sharing.switch.hubAddress'),{danger:true}))){done();return;}
    }
  }

  var result=await doSaveConfig(cfg, saveBtn, 'hubSaved');
  if(result){
    if(sharingEnabled&&_sharingRole==='hub'){
      var adminNameEl=document.getElementById('cfgHubAdminName');
      if(adminNameEl&&adminNameEl.value.trim()){
        try{await fetch('/api/sharing/update-username',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:adminNameEl.value.trim()})});}catch(e){}
      }
    }
    if(sharingEnabled&&_sharingRole==='client'&&result.joinError){
      if(result.joinError==='hub_unreachable'){
        alertModal(t('sharing.joinError.hubUnreachable'));
      }else if(result.joinError==='username_taken'){
        alertModal(t('sharing.joinError.usernameTaken'));
      }else if(result.joinError==='invalid_team_token'){
        alertModal(t('sharing.joinError.invalidToken'));
      }else{
        toast(t('sharing.retryJoin.fail'),'error');
      }
    }else if(sharingEnabled&&_sharingRole==='client'&&result.joinStatus){
      if(result.joinStatus==='pending'){
        toast(t('sharing.joinSent.pending'),'success');
      }else if(result.joinStatus==='active'){
        toast(t('sharing.joinSent.active'),'success');
      }else{
        toast(t('settings.saved'),'success');
      }
    }else{
      toast(t('settings.saved'),'success');
    }
    _lastSidebarFingerprint='';
    _lastSettingsFingerprint='';
    _lastSharingConnStatus='';
    _lastAdminFingerprint='';
    _lastAdminStatsFp='';
    if(sharingEnabled) updateHubShareInfo();
    loadSharingStatus(true);
    if(_activeView==='admin') loadAdminData();
  }
}

async function saveGeneralConfig(){
  var card=document.querySelector('.card-general');
  var saveBtn=card.querySelector('.settings-actions .btn-primary');

  const cfg={};
  const vp=document.getElementById('cfgViewerPort').value.trim();
  if(vp) cfg.viewerPort=Number(vp);
  const tafh=document.getElementById('cfgTaskAutoFinalizeHours').value.trim();
  cfg.taskAutoFinalizeHours=tafh!==''?Math.max(0,Number(tafh)):4;
  cfg.telemetry={enabled:document.getElementById('cfgTelemetryEnabled').checked};

  await doSaveConfig(cfg, saveBtn, 'generalSaved');
}

async function saveConfig(){
  await saveModelsConfig();
}

async function testModel(type){
  var ids={embedding:['Emb','cfgEmbProvider','cfgEmbModel','cfgEmbEndpoint','cfgEmbApiKey'],summarizer:['Sum','cfgSumProvider','cfgSumModel','cfgSumEndpoint','cfgSumApiKey'],skill:['Skill','cfgSkillProvider','cfgSkillModel','cfgSkillEndpoint','cfgSkillApiKey']};
  var c=ids[type];if(!c)return;
  var resultEl=document.getElementById('test'+c[0]+'Result');
  var btn=document.getElementById('test'+c[0]+'Btn');
  var provider=document.getElementById(c[1]).value;
  var model=document.getElementById(c[2]).value.trim();
  var endpoint=document.getElementById(c[3]).value.trim();
  var apiKey=document.getElementById(c[4]).value.trim();
  if(!provider||(provider!=='local'&&!model)){
    resultEl.className='test-result fail';
    resultEl.innerHTML='\\u274C '+t('settings.test.fail')+'<div style="margin-top:4px;font-size:11px;color:var(--text-muted)">Provider and Model are required</div>';
    return;
  }
  if(provider!=='local'&&!apiKey){
    resultEl.className='test-result fail';
    resultEl.innerHTML='\\u274C '+t('settings.test.fail')+'<div style="margin-top:4px;font-size:11px;color:var(--text-muted)">API Key is required</div>';
    return;
  }
  resultEl.className='test-result loading';resultEl.textContent=t('settings.test.loading');
  btn.disabled=true;
  try{
    var body={type:type,provider:provider,model:model,endpoint:endpoint,apiKey:apiKey};
    var r=await fetch('/api/test-model',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
    if(r.status===401){resultEl.className='test-result fail';resultEl.innerHTML='\\u274C '+t('settings.session.expired');btn.disabled=false;return;}
    var d=await r.json();
    if(d.ok){
      resultEl.className='test-result ok';
      resultEl.innerHTML='\\u2705 '+t('settings.test.ok')+(d.detail?'<div style="margin-top:4px;font-size:11px;color:var(--text-muted)">'+esc(d.detail)+'</div>':'');
    }else{
      var errMsg=(d.error||'Unknown error').replace(/:\s*$/,'').trim();
      resultEl.className='test-result fail';
      resultEl.innerHTML='\\u274C '+t('settings.test.fail')+(errMsg?'<div style="margin-top:6px;font-size:11px;padding:8px 10px;background:rgba(239,68,68,.06);border:1px solid rgba(239,68,68,.15);border-radius:6px;white-space:pre-wrap;word-break:break-all;max-height:120px;overflow-y:auto;font-family:SF Mono,Monaco,Consolas,monospace">'+esc(errMsg)+'</div>':'');
    }
  }catch(e){
    var catchMsg=(e.message||'Network error').replace(/:\s*$/,'').trim();
    resultEl.className='test-result fail';
    resultEl.innerHTML='\\u274C '+t('settings.test.fail')+(catchMsg?'<div style="margin-top:6px;font-size:11px;padding:8px 10px;background:rgba(239,68,68,.06);border:1px solid rgba(239,68,68,.15);border-radius:6px;white-space:pre-wrap;word-break:break-all">'+esc(catchMsg)+'</div>':'');
  }finally{btn.disabled=false;}
}

function renderSkillMarkdown(md){
  let content=md;
  // Strip YAML frontmatter
  content=content.replace(/^---[\\s\\S]*?---\\s*/,'');
  // Code blocks
  content=content.replace(/\`\`\`(\\w*)\\n([\\s\\S]*?)\`\`\`/g,function(_,lang,code){
    return '<pre style="background:rgba(0,0,0,.3);border:1px solid var(--border);border-radius:8px;padding:12px 16px;overflow-x:auto;font-size:12px;line-height:1.5;font-family:SF Mono,Monaco,Consolas,monospace"><code>'+esc(code.trim())+'</code></pre>';
  });
  // Inline code
  content=content.replace(/\`([^\`]+)\`/g,'<code style="background:rgba(139,92,246,.1);color:var(--violet);padding:1px 6px;border-radius:4px;font-size:12px">$1</code>');
  // Headers
  content=content.replace(/^### (.+)$/gm,'<div class="summary-section-title" style="font-size:13px;margin-top:12px">$1</div>');
  content=content.replace(/^## (.+)$/gm,'<div class="summary-section-title">$1</div>');
  content=content.replace(/^# (.+)$/gm,'<div style="font-size:16px;font-weight:700;color:var(--text);margin:8px 0">$1</div>');
  // Bold
  content=content.replace(/\\*\\*(.+?)\\*\\*/g,'<strong>$1</strong>');
  // List items
  content=content.replace(/^- (.+)$/gm,'<div style="padding-left:16px;position:relative;margin:3px 0"><span style="position:absolute;left:4px;color:var(--text-muted)">•</span>$1</div>');
  // HTML comments (version markers)
  content=content.replace(/<!--[\\s\\S]*?-->/g,'');
  // Line breaks
  content=content.replace(/\\n\\n/g,'<div style="height:10px"></div>');
  content=content.replace(/\\n/g,'<br>');
  return content;
}

function closeSkillDetail(event){
  if(event && event.target!==document.getElementById('skillDetailOverlay')) return;
  document.getElementById('skillDetailOverlay').classList.remove('show');
  currentSkillId='';
  currentSkillDetail=null;
}

async function deleteSkill(skillId){
  if(!(await confirmModal(t('skill.delete.confirm'),{danger:true}))) return;
  try{
    const r=await fetch('/api/skill/'+skillId,{method:'DELETE'});
    const d=await r.json();
    if(!r.ok) throw new Error(d.error||'unknown');
    selectedSkillIds.delete(skillId);
    updateSkillSelectionToolbar();
    closeSkillDetail();
    document.getElementById('skillDetailOverlay').classList.remove('show');
    loadSkills();
  }catch(e){ alert(t('skill.delete.error')+e.message); }
}
async function disableSkill(skillId){
  if(!(await confirmModal(t('skills.disable.confirm')))) return;
  try{
    const r=await fetch('/api/skill/'+skillId+'/disable',{method:'PUT'});
    const d=await r.json();
    if(!r.ok) throw new Error(d.error||'unknown');
    toast(t('skills.action.disable')+' ✓','ok');
    closeSkillDetail();
    document.getElementById('skillDetailOverlay').classList.remove('show');
    loadSkills();
  }catch(e){ alert(t('skills.disable.error')+e.message); }
}
async function enableSkill(skillId){
  try{
    const r=await fetch('/api/skill/'+skillId+'/enable',{method:'PUT'});
    const d=await r.json();
    if(!r.ok) throw new Error(d.error||'unknown');
    toast(t('skills.action.enable')+' ✓','ok');
    closeSkillDetail();
    document.getElementById('skillDetailOverlay').classList.remove('show');
    loadSkills();
  }catch(e){ alert(t('skills.enable.error')+e.message); }
}

async function deleteSelectedSkills(){
  var ids=Array.from(selectedSkillIds);
  if(ids.length===0) return;
  var msg=t('skill.delete.selected.confirm').replace('{count}',String(ids.length));
  if(!(await confirmModal(msg,{danger:true}))) return;
  var ok=0;
  var fail=0;
  for(var i=0;i<ids.length;i++){
    try{
      var r=await fetch('/api/skill/'+ids[i],{method:'DELETE'});
      var d=await r.json();
      if(!r.ok) throw new Error(d.error||'unknown');
      ok++;
    }catch(e){
      fail++;
    }
  }
  selectedSkillIds.clear();
  updateSkillSelectionToolbar();
  loadSkills();
  if(fail>0) toast(t('skill.delete.partial').replace('{ok}',String(ok)).replace('{fail}',String(fail)),'warn');
  else toast(t('skill.delete.success').replace('{count}',String(ok)),'success');
}


function formatDuration(ms){
  const s=Math.floor(ms/1000);
  if(s<60) return s+'s';
  const m=Math.floor(s/60);
  if(m<60) return m+'min';
  const h=Math.floor(m/60);
  if(h<24) return h+'h '+((m%60)>0?(m%60)+'min':'');
  const d=Math.floor(h/24);
  return d+'d '+((h%24)>0?(h%24)+'h':'');
}

function formatTime(ts){
  if(!ts) return '-';
  return new Date(ts).toLocaleString(dateLoc(),{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'});
}

function formatDateTimeSeconds(ts){
  if(!ts) return '-';
  return new Date(ts).toLocaleString(dateLoc(),{
    year:'numeric',
    month:'2-digit',
    day:'2-digit',
    hour:'2-digit',
    minute:'2-digit',
    second:'2-digit',
    hour12:false
  });
}

function fillDays(rows,days){
  const map=new Map((rows||[]).map(r=>[r.date,{...r}]));
  const out=[];const now=new Date();
  for(let i=days-1;i>=0;i--){
    const d=new Date(now);d.setDate(d.getDate()-i);
    const dateStr=d.toISOString().slice(0,10);
    const row=map.get(dateStr)||{};
    out.push({date:dateStr,count:row.count??0,list:row.list??0,search:row.search??0,total:(row.list??0)+(row.search??0)});
  }
  if(days>60){
    const weeks=[];let i=0;
    while(i<out.length){
      const chunk=out.slice(i,i+7);
      const first=chunk[0].date,last=chunk[chunk.length-1].date;
      const c=chunk.reduce((s,r)=>s+r.count,0);
      const l=chunk.reduce((s,r)=>s+r.list,0);
      const se=chunk.reduce((s,r)=>s+r.search,0);
      const label=first.slice(5,10)+'~'+last.slice(8,10);
      weeks.push({date:label,count:c,list:l,search:se,total:l+se});
      i+=7;
    }
    return weeks;
  }
  return out;
}

function renderBars(el,data,valueKey,H){
  var vals=data.map(function(d){return d[valueKey]??0;});
  if(vals.every(function(v){return v===0;})){el.innerHTML='<div style="color:var(--text-muted);font-size:13px;padding:40px;text-align:center">'+t('chart.nodata')+'</div>';return;}
  var max=Math.max(1,Math.max.apply(null,vals));
  var n=data.length;
  var labelStep=n<=7?1:(n<=14?2:5);
  el.innerHTML=data.map(function(r,idx){
    var v=r[valueKey]??0;
    var rawDate=r.date.includes('~')?r.date:(r.date.length>5?r.date.slice(5):'');
    var showLabel=(idx%labelStep===0)||(idx===n-1);
    var label=showLabel?rawDate:'';
    var tipDate=r.date.length>=10?r.date.slice(5,10):'';
    var tipText=tipDate?(tipDate+': '+v):(''+v);
    if(v===0){
      return '<div class="chart-bar-wrap"><div class="chart-tip">'+tipText+'</div><div class="chart-bar-col"><div class="chart-bar zero" style="height:3px"></div></div><div class="chart-bar-label">'+label+'</div></div>';
    }
    var h=Math.max(8,Math.round((v/max)*H));
    return '<div class="chart-bar-wrap"><div class="chart-tip">'+tipText+'</div><div class="chart-bar-col"><div class="chart-bar" style="height:'+h+'px"></div></div><div class="chart-bar-label">'+label+'</div></div>';
  }).join('');
}

function renderChartWrites(rows){
  const el=document.getElementById('chartWrites');
  const filled=fillDays(rows?.map(r=>({date:r.date,count:r.count})),metricsDays);
  renderBars(el,filled,'count',160);
}

function renderChartCalls(rows){
  var el=document.getElementById('chartCalls');
  var filled=fillDays(rows?.map(function(r){return {date:r.date,list:r.list,search:r.search};}),metricsDays);
  var vals=filled.map(function(f){return f.total;});
  if(vals.every(function(v){return v===0;})){el.innerHTML='<div style="color:var(--text-muted);font-size:13px;padding:40px;text-align:center">'+t('chart.nocalls')+'</div>';return;}
  var max=Math.max(1,Math.max.apply(null,vals));
  var H=160;
  var n=filled.length;
  var labelStep=n<=7?1:(n<=14?2:5);
  el.innerHTML=filled.map(function(r,idx){
    var rawDate=r.date.includes('~')?r.date:(r.date.length>5?r.date.slice(5):'');
    var showLabel=(idx%labelStep===0)||(idx===n-1);
    var label=showLabel?rawDate:'';
    var tipDate=r.date.length>=10?r.date.slice(5,10):'';
    if(r.total===0){
      var tipZero=tipDate?(tipDate+': 0'):'0';
      return '<div class="chart-bar-wrap"><div class="chart-tip">'+tipZero+'</div><div class="chart-bar-col"><div class="chart-bar zero" style="height:3px"></div></div><div class="chart-bar-label">'+label+'</div></div>';
    }
    var totalH=Math.max(8,Math.round((r.total/max)*H));
    var listH=r.list?Math.max(4,Math.round((r.list/r.total)*totalH)):0;
    var searchH=r.search?totalH-listH:0;
    var tip=(tipDate?tipDate+' - ':'')+'List: '+r.list+', Search: '+r.search;
    var bars='';
    if(searchH>0) bars+='<div class="chart-bar violet" style="height:'+searchH+'px"></div>';
    if(listH>0) bars+='<div class="chart-bar" style="height:'+listH+'px"></div>';
    return '<div class="chart-bar-wrap"><div class="chart-tip">'+tip+'</div><div class="chart-bar-col"><div style="display:flex;flex-direction:column;gap:1px;align-items:center;width:100%">'+bars+'</div></div><div class="chart-bar-label">'+label+'</div></div>';
  }).join('');
}

/* ─── Tool Performance Chart ─── */
let toolMinutes=60;
let toolCustomFrom='';
let toolCustomTo='';
const TOOL_COLORS=['#818cf8','#34d399','#fbbf24','#f87171','#38bdf8','#a78bfa','#fb923c'];

function setToolMinutes(m){
  toolMinutes=m;
  toolCustomFrom='';
  toolCustomTo='';
  var fi=document.getElementById('toolRangeFrom');
  var ti=document.getElementById('toolRangeTo');
  if(fi) fi.value='';
  if(ti) ti.value='';
  document.querySelectorAll('.tool-range').forEach(b=>{
    b.classList.toggle('active',Number(b.dataset.mins)===m);
  });
  loadToolMetrics();
}

function applyCustomToolRange(){
  var fi=document.getElementById('toolRangeFrom');
  var ti=document.getElementById('toolRangeTo');
  var from=fi?fi.value:'';
  var to=ti?ti.value:'';
  if(!from&&!to){toast(t('chart.selectRange'),'warn');return;}
  toolCustomFrom=from;
  toolCustomTo=to;
  document.querySelectorAll('.tool-range').forEach(b=>b.classList.remove('active'));
  loadToolMetrics();
}

async function loadToolMetrics(){
  try{
    var qs='minutes='+toolMinutes;
    if(toolCustomFrom) qs='from='+encodeURIComponent(new Date(toolCustomFrom).toISOString());
    if(toolCustomTo) qs+='&to='+encodeURIComponent(new Date(toolCustomTo).toISOString());
    else if(toolCustomFrom) qs+='&to='+encodeURIComponent(new Date().toISOString());
    const r=await fetch('/api/tool-metrics?'+qs);
    if(!r.ok) return;
    const d=await r.json();
    if(d.error) return;
    renderToolChart(d);
    renderToolAgg(d);
  }catch(e){
    console.warn('loadToolMetrics error:',e);
  }
}

function renderToolChart(data){
  const container=document.getElementById('toolChart');
  const legend=document.getElementById('toolLegend');
  const {tools,series}=data;

  if(!series||series.length===0||tools.length===0){
    container.innerHTML='<div style="display:flex;flex-direction:column;align-items:center;justify-content:center;height:100%;gap:12px;color:var(--text-muted)"><div style="font-size:36px;opacity:.25">\u{1F4CA}</div><div style="font-size:13px;font-weight:500">Waiting for tool calls...</div><div style="font-size:11px;opacity:.6">Charts will render once the agent uses memory tools</div></div>';
    legend.innerHTML='';
    return;
  }

  const W=container.clientWidth||800;
  const H=280;
  const pad={t:20,r:20,b:36,l:52};
  const cw=W-pad.l-pad.r;
  const ch=H-pad.t-pad.b;

  let maxVal=0;
  for(const s of series){for(const t of tools){const v=s[t]||0;if(v>maxVal)maxVal=v;}}
  if(maxVal===0)maxVal=100;
  maxVal=Math.ceil(maxVal*1.15);

  const gridLines=5;
  let gridHtml='';
  for(let i=0;i<=gridLines;i++){
    const y=pad.t+ch-(ch/gridLines)*i;
    const val=Math.round((maxVal/gridLines)*i);
    gridHtml+='<line class="grid-line" x1="'+pad.l+'" y1="'+y+'" x2="'+(W-pad.r)+'" y2="'+y+'"/>';
    gridHtml+='<text class="axis-label" x="'+(pad.l-8)+'" y="'+(y+3)+'" text-anchor="end">'+val+'ms</text>';
  }

  const step=cw/(series.length-1||1);
  const labelEvery=Math.max(1,Math.floor(series.length/8));
  let labelsHtml='';
  series.forEach((s,i)=>{
    if(i%labelEvery===0||i===series.length-1){
      const x=pad.l+i*step;
      const time=s.minute.slice(11);
      labelsHtml+='<text class="axis-label" x="'+x+'" y="'+(H-4)+'" text-anchor="middle">'+time+'</text>';
    }
  });

  let pathsHtml='';
  let dotsHtml='';
  tools.forEach((toolName,ti)=>{
    const color=TOOL_COLORS[ti%TOOL_COLORS.length];
    const pts=series.map((s,i)=>{
      const x=pad.l+i*step;
      const v=s[toolName]||0;
      const y=pad.t+ch-((v/maxVal)*ch);
      return {x,y,v};
    });
    let line='M'+pts[0].x.toFixed(1)+' '+pts[0].y.toFixed(1);
    for(let i=1;i<pts.length;i++){
      const p0=pts[Math.max(0,i-2)],p1=pts[i-1],p2=pts[i],p3=pts[Math.min(pts.length-1,i+1)];
      const cp1x=(p1.x+(p2.x-p0.x)/6).toFixed(1),cp1y=(p1.y+(p2.y-p0.y)/6).toFixed(1);
      const cp2x=(p2.x-(p3.x-p1.x)/6).toFixed(1),cp2y=(p2.y-(p3.y-p1.y)/6).toFixed(1);
      line+=' C'+cp1x+' '+cp1y+','+cp2x+' '+cp2y+','+p2.x.toFixed(1)+' '+p2.y.toFixed(1);
    }
    pathsHtml+='<path class="data-line" d="'+line+'" stroke="'+color+'" />';
    const area=line+' L'+pts[pts.length-1].x.toFixed(1)+' '+(pad.t+ch)+' L'+pts[0].x.toFixed(1)+' '+(pad.t+ch)+' Z';
    pathsHtml+='<path class="data-area" d="'+area+'" fill="url(#tg'+ti+')" />';
    pts.forEach((p,i)=>{
      dotsHtml+='<circle class="hover-dot" cx="'+p.x.toFixed(1)+'" cy="'+p.y.toFixed(1)+'" fill="'+color+'" data-tool="'+toolName+'" data-idx="'+i+'" data-val="'+p.v+'" />';
    });
  });

  const svg='<svg class="tool-chart-svg" viewBox="0 0 '+W+' '+H+'" preserveAspectRatio="xMidYMid meet">'+
    '<defs>'+
    tools.map((t,i)=>{
      const c=TOOL_COLORS[i%TOOL_COLORS.length];
      return '<linearGradient id="tg'+i+'" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="'+c+'" stop-opacity=".08"/><stop offset="1" stop-color="'+c+'" stop-opacity="0"/></linearGradient>'+
        '';
    }).join('')+'</defs>'+
    
    gridHtml+labelsHtml+pathsHtml+dotsHtml+
    '<line class="crosshair" x1="0" y1="'+pad.t+'" x2="0" y2="'+(pad.t+ch)+'" stroke="var(--text-muted)" stroke-width="0.5" stroke-dasharray="3 3" opacity="0" />'+
    '<rect class="hover-rect" x="'+pad.l+'" y="'+pad.t+'" width="'+cw+'" height="'+ch+'" fill="transparent" />'+
    '</svg><div class="tool-chart-tooltip" id="toolTooltip"></div>';

  container.innerHTML=svg;

  legend.innerHTML=tools.map((t,i)=>{
    const c=TOOL_COLORS[i%TOOL_COLORS.length];
    return '<span><span class="dot" style="background:'+c+'"></span>'+t+'</span>';
  }).join('');

  const svgEl=container.querySelector('svg');
  const tooltip=document.getElementById('toolTooltip');
  const rect=svgEl.querySelector('.hover-rect');

  rect.addEventListener('mousemove',function(e){
    const r=svgEl.getBoundingClientRect();
    const mx=e.clientX-r.left;
    const scale=W/r.width;
    const dataX=(mx*scale-pad.l)/step;
    const idx=Math.max(0,Math.min(series.length-1,Math.round(dataX)));
    const s=series[idx];
    if(!s)return;

    svgEl.querySelectorAll('.hover-dot').forEach(d=>{
      d.classList.toggle('show',Number(d.dataset.idx)===idx);
    });
    const crosshair=svgEl.querySelector('.crosshair');
    const cx=pad.l+idx*step;
    crosshair.setAttribute('x1',cx);crosshair.setAttribute('x2',cx);crosshair.setAttribute('opacity','0.5');

    let rows='<div class="tt-time">'+s.minute+'</div>';
    tools.forEach((t,ti)=>{
      const v=s[t]||0;
      const c=TOOL_COLORS[ti%TOOL_COLORS.length];
      rows+='<div class="tt-row"><span class="tt-dot" style="background:'+c+'"></span>'+t+'<span class="tt-val">'+v+'ms</span></div>';
    });
    tooltip.innerHTML=rows;
    tooltip.classList.add('show');

    const tx=e.clientX-container.getBoundingClientRect().left;
    const ty=e.clientY-container.getBoundingClientRect().top;
    tooltip.style.left=(tx+15)+'px';
    tooltip.style.top=(ty-10)+'px';
    if(tx>container.clientWidth*0.7) tooltip.style.left=(tx-tooltip.offsetWidth-15)+'px';
  });

  rect.addEventListener('mouseleave',function(){
    svgEl.querySelectorAll('.hover-dot').forEach(d=>d.classList.remove('show'));
    svgEl.querySelector('.crosshair').setAttribute('opacity','0');
    tooltip.classList.remove('show');
  });
}

function renderToolAgg(data){
  const el=document.getElementById('toolAggTable');
  const {aggregated}=data;
  if(!aggregated||aggregated.length===0){el.innerHTML='';return;}

  const msClass=v=>v<100?'fast':v<500?'medium':'slow';

  el.innerHTML='<table class="tool-agg-table"><thead><tr><th>Tool</th><th>Calls</th><th>Avg</th><th>P95</th><th>Errors</th></tr></thead><tbody>'+
    aggregated.map((a,i)=>{
      const c=TOOL_COLORS[i%TOOL_COLORS.length];
      return '<tr>'+
        '<td><span class="tool-name"><span class="tool-dot" style="background:'+c+'"></span>'+a.tool+'</span></td>'+
        '<td>'+a.totalCalls+'</td>'+
        '<td><span class="ms-val '+msClass(a.avgMs)+'">'+a.avgMs+'ms</span></td>'+
        '<td><span class="ms-val '+msClass(a.p95Ms)+'">'+a.p95Ms+'ms</span></td>'+
        '<td>'+(a.errorCount>0?'<span style="color:var(--accent)">'+a.errorCount+'</span>':'<span style="color:var(--text-muted)">0</span>')+'</td>'+
        '</tr>';
    }).join('')+
    '</tbody></table>';
}

/* ─── Unified live-data poller ─── */
var _livePoller=null;
var _LIVE_POLL_MS=15000;
var _livePollBusy=false;

async function _livePollTick(){
  if(_livePollBusy||document.hidden) return;
  _livePollBusy=true;
  var _savedScrollY=window.scrollY;
  var _scrollTargets=['memoryList','tasksList','skillsList','adminUsersPanel','adminMemoriesPanel','adminTasksPanel','adminSkillsPanel'];
  var _savedScrollMap={};
  _scrollTargets.forEach(function(id){var el=document.getElementById(id);if(el&&el.scrollTop)_savedScrollMap[id]=el.scrollTop;});
  try{
    if(sharingStatusCache&&sharingStatusCache.enabled&&_lastSharingConnStatus!=='rejected') await loadSharingStatus(false);
    if(!_notifSSEConnected) await pollNotifCount();
    await pollAdminPending();
    if(_activeView==='admin') await loadAdminData();
    else if(_activeView==='memories'){
      var _searchVal=(document.getElementById('searchInput')||{}).value||'';
      if(!_searchVal.trim()){
        if(memorySearchScope==='hub') await loadHubMemories(true);
        else{var _pollOwner=undefined;await loadStats(_pollOwner);await loadMemories(null,true);}
      }
    }
    else if(_activeView==='tasks') await loadTasks(true);
    else if(_activeView==='skills') await loadSkills(true);
    else if(_activeView==='analytics') await loadMetrics();
  }catch(e){}
  await new Promise(function(r){requestAnimationFrame(r);});
  window.scrollTo(0,_savedScrollY);
  for(var _sid in _savedScrollMap){var _sel=document.getElementById(_sid);if(_sel)_sel.scrollTop=_savedScrollMap[_sid];}
  _livePollBusy=false;
}

function startLivePoller(){
  stopLivePoller();
  _livePoller=setInterval(_livePollTick,_LIVE_POLL_MS);
}
function stopLivePoller(){
  if(_livePoller){clearInterval(_livePoller);_livePoller=null;}
}

document.addEventListener('visibilitychange',function(){
  if(document.hidden){
    stopLivePoller();
  }else{
    _livePollTick();
    startLivePoller();
    if(!_notifSSE||!_notifSSEConnected) connectNotifSSE();
  }
});

/* ─── Notifications (SSE push + fallback poll) ─── */
var _notifCache=[];
var _notifUnread=0;
var _notifPollTimer=null;
var _notifPanelOpen=false;
var _notifSSE=null;
var _notifSSEConnected=false;
var _notifSSERetryMs=1000;

function connectNotifSSE(){
  if(_notifSSE) return;
  try{
    _notifSSE=new EventSource('/api/notifications/stream');
    _notifSSE.onmessage=function(ev){
      try{
        var d=JSON.parse(ev.data);
        if(d.type==='connected'){_notifSSEConnected=true;_notifSSERetryMs=1000;return;}
        if(d.type==='update'){
          var prev=_notifUnread;
          _notifUnread=d.unreadCount||0;
          renderNotifBadge();
          if(_notifUnread>prev&&_notifPanelOpen) loadNotifications();
          if(_notifUnread>prev&&_activeView==='memories'&&memorySearchScope!=='hub'){
            syncTeamShareRemovedFromNotifications().then(function(){ loadMemories(currentPage,true); });
          }
        }
        if(d.type==='cleared'){
          _notifUnread=0;_notifCache=[];
          renderNotifBadge();renderNotifPanel();
        }
      }catch(e){}
    };
    _notifSSE.onerror=function(){
      _notifSSEConnected=false;
      if(_notifSSE){_notifSSE.close();_notifSSE=null;}
      setTimeout(connectNotifSSE,Math.min(_notifSSERetryMs,30000));
      _notifSSERetryMs=Math.min(_notifSSERetryMs*2,30000);
    };
  }catch(e){}
}
connectNotifSSE();

function toggleNotifPanel(e){
  if(e)e.stopPropagation();
  var panel=document.getElementById('notifPanel');
  _notifPanelOpen=!_notifPanelOpen;
  if(_notifPanelOpen){
    panel.classList.add('show');
    loadNotifications();
  }else{
    panel.classList.remove('show');
  }
}

document.addEventListener('click',function(e){
  if(!_notifPanelOpen) return;
  var wrap=document.getElementById('notifBellWrap');
  if(wrap&&!wrap.contains(e.target)){
    _notifPanelOpen=false;
    document.getElementById('notifPanel').classList.remove('show');
  }
});

function notifTimeAgo(ts){
  var diff=Date.now()-ts;
  if(diff<60000) return t('notif.timeAgo.just');
  if(diff<3600000) return t('notif.timeAgo.min').replace('{n}',Math.floor(diff/60000));
  if(diff<86400000) return t('notif.timeAgo.hour').replace('{n}',Math.floor(diff/3600000));
  return t('notif.timeAgo.day').replace('{n}',Math.floor(diff/86400000));
}

function notifIcon(resource,type){
  if(type==='user_online') return '\\u{1F7E2}';
  if(type==='user_offline') return '\\u{1F534}';
  if(type==='user_left') return '\\u{1F6AA}';
  if(type==='user_join_request') return '\\u{1F464}';
  if(type==='membership_removed') return '\\u{26D4}';
  if(type==='hub_shutdown') return '\\u{1F6D1}';
  if(type==='role_promoted') return '\\u{2B06}';
  if(type==='role_demoted') return '\\u{2B07}';
  if(type==='username_renamed') return '\\u{270F}';
  if(resource==='memory') return '\\u{1F4DD}';
  if(resource==='task') return '\\u{1F4CB}';
  if(resource==='skill') return '\\u{1F9E0}';
  return '\\u{1F514}';
}

function notifTypeText(n){
  if(n.type==='resource_removed'){
    return t('notif.removed.'+n.resource)||t('notif.removed.memory');
  }
  if(n.type==='resource_shared'){
    return t('notif.shared.'+n.resource)||t('notif.shared.memory');
  }
  if(n.type==='resource_unshared'){
    return t('notif.unshared.'+n.resource)||t('notif.unshared.memory');
  }
  if(n.type==='user_join_request'){
    return t('notif.userJoin');
  }
  if(n.type==='user_online'){
    return t('notif.userOnline');
  }
  if(n.type==='user_offline'){
    return t('notif.userOffline');
  }
  if(n.type==='user_left'){
    return t('notif.userLeft');
  }
  if(n.type==='membership_approved'){
    return t('notif.membershipApproved');
  }
  if(n.type==='membership_rejected'){
    return t('notif.membershipRejected');
  }
  if(n.type==='membership_removed'){
    return t('notif.membershipRemoved');
  }
  if(n.type==='hub_shutdown'){
    return t('notif.hubShutdown');
  }
  if(n.type==='role_promoted'){
    return t('notif.rolePromoted');
  }
  if(n.type==='role_demoted'){
    return t('notif.roleDemoted');
  }
  if(n.type==='username_renamed'){
    return t('notif.usernameRenamed');
  }
  return n.message||n.type;
}

async function loadNotifications(){
  try{
    var r=await fetch('/api/sharing/notifications');
    var d=await r.json();
    _notifCache=d.notifications||[];
    _notifUnread=d.unreadCount||0;
    renderNotifBadge();
    renderNotifPanel();
  }catch(e){}
}

async function pollNotifCount(){
  try{
    var r=await fetch('/api/sharing/notifications?unread=1');
    var d=await r.json();
    _notifUnread=d.unreadCount||0;
    renderNotifBadge();
  }catch(e){}
}

function renderNotifBadge(){
  var badge=document.getElementById('notifBadge');
  if(!badge) return;
  if(_notifUnread>0){
    badge.textContent=_notifUnread>99?'99+':_notifUnread;
    badge.classList.add('show');
  }else{
    badge.classList.remove('show');
  }
}

var _notifKnownTypes={membership_approved:1,membership_rejected:1,membership_removed:1,hub_shutdown:1,user_left:1,user_online:1,user_offline:1,user_join_request:1,role_promoted:1,role_demoted:1,resource_removed:1,resource_shared:1,resource_unshared:1,username_renamed:1};
function notifDisplayTitle(n){
  if(_notifKnownTypes[n.type]) return notifTypeText(n);
  return n.title||notifTypeText(n);
}
function notifDisplayDetail(n){
  if(_notifKnownTypes[n.type]){
    if(n.type==='resource_removed'||n.type==='resource_shared'||n.type==='resource_unshared') return n.title||'';
    if(n.type==='username_renamed'){
      var rm=n.title&&n.title.match(/from "([^"]+)" to "([^"]+)"/);
      if(rm) return t('notif.usernameRenamed.detail').replace('{oldName}',rm[1]).replace('{newName}',rm[2]);
      return '';
    }
    var m=n.title&&n.title.match(/["\u201C]([^"\u201D]+)["\u201D]/);
    if(m) return m[1];
    if(n.type==='user_left'||n.type==='user_online'||n.type==='user_offline'||n.type==='user_join_request') return n.title||'';
    return '';
  }
  return n.title||'';
}
function renderNotifPanel(){
  var body=document.getElementById('notifPanelBody');
  if(!body) return;
  if(_notifCache.length===0){
    body.innerHTML='<div class="notif-empty">'+t('notif.empty')+'</div>';
    return;
  }
  body.innerHTML=_notifCache.map(function(n){
    var cls='notif-item'+(n.read?'':' unread');
    var detail=notifDisplayDetail(n);
    return '<div class="'+cls+'" onclick="markNotifRead(&quot;'+esc(n.id)+'&quot;)">'+
      '<div class="notif-item-icon">'+notifIcon(n.resource,n.type)+'</div>'+
      '<div class="notif-item-body">'+
        '<div class="notif-item-title">'+esc(notifDisplayTitle(n))+'</div>'+
        (detail?'<div class="notif-item-name">'+esc(detail)+'</div>':'')+
        '<div class="notif-item-time">'+notifTimeAgo(n.createdAt)+'</div>'+
      '</div>'+
      '<div class="notif-item-dot"></div>'+
    '</div>';
  }).join('');
}

async function markNotifRead(id){
  try{
    await fetch('/api/sharing/notifications/read',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({ids:[id]})});
    _notifCache.forEach(function(n){if(n.id===id)n.read=true;});
    _notifUnread=Math.max(0,_notifUnread-1);
    renderNotifBadge();
    renderNotifPanel();
  }catch(e){}
}

async function markAllNotifsRead(){
  try{
    await fetch('/api/sharing/notifications/read',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({all:true})});
    _notifCache.forEach(function(n){n.read=true;});
    _notifUnread=0;
    renderNotifBadge();
    renderNotifPanel();
  }catch(e){}
}

async function clearAllNotifs(){
  try{
    await fetch('/api/sharing/notifications/clear',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({})});
    _notifCache=[];
    _notifUnread=0;
    renderNotifBadge();
    renderNotifPanel();
  }catch(e){}
}

function startNotifPoll(){ startLivePoller(); }
function stopNotifPoll(){ }

/* ─── Data loading ─── */
async function loadAll(){
  await loadStats();
  var initOwner=undefined;
  if(initOwner) await loadStats(initOwner);
  await Promise.all([loadMemories(),loadSharingStatus(false)]);
  checkMigrateStatus();
  connectPPSSE();
  checkForUpdate();
  pollNotifCount();
  startLivePoller();
}

var _lastStatsFp='';
async function loadStats(ownerFilter){
  let d;
  try{
    var statsUrl='/api/stats';
    if(ownerFilter) statsUrl+='?owner='+encodeURIComponent(ownerFilter);
    const r=await fetch(statsUrl);
    d=await r.json();
  }catch(e){ d={}; }
  if(!d||typeof d!=='object') d={};
  if(d.currentAgentOwner && !new URLSearchParams(window.location.search).get('agentId')) _currentAgentOwner=d.currentAgentOwner;
  const tm=d.totalMemories||0;
  const dedupB=d.dedupBreakdown||{};
  const activeCount=dedupB.active||tm;
  const inactiveCount=(dedupB.duplicate||0)+(dedupB.merged||0);
  var agentCount=(d.owners&&d.owners.length)?d.owners.length:1;
  var tvc=(d.taskSessions||[]).length;
  var svc=(d.skillSessions||[]).length;
  var sfp=tm+':'+(d.totalSessions||0)+':'+(d.totalEmbeddings||0)+':'+agentCount+':'+(d.embeddingProvider||'none')+':'+(ownerFilter||'')+':'+(_activeView||'memories')+':'+tvc+':'+svc;
  if(sfp===_lastStatsFp) return;
  _lastStatsFp=sfp;
  document.getElementById('statTotal').textContent=tm;
  if(inactiveCount>0){
    document.getElementById('statTotal').title=activeCount+' '+t('stat.active')+', '+inactiveCount+' '+t('stat.deduped');
  }
  document.getElementById('statTasks').textContent=d.totalTasks||0;
  document.getElementById('statSkills').textContent=d.totalSkills||0;
  document.getElementById('statAgents').textContent=agentCount;

  const provEl=document.getElementById('embeddingStatus');
  if(d.embeddingProvider && d.embeddingProvider!=='none'){
    provEl.innerHTML='<div class="provider-badge"><span>\\u2713</span> '+t('embed.on')+d.embeddingProvider+'</div>';
  } else {
    provEl.innerHTML='<div class="provider-badge offline"><span>\\u26A0</span> '+t('embed.off')+'</div>';
  }

  if(!_embeddingWarningShown){
    _embeddingWarningShown=true;
    if(!d.embeddingProvider||d.embeddingProvider==='local'||d.embeddingProvider==='none'){
      showEmbeddingBanner(t('embed.warn.local'),'warning');
    }
    fetch('/api/model-health').then(r=>r.json()).then(mh=>{
      var models=mh.models||[];
      var embModel=models.find(m=>m.role==='embedding');
      if(embModel&&embModel.status==='error'){
        showEmbeddingBanner(t('embed.err.fail'),'error');
      }
    }).catch(()=>{});
  }

  const memorySessions=d.sessions||[];
  const taskSessions=d.taskSessions||[];
  const skillSessions=d.skillSessions||[];
  const sessionMap={memories:memorySessions,tasks:taskSessions,skills:skillSessions};
  function getSessionsForView(view){
    return sessionMap[view]||memorySessions;
  }
  function countBadgeHtml(cnt){
    return cnt&&cnt>0?'<span class="count">'+cnt+'</span>':'';
  }

  const sidebarSessions=getSessionsForView(_activeView);

  [['filterSession','memories'],['taskFilterSession','tasks'],['skillFilterSession','skills']].forEach(function(pair){
    var selId=pair[0];
    var viewKey=pair[1];
    var viewSessions=getSessionsForView(viewKey);
    const fSel=document.getElementById(selId);
    if(!fSel) return;
    const curVal=activeSession||'';
    var sessionCount=viewSessions.length;
    fSel.style.display=sessionCount>0?'':'none';
    fSel.innerHTML='<option value="">'+t('filter.allsessions')+' ('+sessionCount+')</option>';
    viewSessions.forEach(s=>{
      const sName=s.session_key.length>30?s.session_key.slice(0,12)+'...'+s.session_key.slice(-10):s.session_key;
      const countLabel=(s.count&&s.count>0)?' ('+s.count+')':'';
      fSel.innerHTML+='<option value="'+s.session_key.replace(/"/g,'&quot;')+'"'+(s.session_key===curVal?' selected':'')+'>'+sName+countLabel+'</option>';
    });
  });

  if(d.owners && d.owners.length>0){
    var agents=d.owners.filter(function(o){return o && o.indexOf('agent:')===0;});
    ['filterOwner','taskFilterOwner','skillFilterOwner'].forEach(function(selId){
      var sel=document.getElementById(selId);
      if(!sel) return;
      var curVal=sel.value;
      sel.innerHTML='<option value="">'+t('filter.allagents')+'</option>';
      agents.forEach(function(o){
        var label=o.replace('agent:','');
        sel.innerHTML+='<option value="'+o+'"'+(o===curVal?' selected':'')+'>'+label+'</option>';
      });
      sel.style.display='';
    });
  }
}

function onOwnerFilterChange(){
  var src=event&&event.target?event.target:document.getElementById('filterOwner');
  var owner=src.value;
  ['filterOwner','taskFilterOwner','skillFilterOwner'].forEach(function(id){
    var el=document.getElementById(id);
    if(el&&el!==src) el.value=owner;
  });
  activeSession=null;
  currentPage=1;
  taskSearchQuery='';
  var tsi=document.getElementById('taskSearchInput');if(tsi)tsi.value='';
  refreshSessionDropdown(owner);
  applyFilters();
  loadTasks();
  loadSkills();
}

async function refreshSessionDropdown(ownerFilter){
  try{
    var statsUrl='/api/stats';
    if(ownerFilter) statsUrl+='?owner='+encodeURIComponent(ownerFilter);
    var r=await fetch(statsUrl);
    var d=await r.json();
    var sessions=d.sessions||[];
    var fSel=document.getElementById('filterSession');
    if(fSel){
      fSel.innerHTML='<option value="">'+t('filter.allsessions')+' ('+sessions.length+')</option>';
      sessions.forEach(function(s){
        var sName=s.session_key.length>30?s.session_key.slice(0,12)+'...'+s.session_key.slice(-10):s.session_key;
        fSel.innerHTML+='<option value="'+s.session_key.replace(/"/g,'&quot;')+'">'+sName+' ('+s.count+')</option>';
      });
    }
  }catch(e){}
}

function getFilterParams(){
  const p=new URLSearchParams();
  if(activeSession) p.set('session',activeSession);
  if(activeRole) p.set('role',activeRole);
  const df=document.getElementById('dateFrom').value;
  if(df) p.set('dateFrom',df);
  const dt=document.getElementById('dateTo').value;
  if(dt) p.set('dateTo',dt);
  const sort=document.getElementById('filterSort').value;
  if(sort==='oldest') p.set('sort','oldest');
  const scope=memorySearchScope||'allLocal';
  if(scope==='allLocal'){
    const owner=document.getElementById('filterOwner').value;
    if(owner) {
      p.set('owner',owner);
      _currentAgentOwner = owner;
    }
  }
  return p;
}

/** Hub admin removed a shared memory — badge-only: clear team_shared_chunks (never touches chunks/embeddings/hub_memories recall data). */
async function syncTeamShareRemovedFromNotifications(){
  try{
    var r=await fetch('/api/sharing/notifications');
    var d=await r.json();
    var list=d.notifications||[];
    for(var i=0;i<list.length;i++){
      var n=list[i];
      if(n.type!=='resource_removed'||n.resource!=='memory'||!n.message) continue;
      try{
        var meta=JSON.parse(n.message);
        if(meta.sourceChunkId){
          await fetch('/api/sharing/sync-hub-removal',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({sourceChunkId:meta.sourceChunkId,memoryId:meta.memoryId||''})});
        }
      }catch(e){}
    }
  }catch(e){}
}

async function loadMemories(page,silent){
  if(page) currentPage=page;
  const list=document.getElementById('memoryList');
  if(!silent) list.innerHTML='<div class="spinner"></div>';
  try{
    if(!silent) await syncTeamShareRemovedFromNotifications();
    const p=getFilterParams();
    p.set('limit',PAGE_SIZE);
    p.set('page',currentPage);
    const r=await fetch('/api/memories?'+p.toString());
    const d=await r.json();
    var items=d.memories||[];
    if(silent){
      var fp=JSON.stringify(items.map(function(m){return m.id+'|'+m.updated_at}));
      if(fp===_lastMemoriesFingerprint) return;
      _lastMemoriesFingerprint=fp;
    }else{
      _lastMemoriesFingerprint=JSON.stringify(items.map(function(m){return m.id+'|'+m.updated_at}));
    }
    totalPages=d.totalPages||1;
    totalCount=d.total||0;
    document.getElementById('searchMeta').textContent=totalCount+t('search.meta.total');
    renderMemories(items);
    renderPagination();
  }catch(e){
    if(!silent){
    list.innerHTML='';
    totalPages=1;totalCount=0;
      _lastMemoriesFingerprint='';
    renderMemories([]);
    renderPagination();
    }
  }
}

async function loadHubMemories(silent){
  const list=document.getElementById('memoryList');
  selectedMemoryIds.clear();
  updateMemorySelectionToolbar();
  if(!silent) list.innerHTML='<div class="spinner"></div>';
  try{
    const r=await fetch('/api/sharing/memories/list?limit='+PAGE_SIZE);
    const d=await r.json();
    const items=d.memories||[];
    if(silent){
      var fp=JSON.stringify(items.map(function(m){return m.id+'|'+(m.updated_at||m.created_at)}));
      if(fp===_lastMemoriesFingerprint) return;
      _lastMemoriesFingerprint=fp;
    }else{
      _lastMemoriesFingerprint=JSON.stringify(items.map(function(m){return m.id+'|'+(m.updated_at||m.created_at)}));
    }
    totalPages=1;totalCount=items.length;currentPage=1;
    document.getElementById('searchMeta').textContent=items.length+t('search.meta.total');
    document.getElementById('sharingSearchMeta').textContent='';
    renderMemories(items);
    document.getElementById('pagination').innerHTML='';
  }catch(e){
    if(!silent){
      _lastMemoriesFingerprint='';
    document.getElementById('searchMeta').textContent='0'+t('search.meta.results');
    renderMemories([]);
    document.getElementById('pagination').innerHTML='';
    }
  }
}

async function doSearch(query){
  query=(query||'').trim();
  if(!query){
    currentPage=1;
    if(memorySearchScope==='hub') loadHubMemories();
    else loadMemories();
    return;
  }
  currentPage=1;
  var scope=document.getElementById('memorySearchScope')?.value||memorySearchScope||'allLocal';
  var list=document.getElementById('memoryList');
  list.innerHTML='<div class="spinner"></div>';
  if(scope==='hub'){
    try{
      var r=await fetch('/api/sharing/search/memories',{
        method:'POST',
        headers:{'Content-Type':'application/json'},
        body:JSON.stringify({query:query,scope:scope,maxResults:20,role:activeRole||undefined})
      });
      var data=await r.json();
      totalPages=1;totalCount=(data.results||[]).length;
      renderSharingMemorySearchResults(data,query);
    }catch(e){
      document.getElementById('searchMeta').textContent='0'+t('search.meta.results');
      document.getElementById('sharingSearchMeta').textContent='';
      renderMemories([]);
      document.getElementById('pagination').innerHTML='';
    }
  } else {
    try{
      var p=getFilterParams();
      p.set('q',query);
      var r=await fetch('/api/search?'+p.toString());
      var d=await r.json();
      var total=d.total||0;
      totalPages=1;totalCount=total;
      var meta=[];
      if(d.vectorCount>0) meta.push(d.vectorCount+t('search.meta.semantic'));
      if(d.ftsCount>0) meta.push(d.ftsCount+t('search.meta.text'));
      meta.push(total+t('search.meta.results'));
      document.getElementById('searchMeta').textContent=meta.join(' \u00B7 ');
      document.getElementById('sharingSearchMeta').textContent='';
      renderMemories(d.results||[]);
      document.getElementById('pagination').innerHTML='';
    }catch(e){
      document.getElementById('searchMeta').textContent='0'+t('search.meta.results');
      document.getElementById('sharingSearchMeta').textContent='';
      renderMemories([]);
      document.getElementById('pagination').innerHTML='';
    }
  }
}

function debounceSearch(){
  clearTimeout(searchTimer);
  searchTimer=setTimeout(()=>doSearch(document.getElementById('searchInput').value),350);
}

function filterSession(key){
  activeSession=key;
  currentPage=1;
  tasksPage=0;
  skillsPage=0;
  ['filterSession','taskFilterSession','skillFilterSession'].forEach(function(selId){
    var fSel=document.getElementById(selId);
    if(fSel) fSel.value=key||'';
  });
  if(_activeView==='tasks'){
    loadStats();
    loadTasks();
    return;
  }
  if(_activeView==='skills'){
    loadStats();
    loadSkills();
    return;
  }
  loadAll();
}

function setRoleFilter(btn,role){
  activeRole=role;
  currentPage=1;
  document.querySelectorAll('.filter-chip').forEach(c=>c.classList.remove('active'));
  btn.classList.add('active');
  applyFilters();
}

function applyFilters(){
  currentPage=1;
  if(document.getElementById('searchInput').value.trim()){
    doSearch(document.getElementById('searchInput').value);
  } else {
    loadMemories();
  }
}

function clearDateFilter(){
  document.getElementById('dateFrom').value='';
  document.getElementById('dateTo').value='';
  applyFilters();
}

function updateMemorySelectionToolbar(){
  var toolbar=document.getElementById('memorySelectionToolbar');
  var selectAllBtn=document.getElementById('memorySelectAllBtn');
  var bulkDeleteBtn=document.getElementById('memoryBulkDeleteBtn');
  var isHub=memorySearchScope==='hub';
  var total=document.querySelectorAll('#memoryList .memory-select-check').length;
  var selected=selectedMemoryIds.size;
  if(toolbar) toolbar.style.display=isHub?'none':'flex';
  if(selectAllBtn){
    selectAllBtn.textContent=t(selected>0&&selected===total&&total>0?'skills.unselectAll':'skills.selectAll');
    selectAllBtn.disabled=total===0;
    selectAllBtn.style.display=total===0?'none':'';
  }
  if(bulkDeleteBtn){
    var base=t('memory.deleteSelected');
    bulkDeleteBtn.style.display=selected>0?'':'none';
    bulkDeleteBtn.textContent=selected>0?(base+' ('+selected+')'):base;
  }
}

function toggleMemorySelection(memoryId,checked){
  if(checked) selectedMemoryIds.add(memoryId);
  else selectedMemoryIds.delete(memoryId);
  updateMemorySelectionToolbar();
}

function toggleSelectAllMemories(){
  var total=currentMemoryIds.length;
  if(total===0) return;
  if(selectedMemoryIds.size===total){
    selectedMemoryIds.clear();
  }else{
    selectedMemoryIds=new Set(currentMemoryIds);
  }
  var checks=document.querySelectorAll('#memoryList .memory-select-check');
  checks.forEach(function(cb){cb.checked=selectedMemoryIds.has(cb.value);});
  updateMemorySelectionToolbar();
}

async function deleteSelectedMemories(){
  var ids=Array.from(selectedMemoryIds);
  if(ids.length===0) return;
  var msg=t('memory.delete.selected.confirm').replace('{count}',String(ids.length));
  if(!(await confirmModal(msg,{danger:true}))) return;
  var ok=0;
  var fail=0;
  for(var i=0;i<ids.length;i++){
    try{
      var r=await fetch('/api/memory/'+ids[i],{method:'DELETE'});
      var d=await r.json();
      if(!d.ok) throw new Error(d.error||'unknown');
      ok++;
    }catch(e){
      fail++;
    }
  }
  selectedMemoryIds.clear();
  updateMemorySelectionToolbar();
  if(document.getElementById('searchInput').value.trim()){
    doSearch(document.getElementById('searchInput').value);
  }else if(memorySearchScope==='hub'){
    loadHubMemories();
  }else{
    loadMemories();
  }
  if(fail>0) toast(t('memory.delete.partial').replace('{ok}',String(ok)).replace('{fail}',String(fail)),'warn');
  else toast(t('memory.delete.success').replace('{count}',String(ok)),'success');
}

/* ─── Rendering ─── */
function renderMemories(items){
  const list=document.getElementById('memoryList');
  setPageSizeVisible('memoryPageSize',items.length>0);
  if(!items.length){
    list.innerHTML='<div class="empty"><div class="icon">\\u{1F4ED}</div><p>'+t('empty.text')+'</p></div>';
    currentMemoryIds=[];
    updateMemorySelectionToolbar();
    return;
  }
  items.forEach(m=>{memoryCache[m.id]=m});
  currentMemoryIds=items.map(function(m){return m.id;});
  selectedMemoryIds=new Set(Array.from(selectedMemoryIds).filter(function(id){return currentMemoryIds.includes(id);}));
  list.innerHTML=items.map(m=>{
    const time=m.created_at?new Date(typeof m.created_at==='number'?m.created_at:m.created_at).toLocaleString(dateLoc()):'';
    const role=m.role||'user';
    const rawSummary=m.summary||'';
    const rawContent=m.content||'';
    const content=esc(rawContent);
    const id=m.id;
    const vscore=m._vscore?'<span class="vscore-badge">'+Math.round(m._vscore*100)+'%</span>':'';
    const sid=m.session_key||'';
    const sidShort=fmtSessionDisplay(sid);
    const mc=m.merge_count||0;
    const cardTitle=esc(rawSummary||rawContent||'');
    const mergeBadge=mc>0?'<span class="merge-badge">\\u{1F504} '+t('card.evolved')+' '+mc+t('card.times')+'</span>':'';
    const updatedAt=(m.updated_at&&m.updated_at>m.created_at)?'<span class="card-updated">'+t('card.updated')+' '+new Date(m.updated_at).toLocaleString(dateLoc())+'</span>':'';
    const ds=m.dedup_status||'active';
    const isInactive=ds==='merged'||ds==='duplicate';
    const dedupBadge=ds==='duplicate'?'<span class="dedup-badge duplicate">'+t('card.dedupDuplicate')+'</span>':ds==='merged'?'<span class="dedup-badge merged">'+t('card.dedupMerged')+'</span>':'';
    const isImported=isImportedSession(sid);
    const importBadge=isImported?'<span class="import-badge">\u{1F990} '+t('card.imported')+'</span>':'';
    const ownerVal=m.owner||'agent:main';
    const isPublicMem=ownerVal==='public';
    const localManaged=!!m.localSharingManaged;
    const memShared=m.sharingVisibility||null;
    const isHubScope=memorySearchScope==='hub';
    const memScope=memShared?'team':isPublicMem?'local':'private';
    const memScopeBadge=isHubScope?renderScopeBadge('team'):renderScopeBadge(memScope);
    const selectedAttr=selectedMemoryIds.has(id)?' checked':'';
    const selectBoxHtml=isHubScope?'':'<label class="item-select-box" onclick="event.stopPropagation()"><input class="memory-select-check" type="checkbox" value="'+escAttr(id)+'"'+selectedAttr+' onchange="event.stopPropagation();toggleMemorySelection(&quot;'+escAttr(id)+'&quot;,this.checked)"></label>';
    let dedupInfo='';
    if(ds==='duplicate'||ds==='merged'){
      const reason=m.dedup_reason?'<span style="font-size:11px;color:var(--text-muted)">'+t('card.dedupReason')+esc(m.dedup_reason)+'</span>':'';
      const target=m.dedup_target?'<span class="dedup-target-link" onclick="scrollToMemory(\\''+m.dedup_target+'\\')">'+t('card.dedupTarget')+m.dedup_target.slice(0,8)+'...</span>':'';
      dedupInfo='<div style="margin-top:6px;font-size:11px">'+target+' '+reason+'</div>';
    }
    let historyHtml='';
    if(mc>0){
      try{
        const hist=JSON.parse(m.merge_history||'[]');
        if(hist.length>0){
          historyHtml='<div class="merge-history" id="history-'+id+'" style="display:none"><div style="font-weight:600;margin-bottom:8px;font-size:12px">'+t('card.evolveHistory')+' ('+hist.length+')</div>';
          hist.forEach(function(h){
            const ht=h.at?new Date(h.at).toLocaleString(dateLoc()):'';
            historyHtml+='<div class="merge-history-item"><span class="merge-action '+h.action+'">'+h.action+'</span> <span style="color:var(--text-muted)">'+ht+'</span><br>'+esc(h.reason||'');
            if(h.from) historyHtml+='<br><span style="opacity:.6">'+t('card.oldSummary')+':</span> '+esc(h.from);
            if(h.to) historyHtml+='<br><span style="opacity:.6">'+t('card.newSummary')+':</span> '+esc(h.to);
            historyHtml+='</div>';
          });
          historyHtml+='</div>';
        }
      }catch(e){}
    }
    var ownerName=fmtAgentName(m.owner);
    var ownerBadge=ownerName?'<span class="owner-tag" title="'+esc(m.owner||'')+'">\\u{1F916} '+esc(ownerName)+'</span>':'';
    return '<div class="memory-card'+(isInactive?' dedup-inactive':'')+'">'+
      '<div class="card-header"><div class="meta"><span class="role-tag '+role+'">'+role+'</span>'+ownerBadge+memScopeBadge+importBadge+dedupBadge+mergeBadge+'</div><span class="card-time"><span class="session-tag" data-session-key="'+escAttr(sid)+'" onclick="event.stopPropagation();copySessionKeyFromEl(this)" title="'+esc(sidShort+(sid?' — '+t('copy.hint'):''))+'">'+esc(sidShort)+'</span> '+time+updatedAt+'</span></div>'+
      '<div class="card-summary">'+selectBoxHtml+cardTitle+'</div>'+
      (function(){
        if(mc<=0) return '';
        var mergeHtml='<div class="card-merged-info">';
        mergeHtml+='<div class="card-merged-label">\\u{1F504} '+t('card.mergedInfo')+' ('+mc+t('card.times')+')</div>';
        var sources=m.merge_sources||[];
        if(sources.length>0){
          mergeHtml+='<div style="display:flex;flex-wrap:wrap;gap:6px">';
          sources.forEach(function(s){
            mergeHtml+='<span class="dedup-target-link" onclick="scrollToMemory(\\''+s.id+'\\')">\\u{1F517} '+s.id.slice(0,8)+'...</span>';
          });
          mergeHtml+='</div>';
        }
        mergeHtml+='</div>';
        return mergeHtml;
      })()+
      dedupInfo+
      '<div class="card-content" id="content-'+id+'"><pre>'+content+'</pre></div>'+
      historyHtml+
      '<div class="card-actions">'+
        '<button class="btn btn-sm btn-ghost" onclick="toggleContent(\\''+id+'\\')">'+t('card.expand')+'</button>'+
        (mc>0?'<button class="btn btn-sm btn-ghost" onclick="toggleHistory(\\''+id+'\\')">'+t('card.evolveHistory')+'</button>':'')+
        '<button class="btn btn-sm btn-ghost" onclick="openEditModal(\\''+id+'\\')">'+t('card.edit')+'</button>'+
        (isInactive
          ?'<button class="btn btn-sm btn-ghost" style="opacity:0.45;cursor:not-allowed" onclick="toast(t(\\x27share.scope.inactiveDisabled\\x27),\\x27warn\\x27)">\\u270F '+t('share.shareBtn')+'</button>'
          :'<button class="btn btn-sm btn-ghost" onclick="openMemoryScopeModal(\\''+id+'\\',\\''+memScope+'\\')">\\u270F '+t('share.shareBtn')+'</button>')+
        '<button class="btn btn-sm btn-ghost" style="color:var(--accent)" onclick="deleteMemory(\\''+id+'\\')">'+t('card.delete')+'</button>'+
        vscore+
      '</div></div>';
  }).join('');
  updateMemorySelectionToolbar();
}

function updateMemoryCardBadge(chunkId,newScope){
  var cards=document.querySelectorAll('.memory-card');
  for(var i=0;i<cards.length;i++){
    var btns=cards[i].querySelectorAll('button');
    var shareBtn=null;
    for(var b=0;b<btns.length;b++){
      var oc=btns[b].getAttribute('onclick')||'';
      if(oc.indexOf('openMemoryScopeModal')>=0&&oc.indexOf(chunkId)>=0){shareBtn=btns[b];break;}
    }
    if(!shareBtn) continue;
    var metaDiv=cards[i].querySelector('.meta');
    if(!metaDiv) continue;
    var oldBadge=metaDiv.querySelectorAll('span[style*="border-radius:10px"]');
    for(var j=0;j<oldBadge.length;j++) oldBadge[j].remove();
    var roleTag=metaDiv.querySelector('.role-tag');
    if(roleTag&&roleTag.nextSibling) roleTag.insertAdjacentHTML('afterend',renderScopeBadge(newScope));
    else metaDiv.insertAdjacentHTML('beforeend',renderScopeBadge(newScope));
    shareBtn.setAttribute('onclick','openMemoryScopeModal(\\x27'+chunkId+'\\x27,\\x27'+newScope+'\\x27)');
    break;
  }
}

function renderPagination(){
  const el=document.getElementById('pagination');
  if(totalPages<=1){el.innerHTML='';return}
  let h='';
  h+='<button class="pg-btn'+(currentPage<=1?' disabled':'')+'" onclick="goPage('+(currentPage-1)+')">\u2039</button>';
  const range=[];
  range.push(1);
  for(let i=Math.max(2,currentPage-2);i<=Math.min(totalPages-1,currentPage+2);i++) range.push(i);
  if(totalPages>1) range.push(totalPages);
  const unique=[...new Set(range)].sort((a,b)=>a-b);
  let prev=0;
  for(const p of unique){
    if(p-prev>1) h+='<span class="pg-info">...</span>';
    h+='<button class="pg-btn'+(p===currentPage?' active':'')+'" onclick="goPage('+p+')">'+p+'</button>';
    prev=p;
  }
  h+='<button class="pg-btn'+(currentPage>=totalPages?' disabled':'')+'" onclick="goPage('+(currentPage+1)+')">\u203A</button>';
  h+='<span class="pg-info">'+totalCount+t('pagination.total')+'</span>';
  el.innerHTML=h;
}

function goPage(p){
  if(p<1||p>totalPages||p===currentPage) return;
  currentPage=p;
  if(memorySearchScope==='hub') loadHubMemories();
  else loadMemories();
  document.getElementById('memoryList').scrollIntoView({behavior:'smooth',block:'start'});
}

function toggleHistory(id){
  const el=document.getElementById('history-'+id);
  if(el) el.style.display=el.style.display==='none'?'block':'none';
}

function toggleContent(id){
  const el=document.getElementById('content-'+id);
  el.classList.toggle('show');
}

function scrollToMemory(targetId){
  const cards=document.querySelectorAll('.memory-card');
  for(const card of cards){
    const contentEl=card.querySelector('[id^="content-"]');
    if(contentEl&&contentEl.id==='content-'+targetId){
      card.scrollIntoView({behavior:'smooth',block:'center'});
      card.style.transition='box-shadow .3s';
      card.style.boxShadow='0 0 0 2px var(--pri)';
      setTimeout(()=>{card.style.boxShadow='';},2000);
      return;
    }
  }
  showMemoryModal(targetId);
}
function fmtModalDate(v){
  if(!v) return '-';
  var d=new Date(v);
  if(isNaN(d.getTime())) return '-';
  return d.toLocaleString(dateLoc());
}
async function showMemoryModal(chunkId){
  var overlay=document.getElementById('memoryModal');
  var body=document.getElementById('memoryModalBody');
  body.innerHTML='<div style="text-align:center;padding:56px;color:var(--text-sec)"><div class="spinner" style="margin:0 auto 14px"></div><div style="font-size:12px;letter-spacing:.04em">'+t('memory.detail.loading')+'</div></div>';
  overlay.classList.add('show');
  try{
    var res=await fetch('/api/memory/'+encodeURIComponent(chunkId));
    if(!res.ok){body.innerHTML='<div style="text-align:center;padding:56px"><div style="font-size:32px;margin-bottom:12px">\u{1F50D}</div><div style="color:#f87171;font-size:13px">'+t('memory.detail.notFound')+'</div></div>';return;}
    var data=await res.json();
    var m=data.memory;
    var role=(m.role||'unknown').toUpperCase();
    var roleCls=(m.role||'').toLowerCase();
    var ds=m.dedup_status||'active';
    var h='<div class="mm-hero">';
    h+='<div class="mm-hero-row">';
    h+='<span class="mm-role-chip '+roleCls+'">'+role+'</span>';
    if(ds!=='active') h+='<span class="mm-dedup-chip '+(ds==='duplicate'?'duplicate':'merged')+'">'+(ds==='duplicate'?'\u274C':'\u{1F504}')+' '+ds+'</span>';
    h+='<span class="mm-id" onclick="navigator.clipboard.writeText(\\''+esc(m.id)+'\\');toast(\\'ID copied\\',\\'success\\')" title="'+t('memory.detail.copyId')+'">'+esc(m.id.slice(0,12))+'</span>';
    h+='</div>';
    if(m.summary) h+='<div class="mm-summary">'+esc(m.summary)+'</div>';
    h+='</div>';
    if(m.content){
      h+='<div class="mm-section"><div class="mm-section-label">'+t('admin.content')+'</div><pre class="mm-content">'+esc(m.content)+'</pre></div>';
    }
    h+='<div class="mm-meta">';
    if(m.owner) h+='<div class="mm-meta-chip"><strong>'+t('admin.owner')+'</strong><span>\\u{1F916} '+esc(m.owner)+'</span></div>';
    if(m.session_key) h+='<div class="mm-meta-chip"><strong>'+t('admin.session')+'</strong><span>'+esc(m.session_key)+'</span></div>';
    h+='<div class="mm-meta-chip"><strong>'+t('memory.detail.created')+'</strong><span>'+fmtModalDate(m.created_at)+'</span></div>';
    if(m.updated_at) h+='<div class="mm-meta-chip"><strong>'+t('memory.detail.updated')+'</strong><span>'+fmtModalDate(m.updated_at)+'</span></div>';
    if(m.kind) h+='<div class="mm-meta-chip"><strong>'+t('admin.kind')+'</strong><span>'+esc(m.kind)+'</span></div>';
    h+='</div>';
    if(m.dedup_reason){
      h+='<div class="mm-dedup"><div class="mm-dedup-box">'+esc(m.dedup_reason)+'</div></div>';
    }
    if(m.dedup_target&&m.dedup_target!==chunkId){
      h+='<div class="mm-footer"><span class="dedup-target-link" onclick="closeMemoryModal();scrollToMemory(\\''+m.dedup_target+'\\')">'+t('memory.detail.viewTarget')+' '+m.dedup_target.slice(0,8)+'...</span></div>';
    }
    body.innerHTML=h;
  }catch(e){body.innerHTML='<div style="text-align:center;padding:56px"><div style="font-size:32px;margin-bottom:12px">\u26A0\uFE0F</div><div style="color:#f87171;font-size:13px">'+esc(String(e))+'</div></div>';}
}
function closeMemoryModal(){document.getElementById('memoryModal').classList.remove('show');}


function esc(s){
  if(!s)return'';
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function fmtOwner(item){
  var name=item.ownerName||item.sourceUserId||'unknown';
  if(item.ownerStatus==='removed') return esc(name)+' <span style="color:#ef4444;font-size:0.9em">'+t('sharing.ownerRemoved')+'</span>';
  return esc(name);
}

function renderSummaryHtml(raw){
  if(!raw)return'';
  var lines=raw.split('\\n');
  var html=[];
  var inList=false;
  var sectionRe=new RegExp('^(\u{1F3AF}|\u{1F4CB}|\u2705|\u{1F4A1})\\\\s+(.+)$');
  var listRe=new RegExp('^- (.+)$');
  for(var i=0;i<lines.length;i++){
    var line=lines[i];
    var hm=line.match(sectionRe);
    if(hm){
      if(inList){html.push('</ul>');inList=false;}
      html.push('<div class="summary-section-title">'+esc(line)+'</div>');
      continue;
    }
    var lm=line.match(listRe);
    if(lm){
      if(!inList){html.push('<ul>');inList=true;}
      html.push('<li>'+esc(lm[1])+'</li>');
      continue;
    }
    if(line.trim()===''){
      if(inList){html.push('</ul>');inList=false;}
      continue;
    }
    if(inList){html.push('</ul>');inList=false;}
    html.push('<p style="margin:4px 0">'+esc(line)+'</p>');
  }
  if(inList)html.push('</ul>');
  return html.join('');
}

/* ─── CRUD ─── */
function openEditModal(id){
  const m=memoryCache[id];
  if(!m){toast(t('toast.notfound'),'error');return}
  editingId=id;
  document.getElementById('modalTitle').textContent=t('modal.edit');
  document.getElementById('modalSubmit').textContent=t('modal.save');
  document.getElementById('mRole').value=m.role||'user';
  document.getElementById('mContent').value=m.content||'';
  document.getElementById('mSummary').value=m.summary||'';
  document.getElementById('modalOverlay').classList.add('show');
}

function closeModal(){
  document.getElementById('modalOverlay').classList.remove('show');
}

async function submitModal(){
  if(!editingId)return;
  const data={
    role:document.getElementById('mRole').value,
    content:document.getElementById('mContent').value,
    summary:document.getElementById('mSummary').value,
  };
  if(!data.content.trim()){toast(t('modal.err.empty'),'error');return}
  const r=await fetch('/api/memory/'+editingId,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});
  const d=await r.json();
  if(d.ok){toast(t('toast.updated'),'success');closeModal();loadAll();}
  else{toast(d.error||t('toast.opfail'),'error')}
}

async function deleteMemory(id){
  if(!(await confirmModal(t('confirm.delete'),{danger:true})))return;
  const r=await fetch('/api/memory/'+id,{method:'DELETE'});
  const d=await r.json();
  if(d.ok){
    selectedMemoryIds.delete(id);
    updateMemorySelectionToolbar();
    toast(t('toast.deleted'),'success');
    if(document.getElementById('searchInput').value.trim()){
      doSearch(document.getElementById('searchInput').value);
    }else if(memorySearchScope==='hub'){
      loadHubMemories();
    }else{
      loadMemories();
    }
  }
  else{toast(t('toast.delfail'),'error')}
}

function openMemoryScopeModal(id,currentScope){
  openScopeSelectorModal('memory',id,currentScope,function(newScope){
    if(memoryCache[id]){
      if(newScope==='team'){memoryCache[id].sharingVisibility='public';}
      else if(newScope==='local'){memoryCache[id].sharingVisibility=null;memoryCache[id].owner='public';}
      else{memoryCache[id].sharingVisibility=null;memoryCache[id].owner='agent:main';}
    }
    updateMemoryCardBadge(id,newScope);
  });
}

async function toggleMemoryPublic(id,setPublic){
  try{
    if(!setPublic && !(await confirmModal(t('share.memoryLocalUnshareConfirm'),{danger:true}))) return;
    const memory=memoryCache[id]||{};
    const url=setPublic?'/api/memories/share-local':'/api/memories/unshare-local';
    const body=setPublic?{chunkId:id}:{chunkId:id,privateOwner:memory.localOriginalOwner||undefined};
    const r=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
    const d=await r.json();
    if(d.ok){
      toast(setPublic?t('toast.setPublic'):t('toast.setPrivate'),'success');
      var newScope=setPublic?'local':'private';
      if(memoryCache[id]){memoryCache[id].owner=setPublic?'public':'agent:main';}
      updateMemoryCardBadge(id,newScope);
    }
    else{toast(localMemoryErrorMessage(d.error),'error')}
  }catch(e){toast(localMemoryErrorMessage(e.message),'error')}
}

async function clearAll(){
  try{
    if(!(await confirmModal(t('confirm.clearall'),{danger:true})))return;
    if(!(await confirmModal(t('confirm.clearall2'),{danger:true})))return;
    const r=await fetch('/api/memories',{method:'DELETE'});
    if(r.status===401){toast(t('settings.session.expired'),'error');return;}
    const d=await r.json();
    if(d.ok){
      toast(t('toast.cleared'),'success');
      selectedMemoryIds.clear();selectedTaskIds.clear();selectedSkillIds.clear();
      _lastMemoriesFingerprint='';_lastTasksFingerprint='';_lastSkillsFingerprint='';_lastStatsFp='';
      await loadStats();
      await Promise.all([loadMemories(),loadTasks(),loadSkills(),loadSharingStatus(false)]);
    }
    else{toast(t('toast.clearfail'),'error')}
  }catch(e){toast('Error: '+e.message,'error')}
}

/* ─── Migration ─── */
let migrateScanData=null;
let migrateStats={stored:0,skipped:0,merged:0,errors:0};

(function(){
  const sel=document.getElementById('migrateConcurrency');
  if(sel) sel.addEventListener('change',function(){
    const w=document.getElementById('migrateConcurrencyWarn');
    if(w) w.style.display=parseInt(this.value,10)>1?'block':'none';
  });
  const ppSel=document.getElementById('ppConcurrency');
  if(ppSel) ppSel.addEventListener('change',function(){
    const w=document.getElementById('ppConcurrencyWarn');
    if(w) w.style.display=parseInt(this.value,10)>1?'block':'none';
  });
})();

async function migrateScan(showToast){
  const btn=document.getElementById('migrateScanBtn');
  btn.disabled=true;
  btn.textContent=t('migrate.scanning');
  document.getElementById('migrateStartConcurrencyWrap').style.display='none';
  document.getElementById('migrateScanResult').style.display='none';
  document.getElementById('migrateConfigWarn').style.display='none';
  document.getElementById('migrateProgress').style.display='none';

  try{
    const r=await fetch('/api/migrate/scan');
    const d=await r.json().catch(()=>({}));
    if(d.error && !d.sqliteFiles) throw new Error(d.error);
    migrateScanData=d;

    const files=Array.isArray(d.sqliteFiles)?d.sqliteFiles:[];
    const sess=d.sessions||{count:0,messages:0};
    const sqliteTotal=files.reduce((s,f)=>s+f.chunks,0);
    document.getElementById('migrateSqliteCount').textContent=sqliteTotal;
    document.getElementById('migrateSqliteFiles').textContent=files.map(f=>f.file+' ('+f.chunks+')').join(', ')||'—';
    document.getElementById('migrateSessionCount').textContent=sess.messages;
    document.getElementById('migrateSessionFiles').textContent=sess.count+' '+t('migrate.sessions.count').replace('{n}',sess.messages);
    document.getElementById('migrateScanResult').style.display='block';

    if(!d.configReady){
      document.getElementById('migrateConfigWarn').style.display='block';
      const parts=[];
      if(!d.hasEmbedding) parts.push('Embedding');
      if(!d.hasSummarizer) parts.push('Summarizer');
      document.getElementById('migrateConfigWarn').querySelector('div:last-child').textContent=
        t('migrate.config.warn.desc')+' ('+parts.join(', ')+')';
    }

    const imported=d.importedChunkCount||0;
    const remaining=Math.max(0,(d.totalItems||0)-imported);

    if(d.totalItems>0 && d.configReady){
      document.getElementById('migrateStartConcurrencyWrap').style.display='flex';
      if(d.hasImportedData){
        document.getElementById('migrateStartBtn').textContent=t('migrate.resume');
      }else{
        document.getElementById('migrateStartBtn').textContent=t('migrate.start');
      }
    }

    var hintEl=document.getElementById('migrateImportedHint');
    if(!hintEl){
      hintEl=document.createElement('div');
      hintEl.id='migrateImportedHint';
      hintEl.style.cssText='font-size:12px;color:var(--text-sec);padding:6px 0';
      document.getElementById('migrateActions').appendChild(hintEl);
    }
    if(imported>0){
      hintEl.textContent=t('migrate.imported.hint').replace('{n}',imported);
      hintEl.style.display='block';
    }else{
      hintEl.style.display='none';
    }

    if(d.totalItems===0){
      document.getElementById('migrateStatus').textContent=t('migrate.nodata');
    }

    if(d.hasImportedData){
      document.getElementById('postprocessSection').style.display='block';
    }
    if(showToast) toast(t('migrate.scan.done').replace('{n}',remaining),'success');
  }catch(e){
    toast('Scan failed: '+e.message,'error');
  }finally{
    btn.disabled=false;
    btn.textContent=t('migrate.scan');
  }
}

async function migrateStart(){
  const isResume=document.getElementById('migrateStartBtn').textContent===t('migrate.resume');
  if(!isResume){
    if(!migrateScanData||!migrateScanData.configReady){
      toast(t('migrate.scan.required'),'error');
      return;
    }
    if(!(await confirmModal(t('migrate.start')+'?')))return;
  }

  const concSel=document.getElementById('migrateConcurrency');
  const concurrency=concSel?parseInt(concSel.value,10)||1:1;

  window._migrateRunning=true;
  _migrateStatusChecked=true;
  document.getElementById('migrateStartConcurrencyWrap').style.display='none';
  document.getElementById('migrateScanBtn').disabled=true;
  var hintEl=document.getElementById('migrateImportedHint');
  if(hintEl) hintEl.style.display='none';
  document.getElementById('migrateConcurrencyWarn').style.display='none';
  document.getElementById('migrateProgress').style.display='block';
  document.getElementById('migrateLiveLog').innerHTML='';
  migrateStats={stored:0,skipped:0,merged:0,errors:0};
  updateMigrateStats();
  document.getElementById('migrateBar').style.width='0%';
  document.getElementById('migrateCounter').textContent='';

  document.getElementById('migrateStopBtn').disabled=false;
  document.getElementById('migrateStopBtn').style.display='inline-flex';
  document.getElementById('migrateBar').style.background='linear-gradient(90deg,#6366f1,#8b5cf6)';
  const body=JSON.stringify({sources:['sqlite','sessions'],concurrency});
  connectMigrateSSE('/api/migrate/start','POST',body);
}

async function migrateStop(){
  const btn=document.getElementById('migrateStopBtn');
  btn.disabled=true;
  btn.textContent=t('migrate.stopping');
  try{
    await fetch('/api/migrate/stop',{method:'POST'});
  }catch(e){
    toast('Stop failed: '+e.message,'error');
    btn.disabled=false;
    btn.textContent=t('migrate.stop');
  }
}

function connectMigrateSSE(url,method,body){
  const opts={method:method||'GET'};
  if(body){opts.headers={'Content-Type':'application/json'};opts.body=body;}
  fetch(url,opts)
    .then(r=>{
      if(!r.ok){toast('Migration request failed: '+r.status,'error');onMigrateDone(false);return;}
      readSSEStream(r);
    })
    .catch(e=>{toast('Migration failed: '+e.message,'error');onMigrateDone(false);});
}

function readSSEStream(r){
  const reader=r.body.getReader();
  const decoder=new TextDecoder();
  let buf='';
  let migrateDoneCalled=false;
  const NL=String.fromCharCode(10);
  function pump(){
    reader.read().then(({done,value})=>{
      if(done){if(!migrateDoneCalled)onMigrateDone(false);return;}
      buf+=decoder.decode(value,{stream:true});
      const lines=buf.split(NL);
      buf=lines.pop()||'';
      let evtType='';
      for(const line of lines){
        if(line.startsWith('event: ')){evtType=line.slice(7).trim();}
        else if(line.startsWith('data: ')){
          try{
            const data=JSON.parse(line.slice(6));
            if(evtType==='done'||evtType==='stopped') migrateDoneCalled=true;
            handleMigrateEvent(evtType,data);
          }catch{}
        }
      }
      pump();
    });
  }
  pump();
}

var _migrateStatusChecked=false;
async function checkMigrateStatus(){
  if(_migrateStatusChecked||window._migrateRunning) return;
  _migrateStatusChecked=true;
  try{
    const r=await fetch('/api/migrate/status');
    if(!r.ok)return;
    const s=await r.json();
    if(s.running){
      window._migrateRunning=true;
      switchView('import');
      migrateStats={stored:s.stored,skipped:s.skipped,merged:s.merged,errors:s.errors};
      updateMigrateStats();
      const progEl=document.getElementById('migrateProgress');
      if(!progEl)return;
      progEl.style.display='block';
      document.getElementById('migrateStartConcurrencyWrap').style.display='none';
      document.getElementById('migrateScanBtn').disabled=true;
      document.getElementById('migrateStopBtn').disabled=false;
      const pct=s.total>0?Math.round((s.processed/s.total)*100):0;
      document.getElementById('migrateBar').style.width=pct+'%';
      document.getElementById('migrateCounter').textContent=s.processed+' / '+s.total+' ('+pct+'%)';
      const label=s.phase==='sqlite'?t('migrate.phase.sqlite'):t('migrate.phase.sessions');
      document.getElementById('migratePhaseLabel').textContent=label;
      document.getElementById('migrateStopBtn').style.display='inline-flex';
      if(s.processed>0){
        const log=document.getElementById('migrateLiveLog');
        const hint=document.createElement('div');
        hint.style.cssText='text-align:center;padding:8px 12px;color:var(--text-muted);font-size:11px;border-bottom:1px solid var(--border)';
        hint.textContent=t('migrate.reconnect.hint').replace('{n}',s.processed);
        log.appendChild(hint);
      }
      connectMigrateSSE('/api/migrate/stream','GET',null);
      fetch('/api/migrate/scan').then(function(sr){return sr.json()}).then(function(sd){
        if(sd&&sd.hasImportedData) document.getElementById('postprocessSection').style.display='block';
      }).catch(function(){});
    }else if(s.done&&(s.stored>0||s.skipped>0||s.stopped)){
      migrateStats={stored:s.stored,skipped:s.skipped,merged:s.merged,errors:s.errors};
      updateMigrateStats();
      const progEl=document.getElementById('migrateProgress');
      if(!progEl)return;
      progEl.style.display='block';
      const pct=s.total>0?Math.round((s.processed/s.total)*100):0;
      document.getElementById('migrateBar').style.width=pct+'%';
      document.getElementById('migrateCounter').textContent=s.processed+' / '+s.total+' ('+pct+'%)';
      onMigrateDone(!!s.stopped,true);
    }
  }catch(e){console.log('checkMigrateStatus error',e);}
}

function handleMigrateEvent(evtType,data){
  if(evtType==='phase'){
    const label=data.phase==='sqlite'?t('migrate.phase.sqlite'):t('migrate.phase.sessions');
    document.getElementById('migratePhaseLabel').textContent=label;
  }
  else if(evtType==='progress'){
    document.getElementById('migrateCounter').textContent=data.processed+' / '+data.total;
  }
  else if(evtType==='item'){
    if(data.status==='stored')migrateStats.stored++;
    else if(data.status==='skipped'||data.status==='duplicate')migrateStats.skipped++;
    else if(data.status==='merged')migrateStats.merged++;
    else if(data.status==='error')migrateStats.errors++;
    updateMigrateStats();

    const pct=data.total>0?Math.round((data.index/data.total)*100):0;
    document.getElementById('migrateBar').style.width=pct+'%';
    document.getElementById('migrateCounter').textContent=data.index+' / '+data.total+' ('+pct+'%)';

    appendMigrateLogItem(data);
  }
  else if(evtType==='error'){
    migrateStats.errors++;
    updateMigrateStats();
    appendMigrateLogItem({status:'error',preview:data.error||data.file,source:data.file});
  }
  else if(evtType==='summary'){
    document.getElementById('migrateBar').style.width='100%';
    const tp=data.totalProcessed||0;
    document.getElementById('migrateCounter').textContent=tp+' / '+tp+' (100%)';
  }
  else if(evtType==='done'){
    onMigrateDone(false);
  }
  else if(evtType==='stopped'){
    onMigrateDone(true);
  }
  else if(evtType==='state'){
    migrateStats={stored:data.stored||0,skipped:data.skipped||0,merged:data.merged||0,errors:data.errors||0};
    updateMigrateStats();
    const pct=data.total>0?Math.round((data.processed/data.total)*100):0;
    document.getElementById('migrateBar').style.width=pct+'%';
    document.getElementById('migrateCounter').textContent=data.processed+' / '+data.total+' ('+pct+'%)';
    if(data.phase){
      const label=data.phase==='sqlite'?t('migrate.phase.sqlite'):t('migrate.phase.sessions');
      document.getElementById('migratePhaseLabel').textContent=label;
    }
  }
}

function updateMigrateStats(){
  document.getElementById('migrateStatStored').textContent=migrateStats.stored;
  document.getElementById('migrateStatSkipped').textContent=migrateStats.skipped;
  document.getElementById('migrateStatMerged').textContent=migrateStats.merged;
  document.getElementById('migrateStatErrors').textContent=migrateStats.errors;
}

function appendMigrateLogItem(data){
  const log=document.getElementById('migrateLiveLog');
  const icons={stored:'\\u2705',skipped:'\\u23ED',merged:'\\u{1F500}',error:'\\u274C',duplicate:'\\u23ED'};
  const statusClass=data.status==='duplicate'?'skipped':data.status;
  const el=document.createElement('div');
  el.className='migrate-log-item';
  el.innerHTML=
    '<div class="log-icon '+statusClass+'">'+( icons[data.status]||'\\u2022')+'</div>'+
    '<div class="log-body">'+
      '<div class="log-preview">'+esc(data.preview||'')+'</div>'+
      '<div class="log-meta">'+
        '<span class="tag '+statusClass+'">'+(data.status||'').toUpperCase()+'</span>'+
        (data.source?'<span>'+esc(data.source)+'</span>':'')+
        (data.role?'<span>'+data.role+'</span>':'')+
        (data.summary?'<span style="opacity:.7">'+esc(data.summary)+'</span>':'')+
      '</div>'+
    '</div>';
  log.appendChild(el);
  log.scrollTop=log.scrollHeight;
}

function onMigrateDone(wasStopped,skipReload){
  window._migrateRunning=false;
  document.getElementById('migrateScanBtn').disabled=false;
  document.getElementById('migrateStopBtn').disabled=true;
  document.getElementById('migrateStopBtn').textContent=t('migrate.stop');
  document.getElementById('migrateStopBtn').style.display='none';
  if(wasStopped){
    document.getElementById('migrateBar').style.background='linear-gradient(90deg,#f59e0b,#fbbf24)';
    document.getElementById('migrateStartConcurrencyWrap').style.display='flex';
    document.getElementById('migrateStartBtn').textContent=t('migrate.resume');
    document.getElementById('migratePhaseLabel').textContent=t('migrate.phase.stopped');
  }else{
    document.getElementById('migrateBar').style.width='100%';
    document.getElementById('migrateBar').style.background='linear-gradient(90deg,#22c55e,#16a34a)';
    const total=migrateStats.stored+migrateStats.skipped+migrateStats.merged+migrateStats.errors;
    if(total>0) document.getElementById('migrateCounter').textContent=total+' / '+total+' (100%)';
    document.getElementById('migratePhaseLabel').textContent=t('migrate.phase.done');
  }
  fetch('/api/migrate/scan').then(r=>{if(!r.ok)throw new Error();return r.json()}).then(d=>{
    if(d&&d.hasImportedData){
      document.getElementById('postprocessSection').style.display='block';
    }
  }).catch(()=>{});
  if(!skipReload) loadAll();
}

/* ─── Post-processing: tasks & skills ─── */

var ppStats={tasks:0,skills:0,errors:0,skipped:0};
window._ppRunning=false;

function ppStart(){
  var enableTasks=document.getElementById('ppEnableTasks').checked;
  var enableSkills=document.getElementById('ppEnableSkills').checked;
  if(!enableTasks&&!enableSkills){toast(t('pp.select.warn'),'error');return;}

  var ppConcSel=document.getElementById('ppConcurrency');
  var ppConcurrency=ppConcSel?parseInt(ppConcSel.value,10)||1:1;

  window._ppRunning=true;
  _ppSSEConnected=false;
  ppStats={tasks:0,skills:0,errors:0,skipped:0};
  document.getElementById('ppStartBtn').style.display='none';
  document.getElementById('ppStopBtn').style.display='inline-flex';
  document.getElementById('ppStopBtn').disabled=false;
  document.getElementById('ppStopBtn').textContent=t('migrate.stop');
  document.getElementById('ppProgress').style.display='block';
  document.getElementById('ppDone').style.display='none';
  document.getElementById('ppBar').style.width='0%';
  document.getElementById('ppBar').style.background='linear-gradient(90deg,#f59e0b,#fbbf24)';
  document.getElementById('ppPhaseLabel').textContent=t('pp.running');
  document.getElementById('ppCounter').textContent='';
  document.getElementById('ppLiveLog').innerHTML='';
  updatePPStats();

  var body=JSON.stringify({enableTasks:enableTasks,enableSkills:enableSkills,concurrency:ppConcurrency});
  fetch('/api/migrate/postprocess',{method:'POST',headers:{'Content-Type':'application/json'},body:body})
    .then(function(r){
      if(!r.ok){
        r.json().then(function(j){toast(j.error||('Postprocess failed: '+r.status),'error');}).catch(function(){toast('Postprocess failed: '+r.status,'error');});
        ppDone(false,true);
        return;
      }
      readPPStream(r.body.getReader());
    })
    .catch(function(e){toast('Postprocess failed: '+e.message,'error');ppDone(false,true);});
}

function updatePPStats(){
  document.getElementById('ppStatTasks').textContent=ppStats.tasks;
  document.getElementById('ppStatSkills').textContent=ppStats.skills;
  document.getElementById('ppStatErrors').textContent=ppStats.errors;
  document.getElementById('ppStatSkipped').textContent=ppStats.skipped;
}

function appendPPLogItem(data){
  var log=document.getElementById('ppLiveLog');
  var el=document.createElement('div');
  el.style.cssText='display:flex;align-items:flex-start;gap:8px;padding:6px 12px;border-bottom:1px solid var(--border)';
  var icon='\\u2022';var color='var(--text-muted)';
  if(data.step==='done'){icon='\\u2705';color='#22c55e';}
  else if(data.step==='error'){icon='\\u274C';color='#ef4444';}
  else if(data.step==='processing'){icon='\\u23F3';color='#f59e0b';}
  else if(data.step==='skipped'){icon='\\u23ED';color='#3b82f6';}
  else if(data.step==='skill'){icon='\\u{1F9E0}';color='#8b5cf6';}
  var label=data.taskTitle||data.session||data.title||'';
  if(label.length>60)label=label.slice(0,57)+'...';
  el.innerHTML='<span style="color:'+color+';min-width:18px">'+icon+'</span>'+
    '<span style="flex:1;color:var(--text-sec)">'+esc(label)+'</span>'+
    '<span style="color:var(--text-muted);font-size:10px">'+(data.index||'')+' / '+(data.total||'')+'</span>';
  if(data.error) el.innerHTML+='<span style="color:#ef4444;font-size:10px">'+esc(data.error)+'</span>';
  log.appendChild(el);
  log.scrollTop=log.scrollHeight;
}

function readPPStream(reader){
  var NL=String.fromCharCode(10);
  var dec=new TextDecoder();
  var buf='';
  var ppDoneCalled=false;
  function pump(){
    reader.read().then(function(result){
      if(result.done){if(!ppDoneCalled)ppDone(false);return;}
      buf+=dec.decode(result.value,{stream:true});
      var lines=buf.split(NL);
      buf=lines.pop()||'';
      var evtType='';
      for(var i=0;i<lines.length;i++){
        var line=lines[i];
        if(line.startsWith('event: '))evtType=line.slice(7).trim();
        else if(line.startsWith('data: ')&&evtType){
          try{
            if(evtType==='done'||evtType==='stopped')ppDoneCalled=true;
            handlePPEvent(evtType,JSON.parse(line.slice(6)));
          }catch(e){}
          evtType='';
        }
      }
      pump();
    }).catch(function(){if(!ppDoneCalled)ppDone(false);});
  }
  pump();
}

var _ppSSEConnected=false;
function connectPPSSE(){
  if(_ppSSEConnected) return;
  _ppSSEConnected=true;
  fetch('/api/migrate/postprocess/status').then(function(r){return r.json();}).then(function(s){
    if(s.running){
      window._ppRunning=true;
      document.getElementById('postprocessSection').style.display='block';
      document.getElementById('ppStartBtn').style.display='none';
      document.getElementById('ppStopBtn').style.display='inline-flex';
      document.getElementById('ppStopBtn').disabled=false;
      document.getElementById('ppStopBtn').textContent=t('migrate.stop');
      document.getElementById('ppProgress').style.display='block';
      document.getElementById('ppDone').style.display='none';
      ppStats={tasks:s.tasksCreated||0,skills:s.skillsCreated||0,errors:s.errors||0,skipped:0};
      updatePPStats();
      var pct=s.total>0?Math.round((s.processed/s.total)*100):0;
      document.getElementById('ppBar').style.width=pct+'%';
      document.getElementById('ppCounter').textContent=s.processed+' / '+s.total+' ('+pct+'%)';
      document.getElementById('ppPhaseLabel').textContent=t('pp.running');
      fetch('/api/migrate/postprocess/stream',{method:'GET'}).then(function(r){
        if(r.ok&&r.body)readPPStream(r.body.getReader());
      }).catch(function(){});
    }else if(s.done){
      document.getElementById('postprocessSection').style.display='block';
      ppStats={tasks:s.tasksCreated||0,skills:s.skillsCreated||0,errors:s.errors||0,skipped:s.skippedSessions||0};
      updatePPStats();
      document.getElementById('ppProgress').style.display='block';
      var totalAll=(s.total||0)+(s.skippedSessions||0);
      if(totalAll>0){
        document.getElementById('ppBar').style.width='100%';
        document.getElementById('ppCounter').textContent=totalAll+' / '+totalAll+' (100%)';
      }else{
        var pct2=s.total>0?Math.round((s.processed/s.total)*100):0;
        document.getElementById('ppBar').style.width=pct2+'%';
        document.getElementById('ppCounter').textContent=s.processed+' / '+s.total+' ('+pct2+'%)';
      }
      ppDone(!!s.stopped,false,true);
    }
  }).catch(function(){});
}

function handlePPEvent(evtType,data){
  if(evtType==='progress'){
    if(data.total>0){
      var pct=Math.round((data.processed/data.total)*100);
      document.getElementById('ppBar').style.width=pct+'%';
      document.getElementById('ppCounter').textContent=data.processed+' / '+data.total+' ('+pct+'%)';
    }
  }else if(evtType==='info'){
    if(data.alreadyProcessed>0){
      ppStats.skipped=data.alreadyProcessed;
      updatePPStats();
      appendPPLogItem({step:'skipped',session:t('pp.info.skipped').replace('{n}',data.alreadyProcessed),index:'',total:''});
    }
    if(data.pending===0){
      appendPPLogItem({step:'done',session:t('pp.info.allDone'),index:'',total:''});
      document.getElementById('ppPhaseLabel').textContent=t('pp.info.allDone');
      document.getElementById('ppBar').style.width='100%';
      document.getElementById('ppBar').style.background='linear-gradient(90deg,#22c55e,#16a34a)';
      document.getElementById('ppCounter').textContent=data.alreadyProcessed+' / '+data.totalSessions;
    }else{
      document.getElementById('ppPhaseLabel').textContent=t('pp.info.pending').replace('{n}',data.pending);
    }
  }else if(evtType==='item'){
    var label=data.session||'';
    if(label.length>40)label=label.slice(0,37)+'...';
    if(data.step==='processing'){
      var actionLabel=data.action==='skill-only'?t('pp.action.skillOnly'):t('pp.action.full');
      document.getElementById('ppPhaseLabel').textContent=t('pp.running')+' — '+actionLabel+' — '+label;
    }
    if(data.step==='done'){
      if(data.action!=='skill-only'){
        ppStats.tasks++;
        updatePPStats();
      }
    }else if(data.step==='error'){
      ppStats.errors++;
      updatePPStats();
    }
    appendPPLogItem(data);
  }else if(evtType==='skill'){
    ppStats.skills++;
    updatePPStats();
    appendPPLogItem({step:'skill',title:data.title,index:'',total:''});
  }else if(evtType==='done'){
    ppDone(false);
  }else if(evtType==='stopped'){
    ppDone(true);
  }
}

function ppStop(){
  document.getElementById('ppStopBtn').disabled=true;
  document.getElementById('ppStopBtn').textContent=t('migrate.stopping');
  fetch('/api/migrate/postprocess/stop',{method:'POST'}).catch(function(){});
}

function ppDone(wasStopped,wasFailed,skipReload){
  window._ppRunning=false;
  document.getElementById('ppStopBtn').style.display='none';
  document.getElementById('ppStartBtn').style.display='inline-flex';
  document.getElementById('ppStartBtn').textContent=wasStopped?t('pp.resume'):t('pp.start');
  document.getElementById('ppStartBtn').disabled=false;
  var doneEl=document.getElementById('ppDone');
  doneEl.style.display='block';
  if(wasFailed){
    doneEl.style.background='rgba(239,68,68,.06)';
    doneEl.style.color='#ef4444';
    doneEl.textContent=t('pp.failed')||'Processing failed — check error above';
    document.getElementById('ppBar').style.background='linear-gradient(90deg,#ef4444,#dc2626)';
    document.getElementById('ppPhaseLabel').textContent=t('pp.failed');
  }else if(wasStopped){
    doneEl.style.background='rgba(245,158,11,.06)';
    doneEl.style.color='#f59e0b';
    doneEl.textContent=t('pp.stopped');
    document.getElementById('ppBar').style.background='linear-gradient(90deg,#f59e0b,#fbbf24)';
    document.getElementById('ppPhaseLabel').textContent=t('pp.stopped');
  }else{
    doneEl.style.background='rgba(34,197,94,.06)';
    doneEl.style.color='#22c55e';
    document.getElementById('ppBar').style.width='100%';
    document.getElementById('ppBar').style.background='linear-gradient(90deg,#22c55e,#16a34a)';
    document.getElementById('ppPhaseLabel').textContent=t('pp.done');
    var ppTotal=ppStats.tasks+ppStats.skipped+ppStats.errors;
    if(ppTotal>0) document.getElementById('ppCounter').textContent=ppTotal+' / '+ppTotal+' (100%)';
    fetch('/api/migrate/postprocess/status').then(function(r){return r.json()}).then(function(st){
      var totalTasks=st.existingTasks||0;
      var totalSkills=st.existingSkills||0;
      var lines=[];
      if(ppStats.tasks>0) lines.push(t('pp.stat.tasks')+' +'+ppStats.tasks);
      if(ppStats.skills>0) lines.push(t('pp.stat.skills')+' +'+ppStats.skills);
      if(ppStats.skipped>0) lines.push(t('pp.stat.skipped')+': '+ppStats.skipped);
      var runText=lines.length>0?' ('+lines.join(', ')+')':'';
      var totalText=' — '+t('pp.stat.tasks')+' '+totalTasks+', '+t('pp.stat.skills.total')+' '+totalSkills;
      doneEl.textContent=t('pp.done')+runText+totalText;
    }).catch(function(){
      var parts=[];
      if(ppStats.tasks>0) parts.push(t('pp.stat.tasks')+': '+ppStats.tasks);
      if(ppStats.skills>0) parts.push(t('pp.stat.skills')+': '+ppStats.skills);
      if(ppStats.skipped>0) parts.push(t('pp.stat.skipped')+': '+ppStats.skipped);
      doneEl.textContent=t('pp.done')+(parts.length>0?' ('+parts.join(', ')+')':'');
    });
  }
  if(!skipReload) loadAll();
}

/* ─── Embedding Banner ─── */
function showEmbeddingBanner(msg,type){
  if(document.getElementById('embBanner')) return;
  var cls=type==='error'?'emb-banner error':'emb-banner warning';
  var icon=type==='error'?'\\u274C':'\\u26A0\\uFE0F';
  var btn='<button class="emb-banner-btn" onclick="switchView(\\'settings\\');this.parentElement.remove()">'+t('embed.banner.goto')+'</button>';
  var close='<button class="emb-banner-close" onclick="this.parentElement.remove()">&times;</button>';
  var el=document.createElement('div');
  el.id='embBanner';
  el.className=cls;
  el.innerHTML=icon+' <span>'+esc(msg)+'</span>'+btn+close;
  var mc=document.querySelector('.main-content');
  if(mc) mc.parentElement.insertBefore(el,mc);
}

/* ─── Toast ─── */
function toast(msg,type='info'){
  const c=document.getElementById('toasts');
  const t=document.createElement('div');
  t.className='toast '+type;
  const icons={success:'\\u2705',error:'\\u274C',info:'\\u2139\\uFE0F',warn:'\\u26A0\\uFE0F'};
  t.innerHTML=(icons[type]||'')+' '+esc(msg);
  c.appendChild(t);
  setTimeout(()=>t.remove(),3500);
}

var _confirmResolve=null;
function confirmModal(message,opts){
  opts=opts||{};
  return new Promise(function(resolve){
    _confirmResolve=resolve;
    var overlay=document.getElementById('confirmOverlay');
    document.getElementById('confirmTitle').textContent=opts.title||t('confirm.title')||'\u786E\u8BA4';
    document.getElementById('confirmBody').innerText=message||'';
    var okBtn=document.getElementById('confirmOkBtn');
    okBtn.textContent=opts.okText||t('confirm.ok')||'\u786E\u5B9A';
    okBtn.className='btn-confirm-ok'+(opts.danger?' danger':'');
    var cancelBtn=document.getElementById('confirmCancelBtn');
    cancelBtn.textContent=opts.cancelText||t('confirm.cancel')||'\u53D6\u6D88';
    cancelBtn.style.display=opts.hideCancel?'none':'';
    overlay.classList.add('show');
  });
}
function confirmModalClose(result){
  document.getElementById('confirmOverlay').classList.remove('show');
  document.getElementById('confirmCancelBtn').style.display='';
  if(_confirmResolve){var r=_confirmResolve;_confirmResolve=null;r(result);}
}
function alertModal(message,opts){
  opts=opts||{};
  return confirmModal(message,Object.assign({},opts,{hideCancel:true,okText:opts.okText||t('confirm.ok')||'\u77E5\u9053\u4E86'}));
}

/* ─── Theme ─── */
const VIEWER_THEME_KEY='memos-viewer-theme';
function initViewerTheme(){const s=localStorage.getItem(VIEWER_THEME_KEY);const theme=(s==='light'||s==='dark')?s:'dark';document.documentElement.setAttribute('data-theme',theme);}
function toggleViewerTheme(){const el=document.documentElement;const cur=el.getAttribute('data-theme')||'dark';const next=cur==='dark'?'light':'dark';el.setAttribute('data-theme',next);localStorage.setItem(VIEWER_THEME_KEY,next);}
initViewerTheme();

/* ─── Restart overlay ─── */
function showRestartOverlay(msg){
  var existing=document.getElementById('restartOverlay');
  if(existing) existing.remove();
  var ov=document.createElement('div');
  ov.id='restartOverlay';
  ov.style.cssText='position:fixed;inset:0;z-index:99999;display:flex;flex-direction:column;align-items:center;justify-content:center;background:rgba(0,0,0,.55);backdrop-filter:blur(6px);color:#fff;font-family:inherit';
  ov.innerHTML='<div style="display:flex;flex-direction:column;align-items:center;gap:16px;max-width:400px;text-align:center"><div style="width:36px;height:36px;border:3px solid rgba(255,255,255,.2);border-top-color:#fff;border-radius:50%;animation:spin 1s linear infinite"></div><div style="font-size:15px;font-weight:600">'+esc(msg||t('update.restarting'))+'</div><div id="restartOverlayHint" style="font-size:12px;opacity:.6">'+t('settings.restart.autoRefresh')+'</div></div>';
  document.body.appendChild(ov);
  waitForGatewayAndReload(60);
}

/* ─── Update check ─── */
function waitForGatewayAndReload(maxAttempts,attempt){
  attempt=attempt||0;
  var phase=arguments.length>2?arguments[2]:'waitDown';
  var MAX_WAIT_DOWN=8;
  function forceReload(){window.location.href=window.location.pathname+'?_t='+Date.now();}
  if(attempt>=maxAttempts){forceReload();return;}
  var delay=phase==='waitDown'?1500:2500;
  setTimeout(function(){
    fetch('/api/auth/status').then(function(r){
      if(phase==='waitDown'){
        if(r.ok||r.status===401||r.status===403){
          if(attempt>=MAX_WAIT_DOWN){
            forceReload();
          }else{
            waitForGatewayAndReload(maxAttempts,attempt+1,'waitDown');
          }
        }else{
          waitForGatewayAndReload(maxAttempts,0,'waitUp');
        }
      }else{
        if(r.ok||r.status===401||r.status===403) forceReload();
        else waitForGatewayAndReload(maxAttempts,attempt+1,'waitUp');
      }
    }).catch(function(){
      if(phase==='waitDown'){
        waitForGatewayAndReload(maxAttempts,0,'waitUp');
      }else{
        waitForGatewayAndReload(maxAttempts,attempt+1,'waitUp');
      }
    });
  },delay);
}
function doUpdateInstall(packageSpec,btnEl,statusEl,targetVersion){
  btnEl.disabled=true;
  btnEl.textContent=t('update.installing');
  btnEl.style.cssText='background:rgba(99,102,241,.15);color:var(--pri);border:1px solid rgba(99,102,241,.3);border-radius:6px;padding:4px 14px;font-size:12px;font-weight:600;cursor:wait;white-space:nowrap';
  fetch('/api/update-install',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({packageSpec:packageSpec,targetVersion:targetVersion||''})})
    .then(function(r){return r.json()})
    .then(function(d){
      if(d.ok){
        btnEl.textContent=t('update.success')+(d.version?' v'+d.version:'');
        btnEl.style.cssText='background:rgba(34,197,94,.15);color:#22c55e;border:1px solid rgba(34,197,94,.3);border-radius:6px;padding:4px 14px;font-size:12px;font-weight:600;cursor:default;white-space:nowrap';
        showRestartOverlay(t('update.restarting'));
      }else{
        btnEl.textContent=t('update.btn');
        btnEl.style.cssText='background:none;border:1px solid currentColor;border-radius:6px;padding:4px 14px;font-size:12px;font-weight:600;color:inherit;cursor:pointer;white-space:nowrap;opacity:.85';
        btnEl.disabled=false;
        if(statusEl)statusEl.textContent=t('update.failed')+': '+(d.error||'').slice(0,60);
        setTimeout(function(){if(statusEl)statusEl.textContent='';},8000);
      }
    })
    .catch(function(){
      btnEl.textContent=t('update.btn');
      btnEl.style.cssText='background:none;border:1px solid currentColor;border-radius:6px;padding:4px 14px;font-size:12px;font-weight:600;color:inherit;cursor:pointer;white-space:nowrap;opacity:.85';
      btnEl.disabled=false;
    });
}
var _updateChecked=false;
async function checkForUpdate(){
  if(_updateChecked) return;
  _updateChecked=true;
  try{
    const r=await fetch('/api/update-check?_t='+Date.now(),{cache:'no-store'});
    if(!r.ok)return;
    const d=await r.json();
    if(!d.updateAvailable)return;
    const pkgSpec=d.packageName+'@'+d.latest;
    var bannerWrap=document.createElement('div');
    bannerWrap.id='updateBannerWrap';
    bannerWrap.style.cssText='background:linear-gradient(135deg,rgba(99,102,241,.08),rgba(139,92,246,.06));border-bottom:1px solid rgba(99,102,241,.18);backdrop-filter:blur(8px);animation:slideIn .3s ease';
    var banner=document.createElement('div');
    banner.id='updateBanner';
    banner.style.cssText='display:flex;align-items:center;gap:12px;padding:10px 32px;width:100%;max-width:1400px;margin:0 auto;font-size:13px;font-weight:500;box-sizing:border-box;color:var(--pri)';
    var textNode=document.createElement('div');
    textNode.style.cssText='display:flex;align-items:center;gap:8px;flex-shrink:0;font-size:13px';
    textNode.innerHTML='<span style="font-size:15px">\u2728</span> '+t('update.available')+' <span style="padding:2px 8px;border-radius:6px;background:rgba(99,102,241,.1);font-size:12px;font-weight:600">v'+esc(d.current)+'</span> <span style="opacity:.5">\u2192</span> <span style="padding:2px 8px;border-radius:6px;background:rgba(52,211,153,.12);color:var(--green);font-size:12px;font-weight:600">v'+esc(d.latest)+'</span>';
    var btnUpdate=document.createElement('button');
    btnUpdate.style.cssText='background:var(--pri);color:#fff;border:none;border-radius:8px;padding:5px 16px;font-size:12px;font-weight:600;cursor:pointer;white-space:nowrap;transition:opacity .15s,transform .1s;margin-left:4px';
    btnUpdate.textContent=t('update.btn');
    btnUpdate.onmouseenter=function(){this.style.opacity='.9';this.style.transform='scale(1.02)'};
    btnUpdate.onmouseleave=function(){this.style.opacity='1';this.style.transform='scale(1)'};
    var statusDiv=document.createElement('div');
    statusDiv.style.cssText='font-size:11px;opacity:.7;flex-shrink:0';
    btnUpdate.onclick=function(){doUpdateInstall(pkgSpec,btnUpdate,statusDiv,d.latest)};
    textNode.appendChild(btnUpdate);
    var spacer=document.createElement('div');
    spacer.style.cssText='flex:1';
    var btnClose=document.createElement('button');
    btnClose.style.cssText='background:none;border:none;font-size:16px;color:var(--text-muted);cursor:pointer;opacity:.5;padding:0 2px;line-height:1;transition:opacity .15s';
    btnClose.innerHTML='&times;';
    btnClose.onmouseenter=function(){this.style.opacity='1'};
    btnClose.onmouseleave=function(){this.style.opacity='.5'};
    btnClose.onclick=function(){bannerWrap.remove()};
    var spacerL=document.createElement('div');
    spacerL.style.cssText='flex:1';
    banner.appendChild(spacerL);
    banner.appendChild(textNode);
    banner.appendChild(statusDiv);
    banner.appendChild(spacer);
    banner.appendChild(btnClose);
    bannerWrap.appendChild(banner);
    var tb=document.querySelector('.topbar');
    if(tb&&tb.parentNode){tb.parentNode.insertBefore(bannerWrap,tb);}
    else{document.body.insertBefore(bannerWrap,document.body.firstChild);}
  }catch(e){}
}

/* ─── Init ─── */
try{
  var savedScope=localStorage.getItem('memos_memorySearchScope');
  if(savedScope==='local') savedScope='allLocal';
  if(savedScope&&(savedScope==='allLocal'||savedScope==='hub')){
    memorySearchScope=savedScope;
    var scopeEl=document.getElementById('memorySearchScope');
    if(scopeEl) scopeEl.value=savedScope;
  }
}catch(e){}
restorePageSizeSetting('memos_memoryPageSize','memoryPageSize',20,function(next){PAGE_SIZE=next;});
restorePageSizeSetting('memos_skillsPageSize','skillsPageSize',20,function(next){skillsPageSize=next;});
restorePageSizeSetting('memos_tasksPageSize','tasksPageSize',20,function(next){tasksPageSize=next;});
document.getElementById('modalOverlay').addEventListener('click',e=>{if(e.target.id==='modalOverlay')closeModal()});
document.getElementById('searchInput').addEventListener('keydown',e=>{if(e.key==='Escape'){e.target.value='';currentPage=1;if(memorySearchScope==='hub')loadHubMemories();else loadMemories();}});
applyI18n();
checkAuth();
</script>

<!-- Memory Detail Modal -->
<div class="memory-modal-overlay" id="memoryModal" onclick="if(event.target===this)closeMemoryModal()">
  <div class="memory-modal">
    <div class="memory-modal-title">
      <div class="mm-tl"><div class="mm-tl-icon">\u{1F9E0}</div><span data-i18n="memory.detail.title">Memory Detail</span></div>
      <button class="mm-close" onclick="closeMemoryModal()" title="Close">&times;</button>
    </div>
    <div class="memory-modal-body" id="memoryModalBody"></div>
  </div>
</div>

    <div class="confirm-overlay" id="confirmOverlay" onclick="confirmModalClose(false)">
      <div class="confirm-panel" onclick="event.stopPropagation()">
        <div class="confirm-panel-header" id="confirmTitle"></div>
        <div class="confirm-panel-body" id="confirmBody"></div>
        <div class="confirm-panel-footer">
          <button class="btn-confirm-cancel" id="confirmCancelBtn" onclick="confirmModalClose(false)"></button>
          <button class="btn-confirm-ok" id="confirmOkBtn" onclick="confirmModalClose(true)"></button>
        </div>
      </div>
    </div>
</body>
</html>`;
}
