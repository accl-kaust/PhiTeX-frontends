// Shelf's index (name → pack), kept up to date without a new extension.
//
// Shelf publishes release.json, the one file of it that changes:
//   {"release": "tl2026.7", "index": "index-tl2026.7.tsv.gz", "schema": 1,
//    "pack_table": "packs-tl2026.7.tsv.gz",
//    "min_extension": "0.7.0", "notice": null, "deps": ["pdftex", "xetex"],
//    "search": {"pdftex": {"tex": ["tex/latex", …], …}, "xetex": {…}}}
// and every release's index, pack table and packs, which never change
// (packs are named by their content, under h/; the pack table has each
// one's SHA-256 and size, and a pack is checked against it before it is
// kept or used). The extension ships an index and its pack table (the
// fallback, offline and on first run); at most once a day it reads
// release.json, and a newer release whose schema it reads (1: every file
// by its texmf path, resolved per engine by `search`, resolve.ts) has its
// index and pack table fetched and kept (the platform's store: IndexedDB,
// VS Code's global storage) with its release.json: the next worker reads
// those; a release without a pack table is not taken. The shipped index
// comes with its release.json (shelf-release.json) and pack table
// (shelf-packs.tsv.gzdata). `min_extension` and `notice` go to
// the tabs (an update asked for, a line shown); the extension keeps
// working either way (its index's packs stay on Shelf).
//
// Used by the offscreen document and the core's workers (one store).

import { shelfFetch } from "./shelf.ts";
import { platform } from "./platform.ts";
export { older } from "./version.ts";

import type { ReleaseMeta } from "./resolve.ts";

/** The index and pack format this extension reads (Shelf v1's 1: files by texmf path, per-engine search and deps; packs by content under h/, each in the pack table). */
export const SCHEMA = 1;

export interface Release extends ReleaseMeta {
  release: string;
  index: string;
  /** The pack table (gzipped TSV: `pack TAB sha256 TAB bytes`). */
  pack_table: string;
  schema: number;
  min_extension?: string;
  notice?: string | null;
  /** The files to fetch ahead (prefetch.ts), most papers' first: "name" or "name<TAB>engine" (Shelf's: xetex). */
  prefetch?: string[];
}

const DAY = 24 * 3600 * 1000;

const KV = "release.kv";
const get = <T>(k: string) => platform().kv.get<T>(KV, k);
const put = (entries: [string, unknown][]) => platform().kv.write(entries.map(([k, v]) => [KV, k, v]));

/**
 * The index to use and its pack table (both gzipped TSV), and its
 * release.json: the newest release fetched, else the one shipped (the
 * extension's files).
 */
export async function indexBytes(): Promise<{ gz: ReadableStream; table: ReadableStream; release: string; meta: ReleaseMeta }> {
  const shipped = (name: string) => platform().asset(name);
  const stream = (b: Uint8Array) => new Blob([b as BlobPart]).stream();
  try {
    // (an older schema's, kept without a pack table, is not this one's)
    const have = await get<{ release: string; gz: Uint8Array; table: Uint8Array; meta?: ReleaseMeta }>("index");
    if (have?.meta?.schema === SCHEMA && have.table) return { gz: stream(have.gz), table: stream(have.table), release: have.release, meta: have.meta };
  } catch {
    // (no IndexedDB: a private window's limits; the shipped one)
  }
  const [r, t] = await Promise.all([shipped("shelf-index.tsv.gzdata"), shipped("shelf-packs.tsv.gzdata")]);
  if (!r.ok) throw new Error(`shelf index: ${r.status}`);
  if (!t.ok) throw new Error(`shelf pack table: ${t.status}`);
  const meta = (await shipped("shelf-release.json").then((m) => m.json())) as ReleaseMeta;
  return { gz: r.body!, table: t.body!, release: "shipped", meta };
}

/**
 * Read release.json if a day has passed since the last look (or `force`),
 * and keep a newer release's index if this extension reads its schema.
 * The release as Shelf has it now (or as last seen), for the tabs.
 */
export async function refresh(force = false): Promise<Release | undefined> {
  const seen = await get<{ at: number; r: Release }>("seen").catch(() => undefined);
  if (!force && seen && Date.now() - seen.at < DAY) return seen.r;
  let r: Release;
  try {
    const res = await shelfFetch("release.json", { cache: "no-cache" });
    if (!res.ok) return seen?.r;
    r = (await res.json()) as Release;
  } catch {
    return seen?.r;
  }
  const entries: [string, unknown][] = [["seen", { at: Date.now(), r }]];
  // (none fetched yet: the shipped one's release, not fetched again)
  const have =
    (await get<{ release: string }>("index").catch(() => undefined))?.release ??
    (await platform().asset("shelf-release.json").then((x) => x.json() as Promise<{ release?: string }>).then((m) => m.release, () => undefined));
  // (this schema only: an index of another is not this extension's to read;
  // a release without a pack table is not taken)
  if (r.schema === SCHEMA && r.release !== have && r.pack_table) {
    const gzip = (name: string) => shelfFetch(name).then(async (x) => (x.ok ? new Uint8Array(await x.arrayBuffer()) : null), () => null);
    const [gz, table] = await Promise.all([gzip(r.index), gzip(r.pack_table)]);
    // (both gzip: one that isn't, a 404 page served as 200, is not kept)
    const isGz = (b: Uint8Array | null): b is Uint8Array => !!b && b.length > 2 && b[0] === 0x1f && b[1] === 0x8b;
    if (isGz(gz) && isGz(table)) entries.push(["index", { release: r.release, gz, table, meta: r }]);
  }
  await put(entries).catch(() => undefined);
  return r;
}

/** The release as last seen (refresh), if any. */
export async function latest(): Promise<Release | undefined> {
  return (await get<{ r: Release }>("seen").catch(() => undefined))?.r;
}
