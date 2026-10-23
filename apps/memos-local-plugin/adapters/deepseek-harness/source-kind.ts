/**
 * Producer-owned message source identity for DeepSeek Harness.
 *
 * DSH session format V4 retired the V3 plugin wrapper (`kind: "plugin"` plus a
 * sibling `plugin` field) and admits only producer-owned kinds: a nonempty
 * string that is not the literal `"plugin"`. Runtime writes are validated
 * before persistence, so a V3-shaped source fails every turn with
 * "format v4 message requires a producer-owned source kind" rather than only
 * being rewritten on migration.
 *
 * The harness maps an unknown V3 plugin name to `plugin:<name>`, which is the
 * same form this adapter must write directly and the form historical sessions
 * are lifted into. Declaring the kind through `MessageSourceMap` follows the
 * harness's documented extension point, so the adapter compiles against both
 * pre-V4 and V4 type surfaces.
 */

import type { ContextFormed } from "@deepseek-ai/dsh-llm";

/** Plugin name as DSH knows it (Cordis row id, manifest name, log prefix). */
export const DEEPSEEK_HARNESS_PLUGIN = "memos-local-memory";

/** Producer-owned source kind accepted by DSH session format V4. */
export const DEEPSEEK_HARNESS_SOURCE_KIND = `plugin:${DEEPSEEK_HARNESS_PLUGIN}`;

declare module "@deepseek-ai/dsh-llm" {
  interface MessageSourceMap {
    "plugin:memos-local-memory": {
      kind: "plugin:memos-local-memory";
    } & ContextFormed;
  }
}
