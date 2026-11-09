// Thread 0 of the core (core/: PhiTeX's live document, phitex-live, on
// wasm32-wasip1-threads): the module instantiated on a fresh shared memory,
// its exports called here, never waiting. What the core's threads tell
// (threads.ts) arrives on the core's BroadcastChannel: a Shelf pack the
// build needs (the core resolves names by Shelf's index itself,
// `setIndex`) is fetched by the host (`Fetch`: its bundled packs, its pack
// store, Shelf) and given back with `ph_pack`; a file asked by name (the
// bundled texmf/, or anything without the index) is the host's `Resolve`,
// given back with `ph_provide`; the session's stored bytes (the format's
// state, the records) are the host's `Store`, given back with `ph_stored`;
// meanwhile the thread that asked waits inside the core. An event (the
// viewer's, `phitex watch`'s own) goes to the host.
//
// The viewer's protocol is the core's own (phitex-live's Viewer): a
// request is answered at once, here, from the document's state (`request`),
// and what it asks of the document (an edit) wakes the core's session
// thread, which builds and tells `settled` when the pages are in.
// `CoreSession` is that as the viewer's `CoreTransport`, so a
// PreviewSession talks to the wasm core as it talks to `phitex watch` over
// its WebSocket.

import { type Spawn, type ThreadData, type ThreadMsg, PAGES_MAX, chooseSize, imports, newMemory, outgrownMessage } from "./threads.ts";
import { unsigned, wasi } from "./wasi.ts";
import type { CoreEvent, CoreReq, CoreRes, CoreTransport } from "../viewer/session.ts";

/**
 * The most threads a host gives the wasm engine (the user's call,
 * 2026-10-30): more cost it time, the engine's threads contending (the
 * 17-page TikZ demo's clean build in Overleaf: 87 s at 24 threads, 2.4 s
 * at 4); the engine's fix is under way (PhiTeX), this cap until then.
 */
export const WASM_THREADS = 4;

/** A file by name: its path as the build should report it, and its bytes; null if it is nowhere. */
export type Resolve = (name: string) => Promise<{ path: string; bytes: Uint8Array } | null>;
/** A Shelf pack by id, as Shelf serves it (gzip); null if it could not be had. */
/** Pack `id`, as Shelf serves it; `downloading` called when it goes to the network (not when kept on this machine). */
export type Fetch = (id: string, downloading?: () => void) => Promise<Uint8Array | null>;
/** What a `\write18` command did (PhiTeX's ShellRan, without `read`). */
/** `why`: the command was not run here, and why (the engine says it once, PhiTeX's shell.rs); none when it ran, whatever its status. */
export interface Ran {
  status: number;
  wrote: [string, Uint8Array][];
  removed: string[];
  why?: string;
}
/** Runs `command` (quoted by the engine) over exactly `files` (minted.ts). */
export type Shell = (command: string, files: [string, Uint8Array][]) => Promise<Ran>;
/**
 * What the session keeps between sessions, by key (core/src/store.rs):
 * `doc/NAME` the document's own (the host scopes them to the project),
 * `format/NAME` a format's state and `format/NAME/pkgrecs/HASH` its
 * package loads' records, one a load (any project's). `get` answers null for a key it has nothing under.
 */
export interface Store {
  get(key: string): Promise<Uint8Array | null>;
  put(key: string, bytes: Uint8Array): void | Promise<void>;
}

/**
 * A single-threaded core's host (wasm32-wasip1, `Core.startSingle`: Firefox
 * gives an extension no shared memory): each ask answered inside its
 * call, as nothing else runs while the core waits. A worker's synchronous
 * reads (sync XHR), and what was fetched or read ahead.
 */
export interface SyncHost {
  /** A file by name (`Resolve`, at once). */
  resolve(name: string): { path: string; bytes: Uint8Array } | null;
  /** Pack `id` as Shelf serves it (`Fetch`, at once); `downloading` called when it goes to the network. */
  fetch(id: string, downloading?: () => void): Uint8Array | null;
  /** The store's bytes under `key` (`Store.get`, at once: read ahead). */
  stored(key: string): Uint8Array | null;
  /** `\write18`'s allowed command run at once (minted's runner, loaded ahead); none: refused. */
  shell?(command: string, files: [string, Uint8Array][]): Ran;
}

export interface CoreOptions {
  spawn: Spawn;
  resolve: Resolve;
  fetch?: Fetch;
  /** The core's environment, every thread's (`NAME=value`: the engine's switches, e.g. PHITEX_TEX_TIME=1). */
  env?: string[];
  /** The runner of `\write18`'s allowed commands (minted): without it they are refused. */
  shell?: Shell;
  /** The session's store (the format's state, the records): without it nothing is kept, every open builds its format. */
  store?: Store;
  /** The core's events (the viewer's, `{event: "build", ...}`); more listen with `onEvent`. */
  event?: (e: any) => void;
  /** The document's language server's messages to the editor (JSON-RPC, docs/spec-editor-protocol.md); more listen with `onLsp`. */
  lsp?: (m: any) => void;
  /** What the core writes to stderr (a panic's message). */
  log?: (s: string) => void;
  /** A thread trapped: the core is gone. */
  trap?: (tid: number, error: string) => void;
  /** While true, the core's start asks for its largest size again before taking a smaller one (another core's memory still being freed: threads.ts chooseSize). */
  again?: () => boolean;
}

interface Exports {
  memory: WebAssembly.Memory;
  _initialize(): void;
  ph_alloc(n: number): number;
  ph_free(p: number, n: number): void;
  ph_open(p: number, n: number): number;
  ph_close(): void;
  ph_request(p: number, n: number): number;
  ph_lsp(p: number, n: number): number;
  ph_provide(name: number, nameLen: number, path: number, pathLen: number, data: number, dataLen: number, found: number): void;
  ph_pack(id: number, idLen: number, data: number, dataLen: number, ok: number): void;
  ph_stored(key: number, keyLen: number, data: number, dataLen: number, found: number): void;
  ph_shell_done(id: number, p: number, n: number): void;
  ph_set_index(tsv: number, tsvLen: number, release: number, releaseLen: number, table: number, tableLen: number, bundled: number, bundledLen: number): number;
  ph_output_ptr(): number;
  ph_output_len(): number;
  ph_main_output(): number;
  ph_pdf(): number;
  ph_file(p: number, n: number): number;
  ph_strips(p: number, n: number): number;
  ph_frame(p: number, n: number): number;
  ph_step(): number;
  ph_grow(pages: number): number;
  ph_seal(): void;
}

/** A document to open (core/src/main.rs's `ph_open`). */
export interface Open {
  main: string;
  /** The main file's text, as the editor holds it. */
  text: string;
  /** The program: pdflatex (the default), latex, xelatex, pdftex, tex... */
  engine?: string;
  threads?: number;
  /** The text is the whole job: no format. */
  ini?: boolean;
  /** `\write18`'s allowed commands run by the host (`CoreOptions.shell`). */
  shell?: boolean;
  /** The project's latexmk rc files by path, and whether its other settings apply (PhiTeX's docs/latexmkrc.md). */
  latexmk?: { files: Record<string, string>; exact: boolean };
  /** Every path of the project (a TEXINPUTS `//` folder's subfolders). */
  projectFiles?: string[];
}

let cores = 0;

/**
 * The core's `lost` event (it aborts next: `{why: "memory" | "panic",
 * message}`) as a host says it: "core trapped" first, as a trap's (the
 * viewer's session reopens once on it); a document that outgrew the
 * memory in `outgrownMessage`'s words (the session stops on those, never
 * reopening into the same wall). `pages`: the core's size (0: the most).
 */
export function lostReason(e: { why?: string; message?: string }, pages = 0): string {
  return `core trapped (lost): ${e.why === "memory" ? outgrownMessage(pages || PAGES_MAX) : (e.message ?? "the engine stopped")}`;
}

/**
 * JSPI (WebAssembly.Suspending and promising), where the browser has it:
 * the single-threaded core's build then yields to its host every 40 ms
 * (its `yield` event), and a request is answered mid-build (a page that
 * streamed drawn while the rest builds). Without it a build runs to its
 * end as before.
 */
type Jspi = { Suspending: new (f: (...a: never[]) => unknown) => unknown; promising: <F extends (...a: never[]) => unknown>(f: F) => (...a: Parameters<F>) => Promise<number> };
const jspi = (): Jspi | null => {
  const w = WebAssembly as unknown as Partial<Jspi>;
  return typeof w.Suspending === "function" && typeof w.promising === "function" ? (w as Jspi) : null;
};

export class Core {
  private x: Exports;
  private memory: WebAssembly.Memory;
  /** (heard on one, posted on the other: a BroadcastChannel never hears its own posts) */
  private channels: [hear: BroadcastChannel, post: BroadcastChannel] | [];
  private o: CoreOptions;
  /** What every thread's worker is started with, less its id and argument. */
  private shared: Omit<ThreadData, "tid" | "arg">;

  private listeners: ((e: any) => void)[] = [];
  private lspListeners: ((m: any) => void)[] = [];

  /** Single-threaded (`startSingle`): no threads, the document stepped here (`ph_step`). */
  private single = false;

  private constructor(shared: Omit<ThreadData, "tid" | "arg">, inst: WebAssembly.Instance, channels: [BroadcastChannel, BroadcastChannel] | [], o: CoreOptions) {
    [this.shared, this.memory, this.channels, this.o] = [shared, shared.memory, channels, o];
    if (o.event) this.listeners.push(o.event);
    if (o.lsp) this.lspListeners.push(o.lsp);
    this.x = inst.exports as unknown as Exports;
    this.x._initialize();
    if (channels[0]) channels[0].onmessage = (ev: MessageEvent<ThreadMsg>) => this.heard(ev.data);
  }

  /** The memory's size, in wasm pages, chosen at the start (threads.ts chooseSize): what a document may use. */
  pages = 0;

  /**
   * The core from its compiled module, its memory's size chosen: grown on
   * this thread, before the core has started any thread, to the largest
   * size the browser gives, then sealed (core/src/heap.rs).
   */
  static async start(module: WebAssembly.Module, o: CoreOptions): Promise<Core> {
    const memory = newMemory();
    const ids = new SharedArrayBuffer(4);
    new Int32Array(ids)[0] = 1;
    const channel = `phitex-core-${Date.now()}-${cores++}-${Math.random()}`;
    const out = new BroadcastChannel(channel);
    const shared = { module, memory, ids, channel, env: o.env ?? [] };
    const inst = new WebAssembly.Instance(module, imports(shared, o.spawn, (m) => out.postMessage(m)));
    const core = new Core(shared, inst, [new BroadcastChannel(channel), out], o);
    // (no request reaches the core before this: its first thread starts at the open)
    core.pages = await chooseSize((p) => core.x.ph_grow(p) >>> 0, o.again);
    core.x.ph_seal();
    return core;
  }

  /**
   * The single-threaded core (wasm32-wasip1: its own memory, no threads;
   * Firefox, which gives an extension no shared memory), on this thread (a
   * worker: a build runs here to its end). Its asks are answered inside
   * their calls (`sync`); what it is asked to do is stepped here, a step a
   * task, so requests are answered between them.
   */
  static startSingle(module: WebAssembly.Module, o: Omit<CoreOptions, "spawn" | "resolve"> & { sync: SyncHost }): Core {
    let core: Core | null = null;
    const memory = { get buffer() { return core!.memory.buffer; } } as WebAssembly.Memory;
    const text = (p: number, n: number) => new TextDecoder().decode(new Uint8Array(memory.buffer).slice(p, p + n));
    const tell = (e: any) => core!.listeners.forEach((f) => f(e));
    const J = jspi();
    // (the core's events; a build's `yield`, inside ph_step, answered with a
    // promise of the next task: the core suspends there, and the requests
    // waiting run (ph_request, ph_frame, ...) before it goes on)
    const event = unsigned((p: number, n: number): Promise<void> | undefined => {
      const json = text(p, n);
      if (json.includes('"yield"') && core!.yields()) return core!.suspend();
      core!.heard({ t: "event", json });
      return undefined;
    });
    const inst = new WebAssembly.Instance(module, {
      wasi_snapshot_preview1: wasi(memory, (s) => o.log?.(s), o.env ?? []),
      // (each ask answered before it returns: the core waits for nothing)
      phitex: {
        want: unsigned((p: number, n: number) => {
          const name = text(p, n);
          core!.provide(name, o.sync.resolve(name));
        }),
        fetch: unsigned((p: number, n: number) => {
          const id = text(p, n);
          let told = false;
          const b = o.sync.fetch(id, () => ((told = true), tell({ event: "pack", id, state: "fetching" })));
          if (b) told && tell({ event: "pack", id, state: "done", bytes: b.length });
          else tell({ event: "pack", id, state: "failed" });
          core!.given.add(id);
          core!.givePack(id, b);
        }),
        // (\write18's allowed command run at once: minted's runner, loaded before the open)
        shell: unsigned((id: number, p: number, n: number) => {
          let ran: Ran = { status: 127 << 8, wrote: [], removed: [] };
          try {
            const r = reader(new Uint8Array(memory.buffer).slice(p, p + n));
            const command = new TextDecoder().decode(r.bytes());
            if (o.sync.shell) ran = o.sync.shell(command, r.files());
            else ran = { ...ran, why: "this host runs no \\write18 command" };
          } catch (e) {
            o.log?.(`\\write18: ${e}\n`);
            ran = { ...ran, why: String(e) };
          }
          core!.shellDone(id, ran);
        }),
        store_get: unsigned((p: number, n: number) => {
          const key = text(p, n);
          core!.giveStored(key, o.sync.stored(key));
        }),
        store_put: unsigned((p: number, n: number, b: number, m: number) => void core!.keep(text(p, n), new Uint8Array(memory.buffer).slice(b, b + m))),
        event: J ? new J.Suspending(event) : event,
        lsp: unsigned((p: number, n: number) => core!.heard({ t: "lsp", json: text(p, n) })),
      },
    } as WebAssembly.Imports);
    // (no shared counter: Firefox has no SharedArrayBuffer here at all)
    const shared = { module, memory: inst.exports.memory as WebAssembly.Memory, ids: new ArrayBuffer(0) as unknown as SharedArrayBuffer, channel: "", env: o.env ?? [] };
    core = new Core(shared, inst, [], { ...o, spawn: () => {}, resolve: async (name) => o.sync.resolve(name) });
    core.single = true;
    if (J) core.stepAsync = J.promising(core.x.ph_step);
    return core;
  }

  /** ph_step through JSPI (WebAssembly.promising), where the browser has it: a build may yield. */
  private stepAsync?: () => Promise<number>;
  /** Inside ph_step (entered through JSPI), and suspended at a `yield` in it (a task of the host's running meanwhile). */
  private inStep = false;
  private suspended = false;
  /** What may not be called while a build is suspended (ph_provide: a figure given), done when the step ends. */
  private afterStep: (() => void)[] = [];
  private idleWaiters: (() => void)[] = [];

  /** A `yield` heard now is the build's, inside a ph_step it may suspend (not one of a request made while suspended). */
  private yields(): boolean {
    return this.inStep && !this.suspended;
  }

  /** The build suspended until the next task: the requests waiting answered first. */
  private suspend(): Promise<void> {
    this.suspended = true;
    return new Promise((ok) => setTimeout(() => ((this.suspended = false), ok()), 0));
  }

  /** Resolved when no step is under way (an open waits for it: the core refuses one mid-build). */
  idle(): Promise<void> {
    return this.inStep ? new Promise((ok) => this.idleWaiters.push(ok)) : Promise.resolve();
  }

  /** Single-threaded: the document stepped, a step a task, until nothing is asked. */
  private stepping = false;
  /**
   * `later`: ph_step said 2, only the work after a build is left (its
   * origins, 13 ms on Grail): stepped after the requests now waiting, so
   * the page the build's `settled` asks for is drawn first (a keystroke
   * reached the page ~8 ms sooner, 83 → 75 ms), not after it.
   */
  private stepSoon(later = false): void {
    if (!this.single || this.stepping) return;
    this.stepping = true;
    setTimeout(async () => {
      // (a step's trap, thread 0's own: the core is gone, as a thread's trap;
      // thrown here it reached no one, the build waited for ever)
      let more = 0;
      try {
        if (this.stepAsync) {
          // (stepping stays set: a request mid-build asks for no step of its
          // own, the core keeps its ask, and this step's answer says so)
          this.inStep = true;
          try {
            more = await this.stepAsync();
          } finally {
            this.inStep = false;
            for (const f of this.afterStep.splice(0)) f();
            for (const f of this.idleWaiters.splice(0)) f();
          }
        } else more = this.x.ph_step();
      } catch (e) {
        this.stepping = false;
        return this.o.trap?.(0, String((e as Error)?.stack ?? e));
      }
      this.stepping = false;
      if (more) this.stepSoon(more === 2);
    }, later ? 20 : 0);
  }

  private heard(m: ThreadMsg): void {
    if (m.t === "spawn") this.o.spawn({ ...this.shared, tid: m.tid, arg: m.arg });
    else if (m.t === "want") void this.want(m.name);
    else if (m.t === "fetch") void this.fetch(m.id);
    else if (m.t === "shell") void this.shell(m.id, m.frame);
    else if (m.t === "store_get") void this.stored(m.key);
    else if (m.t === "store_put") void this.keep(m.key, m.bytes);
    else if (m.t === "event") {
      const e = JSON.parse(m.json);
      // (the core's "fetching" progress is its ask for a pack, kept here or not: the
      // downloads are this host's to tell (fetch's pack events), so a warm build's
      // packs read from this machine never say "Fetching packages")
      if (e.event === "progress" && e.phase === "fetching") return;
      // (a build's yield with no JSPI to suspend on: the build goes on, nothing to tell)
      if (e.event === "yield") return;
      for (const f of this.listeners) f(e);
    } else if (m.t === "lsp") {
      const v = JSON.parse(m.json);
      for (const f of this.lspListeners) f(v);
    }
    else if (m.t === "log") this.o.log?.(m.s);
    else if (m.t === "trap") this.o.trap?.(m.tid, m.error);
  }

  private async want(name: string): Promise<void> {
    let f: Awaited<ReturnType<Resolve>> = null;
    try {
      f = await this.o.resolve(name);
    } catch (e) {
      this.o.log?.(`resolve ${name}: ${e}\n`);
    }
    this.provide(name, f);
  }

  /** Packs being fetched (its gunzipped bytes to come), and those given to the core: each given once. */
  private packs = new Map<string, Promise<Uint8Array | null>>();
  private given = new Set<string>();

  /**
   * Pack `id` given to the core (`ph_pack`): asked by it (`asked`: answered
   * even if it could not be had), or ahead of its asking (`prefetch`: a
   * failure not given, so the core's own ask fetches it again). A pack in
   * flight is shared by both.
   */
  private async fetch(id: string, asked = true): Promise<void> {
    let p = this.packs.get(id);
    if (!p) {
      // (each fetch told as an event, its start and its end: the viewer's "Fetching packages", the time a first build spends on them)
      const tell = (e: { state: "fetching" | "done" | "failed"; bytes?: number }) => this.listeners.forEach((f) => f({ event: "pack", id, ...e }));
      // (told only when it is downloaded: one kept on this machine is no fetch, and the viewer says "Fetching packages" only for real downloads)
      let told = false;
      p = (async () => {
        try {
          // (as Shelf serves it: the core checks it against the release's pack table and gunzips it, phitex-shelf)
          return (await this.o.fetch?.(id, () => ((told = true), tell({ state: "fetching" })))) ?? null;
        } catch (e) {
          this.o.log?.(`fetch ${id}: ${e}\n`);
          return null;
        }
      })();
      void p.then((b) => (b ? told && tell({ state: "done", bytes: b.length }) : tell({ state: "failed" })));
      this.packs.set(id, p);
    }
    const b = await p;
    if (this.given.has(id)) return;
    if (!b && !asked) return void this.packs.delete(id);
    this.given.add(id);
    this.packs.delete(id);
    this.givePack(id, b);
  }

  /** Pack `id`'s bytes as Shelf serves them given to the core (null: it could not be had). */
  private givePack(id: string, b: Uint8Array | null): void {
    const n = new TextEncoder().encode(id);
    const d = b ?? new Uint8Array();
    const [pn, pd] = [this.put(n), this.put(d)];
    this.x.ph_pack(pn, n.length, pd, d.length, b ? 1 : 0);
    this.x.ph_free(pn, n.length);
    this.x.ph_free(pd, d.length);
  }

  /** Shelf's pack `id` fetched and given to the core before it asks (a project's packages, all at once). */
  prefetch(id: string): void {
    if (!this.given.has(id) && !this.packs.has(id)) void this.fetch(id, false);
  }

  private async stored(key: string): Promise<void> {
    let b: Uint8Array | null = null;
    try {
      b = (await this.o.store?.get(key)) ?? null;
    } catch (e) {
      this.o.log?.(`store ${key}: ${e}\n`);
    }
    this.giveStored(key, b);
  }

  /** The store's bytes under `key` given to the core (null: nothing under it). */
  private giveStored(key: string, b: Uint8Array | null): void {
    const k = new TextEncoder().encode(key);
    const d = b ?? new Uint8Array();
    const [pk, pd] = [this.put(k), this.put(d)];
    this.x.ph_stored(pk, k.length, pd, d.length, b ? 1 : 0);
    this.x.ph_free(pk, k.length);
    this.x.ph_free(pd, d.length);
  }

  private async keep(key: string, bytes: Uint8Array): Promise<void> {
    try {
      await this.o.store?.put(key, bytes);
    } catch (e) {
      this.o.log?.(`store ${key}: ${e}\n`);
    }
  }

  // (frames as PhiTeX's crates/wasm/live/src/shell.rs: a call `u32 n,
  // command, files`; files `u32 count, (u32 n, name, u32 n, bytes) x
  // count`; an answer `i32 status, files written, files removed[, u32 n,
  // why]`, why only where the command was not run)
  private async shell(id: number, frame: Uint8Array): Promise<void> {
    let ran: Ran = { status: 127 << 8, wrote: [], removed: [] };
    try {
      const r = reader(frame);
      const command = new TextDecoder().decode(r.bytes());
      if (this.o.shell) ran = await this.o.shell(command, r.files());
      else ran = { ...ran, why: "this host runs no \\write18 command" };
    } catch (e) {
      this.o.log?.(`\\write18: ${e}\n`);
      ran = { ...ran, why: String(e) };
    }
    this.shellDone(id, ran);
  }

  /** What `\write18` call `id` did, given to the core. */
  private shellDone(id: number, ran: Ran): void {
    const out = framed([i32(ran.status), files(ran.wrote), files(ran.removed.map((n) => [n, new Uint8Array()])), ...(ran.why ? [sized(new TextEncoder().encode(ran.why))] : [])]);
    const p = this.put(out);
    this.x.ph_shell_done(id, p, out.length);
    this.x.ph_free(p, out.length);
  }

  /**
   * Shelf's index (its TSV, gunzipped), its release.json, the release's
   * pack table (its TSV, gunzipped: every pack checked against it before
   * use), and the names of the bundled texmf/: the core resolves names
   * itself from now on, and asks for packs (`fetch`) instead of names.
   */
  setIndex(tsv: Uint8Array, release: Uint8Array, table: Uint8Array, bundled: string[]): void {
    const names = new TextEncoder().encode(bundled.join("\n"));
    const [pt, pr, pp, pn] = [this.put(tsv), this.put(release), this.put(table), this.put(names)];
    const r = this.x.ph_set_index(pt, tsv.length, pr, release.length, pp, table.length, pn, names.length);
    this.x.ph_free(pt, tsv.length);
    this.x.ph_free(pr, release.length);
    this.x.ph_free(pp, table.length);
    this.x.ph_free(pn, names.length);
    if (r === 2) throw new Error(`Shelf's pack table: ${new TextDecoder().decode(this.output())}`);
    // (a new index: the core's shelves start over and ask for their packs again, the ones given before too)
    this.given.clear();
    if (r !== 0) throw new Error(`ph_set_index: ${r}`);
  }

  /** Gives the core a file (a project's, before the build asks for it), or says it is nowhere. */
  provide(name: string, f: { path: string; bytes: Uint8Array } | null): void {
    // (a figure given while a build is suspended: after its step, the core takes none mid-build)
    if (this.suspended) return void this.afterStep.push(() => this.provide(name, f));
    const enc = new TextEncoder();
    const [n, p] = [enc.encode(name), enc.encode(f?.path ?? "")];
    const d = f?.bytes ?? new Uint8Array();
    const [pn, pp, pd] = [this.put(n), this.put(p), this.put(d)];
    this.x.ph_provide(pn, n.length, pp, p.length, pd, d.length, f ? 1 : 0);
    this.x.ph_free(pn, n.length);
    this.x.ph_free(pp, p.length);
    this.x.ph_free(pd, d.length);
  }

  /** Listens to the core's events too. */
  onEvent(f: (e: any) => void): void {
    this.listeners.push(f);
  }

  /** Opens a document (the project's other files given before, `provide`); its build's events come later. A document open before is closed. */
  open(req: Open): void {
    const r = this.call((p, n) => this.x.ph_open(p, n), JSON.stringify(req));
    if (r === 3) throw new Error(new TextDecoder().decode(this.output()));
    if (r === 4) throw new Error("ph_open: a build is under way (open after idle())");
    if (r !== 0) throw new Error(`ph_open: ${r}`);
    this.stepSoon();
  }

  /** A viewer's request (`{id, op, ...}`, session.ts's CoreReq), answered at once from the document's state: its reply. */
  request(req: object): any {
    const r = this.call((p, n) => this.x.ph_request(p, n), JSON.stringify(req));
    if (r !== 0) return { ...req, ok: false, error: r === 2 ? "no document open" : "not a request" };
    const reply = JSON.parse(new TextDecoder().decode(this.output()));
    // (what it asked of the document, an edit: stepped)
    this.stepSoon();
    return reply;
  }

  /** Listens to the language server's messages too, until the returned function is called. */
  onLsp(f: (m: any) => void): () => void {
    this.lspListeners.push(f);
    return () => void this.lspListeners.splice(this.lspListeners.indexOf(f) >>> 0, 1);
  }

  /** A message to the document's language server (JSON-RPC, unframed); false: it was `exit` (the document to close). */
  lsp(m: object): boolean {
    const r = this.call((p, n) => this.x.ph_lsp(p, n), JSON.stringify(m));
    if (r === 1 || r === 2) throw new Error(r === 2 ? "no document open" : "ph_lsp: not JSON");
    this.stepSoon();
    return r !== 3;
  }

  /** The last build's main output (null: none yet, or no pages). */
  mainOutput(): { pdf: boolean; bytes: Uint8Array } | null {
    const r = this.x.ph_main_output();
    return r ? { pdf: r === 1, bytes: this.output() } : null;
  }

  /** The PDF the viewer is shown (null: none). */
  pdf(): Uint8Array | null {
    return this.x.ph_pdf() ? this.output() : null;
  }

  /**
   * The strips of `keys` (a `frame` answer's bands: phitex-live's
   * Viewer::strips), each its width and height (little-endian u32) then
   * its RGBA pixels, in the order asked; null: no document open.
   */
  strips(keys: string[]): Uint8Array | null {
    return this.call((p, n) => this.x.ph_strips(p, n), keys.join(",")) ? this.output() : null;
  }

  /**
   * Page `k`'s frame at `scale` with the strips of its bands not in `have`
   * (phitex-live's Viewer::frame_with): the frame JSON's length (LE u32),
   * the JSON, the strips; null: no such page. `win`: only that part of the
   * page (fractions: left, top, right, bottom; Viewer::frame_in).
   */
  frame(k: number, scale: number, have: string[], win?: number[]): Uint8Array | null {
    return this.call((p, n) => this.x.ph_frame(p, n), JSON.stringify({ page: k, scale, have: have.join(","), win })) ? this.output() : null;
  }

  /** A file the build wrote (`.aux`, ...); null: not written. */
  file(name: string): Uint8Array | null {
    return this.call((p, n) => this.x.ph_file(p, n), name) ? this.output() : null;
  }

  /** `f` called on `s`'s bytes in the core's memory. */
  private call(f: (p: number, n: number) => number, s: string): number {
    const b = new TextEncoder().encode(s);
    const p = this.put(b);
    try {
      return f(p, b.length);
    } finally {
      this.x.ph_free(p, b.length);
    }
  }

  // (a pointer or length the core returns as unsigned: JS sees wasm's i32 as
  // signed, so one at or above 2 GiB would come negative; wasi.ts's `unsigned`)
  private output(): Uint8Array {
    const p = this.x.ph_output_ptr() >>> 0;
    return new Uint8Array(this.memory.buffer).slice(p, p + (this.x.ph_output_len() >>> 0));
  }

  /** The open document closed (the core keeps running: another may open). */
  close(): void {
    this.x.ph_close();
  }

  /** The core ended: its document closed, its threads no longer heard. */
  end(): void {
    this.close();
    for (const c of this.channels) c.close();
  }

  private put(b: Uint8Array): number {
    const p = this.x.ph_alloc(b.length) >>> 0;
    if (b.length && !p) throw new Error(`the core could not allocate ${b.length} bytes`);
    new Uint8Array(this.memory.buffer).set(b, p);
    return p;
  }
}

/**
 * The core as the viewer's transport (session.ts's CoreTransport), as
 * `phitex watch`'s WebSocket is (the CLI's viewer, cli.ts's Socket): every
 * request answered by the core's viewer, its events pushed. Beside its
 * ops (`frame`, `text`, `outline` among them: the pages as strips), `pdf`
 * (the PDF the viewer is shown, the watch's doc.pdf), `frame_with` (a
 * page's frame and the strips the viewer lacks, in one: `bytes`), `strips`
 * (their pixels, `bytes`), `open` (the
 * project's files given, the document opened: the reply is the core's
 * `open`, its build comes as events) and `cursor` (the editor's, pushed:
 * a `reveal` event). `origins` is answered as the viewer reads it
 * (sync.ts's `{files, g}`, a glyph `[x, y, file, start, end, synth]`),
 * from phitex-live's columns (base64 little-endian words, the synthesized
 * glyphs a bit each).
 */
export class CoreSession implements CoreTransport {
  private next = 1;
  private events: ((e: CoreEvent) => void)[] = [];
  private core: Core;
  /** What `open` opens with (the engine's threads, the shell, the ini). */
  private opts: Partial<Omit<Open, "main" | "text">>;

  constructor(core: Core, opts: Partial<Omit<Open, "main" | "text">> = {}) {
    [this.core, this.opts] = [core, opts];
    core.onEvent((e) => {
      if (typeof e?.event === "string") for (const f of this.events) f(e as CoreEvent);
    });
  }

  async request(req: CoreReq | { op: string; [k: string]: unknown }): Promise<CoreRes> {
    const id = this.next++;
    if (req.op === "pdf") {
      const pdf = this.core.pdf();
      return pdf ? { ok: true, pdf } : { ok: false, error: "no PDF yet" };
    }
    // (the pages are the viewer's Strips' (viewer/src/strips.ts): a page's
    // `frame` is the core's own op, its strips' pixels these bytes)
    if (req.op === "frame_with") {
      const f = req as unknown as { page?: number; scale: number; have: string[]; win?: number[] };
      const bytes = this.core.frame(f.page ?? 0, f.scale, f.have ?? [], f.win);
      return bytes ? ({ ok: true, bytes } as CoreRes) : { ok: false, error: "no such page" };
    }
    if (req.op === "strips") {
      const bytes = this.core.strips((req as unknown as { keys: string[] }).keys);
      return bytes ? ({ ok: true, bytes } as CoreRes) : { ok: false, error: "no document open" };
    }
    if (req.op === "open") {
      const o = req as Extract<CoreReq, { op: "open" }> & Pick<Open, "latexmk" | "projectFiles">;
      // (a build mid-step (a yield) refuses an open: after it)
      await this.core.idle();
      try {
        for (const [name, text] of Object.entries(o.files)) if (name !== o.main) this.core.provide(name, { path: "./" + name, bytes: new TextEncoder().encode(text) });
        const text = o.files[o.main] ?? "";
        this.core.open({ ...this.opts, main: o.main, text, engine: plainTeX(text) ? "pdftex" : (o.engine ?? this.opts.engine), latexmk: o.latexmk, projectFiles: o.projectFiles });
      } catch (e) {
        return { ok: false, error: String(e) };
      }
    }
    const r = this.core.request({ ...req, id });
    if (!r.ok) return { ok: false, error: r.error ?? "refused" };
    return { ok: true, json: r.json };
  }

  /** Listens to the core's events, until the returned function is called. */
  onEvent(cb: (e: CoreEvent) => void): () => void {
    this.events.push(cb);
    return () => void this.events.splice(this.events.indexOf(cb) >>> 0, 1);
  }

}

/**
 * A plain TeX document (no \documentclass, ends with \bye): pdfTeX's plain
 * format, not LaTeX's (the viewer's engines are LaTeX's only).
 */
function plainTeX(text: string): boolean {
  const body = text.replace(/(^|[^\\])%.*$/gm, "$1");
  return !/\\documentclass/.test(body) && /\\bye\b/.test(body);
}

const u32 = (n: number) => new Uint8Array(new Uint32Array([n]).buffer);
const i32 = (n: number) => new Uint8Array(new Int32Array([n]).buffer);
const framed = (parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((a, p) => a + p.length, 0));
  let at = 0;
  for (const p of parts) (out.set(p, at), (at += p.length));
  return out;
};
const sized = (b: Uint8Array) => framed([u32(b.length), b]);
/** `u32 count, (u32 n, name, u32 n, bytes) x count`. */
const files = (fs: [string, Uint8Array][]) => framed([u32(fs.length), ...fs.flatMap(([n, b]) => [sized(new TextEncoder().encode(n)), sized(b)])]);

function reader(b: Uint8Array) {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let at = 0;
  const u = () => ((at += 4), dv.getUint32(at - 4, true));
  const bytes = () => {
    const n = u();
    return b.subarray((at += n) - n, at);
  };
  return {
    bytes,
    files: (): [string, Uint8Array][] => Array.from({ length: u() }, () => [new TextDecoder().decode(bytes()), bytes().slice()]),
  };
}
