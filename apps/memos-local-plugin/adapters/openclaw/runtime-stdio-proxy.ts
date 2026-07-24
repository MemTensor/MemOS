/** Stdio JSON-RPC compatibility proxy for the shared OpenClaw owner. */
import {
  JSONRPC_INTERNAL_ERROR,
  JSONRPC_INVALID_REQUEST,
  JSONRPC_PARSE_ERROR,
  RPC_METHODS,
  type JsonRpcRequest,
} from "../../agent-contract/jsonrpc.js";
import { resolveHome } from "../../core/config/index.js";
import { connectSharedOpenClawRuntime } from "./runtime-client.js";

function explicitHome(): string | undefined {
  const value = process.argv.slice(2).find((arg) => arg.startsWith("--home="));
  return value?.slice("--home=".length);
}

async function main(): Promise<void> {
  const home = resolveHome("openclaw", explicitHome());
  const client = await connectSharedOpenClawRuntime(home);
  process.stdin.setEncoding("utf8");
  let buffer = "";
  let ended = false;
  const inFlight = new Set<Promise<void>>();

  const write = (payload: unknown) => {
    process.stdout.write(`${JSON.stringify(payload)}\n`);
  };
  const handleLine = async (line: string) => {
    let request: JsonRpcRequest;
    try {
      request = JSON.parse(line) as JsonRpcRequest;
    } catch (err) {
      write({
        jsonrpc: "2.0",
        id: null,
        error: {
          code: JSONRPC_PARSE_ERROR,
          message: "invalid JSON",
          data: { message: err instanceof Error ? err.message : String(err) },
        },
      });
      return;
    }
    if (
      !request ||
      request.jsonrpc !== "2.0" ||
      typeof request.method !== "string"
    ) {
      write({
        jsonrpc: "2.0",
        id: request?.id ?? null,
        error: { code: JSONRPC_INVALID_REQUEST, message: "not JSON-RPC 2.0" },
      });
      return;
    }
    try {
      let result: unknown;
      if (request.method === RPC_METHODS.CORE_INIT) {
        await client.request(RPC_METHODS.CORE_HEALTH);
        result = { ok: true };
      } else if (request.method === RPC_METHODS.CORE_SHUTDOWN) {
        result = { ok: true };
      } else {
        result = await client.request(request.method, request.params);
      }
      if (request.id !== undefined && request.id !== null) {
        write({ jsonrpc: "2.0", id: request.id, result });
      }
    } catch (err) {
      const record = err as { code?: unknown; data?: unknown };
      if (request.id !== undefined && request.id !== null) {
        write({
          jsonrpc: "2.0",
          id: request.id,
          error: {
            code: typeof record.code === "number" ? record.code : JSONRPC_INTERNAL_ERROR,
            message: err instanceof Error ? err.message : String(err),
            data: record.data ?? (
              typeof record.code === "string" ? { code: record.code } : undefined
            ),
          },
        });
      }
    }
  };

  const done = new Promise<void>((resolve) => {
    process.stdin.on("data", (chunk) => {
      buffer += String(chunk);
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (line) {
          const task = handleLine(line);
          inFlight.add(task);
          void task.finally(() => inFlight.delete(task));
        }
        newline = buffer.indexOf("\n");
      }
    });
    process.stdin.once("end", () => {
      ended = true;
      const line = buffer.trim();
      if (line) {
        const task = handleLine(line);
        inFlight.add(task);
        void task.finally(() => inFlight.delete(task));
      }
      resolve();
    });
  });
  let stopping: Promise<void> | null = null;
  const stop = (): Promise<void> => {
    if (!stopping) {
      stopping = (async () => {
        if (!ended) process.stdin.pause();
        await Promise.allSettled([...inFlight]);
        client.close();
      })();
    }
    return stopping;
  };
  process.once("SIGINT", () => void stop().then(() => process.exit(0)));
  process.once("SIGTERM", () => void stop().then(() => process.exit(0)));
  await done;
  await stop();
}

void main().catch((err) => {
  process.stderr.write(
    `memos-local OpenClaw runtime stdio proxy failed: ${
      err instanceof Error ? err.stack ?? err.message : String(err)
    }\n`,
  );
  process.exitCode = 1;
});
