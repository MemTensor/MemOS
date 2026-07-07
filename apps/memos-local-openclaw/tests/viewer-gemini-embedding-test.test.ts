import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { SqliteStore } from "../src/storage/sqlite";
import { ViewerServer } from "../src/viewer/server";

const noopLog = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

let tmpDir = "";
let originalEnv: NodeJS.ProcessEnv;
let store: SqliteStore | null = null;

beforeEach(() => {
  originalEnv = { ...process.env };
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "memos-viewer-gemini-"));
  process.env.OPENCLAW_STATE_DIR = tmpDir;
  process.env.OPENCLAW_CONFIG_PATH = path.join(tmpDir, "openclaw.json");
});

afterEach(() => {
  store?.close();
  store = null;
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  tmpDir = "";
  for (const k of Object.keys(process.env)) {
    if (!(k in originalEnv)) delete process.env[k];
  }
  for (const [k, v] of Object.entries(originalEnv)) {
    process.env[k] = v;
  }
});

function makeViewer(): ViewerServer {
  store = new SqliteStore(path.join(tmpDir, "test.db"), noopLog);
  return new ViewerServer({
    store,
    embedder: { provider: "local" } as any,
    port: 19997,
    log: noopLog,
    dataDir: tmpDir,
  });
}

/**
 * Issue #1241: Viewer-side Gemini Test-Connection was calling the wrong
 * Gemini API shape (`v1/...:embedContent`) instead of `v1beta/...:batchEmbedContents`,
 * was ignoring any user-provided endpoint override, and was defaulting to
 * the deprecated `text-embedding-004`. This mirrored the same bug the
 * runtime embedder fixed in PR #1239, but Viewer had drifted.
 *
 * These tests lock in the fixed behavior so the drift cannot reappear.
 */
describe("issue #1241: viewer Gemini embedding test", () => {
  it("calls the v1beta batchEmbedContents endpoint (not v1/embedContent)", async () => {
    const viewer = makeViewer();
    const captured: { url: string; body: string } = { url: "", body: "" };
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: any, init?: any) => {
      captured.url = String(input);
      captured.body = String(init?.body ?? "");
      return {
        ok: true,
        status: 200,
        text: async () => "",
        json: async () => ({ embeddings: [{ values: [0.1, 0.2, 0.3, 0.4] }] }),
      } as any;
    }) as any;

    try {
      const dim = await (viewer as any).testEmbeddingModel(
        "gemini",
        "gemini-embedding-001",
        "",
        "fake-api-key",
      );
      expect(dim).toBe(4);
      expect(captured.url).toContain("/v1beta/");
      expect(captured.url).toContain("batchEmbedContents");
      expect(captured.url).not.toContain(":embedContent?");
      // The batchEmbedContents body wraps content in a `requests` array with
      // a per-request `model` key, matching the runtime provider shape.
      const parsed = JSON.parse(captured.body);
      expect(Array.isArray(parsed.requests)).toBe(true);
      expect(parsed.requests[0].model).toBe("models/gemini-embedding-001");
      expect(parsed.requests[0].content.parts[0].text).toBeTruthy();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("defaults to gemini-embedding-001 when model is empty", async () => {
    const viewer = makeViewer();
    let capturedUrl = "";
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: any) => {
      capturedUrl = String(input);
      return {
        ok: true,
        status: 200,
        text: async () => "",
        json: async () => ({ embeddings: [{ values: [1, 2] }] }),
      } as any;
    }) as any;

    try {
      await (viewer as any).testEmbeddingModel("gemini", "", "", "fake-api-key");
      // Default should be gemini-embedding-001, which is what works against
      // the current Gemini API per the issue reporter's manual verification.
      expect(capturedUrl).toContain("gemini-embedding-001");
      expect(capturedUrl).not.toContain("text-embedding-004");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("respects a user-provided endpoint override", async () => {
    const viewer = makeViewer();
    let capturedUrl = "";
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: any) => {
      capturedUrl = String(input);
      return {
        ok: true,
        status: 200,
        text: async () => "",
        json: async () => ({ embeddings: [{ values: [1, 2, 3] }] }),
      } as any;
    }) as any;

    try {
      const customEndpoint =
        "https://gemini-proxy.example.test/v1beta/models/my-model:batchEmbedContents";
      const dim = await (viewer as any).testEmbeddingModel(
        "gemini",
        "my-model",
        customEndpoint,
        "fake-api-key",
      );
      expect(dim).toBe(3);
      expect(capturedUrl.startsWith("https://gemini-proxy.example.test/")).toBe(true);
      expect(capturedUrl).not.toContain("generativelanguage.googleapis.com");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("resolves ${VAR} in endpoint and apiKey before sending", async () => {
    process.env.GEMINI_KEY_1241 = "sk-resolved-gemini";
    process.env.GEMINI_URL_1241 =
      "https://custom-gemini.example.test/v1beta/models/gemini-embedding-001:batchEmbedContents";

    const viewer = makeViewer();
    let capturedUrl = "";
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: any) => {
      capturedUrl = String(input);
      return {
        ok: true,
        status: 200,
        text: async () => "",
        json: async () => ({ embeddings: [{ values: [1, 2, 3] }] }),
      } as any;
    }) as any;

    try {
      await (viewer as any).testEmbeddingModel(
        "gemini",
        "gemini-embedding-001",
        "${GEMINI_URL_1241}",
        "${GEMINI_KEY_1241}",
      );
      // Both env var literals must be expanded before the network call.
      expect(capturedUrl).toContain("custom-gemini.example.test");
      expect(capturedUrl).toContain("key=sk-resolved-gemini");
      expect(capturedUrl).not.toContain("${");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("surfaces upstream error text when Gemini returns non-2xx", async () => {
    const viewer = makeViewer();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => ({
      ok: false,
      status: 404,
      text: async () => "models/text-embedding-004 is not found",
      json: async () => ({}),
    })) as any;

    try {
      await expect(
        (viewer as any).testEmbeddingModel(
          "gemini",
          "text-embedding-004",
          "",
          "fake-api-key",
        ),
      ).rejects.toThrow(/Gemini embed 404/);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
