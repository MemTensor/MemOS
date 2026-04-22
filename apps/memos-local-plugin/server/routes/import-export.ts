/**
 * Export + import endpoints.
 *
 *   GET  /api/v1/export          → stream a JSON bundle of every trace,
 *                                    policy, world model, and skill in
 *                                    the local store.
 *   POST /api/v1/import          → accept a JSON bundle and insert
 *                                    non-colliding rows.
 *
 * The bundle shape is symmetric (what comes out can go back in) so
 * users can round-trip between devices without tooling. Binary blobs
 * (embeddings) are deliberately dropped on export — we can't
 * re-normalise them after transport.
 */
import type { ServerDeps } from "../types.js";
import { parseJson, writeError, type Routes } from "./registry.js";
import { writeJson } from "../middleware/io.js";

export function registerImportExportRoutes(routes: Routes, deps: ServerDeps): void {
  routes.set("GET /api/v1/export", async (ctx) => {
    const bundle = await deps.core.exportBundle();
    // Hint to the browser that this is a download.
    ctx.res.setHeader(
      "content-disposition",
      `attachment; filename="memos-export-${new Date(bundle.exportedAt)
        .toISOString()
        .slice(0, 10)}.json"`,
    );
    writeJson(ctx.res, 200, bundle);
    return;
  });

  routes.set("POST /api/v1/import", async (ctx) => {
    // The frontend uses `FormData` with field `bundle` (a File). We
    // accept EITHER multipart OR raw JSON body, detected from the
    // content-type header.
    const ct = (ctx.req.headers["content-type"] ?? "").toLowerCase();
    let bundle: Parameters<typeof deps.core.importBundle>[0] | null = null;

    if (ct.startsWith("application/json")) {
      bundle = parseJson(ctx);
    } else if (ct.startsWith("multipart/form-data")) {
      const parsed = parseMultipartBundle(ct, ctx.body);
      if (!parsed) {
        writeError(ctx, 400, "invalid_argument", "missing 'bundle' file field");
        return;
      }
      try {
        bundle = JSON.parse(parsed);
      } catch (err) {
        writeError(ctx, 400, "invalid_argument", "bundle is not valid JSON");
        return;
      }
    } else {
      writeError(
        ctx,
        415,
        "unsupported_media_type",
        "content-type must be application/json or multipart/form-data",
      );
      return;
    }

    if (!bundle || typeof bundle !== "object") {
      writeError(ctx, 400, "invalid_argument", "bundle must be a JSON object");
      return;
    }
    return await deps.core.importBundle(bundle);
  });
}

/**
 * Minimal multipart parser — we only want the first part named
 * `bundle`, as a UTF-8 string. A full implementation would hand off
 * to a library, but we avoid that here to keep the dependency graph
 * small.
 */
function parseMultipartBundle(contentType: string, body: Buffer): string | null {
  const boundaryMatch = contentType.match(/boundary=("?)([^";]+)\1/i);
  if (!boundaryMatch) return null;
  const boundary = `--${boundaryMatch[2]}`;
  const text = body.toString("binary");
  const parts = text.split(boundary);
  for (const part of parts) {
    if (!part || part === "--\r\n") continue;
    const headerEnd = part.indexOf("\r\n\r\n");
    if (headerEnd < 0) continue;
    const headers = part.slice(0, headerEnd);
    if (!/name="bundle"/i.test(headers)) continue;
    // Strip final CRLF before the next boundary (if any).
    let payload = part.slice(headerEnd + 4);
    if (payload.endsWith("\r\n")) payload = payload.slice(0, -2);
    return Buffer.from(payload, "binary").toString("utf8");
  }
  return null;
}
