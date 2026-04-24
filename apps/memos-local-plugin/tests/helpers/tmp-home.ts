/**
 * Throwaway runtime home directory for tests.
 *
 *   const ctx = await makeTmpHome("openclaw");
 *   try {
 *     // ctx.home, ctx.config -- pre-loaded; ctx.cleanup() to remove.
 *   } finally {
 *     await ctx.cleanup();
 *   }
 *
 * `makeTmpHome` sets `MEMOS_HOME` for the duration; `cleanup()` restores it.
 * This guarantees every code path that reads `core/config/paths.ts` ends up
 * inside the tmp dir.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  loadConfig,
  resolveHome,
  type ResolvedConfig,
  type ResolvedHome,
} from "../../core/config/index.js";

export interface TmpHomeContext {
  home: ResolvedHome;
  config: ResolvedConfig;
  /** Where the temp dir lives on disk. */
  root: string;
  /** Restore env + remove dir. */
  cleanup(): Promise<void>;
}

export interface TmpHomeOptions {
  agent?: string;
  /** Extra config patch to write before loadConfig. */
  configYaml?: string;
}

import { promises as fs } from "node:fs";

export async function makeTmpHome(opts: TmpHomeOptions = {}): Promise<TmpHomeContext> {
  const agent = opts.agent ?? "openclaw";
  const root = await mkdtemp(join(tmpdir(), `memos-test-${agent}-`));
  const prevHome = process.env["MEMOS_HOME"];
  process.env["MEMOS_HOME"] = root;

  // Lay out runtime dirs so transports don't have to mkdir.
  await fs.mkdir(join(root, "data"), { recursive: true });
  await fs.mkdir(join(root, "logs"), { recursive: true });
  await fs.mkdir(join(root, "skills"), { recursive: true });
  await fs.mkdir(join(root, "daemon"), { recursive: true });

  if (opts.configYaml != null) {
    await fs.writeFile(join(root, "config.yaml"), opts.configYaml, "utf8");
  }

  const home = resolveHome(agent);
  const { config } = await loadConfig(home);

  return {
    home,
    config,
    root,
    async cleanup() {
      if (prevHome === undefined) delete process.env["MEMOS_HOME"];
      else process.env["MEMOS_HOME"] = prevHome;
      await rm(root, { recursive: true, force: true });
    },
  };
}
