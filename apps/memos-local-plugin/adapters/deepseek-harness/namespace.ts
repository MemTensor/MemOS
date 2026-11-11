import type { RuntimeNamespace } from "../../agent-contract/dto.js";
import type { DshSessionLike } from "./bridge.js";

/** Agent presets choose behavior, not memory ownership or visibility. */
export function deepSeekHarnessNamespace(
  session: DshSessionLike | undefined,
  profileId: string,
): RuntimeNamespace {
  return {
    agentKind: "deepseek-harness",
    profileId,
    profileLabel: profileId,
    workspacePath: session?.header?.cwd,
    sessionKey: session?.id,
  };
}
