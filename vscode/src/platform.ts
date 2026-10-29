// VS Code's platform (common/src/platform.ts), in the extension host and in
// the core's worker threads alike: the extension's files from its folder on
// disk (laid out as the browser extension's package is: dist/core.wasm,
// texmf/, packs/, fonts/), the store a folder in the extension's global
// storage (a file a value, written whole then renamed in), Node's fetch.

import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { deserialize, serialize } from "node:v8";
import { bytesResponse, DATABASES, type KeyValue, type Platform } from "../../common/src/platform.ts";

const TYPES: Record<string, string> = { wasm: "application/wasm", json: "application/json", txt: "text/plain; charset=utf-8" };

/** Keys as file names: any key, no separator, no dot file. */
const file = (key: string) => "k" + encodeURIComponent(key).replace(/\*/g, "%2A");
const unfile = (name: string) => decodeURIComponent(name.slice(1));

/** The store in `dir`: a folder a store ("shelf.packs"), a file a key, its value as structured clone writes it (v8.serialize). */
export function fsKeyValue(dir: string): KeyValue {
  let seq = 0;
  // (a database's format (DATABASES) in "DB.format" beside its stores' folders: in any other,
  // its stores are emptied, once a process, before it is first used)
  const checked = new Map<string, Promise<void>>();
  const check = (db: string) => {
    let c = checked.get(db);
    if (!c) {
      const d = DATABASES[db];
      if (!d) return Promise.reject(new Error(`no database "${db}"`));
      const mark = join(dir, `${db}.format`);
      c = readFile(mark, "utf8").catch(() => "").then(async (found) => {
        if (found.trim() === String(d.format)) return;
        for (const s of d.stores) await rm(join(dir, `${db}.${s}`), { recursive: true, force: true });
        await mkdir(dir, { recursive: true });
        await writeFile(mark, `${d.format}\n`);
      });
      checked.set(db, c);
    }
    return c;
  };
  const ready = (store: string) => check(store.slice(0, store.indexOf(".")));
  const at = (store: string) => join(dir, store.replace(/[^\w.-]/g, "_"));
  const read = async <T>(p: string): Promise<T | undefined> => {
    try {
      return deserialize(await readFile(p)) as T;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw e;
    }
  };
  return {
    get: async <T>(store: string, key: string) => (await ready(store), read<T>(join(at(store), file(key)))),
    async all<T>(store: string) {
      await ready(store);
      const out = new Map<string, T>();
      const names = await readdir(at(store)).catch(() => [] as string[]);
      for (const n of names) {
        if (!n.startsWith("k")) continue;
        const v = await read<T>(join(at(store), n)).catch(() => undefined);
        if (v !== undefined) out.set(unfile(n), v);
      }
      return out;
    },
    async write(ops) {
      for (const [store] of ops) await ready(store);
      // (every value written aside first, then each renamed in: a failed write leaves none half-written)
      const written: [string, string | null][] = [];
      for (const [store, key, v] of ops) {
        const p = join(at(store), file(key));
        if (v === undefined) {
          written.push([p, null]);
          continue;
        }
        await mkdir(at(store), { recursive: true });
        const tmp = join(at(store), `.${process.pid}.${seq++}.tmp`);
        await writeFile(tmp, serialize(v));
        written.push([p, tmp]);
      }
      for (const [p, tmp] of written) await (tmp ? rename(tmp, p) : rm(p, { force: true }));
    },
    async clear(stores) {
      for (const s of stores) await ready(s);
      for (const s of stores) await rm(at(s), { recursive: true, force: true });
    },
  };
}

/** The platform for the extension at `root`, its store in `store`. */
export function nodePlatform(root: string, store: string): Platform {
  return {
    async asset(path) {
      try {
        const b = await readFile(join(root, path));
        return bytesResponse(new Uint8Array(b.buffer, b.byteOffset, b.byteLength), TYPES[path.replace(/^.*\./, "")]);
      } catch {
        // (as a browser's fetch of a file the package lacks: a 404, not a throw)
        return new Response(null, { status: 404 });
      }
    },
    assetUrl: (path) => pathToFileURL(join(root, path)).href,
    kv: fsKeyValue(store),
    // (Node's fetch keeps no HTTP cache: Shelf's packs are kept by packstore.ts)
    fetch: (url) => fetch(url),
  };
}
