import { defineConfig } from "vite";

// A static site: `dist/` deploys to any static host. (The demo, /try, is its own site: demo.phitex.org.)
export default defineConfig({
  base: "./",
  build: { target: "es2022", assetsInlineLimit: 0, rollupOptions: { input: { main: "index.html", overleaf: "overleaf.html", measured: "measured.html", install: "install.html" } } },
  server: { host: "127.0.0.1", port: 5173 },
});
