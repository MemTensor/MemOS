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
    // IMPORTANT: do NOT lowercase the full header — the boundary value
    // is case-sensitive and lowercasing it breaks matching against
    // the body where the original-case boundary appears verbatim.
    const ct = ctx.req.headers["content-type"] ?? "";
    let bundle: Parameters<typeof deps.core.importBundle>[0] | null = null;

    const ctLower = ct.toLowerCase();
    if (ctLower.startsWith("application/json")) {
      bundle = parseJson(ctx);
    } else if (ctLower.startsWith("multipart/form-data")) {
      const parsed = parseMultipartBundle(ct, ctx.body);
      if (!parsed) {
        // Fallback: try parsing the raw body as JSON directly (some
        // environments strip multipart wrappers or the boundary detection
        // can fail on edge-case formatting).
        try {
          bundle = JSON.parse(ctx.body.toString("utf8"));
        } catch {
          writeError(ctx, 400, "invalid_argument", "missing 'bundle' file field");
          return;
        }
      } else {
        try {
          bundle = JSON.parse(parsed);
        } catch (err) {
          writeError(ctx, 400, "invalid_argument", "bundle is not valid JSON");
          return;
        }
      }
    } else {
      // Last resort: try parsing as JSON regardless of content-type
      try {
        bundle = JSON.parse(ctx.body.toString("utf8"));
      } catch {
        writeError(
          ctx,
          415,
          "unsupported_media_type",
          "content-type must be application/json or multipart/form-data",
        );
        return;
      }
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
  // The boundary in the content-type header may or may not start with
  // dashes. In the body, each boundary line is always prefixed with "--".
  // We try both: `--<boundary>` and the raw boundary as-is.
  let raw = boundaryMatch[2]!;
  let boundaryBuf = Buffer.from(`--${raw}`);
  if (body.indexOf(boundaryBuf) < 0) {
    // The header already included the dashes (e.g. "boundary=----Webkit...")
    // so `--` + `----Webkit` = `------Webkit` which won't match.
    // Try using the raw boundary directly.
    boundaryBuf = Buffer.from(raw);
    if (body.indexOf(boundaryBuf) < 0) return null;
  }

  const crlfcrlf = Buffer.from("\r\n\r\n");

  let offset = 0;
  while (offset < body.length) {
    const bStart = body.indexOf(boundaryBuf, offset);
    if (bStart < 0) break;
    let partStart = bStart + boundaryBuf.length;
    // Skip CRLF after the boundary line
    if (partStart + 2 <= body.length &&
        body[partStart] === 0x0d && body[partStart + 1] === 0x0a) {
      partStart += 2;
    }
    const nextBoundary = body.indexOf(boundaryBuf, partStart);
    const partEnd = nextBoundary >= 0 ? nextBoundary : body.length;
    const part = body.subarray(partStart, partEnd);

    const headerEnd = part.indexOf(crlfcrlf);
    if (headerEnd < 0) { offset = partEnd; continue; }
    const headers = part.subarray(0, headerEnd).toString("utf8");
    if (!/name="bundle"/i.test(headers)) { offset = partEnd; continue; }

    let payload = part.subarray(headerEnd + 4);
    if (payload.length >= 2 &&
        payload[payload.length - 2] === 0x0d &&
        payload[payload.length - 1] === 0x0a) {
      payload = payload.subarray(0, payload.length - 2);
    }
    return payload.toString("utf8");
  }
  return null;
}
