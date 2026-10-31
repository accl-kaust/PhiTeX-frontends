// build/web/ served as phitex.org serves /try: COOP same-origin and COEP
// credentialless, so the core's threads may share memory.
//   node web/test/serve.mjs [port] [dir]
import http from "node:http";
import fs from "node:fs";
import path from "node:path";

const port = +(process.argv[2] ?? 8790);
const root = path.resolve(process.argv[3] ?? path.join(path.dirname(new URL(import.meta.url).pathname), "../../build/web"));
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".wasm": "application/wasm", ".json": "application/json", ".txt": "text/plain", ".css": "text/css" };
http
  .createServer((req, res) => {
    const p = path.join(root, decodeURIComponent(new URL(req.url, "http://x").pathname));
    const file = p.endsWith("/") ? p + "index.html" : p;
    if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return res.writeHead(404).end();
    res.writeHead(200, {
      "content-type": TYPES[path.extname(file)] ?? "application/octet-stream",
      "cross-origin-opener-policy": "same-origin",
      "cross-origin-embedder-policy": "credentialless",
    });
    fs.createReadStream(file).pipe(res);
  })
  .listen(port, "127.0.0.1", () => console.log(`http://127.0.0.1:${port}/`));
