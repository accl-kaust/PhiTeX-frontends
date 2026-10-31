// What a host of the core answers it with, the same in the browser (overleaf/
// src/worker.ts) and in VS Code's extension host (vscode/src/core.ts): the
// session's store over the platform's keys and values, falling back to the
// format the extension ships; Shelf's packs; Shelf's index; the packs a
// project will read, fetched all at once when it opens; and the document's
// language server as the editor talks to it (`lspChannel`), the caches,
// which are the host's, answered here.

import { platform } from "../platform.ts";
import type { Core, Store } from "./core.ts";
import { indexOnce } from "../release.ts";
import { packRaw, shipped } from "../shelf.ts";
import { allMeta, clearPacks } from "../packstore.ts";
import { Index, formatOf, shelfEngine, type ReleaseMeta } from "../resolve.ts";
import { referenced } from "../viewer/packages.ts";

const gunzip = async (s: ReadableStream) => new Uint8Array(await new Response(s.pipeThrough(new DecompressionStream("gzip"))).arrayBuffer());

const KV = "core.kv";

/**
 * A format's state the extension ships (formats/, scripts/make-formats.sh:
 * pdfLaTeX's, made by this very core.wasm, gzipped): `format/NAME` is
 * `formats/NAME.gzdata`, `format/NAME/pkgrec` `formats/NAME.pkgrec.gzdata`.
 * NAME holds the engine's identity, so a core.wasm other than the one that
 * made it never asks for it: it builds its own, as without one.
 */
async function shippedFormat(key: string): Promise<Uint8Array | null> {
  const name = key.slice("format/".length).replaceAll("/", ".");
  const r = await ours(`formats/${name}.gzdata`).catch(() => null);
  return r?.ok ? gunzip(r.body!) : null;
}

/** Files of ours being fetched ahead (warmFormats), by path: each taken once, by `ours`. */
const warming = new Map<string, Promise<Response>>();

/** One of our files (the platform's asset): the one fetched ahead if it was, else fetched now. */
function ours(path: string): Promise<Response> {
  const early = warming.get(path);
  warming.delete(path);
  return early ?? platform().asset(path);
}

function warm(path: string): void {
  const p = platform().asset(path);
  p.catch(() => undefined);
  warming.set(path, p);
}

/**
 * pdfLaTeX's shipped format (`formats/list.txt`: the web frontend's, one per
 * engine, scripts/build-web.sh) fetched now, while the core compiles,
 * instead of once it asks: a first visit's 5 MB beside its 22; and the
 * bundled texmf/ files a first build on each reads (`NAME.texmf.txt`,
 * recorded by build-web.sh), all at once instead of one by one as TeX
 * asks. Without the list (the extensions': their files are local, read
 * without the network), nothing.
 */
export async function warmFormats(): Promise<void> {
  const r = await platform().asset("formats/list.txt").catch(() => null);
  if (!r?.ok) return;
  // (pdfLaTeX's only, most documents' engine: another's format, XeLaTeX's 13 MB, fetched when a document asks for it, not by every visit)
  for (const name of (await r.text()).split("\n").filter((n) => n.startsWith("pdflatex-"))) {
    warm(`formats/${name}.gzdata`);
    warm(`formats/${name}.pkgrec.gzdata`);
    const t = await platform().asset(`formats/${name}.texmf.txt`);
    if (!t.ok) throw new Error(`formats/${name}.texmf.txt: ${t.status} (scripts/build-web.sh writes it)`);
    for (const f of (await t.text()).split("\n").filter(Boolean)) warm(`texmf/${f}`);
  }
}

/** A bundled texmf/ file by name (the core's `resolve`, every host's): its bytes, null if there is none. */
export async function texmfFile(name: string): Promise<{ path: string; bytes: Uint8Array } | null> {
  const r = await ours("texmf/" + name).catch(() => null);
  return r?.ok ? { path: name, bytes: new Uint8Array(await r.arrayBuffer()) } : null;
}

/**
 * The packs a first document reads beside format NAME (its fonts'
 * metrics, pdftex.map: `formats/NAME.packs.txt`, make-formats.sh's warm
 * build), fetched at once when the core reads the format: the build asks
 * for each only when it reaches it.
 */
async function formatPacks(key: string, core: Promise<Core>): Promise<void> {
  const r = await platform().asset(`formats/${key.slice("format/".length)}.packs.txt`).catch(() => null);
  if (!r?.ok) return;
  const c = await core;
  for (const id of (await r.text()).split("\n").filter(Boolean)) c.prefetch(id);
}

/** The session's store: the document's keys under `project()`'s, a format the extension ships when none is kept. */
export function coreStore(project: () => string, core: () => Promise<Core>): Store {
  const scoped = (key: string) => (key.startsWith("doc/") ? `doc/${project()}/${key.slice(4)}` : key);
  return {
    async get(key) {
      if (/^format\/[^/]+$/.test(key)) void formatPacks(key, core());
      const kept = await platform().kv.get<Uint8Array>(KV, scoped(key)).catch(() => undefined);
      used.build[kept ? "hits" : "misses"]++;
      if (kept) return kept;
      return key.startsWith("format/") ? shippedFormat(key) : null;
    },
    put: (key, bytes) => {
      used.build.last = Date.now();
      return platform().kv.write([[KV, scoped(key), bytes]]);
    },
  };
}

/**
 * Pack `id`, as Shelf serves it (gzip): one the extension ships (packs/),
 * else kept on this machine, else Shelf's. (The session tells what it
 * fetches: its progress, `{event: "progress", phase: "fetching"}`.)
 */
export async function pack(id: string, downloading?: () => void): Promise<Uint8Array> {
  if ((await shipped()).has(id)) return new Uint8Array(await (await platform().asset(`packs/${id}.pack`)).arrayBuffer());
  const { raw, from } = await packRaw(id, downloading);
  used.packages[from === "cache" ? "hits" : "misses"]++;
  return raw;
}

/** This session's use of the caches (the build's: the store's states; the packages': the packs kept). */
const used = { build: { hits: 0, misses: 0, last: 0 }, packages: { hits: 0, misses: 0 } };

/** A cache as `phitex.cacheStats` says it (docs/spec-editor-protocol.md). */
export interface CacheStat {
  scope: "build" | "packages";
  location: string;
  bytes: number;
  entries: number;
  last_used: string | null;
  hits: number;
  misses: number;
}

/** The caches, kept where `location` says (the host's words: a folder, "this browser"). */
export async function cacheStats(location: string): Promise<{ caches: CacheStat[] }> {
  const states = await platform().kv.all<Uint8Array>(KV);
  let bytes = 0;
  for (const b of states.values()) bytes += b.byteLength;
  const packs = await allMeta();
  let packBytes = 0,
    last = 0;
  for (const m of packs.values()) [packBytes, last] = [packBytes + m.bytes, Math.max(last, m.used)];
  const iso = (t: number) => (t ? new Date(t).toISOString() : null);
  return {
    caches: [
      { scope: "build", location, bytes, entries: states.size, last_used: iso(used.build.last), hits: used.build.hits, misses: used.build.misses },
      { scope: "packages", location, bytes: packBytes, entries: packs.size, last_used: iso(last), ...used.packages },
    ],
  };
}

/** The `scope` cache emptied ("build", "packages", "all"): the bytes it held. */
export async function clearCache(scope: string, location: string): Promise<{ freed_bytes: number }> {
  if (!["build", "packages", "all"].includes(scope)) throw new Error(`no cache ${JSON.stringify(scope)} (build, packages, all)`);
  const before = (await cacheStats(location)).caches;
  if (scope !== "packages") await platform().kv.clear([KV]);
  if (scope !== "build") await clearPacks();
  return { freed_bytes: before.filter((c) => scope === "all" || c.scope === scope).reduce((n, c) => n + c.bytes, 0) };
}

/** The document's language server as an editor talks to it: messages in (`send`), out (`onMessage`), until `close`. */
export interface LspChannel {
  send(m: any): void;
  onMessage(f: (m: any) => void): void;
  close(): void;
}

/**
 * The open document's language server (the core's, `Core.lsp`), the
 * caches' commands answered here: they are the host's (the server's own
 * answer would be "no command": core/src/main.rs).
 */
export function lspChannel(core: Core, location: string): LspChannel {
  const out: ((m: any) => void)[] = [];
  const unheard = core.onLsp((m) => out.forEach((f) => f(m)));
  const answer = (id: unknown, run: () => Promise<unknown>) =>
    void run().then(
      (result) => out.forEach((f) => f({ jsonrpc: "2.0", id, result })),
      (e) => out.forEach((f) => f({ jsonrpc: "2.0", id, error: { code: -32603, message: String((e as Error).message ?? e) } })),
    );
  return {
    send(m) {
      const c = m.method === "workspace/executeCommand" ? m.params?.command : undefined;
      if (c === "phitex.cacheStats") return answer(m.id, () => cacheStats(location));
      if (c === "phitex.clearCache") return answer(m.id, () => clearCache(String(m.params?.arguments?.[0]?.scope ?? "all"), location));
      core.lsp(m);
    },
    onMessage: (f) => void out.push(f),
    close: unheard,
  };
}

/** Shelf's index (its TSV, the release's metadata, its pack table's TSV) and the names the extension bundles (texmf/). */
export interface CoreIndex {
  tsv: Uint8Array;
  meta: ReleaseMeta;
  release: Uint8Array;
  table: Uint8Array;
  names: string[];
}

export async function coreIndex(): Promise<CoreIndex> {
  const { gz, table, meta } = await indexOnce();
  const names = (await (await platform().asset("texmf/names.txt")).text()).split("\n").filter(Boolean);
  const stream = (b: Uint8Array) => new Blob([b as BlobPart]).stream();
  return { tsv: await gunzip(stream(gz)), meta, release: new TextEncoder().encode(JSON.stringify(meta)), table: await gunzip(stream(table)), names };
}

/**
 * The packs a project's sources load (their \documentclass, \usepackage and
 * font names, packages.ts's scan), and those their loading reads (the
 * index's deps), fetched all at once when it opens: the core asks for each
 * file only when its build reaches it, one after another.
 */
const lookups = new WeakMap<CoreIndex, Index>();
export function prefetch(core: Core, ix: CoreIndex, files: Record<string, string>, engine: string): void {
  let lookup = lookups.get(ix);
  if (!lookup) lookups.set(ix, (lookup = new Index(new TextDecoder().decode(ix.tsv), ix.meta)));
  const bundled = new Set(ix.names);
  const e = shelfEngine(engine);
  const ids = new Set<string>();
  for (const name of new Set(Object.values(files).flatMap(referenced))) {
    if (name in files || bundled.has(name)) continue;
    const path = lookup.resolve(name, formatOf(name), e);
    if (path) for (const id of lookup.packs(path, e)) ids.add(id);
  }
  for (const id of ids) core.prefetch(id);
}

/**
 * The packs a compare's marked-up document loads besides the project's
 * (latexdiff's preambles, phitex-diff's: ulem and xcolor for its default
 * markup, footmisc and changebar for the others), and those their loading
 * reads, kept on this machine ahead of the first compare: its build then
 * waits on no download. Asked once a session, after the project's first
 * build (its own packs first).
 */
export async function warmDiff(ix: CoreIndex, engine: string): Promise<void> {
  let lookup = lookups.get(ix);
  if (!lookup) lookups.set(ix, (lookup = new Index(new TextDecoder().decode(ix.tsv), ix.meta)));
  const bundled = new Set(ix.names);
  const e = shelfEngine(engine);
  const ids = new Set<string>();
  // (and what a diff's build asked for beyond the project's, measured on the demo's
  // Article: atbegshi, grfext, the sans italic its markup sets added text in)
  for (const name of ["ulem.sty", "xcolor.sty", "footmisc.sty", "changebar.sty", "atbegshi.sty", "grfext.sty", "cmssi10.tfm", "cmssi10.pfb"]) {
    if (bundled.has(name)) continue;
    const path = lookup.resolve(name, formatOf(name), e);
    if (path) for (const id of lookup.packs(path, e)) ids.add(id);
  }
  for (const id of ids) await packRaw(id).catch(() => undefined);
}
