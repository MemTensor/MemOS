import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { detectDefault } from "../../../viewer/src/stores/i18n";

/**
 * Regression coverage for the module-level default-locale detector.
 *
 * Under Node (Vitest / SSR / CI without jsdom) `navigator` is undefined
 * and `localStorage` access throws (swallowed by the module's try/catch).
 * Before #2346 this made the `zh-*` → "zh" branch unreachable from unit
 * tests — the only way to assert zh strings was to mutate `locale.value`
 * directly. `detectDefault` is now exported and takes an options bag so
 * both branches are reachable from Node.
 */

type Store = Map<string, string>;

/** Minimal Storage stub matching the shape `detectDefault` uses. */
function makeStorage(initial?: Record<string, string>): Storage {
  const map: Store = new Map(Object.entries(initial ?? {}));
  return {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (k: string) => (map.has(k) ? (map.get(k) as string) : null),
    setItem: (k: string, v: string) => {
      map.set(k, String(v));
    },
    removeItem: (k: string) => {
      map.delete(k);
    },
    key: (i: number) => Array.from(map.keys())[i] ?? null,
  };
}

/** Storage stub whose getItem throws — mirrors browser private-mode / SSR. */
function makeThrowingStorage(): Storage {
  return {
    get length() {
      return 0;
    },
    clear: () => {
      throw new Error("no storage");
    },
    getItem: () => {
      throw new Error("no storage");
    },
    setItem: () => {
      throw new Error("no storage");
    },
    removeItem: () => {
      throw new Error("no storage");
    },
    key: () => null,
  };
}

describe("detectDefault (i18n locale detector)", () => {
  const originalNavigator = (globalThis as { navigator?: unknown }).navigator;
  const originalLocalStorage = (globalThis as { localStorage?: unknown })
    .localStorage;

  beforeEach(() => {
    // Start each test with a clean slate — no globals leaked in.
    delete (globalThis as { navigator?: unknown }).navigator;
    delete (globalThis as { localStorage?: unknown }).localStorage;
  });

  afterEach(() => {
    if (originalNavigator === undefined) {
      delete (globalThis as { navigator?: unknown }).navigator;
    } else {
      (globalThis as { navigator?: unknown }).navigator = originalNavigator;
    }
    if (originalLocalStorage === undefined) {
      delete (globalThis as { localStorage?: unknown }).localStorage;
    } else {
      (globalThis as { localStorage?: unknown }).localStorage =
        originalLocalStorage;
    }
  });

  describe("via injected options", () => {
    it("returns the saved value from injected storage when it is 'zh'", () => {
      const storage = makeStorage({ "memos.lang": "zh" });
      expect(detectDefault({ storage })).toBe("zh");
    });

    it("returns the saved value from injected storage when it is 'en'", () => {
      const storage = makeStorage({ "memos.lang": "en" });
      expect(detectDefault({ storage })).toBe("en");
    });

    it("falls back to navLanguage when injected storage has no saved value", () => {
      const storage = makeStorage();
      expect(detectDefault({ storage, navLanguage: "zh-CN" })).toBe("zh");
      expect(detectDefault({ storage, navLanguage: "en-US" })).toBe("en");
    });

    it("ignores unrecognised saved values and falls back to navLanguage", () => {
      const storage = makeStorage({ "memos.lang": "fr" });
      expect(detectDefault({ storage, navLanguage: "zh-TW" })).toBe("zh");
    });

    it("maps zh-* language tags case-insensitively to 'zh'", () => {
      // This is the branch that was previously untestable under Node.
      expect(detectDefault({ navLanguage: "zh" })).toBe("zh");
      expect(detectDefault({ navLanguage: "zh-CN" })).toBe("zh");
      expect(detectDefault({ navLanguage: "zh-Hans" })).toBe("zh");
      expect(detectDefault({ navLanguage: "ZH-TW" })).toBe("zh");
      expect(detectDefault({ navLanguage: "zh-hant-hk" })).toBe("zh");
    });

    it("returns 'en' for non-zh navLanguages", () => {
      expect(detectDefault({ navLanguage: "en-US" })).toBe("en");
      expect(detectDefault({ navLanguage: "fr-FR" })).toBe("en");
      expect(detectDefault({ navLanguage: "ja-JP" })).toBe("en");
      expect(detectDefault({ navLanguage: "" })).toBe("en");
    });

    it("honours a custom storageKey", () => {
      const storage = makeStorage({ "custom.lang": "zh" });
      expect(
        detectDefault({ storage, storageKey: "custom.lang" }),
      ).toBe("zh");
      expect(
        detectDefault({ storage, storageKey: "memos.lang" }),
      ).toBe("en");
    });

    it("survives a throwing storage — falls back to navLanguage", () => {
      const storage = makeThrowingStorage();
      expect(detectDefault({ storage, navLanguage: "zh-CN" })).toBe("zh");
      expect(detectDefault({ storage, navLanguage: "en-US" })).toBe("en");
    });

    it("returns 'en' when no options and no globals are available", () => {
      // Bare Node — same environment the current test file runs in.
      expect(detectDefault()).toBe("en");
    });
  });

  describe("via global fallbacks (browser-shaped host)", () => {
    it("picks up navigator.language when no options passed", () => {
      (globalThis as { navigator?: { language: string } }).navigator = {
        language: "zh-CN",
      };
      expect(detectDefault()).toBe("zh");
    });

    it("picks up localStorage when no options passed", () => {
      (globalThis as { localStorage?: Storage }).localStorage = makeStorage({
        "memos.lang": "zh",
      });
      expect(detectDefault()).toBe("zh");
    });

    it("prefers saved localStorage value over navigator.language", () => {
      (globalThis as { navigator?: { language: string } }).navigator = {
        language: "en-US",
      };
      (globalThis as { localStorage?: Storage }).localStorage = makeStorage({
        "memos.lang": "zh",
      });
      expect(detectDefault()).toBe("zh");
    });

    it("prefers explicit options over ambient globals", () => {
      (globalThis as { navigator?: { language: string } }).navigator = {
        language: "en-US",
      };
      expect(detectDefault({ navLanguage: "zh-CN" })).toBe("zh");
    });
  });
});
