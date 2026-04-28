/**
 * Line-delimited JSON-RPC over TCP.
 *
 * A TCP server that accepts connections from remote clients (e.g. the
 * Hermes Python provider) and dispatches JSON-RPC 2.0 messages through
 * the same `Dispatcher` used by the stdio server.
 *
 * Each connected client gets its own read/write loop.  Notifications
 * (events + logs) are broadcast to all connected clients.
 *
 * The transport:
 *   - Listens on the port given via `--tcp=<port>`.
 *   - Reads each connection as UTF-8 text, splits by `\n`.
 *   - Parses each line as JSON, dispatches via `Dispatcher`.
 *   - Writes responses as JSON followed by `\n` to the originating socket.
 *   - Broadcasts `LogRecord` and `CoreEvent` as JSON-RPC notifications
 *     (method = `logs.forward` / `events.notify`) to all connected clients.
 */

import { createServer, type Socket } from "node:net";
import {
  JSONRPC_PARSE_ERROR,
  JSONRPC_INVALID_REQUEST,
  RPC_METHODS,
  rpcCodeForError,
  type JsonRpcFailure,
  type JsonRpcRequest,
  type JsonRpcSuccess,
} from "../agent-contract/jsonrpc.js";
import type { MemoryCore } from "../agent-contract/memory-core.js";
import { MemosError } from "../agent-contract/errors.js";
import { errorCodeOf, makeDispatcher } from "./methods.js";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface TcpServerOptions {
  core: MemoryCore;
  host: string;
  port: number;
}

export interface TcpServerHandle {
  readonly url: string;
  close: () => Promise<void>;
  done: Promise<void>;
}

// ─── Server ─────────────────────────────────────────────────────────────────

export function startTcpServer(options: TcpServerOptions): TcpServerHandle {
  const { core, host, port } = options;
  const dispatch = makeDispatcher(core);

  const clients = new Set<Socket>();
  let closed = false;
  let doneResolve: () => void;
  const donePromise = new Promise<void>((resolve) => {
    doneResolve = resolve;
  });

  // Subscribe to events + logs and broadcast to all connected clients.
  const eventsUnsub = core.subscribeEvents((e) => {
    broadcast({ jsonrpc: "2.0", method: RPC_METHODS.EVENTS_NOTIFY, params: e });
  });
  const logsUnsub = core.subscribeLogs((r) => {
    broadcast({ jsonrpc: "2.0", method: RPC_METHODS.LOGS_FORWARD, params: r });
  });

  function broadcast(obj: unknown): void {
    const payload = JSON.stringify(obj) + "\n";
    for (const sock of clients) {
      try {
        sock.write(payload);
      } catch {
        /* best-effort per client */
      }
    }
  }

  function errorResponse(
    id: JsonRpcRequest["id"] | null,
    code: number,
    message: string,
    data?: unknown,
  ): JsonRpcFailure {
    return {
      jsonrpc: "2.0",
      id: id ?? null,
      error: { code, message, data: data as any },
    };
  }

  function writeLine(sock: Socket, obj: unknown): void {
    try {
      sock.write(JSON.stringify(obj) + "\n");
    } catch {
      /* ignore */
    }
  }

  async function handleLine(sock: Socket, line: string): Promise<void> {
    const trimmed = line.trim();
    if (trimmed.length === 0) return;

    let msg: JsonRpcRequest | null = null;
    try {
      msg = JSON.parse(trimmed) as JsonRpcRequest;
    } catch (err) {
      writeLine(
        sock,
        errorResponse(null, JSONRPC_PARSE_ERROR, "invalid JSON", {
          text: err instanceof Error ? err.message : String(err),
        }),
      );
      return;
    }

    if (!msg || typeof msg !== "object" || msg.jsonrpc !== "2.0" || !msg.method) {
      writeLine(sock, errorResponse(msg?.id ?? null, JSONRPC_INVALID_REQUEST, "not JSON-RPC 2.0"));
      return;
    }

    try {
      const result = await dispatch(msg.method, msg.params);
      if (msg.id !== undefined && msg.id !== null) {
        const ok: JsonRpcSuccess = { jsonrpc: "2.0", id: msg.id, result };
        writeLine(sock, ok);
      }
    } catch (err) {
      const code = rpcCodeForError(errorCodeOf(err));
      const mErr =
        err instanceof MemosError
          ? err
          : new MemosError("internal", err instanceof Error ? err.message : String(err));
      writeLine(sock, errorResponse(msg.id ?? null, code, mErr.message, mErr.toJSON()));
      process.stderr.write(`bridge.tcp.dispatch.err ${msg.method}: ${mErr.message}\n`);
    }
  }

  // ─── Server ───────────────────────────────────────────────────────────────

  const server = createServer((sock: Socket) => {
    clients.add(sock);
    process.stderr.write(
      `bridge.tcp: client connected (${sock.remoteAddress ?? "unknown"}:${sock.remotePort ?? "?"})\n`,
    );

    let buffer = "";
    sock.setEncoding("utf8");

    sock.on("data", (chunk: string) => {
      buffer += chunk;
      let nl = buffer.indexOf("\n");
      while (nl >= 0) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        void handleLine(sock, line);
        nl = buffer.indexOf("\n");
      }
    });

    sock.on("close", () => {
      clients.delete(sock);
      process.stderr.write(
        `bridge.tcp: client disconnected (${sock.remoteAddress ?? "unknown"}:${sock.remotePort ?? "?"})\n`,
      );
    });

    sock.on("error", (err) => {
      process.stderr.write(`bridge.tcp: socket error: ${err.message}\n`);
      clients.delete(sock);
    });
  });

  server.on("error", (err) => {
    process.stderr.write(`bridge.tcp: server error: ${err.message}\n`);
  });

  server.listen(port, host, () => {
    process.stderr.write(`bridge.tcp: listening on ${host}:${port}\n`);
  });

  return {
    get url() {
      return `tcp://${host}:${port}`;
    },
    async close() {
      if (closed) return;
      closed = true;
      eventsUnsub();
      logsUnsub();
      for (const sock of clients) {
        sock.end();
        sock.destroy();
      }
      clients.clear();
      server.close();
      doneResolve();
    },
    done: donePromise,
  };
}
