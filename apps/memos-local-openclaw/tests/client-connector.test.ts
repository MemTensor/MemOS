import { afterEach, describe, expect, it } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { SqliteStore } from "../src/storage/sqlite";
import { HubServer } from "../src/hub/server";
import { connectToHub, getHubStatus } from "../src/client/connector";

const noopLog = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

const servers: HubServer[] = [];
const stores: SqliteStore[] = [];
const dirs: string[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) await server.stop();
  for (const store of stores.splice(0)) store.close();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("client connector", () => {
  it("should connect to hub and persist the resolved user session", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "memos-client-connector-"));
    dirs.push(dir);
    const store = new SqliteStore(path.join(dir, "test.db"), noopLog);
    stores.push(store);

    const server = new HubServer({
      store,
      log: noopLog,
      config: { sharing: { enabled: true, role: "hub", hub: { port: 18917, teamName: "Connector", teamToken: "connector-secret" } } },
      dataDir: dir,
    } as any);
    servers.push(server);
    await server.start();

    const authState = JSON.parse(fs.readFileSync(path.join(dir, "hub-auth.json"), "utf8"));
    const token = authState.bootstrapAdminToken;
    const userId = authState.bootstrapAdminUserId;

    store.upsertHubGroup({
      id: "group-backend",
      name: "Backend",
      description: "Backend team",
      createdAt: 1,
    });
    store.addHubGroupMember("group-backend", userId, 1);

    const clientDir = fs.mkdtempSync(path.join(os.tmpdir(), "memos-client-state-"));
    dirs.push(clientDir);
    const clientStore = new SqliteStore(path.join(clientDir, "client.db"), noopLog);
    stores.push(clientStore);

    const session = await connectToHub(clientStore, {
      sharing: {
        enabled: true,
        role: "client",
        client: {
          hubAddress: "127.0.0.1:18917",
          userToken: token,
        },
      },
    } as any);

    expect(session.userId).toBeTruthy();
    expect(session.role).toBe("admin");
    expect(clientStore.getClientHubConnection()).not.toBeNull();

    const status = await getHubStatus(clientStore, {
      sharing: {
        enabled: true,
        role: "client",
        client: {
          hubAddress: "127.0.0.1:18917",
          userToken: token,
        },
      },
    } as any);
    expect(status.connected).toBe(true);
    expect(status.hubUrl).toBe("http://127.0.0.1:18917");
    expect(status.user?.role).toBe("admin");
    expect(status.user?.groups.map((group: any) => group.name)).toEqual(["Backend"]);
  });
});
