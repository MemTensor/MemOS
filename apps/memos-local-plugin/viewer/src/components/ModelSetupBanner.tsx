/**
 * ModelSetupBanner — sticky amber strip just under the topbar.
 *
 * Shows up when at least one of the three model slots
 * (`embedder`, `llm`, `skillEvolver`) is not usable. Hides itself
 * automatically as soon as the bridge reports all three as
 * `available=true` — the same flag `stores/health.ts` advertises as
 * "the viewer's setup banner uses this flag". The user can also
 * dismiss it manually with `✕`; that dismissal is persisted to
 * localStorage so a half-configured user doesn't get nagged forever.
 *
 * Display rules, in order:
 *   1. User clicked `✕` before          → hidden permanently.
 *   2. `health` hasn't loaded yet       → hidden (avoids flashing a red
 *                                          bar on first paint before we
 *                                          know whether anything's wrong).
 *   3. All three slots `available=true` → hidden (setup is complete).
 *   4. Otherwise                        → shown.
 *
 * Mounted as the second row of `.shell` (see `styles/layout.css`); the
 * row collapses to zero height when the banner is hidden.
 */
import { useState } from "preact/hooks";
import { t } from "../stores/i18n";
import { health } from "../stores/health";
import { navigate } from "../stores/router";
import { Icon } from "./Icon";

const STORAGE_KEY = "memos.banner.modelSetup.dismissed";

function isDismissed(): boolean {
  try {
    return window.localStorage.getItem(STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

function persistDismissed(): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, "1");
  } catch {
    /* localStorage may be unavailable (private mode) — degrade silently */
  }
}

export function ModelSetupBanner() {
  const [dismissed, setDismissed] = useState<boolean>(() => isDismissed());
  const h = health.value;

  if (dismissed || !h || modelsReady(h)) return null;

  const handleDismiss = () => {
    persistDismissed();
    setDismissed(true);
  };

  const handleGoSettings = (e: Event) => {
    e.preventDefault();
    navigate("/settings");
  };

  return (
    <div
      class="model-setup-banner"
      role="status"
      aria-label={t("banner.modelSetup.aria")}
    >
      <div class="model-setup-banner__icon" aria-hidden="true">
        <Icon name="circle-alert" size={16} />
      </div>
      <div class="model-setup-banner__body">
        <strong class="model-setup-banner__title">
          {t("banner.modelSetup.title")}
        </strong>
        <span class="model-setup-banner__msg">
          {t("banner.modelSetup.msg")}
        </span>
        <a
          class="model-setup-banner__cta"
          href="/settings"
          onClick={handleGoSettings}
        >
          {t("banner.modelSetup.cta")}
          <Icon name="arrow-up-right" size={12} />
        </a>
      </div>
      <button
        type="button"
        class="model-setup-banner__close"
        aria-label={t("banner.modelSetup.dismiss")}
        title={t("banner.modelSetup.dismiss")}
        onClick={handleDismiss}
      >
        <Icon name="x" size={16} />
      </button>
    </div>
  );
}

function modelsReady(h: NonNullable<typeof health.value>): boolean {
  return Boolean(
    h.llm?.available &&
      h.embedder?.available &&
      h.skillEvolver?.available,
  );
}
