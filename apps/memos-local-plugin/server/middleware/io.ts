/**
 * Request-body and response-writing helpers.
 *
 * Keep these minimal — we don't want to accidentally re-implement a
 * web framework. Handlers return plain objects; `writeJson` takes care
 * of stringification + content-type + status.
 */

import type { IncomingMessage, ServerResponse } from "node:http";

export async function readBody(
  req: IncomingMessage,
  maxBytes: number,
): Promise<Buffer> {
  if (req.method === "GET" || req.method === "HEAD") return Buffer.alloc(0);
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf: Buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buf.length;
    if (total > maxBytes) {
      throw new Error(`body exceeds max size (${maxBytes} bytes)`);
    }
    chunks.push(buf);
  }
  return Buffer.concat(chunks);
}

export function parseJsonBody<T = unknown>(body: Buffer): T {
  if (body.length === 0) return {} as T;
  return JSON.parse(body.toString("utf8")) as T;
}

export function writeJson(
  res: ServerResponse,
  status: number,
  payload: unknown,
): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(body);
}

export function writeText(
  res: ServerResponse,
  status: number,
  text: string,
  contentType = "text/plain; charset=utf-8",
): void {
  res.writeHead(status, { "content-type": contentType });
  res.end(text);
}

export function writeNotFound(res: ServerResponse): void {
  writeJson(res, 404, { error: { code: "not_found", message: "not found" } });
}

export function writeMethodNotAllowed(res: ServerResponse, method: string): void {
  writeJson(res, 405, {
    error: { code: "method_not_allowed", message: `${method} not allowed here` },
  });
}
