/**
 * Public entry point for the `server` module.
 *
 * Consumers (bridge.cts, adapters, tests) should import from here.
 * Internals live behind `./http`, `./routes`, `./middleware`.
 */

export { startHttpServer } from "./http.js";
export type { ServerDeps, ServerHandle, ServerOptions } from "./types.js";
