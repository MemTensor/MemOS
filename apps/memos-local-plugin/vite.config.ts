import { defineConfig } from "vite";
import preact from "@preact/preset-vite";
import path from "node:path";

// Vite config for the runtime viewer (web/).
// Output goes to web/dist and is served at runtime by server/static.ts.

export default defineConfig({
  root: "web",
  publicDir: "public",
  plugins: [preact()],
  // Relative asset URLs so the same bundle can be served from `/`,
  // `/openclaw/`, or `/hermes/` (multi-agent hub routing). Without
  // `base: "./"`, Vite emits `/assets/index-abc.js` which 404s when
  // the viewer is loaded under `/openclaw/`.
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
      "@web": path.resolve(__dirname, "web/src"),
    },
  },
});
