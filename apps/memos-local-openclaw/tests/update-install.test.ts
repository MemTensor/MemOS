import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return {
    ...actual,
    exec: vi.fn(),
    execFile: vi.fn(),
    execSync: vi.fn(),
  };
});

import { exec, execFile } from "node:child_process";
import { SqliteStore } from "../src/storage/sqlite";
import { ViewerServer } from "../src/viewer/server";

const pluginPackageJson = fileURLToPath(new URL("../package.json", import.meta.url));
const noopLog = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

function createMockRequest(body: unknown) {
  const req = new EventEmitter() as any;
  req.pushBody = () => {
    req.emit("data", Buffer.from(JSON.stringify(body)));
    req.emit("end");
  };
  return req;
}

function invokeUpdateInstall(viewer: ViewerServer, body: unknown): Promise<{ statusCode: number; data: any }> {
  return new Promise((resolve) => {
    const req = createMockRequest(body);
    const res = {
      statusCode: 0,
      headers: {} as Record<string, string>,
      writeHead(code: number, headers: Record<string, string>) {
        this.statusCode = code;
        this.headers = headers;
      },
      end(payload: string) {
        resolve({ statusCode: this.statusCode, data: JSON.parse(payload) });
      },
    } as any;

    (viewer as any).handleUpdateInstall(req, res);
    req.pushBody();
  });
}

function seedExistingPlugin(extDir: string, version: string) {
  fs.mkdirSync(extDir, { recursive: true });
  fs.writeFileSync(
    path.join(extDir, "package.json"),
    JSON.stringify({ name: "@memtensor/memos-local-openclaw-plugin", version }, null, 2),
    "utf8",
  );
}

function installUpdateMocks(options: { newVersion: string; postinstallError?: Error; postinstallStderr?: string }) {
  const execMock = exec as any;
  const execFileMock = execFile as any;

  execMock.mockImplementation((command: string, execOptions: any, callback: Function) => {
    if (command.startsWith("npm pack ")) {
      callback(null, "memos-local-openclaw-plugin.tgz\n", "");
      return {} as any;
    }
    if (command.startsWith("tar -xzf ")) {
      const match = command.match(/ -C (.+)$/);
      if (!match) throw new Error(`Unexpected tar command: ${command}`);
      const extractDir = match[1];
      const pkgDir = path.join(extractDir, "package");
      fs.mkdirSync(path.join(pkgDir, "scripts"), { recursive: true });
      fs.writeFileSync(
        path.join(pkgDir, "package.json"),
        JSON.stringify({ name: "@memtensor/memos-local-openclaw-plugin", version: options.newVersion }, null, 2),
        "utf8",
      );
      fs.writeFileSync(path.join(pkgDir, "scripts", "postinstall.cjs"), "console.log('postinstall placeholder');\n", "utf8");
      callback(null, "", "");
      return {} as any;
    }
    throw new Error(`Unexpected exec command: ${command}`);
  });

  execFileMock.mockImplementation((file: string, args: string[], execOptions: any, callback: Function) => {
    if (args[0] === "install") {
      callback(null, "installed", "");
      return {} as any;
    }
    if (args[0] === "rebuild") {
      callback(null, "rebuilt", "");
      return {} as any;
    }
    if (file === process.execPath && args[0] === "scripts/postinstall.cjs") {
      if (options.postinstallError) {
        callback(options.postinstallError, "", options.postinstallStderr ?? "");
      } else {
        callback(null, "postinstall ok", "");
      }
      return {} as any;
    }
    throw new Error(`Unexpected execFile call: ${file} ${args.join(" ")}`);
  });
}

describe("viewer update-install", () => {
  let tmpDir = "";
  let homeDir = "";
  let store: SqliteStore | null = null;
  let viewer: ViewerServer | null = null;

  beforeEach(() => {
    vi.useFakeTimers();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "memos-update-install-"));
    homeDir = path.join(tmpDir, "home");
    fs.mkdirSync(homeDir, { recursive: true });
    store = new SqliteStore(path.join(tmpDir, "viewer.db"), noopLog);
    viewer = new ViewerServer({
      store,
      embedder: { provider: "local" } as any,
      port: 19997,
      log: noopLog,
      dataDir: tmpDir,
    });

    vi.spyOn(os, "homedir").mockReturnValue(homeDir);
    vi.spyOn(viewer as any, "findPluginPackageJson").mockReturnValue(pluginPackageJson);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    store?.close();
    viewer = null;
    store = null;
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = "";
    homeDir = "";
  });

  it("rolls back and does not restart when postinstall fails", async () => {
    installUpdateMocks({
      newVersion: "2.0.0-beta.1",
      postinstallError: new Error("postinstall exploded"),
      postinstallStderr: "SyntaxError: duplicate declaration",
    });

    const extDir = path.join(homeDir, ".openclaw", "extensions", "memos-local-openclaw-plugin");
    seedExistingPlugin(extDir, "1.0.0");
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true as any);

    const result = await invokeUpdateInstall(viewer!, { packageSpec: "@memtensor/memos-local-openclaw-plugin@beta" });

    expect(result.statusCode).toBe(200);
    expect(result.data.ok).toBe(false);
    expect(result.data.error).toContain("Postinstall failed");
    expect(result.data.error).toContain("duplicate declaration");
    expect(JSON.parse(fs.readFileSync(path.join(extDir, "package.json"), "utf8")).version).toBe("1.0.0");
    expect(fs.readdirSync(path.dirname(extDir)).filter((name) => name.includes(".backup-"))).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(1000);
    expect(killSpy).not.toHaveBeenCalled();
  });

  it("keeps the new version and restarts only after a successful postinstall", async () => {
    installUpdateMocks({ newVersion: "2.0.0-beta.2" });

    const extDir = path.join(homeDir, ".openclaw", "extensions", "memos-local-openclaw-plugin");
    seedExistingPlugin(extDir, "1.0.0");
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true as any);

    const result = await invokeUpdateInstall(viewer!, { packageSpec: "@memtensor/memos-local-openclaw-plugin@beta" });

    expect(result.statusCode).toBe(200);
    expect(result.data).toEqual({ ok: true, version: "2.0.0-beta.2" });
    expect(JSON.parse(fs.readFileSync(path.join(extDir, "package.json"), "utf8")).version).toBe("2.0.0-beta.2");
    expect(fs.readdirSync(path.dirname(extDir)).filter((name) => name.includes(".backup-"))).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(500);
    expect(killSpy).toHaveBeenCalledWith(process.pid, "SIGUSR1");
  });
});
