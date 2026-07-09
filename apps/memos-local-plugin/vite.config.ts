import { defineConfig } from "vite";
import preact from "@preact/preset-vite";
import path from "node:path";

// Vite config for the runtime viewer (viewer/).
// Output goes to viewer/dist and is served at runtime by server/static.ts.

export default defineConfig({
  root: "viewer",
  publicDir: "public",
  plugins: [preact()],
  // Relative asset URLs. Each agent owns its own port and serves the
  // SPA at root, so absolute `/assets/...` would also work — we keep
  // `./` so legacy bookmarks at `/openclaw/...` (which the server
  // rewrites to `/...`) still find the right asset path inside HTML.
  base: "./",
  build: {
    outDir: "dist",
    emptyOutDir: true,
    sourcemap: true,
    target: "es2022",
  },
  server: {
    port: 5173,
    strictPort: false,
    proxy: {
      "/api": {
        target: "http://127.0.0.1:18910",
        changeOrigin: true,
      },
    },
  },
  resolve: {
    alias: {
      "@contract": path.resolve(__dirname, "agent-contract"),
      "@viewer": path.resolve(__dirname, "viewer/src"),
    },
  },
});
