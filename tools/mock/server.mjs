// A local stand-in for Overleaf: the editor page (overleaf.html, a mock of
// its DOM, with CodeMirror 6 itself: tools/mock/editor/, tools/build/mock-editor.sh) at /project/mock, and
// the endpoints the extension reads: /entities, /doc/:id/download,
// /download/zip. Edits made in the mock are kept in memory (as a server).
//   node tools/mock/server.mjs [port]
// MOCK_PROJECT: a folder (default tools/mock/project; `latex` is tools/mock/latex/) or an
// Overleaf source ZIP ("Download as source"), binaries (figures) included.
// Recompile runs the local pdflatex (twice) on a copy in /tmp/tex/mock,
// as Overleaf's compile: its PDF, log and download, to compare with PhiTeX's.
// The project dashboard at /project (dashboard.html): MOCK_DASHBOARD, a JSON
// file of the user's projects, tags and folders (test/scenarios/dashboard/
// projects.json says how), the folders kept in the storage project as the
// extension keeps them (folders/project.ts: its zip's data/folders.json, an
// upload replacing it).
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import crypto from "node:crypto";
import { execFile } from "node:child_process";

const dir = path.dirname(new URL(import.meta.url).pathname);
const port = +(process.argv[2] ?? 8123);
const docs = new Map(); // id → { path, text }
const files = new Map(); // path → Buffer (binary files: figures)
let n = 0;
const TEXT = /\.(tex|bib|cls|sty|bst|bbx|cbx|lbx|dbx|cfg|def|clo|fd|ltx|txt|md|ist|tikz|pgf|dtx|ins)$/i;
// (the editor's socket as Overleaf's speaks it: server to client text frames
// only; POST /project/mock/replace?path=fig.png with the new bytes says what
// a replaced file says: a new id, `removeEntity`, then `reciveNewFile`)
// The join's answer on each new socket, as Overleaf's real-time service
// sends it (`joinProjectResponse`: the project's root doc and folder tree),
// and a change of the root doc (POST /project/mock/root-doc?path=main.tex:
// `rootDocUpdated`, the new id). MOCK_ROOT: the root doc's path (unset: none,
// as a project whose root doc was deleted).
const sockets = new Set();
const frame = (name, args) => {
  const t = Buffer.from(`5:::${JSON.stringify({ name, args })}`);
  const len = t.length;
  const head = len < 126 ? Buffer.from([0x81, len]) : len < 65536 ? Buffer.from([0x81, 126, len >> 8, len & 255]) : Buffer.concat([Buffer.from([0x81, 127]), Buffer.from(new BigUint64Array([BigInt(len)]).buffer).reverse()]);
  return Buffer.concat([head, t]);
};
const say = (name, args) => {
  for (const s of sockets) s.write(frame(name, args));
};
let rootPath = process.env.MOCK_ROOT ?? null;
const docId = (p) => [...docs].find(([, d]) => d.path === p)?.[0] ?? null;
/** The project's folders as Overleaf's join gives them (ProjectEditorHandler's folder model): names and ids. */
const folderTree = () => {
  const top = { _id: "rootfolder", name: "rootFolder", folders: [], docs: [], fileRefs: [] };
  const at = (parts) => {
    let f = top;
    for (const name of parts) f = f.folders.find((c) => c.name === name) ?? (f.folders.push({ _id: `folder-${name}`, name, folders: [], docs: [], fileRefs: [] }), f.folders.at(-1));
    return f;
  };
  for (const [id, d] of docs) at(d.path.split("/").slice(0, -1)).docs.push({ _id: id, name: path.basename(d.path) });
  for (const p of files.keys()) at(p.split("/").slice(0, -1)).fileRefs.push({ _id: `file-${p}`, name: path.basename(p) });
  return [top];
};
const fileIds = new Map(); // id → path
const add = (p, b) => {
  if (TEXT.test(p) && !b.includes(0)) docs.set(`d${String(++n).padStart(23, "0")}`, { path: p, text: b.toString("utf8") });
  else files.set(p, b);
};

/** An archive's entries: [path, bytes] (stored or deflated, as Overleaf's ZIP has). */
function unzip(b) {
  const out = [];
  let e = b.length - 22;
  while (e >= 0 && b.readUInt32LE(e) !== 0x06054b50) e--;
  const count = b.readUInt16LE(e + 10);
  let c = b.readUInt32LE(e + 16);
  for (let k = 0; k < count; k++) {
    const method = b.readUInt16LE(c + 10), size = b.readUInt32LE(c + 20), nl = b.readUInt16LE(c + 28), xl = b.readUInt16LE(c + 30), cl = b.readUInt16LE(c + 32);
    const local = b.readUInt32LE(c + 42), name = b.subarray(c + 46, c + 46 + nl).toString("utf8");
    c += 46 + nl + xl + cl;
    if (name.endsWith("/")) continue;
    const at = local + 30 + b.readUInt16LE(local + 26) + b.readUInt16LE(local + 28);
    const raw = b.subarray(at, at + size);
    out.push([name, method === 8 ? zlib.inflateRawSync(raw) : Buffer.from(raw)]);
  }
  return out;
}

const proj = path.resolve(dir, process.env.MOCK_PROJECT ?? "project"); // (or an absolute path)
if (proj.endsWith(".zip")) for (const [p, b] of unzip(fs.readFileSync(proj))) add(p, b);
else {
  const walk = (d, rel = "") => {
    for (const f of fs.readdirSync(d, { withFileTypes: true })) {
      const r = rel ? `${rel}/${f.name}` : f.name;
      if (f.isDirectory()) walk(path.join(d, f.name), r);
      else add(r, fs.readFileSync(path.join(d, f.name)));
    }
  };
  walk(proj);
}

function zip(entries) {
  // (stored and deflated entries, as Overleaf's has both)
  const parts = [], central = [];
  let off = 0;
  for (const [name, body] of entries) {
    const raw = Buffer.from(body), data = zlib.deflateRawSync(raw), nb = Buffer.from(name);
    const h = Buffer.alloc(30);
    h.writeUInt32LE(0x04034b50, 0); h.writeUInt16LE(20, 4); h.writeUInt16LE(8, 8);
    h.writeUInt32LE(zlib.crc32(raw), 14); h.writeUInt32LE(data.length, 18); h.writeUInt32LE(raw.length, 22); h.writeUInt16LE(nb.length, 26);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(8, 10);
    c.writeUInt32LE(zlib.crc32(raw), 16); c.writeUInt32LE(data.length, 20); c.writeUInt32LE(raw.length, 24); c.writeUInt16LE(nb.length, 28); c.writeUInt32LE(off, 42);
    parts.push(h, nb, data); central.push(c, nb);
    off += 30 + nb.length + data.length;
  }
  const cd = Buffer.concat(central), e = Buffer.alloc(22);
  e.writeUInt32LE(0x06054b50, 0); e.writeUInt16LE(entries.length, 8); e.writeUInt16LE(entries.length, 10);
  e.writeUInt32LE(cd.length, 12); e.writeUInt32LE(off, 16);
  return Buffer.concat([...parts, cd, e]);
}

/** Overleaf's compile, locally: the project as it is now, pdflatex, in /tmp/tex/mock. */
const OUT = "/tmp/tex/mock";
function compile() {
  return new Promise((res) => {
    fs.rmSync(OUT, { recursive: true, force: true });
    fs.mkdirSync(OUT, { recursive: true });
    const put = (p, b) => (fs.mkdirSync(path.dirname(path.join(OUT, p)), { recursive: true }), fs.writeFileSync(path.join(OUT, p), b));
    for (const d of docs.values()) put(d.path, d.text);
    for (const [p, b] of files) put(p, b);
    const main = [...docs.values()].find((d) => /\\documentclass/.test(d.text))?.path ?? "main.tex";
    const t = Date.now();
    // (pdflatex itself, twice for references: latexmk's own rc may send its output elsewhere)
    const run = (k) =>
      execFile("pdflatex", ["-interaction=nonstopmode", "-jobname=output", main], { cwd: OUT, timeout: 120_000 }, () =>
        k > 1 ? run(k - 1) : res({ ok: fs.existsSync(path.join(OUT, "output.pdf")), ms: Date.now() - t }),
      );
    run(2);
  });
}

/** A dashboard's projects (Overleaf's API's shape), tags and storage project, from a file (MOCK_DASHBOARD, or another account's: POST /project/mock/dashboard). */
const readDash = (file) => {
  const f = JSON.parse(fs.readFileSync(file, "utf8"));
  // (an age, "40m" "5h" "3d" "2w" "6mo" "1y", as a date that long before the mock started)
  const units = { m: 60e3, h: 3600e3, d: 86400e3, w: 604800e3, mo: 2592000e3, y: 31536000e3 };
  const at = (age) => {
    const [, n, u] = /^(\d+)(mo|[mhdwy])$/.exec(age) ?? [, "0", "m"];
    return new Date(Date.now() - +n * units[u]).toISOString();
  };
  const person = (name) => {
    const [firstName, ...rest] = name.split(" ");
    return { id: `u-${name.replace(/\W/g, "")}`, firstName, lastName: rest.join(" "), email: `${firstName.toLowerCase()}@example.org` };
  };
  const me = { id: "u-me", firstName: "Mock", lastName: "User", email: "me@example.org" };
  const projects = f.projects.map((p) => ({
    id: p.id, name: p.name, lastUpdated: at(p.ago ?? "1d"), accessLevel: p.owner ? "readAndWrite" : "owner", source: p.owner ? "invite" : "owner",
    archived: !!p.archived, trashed: !!p.trashed, owner: p.owner ? person(p.owner) : me, lastUpdatedBy: p.owner ? person(p.owner) : me,
  }));
  // (the storage project, the folders' own: edited at each change to them, so the newest; "storage": false, none)
  const storage = f.storage === false ? null : { id: "5f0000000000000000000da7", file: null, text: JSON.stringify({ ...f.folders, dataFolder: "5f0000000000000000000d07" }) };
  if (storage) projects.push({ id: storage.id, name: ".phitex-data", lastUpdated: at("1m"), accessLevel: "owner", source: "owner", archived: false, trashed: false, owner: me, lastUpdatedBy: me });
  return { projects, tags: f.tags ?? [], storage };
};
let dash = process.env.MOCK_DASHBOARD ? readDash(process.env.MOCK_DASHBOARD) : null;
/**
 * The project's history (MOCK_HISTORY: a JSON file), as Overleaf's History
 * view reads it: `users` by key ({id, first_name, last_name, email}),
 * `updates` oldest first ({v, user, ago: "3d", files}), `labels` ({comment,
 * v, ago}), and `lines` by file: [first, last, v] (lines from 1) inserted by
 * update v, the rest the first version's. GET /updates (newest first),
 * /labels, /diff?pathname=&from=&to= (the file's text as it is now, its
 * lines' inserts with their update's meta) and /version/N/zip (the files
 * as they are now: the mock keeps no older text).
 */
const hist = process.env.MOCK_HISTORY ? JSON.parse(fs.readFileSync(process.env.MOCK_HISTORY, "utf8")) : null;
// (the history's last version: the files as the mock loaded them; edits made since are not in it, as
// Overleaf's history lags the editor until it flushes)
const histText = new Map([...docs.values()].map((d) => [d.path, d.text]));
const histAt = (ago) => {
  const m = /^(\d+)([mhd])$/.exec(ago ?? "1d");
  return Date.now() - (m ? +m[1] * { m: 60e3, h: 3600e3, d: 86400e3 }[m[2]] : 86400e3);
};
const histUpdate = (x) => ({ fromV: x.v - 1, toV: x.v, meta: { users: [hist.users[x.user]], start_ts: histAt(x.ago) - 60e3, end_ts: histAt(x.ago) }, pathnames: x.files ?? [], project_ops: [], labels: (hist.labels ?? []).filter((l) => l.v === x.v).map((l) => ({ comment: l.comment })) });
/** A multipart body's file part's bytes (the upload's qqfile). */
const filePart = (body, type) => {
  const boundary = "--" + /boundary=(.+)$/.exec(type)?.[1];
  for (const part of body.toString("latin1").split(boundary)) {
    const i = part.indexOf("\r\n\r\n");
    if (i > 0 && /filename=/.test(part.slice(0, i))) return Buffer.from(part.slice(i + 4, part.lastIndexOf("\r\n")), "latin1");
  }
  return null;
};
const escapeAttr = (t) => t.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");

http.createServer((req, res) => {
  const u = new URL(req.url, "http://x");
  // (served as overleaf.com is: COOP same-origin and COEP credentialless,
  // so the tab is cross-origin isolated, as the core's offscreen page is
  // by its manifest; tools/dev/mock-run.mjs asserts both before the
  // first page is waited for)
  const iso = { "cross-origin-opener-policy": "same-origin", "cross-origin-embedder-policy": "credentialless" };
  const send = (code, type, body) => (res.writeHead(code, { "content-type": type, ...iso }), res.end(body));
  let m;
  // (with Overleaf's script policy: a nonce, strict-dynamic, and no
  // 'wasm-unsafe-eval', so WebAssembly compiled in the tab fails here as it
  // does on overleaf.com, where content scripts get the page's policy)
  if (u.pathname === "/project/mock" || u.pathname === "/project/mock/") {
    const nonce = Math.random().toString(36).slice(2);
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "content-security-policy": `script-src 'nonce-${nonce}' 'unsafe-inline' 'strict-dynamic' https: 'report-sample'`, ...iso });
    return res.end(fs.readFileSync(path.join(dir, "overleaf.html"), "utf8").replaceAll("<script", `<script nonce="${nonce}"`));
  }
  // (the dashboard, and the storage project's endpoints the folders use: read, list, write)
  if (dash && (u.pathname === "/project" || u.pathname === "/project/")) {
    const blob = escapeAttr(JSON.stringify({ totalSize: dash.projects.length, projects: dash.projects }));
    const page = fs.readFileSync(path.join(dir, "dashboard.html"), "utf8").replace('content="__BLOB__"', `content="${blob}" data-tags="${escapeAttr(JSON.stringify(dash.tags))}"`);
    return send(200, "text/html; charset=utf-8", page);
  }
  // (another account's dashboard: POST /project/mock/dashboard?path=FILE, its projects and folders from then on)
  if (u.pathname === "/project/mock/dashboard" && req.method === "POST") {
    dash = readDash(u.searchParams.get("path"));
    return send(204, "text/plain", "");
  }
  if (hist && u.pathname === "/project/mock/updates") return send(200, "application/json", JSON.stringify({ updates: hist.updates.map(histUpdate).reverse() }));
  if (hist && u.pathname === "/project/mock/labels")
    return send(200, "application/json", JSON.stringify((hist.labels ?? []).map((l, i) => ({ id: `l${i}`, comment: l.comment, version: l.v, created_at: new Date(histAt(l.ago)).toISOString(), user_display_name: "Mock User" }))));
  if (hist && u.pathname === "/project/mock/diff") {
    const p = u.searchParams.get("pathname");
    const d = histText.has(p) ? { text: histText.get(p) } : null;
    if (!d) return send(404, "text/plain", "no such file");
    const spans = hist.lines?.[p] ?? [];
    const parts = [];
    d.text.split(/(?<=\n)/).forEach((line, i) => {
      const s = spans.find(([a, b]) => i + 1 >= a && i + 1 <= b);
      const up = s && hist.updates.find((x) => x.v === s[2]);
      const part = up ? { i: line, meta: histUpdate(up).meta } : { u: line };
      const last = parts.at(-1);
      if (last && !!last.i === !!part.i && (!part.i || last.meta.end_ts === part.meta.end_ts)) last[part.i ? "i" : "u"] += line;
      else parts.push(part);
    });
    return send(200, "application/json", JSON.stringify({ diff: parts }));
  }
  if (hist && /^\/project\/mock\/version\/\d+\/zip$/.test(u.pathname)) return send(200, "application/zip", zip([...[...docs.values()].map((x) => [x.path, x.text]), ...files]));
  if (dash && u.pathname === "/api/project" && req.method === "POST") return send(200, "application/json", JSON.stringify({ totalSize: dash.projects.length, projects: dash.projects }));
  const st = dash?.storage;
  if (st && u.pathname.toLowerCase() === `/project/${st.id}/download/zip`) return send(200, "application/zip", zip([["main.tex", "% the folders' storage (mock)\n"], ["data/folders.json", st.text]]));
  if (st && (m = u.pathname.match(/^\/Project\/(\w+)\/file\/(\w+)$/i)) && m[1] === st.id)
    return m[2] === st.file ? send(200, "application/json", st.text) : send(404, "text/plain", "not found");
  if (st && u.pathname === `/project/${st.id}/folder` && req.method === "POST") return send(200, "application/json", JSON.stringify({ _id: "5f0000000000000000000d07", name: "data" }));
  if (st && u.pathname.toLowerCase() === `/project/${st.id}/upload` && req.method === "POST") {
    const parts = [];
    req.on("data", (c) => parts.push(c));
    req.on("end", () => {
      const b = filePart(Buffer.concat(parts), req.headers["content-type"] ?? "");
      if (!b) return send(400, "application/json", JSON.stringify({ success: false, error: "no file" }));
      st.text = b.toString("utf8");
      st.file = `f${String(++n).padStart(23, "0")}`;
      send(200, "application/json", JSON.stringify({ success: true, entity_id: st.file, entity_type: "file" }));
    });
    return;
  }
  // (the editor: CodeMirror 6 and Overleaf's grammar, tools/build/mock-editor.sh)
  if (u.pathname === "/project/mock/editor.js") {
    const f = path.join(dir, "build/editor.js");
    if (!fs.existsSync(f)) return send(404, "text/plain", "tools/mock/build/editor.js: run tools/sandbox tools/build/mock-editor.sh");
    return send(200, "text/javascript; charset=utf-8", fs.readFileSync(f));
  }
  if ((m = u.pathname.match(/^\/project\/mock\/file\/(\w+)$/)) && files.has(fileIds.get(m[1])))
    return send(200, "application/octet-stream", files.get(fileIds.get(m[1])));
  if (u.pathname === "/project/mock/replace" && req.method === "POST") {
    const parts = [];
    req.on("data", (c) => parts.push(c));
    req.on("end", () => {
      const p = u.searchParams.get("path"), id = `f${String(++n).padStart(23, "0")}`;
      files.set(p, Buffer.concat(parts));
      fileIds.set(id, p);
      say("removeEntity", ["old", "upload"]);
      say("reciveNewFile", ["root", { _id: id, name: path.basename(p) }, "upload", null, "me"]);
      send(204, "text/plain", "");
    });
    return;
  }
  if (u.pathname === "/project/mock/root-doc" && req.method === "POST") {
    rootPath = u.searchParams.get("path");
    say("rootDocUpdated", [docId(rootPath)]);
    return send(204, "text/plain", "");
  }
  if (u.pathname === "/project/mock/entities")
    return send(200, "application/json", JSON.stringify({ project_id: "mock", entities: [...docs.values()].map((d) => ({ path: "/" + d.path, type: "doc" })).concat([...files.keys()].map((p) => ({ path: "/" + p, type: "file" }))) }));
  if (u.pathname === "/project/mock/docs")
    return send(200, "application/json", JSON.stringify([...docs].map(([id, d]) => ({ id, ...d }))));
  if ((m = u.pathname.match(/^\/project\/mock\/doc\/(\w+)\/download$/)) && docs.has(m[1]))
    return send(200, "text/plain; charset=utf-8", docs.get(m[1]).text);
  if ((m = u.pathname.match(/^\/project\/mock\/doc\/(\w+)$/)) && req.method === "POST") {
    let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => { const d = docs.get(m[1]); if (!d) return send(404, "text/plain", "no such doc"); d.text = b; send(204, "text/plain", ""); });
    return;
  }
  if (u.pathname === "/project/mock/download/zip") {
    const z = zip([...[...docs.values()].map((d) => [d.path, d.text]), ...files]);
    // (PHITEX_SLOWZIP=kbit/s: the ZIP trickled, as a slow connection sends a big project)
    const kbps = +(process.env.PHITEX_SLOWZIP ?? 0);
    if (!kbps) return send(200, "application/zip", z);
    res.writeHead(200, { "content-type": "application/zip", "content-length": String(z.length), ...iso });
    const step = Math.max(256, Math.round((kbps * 1000) / 8 / 10));
    let at = 0;
    const tick = setInterval(() => {
      res.write(z.subarray(at, (at += step)));
      if (at >= z.length) (clearInterval(tick), res.end());
    }, 100);
    return;
  }
  if (u.pathname === "/project/mock/compile" && req.method === "POST")
    return void compile().then((c) => send(200, "application/json", JSON.stringify(c)));
  if (u.pathname === "/project/mock/output/output.pdf" && fs.existsSync(path.join(OUT, "output.pdf")))
    return send(200, "application/pdf", fs.readFileSync(path.join(OUT, "output.pdf")));
  if (u.pathname === "/project/mock/output/output.log" && fs.existsSync(path.join(OUT, "output.log")))
    return send(200, "text/plain; charset=utf-8", fs.readFileSync(path.join(OUT, "output.log")));
  send(404, "text/plain", "not found");
}).on("upgrade", (req, socket) => {
  const accept = crypto.createHash("sha1").update(req.headers["sec-websocket-key"] + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  sockets.add(socket);
  socket.write(frame("joinProjectResponse", [{ project: { _id: "mock", name: "mock", rootDoc_id: rootPath && docId(rootPath), rootFolder: folderTree() }, permissionsLevel: "owner", protocolVersion: 2 }]));
  socket.on("close", () => sockets.delete(socket));
  socket.on("error", () => sockets.delete(socket));
}).listen(port, () => console.log(`mock Overleaf on http://localhost:${port}/project/mock (${docs.size} docs, ${files.size} files)`));
