/** Local multi-client JSON-RPC transport for the shared MemOS runtime. */
import fs from "node:fs";
import net from "node:net";

import {
  JSONRPC_INVALID_REQUEST,
  JSONRPC_PARSE_ERROR,
  rpcCodeForError,
  type JsonRpcFailure,
  type JsonRpcRequest,
  type JsonRpcResponse,
  type JsonRpcSuccess,
} from "../agent-contract/jsonrpc.js";
import { MemosError } from "../agent-contract/errors.js";
import type { MemoryCore } from "../agent-contract/memory-core.js";
import { errorCodeOf, makeDispatcher } from "./methods.js";

export interface SocketServerHandle {
  readonly connectionCount: number;
  close(): Promise<void>;
}

export interface SocketClient {
  request<R = unknown>(
    method: string,
    params?: unknown,
    options?: { timeoutMs?: number },
  ): Promise<R>;
  close(): void;
  readonly connected: boolean;
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
    error: { code, message, data: data as JsonRpcFailure["error"]["data"] },
  };
}

export async function startSocketServer(options: {
  core: MemoryCore;
  socketPath: string;
  strict?: boolean;
  onConnectionCountChanged?: (count: number) => void;
}): Promise<SocketServerHandle> {
  const dispatch = makeDispatcher(options.core, { strict: options.strict });
  const sockets = new Set<net.Socket>();
  const inFlight = new Set<Promise<void>>();
  cleanupUnixSocket(options.socketPath);

  const server = net.createServer((socket) => {
    sockets.add(socket);
    options.onConnectionCountChanged?.(sockets.size);
    socket.setEncoding("utf8");
    let buffer = "";

    const write = (payload: unknown) => {
      if (!socket.destroyed) socket.write(`${JSON.stringify(payload)}\n`);
    };
    const handleLine = async (line: string) => {
      let msg: JsonRpcRequest;
      try {
        msg = JSON.parse(line) as JsonRpcRequest;
      } catch (err) {
        write(errorResponse(null, JSONRPC_PARSE_ERROR, "invalid JSON", {
          message: err instanceof Error ? err.message : String(err),
        }));
        return;
      }
      if (!msg || msg.jsonrpc !== "2.0" || typeof msg.method !== "string") {
        write(errorResponse(msg?.id ?? null, JSONRPC_INVALID_REQUEST, "not JSON-RPC 2.0"));
        return;
      }
      try {
        const result = await dispatch(msg.method, msg.params, {
          connectionId: `${socket.remoteAddress ?? "local"}:${socket.remotePort ?? 0}`,
        });
        if (msg.id !== undefined && msg.id !== null) {
          write({ jsonrpc: "2.0", id: msg.id, result } satisfies JsonRpcSuccess);
        }
      } catch (err) {
        const memosError =
          err instanceof MemosError
            ? err
            : new MemosError("internal", err instanceof Error ? err.message : String(err));
        write(
          errorResponse(
            msg.id ?? null,
            rpcCodeForError(errorCodeOf(err)),
            memosError.message,
            memosError.toJSON(),
          ),
        );
      }
    };

    socket.on("data", (chunk) => {
      buffer += String(chunk);
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (line) {
          const task = handleLine(line);
          inFlight.add(task);
          void task.then(
            () => inFlight.delete(task),
            () => inFlight.delete(task),
          );
        }
        newline = buffer.indexOf("\n");
      }
    });
    const remove = () => {
      if (!sockets.delete(socket)) return;
      options.onConnectionCountChanged?.(sockets.size);
    };
    socket.once("close", remove);
    socket.once("error", remove);
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.socketPath, () => {
      server.off("error", reject);
      if (!isWindowsNamedPipe(options.socketPath)) {
        try {
          fs.chmodSync(options.socketPath, 0o600);
        } catch {
          /* best effort on platforms without Unix socket permissions */
        }
      }
      resolve();
    });
  });

  return {
    get connectionCount() {
      return sockets.size;
    },
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await Promise.allSettled([...inFlight]);
      cleanupUnixSocket(options.socketPath);
    },
  };
}

export async function connectSocketClient(
  socketPath: string,
  options?: { connectTimeoutMs?: number; requestTimeoutMs?: number },
): Promise<SocketClient> {
  const socket = net.createConnection(socketPath);
  const connectTimeoutMs = options?.connectTimeoutMs ?? 2_000;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`MemOS runtime socket connect timed out after ${connectTimeoutMs}ms`));
    }, connectTimeoutMs);
    const onConnectError = (err: Error) => {
      clearTimeout(timer);
      reject(err);
    };
    socket.once("connect", () => {
      clearTimeout(timer);
      socket.off("error", onConnectError);
      resolve();
    });
    socket.once("error", onConnectError);
  });

  socket.setEncoding("utf8");
  let nextId = 1;
  let buffer = "";
  let closed = false;
  const pending = new Map<
    number,
    {
      resolve: (value: unknown) => void;
      reject: (err: unknown) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();

  const finish = (reason: Error) => {
    if (closed) return;
    closed = true;
    for (const entry of pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(reason);
    }
    pending.clear();
  };
  socket.on("data", (chunk) => {
    buffer += String(chunk);
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf("\n");
      if (!line) continue;
      try {
        const response = JSON.parse(line) as JsonRpcResponse;
        if (typeof response.id !== "number") continue;
        const entry = pending.get(response.id);
        if (!entry) continue;
        pending.delete(response.id);
        clearTimeout(entry.timer);
        if ("error" in response) {
          entry.reject(
            Object.assign(new Error(response.error.message), {
              code: response.error.code,
              data: response.error.data,
            }),
          );
        } else {
          entry.resolve(response.result);
        }
      } catch {
        /* Ignore malformed daemon output; request timeout stays authoritative. */
      }
    }
  });
  socket.once("close", () => finish(new Error("MemOS runtime socket closed")));
  socket.once("error", (err) => finish(err));

  return {
    get connected() {
      return !closed && !socket.destroyed;
    },
    request<R = unknown>(method: string, params?: unknown, requestOptions?: { timeoutMs?: number }) {
      return new Promise<R>((resolve, reject) => {
        if (closed || socket.destroyed) {
          reject(new Error("MemOS runtime socket is not connected"));
          return;
        }
        const id = nextId++;
        const timeoutMs = requestOptions?.timeoutMs ?? options?.requestTimeoutMs ?? 180_000;
        const timer = setTimeout(() => {
          if (pending.delete(id)) {
            reject(Object.assign(
              new Error(`MemOS RPC ${method} timed out after ${timeoutMs}ms`),
              { code: "rpc_timeout", method },
            ));
          }
        }, timeoutMs);
        pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer });
        socket.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
      });
    },
    close() {
      finish(new Error("MemOS runtime socket closed by client"));
      socket.end();
    },
  };
}

function cleanupUnixSocket(endpoint: string): void {
  if (isWindowsNamedPipe(endpoint)) return;
  try {
    fs.unlinkSync(endpoint);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
}

function isWindowsNamedPipe(endpoint: string): boolean {
  return endpoint.startsWith("\\\\.\\pipe\\");
}
