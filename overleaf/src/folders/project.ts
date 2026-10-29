// A Storage in an Overleaf project of the user's, ".phitex-data": its data/folders.json,
// versioned by Overleaf's history like any file. Plain HTTP, the editor's
// own endpoints (services/web/app/src/Features/{Uploads,Editor,Project}):
// - write: an upload replacing data/folders.json; the upload wants its
//   folder's id, and nothing outside the editor's socket gives the root
//   folder's, so the file sits in a folder "data", made once (its id is
//   returned then), whose id the file itself keeps;
// - read: the file by its id (each upload gives it a new one: a 404 means
//   another tab or device wrote since), else from the project's zip, by path;
// - made from a zip upload, with a main.tex saying what it is (readme.ts),
//   at the first write, never by reading: until the user makes a folder or
//   gives a status (and agrees to the project, main.ts), nothing is made.

import type { State } from "./folders.ts";
import { call, csrf, fetchProjects, listProjects } from "./overleaf.ts";
import { README_TEX } from "./readme.ts";
import type { Storage } from "./sync.ts";

export const PROJECT_NAME = ".phitex-data";
const FILE = "folders.json";
/** The storage's ids remembered in this browser, per project name. */
const CACHE = "phitex:storage:";

/** The file as stored: the state, and its folder's id. */
type Stored = State & { dataFolder: string };

export function projectStorage(name = PROJECT_NAME): Storage & { find(): Promise<string | null>; projectId(): Promise<string> } {
  // (remembered per browser: which project, the file's current id, its folder's)
  let cache: { project?: string; file?: string; folder?: string } = {};
  try {
    cache = JSON.parse(localStorage.getItem(CACHE + name) ?? "{}");
  } catch {}
  const remember = (c: typeof cache) => {
    cache = { ...cache, ...c };
    try {
      localStorage.setItem(CACHE + name, JSON.stringify(cache));
    } catch {}
  };

  /** The project found or made here: the page's list, from its load, doesn't have one made since. */
  let known: string | null = null;
  /** The storage project's id: the user's own, not trashed, named `name`; null if none (`fresh`: asked for, not the page's list). */
  const find = async (fresh = false) => {
    if (known) return known;
    const mine = (await (fresh ? fetchProjects() : listProjects())).filter((p) => p.name === name && p.accessLevel === "owner" && !p.trashed);
    // (the one remembered, if still there, else the oldest: two made at once by two tabs, the first wins)
    const p = mine.find((p) => p.id === cache.project) ?? mine.sort((a, b) => a.id.localeCompare(b.id))[0];
    if (p) remember({ project: p.id });
    return (known = p?.id ?? null);
  };
  let made: Promise<string> | null = null;
  /** The storage project's id, made if none (a write's). */
  const projectId = () =>
    (made ??= (async () => {
      // (another tab or device may have made it since this page loaded: asked for, not the page's list)
      const found = await find(true);
      if (found) return found;
      const body = new FormData();
      body.append("name", `${name}.zip`);
      body.append("qqfile", zip({ "main.tex": README_TEX }), `${name}.zip`);
      const r = await fetch("/project/new/upload", { method: "POST", headers: { "X-Csrf-Token": csrf(), Accept: "application/json" }, body });
      const out = await r.json().catch(() => ({}));
      if (!r.ok || !out.project_id) throw new Error(`Couldn't make the project "${name}" (${out.error ?? r.status})`);
      remember({ project: out.project_id, file: undefined, folder: undefined });
      return (known = out.project_id as string);
    })().catch((e) => ((made = null), Promise.reject(e))));

  const parse = (text: string): State => {
    const { dataFolder, ...s } = JSON.parse(text) as Stored;
    remember({ folder: dataFolder });
    return s;
  };

  return {
    find,
    projectId,
    async read() {
      // (none yet: no folders, and nothing made by reading)
      const project = await find();
      if (!project) return null;
      if (cache.file) {
        const r = await fetch(`/Project/${project}/file/${cache.file}`, { cache: "no-store" });
        if (r.ok) return parse(await r.text());
      }
      const text = await fromZip(project, `data/${FILE}`);
      remember({ file: undefined });
      return text === null ? null : parse(text);
    },
    async write(s) {
      const project = await projectId();
      if (!cache.folder) {
        // (a first write: the folder too; one already there, made by an earlier
        // write whose file can't be read, fails, as it should)
        const folder = await call("POST", `/project/${project}/folder`, { name: "data" });
        remember({ folder: folder._id });
      }
      const body = new FormData();
      body.append("name", FILE);
      body.append("qqfile", new Blob([JSON.stringify({ ...s, dataFolder: cache.folder }, null, 1)], { type: "application/json" }), FILE);
      const r = await fetch(`/Project/${project}/upload?folder_id=${cache.folder}`, { method: "POST", headers: { "X-Csrf-Token": csrf(), Accept: "application/json" }, body });
      const out = await r.json().catch(() => ({}));
      if (!r.ok || !out.success) {
        // (its folder gone, deleted in the editor: made again by the next try)
        if (out.error === "folder_not_found") remember({ folder: undefined });
        throw new Error(`Couldn't save the folders to "${name}" (${out.error ?? r.status})`);
      }
      remember({ file: out.entity_id });
    },
  };
}

/** A file of a project, read from its zip download; null if not in it. */
async function fromZip(project: string, path: string): Promise<string | null> {
  const r = await fetch(`/Project/${project}/download/zip`, { cache: "no-store" });
  if (!r.ok) throw new Error(`Couldn't read the folders (${r.status} on the project's zip)`);
  const zip = new Uint8Array(await r.arrayBuffer());
  const v = new DataView(zip.buffer);
  // (the central directory, from its end record: the last 22+ bytes)
  let end = zip.length - 22;
  while (end >= 0 && v.getUint32(end, true) !== 0x06054b50) end--;
  if (end < 0) throw new Error("Couldn't read the folders (not a zip)");
  for (let i = 0, p = v.getUint32(end + 16, true); i < v.getUint16(end + 10, true); i++) {
    const nameLen = v.getUint16(p + 28, true);
    const name = new TextDecoder().decode(zip.subarray(p + 46, p + 46 + nameLen));
    if (name === path) {
      const local = v.getUint32(p + 42, true);
      const start = local + 30 + v.getUint16(local + 26, true) + v.getUint16(local + 28, true);
      const data = zip.subarray(start, start + v.getUint32(p + 20, true));
      const stream = new Blob([data]).stream();
      return new Response(v.getUint16(p + 10, true) === 8 ? stream.pipeThrough(new DecompressionStream("deflate-raw")) : stream).text();
    }
    p += 46 + nameLen + v.getUint16(p + 30, true) + v.getUint16(p + 32, true);
  }
  return null;
}

/** A zip of text files, stored (not compressed): what Overleaf makes a project from. */
function zip(files: Record<string, string>): Blob {
  const enc = new TextEncoder();
  const parts: BlobPart[] = [];
  const dir: BlobPart[] = [];
  let offset = 0;
  let dirSize = 0;
  const names = Object.keys(files);
  for (const name of names) {
    const n = enc.encode(name);
    const data = enc.encode(files[name]);
    const crc = crc32(data);
    // (its local header, then its entry in the central directory: version 2.0, stored, 1980-01-01)
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true);
    local.setUint16(12, 0x21, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, data.length, true);
    local.setUint32(22, data.length, true);
    local.setUint16(26, n.length, true);
    parts.push(local, n, data);
    const entry = new DataView(new ArrayBuffer(46));
    entry.setUint32(0, 0x02014b50, true);
    entry.setUint16(4, 20, true);
    entry.setUint16(6, 20, true);
    entry.setUint16(14, 0x21, true);
    entry.setUint32(16, crc, true);
    entry.setUint32(20, data.length, true);
    entry.setUint32(24, data.length, true);
    entry.setUint16(28, n.length, true);
    entry.setUint32(42, offset, true);
    dir.push(entry, n);
    offset += 30 + n.length + data.length;
    dirSize += 46 + n.length;
  }
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, names.length, true);
  end.setUint16(10, names.length, true);
  end.setUint32(12, dirSize, true);
  end.setUint32(16, offset, true);
  return new Blob([...parts, ...dir, end], { type: "application/zip" });
}

function crc32(data: Uint8Array): number {
  let c = ~0;
  for (const b of data) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}
