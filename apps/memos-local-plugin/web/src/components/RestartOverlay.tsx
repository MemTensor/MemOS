/**
 * Restart overlay.
 *
 * IMPORTANT: config saves must never fall back to a "settings saved"
 * toast/card. OpenClaw restarts the gateway; Hermes terminates the
 * active `hermes chat` process while keeping the Memory Viewer daemon
 * online. Both flows use this full-screen overlay so the user sees the
 * same blocking restart affordance instead of a passive success card.
 */
import { restartState, dismissRestartBanner } from "../stores/restart";
import { health } from "../stores/health";
import { t } from "../stores/i18n";
import { Icon } from "./Icon";

function FullScreenSpinner() {
  const s = restartState.value;
  const agentType = health.value?.agent === "openclaw" ? "openclaw" : "hermes";

  const message =
    s.phase === "restartFailed"
      ? t("restart.failed")
      : s.phase === "waitingUp"
        ? t("restart.waitingUp")
        : agentType === "hermes"
          ? t("restart.restarting.hermes")
          : t("restart.restarting");

  const hint =
    s.phase === "restartFailed"
      ? t(`restart.failedHint.${agentType}` as any)
      : t("restart.autoRefresh");

  return (
    <div
      role="status"
      aria-live="assertive"
      style={`
        position:fixed;inset:0;z-index:99999;
        display:flex;flex-direction:column;align-items:center;justify-content:center;
        background:rgba(0,0,0,.55);backdrop-filter:blur(6px);
        color:#fff;font-family:inherit;
      `}
    >
      <div
        style={`
          display:flex;flex-direction:column;align-items:center;
          gap:16px;max-width:400px;text-align:center;
        `}
      >
        {s.phase !== "restartFailed" ? (
          <div
            style={`
              width:36px;height:36px;
              border:3px solid rgba(255,255,255,.2);
              border-top-color:#fff;
              border-radius:50%;
              animation:restartSpin 1s linear infinite;
            `}
          />
        ) : (
          <Icon name="circle-alert" size={36} />
        )}
        <div style="font-size:15px;font-weight:600">{message}</div>
        <div style="font-size:12px;opacity:.6">{hint}</div>
        {s.phase === "restartFailed" && (
          <button
            class="btn btn--ghost btn--sm"
            onClick={dismissRestartBanner}
            style="color:#fff;border-color:rgba(255,255,255,.3);margin-top:8px"
          >
            {t("common.close")}
          </button>
        )}
      </div>
      <style>{`@keyframes restartSpin{to{transform:rotate(360deg)}}`}</style>
    </div>
  );
}

export function RestartOverlay() {
  const s = restartState.value;
  if (s.phase === "idle") return null;
  return <FullScreenSpinner />;
}
