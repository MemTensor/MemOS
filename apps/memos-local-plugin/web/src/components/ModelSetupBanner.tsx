/**
 * ModelSetupBanner — sticky amber strip just under the topbar.
 *
 * A simple "please configure your models" reminder. Always shown until
 * the operator clicks `✕`; the dismissal is persisted to localStorage
 * so it survives page reloads. We intentionally do NOT inspect health
 * to decide whether to hide it — the banner is a one-time onboarding
 * nudge, not a live status indicator.
 *
 * Mounted as the second row of `.shell` (see `styles/layout.css`); the
 * row collapses to zero height when the banner is dismissed.
 */
import { useState } from "preact/hooks";
import { t } from "../stores/i18n";
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

  if (dismissed) return null;

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
