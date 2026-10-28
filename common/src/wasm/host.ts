// What a host of the core answers it with, the same in the browser (overleaf/
// src/worker.ts) and in VS Code's extension host (vscode/src/core.ts): the
// session's store over the platform's keys and values, falling back to the
// format the extension ships; Shelf's packs, the host told while one comes;
// Shelf's index; and the packs a project will read, fetched all at once
// when it opens.

import { platform } from "../platform.ts";
import type { Core, Store } from "./core.ts";
import { indexBytes } from "../release.ts";
import { packRaw, shipped } from "../shelf.ts";
import { hasPack } from "../packstore.ts";
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
  const r = await platform().asset(`formats/${name}.gzdata`).catch(() => null);
  return r?.ok ? gunzip(r.body!) : null;
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
      if (kept) return kept;
      return key.startsWith("format/") ? shippedFormat(key) : null;
    },
    put: (key, bytes) => platform().kv.write([[KV, scoped(key), bytes]]),
  };
}

/**
 * Pack `id`: one the extension ships (packs/), else kept on this machine,
 * else Shelf's, `tell` told while it comes (`fetching`, the session's
 * packages: one that could not be had, `failed`).
 */
export function packs(tell: (e: { event: "fetching"; pack: string; name: string; failed?: boolean }) => void): (id: string) => Promise<Uint8Array | null> {
  return async (id) => {
    if ((await shipped()).has(id)) return new Uint8Array(await (await platform().asset(`packs/${id}.pack`)).arrayBuffer());
    const kept = await hasPack(id).catch(() => false);
    // (by its name: the id less the content hash, `amsmath-0123456789ab`)
    const name = id.replace(/-[0-9a-f]{12}$/, "");
    if (!kept) tell({ event: "fetching", pack: name, name: id });
    try {
      return (await packRaw(id)).raw;
    } catch (e) {
      tell({ event: "fetching", pack: name, name: id, failed: true });
      throw e;
    }
  };
}

/** Shelf's index (its TSV, the release's metadata) and the names the extension bundles (texmf/). */
export interface CoreIndex {
  tsv: Uint8Array;
  meta: ReleaseMeta;
  release: Uint8Array;
  names: string[];
}

export async function coreIndex(): Promise<CoreIndex> {
  const { gz, meta } = await indexBytes();
  const names = (await (await platform().asset("texmf/names.txt")).text()).split("\n").filter(Boolean);
  return { tsv: await gunzip(gz), meta, release: new TextEncoder().encode(JSON.stringify(meta)), names };
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
