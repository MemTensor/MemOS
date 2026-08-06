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
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "memos-viewer-env-"));
  process.env.OPENCLAW_STATE_DIR = tmpDir;
  process.env.OPENCLAW_CONFIG_PATH = path.join(tmpDir, "openclaw.json");
});

afterEach(() => {
  store?.close();
  store = null;
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  tmpDir = "";
  // Restore env without leaking test keys
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
    port: 19998,
    log: noopLog,
    dataDir: tmpDir,
  });
}

describe("viewer env var resolution", () => {
  it("handleTestModel should resolve ${VAR} in apiKey/endpoint before sending", async () => {
    process.env.MY_FAKE_API_KEY = "sk-resolved-key";
    process.env.MY_FAKE_ENDPOINT = "https://example.test/v1";

    const viewer = makeViewer();

    // Stub fetch to capture the headers/url that the test path would call
    const captured: { url: string; headers: Record<string, string>; body: string } = { url: "", headers: {}, body: "" };
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: any, init?: any) => {
      captured.url = String(input);
      captured.headers = { ...((init?.headers as Record<string, string>) ?? {}) };
      captured.body = String(init?.body ?? "");
      return {
        ok: true,
        status: 200,
        text: async () => "",
        json: async () => ({ data: [{ embedding: [1, 2, 3] }] }),
      } as any;
    }) as any;

    try {
      const dim = await (viewer as any).testEmbeddingModel(
        "openai",
        "text-embedding-3-small",
        "${MY_FAKE_ENDPOINT}",
        "${MY_FAKE_API_KEY}",
      );
      expect(dim).toBe(3);
      // The Authorization header must contain the resolved key, not the literal ${VAR}.
      expect(captured.headers.Authorization).toBe("Bearer sk-resolved-key");
      expect(captured.url).toContain("https://example.test/v1");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("serveFallbackModel should resolve ${VAR} in providers.baseUrl/apiKey", () => {
    process.env.MY_FAKE_BASE = "https://provider.test/v1";
    process.env.MY_FAKE_API_KEY = "sk-resolved-key";

    fs.writeFileSync(
      process.env.OPENCLAW_CONFIG_PATH!,
      JSON.stringify({
        agents: { defaults: { model: { primary: "openai/gpt-4o-mini" } } },
        models: {
          providers: {
            openai: {
              baseUrl: "${MY_FAKE_BASE}",
              apiKey: "${MY_FAKE_API_KEY}",
            },
          },
        },
      }),
    );

    const viewer = makeViewer();
    let payload: any = null;
    const res: any = {
      writeHead() {},
      end(body: string) { payload = JSON.parse(body); },
    };
    (viewer as any).serveFallbackModel(res);
    expect(payload).toBeTruthy();
    expect(payload.available).toBe(true);
    expect(payload.baseUrl).toBe("https://provider.test/v1");
    expect(payload.model).toBe("gpt-4o-mini");
  });

  it("readPluginConfigResolved reads openclaw.json and resolves ${VAR} into apiKey", () => {
    process.env.MY_FAKE_SUM_KEY = "sk-resolved-summary";
    fs.writeFileSync(
      process.env.OPENCLAW_CONFIG_PATH!,
      JSON.stringify({
        plugins: {
          entries: {
            "memos-local-openclaw-plugin": {
              enabled: true,
              config: {
                summarizer: {
                  provider: "openai",
                  apiKey: "${MY_FAKE_SUM_KEY}",
                },
              },
            },
          },
        },
      }),
    );

    const viewer = makeViewer();
    const cfg = (viewer as any).readPluginConfigResolved();
    expect(cfg.summarizer.apiKey).toBe("sk-resolved-summary");
  });

  it("serveConfig should keep raw ${VAR} literals so UI can still edit them", () => {
    process.env.MY_FAKE_EMB_KEY = "sk-should-stay-hidden";
    fs.writeFileSync(
      process.env.OPENCLAW_CONFIG_PATH!,
      JSON.stringify({
        plugins: {
          entries: {
            "memos-local-openclaw-plugin": {
              enabled: true,
              config: {
                embedding: {
                  provider: "openai",
                  apiKey: "${MY_FAKE_EMB_KEY}",
                },
              },
            },
          },
        },
      }),
    );

    const viewer = makeViewer();
    let payload: any = null;
    const res: any = {
      writeHead() {},
      end(body: string) { payload = JSON.parse(body); },
    };
    (viewer as any).serveConfig(res);
    expect(payload).toBeTruthy();
    // UI should still see the raw env var literal so users can keep secrets out of the file.
    expect(payload.embedding.apiKey).toBe("${MY_FAKE_EMB_KEY}");
  });
});
