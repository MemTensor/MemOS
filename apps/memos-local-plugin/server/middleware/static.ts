/**
 * Static-asset middleware.
 *
 * Serves the built viewer bundle + (optionally) the product site from
 * a configured directory. Directory traversal is blocked by resolving
 * every request path against the root and verifying containment.
 *
 * Content-Type is derived from the file extension — we keep a small
 * hard-coded MIME map instead of shelling out to `mime-types`.
 */

import { createReadStream } from "node:fs";
import { stat, readFile } from "node:fs/promises";
import path from "node:path";
import type { ServerResponse } from "node:http";

import { writeNotFound, writeText } from "./io.js";
import type { ServerOptions } from "../types.js";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
};

export async function serveStatic(
  res: ServerResponse,
  pathname: string,
  opts: ServerOptions,
): Promise<boolean> {
  // Route `/site/*` to `siteRoot` when configured.
  if (pathname.startsWith("/site") && opts.siteRoot) {
    const relative = pathname === "/site" ? "/index.html" : pathname.replace(/^\/site/, "") || "/index.html";
    return await tryServe(res, opts.siteRoot, relative);
  }

  if (!opts.staticRoot) return false;
  const relative = pathname === "/" || pathname === "/viewer" ? "/index.html" : pathname;
  return await tryServe(res, opts.staticRoot, relative);
}

async function tryServe(
  res: ServerResponse,
  root: string,
  relative: string,
): Promise<boolean> {
  const resolvedRoot = path.resolve(root);
  const target = path.resolve(resolvedRoot, "." + relative);
  if (!target.startsWith(resolvedRoot)) {
    writeText(res, 403, "forbidden");
    return true;
  }
  try {
    const st = await stat(target);
    if (!st.isFile()) {
      writeNotFound(res);
      return true;
    }
    const ext = path.extname(target).toLowerCase();
    res.writeHead(200, {
      "content-type": MIME[ext] ?? "application/octet-stream",
      "content-length": String(st.size),
      "cache-control": "public, max-age=60",
    });
    // For small files (≤128 KiB) read to buffer and end atomically;
    // for larger, stream and wait on the response's finish event.
    if (st.size <= 128 * 1024) {
      const buf = await readFile(target);
      res.end(buf);
    } else {
      await new Promise<void>((resolve, reject) => {
        const stream = createReadStream(target);
        stream.on("error", reject);
        res.on("finish", () => resolve());
        res.on("close", () => resolve());
        stream.pipe(res);
      });
    }
    return true;
  } catch (err: any) {
    if (err?.code === "ENOENT") return false; // let the caller write 404
    writeText(res, 500, "static: " + (err instanceof Error ? err.message : String(err)));
    return true;
  }
}
