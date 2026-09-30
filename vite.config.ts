import { defineConfig } from "vite";

// A static site: `dist/` deploys to any static host.
export default defineConfig({
  base: "./",
  build: { target: "es2022", assetsInlineLimit: 0, rollupOptions: { input: { main: "index.html", pick: "pick.html" } } },
  server: { host: "127.0.0.1", port: 5173 },
});
