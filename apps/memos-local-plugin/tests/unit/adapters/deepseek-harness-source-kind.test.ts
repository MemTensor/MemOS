/**
 * Regression guard for DSH session format V4 message-source admission.
 *
 * V4 rejects any runtime-written message whose `source.kind` is the retired V3
 * wrapper `"plugin"` and requires the producer-owned `plugin:<name>` form
 * instead. Writing the V3 shape fails every turn at `agent/pre-step`, before
 * persistence, so the adapter must never construct it again.
 */

import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  DEEPSEEK_HARNESS_PLUGIN,
  DEEPSEEK_HARNESS_SOURCE_KIND,
} from "../../../adapters/deepseek-harness/source-kind.js";

const adapterDir = resolve(import.meta.dirname, "../../../adapters/deepseek-harness");

async function adapterSources(): Promise<Array<[string, string]>> {
  const names = (await readdir(adapterDir)).filter((name) => name.endsWith(".ts"));
  return Promise.all(names.map(async (name) => [
    name,
    await readFile(join(adapterDir, name), "utf8"),
  ] as [string, string]));
}

describe("DeepSeek Harness V4 message source", () => {
  it("derives the producer-owned kind from the harness plugin name", () => {
    expect(DEEPSEEK_HARNESS_PLUGIN).toBe("memos-local-memory");
    expect(DEEPSEEK_HARNESS_SOURCE_KIND).toBe("plugin:memos-local-memory");
  });

  it("never writes the retired V3 plugin wrapper in adapter sources", async () => {
    const offenders: string[] = [];
    for (const [name, source] of await adapterSources()) {
      source.split("\n").forEach((line, index) => {
        // Prose may describe the retired shape; only emitted code matters.
        const code = line.replace(/\/\/.*$/, "").replace(/^\s*\*.*$/, "");
        // The V3 wrapper is `kind: "plugin"`; producer-owned kinds are
        // `plugin:<name>` and therefore never match this exact literal.
        if (/kind:\s*["']plugin["']/.test(code)) {
          offenders.push(`${name}:${index + 1}: ${line.trim()}`);
        }
      });
    }
    expect(offenders).toEqual([]);
  });

  it("emits producer-owned kinds from both runtime message writers", async () => {
    const recall = await readFile(join(adapterDir, "index.ts"), "utf8");
    const hostLlm = await readFile(join(adapterDir, "host-llm.ts"), "utf8");

    expect(recall).toContain("kind: DEEPSEEK_HARNESS_SOURCE_KIND");
    expect(recall).toContain('form: "recall"');
    expect(hostLlm).toContain("kind: DEEPSEEK_HARNESS_SOURCE_KIND");
  });
});
