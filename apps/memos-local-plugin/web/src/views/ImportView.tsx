/**
 * Import / Export view.
 *
 *   - Export: `GET /api/v1/export` returns a JSON bundle of every
 *     trace/policy/world-model/skill. We trigger a browser download.
 *   - Import: POST the file back to `/api/v1/import`. The server
 *     preserves existing data and assigns fresh ids to imported rows.
 *   - Migrate: `POST /api/v1/migrate/legacy/run` — scans the legacy
 *     SQLite file for the **currently running agent** (openclaw or
 *     hermes — the server picks the right path based on its own
 *     `options.agent`) and copies rows into the V7 store.
 *   - Hermes native import: when this viewer is attached to Hermes,
 *     batch-imports `~/.hermes/memories/MEMORY.md` entries separated
 *     by a single `§` line.
 *   - OpenClaw native import: when attached to OpenClaw, batch-imports
 *     OpenClaw agent session JSONL user/assistant messages.
 */
import { useEffect, useRef, useState } from "preact/hooks";
import { api } from "../api/client";
import { health } from "../stores/health";
import { t } from "../stores/i18n";
import { Icon } from "../components/Icon";

type NativeImportKind = "hermes" | "openclaw";

interface NativeImportScan {
  found: boolean;
  agent?: string;
  path: string;
  total: number;
  files?: number;
  sessions?: number;
  bytes?: number;
  error?: string;
}

interface NativeImportBatchResult {
  path: string;
  total: number;
  nextOffset: number;
  imported: number;
  skipped: number;
  done: boolean;
}

const NATIVE_IMPORT_CONFIGS = {
  hermes: {
    endpoint: "/api/v1/import/hermes-native",
    keys: {
      title: "import.hermes.title",
      desc: "import.hermes.desc",
      scan: "import.hermes.scan",
      run: "import.hermes.run",
      stop: "import.hermes.stop",
      running: "import.hermes.running",
      stopping: "import.hermes.stopping",
      found: "import.hermes.found",
      notFoundAt: "import.hermes.notFoundAt",
      progress: "import.hermes.progress",
      done: "import.hermes.done",
      stopped: "import.hermes.stopped",
    },
  },
  openclaw: {
    endpoint: "/api/v1/import/openclaw-native",
    keys: {
      title: "import.openclaw.title",
      desc: "import.openclaw.desc",
      scan: "import.openclaw.scan",
      run: "import.openclaw.run",
      stop: "import.openclaw.stop",
      running: "import.openclaw.running",
      stopping: "import.openclaw.stopping",
      found: "import.openclaw.found",
      notFoundAt: "import.openclaw.notFoundAt",
      progress: "import.openclaw.progress",
      done: "import.openclaw.done",
      stopped: "import.openclaw.stopped",
    },
  },
} as const;

export function ImportView() {
  return (
    <>
      <div class="view-header">
        <div class="view-header__title">
          <h1>{t("import.title")}</h1>
          <p>{t("import.subtitle")}</p>
        </div>
      </div>

      <div class="vstack" style="gap:var(--sp-4)">
        <ExportCard />
        <ImportCard />
        {health.value?.agent === "hermes" && <NativeImportCard kind="hermes" />}
        {health.value?.agent === "openclaw" && <NativeImportCard kind="openclaw" />}
        <MigrateCard />
      </div>
    </>
  );
}

function ExportCard() {
  const [busy, setBusy] = useState(false);

  const run = async () => {
    setBusy(true);
    try {
      const blob = await api.blob("/api/v1/export");
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      const ts = new Date().toISOString().slice(0, 10);
      a.href = url;
      a.download = `memos-export-${ts}.json`;
      a.click();
      URL.revokeObjectURL(url);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section class="card">
      <div class="card__header">
        <div class="hstack">
          <span
            aria-hidden="true"
            style="width:36px;height:36px;display:flex;align-items:center;justify-content:center;border-radius:var(--radius-md);background:var(--accent-soft);color:var(--accent)"
          >
            <Icon name="download" size={18} />
          </span>
          <div>
            <h3 class="card__title" style="margin:0">
              {t("import.export.title")}
            </h3>
            <p class="card__subtitle" style="margin:0">
              {t("import.export.desc")}
            </p>
          </div>
        </div>
      </div>
      <button class="btn btn--primary" onClick={run} disabled={busy}>
        {busy ? <Icon name="loader-2" size={14} class="spin" /> : <Icon name="download" size={14} />}
        {t("import.export.btn")}
      </button>
    </section>
  );
}

function ImportCard() {
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<{
    kind: "ok" | "error";
    text: string;
  } | null>(null);

  const run = async (file: File) => {
    setBusy(true);
    setStatus(null);
    try {
      const form = new FormData();
      form.append("bundle", file);
      const r = await api.postRaw<{ imported: number; skipped: number }>(
        "/api/v1/import",
        form,
      );
      setStatus({
        kind: "ok",
        text: `Imported ${r.imported} / skipped ${r.skipped}`,
      });
    } catch (err) {
      setStatus({ kind: "error", text: (err as Error).message });
    } finally {
      setBusy(false);
    }
  };

  return (
    <section class="card">
      <div class="card__header">
        <div class="hstack">
          <span
            aria-hidden="true"
            style="width:36px;height:36px;display:flex;align-items:center;justify-content:center;border-radius:var(--radius-md);background:var(--info-soft);color:var(--info)"
          >
            <Icon name="upload" size={18} />
          </span>
          <div>
            <h3 class="card__title" style="margin:0">
              {t("import.import.title")}
            </h3>
            <p class="card__subtitle" style="margin:0">
              {t("import.import.desc")}
            </p>
          </div>
        </div>
      </div>
      <label class="btn">
        <Icon name="upload" size={14} />
        {t("import.import.btn")}
        <input
          type="file"
          accept="application/json,.json"
          hidden
          onChange={(e) => {
            const f = (e.target as HTMLInputElement).files?.[0];
            if (f) void run(f);
          }}
          disabled={busy}
        />
      </label>
      {status && (
        <div
          role="status"
          style={`margin-top:var(--sp-3);font-size:var(--fs-sm);color:${
            status.kind === "ok" ? "var(--success)" : "var(--danger)"
          }`}
        >
          {status.text}
        </div>
      )}
    </section>
  );
}

function NativeImportCard({ kind }: { kind: NativeImportKind }) {
  const cfg = NATIVE_IMPORT_CONFIGS[kind];
  const [scanning, setScanning] = useState(false);
  const [scan, setScan] = useState<NativeImportScan | null>(null);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState({
    imported: 0,
    skipped: 0,
    offset: 0,
    total: 0,
  });
  const [status, setStatus] = useState<{
    kind: "ok" | "error" | "muted";
    text: string;
  } | null>(null);
  const stopRef = useRef(false);

  const doScan = async () => {
    setScanning(true);
    setStatus(null);
    try {
      const r = await api.get<NativeImportScan>(`${cfg.endpoint}/scan`);
      setScan(r);
      setProgress((p) => ({ ...p, total: r.total }));
      if (!r.found) {
        setStatus({
          kind: "error",
          text: r.error || t(cfg.keys.notFoundAt, { path: r.path }),
        });
      }
    } catch (err) {
      setStatus({ kind: "error", text: (err as Error).message });
    } finally {
      setScanning(false);
    }
  };

  useEffect(() => {
    void doScan();
  }, []);

  const run = async () => {
    const knownScan = scan?.found ? scan : await api.get<NativeImportScan>(`${cfg.endpoint}/scan`);
    setScan(knownScan);
    if (!knownScan.found || knownScan.total <= 0) {
      setStatus({
        kind: "error",
        text: knownScan.error || t(cfg.keys.notFoundAt, { path: knownScan.path }),
      });
      return;
    }

    setRunning(true);
    stopRef.current = false;
    setStatus({ kind: "muted", text: t(cfg.keys.running) });
    setProgress({ imported: 0, skipped: 0, offset: 0, total: knownScan.total });

    let offset = 0;
    let imported = 0;
    let skipped = 0;
    try {
      while (offset < knownScan.total && !stopRef.current) {
        const r = await api.post<NativeImportBatchResult>(
          `${cfg.endpoint}/run`,
          { offset, limit: 25 },
        );
        imported += r.imported;
        skipped += r.skipped;
        offset = r.nextOffset;
        setProgress({ imported, skipped, offset, total: r.total });
        if (r.done) break;
      }
      setStatus({
        kind: stopRef.current ? "muted" : "ok",
        text: stopRef.current
          ? t(cfg.keys.stopped, { imported, skipped })
          : t(cfg.keys.done, { imported, skipped }),
      });
    } catch (err) {
      setStatus({ kind: "error", text: (err as Error).message });
    } finally {
      setRunning(false);
    }
  };

  const stop = () => {
    stopRef.current = true;
    setStatus({ kind: "muted", text: t(cfg.keys.stopping) });
  };

  const percent = progress.total > 0
    ? Math.min(100, Math.round((progress.offset / progress.total) * 100))
    : 0;

  return (
    <section class="card">
      <div class="card__header">
        <div class="hstack">
          <span
            aria-hidden="true"
            style="width:36px;height:36px;display:flex;align-items:center;justify-content:center;border-radius:var(--radius-md);background:var(--accent-soft);color:var(--accent)"
          >
            <Icon name="database" size={18} />
          </span>
          <div>
            <h3 class="card__title" style="margin:0">
              {t(cfg.keys.title)}
            </h3>
            <p class="card__subtitle" style="margin:0">
              {t(cfg.keys.desc)}
            </p>
          </div>
        </div>
      </div>

      <div class="hstack" style="gap:var(--sp-2);flex-wrap:wrap">
        <button class="btn" onClick={doScan} disabled={scanning || running}>
          {scanning ? <Icon name="loader-2" size={14} class="spin" /> : <Icon name="search" size={14} />}
          {t(cfg.keys.scan)}
        </button>
        <button
          class="btn btn--primary"
          onClick={run}
          disabled={running || scanning || !scan?.found || scan.total <= 0}
        >
          {running ? <Icon name="loader-2" size={14} class="spin" /> : <Icon name="upload" size={14} />}
          {t(cfg.keys.run)}
        </button>
        <button class="btn btn--danger" onClick={stop} disabled={!running}>
          {t(cfg.keys.stop)}
        </button>
      </div>

      {scan && (
        scan.found ? (
          <NativeImportScanResult kind={kind} scan={scan} foundText={t(cfg.keys.found, {
            path: scan.path,
            total: scan.total,
            files: scan.files ?? 0,
            sessions: scan.sessions ?? 0,
          })} />
        ) : (
          <div class="muted" style="margin-top:var(--sp-3);font-size:var(--fs-sm)">
            {t(cfg.keys.notFoundAt, { path: scan.path })}
          </div>
        )
      )}

      {(running || progress.total > 0) && (
        <div class="native-import-progress">
          <div class="native-import-progress__head">
            <div class="native-import-progress__phase">
              {running ? t(cfg.keys.running) : t(cfg.keys.done, {
                imported: progress.imported,
                skipped: progress.skipped,
              })}
            </div>
            <div class="native-import-progress__counter">
              {progress.offset} / {progress.total} · {percent}%
            </div>
          </div>
          <div class="native-import-progress__bar" role="progressbar" aria-valuemin={0} aria-valuemax={Math.max(1, progress.total)} aria-valuenow={progress.offset}>
            <div class="native-import-progress__fill" style={`width:${percent}%`} />
          </div>
          <div class="native-import-progress__stats">
            <NativeImportStat color="success" label={t("import.native.stat.imported")} value={progress.imported} />
            <NativeImportStat color="warning" label={t("import.native.stat.skipped")} value={progress.skipped} />
            <NativeImportStat color="info" label={t("import.native.stat.processed")} value={progress.offset} />
          </div>
        </div>
      )}

      {status && (
        <div
          role="status"
          style={`margin-top:var(--sp-2);font-size:var(--fs-sm);color:${
            status.kind === "ok"
              ? "var(--success)"
              : status.kind === "error"
                ? "var(--danger)"
                : "var(--fg-muted)"
          }`}
        >
          {status.text}
        </div>
      )}
    </section>
  );
}

function NativeImportScanResult({
  kind,
  scan,
  foundText,
}: {
  kind: NativeImportKind;
  scan: NativeImportScan;
  foundText: string;
}) {
  return (
    <div class="native-import-scan" role="status">
      <div class="native-import-scan__grid">
        <NativeImportMetric
          label={t("import.native.metric.items")}
          value={scan.total}
          hint={kind === "openclaw" ? t("import.native.metric.messages") : t("import.native.metric.memories")}
        />
        <NativeImportMetric
          label={kind === "openclaw" ? t("import.native.metric.sessions") : t("import.native.metric.file")}
          value={kind === "openclaw" ? scan.sessions ?? 0 : 1}
          hint={kind === "openclaw" ? t("import.native.metric.jsonl") : t("import.native.metric.memoryMd")}
        />
      </div>
      <div class="native-import-scan__path">{foundText}</div>
    </div>
  );
}

function NativeImportMetric({
  label,
  value,
  hint,
}: {
  label: string;
  value: number;
  hint: string;
}) {
  return (
    <div class="native-import-metric">
      <div class="native-import-metric__label">{label}</div>
      <div class="native-import-metric__value">{value}</div>
      <div class="native-import-metric__hint">{hint}</div>
    </div>
  );
}

function NativeImportStat({
  color,
  label,
  value,
}: {
  color: "success" | "warning" | "info";
  label: string;
  value: number;
}) {
  return (
    <div class="native-import-stat">
      <span class={`native-import-stat__dot native-import-stat__dot--${color}`} />
      <span class="native-import-stat__label">{label}</span>
      <span class="native-import-stat__value">{value}</span>
    </div>
  );
}

function MigrateCard() {
  const [scanning, setScanning] = useState(false);
  const [scan, setScan] = useState<{
    found: boolean;
    agent?: "openclaw" | "hermes";
    candidates?: { traces: number; skills: number; tasks: number };
    path?: string;
  } | null>(null);
  const [migrating, setMigrating] = useState(false);
  const [result, setResult] = useState<string | null>(null);

  const doScan = async () => {
    setScanning(true);
    setResult(null);
    try {
      const r = await api.get<typeof scan>("/api/v1/migrate/legacy/scan");
      setScan(r);
    } catch {
      setScan({ found: false });
    } finally {
      setScanning(false);
    }
  };

  const doMigrate = async () => {
    setMigrating(true);
    try {
      const r = await api.post<{
        imported: { traces: number; skills: number; tasks: number };
      }>("/api/v1/migrate/legacy/run", {});
      setResult(
        `Imported ${r.imported.traces} traces, ${r.imported.skills} skills, ${r.imported.tasks} tasks.`,
      );
    } catch (err) {
      setResult((err as Error).message);
    } finally {
      setMigrating(false);
    }
  };

  return (
    <section class="card">
      <div class="card__header">
        <div class="hstack">
          <span
            aria-hidden="true"
            style="width:36px;height:36px;display:flex;align-items:center;justify-content:center;border-radius:var(--radius-md);background:var(--warning-soft);color:var(--warning)"
          >
            <Icon name="history" size={18} />
          </span>
          <div>
            <h3 class="card__title" style="margin:0">
              {t("import.migrate.title")}
            </h3>
            <p class="card__subtitle" style="margin:0">
              {t("import.migrate.desc")}
            </p>
          </div>
        </div>
      </div>
      <div class="hstack" style="gap:var(--sp-2);flex-wrap:wrap">
        <button class="btn" onClick={doScan} disabled={scanning}>
          {scanning ? <Icon name="loader-2" size={14} class="spin" /> : <Icon name="search" size={14} />}
          {t("import.migrate.scan")}
        </button>
        <button
          class="btn btn--primary"
          onClick={doMigrate}
          disabled={migrating || !scan?.found}
        >
          {migrating ? <Icon name="loader-2" size={14} class="spin" /> : <Icon name="arrow-up-right" size={14} />}
          {t("import.migrate.run")}
        </button>
      </div>
      {scan && (
        <div class="muted" style="margin-top:var(--sp-3);font-size:var(--fs-sm)">
          {scan.found
            ? t("import.migrate.found", {
                agent: scan.agent ?? "",
                path: scan.path ?? "",
                traces: scan.candidates?.traces ?? 0,
                skills: scan.candidates?.skills ?? 0,
                tasks: scan.candidates?.tasks ?? 0,
              })
            : scan.path
              ? t("import.migrate.notFoundAt", { path: scan.path })
              : t("import.migrate.notFound")}
        </div>
      )}
      {result && (
        <div style="margin-top:var(--sp-2);font-size:var(--fs-sm);color:var(--success)">
          {result}
        </div>
      )}
    </section>
  );
}
