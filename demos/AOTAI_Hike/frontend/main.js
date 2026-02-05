import { installActionsToWindow } from "./src/actions.js";
import { bootstrap } from "./src/bootstrap.js";
import { logMsg } from "./src/render.js";

installActionsToWindow();

bootstrap().catch((err) => {
  console.error(err);
  logMsg({ kind: "system", content: `启动失败：${err.message}`, timestamp_ms: Date.now() });
});
