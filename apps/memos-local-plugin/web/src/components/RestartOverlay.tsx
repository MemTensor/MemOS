/**
 * Full-viewport overlay shown while the viewer is reloading config
 * and waiting for the backend to restart. Driven by `restartState`.
 *
 * Mirrors the legacy `memos-local-openclaw` v2 overlay — dark scrim,
 * centred spinner, primary message, subtitle. See the design spec in
 * `stores/restart.ts` for the state machine.
 */
import { restartState } from "../stores/restart";
import { t } from "../stores/i18n";
import { Icon } from "./Icon";

export function RestartOverlay() {
  const s = restartState.value;
  if (s.phase === "idle") return null;

  const title =
    s.phase === "down"
      ? t("restart.down")
      : s.phase === "up"
      ? t("restart.up")
      : s.phase === "done"
      ? t("restart.done")
      : t("restart.failed");

  const subtitle =
    s.phase === "failed"
      ? s.message ?? ""
      : t("restart.subtitle");

  return (
    <div
      role="dialog"
      aria-modal="true"
      style={`
        position:fixed;inset:0;z-index:1000;display:flex;
        align-items:center;justify-content:center;
        background:rgba(0,0,0,0.72);backdrop-filter:blur(4px);
      `}
    >
      <div
        class="card"
        style={`
          max-width:420px;width:90%;text-align:center;
          padding:var(--sp-8) var(--sp-6);
          display:flex;flex-direction:column;align-items:center;gap:var(--sp-4)
        `}
      >
        {s.phase === "failed" ? (
          <Icon name="circle-alert" size={40} />
        ) : (
          <Icon name="loader-2" size={40} class="spin" />
        )}
        <div>
          <div
            style="font-size:var(--fs-lg);font-weight:var(--fw-semi);margin-bottom:4px"
          >
            {title}
          </div>
          <div class="muted" style="font-size:var(--fs-sm)">{subtitle}</div>
        </div>
        {s.phase === "failed" && (
          <button class="btn btn--primary btn--sm" onClick={() => location.reload()}>
            <Icon name="refresh-cw" size={14} />
            {t("restart.reload")}
          </button>
        )}
      </div>
    </div>
  );
}
