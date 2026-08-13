import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";

import type { ResolvedHome } from "../../core/config/index.js";
import type { AgentKind } from "../../agent-contract/dto.js";

export function sharedRuntimeSocketPath(
  home: ResolvedHome,
  agent: AgentKind,
  platform: NodeJS.Platform = process.platform,
): string {
  const digest = createHash("sha256").update(path.resolve(home.root)).digest("hex").slice(0, 24);
  if (platform === "win32") {
    return `\\\\.\\pipe\\memos-${agent}-${digest}`;
  }
  const uid = typeof process.getuid === "function" ? process.getuid() : "nouid";
  return path.join(os.tmpdir(), `memos-${agent}-${uid}-${digest}.sock`);
}

/**
 * Stable local IPC endpoint for one OpenClaw MEMOS_HOME.
 *
 * Linux/macOS use a short Unix-domain socket path. Windows uses a named pipe,
 * which Node's `net` module exposes through the same listen/connect API.
 */
export function openClawRuntimeSocketPath(
  home: ResolvedHome,
  platform: NodeJS.Platform = process.platform,
): string {
  return sharedRuntimeSocketPath(home, "openclaw", platform);
}

export function isWindowsNamedPipe(endpoint: string): boolean {
  return endpoint.startsWith("\\\\.\\pipe\\");
}
