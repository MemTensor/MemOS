export function viewerHTML(pluginVersion?: string): string {
const vBadge = pluginVersion ? `<span class="version-badge">v${pluginVersion}</span>` : '';
return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>OpenClaw Memory - Powered by MemOS</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>
*{margin:0;padding:0;box-sizing:border-box}
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
[data-theme="light"] .session-item .count,[data-theme="light"] .kind-tag,[data-theme="light"] .session-tag{background:rgba(0,0,0,.05)}
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
[data-theme="light"] .chart-bar{box-shadow:none}
[data-theme="light"] .chart-bar:hover{box-shadow:0 2px 8px rgba(79,70,229,.15)}
[data-theme="light"] .tool-chart-tooltip{background:rgba(17,24,39,.92);color:#e8eaed;border-color:rgba(99,102,241,.3);box-shadow:0 8px 24px rgba(0,0,0,.2)}
[data-theme="light"] .tool-chart-tooltip .tt-time{color:#a5b4fc}
[data-theme="light"] .tool-chart-tooltip .tt-val{color:#e8eaed}
[data-theme="light"] .tool-agg-table td{background:transparent}
[data-theme="light"] .tool-agg-table tr:hover td{background:rgba(79,70,229,.03)}
[data-theme="light"] .tool-agg-table th{color:#9ca3af}
[data-theme="light"] .breakdown-item{background:#f9fafb;border-color:var(--border)}
[data-theme="light"] .breakdown-item:hover{background:#f3f4f6;border-color:#cbd5e1}
[data-theme="light"] .breakdown-bar-wrap{background:#e5e7eb}
[data-theme="light"] .breakdown-bar{background:linear-gradient(90deg,#4f46e5,#6366f1);box-shadow:none}
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
.topbar{background:rgba(11,13,17,.88);border-bottom:1px solid var(--border);padding:0 28px;height:56px;display:flex;align-items:center;position:sticky;top:0;z-index:100;backdrop-filter:blur(12px)}
.topbar .brand{display:flex;align-items:center;gap:10px;font-weight:700;font-size:15px;color:var(--text);letter-spacing:-.02em;flex-shrink:0}
.topbar .brand .icon{width:32px;height:32px;display:flex;align-items:center;justify-content:center;font-size:22px;background:none;border-radius:0}
.topbar .brand .sub{font-weight:400;color:var(--text-muted);font-size:11px}
.version-badge{font-size:10px;font-weight:600;color:var(--text-muted);background:rgba(255,255,255,.08);border:1px solid rgba(255,255,255,.1);padding:1px 7px;border-radius:6px;margin-left:6px;letter-spacing:.02em;user-select:all}
[data-theme="light"] .version-badge{background:rgba(0,0,0,.05);border-color:rgba(0,0,0,.08);color:var(--text-sec)}
.topbar-center{flex:1;display:flex;justify-content:center}
.topbar .actions{display:flex;align-items:center;gap:6px;flex-shrink:0}

.main-content{display:flex;flex:1;max-width:1400px;margin:0 auto;width:100%;padding:28px 32px;gap:28px}

/* ─── Sidebar ─── */
.sidebar{width:260px;flex-shrink:0}
.sidebar .stats-grid{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:24px}
.stat-card{background:var(--bg-card);border:1px solid var(--border);border-radius:var(--radius);padding:18px;transition:all .2s}
.stat-card:hover{border-color:var(--border-glow);background:var(--bg-card-hover)}
.stat-card .stat-value{font-size:22px;font-weight:700;color:var(--text);letter-spacing:-.02em}
.stat-card .stat-label{font-size:12px;color:var(--text-sec);margin-top:4px;font-weight:500}
.stat-card.pri .stat-value{color:var(--pri)}
.stat-card.green .stat-value{color:var(--green)}
.stat-card.amber .stat-value{color:var(--amber)}
.stat-card.rose .stat-value{color:var(--rose)}

.sidebar .section-title{font-size:11px;font-weight:600;color:var(--text-muted);text-transform:uppercase;letter-spacing:.08em;margin:24px 0 12px;padding:0 2px}
.sidebar .session-list{display:flex;flex-direction:column;gap:6px;max-height:280px;overflow-y:auto}
.session-item{display:flex;align-items:center;justify-content:space-between;padding:10px 14px;background:var(--bg-card);border:1px solid var(--border);border-radius:10px;cursor:pointer;transition:all .15s;font-size:13px;color:var(--text)}
.session-item:hover{border-color:var(--pri);background:var(--pri-glow)}
.session-item.active{border-color:var(--pri);background:var(--pri-glow);font-weight:600;color:var(--pri)}
.session-item .count{color:var(--text-sec);font-size:11px;font-weight:600;background:rgba(0,0,0,.2);padding:3px 8px;border-radius:8px}

.provider-badge{display:inline-flex;align-items:center;gap:6px;padding:6px 12px;background:var(--green-bg);color:var(--green);border-radius:999px;font-size:11px;font-weight:600;margin-top:10px}
.provider-badge.offline{background:var(--amber-bg);color:var(--amber)}

/* ─── Feed ─── */
.feed{flex:1;min-width:0}
.search-bar{display:flex;gap:10px;margin-bottom:16px;position:relative;align-items:center}
.search-bar input{flex:1;padding:10px 16px 10px 40px;border:1px solid var(--border);border-radius:10px;font-size:14px;outline:none;background:var(--bg-card);color:var(--text);transition:all .2s}
.search-bar input::placeholder{color:var(--text-muted)}
.search-bar input:focus{border-color:var(--pri);box-shadow:0 0 0 3px var(--pri-glow)}
.search-bar .search-icon{position:absolute;left:14px;top:50%;transform:translateY(-50%);color:var(--text-muted);font-size:14px;pointer-events:none}
.search-meta{font-size:12px;color:var(--text-sec);margin-bottom:14px;padding:0 2px}

.filter-bar{display:flex;gap:8px;margin-bottom:16px;flex-wrap:wrap}
.filter-chip{padding:5px 14px;border:1px solid var(--border);border-radius:6px;background:transparent;color:var(--text-sec);font-size:12px;font-weight:500;transition:all .15s}
.filter-chip:hover{border-color:var(--pri);color:var(--pri)}
.filter-chip.active{background:rgba(99,102,241,.08);color:var(--pri);border-color:rgba(99,102,241,.25)}

.memory-list{display:flex;flex-direction:column;gap:16px}
.memory-card{background:var(--bg-card);border:1px solid var(--border);border-radius:var(--radius-lg);padding:20px 24px;transition:all .2s}
.memory-card:hover{border-color:var(--border-glow);background:var(--bg-card-hover)}
.memory-card .card-header{display:flex;align-items:center;justify-content:space-between;margin-bottom:12px;flex-wrap:wrap;gap:8px}
.memory-card .meta{display:flex;align-items:center;gap:8px}
.role-tag{padding:4px 10px;border-radius:8px;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.03em}
.role-tag.user{background:var(--pri-glow);color:var(--pri);border:1px solid rgba(99,102,241,.12)}
.role-tag.assistant{background:var(--accent-glow);color:var(--accent);border:1px solid rgba(230,57,70,.2)}
.role-tag.system{background:var(--amber-bg);color:var(--amber);border:1px solid rgba(245,158,11,.2)}
.kind-tag{padding:4px 10px;border-radius:8px;font-size:11px;color:var(--text-sec);background:rgba(0,0,0,.2);font-weight:500}
.card-time{font-size:12px;color:var(--text-sec);display:flex;align-items:center;gap:8px}
.session-tag{font-size:11px;font-family:ui-monospace,monospace;color:var(--text-muted);background:rgba(0,0,0,.2);padding:3px 8px;border-radius:6px;cursor:default}
.card-summary{font-size:15px;font-weight:600;color:var(--text);margin-bottom:10px;line-height:1.5;letter-spacing:-.01em}
.card-content{font-size:13px;color:var(--text-sec);line-height:1.65;max-height:0;overflow:hidden;transition:max-height .3s ease}
.card-content.show{max-height:600px;overflow-y:auto}
.card-content pre{white-space:pre-wrap;word-break:break-all;background:rgba(0,0,0,.25);padding:14px;border-radius:10px;font-size:12px;font-family:ui-monospace,monospace;margin-top:10px;border:1px solid var(--border);color:var(--text-sec)}
.card-actions{display:flex;align-items:center;gap:8px;margin-top:14px}
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
.memory-modal-overlay{position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:9999;display:none;align-items:center;justify-content:center;backdrop-filter:blur(4px)}
.memory-modal-overlay.show{display:flex}
.memory-modal{background:var(--bg-card);border:1px solid var(--border);border-radius:16px;width:min(600px,90vw);max-height:80vh;display:flex;flex-direction:column;box-shadow:0 20px 60px rgba(0,0,0,.4);animation:modalIn .2s ease-out}
@keyframes modalIn{from{opacity:0;transform:scale(.95) translateY(10px)}to{opacity:1;transform:scale(1) translateY(0)}}
.memory-modal-title{display:flex;align-items:center;justify-content:space-between;padding:16px 20px;border-bottom:1px solid var(--border);font-size:14px;font-weight:700}
.memory-modal-body{padding:20px;overflow-y:auto;flex:1}
.modal-memory-card{display:flex;flex-direction:column;gap:14px}
.modal-header-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.modal-field{display:flex;flex-direction:column;gap:4px}
.modal-field-label{font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:1px;color:var(--text-sec)}
.modal-field-val{font-size:13px;color:var(--text);line-height:1.5}
.modal-field-content{font-family:'SF Mono',Consolas,monospace;font-size:12px;line-height:1.6;color:var(--text);white-space:pre-wrap;word-break:break-all;background:rgba(0,0,0,.15);border-radius:8px;padding:12px;max-height:240px;overflow-y:auto;margin:0}
[data-theme="light"] .modal-field-content{background:rgba(0,0,0,.04)}
.modal-meta-row{display:flex;flex-wrap:wrap;gap:12px;font-size:11px;color:var(--text-sec);padding:8px 0;border-top:1px dashed var(--border)}
[data-theme="light"] .merge-history{background:rgba(0,0,0,.04)}
[data-theme="light"] .merge-history-item{border-bottom-color:rgba(0,0,0,.06)}

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
.toast-container{position:fixed;top:80px;right:24px;z-index:1000;display:flex;flex-direction:column;gap:8px}
.toast{padding:14px 20px;border-radius:10px;font-size:13px;font-weight:500;box-shadow:var(--shadow-lg);animation:slideIn .3s ease;display:flex;align-items:center;gap:10px;max-width:360px;border:1px solid}
.toast.success{background:var(--green-bg);color:var(--green);border-color:rgba(16,185,129,.3)}
.toast.error{background:var(--rose-bg);color:var(--rose);border-color:rgba(244,63,94,.3)}
.toast.info{background:var(--pri-glow);color:var(--pri);border-color:rgba(99,102,241,.15)}
@keyframes slideIn{from{transform:translateX(100px);opacity:0}to{transform:translateX(0);opacity:1}}

.empty{text-align:center;padding:64px 20px;color:var(--text-sec)}
.empty .icon{font-size:52px;margin-bottom:16px;opacity:.5}
.empty p{font-size:15px;font-weight:500}

.spinner{width:40px;height:40px;border:3px solid var(--border);border-top-color:var(--pri);border-radius:50%;animation:spin .8s linear infinite;margin:48px auto}
@keyframes spin{to{transform:rotate(360deg)}}

::-webkit-scrollbar{width:6px;height:6px}
::-webkit-scrollbar-track{background:transparent}
::-webkit-scrollbar-thumb{background:rgba(255,255,255,.15);border-radius:3px}
::-webkit-scrollbar-thumb:hover{background:rgba(255,255,255,.25)}

.filter-sep{width:1px;height:20px;background:var(--border);margin:0 4px}
.filter-select{padding:6px 12px;border:1px solid var(--border);border-radius:999px;background:var(--bg-card);color:var(--text-sec);font-size:13px;outline:none;cursor:pointer}
.filter-select:focus{border-color:var(--pri)}
.date-filter{display:flex;align-items:center;gap:10px;margin-bottom:18px;font-size:13px;color:var(--text-sec)}
.date-filter input[type="datetime-local"]{padding:6px 10px;border:1px solid var(--border);border-radius:8px;font-size:12px;outline:none;background:var(--bg-card);color:var(--text)}
.date-filter input[type="datetime-local"]:focus{border-color:var(--pri)}
.date-filter label{font-weight:500}

.pagination{display:flex;align-items:center;justify-content:center;gap:6px;padding:28px 0;flex-wrap:wrap}
.pagination .pg-btn{min-width:38px;height:38px;display:flex;align-items:center;justify-content:center;border:1px solid var(--border);border-radius:10px;background:var(--bg-card);color:var(--text-sec);font-size:13px;font-weight:500;cursor:pointer;transition:all .15s}
.pagination .pg-btn:hover{border-color:var(--pri);color:var(--pri)}
.pagination .pg-btn.active{background:var(--pri);color:#000;border-color:var(--pri)}
.pagination .pg-btn.disabled{opacity:.4;pointer-events:none}
.pagination .pg-info{font-size:12px;color:var(--text-sec);padding:0 12px}

/* ─── Tasks 视图 ─── */
.tasks-view{display:none;flex:1;min-width:0;flex-direction:column;gap:16px}
.tasks-view.show{display:flex}
.tasks-header{display:flex;flex-direction:column;gap:14px}
.tasks-stats{display:flex;gap:16px}
.tasks-stat{display:flex;align-items:center;gap:8px;background:var(--bg-card);border:1px solid var(--border);border-radius:var(--radius);padding:12px 18px;flex:1;transition:all .2s}
.tasks-stat:hover{border-color:var(--border-glow)}
.tasks-stat-value{font-size:22px;font-weight:700;color:var(--text)}
.tasks-stat-label{font-size:12px;color:var(--text-sec);font-weight:500}
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
.task-detail-summary:empty::after{content:'Summary not yet generated (task still active)';color:var(--text-muted);font-style:italic}
.task-detail-summary .summary-section-title{font-size:14px;font-weight:700;color:var(--text);margin:14px 0 6px 0;padding-bottom:4px;border-bottom:1px solid var(--border)}
.task-detail-summary .summary-section-title:first-child{margin-top:0}
.task-detail-summary ul{margin:4px 0 8px 0;padding-left:20px}
.task-detail-summary li{margin:3px 0;color:var(--text-sec);line-height:1.6}
.task-detail-chunks-title{font-size:12px;font-weight:700;color:var(--text-muted);text-transform:uppercase;letter-spacing:.06em;margin-bottom:12px}
.task-detail-chunks{display:flex;flex-direction:column;gap:14px;padding:8px 0}
.task-chunk-item{display:flex;flex-direction:column;max-width:82%;font-size:13px;line-height:1.6}
.task-chunk-item.role-user{align-self:flex-end;align-items:flex-end}
.task-chunk-item.role-assistant,.task-chunk-item.role-tool{align-self:flex-start;align-items:flex-start}
.task-chunk-role{font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:.05em;margin-bottom:3px;padding:0 4px}
.task-chunk-role.user{color:var(--pri)}
.task-chunk-role.assistant{color:var(--green)}
.task-chunk-role.tool{color:var(--amber)}
.task-chunk-bubble{padding:12px 16px;border-radius:16px;white-space:pre-wrap;word-break:break-word;max-height:200px;overflow:hidden;position:relative;transition:all .2s}
.task-chunk-bubble.expanded{max-height:none}
.role-user .task-chunk-bubble{background:var(--pri);color:#000;border-bottom-right-radius:4px}
.role-assistant .task-chunk-bubble{background:var(--bg-card);border:1px solid var(--border);color:var(--text-sec);border-bottom-left-radius:4px}
.role-tool .task-chunk-bubble{background:rgba(245,158,11,.08);border:1px solid rgba(245,158,11,.2);color:var(--text-sec);border-bottom-left-radius:4px;font-family:'SF Mono',Monaco,Consolas,monospace;font-size:12px}
.task-chunk-bubble:hover{filter:brightness(1.05)}
.task-chunk-time{font-size:10px;color:var(--text-muted);margin-top:3px;padding:0 4px}
[data-theme="light"] .role-user .task-chunk-bubble{background:var(--pri);color:#fff}
[data-theme="light"] .role-assistant .task-chunk-bubble{background:#f0f0f0;border:none;color:#333}
[data-theme="light"] .task-detail-panel{background:#fff}
[data-theme="light"] .task-card{background:#fff}
[data-theme="light"] .tasks-stat{background:#fff}

/* ─── Skills ─── */
.skills-view{display:none;flex:1;min-width:0;flex-direction:column;gap:16px}
.skills-view.show{display:flex}
.skill-card{background:var(--bg-card);border:1px solid var(--border);border-radius:var(--radius-lg);padding:18px 20px;cursor:pointer;transition:all .25s;position:relative;overflow:hidden}
.skill-card:hover{border-color:var(--border-glow);background:var(--bg-card-hover);transform:translateY(-1px);box-shadow:var(--shadow)}
.skill-card::before{content:'';position:absolute;top:0;left:0;bottom:0;width:3px;border-radius:3px 0 0 3px;background:var(--violet)}
.skill-card.installed::before{background:var(--green)}
.skill-card.archived{opacity:.5}
.skill-card.archived::before{background:var(--text-muted)}
.skill-card-top{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;margin-bottom:6px}
.skill-card-name{font-size:15px;font-weight:700;color:var(--text);flex:1}
.skill-card-badges{display:flex;gap:6px;align-items:center}
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
.analytics-view,.settings-view,.logs-view,.migrate-view{display:none;flex:1;min-width:0;flex-direction:column;gap:20px}
.analytics-view.show,.settings-view.show,.logs-view.show,.migrate-view.show{display:flex}

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
.log-msg-item{display:flex;gap:8px;align-items:flex-start;font-size:11.5px;line-height:1.5;padding:4px 10px;border-radius:6px;background:rgba(255,255,255,.02)}
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
.settings-grid{display:grid;grid-template-columns:1fr 1fr;gap:14px}
@media(max-width:800px){.settings-grid{grid-template-columns:1fr}}
.settings-field{display:flex;flex-direction:column;gap:4px}
.settings-field label{font-size:11px;font-weight:600;color:var(--text-muted);text-transform:uppercase;letter-spacing:.04em}
.settings-field input,.settings-field select{background:var(--bg);border:1px solid var(--border);border-radius:8px;padding:8px 12px;color:var(--text);font-size:13px;font-family:inherit;transition:border-color .15s}
.settings-field input:focus,.settings-field select:focus{outline:none;border-color:var(--pri)}
.settings-field input[type="password"]{font-family:'Courier New',monospace;letter-spacing:.05em}
.settings-field .field-hint{font-size:10px;color:var(--text-muted);margin-top:2px}
.settings-field.full-width{grid-column:1/-1}
.settings-toggle{display:flex;align-items:center;gap:10px;padding:4px 0}
.settings-toggle label{font-size:12px;font-weight:500;color:var(--text-sec);text-transform:none;letter-spacing:0}
.toggle-switch{position:relative;width:36px;height:20px;cursor:pointer}
.toggle-switch input{opacity:0;width:0;height:0}
.toggle-slider{position:absolute;inset:0;background:var(--border);border-radius:20px;transition:.2s}
.toggle-slider::before{content:'';position:absolute;height:14px;width:14px;left:3px;bottom:3px;background:#fff;border-radius:50%;transition:.2s}
.toggle-switch input:checked+.toggle-slider{background:var(--pri)}
.toggle-switch input:checked+.toggle-slider::before{transform:translateX(16px)}
.settings-actions{display:flex;gap:12px;justify-content:flex-end;align-items:center;margin-top:16px;padding-top:16px;border-top:1px solid var(--border)}
.settings-actions .btn{min-width:110px;padding:10px 20px;font-size:13px}
.settings-actions .btn-primary{background:rgba(99,102,241,.08);color:var(--pri);border:1px solid rgba(99,102,241,.25);font-weight:600}
.settings-actions .btn-primary:hover{background:rgba(99,102,241,.14);border-color:var(--pri)}
[data-theme="light"] .settings-actions .btn-primary{background:rgba(79,70,229,.06);color:#4f46e5;border:1px solid rgba(79,70,229,.2)}
[data-theme="light"] .settings-actions .btn-primary:hover{background:rgba(79,70,229,.1);border-color:#4f46e5}
.settings-saved{display:inline-flex;align-items:center;gap:6px;color:var(--green);font-size:12px;font-weight:600;opacity:0;transition:opacity .3s}
.settings-saved.show{opacity:1}
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
.feed-wrap{flex:1;min-width:0;display:flex;flex-direction:column}
.feed-wrap.hide{display:none}
.analytics-cards{display:grid;grid-template-columns:repeat(4,1fr);gap:14px}
.analytics-card{position:relative;overflow:hidden;border-radius:var(--radius-lg);padding:22px 20px;transition:all .2s ease;border:1px solid var(--border);background:var(--bg-card)}
.analytics-card::before{content:'';position:absolute;top:0;left:0;right:0;height:2px;background:var(--pri);opacity:.5}
.analytics-card::after{display:none}
.analytics-card:hover{transform:translateY(-2px);box-shadow:var(--shadow);border-color:var(--border-glow)}
.analytics-card.green::before{background:var(--green)}
.analytics-card.amber::before{background:var(--amber)}
.analytics-card .ac-value{font-size:28px;font-weight:700;letter-spacing:-.03em;color:var(--text);line-height:1;-webkit-text-fill-color:unset;background:none}
.analytics-card.green .ac-value{color:var(--green);background:none}
.analytics-card.amber .ac-value{color:var(--amber);background:none}
.analytics-card .ac-label{font-size:11px;color:var(--text-muted);margin-top:6px;font-weight:500;text-transform:uppercase;letter-spacing:.06em}
.analytics-section{background:var(--bg-card);border:1px solid var(--border);border-radius:var(--radius-lg);padding:22px 24px;position:relative;overflow:hidden}
.analytics-section::before{display:none}
.analytics-section h3{font-size:11px;font-weight:600;color:var(--text-muted);text-transform:uppercase;letter-spacing:.08em;margin-bottom:16px;display:flex;align-items:center;gap:8px}
.analytics-section h3 .icon{font-size:14px;opacity:.6}
.chart-bars{display:flex;align-items:flex-end;gap:4px;padding:8px 0;overflow-x:auto;justify-content:center}
.chart-bar-wrap{flex:1;min-width:28px;max-width:80px;display:flex;flex-direction:column;align-items:center;gap:4px;position:relative}
.chart-bar-col{width:100%;height:160px;display:flex;flex-direction:column;justify-content:flex-end;align-items:stretch}
.chart-bar-wrap:hover .chart-bar{opacity:1}
.chart-bar-wrap:hover .chart-bar-label{color:var(--text)}
.chart-bar-wrap:hover .chart-tip{opacity:1;transform:translateX(-50%) translateY(0)}
.chart-tip{position:absolute;top:-6px;left:50%;transform:translateX(-50%) translateY(4px);background:var(--bg-card);border:1px solid var(--border-glow);color:var(--text);padding:2px 8px;border-radius:6px;font-size:10px;font-weight:600;white-space:nowrap;z-index:5;pointer-events:none;box-shadow:var(--shadow);opacity:0;transition:all .15s ease}
.chart-bar{width:100%;border-radius:3px 3px 1px 1px;background:#818cf8;opacity:.75;transition:all .2s ease}
.chart-bar.violet{background:#6366f1}
.chart-bar.green{background:var(--green)}
.chart-bar.zero{background:var(--border);opacity:.3;border-radius:2px}
.chart-bar-label{font-size:9px;color:var(--text-muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:100%;text-align:center;transition:color .15s}
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
.breakdown-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:20px}
.breakdown-item{display:flex;flex-direction:column;gap:5px;padding:10px 12px;background:rgba(255,255,255,.02);border-radius:8px;border:1px solid var(--border);transition:all .15s}
.breakdown-item:hover{border-color:var(--border-glow);background:rgba(255,255,255,.04)}
.breakdown-item .bd-top{display:flex;align-items:center;justify-content:space-between}
.breakdown-item .label{font-size:12px;color:var(--text-sec);font-weight:500;text-transform:capitalize}
.breakdown-item .value{font-size:13px;font-weight:600;color:var(--text)}
.breakdown-bar-wrap{height:3px;background:rgba(255,255,255,.06);border-radius:2px;overflow:hidden}
.breakdown-bar{height:100%;border-radius:2px;background:var(--pri);transition:width .5s ease}
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
@media(max-width:900px){.main-content{flex-direction:column;padding:20px}.sidebar{width:100%}.sidebar .stats-grid{grid-template-columns:repeat(4,1fr)}.analytics-cards{grid-template-columns:repeat(2,1fr)}.topbar{padding:0 16px;gap:8px}.topbar .brand span{display:none}.topbar-center{justify-content:flex-start}}
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
    <div class="logo"><svg width="60" height="60" viewBox="0 0 120 120" fill="none" xmlns="http://www.w3.org/2000/svg"><defs><linearGradient id="aLG" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="#ff4d4d"/><stop offset="100%" stop-color="#991b1b"/></linearGradient></defs><path d="M60 10C30 10 15 35 15 55C15 75 30 95 45 100L45 110L55 110L55 100C55 100 60 102 65 100L65 110L75 110L75 100C90 95 105 75 105 55C105 35 90 10 60 10Z" fill="url(#aLG)"/><path d="M20 45C5 40 0 50 5 60C10 70 20 65 25 55C28 48 25 45 20 45Z" fill="url(#aLG)"/><path d="M100 45C115 40 120 50 115 60C110 70 100 65 95 55C92 48 95 45 100 45Z" fill="url(#aLG)"/><path d="M45 15Q35 5 30 8" stroke="#ff4d4d" stroke-width="2" stroke-linecap="round"/><path d="M75 15Q85 5 90 8" stroke="#ff4d4d" stroke-width="2" stroke-linecap="round"/><circle cx="45" cy="35" r="6" fill="#050810"/><circle cx="75" cy="35" r="6" fill="#050810"/><circle cx="46" cy="34" r="2" fill="#00e5cc"/><circle cx="76" cy="34" r="2" fill="#00e5cc"/></svg></div>
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
    <div class="logo"><svg width="60" height="60" viewBox="0 0 120 120" fill="none" xmlns="http://www.w3.org/2000/svg"><defs><linearGradient id="bLG" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="#ff4d4d"/><stop offset="100%" stop-color="#991b1b"/></linearGradient></defs><path d="M60 10C30 10 15 35 15 55C15 75 30 95 45 100L45 110L55 110L55 100C55 100 60 102 65 100L65 110L75 110L75 100C90 95 105 75 105 55C105 35 90 10 60 10Z" fill="url(#bLG)"/><path d="M20 45C5 40 0 50 5 60C10 70 20 65 25 55C28 48 25 45 20 45Z" fill="url(#bLG)"/><path d="M100 45C115 40 120 50 115 60C110 70 100 65 95 55C92 48 95 45 100 45Z" fill="url(#bLG)"/><path d="M45 15Q35 5 30 8" stroke="#ff4d4d" stroke-width="2" stroke-linecap="round"/><path d="M75 15Q85 5 90 8" stroke="#ff4d4d" stroke-width="2" stroke-linecap="round"/><circle cx="45" cy="35" r="6" fill="#050810"/><circle cx="75" cy="35" r="6" fill="#050810"/><circle cx="46" cy="34" r="2" fill="#00e5cc"/><circle cx="76" cy="34" r="2" fill="#00e5cc"/></svg></div>
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
    <div class="brand">
      <div class="icon"><svg width="24" height="24" viewBox="0 0 120 120" fill="none" xmlns="http://www.w3.org/2000/svg" style="filter:drop-shadow(0 0 8px rgba(255,77,77,.3))"><defs><linearGradient id="tLG" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="#ff4d4d"/><stop offset="100%" stop-color="#991b1b"/></linearGradient></defs><path d="M60 10C30 10 15 35 15 55C15 75 30 95 45 100L45 110L55 110L55 100C55 100 60 102 65 100L65 110L75 110L75 100C90 95 105 75 105 55C105 35 90 10 60 10Z" fill="url(#tLG)"/><path d="M20 45C5 40 0 50 5 60C10 70 20 65 25 55C28 48 25 45 20 45Z" fill="url(#tLG)"/><path d="M100 45C115 40 120 50 115 60C110 70 100 65 95 55C92 48 95 45 100 45Z" fill="url(#tLG)"/><path d="M45 15Q35 5 30 8" stroke="#ff4d4d" stroke-width="2" stroke-linecap="round"/><path d="M75 15Q85 5 90 8" stroke="#ff4d4d" stroke-width="2" stroke-linecap="round"/><circle cx="45" cy="35" r="6" fill="#050810"/><circle cx="75" cy="35" r="6" fill="#050810"/><circle cx="46" cy="34" r="2" fill="#00e5cc"/><circle cx="76" cy="34" r="2" fill="#00e5cc"/></svg></div>
      <span data-i18n="title">OpenClaw Memory</span>${vBadge}
    </div>
    <div class="topbar-center">
      <nav class="nav-tabs">
        <button class="tab active" data-view="memories" onclick="switchView('memories')" data-i18n="tab.memories">\u{1F4DA} Memories</button>
        <button class="tab" data-view="tasks" onclick="switchView('tasks')" data-i18n="tab.tasks">\u{1F4CB} Tasks</button>
        <button class="tab" data-view="skills" onclick="switchView('skills')" data-i18n="tab.skills">\u{1F9E0} Skills</button>
        <button class="tab" data-view="analytics" onclick="switchView('analytics')" data-i18n="tab.analytics">\u{1F4CA} Analytics</button>
        <button class="tab" data-view="logs" onclick="switchView('logs')" data-i18n="tab.logs">\u{1F4DD} Logs</button>
        <button class="tab" data-view="import" onclick="switchView('import')" data-i18n="tab.import">\u{1F4E5} Import</button>
        <button class="tab" data-view="settings" onclick="switchView('settings')" data-i18n="tab.settings">\u2699 Settings</button>
      </nav>
    </div>
    <div class="actions">
      <button class="btn btn-icon" onclick="toggleLang()" aria-label="Switch language" style="font-size:12px;font-weight:700;padding:4px 8px"><span data-i18n="lang.switch">EN</span></button>
      <button class="btn btn-icon theme-toggle" onclick="toggleViewerTheme()" title="Toggle light/dark" aria-label="Toggle theme"><span class="theme-icon-dark">\u{1F319}</span><span class="theme-icon-light">\u2600</span></button>
      <button class="btn btn-ghost btn-sm" onclick="loadAll()" data-i18n="refresh">\u21BB Refresh</button>
      <button class="btn btn-ghost btn-sm" onclick="doLogout()" data-i18n="logout">Logout</button>
    </div>
  </div>

  <div class="main-content">
    <div class="sidebar" id="sidebar">
      <div class="stats-grid" id="statsGrid">
        <div class="stat-card pri"><div class="stat-value" id="statTotal">-</div><div class="stat-label" data-i18n="stat.memories">Memories</div></div>
        <div class="stat-card green"><div class="stat-value" id="statSessions">-</div><div class="stat-label" data-i18n="stat.sessions">Sessions</div></div>
        <div class="stat-card amber"><div class="stat-value" id="statEmbeddings">-</div><div class="stat-label" data-i18n="stat.embeddings">Embeddings</div></div>
        <div class="stat-card rose"><div class="stat-value" id="statTimeSpan">-</div><div class="stat-label" data-i18n="stat.days">Days</div></div>
      </div>
      <div id="embeddingStatus"></div>
      <div class="section-title" data-i18n="sidebar.sessions">Sessions</div>
      <div class="session-list" id="sessionList"></div>
      <button class="btn btn-sm btn-ghost" style="width:100%;margin-top:20px;justify-content:center;color:var(--text-muted);font-size:11px" onclick="clearAll()" data-i18n="sidebar.clear">\u{1F5D1} Clear All Data</button>
    </div>

    <div class="feed-wrap" id="feedWrap">
    <div class="feed">
      <div class="search-bar">
        <span class="search-icon">\u{1F50D}</span>
        <input type="text" id="searchInput" data-i18n-ph="search.placeholder" placeholder="Search memories (supports semantic search)..." oninput="debounceSearch()">
      </div>
      <div class="search-meta" id="searchMeta"></div>
      <div class="filter-bar" id="filterBar">
        <button class="filter-chip active" data-role="" onclick="setRoleFilter(this,'')" data-i18n="filter.all">All</button>
        <button class="filter-chip" data-role="user" onclick="setRoleFilter(this,'user')">User</button>
        <button class="filter-chip" data-role="assistant" onclick="setRoleFilter(this,'assistant')">Assistant</button>
        <button class="filter-chip" data-role="system" onclick="setRoleFilter(this,'system')">System</button>
        <span class="filter-sep"></span>
        <select id="filterKind" class="filter-select" onchange="applyFilters()">
          <option value="" data-i18n="filter.allkinds">All kinds</option>
          <option value="paragraph" data-i18n="filter.paragraph">Paragraph</option>
          <option value="code_block" data-i18n="filter.code">Code</option>
          <option value="dialog" data-i18n="filter.dialog">Dialog</option>
          <option value="list" data-i18n="filter.list">List</option>
          <option value="error_stack" data-i18n="filter.error">Error</option>
          <option value="command" data-i18n="filter.command">Command</option>
        </select>
        <select id="filterSort" class="filter-select" onchange="applyFilters()">
          <option value="newest" data-i18n="filter.newest">Newest first</option>
          <option value="oldest" data-i18n="filter.oldest">Oldest first</option>
        </select>
        <span class="filter-sep"></span>
        <select id="filterOwner" class="filter-select" onchange="applyFilters()">
          <option value="" data-i18n="filter.allowners">All owners</option>
          <option value="public" data-i18n="filter.public">Public</option>
        </select>
      </div>
      <div class="date-filter">
        <label data-i18n="filter.from">From</label><input type="datetime-local" id="dateFrom" step="1" onchange="applyFilters()">
        <label data-i18n="filter.to">To</label><input type="datetime-local" id="dateTo" step="1" onchange="applyFilters()">
        <button class="btn btn-sm btn-text" onclick="clearDateFilter()" data-i18n="filter.clear">Clear</button>
      </div>
      <div class="memory-list" id="memoryList"><div class="spinner"></div></div>
      <div class="pagination" id="pagination"></div>
    </div>
    </div>
    <div class="tasks-view" id="tasksView">
      <div class="tasks-header">
        <div class="tasks-stats">
          <div class="tasks-stat"><span class="tasks-stat-value" id="tasksTotalCount">-</span><span class="tasks-stat-label" data-i18n="tasks.total">Total Tasks</span></div>
          <div class="tasks-stat"><span class="tasks-stat-value" id="tasksActiveCount">-</span><span class="tasks-stat-label" data-i18n="tasks.active">Active</span></div>
          <div class="tasks-stat"><span class="tasks-stat-value" id="tasksCompletedCount">-</span><span class="tasks-stat-label" data-i18n="tasks.completed">Completed</span></div>
          <div class="tasks-stat"><span class="tasks-stat-value" id="tasksSkippedCount">-</span><span class="tasks-stat-label" data-i18n="tasks.status.skipped">Skipped</span></div>
        </div>
        <div class="tasks-filters">
          <button class="filter-chip active" data-task-status="" onclick="setTaskStatusFilter(this,'')" data-i18n="filter.all">All</button>
          <button class="filter-chip" data-task-status="active" onclick="setTaskStatusFilter(this,'active')" data-i18n="tasks.status.active">Active</button>
          <button class="filter-chip" data-task-status="completed" onclick="setTaskStatusFilter(this,'completed')" data-i18n="tasks.status.completed">Completed</button>
          <button class="filter-chip" data-task-status="skipped" onclick="setTaskStatusFilter(this,'skipped')" data-i18n="tasks.status.skipped">Skipped</button>
          <button class="btn btn-sm btn-ghost" onclick="loadTasks()" style="margin-left:auto" data-i18n="refresh">\u21BB Refresh</button>
        </div>
      </div>
      <div class="tasks-list" id="tasksList"><div class="spinner"></div></div>
      <div class="pagination" id="tasksPagination"></div>
      <div class="task-detail-overlay" id="taskDetailOverlay" onclick="closeTaskDetail(event)">
        <div class="task-detail-panel" onclick="event.stopPropagation()">
          <div class="task-detail-header">
            <h2 id="taskDetailTitle"></h2>
            <button class="btn btn-icon" onclick="closeTaskDetail()" title="Close">\u2715</button>
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
    <div class="skills-view" id="skillsView">
      <div class="tasks-header">
        <div class="tasks-stats">
          <div class="tasks-stat"><span class="tasks-stat-value" id="skillsTotalCount">-</span><span class="tasks-stat-label" data-i18n="skills.total">Total Skills</span></div>
          <div class="tasks-stat" style="border-left:3px solid var(--green)"><span class="tasks-stat-value" id="skillsActiveCount">-</span><span class="tasks-stat-label" data-i18n="skills.active">Active</span></div>
          <div class="tasks-stat" style="border-left:3px solid var(--amber)"><span class="tasks-stat-value" id="skillsDraftCount">-</span><span class="tasks-stat-label" data-i18n="skills.draft">Draft</span></div>
          <div class="tasks-stat" style="border-left:3px solid var(--violet)"><span class="tasks-stat-value" id="skillsInstalledCount">-</span><span class="tasks-stat-label" data-i18n="skills.installed">Installed</span></div>
          <div class="tasks-stat" style="border-left:3px solid var(--cyan)"><span class="tasks-stat-value" id="skillsPublicCount">-</span><span class="tasks-stat-label" data-i18n="skills.public">Public</span></div>
        </div>
        <div class="tasks-filters">
          <button class="filter-chip active" data-skill-status="" onclick="setSkillStatusFilter(this,'')" data-i18n="filter.all">All</button>
          <button class="filter-chip" data-skill-status="active" onclick="setSkillStatusFilter(this,'active')" data-i18n="skills.filter.active">Active</button>
          <button class="filter-chip" data-skill-status="draft" onclick="setSkillStatusFilter(this,'draft')" data-i18n="skills.filter.draft">Draft</button>
          <button class="filter-chip" data-skill-status="archived" onclick="setSkillStatusFilter(this,'archived')" data-i18n="skills.filter.archived">Archived</button>
          <span class="filter-sep"></span>
          <select id="skillVisibilityFilter" class="filter-select" onchange="loadSkills()">
            <option value="" data-i18n="filter.allvisibility">All visibility</option>
            <option value="public" data-i18n="filter.public">Public</option>
            <option value="private" data-i18n="filter.private">Private</option>
          </select>
          <button class="btn btn-sm btn-ghost" onclick="loadSkills()" style="margin-left:auto" data-i18n="refresh">\u21BB Refresh</button>
        </div>
      </div>
      <div class="tasks-list" id="skillsList"><div class="spinner"></div></div>
    </div>
    <div class="task-detail-overlay" id="skillDetailOverlay" onclick="closeSkillDetail(event)">
      <div class="task-detail-panel" onclick="event.stopPropagation()">
        <div class="task-detail-header">
          <h2 id="skillDetailTitle"></h2>
          <div style="display:flex;gap:8px;align-items:center">
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
    <div class="analytics-view" id="analyticsView">
      <div class="metrics-toolbar">
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
          <div style="display:flex;gap:6px;align-items:center">
            <button class="range-btn tool-range active" data-mins="60" onclick="setToolMinutes(60)">1h</button>
            <button class="range-btn tool-range" data-mins="360" onclick="setToolMinutes(360)">6h</button>
            <button class="range-btn tool-range" data-mins="1440" onclick="setToolMinutes(1440)">24h</button>
          </div>
        </div>
        <div id="toolChart" style="width:100%;height:280px;position:relative;overflow:hidden;border-radius:12px"></div>
        <div id="toolLegend" class="chart-legend" style="margin-top:14px;padding:0 4px"></div>
        <div id="toolAggTable" style="margin-top:20px"></div>
      </div>

      <div class="breakdown-grid" style="display:grid;grid-template-columns:1fr 1fr;gap:24px">
        <div class="analytics-section">
          <h3><span class="icon">\u{1F464}</span> <span data-i18n="breakdown.role">By Role</span></h3>
          <div id="breakdownRole"></div>
        </div>
        <div class="analytics-section">
          <h3><span class="icon">\u{1F4DD}</span> <span data-i18n="breakdown.kind">By Kind</span></h3>
          <div id="breakdownKind"></div>
        </div>
      </div>
    </div>

    <!-- ─── Logs View ─── -->
    <div class="logs-view" id="logsView">
      <div class="logs-toolbar">
        <div class="logs-toolbar-left">
          <select id="logToolFilter" onchange="onLogFilterChange()" style="font-size:12px;padding:4px 8px;border-radius:6px;border:1px solid var(--border);background:var(--card);color:var(--text);min-width:120px">
            <option value="" data-i18n="logs.allTools">All Tools</option>
          </select>
          <button class="btn btn-sm btn-ghost" onclick="loadLogs()" style="font-size:12px">\u21BB <span data-i18n="logs.refresh">Refresh</span></button>
        </div>
        <div class="logs-toolbar-right">
          <input type="checkbox" id="logAutoRefresh" style="display:none">
        </div>
      </div>
      <div class="logs-list" id="logsList"></div>
      <div id="logsPagination"></div>
    </div>

    <!-- ─── Settings View ─── -->
    <div class="settings-view" id="settingsView">
      <div class="settings-group" id="settingsModelConfig">
        <h2 class="settings-group-title"><span data-i18n="settings.modelconfig">Model Configuration</span></h2>
      <div class="settings-section">
        <h3><span class="icon">\u{1F4E1}</span> <span data-i18n="settings.embedding">Embedding Model</span></h3>
        <div class="settings-grid">
          <div class="settings-field">
            <label data-i18n="settings.provider">Provider</label>
            <select id="cfgEmbProvider">
              <option value="openai_compatible">OpenAI Compatible</option>
              <option value="openai">OpenAI</option>
              <option value="gemini">Gemini</option>
              <option value="azure_openai">Azure OpenAI</option>
              <option value="cohere">Cohere</option>
              <option value="mistral">Mistral</option>
              <option value="voyage">Voyage</option>
              <option value="local">Local</option>
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
      </div>

      <div class="settings-section">
        <h3><span class="icon">\u{1F9E0}</span> <span data-i18n="settings.summarizer">Summarizer Model</span></h3>
        <div class="settings-grid">
          <div class="settings-field">
            <label data-i18n="settings.provider">Provider</label>
            <select id="cfgSumProvider">
              <option value="openai_compatible">OpenAI Compatible</option>
              <option value="openai">OpenAI</option>
              <option value="anthropic">Anthropic</option>
              <option value="gemini">Gemini</option>
              <option value="azure_openai">Azure OpenAI</option>
              <option value="bedrock">Bedrock</option>
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
      </div>
      </div>

      <div class="settings-section">
        <h3><span class="icon">\u{1F527}</span> <span data-i18n="settings.skill">Skill Evolution</span></h3>
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
        <div style="margin-top:16px;padding-top:16px;border-top:1px solid var(--border)">
          <h4 style="font-size:12px;font-weight:600;color:var(--text-sec);margin-bottom:12px"><span data-i18n="settings.skill.model">Skill Dedicated Model</span></h4>
          <div class="field-hint" style="margin-bottom:12px" data-i18n="settings.skill.model.hint">If not configured, the main Summarizer Model above will be used for skill generation. Configure a dedicated model here for higher quality skill output.</div>
          <div class="settings-grid">
            <div class="settings-field">
              <label data-i18n="settings.provider">Provider</label>
              <select id="cfgSkillProvider">
                <option value="">— <span data-i18n="settings.skill.usemain">Use main summarizer</span> —</option>
                <option value="openai_compatible">OpenAI Compatible</option>
                <option value="openai">OpenAI</option>
                <option value="anthropic">Anthropic</option>
                <option value="gemini">Gemini</option>
                <option value="azure_openai">Azure OpenAI</option>
                <option value="bedrock">Bedrock</option>
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
        </div>
      </div>

      <div class="settings-section">
        <h3><span class="icon">\u{1F4CA}</span> <span data-i18n="settings.telemetry">Telemetry</span></h3>
        <div class="settings-grid">
          <div class="settings-toggle">
            <label class="toggle-switch"><input type="checkbox" id="cfgTelemetryEnabled" checked><span class="toggle-slider"></span></label>
            <label data-i18n="settings.telemetry.enabled">Enable Anonymous Telemetry</label>
          </div>
          <div class="settings-field full-width">
            <div class="field-hint" data-i18n="settings.telemetry.hint">Anonymous usage analytics to help improve the plugin. Only sends tool names, latencies, and version info. No memory content, queries, or personal data is ever sent.</div>
          </div>
        </div>
      </div>

      <div class="settings-section">
        <h3><span class="icon">\u{1F4BE}</span> <span data-i18n="settings.general">General</span></h3>
        <div class="settings-grid">
          <div class="settings-field">
            <label data-i18n="settings.viewerport">Viewer Port</label>
            <input type="number" id="cfgViewerPort" placeholder="18799">
            <div class="field-hint" data-i18n="settings.viewerport.hint">Requires restart to take effect</div>
          </div>
        </div>
      </div>

      <div class="settings-actions">
        <span class="settings-saved" id="settingsSaved">\u2713 <span data-i18n="settings.saved">Saved</span></span>
        <button class="btn btn-ghost" onclick="loadConfig()" data-i18n="settings.reset">Reset</button>
        <button class="btn btn-primary" onclick="saveConfig()" data-i18n="settings.save">Save Settings</button>
      </div>
      <div style="font-size:11px;color:var(--text-muted);text-align:right;margin-top:4px" data-i18n="settings.restart.hint">Some changes require restarting the OpenClaw gateway to take effect.</div>
    </div>

    <!-- ─── Import Page ─── -->
    <div class="migrate-view" id="migrateView">
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

        <div id="migrateActions" style="display:flex;gap:12px;align-items:center;flex-wrap:wrap">
          <button class="btn btn-ghost" onclick="migrateScan()" id="migrateScanBtn" data-i18n="migrate.scan">Scan Data Sources</button>
          <button class="btn btn-primary" onclick="migrateStart()" id="migrateStartBtn" style="display:none" data-i18n="migrate.start">Start Import</button>
          <span id="migrateConcurrencyRow" style="display:none;align-items:center;gap:6px">
            <span style="font-size:11px;color:var(--text-muted)" data-i18n="migrate.concurrency.label">Concurrent agents</span>
            <select id="migrateConcurrency" class="filter-select" style="min-width:auto;padding:3px 10px;font-size:11px">
              <option value="1" selected>1</option>
              <option value="2">2</option>
              <option value="4">4</option>
              <option value="8">8</option>
            </select>
          </span>
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
                <select id="ppConcurrency" class="filter-select" style="min-width:auto;padding:3px 10px;font-size:11px">
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

<!-- ─── Memory Modal ─── -->
<div class="modal-overlay" id="modalOverlay">
  <div class="modal">
    <h2 id="modalTitle" data-i18n="modal.new">New Memory</h2>
    <div class="form-group"><label data-i18n="modal.role">Role</label><select id="mRole"><option value="user">User</option><option value="assistant">Assistant</option><option value="system">System</option></select></div>
    <div class="form-group"><label data-i18n="modal.content">Content</label><textarea id="mContent" rows="4" data-i18n-ph="modal.content.ph" placeholder="Memory content..."></textarea></div>
    <div class="form-group"><label data-i18n="modal.summary">Summary</label><input type="text" id="mSummary" data-i18n-ph="modal.summary.ph" placeholder="Brief summary (optional)"></div>
    <div class="form-group"><label data-i18n="modal.kind">Kind</label><select id="mKind"><option value="paragraph" data-i18n="filter.paragraph">Paragraph</option><option value="code" data-i18n="filter.code">Code</option><option value="dialog" data-i18n="filter.dialog">Dialog</option></select></div>
    <div class="modal-actions">
      <button class="btn btn-ghost" onclick="closeModal()" data-i18n="modal.cancel">Cancel</button>
      <button class="btn btn-primary" id="modalSubmit" onclick="submitModal()" data-i18n="modal.create">Create</button>
    </div>
  </div>
</div>

<!-- ─── Toast ─── -->
<div class="toast-container" id="toasts"></div>

<script>
let activeSession=null,activeRole='',editingId=null,searchTimer=null,memoryCache={},currentPage=1,totalPages=1,totalCount=0,PAGE_SIZE=40,metricsDays=30;

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
    'skills.visibility.public':'Public',
    'skills.visibility.private':'Private',
    'skills.setPublic':'Set Public',
    'skills.setPrivate':'Set Private',
    'tasks.total':'Total Tasks',
    'tasks.active':'Active',
    'tasks.completed':'Completed',
    'tasks.status.active':'Active',
    'tasks.status.completed':'Completed',
    'tasks.status.skipped':'Skipped',
    'tasks.empty':'No tasks yet. Tasks are automatically created as you converse.',
    'tasks.loading':'Loading...',
    'tasks.untitled':'Untitled Task',
    'tasks.chunks':'Related Memories',
    'tasks.nochunks':'No memories in this task yet.',
    'tasks.skipped.default':'This conversation was too brief to generate a summary. It will not appear in search results.',
    'refresh':'\\u21BB Refresh',
    'logout':'Logout',
    'stat.memories':'Memories',
    'stat.sessions':'Sessions',
    'stat.embeddings':'Embeddings',
    'stat.days':'Days',
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
    'filter.allkinds':'All kinds',
    'filter.paragraph':'Paragraph',
    'filter.code':'Code',
    'filter.dialog':'Dialog',
    'filter.list':'List',
    'filter.error':'Error',
    'filter.command':'Command',
    'filter.newest':'Newest first',
    'filter.oldest':'Oldest first',
    'filter.allowners':'All owners',
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
    'card.updated':'updated',
    'card.evolveHistory':'Evolution History',
    'card.oldSummary':'Old',
    'card.dedupDuplicate':'Duplicate',
    'card.dedupMerged':'Merged',
    'card.dedupTarget':'Target: ',
    'card.dedupReason':'Reason: ',
    'card.newSummary':'New',
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
    'chart.list':'List',
    'chart.search':'Search',
    'breakdown.role':'By Role',
    'breakdown.kind':'By Kind',
    'modal.new':'New Memory',
    'modal.edit':'Edit Memory',
    'modal.role':'Role',
    'modal.content':'Content',
    'modal.content.ph':'Memory content...',
    'modal.summary':'Summary',
    'modal.summary.ph':'Brief summary (optional)',
    'modal.kind':'Kind',
    'modal.cancel':'Cancel',
    'modal.create':'Create',
    'modal.save':'Save',
    'modal.err.empty':'Please enter content',
    'toast.created':'Memory created',
    'toast.updated':'Memory updated',
    'toast.deleted':'Memory deleted',
    'toast.opfail':'Operation failed',
    'toast.delfail':'Delete failed',
    'toast.setPublic':'Set to public',
    'toast.setPrivate':'Set to private',
    'toast.cleared':'All memories cleared',
    'toast.clearfail':'Clear failed',
    'toast.notfound':'Memory not found in cache',
    'confirm.delete':'Delete this memory?',
    'confirm.clearall':'Delete ALL memories? This cannot be undone.',
    'confirm.clearall2':'Are you absolutely sure?',
    'embed.on':'Embedding: ',
    'embed.off':'No embedding model',
    'lang.switch':'中',
    'tab.logs':'\u{1F4DD} Logs',
    'logs.allTools':'All Tools',
    'logs.refresh':'Refresh',
    'logs.autoRefresh':'Auto-refresh',
    'logs.input':'INPUT',
    'logs.output':'OUTPUT',
    'logs.empty':'No logs yet. Logs will appear here when tools are called.',
    'logs.ago':'ago',
    'tab.import':'\u{1F4E5} Import',
    'tab.settings':'\u2699 Settings',
    'settings.modelconfig':'Model Configuration',
    'settings.embedding':'Embedding Model',
    'settings.summarizer':'Summarizer Model',
    'settings.skill':'Skill Evolution',
    'settings.general':'General',
    'settings.provider':'Provider',
    'settings.model':'Model',
    'settings.temperature':'Temperature',
    'settings.skill.enabled':'Enable Skill Evolution',
    'settings.skill.autoinstall':'Auto Install Skills',
    'settings.skill.confidence':'Min Confidence',
    'settings.skill.minchunks':'Min Chunks',
    'settings.skill.model':'Skill Dedicated Model',
    'settings.skill.model.hint':'If not configured, the main Summarizer Model above will be used for skill generation. Configure a dedicated model here for higher quality skill output.',
    'settings.optional':'Optional',
    'settings.skill.usemain':'Use Main Summarizer',
    'settings.telemetry':'Telemetry',
    'settings.telemetry.enabled':'Enable Anonymous Telemetry',
    'settings.telemetry.hint':'Anonymous usage analytics to help improve the plugin. Only sends tool names, latencies, and version info. No memory content, queries, or personal data is ever sent.',
    'settings.viewerport':'Viewer Port',
    'settings.viewerport.hint':'Requires restart to take effect',
    'settings.save':'Save Settings',
    'settings.reset':'Reset',
    'settings.saved':'Saved',
    'settings.restart.hint':'Some changes require restarting the OpenClaw gateway to take effect.',
    'settings.save.fail':'Failed to save settings',
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
    'migrate.stat.stored':'Stored',
    'migrate.stat.skipped':'Skipped',
    'migrate.stat.merged':'Merged',
    'migrate.stat.errors':'Errors',
    'migrate.phase.sqlite':'Importing memory index...',
    'migrate.phase.sessions':'Importing conversation history...',
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
    'pp.stat.skills':'Skills',
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
    'skills.empty':'No skills yet. Skills are automatically generated from completed tasks that contain reusable experience.',
    'skills.loading':'Loading...',
    'skills.error':'Error loading skill',
    'skills.error.detail':'Failed to load skill: ',
    'skills.nofiles':'No files found',
    'skills.noversions':'No versions recorded',
    'skills.norelated':'No related tasks',
    'skills.nocontent':'No content available',
    'skills.nochangelog':'No changelog',
    'skills.status.active':'Active',
    'skills.status.draft':'Draft',
    'skills.status.archived':'Archived',
    'skills.updated':'Updated: ',
    'skills.task.prefix':'Task: ',
    'tasks.chunks.label':'chunks',
    'tasks.taskid':'Task ID: ',
    'tasks.role.user':'You',
    'tasks.role.assistant':'Assistant',
    'tasks.error':'Error',
    'tasks.error.detail':'Failed to load task details',
    'tasks.untitled.related':'Untitled',
    'task.edit':'Edit',
    'task.delete':'Delete',
    'task.save':'Save',
    'task.cancel':'Cancel',
    'task.delete.confirm':'Are you sure you want to delete this task? This cannot be undone.',
    'task.delete.error':'Failed to delete task: ',
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
    'skill.delete.error':'Failed to delete skill: ',
    'skill.save.error':'Failed to save skill: '
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
    'skills.visibility.public':'公开',
    'skills.visibility.private':'私有',
    'skills.setPublic':'设为公开',
    'skills.setPrivate':'设为私有',
    'tasks.total':'任务总数',
    'tasks.active':'进行中',
    'tasks.completed':'已完成',
    'tasks.status.active':'进行中',
    'tasks.status.completed':'已完成',
    'tasks.status.skipped':'已跳过',
    'tasks.empty':'暂无任务。任务会随着对话自动创建。',
    'tasks.loading':'加载中...',
    'tasks.untitled':'未命名任务',
    'tasks.chunks':'关联记忆',
    'tasks.nochunks':'此任务暂无关联记忆。',
    'tasks.skipped.default':'对话内容过少，未生成摘要。该任务不会出现在检索结果中。',
    'refresh':'\\u21BB 刷新',
    'logout':'退出',
    'stat.memories':'记忆',
    'stat.sessions':'会话',
    'stat.embeddings':'嵌入',
    'stat.days':'天数',
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
    'filter.allkinds':'所有类型',
    'filter.paragraph':'段落',
    'filter.code':'代码',
    'filter.dialog':'对话',
    'filter.list':'列表',
    'filter.error':'错误',
    'filter.command':'命令',
    'filter.newest':'最新优先',
    'filter.oldest':'最早优先',
    'filter.allowners':'所有归属',
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
    'card.updated':'更新于',
    'card.evolveHistory':'演化记录',
    'card.oldSummary':'旧摘要',
    'card.dedupDuplicate':'重复',
    'card.dedupMerged':'已合并',
    'card.dedupTarget':'关联: ',
    'card.dedupReason':'原因: ',
    'card.newSummary':'新摘要',
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
    'chart.list':'列表',
    'chart.search':'搜索',
    'breakdown.role':'按角色',
    'breakdown.kind':'按类型',
    'modal.new':'新建记忆',
    'modal.edit':'编辑记忆',
    'modal.role':'角色',
    'modal.content':'内容',
    'modal.content.ph':'记忆内容...',
    'modal.summary':'摘要',
    'modal.summary.ph':'简要摘要（可选）',
    'modal.kind':'类型',
    'modal.cancel':'取消',
    'modal.create':'创建',
    'modal.save':'保存',
    'modal.err.empty':'请输入内容',
    'toast.created':'记忆已创建',
    'toast.updated':'记忆已更新',
    'toast.deleted':'记忆已删除',
    'toast.opfail':'操作失败',
    'toast.delfail':'删除失败',
    'toast.setPublic':'已设为公开',
    'toast.setPrivate':'已设为私有',
    'toast.cleared':'所有记忆已清除',
    'toast.clearfail':'清除失败',
    'toast.notfound':'缓存中未找到此记忆',
    'confirm.delete':'确定要删除这条记忆吗？',
    'confirm.clearall':'确定要删除所有记忆？此操作不可撤销。',
    'confirm.clearall2':'你真的确定吗？',
    'embed.on':'嵌入模型：',
    'embed.off':'无嵌入模型',
    'lang.switch':'EN',
    'tab.logs':'\u{1F4DD} 日志',
    'logs.allTools':'全部工具',
    'logs.refresh':'刷新',
    'logs.autoRefresh':'自动刷新',
    'logs.input':'输入',
    'logs.output':'输出',
    'logs.empty':'暂无日志。当工具被调用时日志会显示在这里。',
    'logs.ago':'前',
    'tab.import':'\u{1F4E5} 导入',
    'tab.settings':'\u2699 设置',
    'settings.modelconfig':'模型配置',
    'settings.embedding':'嵌入模型',
    'settings.summarizer':'摘要模型',
    'settings.skill':'技能进化',
    'settings.general':'通用设置',
    'settings.provider':'服务商',
    'settings.model':'模型',
    'settings.temperature':'温度',
    'settings.skill.enabled':'启用技能进化',
    'settings.skill.autoinstall':'自动安装技能',
    'settings.skill.confidence':'最低置信度',
    'settings.skill.minchunks':'最少记忆片段',
    'settings.skill.model':'技能专用模型',
    'settings.skill.model.hint':'不配置时默认使用上方的摘要模型进行技能生成。如需更高质量的技能输出，可在此单独配置一个更强的模型。',
    'settings.optional':'可选',
    'settings.skill.usemain':'使用主摘要模型',
    'settings.telemetry':'数据统计',
    'settings.telemetry.enabled':'启用匿名数据统计',
    'settings.telemetry.hint':'匿名使用统计，帮助改进插件。仅发送工具名称、响应时间和版本信息，不会发送任何记忆内容、搜索查询或个人数据。',
    'settings.viewerport':'Viewer 端口',
    'settings.viewerport.hint':'修改后需重启网关生效',
    'settings.save':'保存设置',
    'settings.reset':'重置',
    'settings.saved':'已保存',
    'settings.restart.hint':'部分设置修改后需要重启 OpenClaw 网关才能生效。',
    'settings.save.fail':'保存设置失败',
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
    'migrate.stat.stored':'已存储',
    'migrate.stat.skipped':'已跳过',
    'migrate.stat.merged':'已合并',
    'migrate.stat.errors':'错误',
    'migrate.phase.sqlite':'正在导入记忆索引...',
    'migrate.phase.sessions':'正在导入对话历史...',
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
    'pp.stat.skills':'技能',
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
    'skills.empty':'暂无技能。技能会从已完成的、包含可复用经验的任务中自动生成。',
    'skills.loading':'加载中...',
    'skills.error':'加载技能失败',
    'skills.error.detail':'加载技能失败：',
    'skills.nofiles':'暂无文件',
    'skills.noversions':'暂无版本记录',
    'skills.norelated':'暂无关联任务',
    'skills.nocontent':'暂无内容',
    'skills.nochangelog':'暂无变更记录',
    'skills.status.active':'生效中',
    'skills.status.draft':'草稿',
    'skills.status.archived':'已归档',
    'skills.updated':'更新于：',
    'skills.task.prefix':'任务：',
    'tasks.chunks.label':'条记忆',
    'tasks.taskid':'任务 ID：',
    'tasks.role.user':'你',
    'tasks.role.assistant':'助手',
    'tasks.error':'出错了',
    'tasks.error.detail':'加载任务详情失败',
    'tasks.untitled.related':'未命名',
    'task.edit':'编辑',
    'task.delete':'删除',
    'task.save':'保存',
    'task.cancel':'取消',
    'task.delete.confirm':'确定要删除此任务吗？此操作不可撤销。',
    'task.delete.error':'删除任务失败：',
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
    'skill.delete.error':'删除技能失败：',
    'skill.save.error':'保存技能失败：'
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
  document.title=t('title')+' - MemOS';
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

function enterApp(){
  document.getElementById('app').style.display='flex';
  loadAll();
}

function switchView(view){
  document.querySelectorAll('.nav-tabs .tab').forEach(t=>t.classList.toggle('active',t.dataset.view===view));
  const feedWrap=document.getElementById('feedWrap');
  const analyticsView=document.getElementById('analyticsView');
  const tasksView=document.getElementById('tasksView');
  const skillsView=document.getElementById('skillsView');
  const logsView=document.getElementById('logsView');
  const settingsView=document.getElementById('settingsView');
  const migrateView=document.getElementById('migrateView');
  feedWrap.classList.add('hide');
  analyticsView.classList.remove('show');
  tasksView.classList.remove('show');
  skillsView.classList.remove('show');
  logsView.classList.remove('show');
  settingsView.classList.remove('show');
  migrateView.classList.remove('show');
  if(view==='analytics'){
    analyticsView.classList.add('show');
    loadMetrics();
  } else if(view==='tasks'){
    tasksView.classList.add('show');
    loadTasks();
  } else if(view==='skills'){
    skillsView.classList.add('show');
    loadSkills();
  } else if(view==='logs'){
    logsView.classList.add('show');
    loadLogs();
  } else if(view==='settings'){
    settingsView.classList.add('show');
    loadConfig();
  } else if(view==='import'){
    migrateView.classList.add('show');
    if(!window._migrateRunning) migrateScan();
  } else {
    feedWrap.classList.remove('hide');
  }
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
  const time=d.toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false});
  const y=d.getFullYear();
  const m=String(d.getMonth()+1).padStart(2,'0');
  const day=String(d.getDate()).padStart(2,'0');
  return y+'-'+m+'-'+day+' '+time;
}

function buildLogSummary(lg){
  let inputObj=null;
  try{inputObj=JSON.parse(lg.input);}catch(_){}
  let html='';
  const tn=lg.toolName;
  if(tn==='memory_search'&&inputObj){
    const q=inputObj.query||'';
    if(q) html+='<div class="log-summary-query">'+escapeHtml(q.length>200?q.slice(0,200)+'...':q)+'</div>';
    const outLines=(lg.output||'').split('\\n');
    const memCount=outLines.filter(l=>l.match(/^\\d+\\.\\s*\\[/)).length;
    if(memCount>0) html+='<div style="margin-top:4px;font-size:11px;color:var(--text-sec)">\u{1F4CE} '+memCount+' memories retrieved</div>';
    else if(lg.output&&lg.output.includes('no hits')) html+='<div style="margin-top:4px;font-size:11px;color:var(--text-sec)">\u2205 No matching memories</div>';
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
    const outLines=out.split('\\n').filter(l=>l.startsWith('['));
    if(outLines.length>0){
      html+='<div class="log-msg-list">';
      outLines.forEach(function(l){
        var rm=l.match(/^\\[(\\w+)\\]\\s*([^\u2192]+)\u2192\\s*(.*)/);
        if(rm){
          var role=rm[1],actionRaw=rm[2].trim(),text=rm[3].trim();
          var actionCls='stored';
          if(actionRaw.indexOf('exact-dup')>=0||actionRaw.indexOf('\u23ED')>=0) actionCls='exact-dup';
          else if(actionRaw.indexOf('dedup')>=0||actionRaw.indexOf('\uD83D\uDD01')>=0) actionCls='dedup';
          else if(actionRaw.indexOf('merged')>=0||actionRaw.indexOf('\uD83D\uDD00')>=0) actionCls='merged';
          else if(actionRaw.indexOf('error')>=0||actionRaw.indexOf('\u274C')>=0) actionCls='error';
          var actionLabel={'stored':'\u2713 stored','exact-dup':'\u23ED skip','dedup':'\uD83D\uDD01 dedup','merged':'\uD83D\uDD00 merged','error':'\u2717 error'}[actionCls]||actionCls;
          html+='<div class="log-msg-item">'+
            '<span class="log-msg-role '+role+'">'+role+'</span>'+
            '<span class="log-msg-action '+actionCls+'">'+actionLabel+'</span>'+
            '<span class="log-msg-text">'+escapeHtml(text.length>150?text.slice(0,150)+'...':text)+'</span>'+
          '</div>';
        }else{
          html+='<div class="log-msg-item"><span class="log-msg-text">'+escapeHtml(l.length>200?l.slice(0,200)+'...':l)+'</span></div>';
        }
      });
      html+='</div>';
    }else if(inputObj.details&&Array.isArray(inputObj.details)&&inputObj.details.length>0){
      html+='<div class="log-msg-list">';
      inputObj.details.forEach(function(d){
        var s=typeof d==='string'?d:String(d);
        var dm=s.match(/^\\[(\\w+)\\]\\s*(.*)/);
        if(dm){
          html+='<div class="log-msg-item"><span class="log-msg-role '+dm[1]+'">'+dm[1]+'</span><span class="log-msg-text">'+escapeHtml(dm[2].length>150?dm[2].slice(0,150)+'...':dm[2])+'</span></div>';
        }else{
          html+='<div class="log-msg-item"><span class="log-msg-text">'+escapeHtml(s.length>150?s.slice(0,150)+'...':s)+'</span></div>';
        }
      });
      html+='</div>';
    }
  }else if(inputObj){
    const keys=Object.keys(inputObj);
    keys.slice(0,4).forEach(k=>{
      const v=String(inputObj[k]);
      html+='<span class="log-summary-kv"><span class="kv-label">'+escapeHtml(k)+':</span><span class="kv-val">'+escapeHtml(v.length>60?v.slice(0,60)+'...':v)+'</span></span>';
    });
  }
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
    try{const parsed=JSON.parse(lg.input);inputDisplay=JSON.stringify(parsed,null,2);}catch(_){inputDisplay=lg.input;}
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
          '<pre class="log-io-content">'+escapeHtml(inputDisplay)+'</pre>'+
        '</div>'+
        '<div class="log-io-section">'+
          '<div class="log-io-label">\u25C0 '+t('logs.output')+'</div>'+
          '<pre class="log-io-content">'+escapeHtml(lg.output)+'</pre>'+
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

function setMetricsDays(d){
  metricsDays=d;
  document.querySelectorAll('.metrics-toolbar .range-btn').forEach(btn=>btn.classList.toggle('active',Number(btn.dataset.days)===d));
  loadMetrics();
}

async function loadMetrics(){
  const r=await fetch('/api/metrics?days='+metricsDays);
  const d=await r.json();
  document.getElementById('mTotal').textContent=formatNum(d.totals.memories);
  document.getElementById('mTodayWrites').textContent=formatNum(d.totals.todayWrites);
  document.getElementById('mSessions').textContent=formatNum(d.totals.sessions);
  document.getElementById('mEmbeddings').textContent=formatNum(d.totals.embeddings);
  renderChartWrites(d.writesPerDay);
  renderBreakdown(d.roleBreakdown,'breakdownRole');
  renderBreakdown(d.kindBreakdown,'breakdownKind');
  loadToolMetrics();
}

function formatNum(n){return n>=1e6?(n/1e6).toFixed(1)+'M':n>=1e3?(n/1e3).toFixed(1)+'k':String(n);}

/* ─── Tasks View Logic ─── */
let tasksStatusFilter='';
let tasksPage=0;
const TASKS_PER_PAGE=20;

function setTaskStatusFilter(btn,status){
  document.querySelectorAll('.tasks-filters .filter-chip').forEach(c=>c.classList.remove('active'));
  btn.classList.add('active');
  tasksStatusFilter=status;
  tasksPage=0;
  loadTasks();
}

async function loadTasks(){
  const list=document.getElementById('tasksList');
  list.innerHTML='<div class="spinner"></div>';
  try{
    const params=new URLSearchParams({limit:String(TASKS_PER_PAGE),offset:String(tasksPage*TASKS_PER_PAGE)});
    if(tasksStatusFilter) params.set('status',tasksStatusFilter);
    const r=await fetch('/api/tasks?'+params);
    const data=await r.json();

    // stats
    const allR=await fetch('/api/tasks?limit=1&offset=0');
    const allD=await allR.json();
    document.getElementById('tasksTotalCount').textContent=formatNum(allD.total);

    const activeR=await fetch('/api/tasks?status=active&limit=1&offset=0');
    const activeD=await activeR.json();
    document.getElementById('tasksActiveCount').textContent=formatNum(activeD.total);

    const compR=await fetch('/api/tasks?status=completed&limit=1&offset=0');
    const compD=await compR.json();
    document.getElementById('tasksCompletedCount').textContent=formatNum(compD.total);

    const skipR=await fetch('/api/tasks?status=skipped&limit=1&offset=0');
    const skipD=await skipR.json();
    document.getElementById('tasksSkippedCount').textContent=formatNum(skipD.total);

    if(!data.tasks||data.tasks.length===0){
      list.innerHTML='<div style="text-align:center;padding:48px;color:var(--text-muted);font-size:14px" data-i18n="tasks.empty">'+t('tasks.empty')+'</div>';
      document.getElementById('tasksPagination').innerHTML='';
      return;
    }

    list.innerHTML=data.tasks.map(task=>{
      const timeStr=formatTime(task.startedAt);
      const endStr=task.endedAt?formatTime(task.endedAt):'';
      const durationStr=task.endedAt?formatDuration(task.endedAt-task.startedAt):'';
      return '<div class="task-card status-'+task.status+'" onclick="openTaskDetail(\\''+task.id+'\\')">'+
        '<div class="task-card-top">'+
          '<div class="task-card-title">'+esc(task.title)+'</div>'+
          '<span class="task-status-badge '+task.status+'">'+t('tasks.status.'+task.status)+'</span>'+
        '</div>'+
        (task.summary?'<div class="task-card-summary'+(task.status==='skipped'?' skipped-reason':'')+'">'+esc(task.summary)+'</div>':'')+
        '<div class="task-card-bottom">'+
          '<span class="tag"><span class="icon">\\u{1F4C5}</span> '+timeStr+'</span>'+
          (durationStr?'<span class="tag"><span class="icon">\\u23F1</span> '+durationStr+'</span>':'')+
          '<span class="tag"><span class="icon">\\u{1F4DD}</span> '+task.chunkCount+' '+t('tasks.chunks.label')+'</span>'+
          '<span class="tag"><span class="icon">\\u{1F4C2}</span> '+(task.sessionKey||'').slice(0,12)+'</span>'+
        '</div>'+
        '<div class="card-actions" onclick="event.stopPropagation()">'+
          '<button class="btn btn-sm btn-ghost" onclick="openTaskDetail(\\''+task.id+'\\')">'+t('card.expand')+'</button>'+
          '<button class="btn btn-sm btn-ghost" onclick="editTaskInline(\\''+task.id+'\\')">'+t('card.edit')+'</button>'+
          (task.status==='completed'&&(!task.skillStatus||task.skillStatus==='not_generated'||task.skillStatus==='skipped')?'<button class="btn btn-sm btn-ghost" onclick="retrySkillGen(\\''+task.id+'\\')">'+t('task.retrySkill.short')+'</button>':'')+
          '<button class="btn btn-sm btn-ghost" style="color:var(--accent)" onclick="deleteTask(\\''+task.id+'\\')">'+t('task.delete')+'</button>'+
        '</div>'+
      '</div>';
    }).join('');

    renderTasksPagination(data.total);
  }catch(e){
    console.error('loadTasks error:',e);
    list.innerHTML='<div style="text-align:center;padding:24px;color:var(--rose)">Failed to load tasks: '+String(e)+'</div>';
  }
}

function renderTasksPagination(total){
  const el=document.getElementById('tasksPagination');
  const pages=Math.ceil(total/TASKS_PER_PAGE);
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
  document.getElementById('taskDetailActions').innerHTML='';

  try{
    const r=await fetch('/api/task/'+taskId);
    const task=await r.json();

    document.getElementById('taskDetailTitle').textContent=task.title||t('tasks.untitled');

    const meta=[
      '<span class="meta-item"><span class="task-status-badge '+task.status+'">'+t('tasks.status.'+task.status)+'</span></span>',
      '<span class="meta-item">\\u{1F4C5} '+formatTime(task.startedAt)+'</span>',
    ];
    if(task.endedAt) meta.push('<span class="meta-item">\\u2192 '+formatTime(task.endedAt)+'</span>');
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
      document.getElementById('taskDetailChunks').innerHTML=task.chunks.map(c=>{
        var roleLabel=c.role==='user'?t('tasks.role.user'):c.role==='assistant'?t('tasks.role.assistant'):c.role.toUpperCase();
        return '<div class="task-chunk-item role-'+c.role+'">'+
          '<div class="task-chunk-role '+c.role+'">'+roleLabel+'</div>'+
          '<div class="task-chunk-bubble" onclick="this.classList.toggle(\\\'expanded\\\')">'+esc(c.content)+'</div>'+
          '<div class="task-chunk-time">'+formatTime(c.createdAt)+'</div>'+
        '</div>';
      }).join('');
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

function closeTaskDetail(event){
  if(event && event.target!==document.getElementById('taskDetailOverlay')) return;
  document.getElementById('taskDetailOverlay').classList.remove('show');
}

async function retrySkillGen(taskId){
  if(!confirm(t('task.retrySkill.confirm'))) return;
  try{
    const r=await fetch('/api/task/'+taskId+'/retry-skill',{method:'POST'});
    const d=await r.json();
    if(!r.ok) throw new Error(d.error||'unknown');
    openTaskDetail(taskId);
  }catch(e){ alert(t('task.retrySkill.error')+e.message); }
}

async function deleteTask(taskId){
  if(!confirm(t('task.delete.confirm'))) return;
  try{
    const r=await fetch('/api/task/'+taskId,{method:'DELETE'});
    const d=await r.json();
    if(!r.ok) throw new Error(d.error||'unknown');
    closeTaskDetail();
    document.getElementById('taskDetailOverlay').classList.remove('show');
    loadTasks();
  }catch(e){ alert(t('task.delete.error')+e.message); }
}

async function editTaskInline(){
  if(!_currentTaskData) return;
  var task=_currentTaskData;
  var titleEl=document.getElementById('taskDetailTitle');
  var summaryEl=document.getElementById('taskDetailSummary');
  var actionsEl=document.getElementById('taskDetailActions');

  titleEl.innerHTML='<input id="editTaskTitle" class="filter-input" style="width:100%;font-size:16px;font-weight:600" value="'+esc(task.title||'')+'"/>';
  summaryEl.innerHTML='<textarea id="editTaskSummary" class="filter-input" style="width:100%;min-height:80px;font-size:13px;resize:vertical">'+esc(task.summary||'')+'</textarea>';
  actionsEl.innerHTML=
    '<button class="btn btn-primary" onclick="saveTaskEdit()" style="font-size:12px">'+t('task.save')+'</button>'+
    '<button class="btn btn-ghost" onclick="openTaskDetail(\\''+esc(task.id)+'\\')" style="font-size:12px">'+t('task.cancel')+'</button>';
}

async function saveTaskEdit(){
  if(!_currentTaskId) return;
  var title=document.getElementById('editTaskTitle').value.trim();
  var summary=document.getElementById('editTaskSummary').value.trim();
  try{
    const r=await fetch('/api/task/'+_currentTaskId,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({title:title,summary:summary})});
    const d=await r.json();
    if(!r.ok) throw new Error(d.error||'unknown');
    openTaskDetail(_currentTaskId);
    loadTasks();
  }catch(e){ alert(t('task.save.error')+e.message); }
}

/* ─── Skills View Logic ─── */
let skillsStatusFilter='';

function setSkillStatusFilter(btn,status){
  document.querySelectorAll('.skills-view .tasks-filters .filter-chip').forEach(c=>c.classList.remove('active'));
  btn.classList.add('active');
  skillsStatusFilter=status;
  loadSkills();
}

async function loadSkills(){
  const list=document.getElementById('skillsList');
  list.innerHTML='<div class="spinner"></div>';
  try{
    const params=new URLSearchParams();
    if(skillsStatusFilter) params.set('status',skillsStatusFilter);
    const visFilter=document.getElementById('skillVisibilityFilter')?.value;
    if(visFilter) params.set('visibility',visFilter);
    const r=await fetch('/api/skills?'+params);
    const data=await r.json();

    document.getElementById('skillsTotalCount').textContent=formatNum(data.skills.length);
    document.getElementById('skillsActiveCount').textContent=formatNum(data.skills.filter(s=>s.status==='active').length);
    document.getElementById('skillsDraftCount').textContent=formatNum(data.skills.filter(s=>s.status==='draft').length);
    document.getElementById('skillsInstalledCount').textContent=formatNum(data.skills.filter(s=>s.installed).length);
    document.getElementById('skillsPublicCount').textContent=formatNum(data.skills.filter(s=>s.visibility==='public').length);

    if(!data.skills||data.skills.length===0){
      list.innerHTML='<div style="text-align:center;padding:48px;color:var(--text-muted);font-size:14px">'+t('skills.empty')+'</div>';
      return;
    }

    list.innerHTML=data.skills.map(skill=>{
      const timeStr=formatTime(skill.createdAt);
      const tags=parseTags(skill.tags);
      const installedClass=skill.installed?'installed':'';
      const statusClass=skill.status==='archived'?'archived':(skill.status==='draft'?'draft':'');
      const qs=skill.qualityScore;
      const qsBadge=qs!==null&&qs!==undefined?'<span class="skill-badge quality '+(qs>=7?'high':qs>=5?'mid':'low')+'">\\u2605 '+qs.toFixed(1)+'</span>':'';
      const visBadge=skill.visibility==='public'?'<span class="skill-badge visibility-public">\\u{1F310} '+t('skills.visibility.public')+'</span>':'';
      return '<div class="skill-card '+installedClass+' '+statusClass+'" onclick="openSkillDetail(\\''+skill.id+'\\')">'+
        '<div class="skill-card-top">'+
          '<div class="skill-card-name">\\u{1F9E0} '+esc(skill.name)+'</div>'+
          '<div class="skill-card-badges">'+
            qsBadge+
            '<span class="skill-badge version">v'+skill.version+'</span>'+
            visBadge+
            (skill.installed?'<span class="skill-badge installed">'+t('skills.installed.badge')+'</span>':'')+
            '<span class="skill-badge status-'+skill.status+'">'+t('skills.status.'+skill.status)+'</span>'+
          '</div>'+
        '</div>'+
        '<div class="skill-card-desc">'+esc(skill.description)+'</div>'+
        '<div class="skill-card-bottom">'+
          '<span class="tag"><span class="icon">\\u{1F4C5}</span> '+timeStr+'</span>'+
          '<span class="tag"><span class="icon">\\u{1F4E6}</span> '+skill.sourceType+'</span>'+
          (tags.length>0?'<div class="skill-card-tags">'+tags.map(t=>'<span class="skill-tag">'+esc(t)+'</span>').join('')+'</div>':'')+
        '</div>'+
        '<div class="card-actions" onclick="event.stopPropagation()">'+
          '<button class="btn btn-sm btn-ghost" onclick="openSkillDetail(\\''+skill.id+'\\')">'+t('card.expand')+'</button>'+
          '<button class="btn btn-sm btn-ghost" onclick="editSkillInline(\\''+skill.id+'\\')">'+t('card.edit')+'</button>'+
          (skill.visibility==='public'?'<button class="btn btn-sm btn-ghost" onclick="toggleSkillPublic(\\''+skill.id+'\\',false)">\\u{1F512} '+t('skills.setPrivate')+'</button>':'<button class="btn btn-sm btn-ghost" onclick="toggleSkillPublic(\\''+skill.id+'\\',true)">\\u{1F310} '+t('skills.setPublic')+'</button>')+
          '<button class="btn btn-sm btn-ghost" style="color:var(--accent)" onclick="deleteSkill(\\''+skill.id+'\\')">'+t('skill.delete')+'</button>'+
        '</div>'+
      '</div>';
    }).join('');
  }catch(e){
    list.innerHTML='<div style="text-align:center;padding:24px;color:var(--rose)">Failed to load skills: '+esc(String(e))+'</div>';
  }
}

function parseTags(tagsStr){
  try{ const arr=JSON.parse(tagsStr||'[]'); return Array.isArray(arr)?arr:[]; }catch{ return []; }
}

let currentSkillId='';

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
    const visMeta=skill.visibility==='public'?'<span class="meta-item"><span class="skill-badge visibility-public">\\u{1F310} '+t('skills.visibility.public')+'</span></span>':'<span class="meta-item"><span class="skill-badge">\\u{1F512} '+t('skills.visibility.private')+'</span></span>';
    document.getElementById('skillDetailMeta').innerHTML=[
      '<span class="meta-item"><span class="skill-badge version">v'+skill.version+'</span></span>',
      '<span class="meta-item"><span class="skill-badge status-'+skill.status+'">'+t('skills.status.'+skill.status)+'</span></span>',
      visMeta,
      qsBadge,
      skill.installed?'<span class="meta-item"><span class="skill-badge installed">'+t('skills.installed.badge')+'</span></span>':'',
      '<span class="meta-item">\\u{1F4C5} '+formatTime(skill.createdAt)+'</span>',
      '<span class="meta-item">\\u270F '+t('skills.updated')+formatTime(skill.updatedAt)+'</span>',
    ].filter(Boolean).join('');

    const visBtn=document.getElementById('skillVisibilityBtn');
    visBtn.className='skill-vis-btn';
    if(skill.visibility==='public'){
      visBtn.textContent='\\u{1F512} '+t('skills.setPrivate');
      visBtn.classList.add('is-public');
      visBtn.dataset.vis='public';
    } else {
      visBtn.textContent='\\u{1F310} '+t('skills.setPublic');
      visBtn.classList.add('is-private');
      visBtn.dataset.vis='private';
    }

    document.getElementById('skillDetailDesc').textContent=skill.description;

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
    document.getElementById('skillDetailActions').innerHTML='';

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
    if(!r.ok) throw new Error('Failed: '+r.status);
    openSkillDetail(currentSkillId);
    loadSkills();
  }catch(e){
    alert('Error: '+e.message);
  }
}

async function toggleSkillPublic(id,setPublic){
  const newVis=setPublic?'public':'private';
  try{
    const r=await fetch('/api/skill/'+id+'/visibility',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({visibility:newVis})});
    if(!r.ok) throw new Error('Failed: '+r.status);
    toast(setPublic?t('toast.setPublic'):t('toast.setPrivate'),'success');
    loadSkills();
  }catch(e){
    toast('Error: '+e.message,'error');
  }
}

/* ─── Settings / Config ─── */
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

    const tel=cfg.telemetry||{};
    document.getElementById('cfgTelemetryEnabled').checked=tel.enabled!==false;
  }catch(e){
    console.error('loadConfig error',e);
  }
}

async function saveConfig(){
  const cfg={};
  const embP=document.getElementById('cfgEmbProvider').value;
  if(embP){
    cfg.embedding={provider:embP};
    const v=document.getElementById('cfgEmbModel').value.trim();if(v) cfg.embedding.model=v;
    const e=document.getElementById('cfgEmbEndpoint').value.trim();if(e) cfg.embedding.endpoint=e;
    const k=document.getElementById('cfgEmbApiKey').value.trim();if(k) cfg.embedding.apiKey=k;
  }
  const sumP=document.getElementById('cfgSumProvider').value;
  if(sumP){
    cfg.summarizer={provider:sumP};
    const v=document.getElementById('cfgSumModel').value.trim();if(v) cfg.summarizer.model=v;
    const e=document.getElementById('cfgSumEndpoint').value.trim();if(e) cfg.summarizer.endpoint=e;
    const k=document.getElementById('cfgSumApiKey').value.trim();if(k) cfg.summarizer.apiKey=k;
    const tp=document.getElementById('cfgSumTemp').value.trim();if(tp!=='') cfg.summarizer.temperature=Number(tp);
  }
  cfg.skillEvolution={
    enabled:document.getElementById('cfgSkillEnabled').checked,
    autoInstall:document.getElementById('cfgSkillAutoInstall').checked
  };
  const mc=document.getElementById('cfgSkillConfidence').value.trim();if(mc) cfg.skillEvolution.minConfidence=Number(mc);
  const mk=document.getElementById('cfgSkillMinChunks').value.trim();if(mk) cfg.skillEvolution.minChunksForEval=Number(mk);

  const skP=document.getElementById('cfgSkillProvider').value;
  if(skP){
    cfg.skillEvolution.summarizer={provider:skP};
    const sv=document.getElementById('cfgSkillModel').value.trim();if(sv) cfg.skillEvolution.summarizer.model=sv;
    const se=document.getElementById('cfgSkillEndpoint').value.trim();if(se) cfg.skillEvolution.summarizer.endpoint=se;
    const sk=document.getElementById('cfgSkillApiKey').value.trim();if(sk) cfg.skillEvolution.summarizer.apiKey=sk;
  }

  const vp=document.getElementById('cfgViewerPort').value.trim();
  if(vp) cfg.viewerPort=Number(vp);

  cfg.telemetry={
    enabled:document.getElementById('cfgTelemetryEnabled').checked
  };

  try{
    const r=await fetch('/api/config',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(cfg)});
    if(!r.ok) throw new Error(await r.text());
    const el=document.getElementById('settingsSaved');
    el.classList.add('show');
    setTimeout(()=>el.classList.remove('show'),2500);
  }catch(e){
    showToast(t('settings.save.fail')+': '+e.message,'error');
  }
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
}

async function deleteSkill(skillId){
  if(!confirm(t('skill.delete.confirm'))) return;
  try{
    const r=await fetch('/api/skill/'+skillId,{method:'DELETE'});
    const d=await r.json();
    if(!r.ok) throw new Error(d.error||'unknown');
    closeSkillDetail();
    document.getElementById('skillDetailOverlay').classList.remove('show');
    loadSkills();
  }catch(e){ alert(t('skill.delete.error')+e.message); }
}

function editSkillInline(){
  var skill=window._currentSkillData;
  if(!skill) return;
  var descEl=document.getElementById('skillDetailDesc');
  var actionsEl=document.getElementById('skillDetailActions');
  descEl.innerHTML='<textarea id="editSkillDesc" class="filter-input" style="width:100%;min-height:60px;font-size:13px;resize:vertical">'+esc(skill.description||'')+'</textarea>';
  actionsEl.innerHTML=
    '<button class="btn btn-primary" onclick="saveSkillEdit()" style="font-size:12px">'+t('skill.save')+'</button>'+
    '<button class="btn btn-ghost" onclick="openSkillDetail(\\''+esc(skill.id)+'\\')" style="font-size:12px">'+t('skill.cancel')+'</button>';
}

async function saveSkillEdit(){
  if(!currentSkillId) return;
  var desc=document.getElementById('editSkillDesc').value.trim();
  try{
    const r=await fetch('/api/skill/'+currentSkillId,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({description:desc})});
    const d=await r.json();
    if(!r.ok) throw new Error(d.error||'unknown');
    openSkillDetail(currentSkillId);
    loadSkills();
  }catch(e){ alert(t('skill.save.error')+e.message); }
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
  return new Date(ts).toLocaleString('zh-CN',{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'});
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
  if(days>21){
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
  const vals=data.map(d=>d[valueKey]??0);
  if(vals.every(v=>v===0)){el.innerHTML='<div style="color:var(--text-muted);font-size:13px;padding:20px;text-align:center">'+t('chart.nodata')+'</div>';return;}
  const max=Math.max(1,...vals);
  const nonZero=vals.filter(v=>v>0).length;
  const barStyle=data.length<=7?'min-width:40px;max-width:120px':'';
  el.innerHTML=data.map(r=>{
    const v=r[valueKey]??0;
    const label=r.date.includes('~')?r.date:(r.date.length>5?r.date.slice(5):r.date);
    if(v===0){
      return '<div class="chart-bar-wrap" style="'+barStyle+'"><div class="chart-tip">0</div><div class="chart-bar-col"><div class="chart-bar zero" style="height:2px"></div></div><div class="chart-bar-label">'+label+'</div></div>';
    }
    const h=Math.max(8,Math.round((v/max)*H));
    return '<div class="chart-bar-wrap" style="'+barStyle+'"><div class="chart-tip">'+v+'</div><div class="chart-bar-col"><div class="chart-bar" style="height:'+h+'px"></div></div><div class="chart-bar-label">'+label+'</div></div>';
  }).join('');
}

function renderChartWrites(rows){
  const el=document.getElementById('chartWrites');
  const filled=fillDays(rows?.map(r=>({date:r.date,count:r.count})),metricsDays);
  renderBars(el,filled,'count',160);
}

function renderChartCalls(rows){
  const el=document.getElementById('chartCalls');
  const filled=fillDays(rows?.map(r=>({date:r.date,list:r.list,search:r.search})),metricsDays);
  const vals=filled.map(f=>f.total);
  if(vals.every(v=>v===0)){el.innerHTML='<div style="color:var(--text-muted);font-size:13px;padding:20px;text-align:center">'+t('chart.nocalls')+'</div>';return;}
  const max=Math.max(1,...vals);
  const H=160;
  el.innerHTML=filled.map(r=>{
    const label=r.date.includes('~')?r.date:(r.date.length>5?r.date.slice(5):r.date);
    if(r.total===0){
      return '<div class="chart-bar-wrap"><div class="chart-tip">0</div><div class="chart-bar-col"><div class="chart-bar zero" style="height:2px"></div></div><div class="chart-bar-label">'+label+'</div></div>';
    }
    const totalH=Math.max(8,Math.round((r.total/max)*H));
    const listH=r.list?Math.max(3,Math.round((r.list/r.total)*totalH)):0;
    const searchH=r.search?totalH-listH:0;
    const tip='List: '+r.list+', Search: '+r.search;
    let bars='';
    if(searchH>0) bars+='<div class="chart-bar violet" style="height:'+searchH+'px"></div>';
    if(listH>0) bars+='<div class="chart-bar" style="height:'+listH+'px"></div>';
    return '<div class="chart-bar-wrap"><div class="chart-tip">'+tip+'</div><div class="chart-bar-col"><div style="display:flex;flex-direction:column;gap:1px">'+bars+'</div></div><div class="chart-bar-label">'+label+'</div></div>';
  }).join('');
}

/* ─── Tool Performance Chart ─── */
let toolMinutes=60;
const TOOL_COLORS=['#818cf8','#34d399','#fbbf24','#f87171','#38bdf8','#a78bfa','#fb923c'];

function setToolMinutes(m){
  toolMinutes=m;
  document.querySelectorAll('.tool-range').forEach(b=>{
    b.classList.toggle('active',Number(b.dataset.mins)===m);
  });
  loadToolMetrics();
}

async function loadToolMetrics(){
  try{
    const r=await fetch('/api/tool-metrics?minutes='+toolMinutes);
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

function renderBreakdown(obj,containerId){
  const el=document.getElementById(containerId);
  if(!el)return;
  const entries=Object.entries(obj||{}).sort((a,b)=>b[1]-a[1]);
  const total=entries.reduce((s,[,v])=>s+v,0)||1;
  el.innerHTML=entries.map(([label,value])=>{
    const pct=Math.round((value/total)*100);
    return '<div class="breakdown-item"><div class="bd-top"><span class="label">'+esc(label)+'</span><span class="value">'+value+' <span style="font-size:11px;font-weight:500;color:var(--text-muted)">('+pct+'%)</span></span></div><div class="breakdown-bar-wrap"><div class="breakdown-bar" style="width:'+pct+'%"></div></div></div>';
  }).join('');
}

/* ─── Data loading ─── */
async function loadAll(){
  await Promise.all([loadStats(),loadMemories()]);
  checkMigrateStatus();
  connectPPSSE();
}

async function loadStats(){
  let d;
  try{
    const r=await fetch('/api/stats');
    d=await r.json();
  }catch(e){ d={}; }
  if(!d||typeof d!=='object') d={};
  const tm=d.totalMemories||0;
  const dedupB=d.dedupBreakdown||{};
  const activeCount=dedupB.active||tm;
  const inactiveCount=(dedupB.duplicate||0)+(dedupB.merged||0);
  document.getElementById('statTotal').textContent=tm;
  if(inactiveCount>0){
    document.getElementById('statTotal').title=activeCount+' '+t('stat.active')+', '+inactiveCount+' '+t('stat.deduped');
  }
  document.getElementById('statSessions').textContent=d.totalSessions||0;
  document.getElementById('statEmbeddings').textContent=d.totalEmbeddings||0;
  let days=0;
  if(d.timeRange&&d.timeRange.earliest!=null&&d.timeRange.latest!=null){
    let e=Number(d.timeRange.earliest), l=Number(d.timeRange.latest);
    if(Number.isFinite(e)&&Number.isFinite(l)){
      if(e<1e12) e*=1000;
      if(l<1e12) l*=1000;
      days=Math.round((l-e)/86400000);
      days=Math.max(0,Math.min(36500,days));
      if(days===0) days=1;
    }
  }
  document.getElementById('statTimeSpan').textContent=days;

  const provEl=document.getElementById('embeddingStatus');
  if(d.embeddingProvider && d.embeddingProvider!=='none'){
    provEl.innerHTML='<div class="provider-badge"><span>\\u2713</span> '+t('embed.on')+d.embeddingProvider+'</div>';
  } else {
    provEl.innerHTML='<div class="provider-badge offline"><span>\\u26A0</span> '+t('embed.off')+'</div>';
  }

  const sl=document.getElementById('sessionList');
  sl.innerHTML='<div class="session-item'+(activeSession===null?' active':'')+'" onclick="filterSession(null)"><span>'+t('sidebar.allsessions')+'</span><span class="count">'+tm+'</span></div>';
  (d.sessions||[]).forEach(s=>{
    const isActive=activeSession===s.session_key;
    const name=s.session_key.length>20?s.session_key.slice(0,8)+'...'+s.session_key.slice(-8):s.session_key;
    sl.innerHTML+='<div class="session-item'+(isActive?' active':'')+'" onclick="filterSession(\\''+s.session_key.replace(/'/g,"\\\\'")+'\\')"><span title="'+s.session_key+'">'+name+'</span><span class="count">'+s.count+'</span></div>';
  });

  const ownerSel=document.getElementById('filterOwner');
  if(ownerSel && d.owners && d.owners.length>0){
    const curVal=ownerSel.value;
    ownerSel.innerHTML='<option value="">'+t('filter.allowners')+'</option>'+'<option value="public">'+t('filter.public')+'</option>';
    d.owners.filter(o=>o && o!=='public').forEach(o=>{
      ownerSel.innerHTML+='<option value="'+o+'">'+o+'</option>';
    });
    ownerSel.value=curVal;
  }
}

function getFilterParams(){
  const p=new URLSearchParams();
  if(activeSession) p.set('session',activeSession);
  if(activeRole) p.set('role',activeRole);
  const kind=document.getElementById('filterKind').value;
  if(kind) p.set('kind',kind);
  const df=document.getElementById('dateFrom').value;
  if(df) p.set('dateFrom',df);
  const dt=document.getElementById('dateTo').value;
  if(dt) p.set('dateTo',dt);
  const sort=document.getElementById('filterSort').value;
  if(sort==='oldest') p.set('sort','oldest');
  const owner=document.getElementById('filterOwner').value;
  if(owner) p.set('owner',owner);
  return p;
}

async function loadMemories(page){
  if(page) currentPage=page;
  const list=document.getElementById('memoryList');
  list.innerHTML='<div class="spinner"></div>';
  try{
    const p=getFilterParams();
    p.set('limit',PAGE_SIZE);
    p.set('page',currentPage);
    const r=await fetch('/api/memories?'+p.toString());
    const d=await r.json();
    totalPages=d.totalPages||1;
    totalCount=d.total||0;
    document.getElementById('searchMeta').textContent=totalCount+t('search.meta.total');
    renderMemories(d.memories||[]);
    renderPagination();
  }catch(e){
    list.innerHTML='';
    totalPages=1;totalCount=0;
    renderMemories([]);
    renderPagination();
  }
}

async function doSearch(q){
  if(!q.trim()){currentPage=1;loadMemories();return}
  const list=document.getElementById('memoryList');
  list.innerHTML='<div class="spinner"></div>';
  const p=getFilterParams();
  p.set('q',q);
  const r=await fetch('/api/search?'+p.toString());
  const d=await r.json();
  const meta=[];
  if(d.vectorCount>0) meta.push(d.vectorCount+t('search.meta.semantic'));
  if(d.ftsCount>0) meta.push(d.ftsCount+t('search.meta.text'));
  meta.push(d.total+t('search.meta.results'));
  document.getElementById('searchMeta').textContent=meta.join(' \\u00B7 ');
  renderMemories(d.results||[]);
  document.getElementById('pagination').innerHTML='';
}

function debounceSearch(){
  clearTimeout(searchTimer);
  searchTimer=setTimeout(()=>doSearch(document.getElementById('searchInput').value),350);
}

function filterSession(key){
  activeSession=key;
  currentPage=1;
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

/* ─── Rendering ─── */
function renderMemories(items){
  const list=document.getElementById('memoryList');
  if(!items.length){
    list.innerHTML='<div class="empty"><div class="icon">\\u{1F4ED}</div><p>'+t('empty.text')+'</p></div>';
    return;
  }
  items.forEach(m=>{memoryCache[m.id]=m});
  list.innerHTML=items.map(m=>{
    const time=m.created_at?new Date(typeof m.created_at==='number'?m.created_at:m.created_at).toLocaleString('zh-CN'):'';
    const role=m.role||'user';
    const kind=m.kind||'paragraph';
    const summary=esc(m.summary||m.content?.slice(0,120)||'');
    const content=esc(m.content||'');
    const id=m.id;
    const vscore=m._vscore?'<span class="vscore-badge">'+Math.round(m._vscore*100)+'%</span>':'';
    const sid=m.session_key||'';
    const sidShort=sid.length>18?sid.slice(0,6)+'..'+sid.slice(-6):sid;
    const mc=m.merge_count||0;
    const mergeBadge=mc>0?'<span class="merge-badge">\\u{1F504} '+t('card.evolved')+' '+mc+t('card.times')+'</span>':'';
    const updatedAt=(m.updated_at&&m.updated_at>m.created_at)?'<span class="card-updated">'+t('card.updated')+' '+new Date(m.updated_at).toLocaleString('zh-CN')+'</span>':'';
    const ds=m.dedup_status||'active';
    const isInactive=ds==='duplicate'||ds==='merged';
    const dedupBadge=ds==='duplicate'?'<span class="dedup-badge duplicate">'+t('card.dedupDuplicate')+'</span>':ds==='merged'?'<span class="dedup-badge merged">'+t('card.dedupMerged')+'</span>':'';
    const isImported=sid.startsWith('openclaw-import-')||sid.startsWith('openclaw-session-');
    const importBadge=isImported?'<span class="import-badge">\u{1F990} '+t('card.imported')+'</span>':'';
    const ownerVal=m.owner||'agent:main';
    const isPublicMem=ownerVal==='public';
    const ownerBadge=isPublicMem?'<span class="owner-badge public">\\u{1F310} '+t('filter.public')+'</span>':'<span class="owner-badge agent">\\u{1F512} '+t('filter.private')+'</span>';
    let dedupInfo='';
    if(isInactive){
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
            const ht=h.at?new Date(h.at).toLocaleString('zh-CN'):'';
            historyHtml+='<div class="merge-history-item"><span class="merge-action '+h.action+'">'+h.action+'</span> <span style="color:var(--text-muted)">'+ht+'</span><br>'+esc(h.reason||'');
            if(h.from) historyHtml+='<br><span style="opacity:.6">'+t('card.oldSummary')+':</span> '+esc(h.from);
            if(h.to) historyHtml+='<br><span style="opacity:.6">'+t('card.newSummary')+':</span> '+esc(h.to);
            historyHtml+='</div>';
          });
          historyHtml+='</div>';
        }
      }catch(e){}
    }
    return '<div class="memory-card'+(isInactive?' dedup-inactive':'')+'">'+
      '<div class="card-header"><div class="meta"><span class="role-tag '+role+'">'+role+'</span><span class="kind-tag">'+kind+'</span>'+ownerBadge+importBadge+dedupBadge+mergeBadge+'</div><span class="card-time"><span class="session-tag" title="'+esc(sid)+'">'+esc(sidShort)+'</span> '+time+updatedAt+'</span></div>'+
      '<div class="card-summary">'+summary+'</div>'+
      dedupInfo+
      '<div class="card-content" id="content-'+id+'"><pre>'+content+'</pre></div>'+
      historyHtml+
      '<div class="card-actions">'+
        '<button class="btn btn-sm btn-ghost" onclick="toggleContent(\\''+id+'\\')">'+t('card.expand')+'</button>'+
        (mc>0?'<button class="btn btn-sm btn-ghost" onclick="toggleHistory(\\''+id+'\\')">'+t('card.evolveHistory')+'</button>':'')+
        '<button class="btn btn-sm btn-ghost" onclick="openEditModal(\\''+id+'\\')">'+t('card.edit')+'</button>'+
        (isPublicMem?'<button class="btn btn-sm btn-ghost" onclick="toggleMemoryPublic(\\''+id+'\\',false)">\\u{1F512} '+t('skills.setPrivate')+'</button>':'<button class="btn btn-sm btn-ghost mem-public-btn" onclick="toggleMemoryPublic(\\''+id+'\\',true)">\\u{1F310} '+t('skills.setPublic')+'</button>')+
        '<button class="btn btn-sm btn-ghost" style="color:var(--accent)" onclick="deleteMemory(\\''+id+'\\')">'+t('card.delete')+'</button>'+
        vscore+
      '</div></div>';
  }).join('');
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
  loadMemories();
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
async function showMemoryModal(chunkId){
  const overlay=document.getElementById('memoryModal');
  const body=document.getElementById('memoryModalBody');
  body.innerHTML='<div style="text-align:center;padding:40px;color:var(--text-sec)">Loading...</div>';
  overlay.classList.add('show');
  try{
    const res=await fetch('/api/memory/'+encodeURIComponent(chunkId));
    if(!res.ok){body.innerHTML='<div style="text-align:center;padding:40px;color:#f87171">Memory not found</div>';return;}
    const data=await res.json();
    const m=data.memory;
    const role=(m.role||'unknown').toUpperCase();
    const roleCls=(m.role||'').toLowerCase();
    const kind=m.kind||'paragraph';
    const ds=m.dedup_status||'active';
    const time=new Date(m.created_at).toLocaleString('zh-CN');
    const updated=m.updated_at?new Date(m.updated_at).toLocaleString('zh-CN'):'';
    let html='<div class="modal-memory-card">';
    html+='<div class="modal-header-row"><span class="role-tag '+roleCls+'">'+role+'</span><span class="kind-tag">'+kind+'</span>';
    if(ds!=='active') html+='<span class="dedup-badge '+(ds==='duplicate'?'duplicate':'merged')+'">'+ds+'</span>';
    html+='</div>';
    html+='<div class="modal-field"><div class="modal-field-label">ID</div><div class="modal-field-val" style="font-family:monospace;font-size:11px">'+esc(m.id)+'</div></div>';
    html+='<div class="modal-field"><div class="modal-field-label">Summary</div><div class="modal-field-val" style="font-size:14px;font-weight:600">'+esc(m.summary||'')+'</div></div>';
    html+='<div class="modal-field"><div class="modal-field-label">Content</div><pre class="modal-field-content">'+esc(m.content||'')+'</pre></div>';
    html+='<div class="modal-meta-row">';
    html+='<span><strong>Session:</strong> '+esc(m.session_key||'')+'</span>';
    html+='<span><strong>Created:</strong> '+time+'</span>';
    if(updated) html+='<span><strong>Updated:</strong> '+updated+'</span>';
    html+='</div>';
    if(m.dedup_reason) html+='<div class="modal-field"><div class="modal-field-label">Dedup Reason</div><div class="modal-field-val">'+esc(m.dedup_reason)+'</div></div>';
    if(m.dedup_target&&m.dedup_target!==chunkId) html+='<div class="modal-field"><span class="dedup-target-link" onclick="closeMemoryModal();scrollToMemory(\\''+m.dedup_target+'\\')">View target: '+m.dedup_target.slice(0,8)+'...</span></div>';
    html+='</div>';
    body.innerHTML=html;
  }catch(e){body.innerHTML='<div style="text-align:center;padding:40px;color:#f87171">Error: '+esc(String(e))+'</div>';}
}
function closeMemoryModal(){document.getElementById('memoryModal').classList.remove('show');}


function esc(s){
  if(!s)return'';
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
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
function openCreateModal(){
  editingId=null;
  document.getElementById('modalTitle').textContent=t('modal.new');
  document.getElementById('modalSubmit').textContent=t('modal.create');
  document.getElementById('mRole').value='user';
  document.getElementById('mContent').value='';
  document.getElementById('mSummary').value='';
  document.getElementById('mKind').value='paragraph';
  document.getElementById('modalOverlay').classList.add('show');
}

function openEditModal(id){
  const m=memoryCache[id];
  if(!m){toast(t('toast.notfound'),'error');return}
  editingId=id;
  document.getElementById('modalTitle').textContent=t('modal.edit');
  document.getElementById('modalSubmit').textContent=t('modal.save');
  document.getElementById('mRole').value=m.role||'user';
  document.getElementById('mContent').value=m.content||'';
  document.getElementById('mSummary').value=m.summary||'';
  document.getElementById('mKind').value=m.kind||'paragraph';
  document.getElementById('modalOverlay').classList.add('show');
}

function closeModal(){
  document.getElementById('modalOverlay').classList.remove('show');
}

async function submitModal(){
  const data={
    role:document.getElementById('mRole').value,
    content:document.getElementById('mContent').value,
    summary:document.getElementById('mSummary').value,
    kind:document.getElementById('mKind').value,
  };
  if(!data.content.trim()){toast(t('modal.err.empty'),'error');return}
  let r;
  if(editingId){
    r=await fetch('/api/memory/'+editingId,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});
  } else {
    r=await fetch('/api/memory',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});
  }
  const d=await r.json();
  if(d.ok){toast(editingId?t('toast.updated'):t('toast.created'),'success');closeModal();loadAll();}
  else{toast(d.error||t('toast.opfail'),'error')}
}

async function deleteMemory(id){
  if(!confirm(t('confirm.delete')))return;
  const r=await fetch('/api/memory/'+id,{method:'DELETE'});
  const d=await r.json();
  if(d.ok){toast(t('toast.deleted'),'success');loadAll();}
  else{toast(t('toast.delfail'),'error')}
}

async function toggleMemoryPublic(id,setPublic){
  const newOwner=setPublic?'public':'agent:main';
  try{
    const r=await fetch('/api/memory/'+id,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({owner:newOwner})});
    const d=await r.json();
    if(d.ok){toast(setPublic?t('toast.setPublic'):t('toast.setPrivate'),'success');loadAll();}
    else{toast(d.error||t('toast.opfail'),'error')}
  }catch(e){toast('Error: '+e.message,'error')}
}

async function clearAll(){
  if(!confirm(t('confirm.clearall')))return;
  if(!confirm(t('confirm.clearall2')))return;
  const r=await fetch('/api/memories',{method:'DELETE'});
  const d=await r.json();
  if(d.ok){toast(t('toast.cleared'),'success');loadAll();}
  else{toast(t('toast.clearfail'),'error')}
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

async function migrateScan(){
  const btn=document.getElementById('migrateScanBtn');
  btn.disabled=true;
  btn.textContent=t('migrate.scanning');
  document.getElementById('migrateStartBtn').style.display='none';
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

    if(d.totalItems>0 && d.configReady){
      document.getElementById('migrateStartBtn').style.display='inline-flex';
      document.getElementById('migrateConcurrencyRow').style.display='inline-flex';
    }

    if(d.totalItems===0){
      document.getElementById('migrateStatus').textContent=t('migrate.nodata');
    }

    if(d.hasImportedData){
      document.getElementById('postprocessSection').style.display='block';
    }
  }catch(e){
    toast('Scan failed: '+e.message,'error');
  }finally{
    btn.disabled=false;
    btn.textContent=t('migrate.scan');
  }
}

function migrateStart(){
  if(!migrateScanData||!migrateScanData.configReady)return;
  if(!confirm(t('migrate.start')+'?'))return;

  const concSel=document.getElementById('migrateConcurrency');
  const concurrency=concSel?parseInt(concSel.value,10)||1:1;

  window._migrateRunning=true;
  _migrateStatusChecked=false;
  document.getElementById('migrateStartBtn').style.display='none';
  document.getElementById('migrateScanBtn').disabled=true;
  document.getElementById('migrateConcurrencyRow').style.display='none';
  document.getElementById('migrateConcurrencyWarn').style.display='none';
  document.getElementById('migrateProgress').style.display='block';
  document.getElementById('migrateLiveLog').innerHTML='';
  migrateStats={stored:0,skipped:0,merged:0,errors:0};
  updateMigrateStats();

  document.getElementById('migrateStopBtn').disabled=false;
  document.getElementById('migrateBar').style.width='0%';
  document.getElementById('migrateBar').style.background='linear-gradient(90deg,#6366f1,#8b5cf6)';
  document.getElementById('migrateCounter').textContent='';
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
      if(done){if(!migrateDoneCalled&&!window._migrateRunning)onMigrateDone(false);return;}
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
  if(_migrateStatusChecked) return;
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
      document.getElementById('migrateStartBtn').style.display='none';
      document.getElementById('migrateScanBtn').disabled=true;
      document.getElementById('migrateStopBtn').disabled=false;
      const pct=s.total>0?Math.round((s.processed/s.total)*100):0;
      document.getElementById('migrateBar').style.width=pct+'%';
      document.getElementById('migrateCounter').textContent=s.processed+' / '+s.total+' ('+pct+'%)';
      const label=s.phase==='sqlite'?t('migrate.phase.sqlite'):t('migrate.phase.sessions');
      document.getElementById('migratePhaseLabel').textContent=label;
      connectMigrateSSE('/api/migrate/stream','GET',null);
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
  if(wasStopped){
    document.getElementById('migrateBar').style.background='linear-gradient(90deg,#f59e0b,#fbbf24)';
    document.getElementById('migrateStartBtn').style.display='inline-flex';
    document.getElementById('migrateStartBtn').textContent=t('migrate.resume');
  }else{
    document.getElementById('migrateBar').style.width='100%';
    document.getElementById('migrateBar').style.background='linear-gradient(90deg,#22c55e,#16a34a)';
    const total=migrateStats.stored+migrateStats.skipped+migrateStats.merged+migrateStats.errors;
    if(total>0) document.getElementById('migrateCounter').textContent=total+' / '+total+' (100%)';
  }
  fetch('/api/migrate/scan').then(r=>{if(!r.ok)throw new Error();return r.json()}).then(d=>{
    if(d&&d.hasImportedData) document.getElementById('postprocessSection').style.display='block';
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
      ppStats={tasks:s.tasksCreated||0,skills:s.skillsCreated||0,errors:s.errors||0,skipped:0};
      updatePPStats();
      document.getElementById('ppProgress').style.display='block';
      var pct2=s.total>0?Math.round((s.processed/s.total)*100):0;
      document.getElementById('ppBar').style.width=pct2+'%';
      document.getElementById('ppCounter').textContent=s.processed+' / '+s.total+' ('+pct2+'%)';
      ppDone(!!s.stopped,false,true);
    }
  }).catch(function(){});
}

function handlePPEvent(evtType,data){
  if(evtType==='progress'){
    var pct=data.total>0?Math.round((data.processed/data.total)*100):0;
    document.getElementById('ppBar').style.width=pct+'%';
    document.getElementById('ppCounter').textContent=data.processed+' / '+data.total+' ('+pct+'%)';
  }else if(evtType==='info'){
    if(data.alreadyProcessed>0){
      ppStats.skipped=data.alreadyProcessed;
      updatePPStats();
      appendPPLogItem({step:'skipped',session:t('pp.info.skipped').replace('{n}',data.alreadyProcessed),index:'',total:''});
    }
    if(data.pending===0){
      appendPPLogItem({step:'done',session:t('pp.info.allDone'),index:'',total:''});
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
      if(data.action==='skill-only'){
        ppStats.skills++;
      }else{
        ppStats.tasks++;
      }
      updatePPStats();
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
  var doneEl=document.getElementById('ppDone');
  doneEl.style.display='block';
  if(wasFailed){
    doneEl.style.background='rgba(239,68,68,.06)';
    doneEl.style.color='#ef4444';
    doneEl.textContent=t('pp.failed')||'Processing failed — check error above';
    document.getElementById('ppBar').style.background='linear-gradient(90deg,#ef4444,#dc2626)';
  }else if(wasStopped){
    doneEl.style.background='rgba(245,158,11,.06)';
    doneEl.style.color='#f59e0b';
    doneEl.textContent=t('pp.stopped');
    document.getElementById('ppBar').style.background='linear-gradient(90deg,#f59e0b,#fbbf24)';
  }else{
    doneEl.style.background='rgba(34,197,94,.06)';
    doneEl.style.color='#22c55e';
    doneEl.textContent=t('pp.done')+' ('+t('pp.stat.tasks')+': '+ppStats.tasks+', '+t('pp.stat.skills')+': '+ppStats.skills+')';
    document.getElementById('ppBar').style.width='100%';
    document.getElementById('ppBar').style.background='linear-gradient(90deg,#22c55e,#16a34a)';
  }
  if(!skipReload) loadAll();
}

/* ─── Toast ─── */
function toast(msg,type='info'){
  const c=document.getElementById('toasts');
  const t=document.createElement('div');
  t.className='toast '+type;
  const icons={success:'\\u2705',error:'\\u274C',info:'\\u2139\\uFE0F'};
  t.innerHTML=(icons[type]||'')+' '+esc(msg);
  c.appendChild(t);
  setTimeout(()=>t.remove(),3500);
}

/* ─── Theme ─── */
const VIEWER_THEME_KEY='memos-viewer-theme';
function initViewerTheme(){const s=localStorage.getItem(VIEWER_THEME_KEY);const theme=(s==='light'||s==='dark')?s:'dark';document.documentElement.setAttribute('data-theme',theme);}
function toggleViewerTheme(){const el=document.documentElement;const cur=el.getAttribute('data-theme')||'dark';const next=cur==='dark'?'light':'dark';el.setAttribute('data-theme',next);localStorage.setItem(VIEWER_THEME_KEY,next);}
initViewerTheme();

/* ─── Init ─── */
document.getElementById('modalOverlay').addEventListener('click',e=>{if(e.target.id==='modalOverlay')closeModal()});
document.getElementById('searchInput').addEventListener('keydown',e=>{if(e.key==='Escape'){e.target.value='';loadMemories()}});
applyI18n();
checkAuth();
</script>

<!-- Memory Detail Modal -->
<div class="memory-modal-overlay" id="memoryModal" onclick="if(event.target===this)closeMemoryModal()">
  <div class="memory-modal">
    <div class="memory-modal-title">
      <span>Memory Detail</span>
      <button class="btn btn-sm btn-ghost" onclick="closeMemoryModal()" style="font-size:16px;padding:2px 8px">&times;</button>
    </div>
    <div class="memory-modal-body" id="memoryModalBody"></div>
  </div>
</div>

</body>
</html>`;
}
