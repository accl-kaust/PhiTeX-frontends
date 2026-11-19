// Overleaf's history, exact to the character: every change the project's
// history has (its `/changes`, each with its version, its authors and its
// time), replayed from the first version, so that each character of the
// text as it is now is known by the change that typed it, and each one
// deleted by the change that deleted it. Nothing is guessed from times:
// `/diff`'s authors are runs merged across changes (project-history's
// DiffGenerator.compressDiff joins a user's adjacent inserts and keeps the
// earliest start and latest end), and its history resyncs turn inserts into
// unchanged text, so a run there can span many versions. `/changes` is the
// history itself: change k is version k → k+1, with `v2Authors` and its
// `timestamp`.
//
// The edit sessions (`/updates`, Overleaf's History list) group the changes:
// an update covers the changes [fromV, toV). Blame names a session and its
// author (an update may hold several people's edits; each character keeps
// its own); Changes' history lists the sessions, one lane, the labels as
// tags.
//
// Read as Overleaf's History view reads them (same origin, the user's own
// session), page by page, newest sessions first and the changes from the
// first, each page drawn as it comes; kept in the extension's storage by
// project, so a project opened again reads only the changes made since.

import type { PageFetch } from "./history.ts";
import { readZip } from "./common/zip.ts";

export interface OlUser {
  id?: string;
  first_name?: string;
  last_name?: string;
  email?: string;
}

export interface OlUpdate {
  fromV: number;
  toV: number;
  meta: { users?: (OlUser | null)[]; start_ts: number; end_ts: number };
  labels?: { comment: string; version?: number }[];
  pathnames?: string[];
  project_ops?: { add?: { pathname?: string }; rename?: { pathname?: string; newPathname?: string }; remove?: { pathname?: string } }[];
}

export interface OlLabel {
  id?: string;
  comment: string;
  version: number;
  created_at: string;
  user_display_name?: string;
}

type RawTracking = { type?: string };
type RawScan = number | string | { r: number; tracking?: RawTracking } | { i: string; tracking?: RawTracking; commentIds?: string[] };
/** A raw operation (overleaf-editor-core's Operation.toRaw). */
export type RawOp =
  | { pathname: string; file: { hash?: string; content?: string; rangesHash?: string; stringLength?: number; byteLength?: number } }
  | { pathname: string; textOperation: RawScan[] }
  | { pathname: string; newPathname: string }
  | { pathname: string; metadata: unknown }
  | Record<string, unknown>;
/** A raw change (Change.toRaw): its operations, ISO timestamp, authors. */
export interface RawChange {
  operations: RawOp[];
  timestamp: string;
  authors?: (number | null)[];
  v2Authors?: (string | null)[];
  projectVersion?: string;
}

/** A run of characters: inserted by change `v` (`o`: each one's writer where it was moved, else `v`), deleted by change `d` (-1: alive), a tracked deletion (`td`), and `p`, the change whose text it replaced (a skipped change's text goes back to it). */
interface Run {
  s: string;
  v: number;
  o: Int32Array | null;
  d: number;
  td: boolean;
  p: number;
}

/** A file in the replay: its runs (the deleted ones kept, as tombstones), binary or text, and the change that last touched it. */
interface FileState {
  runs: Run[];
  binary: boolean;
  last: number;
}

const BINARY = /\.(png|jpe?g|pdf|eps|ps|gif|bmp|tiff?|webp|zip|gz)$/i;

/** The writer of text the history had before its first change (a project whose history starts from a snapshot). */
export const FIRST = -2;

/** A character's writer: its change, or, moved with "keep its writer", the change that first typed it. */
const writer = (r: Run, k: number, moved: boolean) => (moved && r.o ? r.o[k] : r.v);

/** A user's name as Overleaf's history names them. */
export const userName = (u: OlUser | null | undefined) => (u ? [u.first_name, u.last_name].filter(Boolean).join(" ") || u.email || "someone" : "someone");

/**
 * The replay: the project's files as each change left them, every
 * character with the change that typed it (and the one that deleted it,
 * if any).
 */
export class Replay {
  files = new Map<string, FileState>();
  /** Changes applied (the version the files are at). */
  version = 0;
  /** Each change's authors (v2 ids) and time (ms). */
  authors: (string | null)[] = [];
  times: number[] = [];
  /** The last change's removed text, for moves: [author, time, segments]. */
  private removed: { who: string | null; at: number; segs: { s: string; o: Int32Array }[] } | null = null;

  /**
   * Change `c` (version `this.version` → +1) applied; `blob(hash)` a
   * file's text; `snapshot(v)` the project's text files at version `v`, for
   * a file edited that no change added (a history that starts from a
   * snapshot: its text the first version's, FIRST).
   */
  async apply(c: RawChange, blob: (hash: string) => Promise<string | null>, snapshot?: (v: number) => Promise<Record<string, string>>): Promise<void> {
    const i = this.version;
    const who = c.v2Authors?.[0] ?? (c.authors?.[0] != null ? String(c.authors[0]) : null);
    const at = Date.parse(c.timestamp);
    this.authors[i] = who;
    this.times[i] = at;
    const removed: { s: string; o: Int32Array }[] = [];
    const inserted: Run[] = [];
    // (the same author's change just before, within ten minutes: its removed text, for a paste after a cut)
    const prev = this.removed && this.removed.who === who && at - this.removed.at < 10 * 60e3 ? this.removed.segs : [];
    for (const op of c.operations) {
      const path = typeof op.pathname === "string" ? op.pathname.replace(/^\//, "") : "";
      if ("file" in op && op.file && typeof op.file === "object") {
        const f = op.file as { hash?: string; content?: string; rangesHash?: string; byteLength?: number; stringLength?: number };
        const binary = BINARY.test(path) || (f.byteLength !== undefined && f.stringLength === undefined);
        let text: string | null = null;
        if (!binary) text = typeof f.content === "string" ? f.content : f.hash ? await blob(f.hash) : "";
        const runs: Run[] = text ? [{ s: text, v: i, o: null, d: -1, td: false, p: i }] : [];
        // (tracked deletions in the file as added: its ranges' blob)
        if (text && f.rangesHash) {
          const r = await blob(f.rangesHash).catch(() => null);
          const tracked = (r ? (JSON.parse(r) as { trackedChanges?: { range: { pos: number; length: number }; tracking: RawTracking }[] }).trackedChanges : undefined) ?? [];
          for (const t of tracked) if (t.tracking?.type === "delete") this.mark(runs, t.range.pos, t.range.length);
        }
        this.files.set(path, { runs, binary: text === null, last: i });
      } else if ("newPathname" in op) {
        const to = String(op.newPathname ?? "").replace(/^\//, "");
        const f = this.files.get(path);
        this.files.delete(path);
        if (to && f) this.files.set(to, { ...f, last: i });
      } else if ("textOperation" in op && Array.isArray(op.textOperation)) {
        let f = this.files.get(path);
        if (!f && snapshot) {
          const snap = await snapshot(i);
          for (const [p, t] of Object.entries(snap)) if (!this.files.has(p)) this.files.set(p, { runs: t ? [{ s: t, v: FIRST, o: null, d: -1, td: false, p: FIRST }] : [], binary: false, last: FIRST });
          f = this.files.get(path);
        }
        if (!f) continue;
        f.runs = this.edit(f.runs, op.textOperation as RawScan[], i, removed, inserted, prev);
        f.last = i;
      }
    }
    this.removed = removed.length ? { who, at, segs: removed } : this.removed && this.removed.who === who ? this.removed : null;
    this.version = i + 1;
  }

  /** Characters [pos, pos + n) of the alive text marked tracked deletions. */
  private mark(runs: Run[], pos: number, n: number): void {
    const out = this.split(runs, pos);
    const end = this.split(out, pos + n);
    let at = 0;
    for (const r of end) {
      if (r.d >= 0) continue;
      if (at >= pos && at < pos + n) r.td = true;
      at += r.s.length;
    }
    runs.splice(0, runs.length, ...end);
  }

  /** The runs with a boundary at alive offset `pos`. */
  private split(runs: Run[], pos: number): Run[] {
    const out: Run[] = [];
    let at = 0;
    for (const r of runs) {
      if (r.d >= 0 || pos <= at || pos >= at + r.s.length) {
        out.push(r);
        if (r.d < 0) at += r.s.length;
        continue;
      }
      const k = pos - at;
      out.push({ ...r, s: r.s.slice(0, k), o: r.o && r.o.slice(0, k) }, { ...r, s: r.s.slice(k), o: r.o && r.o.slice(k) });
      at += r.s.length;
    }
    return out;
  }

  /** A text operation applied to a file's runs (overleaf-editor-core's TextOperation, positions in the alive text). */
  private edit(runs: Run[], ops: RawScan[], i: number, removed: { s: string; o: Int32Array }[], inserted: Run[], prev: { s: string; o: Int32Array }[]): Run[] {
    const out: Run[] = [];
    let k = 0;
    let cur: Run | null = null;
    // (the next run to read from: the rest of one split, or the next whole one; tombstones passed through)
    const next = (): Run | null => {
      for (;;) {
        if (cur) return cur;
        if (k >= runs.length) return null;
        const r = runs[k++];
        if (r.d >= 0 || !r.s.length) out.push(r);
        else cur = r;
      }
    };
    /** `n` alive characters taken, each run's part changed by `f`. */
    const take = (n: number, f: (r: Run) => Run) => {
      while (n > 0) {
        const r = next();
        if (!r) throw new Error("history: an operation longer than its file");
        if (r.s.length <= n) {
          out.push(f(r));
          n -= r.s.length;
          cur = null;
        } else {
          out.push(f({ ...r, s: r.s.slice(0, n), o: r.o && r.o.slice(0, n) }));
          cur = { ...r, s: r.s.slice(n), o: r.o && r.o.slice(n) };
          n = 0;
        }
      }
    };
    /** The writer of the alive character before the place reached (what an insert there replaces, if nothing was deleted). */
    const before = () => {
      for (let j = out.length - 1; j >= 0; j--) if (out[j].d < 0 && out[j].s.length) return out[j].o ? out[j].o![out[j].s.length - 1] : out[j].v;
      return i;
    };
    let lastDel = -1;
    for (const op of ops) {
      if (typeof op === "number" && op > 0) take(op, (r) => r), (lastDel = -1);
      else if (typeof op === "object" && op && "r" in op) {
        const t = op.tracking?.type;
        take(op.r, (r) => (t === "delete" ? { ...r, td: true } : t === "none" || t === "insert" ? { ...r, td: false } : r));
        lastDel = -1;
      } else if (typeof op === "string" || (typeof op === "object" && op && "i" in op)) {
        const s = typeof op === "string" ? op : op.i;
        const td = typeof op === "object" && op.tracking?.type === "delete";
        const r: Run = { s, v: i, o: null, d: -1, td, p: lastDel >= 0 ? lastDel : before() };
        out.push(r);
        inserted.push(r);
      } else if (typeof op === "number" && op < 0) {
        // (the text removed, whole, with each character's writer: an insert of it elsewhere is a move)
        let text = "";
        const os: Int32Array[] = [];
        take(-op, (r) => {
          const o = r.o ?? new Int32Array(r.s.length).fill(r.v);
          text += r.s;
          os.push(o);
          return { ...r, d: i };
        });
        const o = new Int32Array(text.length);
        let k = 0;
        for (const x of os) o.set(x, k), (k += x.length);
        removed.push({ s: text, o });
        lastDel = o[0] ?? lastDel;
      }
    }
    // (the rest, as it was)
    if (cur) out.push(cur);
    for (; k < runs.length; k++) out.push(runs[k]);
    // (text moved: an insert of 12 characters or more that this change, or the same author's change just
    // before, removed whole keeps who first wrote each character)
    for (const r of inserted) {
      if (r.o || r.s.length < 12 || !/\S/.test(r.s)) continue;
      for (const seg of [...removed, ...prev]) {
        const at = seg.s.indexOf(r.s);
        if (at >= 0) {
          r.o = seg.o.slice(at, at + r.s.length);
          break;
        }
      }
    }
    // (adjacent runs alike merged: the list stays short)
    const merged: Run[] = [];
    for (const r of out) {
      const m = merged.at(-1);
      if (m && !m.o && !r.o && m.v === r.v && m.d === r.d && m.td === r.td && m.p === r.p) m.s += r.s;
      else merged.push(r.o || !r.s.length ? r : { ...r });
    }
    return merged.filter((r) => r.s.length);
  }

  /**
   * A file's text at version `at` (every change before it applied; tracked
   * deletions out, as the editor and the compile have it) with each
   * character's writer (a change index; `moved`: moved text its first
   * writer), and its deleter where `dels` asks.
   */
  textAt(path: string, at = this.version, moved = true): { text: string; who: Int32Array } | null {
    const f = this.files.get(path);
    if (!f || f.binary) return null;
    let text = "";
    const who: number[] = [];
    for (const r of f.runs) {
      if (r.v >= at || (r.d >= 0 && r.d < at) || (r.td && at >= this.version)) continue;
      text += r.s;
      for (let k = 0; k < r.s.length; k++) who.push(writer(r, k, moved));
    }
    return { text, who: Int32Array.from(who) };
  }

  /** Each character of `path` alive at `from` that a change in [from, to) deleted, by offset in the text at `from`: the deleter. */
  deletedAt(path: string, from: number, to: number): Map<number, number> {
    const f = this.files.get(path);
    const out = new Map<number, number>();
    if (!f) return out;
    let at = 0;
    for (const r of f.runs) {
      if (r.v >= from || (r.d >= 0 && r.d < from)) continue;
      if (r.d >= from && r.d < to) for (let k = 0; k < r.s.length; k++) out.set(at + k, r.d);
      at += r.s.length;
    }
    return out;
  }

  /** The replaced text's writer for each character typed by change `v` (a skipped change's text goes back to it). */
  previous(path: string): Map<number, number> {
    const f = this.files.get(path);
    const out = new Map<number, number>();
    for (const r of f?.runs ?? []) if (r.v !== r.p) out.set(r.v, r.p);
    return out;
  }

  /** The text alive now (tracked deletions out) as runs [from, to, change], a skipped change's text its predecessor's. */
  runsNow(path: string, moved: boolean, skip: (v: number) => boolean): { text: string; runs: [number, number, number][] } | null {
    const f = this.files.get(path);
    if (!f || f.binary) return null;
    let text = "";
    const runs: [number, number, number][] = [];
    const push = (a: number, b: number, v: number) => {
      const l = runs.at(-1);
      if (l && l[2] === v && l[1] === a) l[1] = b;
      else runs.push([a, b, v]);
    };
    for (const r of f.runs) {
      if (r.d >= 0 || r.td) continue;
      const at = text.length;
      text += r.s;
      for (let k = 0; k < r.s.length; k++) {
        let v = writer(r, k, moved);
        if (skip(v)) v = r.p;
        push(at + k, at + k + 1, v);
      }
    }
    return { text, runs };
  }

  /** The change that last touched a binary file (an image), or -1. */
  lastChange(path: string): number {
    return this.files.get(path)?.last ?? -1;
  }
}

/** Where the history is kept between visits: the extension's storage. */
export interface HistoryStore {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<void>;
}

/** What the history is doing, for the popover's progress line. */
export type Progress = (text: string, done?: number, total?: number) => void;

/**
 * A project's history: its sessions (updates) and labels, and its replay,
 * each read page by page as asked, newest sessions first and the changes
 * from the first; the changes and the files' first texts kept in `store`
 * by project, a project opened again reading only what is new.
 */
export class ProjectHistory {
  private base: () => string;
  private fetcher: PageFetch;
  private store: HistoryStore | undefined;
  updates: OlUpdate[] = [];
  private updatesDone = false;
  private updatesNext: number | undefined;
  private updatesBusy: Promise<void> | null = null;
  users = new Map<string, OlUser>();
  private labelsP: Promise<OlLabel[]> | null = null;
  private replayP: Promise<Replay> | null = null;
  private replayed: Replay | null = null;
  private raw: RawChange[] = [];
  private blobs = new Map<string, string | null>();
  private listeners: Progress[] = [];
  /** Aborted when the project is left: no read goes on. */
  readonly abort = new AbortController();
  /** The latest version (the first page's newest session's toV). */
  latest = 0;

  constructor(base: () => string, fetcher: PageFetch, store?: HistoryStore) {
    this.base = base;
    this.fetcher = fetcher;
    this.store = store;
  }

  /** `f` told what the history is doing; the returned function stops it. */
  onProgress(f: Progress): () => void {
    this.listeners.push(f);
    return () => void (this.listeners = this.listeners.filter((x) => x !== f));
  }

  private say(text: string, done?: number, total?: number): void {
    for (const f of this.listeners) f(text, done, total);
  }

  /** Reads under way: the progress line said while any is, cleared once none is (a moment after, so pages in a row do not flicker it). */
  private reads = 0;
  private async reading<T>(f: () => Promise<T>): Promise<T> {
    this.reads++;
    try {
      return await f();
    } finally {
      this.reads--;
      setTimeout(() => this.reads || this.say(""), 150);
    }
  }

  private async get<T>(u: string): Promise<T> {
    if (this.abort.signal.aborted) throw new Error("the project was left");
    const r = await this.fetcher(`${this.base()}${u}`, { credentials: "include" });
    if (!r.ok) throw new Error(`Overleaf answered ${r.status} for ${u.replace(/\?.*/, "")}`);
    return (await r.json()) as T;
  }

  /** The project's id (its storage key). */
  private key(): string {
    return `olhist:${this.base().replace(/.*\//, "")}`;
  }

  labels(): Promise<OlLabel[]> {
    this.labelsP ??= this.get<OlLabel[]>("/labels").catch((e) => ((this.labelsP = null), Promise.reject(e)));
    return this.labelsP;
  }

  /** The next page of sessions (newest first), appended; resolved once read. */
  moreUpdates(): Promise<void> {
    if (this.updatesDone) return Promise.resolve();
    this.updatesBusy ??= this.reading(async () => {
      try {
        const page = await this.get<{ updates: OlUpdate[]; nextBeforeTimestamp?: number }>(`/updates?min_count=100${this.updatesNext ? `&before=${this.updatesNext}` : ""}`);
        for (const u of page.updates) for (const w of u.meta.users ?? []) if (w?.id) this.users.set(w.id, w);
        this.updates.push(...page.updates);
        if (!this.latest && page.updates[0]) this.latest = page.updates[0].toV;
        this.updatesNext = page.nextBeforeTimestamp;
        this.updatesDone = !page.nextBeforeTimestamp;
        const oldest = this.updates.at(-1)?.fromV ?? 0;
        this.say(this.updatesDone ? "" : `Reading history… ${(this.latest - oldest).toLocaleString()} of ~${this.latest.toLocaleString()} edits`, this.latest - oldest, this.latest);
      } finally {
        this.updatesBusy = null;
      }
    });
    return this.updatesBusy;
  }

  /** Whether every session is read. */
  get allUpdates(): boolean {
    return this.updatesDone;
  }

  /** The session holding change `i` (fromV ≤ i < toV), reading older pages as needed. */
  async updateOf(i: number): Promise<OlUpdate | null> {
    for (;;) {
      const u = this.updates.find((x) => x.fromV <= i && i < x.toV);
      if (u) return u;
      if (this.updatesDone) return null;
      await this.moreUpdates();
    }
  }

  private async blob(hash: string): Promise<string | null> {
    if (this.blobs.has(hash)) return this.blobs.get(hash)!;
    const r = await this.fetcher(`${this.base()}/blob/${hash}`, { credentials: "include" });
    if (!r.ok) throw new Error(`Overleaf answered ${r.status} for a file's first text`);
    const bytes = new Uint8Array(await r.arrayBuffer());
    let text: string | null;
    try {
      text = bytes.includes(0) ? null : new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      text = null;
    }
    this.blobs.set(hash, text);
    return text;
  }

  /**
   * The replay of every change, from the first: the changes kept from an
   * earlier visit applied at once, then the new ones read page by page
   * (`/changes?since=N&paginated=true`), each page applied as it comes;
   * read again to the newest version whenever asked (`fresh`).
   */
  replay(fresh = false): Promise<Replay> {
    // (one read at a time: a read under way reads to the newest version already, and two would apply each change twice)
    if (this.inflight) return this.inflight;
    if (this.replayP && !fresh) return this.replayP;
    const p = this.reading(() => this.read());
    this.inflight = this.replayP = p;
    p.then(
      () => undefined,
      () => this.replayP === p && (this.replayP = null),
    ).finally(() => this.inflight === p && (this.inflight = null));
    return p;
  }
  private inflight: Promise<Replay> | null = null;

  private async read(): Promise<Replay> {
    if (!this.raw.length && this.store) {
      const kept = (await this.store.get(this.key()).catch(() => undefined)) as { raw?: RawChange[]; blobs?: [string, string | null][] } | undefined;
      if (kept?.raw?.length) {
        this.raw = kept.raw;
        for (const [h, t] of kept.blobs ?? []) this.blobs.set(h, t);
      }
    }
    const r = this.replayed ?? new Replay();
    // (what is kept, applied, yielding to the page now and then)
    const total = () => Math.max(this.latest, this.raw.length);
    if (!this.latest) await this.moreUpdates().catch(() => undefined);
    let tick = performance.now();
    const snapshot = async (v: number) => {
      const z = await this.fetcher(`${this.base()}/version/${v}/zip`, { credentials: "include" });
      if (!z.ok) throw new Error(`Overleaf answered ${z.status} for version ${v}`);
      return (await readZip(await z.arrayBuffer())).files;
    };
    const apply = async () => {
      while (r.version < this.raw.length) {
        await r.apply(this.raw[r.version], (h) => this.blob(h), snapshot);
        if (performance.now() - tick > 12) {
          this.say(`Working out who wrote each character… ${r.version.toLocaleString()} of ${total().toLocaleString()} edits`, r.version, total());
          await new Promise((ok) => setTimeout(ok, 0));
          if (this.abort.signal.aborted) throw new Error("the project was left");
          tick = performance.now();
        }
      }
    };
    await apply();
    for (;;) {
      this.say(`Reading history… ${this.raw.length.toLocaleString()} of ~${total().toLocaleString()} edits`, this.raw.length, total());
      const page = await this.get<{ changes: RawChange[]; hasMore: boolean } | RawChange[]>(`/changes?since=${this.raw.length}&paginated=true`);
      const changes = Array.isArray(page) ? page : page.changes;
      this.raw.push(...changes);
      await apply();
      if (Array.isArray(page) || !page.hasMore || !changes.length) break;
    }
    if (this.raw.length > this.latest) this.latest = this.raw.length;
    this.replayed = r;
    this.say("");
    // (kept for the next visit: the changes and the files' first texts)
    void this.store?.set(this.key(), { raw: this.raw, blobs: [...this.blobs] }).catch(() => undefined);
    return r;
  }
}
