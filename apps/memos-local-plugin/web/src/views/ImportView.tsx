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
 */
import { useState } from "preact/hooks";
import { api } from "../api/client";
import { t } from "../stores/i18n";
import { Icon } from "../components/Icon";

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
            ? `Found legacy ${scan.agent ?? ""} DB at ${scan.path}. Candidates — traces: ${scan.candidates?.traces ?? 0}, skills: ${scan.candidates?.skills ?? 0}, tasks: ${scan.candidates?.tasks ?? 0}.`
            : `No legacy database found${scan.path ? ` at ${scan.path}` : ""}.`}
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
