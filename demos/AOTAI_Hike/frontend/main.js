import { installActionsToWindow } from "./src/actions.js";
import { bootstrap } from "./src/bootstrap.js";
import { t } from "./src/i18n.js";
import { logMsg } from "./src/render.js";

installActionsToWindow();

bootstrap().catch((err) => {
  console.error(err);
  logMsg({ kind: "system", content: t("msgStartupFailed") + err.message, timestamp_ms: Date.now() });
});
