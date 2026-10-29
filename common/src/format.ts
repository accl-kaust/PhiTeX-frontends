// What every store the extensions keep is versioned by: a format number,
// kept with what is stored. Two kinds of store, two rules:
//
// - **The user's own** (the folders in .phitex-data, the extension's
//   settings): a format older than this extension's is taken through
//   each step up to it, nothing lost (`upgrade`); a newer one, written
//   by a newer extension (on another device, or before a downgrade), is
//   refused (`NewerFormat`): neither shown as if it were this one's, nor
//   ever written over.
// - **Caches** (Shelf's packs, the core's states, the release, the page's
//   copies): any other format, older or newer, is dropped and made again
//   (`current`): what they hold can always be had again.

/** Data stored by a newer extension than this one: refused, never written over. */
export class NewerFormat extends Error {
  readonly found: number;
  readonly reads: number;
  constructor(what: string, found: number, reads: number) {
    super(`${what} were saved by a newer PhiTeX Instant (format ${found}; this one reads up to ${reads}): update the extension`);
    this.found = found;
    this.reads = reads;
  }
}

/** From each older format to the next: `steps[n]` takes format n's data to n + 1's. */
export type Steps = Record<number, (old: any) => any>;

/**
 * `data` (with its `version`) in format `version`: an older one taken
 * through `steps`, one at a time; a newer one refused (NewerFormat).
 */
export function upgrade<T extends { version: number }>(what: string, data: unknown, version: number, steps: Steps): T {
  const found = (data as { version?: unknown } | null)?.version;
  if (typeof found !== "number" || !Number.isInteger(found) || found < 1) throw new Error(`${what}: no format version`);
  if (found > version) throw new NewerFormat(what, found, version);
  let d = data as { version: number };
  for (let n = found; n < version; n++) {
    const step = steps[n];
    if (!step) throw new Error(`${what}: no step from format ${n}`);
    d = { ...step(d), version: n + 1 };
  }
  return d as T;
}

/** A cache's content if it is in format `version`, else null: a cache of any other is made again. */
export function current<T>(kept: { v?: unknown; data?: T } | null | undefined, version: number): T | null {
  return kept?.v === version && kept.data !== undefined ? kept.data : null;
}

/** A cache or preference in the page's localStorage, if it is in format `version` (else null: made again). */
export function readLocal<T>(key: string, version: number): T | null {
  try {
    return current<T>(JSON.parse(localStorage.getItem(key) ?? "null"), version);
  } catch {
    return null;
  }
}

/** Keeps `data` in the page's localStorage, in format `version`. */
export function writeLocal(key: string, version: number, data: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify({ v: version, data }));
  } catch {}
}
