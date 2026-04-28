/**
 * Settings view — four tabs:
 *
 *   - AI Models   — embedding / summarizer / **skill evolver** slots,
 *                   each with a "测试" button that calls
 *                   `POST /api/v1/models/test`.
 *   - Team Sharing — hub on/off + address + tokens.
 *   - Account     — optional password protection for the viewer.
 *   - General     — theme + language + telemetry.
 *
 * Save flow: `PATCH /api/v1/config` → show restart overlay → call
 * `POST /api/v1/admin/restart` → poll `GET /api/v1/health` until the
 * server is back → reload the page.
 */
import { useEffect, useState } from "preact/hooks";
import { api } from "../api/client";
import { t, locale, setLocale } from "../stores/i18n";
import { theme, setTheme } from "../stores/theme";
import { Icon } from "../components/Icon";
import { HubAdminPanel } from "../components/HubAdminPanel";
import { triggerRestart, triggerCleared } from "../stores/restart";

type Tab = "models" | "hub" | "general";

interface ProviderBlock {
  provider?: string;
  endpoint?: string;
  model?: string;
  apiKey?: string;
  temperature?: number;
}

interface ResolvedConfig {
  version?: number;
  viewer?: { port: number; bindHost?: string };
  embedding?: ProviderBlock & { dimensions?: number };
  llm?: ProviderBlock;
  skillEvolver?: ProviderBlock;
  algorithm?: unknown;
  hub?: {
    enabled?: boolean;
    role?: "hub" | "client";
    address?: string;
    port?: number;
    teamToken?: string;
    userToken?: string;
  };
  telemetry?: { enabled?: boolean };
  logging?: { level?: string };
}

const EMBEDDING_PROVIDERS = [
  "local",
  "openai_compatible",
  "gemini",
  "cohere",
  "voyage",
  "mistral",
];

const LLM_PROVIDERS = [
  "local_only",
  "openai_compatible",
  "anthropic",
  "gemini",
  "bedrock",
  "host",
];

const SKILL_PROVIDERS = [
  "", // inherit from llm
  "openai_compatible",
  "anthropic",
  "gemini",
  "bedrock",
];

export function SettingsView({ initialTab }: { initialTab?: Tab } = {}) {
  const [tab, setTab] = useState<Tab>(initialTab ?? "models");
  const [config, setConfig] = useState<ResolvedConfig | null>(null);
  const [dirty, setDirty] = useState<Partial<ResolvedConfig>>({});
  const [saving, setSaving] = useState<"idle" | "saving">("idle");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const ctrl = new AbortController();
    api
      .get<ResolvedConfig>("/api/v1/config", { signal: ctrl.signal })
      .then(setConfig)
      .catch(() => setConfig({}));
    return () => ctrl.abort();
  }, []);

  const patch = <K extends keyof ResolvedConfig>(
    key: K,
    partial: Partial<NonNullable<ResolvedConfig[K]>>,
  ) => {
    setDirty((prev) => {
      const existing = (prev[key] as Record<string, unknown>) ?? {};
      return { ...prev, [key]: { ...existing, ...partial } };
    });
  };

  const save = async () => {
    if (Object.keys(dirty).length === 0) return;
    setSaving("saving");
    setError(null);
    try {
      await api.patch<ResolvedConfig>("/api/v1/config", dirty);
      setDirty({});
      await triggerRestart();
      // For Hermes/generic the page stays; reset the button state.
      setSaving("idle");
    } catch (err) {
      setError((err as Error).message);
      setSaving("idle");
    }
  };

  // Merge the saved config (`config[key]`) with any unsaved edits
  // (`dirty[key]`). Previously this returned whichever side was set,
  // which meant editing a single field (e.g. `model`) hid all other
  // saved fields (`provider`, `endpoint`, `apiKey`) from the card —
  // users were forced to re-enter them. Deep merge preserves saved
  // fields unless explicitly overwritten by the current edit session.
  const get = <K extends keyof ResolvedConfig>(
    key: K,
  ): ResolvedConfig[K] => {
    const base = config?.[key];
    const patchVal = dirty[key];
    if (base === undefined || base === null) return patchVal as ResolvedConfig[K];
    if (patchVal === undefined || patchVal === null) return base;
    if (typeof base === "object" && typeof patchVal === "object") {
      return { ...base, ...(patchVal as object) } as ResolvedConfig[K];
    }
    return patchVal as ResolvedConfig[K];
  };

  return (
    <>
      <div class="view-header">
        <div class="view-header__title">
          <h1>{t("settings.title")}</h1>
        </div>
        <div class="view-header__actions">
          {Object.keys(dirty).length > 0 && (
            <>
              <button
                class="btn btn--ghost btn--sm"
                onClick={() => setDirty({})}
                disabled={saving === "saving"}
              >
                {t("common.reset")}
              </button>
              <button
                class="btn btn--primary btn--sm"
                onClick={save}
                disabled={saving === "saving"}
              >
                <Icon name="check" size={14} />
                {t("settings.saveAndRestart")}
              </button>
            </>
          )}
        </div>
      </div>

      {error && (
        <div class="card" role="alert" style="border-color:var(--danger);margin-bottom:var(--sp-4)">
          <div class="hstack">
            <Icon name="circle-alert" size={16} />
            <span>{error}</span>
          </div>
        </div>
      )}

      <div class="segmented" style="margin-bottom:var(--sp-6)">
        {[
          { v: "models" as Tab, k: "settings.tab.models" as const, icon: "cpu" as const },
          { v: "hub" as Tab, k: "settings.tab.hub" as const, icon: "users" as const },
          { v: "general" as Tab, k: "settings.tab.general" as const, icon: "settings-2" as const },
        ].map((o) => (
          <button
            key={o.v}
            class="segmented__item"
            aria-pressed={tab === o.v}
            onClick={() => setTab(o.v)}
          >
            <Icon name={o.icon} size={14} />
            {t(o.k)}
          </button>
        ))}
      </div>

      {tab === "models" && (
        <ModelsTab
          embedding={(get("embedding") ?? {}) as ProviderBlock}
          llm={(get("llm") ?? {}) as ProviderBlock}
          skillEvolver={(get("skillEvolver") ?? {}) as ProviderBlock}
          onPatchEmbedding={(p) => patch("embedding", p)}
          onPatchLlm={(p) => patch("llm", p)}
          onPatchSkillEvolver={(p) => patch("skillEvolver", p)}
        />
      )}

      {tab === "hub" && (
        <HubTab
          hub={(get("hub") ?? {}) as NonNullable<ResolvedConfig["hub"]>}
          onPatch={(p) => patch("hub", p)}
        />
      )}

      {tab === "general" && (
        <GeneralTab
          telemetry={(get("telemetry") ?? {}) as NonNullable<ResolvedConfig["telemetry"]>}
          onPatchTelemetry={(p) => patch("telemetry", p)}
        />
      )}
    </>
  );
}

// ─── AI Models tab ───────────────────────────────────────────────────────

function ModelsTab({
  embedding,
  llm,
  skillEvolver,
  onPatchEmbedding,
  onPatchLlm,
  onPatchSkillEvolver,
}: {
  embedding: ProviderBlock & { dimensions?: number };
  llm: ProviderBlock;
  skillEvolver: ProviderBlock;
  onPatchEmbedding: (p: Partial<ProviderBlock & { dimensions?: number }>) => void;
  onPatchLlm: (p: Partial<ProviderBlock>) => void;
  onPatchSkillEvolver: (p: Partial<ProviderBlock>) => void;
}) {
  return (
    <div class="vstack" style="gap:var(--sp-5)">
      <section
        class="card card--flat"
        style="border-left:3px solid var(--accent)"
      >
        <div class="hstack" style="gap:var(--sp-2);align-items:flex-start">
          <Icon name="info" size={14} style="margin-top:3px;flex-shrink:0;color:var(--accent)" />
          <div>
            <h3
              class="card__title"
              style="font-size:var(--fs-md);margin:0 0 var(--sp-2) 0"
            >
              {t("settings.model.tip.title")}
            </h3>
            <ul style="margin:0;padding-left:18px;font-size:var(--fs-sm);line-height:1.7;color:var(--fg)">
              <li>{t("settings.model.tip.embedding")}</li>
              <li>{t("settings.model.tip.summarizer")}</li>
              <li>{t("settings.model.tip.skillEvolver")}</li>
            </ul>
          </div>
        </div>
      </section>

      <ModelCard
        icon="plug"
        title={t("settings.embedding.title")}
        desc={t("settings.embedding.desc")}
        block={embedding}
        providers={EMBEDDING_PROVIDERS}
        type="embedding"
        extra={
          <Field label="Dimensions">
            <input
              class="input"
              type="number"
              value={embedding.dimensions ?? ""}
              onInput={(e) =>
                onPatchEmbedding({
                  dimensions: Number((e.target as HTMLInputElement).value) || undefined,
                })
              }
            />
          </Field>
        }
        onPatch={onPatchEmbedding}
      />

      <ModelCard
        icon="sparkles"
        title={t("settings.summarizer.title")}
        desc={t("settings.summarizer.desc")}
        block={llm}
        providers={LLM_PROVIDERS}
        withTemperature
        type="summarizer"
        onPatch={onPatchLlm}
      />

      <ModelCard
        icon="wand-sparkles"
        title={t("settings.skillEvolver.title")}
        desc={t("settings.skillEvolver.desc")}
        block={skillEvolver}
        providers={SKILL_PROVIDERS}
        withTemperature
        type="skillEvolver"
        inheritsLabel={t("settings.skillEvolver.inherit")}
        onPatch={onPatchSkillEvolver}
      />
    </div>
  );
}

// ─── Model card with test button ─────────────────────────────────────────

function ModelCard({
  icon,
  title,
  desc,
  block,
  providers,
  type,
  extra,
  withTemperature,
  inheritsLabel,
  onPatch,
}: {
  icon: "plug" | "sparkles" | "wand-sparkles";
  title: string;
  desc: string;
  block: ProviderBlock;
  providers: string[];
  type: "embedding" | "summarizer" | "skillEvolver";
  extra?: preact.ComponentChildren;
  withTemperature?: boolean;
  inheritsLabel?: string;
  onPatch: (p: Partial<ProviderBlock>) => void;
}) {
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<
    | { ok: true; latencyMs: number; dimensions?: number; responseChars?: number }
    | { ok: false; error: string }
    | null
  >(null);

  // `block.apiKey` from the server comes back masked as "••••". If we
  // echo that back in the request body it ends up in an HTTP header
  // server-side, and fetch() throws "Cannot convert argument to a
  // ByteString because the character at index 7 has a value of 8226"
  // (U+2022 • bullet) — exactly the crash the user hit after save+reload.
  //
  // The contract is: an empty / all-mask string means "keep using the
  // value already saved on disk"; anything else is a fresh key. The
  // backend /models/test route honours the same convention. We
  // recognise BOTH the historical `••••` mask and the ASCII-safe
  // `__memos_secret__` sentinel that replaced it — either means
  // "user hasn't re-entered the key, ignore it".
  const API_KEY_MASKED = (s: string | undefined | null): boolean =>
    !!s && (s === "__memos_secret__" || /^[\s•]+$/.test(s));
  const sanitizeApiKey = (s: string | undefined | null): string =>
    API_KEY_MASKED(s) ? "" : s ?? "";

  const runTest = async () => {
    setTesting(true);
    setResult(null);
    try {
      const r = await api.post<typeof result>(`/api/v1/models/test`, {
        type,
        provider: block.provider,
        endpoint: block.endpoint,
        model: block.model,
        apiKey: sanitizeApiKey(block.apiKey),
      });
      setResult(r);
    } catch (err) {
      setResult({ ok: false, error: (err as Error).message });
    } finally {
      setTesting(false);
    }
  };

  const inherits = type === "skillEvolver" && !block.provider;

  return (
    <section class="card">
      <div class="card__header">
        <div class="hstack">
          <span
            aria-hidden="true"
            style="width:32px;height:32px;display:flex;align-items:center;justify-content:center;border-radius:var(--radius-md);background:var(--accent-soft);color:var(--accent)"
          >
            <Icon name={icon} size={16} />
          </span>
          <div>
            <h3 class="card__title" style="margin:0">{title}</h3>
            <p class="card__subtitle" style="margin:0">{desc}</p>
          </div>
        </div>
        <button
          class="btn btn--sm"
          onClick={runTest}
          disabled={testing || inherits}
          title={inherits ? inheritsLabel : undefined}
        >
          <Icon name={testing ? "loader-2" : "plug"} size={14} class={testing ? "spin" : ""} />
          {testing ? t("common.loading") : t("settings.test")}
        </button>
      </div>

      {inherits && (
        <div
          style="font-size:var(--fs-xs);color:var(--fg-muted);margin-bottom:var(--sp-3);padding:var(--sp-2) var(--sp-3);background:var(--bg-canvas);border-radius:var(--radius-sm);border:1px dashed var(--border)"
        >
          {inheritsLabel}
        </div>
      )}

      <div
        style="display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:var(--sp-4)"
      >
        <Field label={t("settings.provider")}>
          <select
            class="select"
            value={block.provider ?? providers[0]}
            onChange={(e) =>
              onPatch({ provider: (e.target as HTMLSelectElement).value })
            }
          >
            {providers.map((p) => (
              <option key={p} value={p}>
                {p || "(inherit)"}
              </option>
            ))}
          </select>
        </Field>
        <Field label={t("settings.model")}>
          <input
            class="input"
            type="text"
            value={block.model ?? ""}
            placeholder="e.g. gpt-4o-mini"
            onInput={(e) => onPatch({ model: (e.target as HTMLInputElement).value })}
          />
        </Field>
        <Field label={t("settings.endpoint")}>
          <input
            class="input"
            type="url"
            value={block.endpoint ?? ""}
            placeholder="https://api.openai.com/v1"
            onInput={(e) => onPatch({ endpoint: (e.target as HTMLInputElement).value })}
          />
        </Field>
        <Field label={t("settings.apiKey")}>
          <input
            class="input"
            type="password"
            // Don't echo the masked "••••" back into the input — it
            // would ship bullet chars to /models/test and crash fetch
            // with "Cannot convert argument to a ByteString" (the
            // legacy viewer had the same bug until its 3.x rewrite).
            // Empty input = "keep the saved key"; the placeholder
            // makes that state legible.
            value={API_KEY_MASKED(block.apiKey) ? "" : block.apiKey ?? ""}
            placeholder={
              API_KEY_MASKED(block.apiKey) ? t("settings.apiKey.saved") : "sk-…"
            }
            onInput={(e) => onPatch({ apiKey: (e.target as HTMLInputElement).value })}
          />
        </Field>
        {withTemperature && (
          <Field label={t("settings.temperature")}>
            <input
              class="input"
              type="number"
              step={0.1}
              min={0}
              max={2}
              value={block.temperature ?? 0}
              onInput={(e) =>
                onPatch({
                  temperature: Number((e.target as HTMLInputElement).value) || 0,
                })
              }
            />
          </Field>
        )}
        {extra}
      </div>

      {result && (
        <div
          class="hstack"
          style={`margin-top:var(--sp-3);padding:var(--sp-2) var(--sp-3);border-radius:var(--radius-sm);background:${
            result.ok ? "var(--success-soft)" : "var(--danger-soft)"
          };color:${result.ok ? "var(--success)" : "var(--danger)"}`}
        >
          <Icon name={result.ok ? "check" : "circle-alert"} size={14} />
          {result.ok ? (
            <>
              <span style="font-weight:var(--fw-semi)">
                {t("settings.test.ok")}
              </span>
              <span class="muted" style="font-size:var(--fs-xs)">
                {result.latencyMs}ms
                {result.dimensions != null ? ` · dim ${result.dimensions}` : ""}
                {result.responseChars != null ? ` · ${result.responseChars} chars` : ""}
              </span>
            </>
          ) : (
            <span style="font-weight:var(--fw-semi)">{result.error}</span>
          )}
        </div>
      )}
    </section>
  );
}

// ─── Hub tab ─────────────────────────────────────────────────────────────

function HubTab({
  hub,
  onPatch,
}: {
  hub: NonNullable<ResolvedConfig["hub"]>;
  onPatch: (p: Partial<NonNullable<ResolvedConfig["hub"]>>) => void;
}) {
  return (
    <div class="card">
      <div class="hstack" style="justify-content:space-between;margin-bottom:var(--sp-4)">
        <div>
          <h3 class="card__title">{t("settings.hub.enabled")}</h3>
          <p class="card__subtitle">
            {t("settings.hub.subtitle")}
          </p>
        </div>
        <ToggleSwitch
          checked={!!hub.enabled}
          onChange={(v) => onPatch({ enabled: v })}
        />
      </div>

      {hub.enabled && (
        <div
          style="display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:var(--sp-4)"
        >
          <Field label={t("settings.hub.role")}>
            <div class="segmented">
              {(["hub", "client"] as const).map((r) => (
                <button
                  key={r}
                  class="segmented__item"
                  aria-pressed={hub.role === r}
                  onClick={() => onPatch({ role: r })}
                >
                  {t(`settings.hub.role.${r}` as "settings.hub.role.hub")}
                </button>
              ))}
            </div>
          </Field>

          {hub.role === "client" && (
            <Field label={t("settings.hub.address")}>
              <input
                class="input"
                type="url"
                value={hub.address ?? ""}
                placeholder="http://10.0.0.12:18912"
                onInput={(e) =>
                  onPatch({ address: (e.target as HTMLInputElement).value })
                }
              />
            </Field>
          )}

          <Field label={t("settings.hub.teamToken")}>
            <input
              class="input"
              type="password"
              value={hub.teamToken ?? ""}
              onInput={(e) =>
                onPatch({ teamToken: (e.target as HTMLInputElement).value })
              }
            />
          </Field>

          <Field label={t("settings.hub.userToken")}>
            <input
              class="input"
              type="password"
              value={hub.userToken ?? ""}
              onInput={(e) =>
                onPatch({ userToken: (e.target as HTMLInputElement).value })
              }
            />
          </Field>
        </div>
      )}

      {/*
       * Admin (members / groups / pending approvals) folded inline.
       * Previously exposed as a separate sidebar tab — users found
       * that duplicative with this section. We only render it when
       * hub is actually enabled; otherwise there's nothing to admin.
       */}
      {hub.enabled && (
        <div style="margin-top:var(--sp-5);padding-top:var(--sp-4);border-top:1px solid var(--border)">
          <h4
            class="card__title"
            style="font-size:var(--fs-md);margin-bottom:var(--sp-3)"
          >
            {t("settings.hub.admin")}
          </h4>
          <HubAdminPanel />
        </div>
      )}
    </div>
  );
}

// ─── Account / password tab ──────────────────────────────────────────────

// ─── General tab (merged Account + General) ─────────────────────────

function GeneralTab({
  telemetry,
  onPatchTelemetry,
}: {
  telemetry: NonNullable<ResolvedConfig["telemetry"]>;
  onPatchTelemetry: (
    p: Partial<NonNullable<ResolvedConfig["telemetry"]>>,
  ) => void;
}) {
  return (
    <div class="vstack" style="gap:var(--sp-4)">
      <section class="card">
        <div class="card__header" style="margin-bottom:var(--sp-3)">
          <h3 class="card__title">{t("settings.general.lang")}</h3>
        </div>
        <div class="segmented">
          <button
            class="segmented__item"
            aria-pressed={locale.value === "en"}
            onClick={() => setLocale("en")}
          >
            English
          </button>
          <button
            class="segmented__item"
            aria-pressed={locale.value === "zh"}
            onClick={() => setLocale("zh")}
          >
            中文
          </button>
        </div>
      </section>

      <section class="card">
        <div class="card__header" style="margin-bottom:var(--sp-3)">
          <h3 class="card__title">{t("settings.general.theme")}</h3>
        </div>
        <div class="segmented">
          {[
            { v: "auto" as const, k: "settings.general.theme.auto" as const, icon: "monitor" as const },
            { v: "light" as const, k: "settings.general.theme.light" as const, icon: "sun" as const },
            { v: "dark" as const, k: "settings.general.theme.dark" as const, icon: "moon" as const },
          ].map((opt) => (
            <button
              key={opt.v}
              class="segmented__item"
              aria-pressed={theme.value === opt.v}
              onClick={() => setTheme(opt.v)}
            >
              <Icon name={opt.icon} size={14} />
              {t(opt.k)}
            </button>
          ))}
        </div>
      </section>

      <AccountSection />

      <section class="card">
        <div class="hstack" style="justify-content:space-between;margin-bottom:var(--sp-2)">
          <div>
            <h3 class="card__title">{t("settings.general.telemetry")}</h3>
            <p class="card__subtitle">{t("settings.general.telemetry.desc")}</p>
          </div>
          <ToggleSwitch
            checked={!!telemetry.enabled}
            onChange={(v) => onPatchTelemetry({ enabled: v })}
          />
        </div>
      </section>

      <DangerZoneSection />
    </div>
  );
}

function AccountSection() {
  // Password protection is one-way (can't be disabled from settings —
  // only reset back to the initial setup screen). This section offers
  // two actions: "Logout" (keeps password, clears session) and
  // "Reset password" (deletes `.auth.json` then logs out, so the next
  // visit lands on the setup screen).
  const [status, setStatus] = useState<{ enabled: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmingReset, setConfirmingReset] = useState(false);

  useEffect(() => {
    api
      .get<{ enabled: boolean }>("/api/v1/auth/status")
      .then(setStatus)
      .catch(() => setStatus({ enabled: false }));
  }, []);

  const logout = async () => {
    setBusy(true);
    try { await api.post("/api/v1/auth/logout", {}); location.reload(); }
    finally { setBusy(false); }
  };

  const resetPassword = async () => {
    setBusy(true);
    try {
      await api.post("/api/v1/auth/reset", {});
      location.reload();
    } catch {
      setBusy(false);
      setConfirmingReset(false);
    }
  };

  if (!status?.enabled) return null;

  return (
    <>
      <section class="card">
        <div class="card__header">
          <div>
            <h3 class="card__title">{t("settings.account.protection")}</h3>
          </div>
        </div>
        {/*
         * Action order: reset-password on the LEFT (the routine
         * operator action), logout on the RIGHT (the terminal /
         * destructive one — visually anchored where the "primary
         * decisive" slot is). Mirrors the placement users expect from
         * Gmail-style "change password | sign out" rows.
         */}
        <div class="hstack" style="gap:var(--sp-3)">
          <button
            class="btn btn--ghost btn--sm"
            onClick={() => setConfirmingReset(true)}
            disabled={busy}
          >
            <Icon name="key-round" size={14} />
            {t("settings.account.resetPassword")}
          </button>
          <button class="btn btn--danger btn--sm" onClick={logout} disabled={busy}>
            <Icon name={busy ? "loader-2" : "log-out"} size={14} class={busy ? "spin" : ""} />
            {t("settings.account.logout")}
          </button>
        </div>
      </section>

      {confirmingReset && (
        <div
          class="modal-backdrop"
          onClick={() => { if (!busy) setConfirmingReset(false); }}
        >
          <div
            class="modal"
            role="dialog"
            aria-modal="true"
            onClick={(e) => e.stopPropagation()}
          >
            <div class="modal__header">
              <div class="hstack" style="gap:var(--sp-2);align-items:center">
                <Icon name="key-round" size={18} style="color:var(--accent)" />
                <h3 class="modal__title" style="margin:0">
                  {t("settings.account.resetPassword")}
                </h3>
              </div>
            </div>
            <div class="modal__body">
              <p style="margin:0;font-size:var(--fs-sm);line-height:1.6">
                {t("settings.account.resetConfirm")}
              </p>
            </div>
            <div class="modal__footer">
              <button
                class="btn btn--ghost btn--sm"
                onClick={() => setConfirmingReset(false)}
                disabled={busy}
              >
                {t("common.cancel")}
              </button>
              <button
                class="btn btn--danger btn--sm"
                onClick={resetPassword}
                disabled={busy}
              >
                <Icon
                  name={busy ? "loader-2" : "refresh-cw"}
                  size={14}
                  class={busy ? "spin" : ""}
                />
                {t("settings.account.resetConfirmBtn")}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

function DangerZoneSection() {
  const [confirming, setConfirming] = useState(false);
  const [clearing, setClearing] = useState(false);

  const clearAllData = async () => {
    setClearing(true);
    try {
      // The server wipes SQLite + cleanly tears down its core; the
      // next agent boot will recreate an empty DB. We don't try to
      // restart the agent process from here — the toast tells the
      // user to do it manually (see `stores/restart.ts` for why).
      await api.post("/api/v1/admin/clear-data", {});
      setConfirming(false);
      setClearing(false);
      await triggerCleared();
    } catch {
      setClearing(false);
      setConfirming(false);
    }
  };

  return (
    <>
      <section class="card" style="border-color:var(--red)">
        <div class="card__header">
          <div>
            <h3 class="card__title" style="color:var(--red)">{t("settings.danger.title")}</h3>
            <p class="card__subtitle">{t("settings.danger.desc")}</p>
          </div>
        </div>
        <button class="btn btn--danger btn--sm" onClick={() => setConfirming(true)}>
          <Icon name="trash-2" size={14} />
          {t("settings.danger.clearAll")}
        </button>
      </section>

      {confirming && (
        <div
          class="modal-backdrop"
          onClick={() => { if (!clearing) setConfirming(false); }}
        >
          <div
            class="modal"
            role="dialog"
            aria-modal="true"
            onClick={(e) => e.stopPropagation()}
          >
            <div class="modal__header">
              <div class="hstack" style="gap:var(--sp-2);align-items:center">
                <Icon name="circle-alert" size={18} style="color:var(--red)" />
                <h3 class="modal__title" style="color:var(--red);margin:0">
                  {t("settings.danger.clearAll")}
                </h3>
              </div>
            </div>
            <div class="modal__body">
              <p style="margin:0;font-size:var(--fs-sm);line-height:1.6">
                {t("settings.danger.confirm")}
              </p>
            </div>
            <div class="modal__footer">
              <button
                class="btn btn--ghost btn--sm"
                onClick={() => setConfirming(false)}
                disabled={clearing}
              >
                {t("common.cancel")}
              </button>
              <button
                class="btn btn--danger btn--sm"
                onClick={clearAllData}
                disabled={clearing}
              >
                <Icon
                  name={clearing ? "loader-2" : "trash-2"}
                  size={14}
                  class={clearing ? "spin" : ""}
                />
                {t("settings.danger.confirmBtn")}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

// ─── Small helpers ───────────────────────────────────────────────────────

function Field({
  label,
  children,
}: {
  label: string;
  children: preact.ComponentChildren;
}) {
  return (
    <label style="display:flex;flex-direction:column;gap:6px">
      <span style="font-size:var(--fs-xs);color:var(--fg-muted);font-weight:var(--fw-med)">
        {label}
      </span>
      {children}
    </label>
  );
}

function ToggleSwitch({
  checked,
  onChange,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <button
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      style={`
        position:relative;width:40px;height:22px;border-radius:999px;
        background:${checked ? "var(--accent)" : "var(--border-strong)"};
        border:none;cursor:pointer;transition:background var(--dur-xs);flex-shrink:0
      `}
    >
      <span
        aria-hidden="true"
        style={`
          position:absolute;left:${checked ? "20px" : "2px"};top:2px;
          width:18px;height:18px;border-radius:999px;background:#fff;
          transition:left var(--dur-xs) var(--ease-out);
          box-shadow:0 1px 3px rgba(0,0,0,0.25)
        `}
      />
    </button>
  );
}
