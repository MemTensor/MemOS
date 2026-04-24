/**
 * Lightweight bottom-of-screen toast announcing "config saved" or
 * "data cleared". Shown for ~8 s, then auto-dismisses.
 *
 * Replaces the full-screen restart overlay used by earlier versions:
 * we no longer try to restart the plugin process from the viewer
 * (see `stores/restart.ts` for the rationale), so there's no more
 * "waiting for service to come back" UX. The agent process picks up
 * the new YAML on its own next boot; the toast tells the user that
 * needs to happen manually.
 */
import { restartState, dismissRestartBanner } from "../stores/restart";
import { health } from "../stores/health";
import { t } from "../stores/i18n";
import { Icon } from "./Icon";

export function RestartOverlay() {
  const s = restartState.value;
  if (s.phase === "idle") return null;

  const agent = health.value?.agent ?? "agent";
  const restartHint =
    agent === "openclaw"
      ? t("restart.hint.openclaw")
      : agent === "hermes"
      ? t("restart.hint.hermes")
      : t("restart.hint.generic");

  const title =
    s.phase === "cleared" ? t("restart.cleared") : t("restart.saved");

  return (
    <div
      role="status"
      aria-live="polite"
      style={`
        position:fixed;left:50%;bottom:24px;transform:translateX(-50%);
        z-index:1000;max-width:520px;width:calc(100% - 32px);
      `}
    >
      <div
        class="card"
        style={`
          padding:14px 18px;display:flex;align-items:flex-start;gap:12px;
          box-shadow:0 12px 32px -12px rgba(0,0,0,0.32);
        `}
      >
        <div style="flex-shrink:0;display:flex;align-items:center;color:var(--success)">
          <Icon name="circle-check" size={20} />
        </div>
        <div style="flex:1;min-width:0">
          <div style="font-weight:var(--fw-semi);font-size:var(--fs-md)">
            {title}
          </div>
          <div class="muted" style="font-size:var(--fs-sm);margin-top:2px">
            {restartHint}
          </div>
        </div>
        <button
          class="btn btn--ghost btn--sm"
          aria-label={t("common.close")}
          onClick={dismissRestartBanner}
          style="flex-shrink:0;padding:4px"
        >
          <Icon name="x" size={14} />
        </button>
      </div>
    </div>
  );
}
