// The persisted graph (PhiTeX's docs/spec-persisted-graph.md): the
// engine's whole state after a build, which the next open of the same
// document loads, so that a project opened again builds only what changed
// since (nothing, unchanged: its pages at once). The core makes and checks
// it (its keys: the engine, the format, Shelf's release, the options, the
// files' contents; a stale or damaged one is a clean build, never a wrong
// PDF); the host keeps it, one a document, here: VS Code in its workspace
// storage, the browsers in IndexedDB (the extension's origin, the demo's).
//
// Past a cap, the least recently used go first: a graph is tens of MB
// (amsldoc's about 30, a 60-page XeLaTeX thesis chapter's about 60).

import type { KeyValue } from "../platform.ts";

/** A host's graphs, by document (`doc`: the host's name for it, its project's and its main file's). */
export interface GraphStore {
  /** The graph kept for `doc`; null: none. */
  get(doc: string): Promise<Uint8Array | null>;
  /** `doc`'s graph kept, over any before. */
  put(doc: string, bytes: Uint8Array): Promise<void>;
  /** `doc`'s graph dropped (the core refused it: cut or damaged). */
  drop(doc: string): Promise<void>;
  /** Whether graphs are kept (the host's setting; on by default). */
  on(): Promise<boolean>;
}

/** How many graphs, and how many bytes of them, a store keeps at most. */
export interface GraphCap {
  count: number;
  bytes: number;
}

/** The browsers' cap: 16 documents and 512 MB. */
export const BROWSER_CAP: GraphCap = { count: 16, bytes: 512 * 1048576 };

/** The stores (DATABASES' `graph`): the graphs, their sizes and last use, and the setting. */
const FILES = "graph.files";
const META = "graph.meta";
const KV = "graph.kv";

interface Meta {
  bytes: number;
  used: number;
}

/** Whether graphs are kept, in `kv` (its `graph.kv` "off"): the browsers' setting (the popup's, the demo's menu). */
export async function graphsOn(kv: KeyValue): Promise<boolean> {
  return !(await kv.get<boolean>(KV, "off").catch(() => false));
}

/** Graphs kept (`on`) or not, from now on; off drops every graph kept. */
export async function setGraphsOn(kv: KeyValue, on: boolean): Promise<void> {
  await kv.write([[KV, "off", on ? undefined : true]]);
  if (!on) await kv.clear([FILES, META]);
}

/** The graphs kept in `kv` and their bytes (the caches' count). */
export async function graphStats(kv: KeyValue): Promise<{ entries: number; bytes: number; used: number }> {
  const all = await kv.all<Meta>(META).catch(() => new Map<string, Meta>());
  let [bytes, used] = [0, 0];
  for (const m of all.values()) [bytes, used] = [bytes + m.bytes, Math.max(used, m.used)];
  return { entries: all.size, bytes, used };
}

/** Every graph kept in `kv` dropped (Clear cache). */
export async function clearGraphs(kv: KeyValue): Promise<void> {
  await kv.clear([FILES, META]);
}

/**
 * The graphs in `kv` (DATABASES' `graph`), `doc` under `project()`'s
 * name; past `cap` the least recently used dropped (a graph larger than
 * the cap alone is not kept). `on`: the host's setting, the browsers'
 * `graph.kv` by default.
 */
export function kvGraphs(kv: KeyValue, project: () => string, cap: GraphCap, on?: () => Promise<boolean>): GraphStore {
  const key = (doc: string) => `${project()}\u0000${doc}`;
  return {
    on: on ?? (() => graphsOn(kv)),
    async get(doc) {
      const k = key(doc);
      const b = await kv.get<Uint8Array>(FILES, k).catch(() => undefined);
      if (!b) return null;
      // (its use now: the last to go)
      await kv.write([[META, k, { bytes: b.byteLength, used: Date.now() } satisfies Meta]]).catch(() => undefined);
      return b;
    },
    async put(doc, bytes) {
      if (bytes.byteLength > cap.bytes) return;
      const k = key(doc);
      const all = await kv.all<Meta>(META).catch(() => new Map<string, Meta>());
      all.delete(k);
      // (the oldest dropped until this one fits beside the rest)
      const old = [...all].sort((a, b) => a[1].used - b[1].used);
      let [count, total] = [all.size + 1, bytes.byteLength];
      for (const [, m] of old) total += m.bytes;
      const drop: string[] = [];
      for (const [o, m] of old) {
        if (count <= cap.count && total <= cap.bytes) break;
        drop.push(o);
        count--;
        total -= m.bytes;
      }
      await kv.write([
        ...drop.flatMap((o): [string, string, unknown][] => [[FILES, o, undefined], [META, o, undefined]]),
        [FILES, k, bytes],
        [META, k, { bytes: bytes.byteLength, used: Date.now() } satisfies Meta],
      ]);
    },
    async drop(doc) {
      const k = key(doc);
      await kv.write([[FILES, k, undefined], [META, k, undefined]]);
    },
  };
}
