import { defineConfig } from "vite";
import path from "node:path";

// Vite config for the static marketing/docs site (site/).
// Build output is local-only: site/dist/. Not deployed anywhere.

export default defineConfig({
  root: ".",
  publicDir: "public",
  build: {
    outDir: "dist",
    emptyOutDir: true,
    sourcemap: true,
    target: "es2022",
  },
  server: {
    port: 5174,
    strictPort: false,
  },
  resolve: {
    alias: {
      "@site": path.resolve(__dirname, "src"),
      "@content": path.resolve(__dirname, "content"),
    },
  },
});
