// Thread 0 of the core (core/: PhiTeX's Build on wasm32-wasip1-threads):
// the module instantiated on a fresh shared memory, its exports called
// here, never waiting. What the core's threads tell (threads.ts) arrives on
// the core's BroadcastChannel: a Shelf pack the build needs (the core
// resolves names by Shelf's index itself, `setIndex`) is fetched by the
// host (`Fetch`: its bundled packs, its pack store, Shelf) and given back
// with `ph_pack`; a file asked by name (the bundled texmf/, or anything
// without the index) is the host's `Resolve`, given back with
// `ph_provide`; meanwhile the thread that asked waits inside the core. An
// event goes to the host.

import { type Spawn, type ThreadData, type ThreadMsg, imports, newMemory } from "./threads.ts";

/** A file by name: its path as the build should report it, and its bytes; null if it is nowhere. */
export type Resolve = (name: string) => Promise<{ path: string; bytes: Uint8Array } | null>;
/** A Shelf pack by id, as Shelf serves it (gzip); null if it could not be had. */
export type Fetch = (id: string) => Promise<Uint8Array | null>;
/** What a `\write18` command did (PhiTeX's ShellRan, without `read`). */
export interface Ran {
  status: number;
  wrote: [string, Uint8Array][];
  removed: string[];
}
/** Runs `command` (quoted by the engine) over exactly `files` (minted.ts). */
export type Shell = (command: string, files: [string, Uint8Array][]) => Promise<Ran>;

export interface CoreOptions {
  spawn: Spawn;
  resolve: Resolve;
  fetch?: Fetch;
  /** The core's environment, every thread's (`NAME=value`: the engine's switches, e.g. PHITEX_TEX_TIME=1). */
  env?: string[];
  /** The runner of `\write18`'s allowed commands (minted): without it they are refused. */
  shell?: Shell;
  /** The core's events (`{event: "built", ...}`). */
  event: (e: any) => void;
  /** What the core writes to stderr (a panic's message). */
  log?: (s: string) => void;
  /** A thread trapped: the core is gone. */
  trap?: (tid: number, error: string) => void;
}

interface Exports {
  memory: WebAssembly.Memory;
  _initialize(): void;
  ph_alloc(n: number): number;
  ph_free(p: number, n: number): void;
  ph_open(p: number, n: number): number;
  ph_provide(name: number, nameLen: number, path: number, pathLen: number, data: number, dataLen: number, found: number): void;
  ph_pack(id: number, idLen: number, data: number, dataLen: number, ok: number): void;
  ph_shell_done(id: number, p: number, n: number): void;
  ph_set_index(tsv: number, tsvLen: number, release: number, releaseLen: number, bundled: number, bundledLen: number): number;
  ph_output_ptr(): number;
  ph_output_len(): number;
  ph_take_output(): void;
  ph_take_prelude(): void;
  ph_set_prelude(p: number, n: number): void;
}

let cores = 0;

export class Core {
  private x: Exports;
  private memory: WebAssembly.Memory;
  /** (heard on one, posted on the other: a BroadcastChannel never hears its own posts) */
  private channels: [hear: BroadcastChannel, post: BroadcastChannel];
  private o: CoreOptions;
  /** What every thread's worker is started with, less its id and argument. */
  private shared: Omit<ThreadData, "tid" | "arg">;

  private constructor(shared: Omit<ThreadData, "tid" | "arg">, inst: WebAssembly.Instance, channels: [BroadcastChannel, BroadcastChannel], o: CoreOptions) {
    [this.shared, this.memory, this.channels, this.o] = [shared, shared.memory, channels, o];
    this.x = inst.exports as unknown as Exports;
    this.x._initialize();
    channels[0].onmessage = (ev: MessageEvent<ThreadMsg>) => this.heard(ev.data);
  }

  /** The core from its compiled module. */
  static start(module: WebAssembly.Module, o: CoreOptions): Core {
    const memory = newMemory();
    const ids = new SharedArrayBuffer(4);
    new Int32Array(ids)[0] = 1;
    const channel = `phitex-core-${Date.now()}-${cores++}-${Math.random()}`;
    const out = new BroadcastChannel(channel);
    const shared = { module, memory, ids, channel, env: o.env ?? [] };
    const inst = new WebAssembly.Instance(module, imports(shared, o.spawn, (m) => out.postMessage(m)));
    return new Core(shared, inst, [new BroadcastChannel(channel), out], o);
  }

  private heard(m: ThreadMsg): void {
    if (m.t === "spawn") this.o.spawn({ ...this.shared, tid: m.tid, arg: m.arg });
    else if (m.t === "want") void this.want(m.name);
    else if (m.t === "fetch") void this.fetch(m.id);
    else if (m.t === "shell") void this.shell(m.id, m.frame);
    else if (m.t === "event") this.o.event(JSON.parse(m.json));
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

  private async fetch(id: string): Promise<void> {
    let b: Uint8Array | null = null;
    try {
      const gz = await this.o.fetch?.(id);
      // (gunzipped here, natively and off the core's threads)
      if (gz) b = new Uint8Array(await new Response(new Blob([gz as BlobPart]).stream().pipeThrough(new DecompressionStream("gzip"))).arrayBuffer());
    } catch (e) {
      this.o.log?.(`fetch ${id}: ${e}\n`);
    }
    const n = new TextEncoder().encode(id);
    const d = b ?? new Uint8Array();
    const [pn, pd] = [this.put(n), this.put(d)];
    this.x.ph_pack(pn, n.length, pd, d.length, b ? 1 : 0);
    this.x.ph_free(pn, n.length);
    this.x.ph_free(pd, d.length);
  }

  // (frames as core/src/shell.rs: a call `u32 n, command, files`; files
  // `u32 count, (u32 n, name, u32 n, bytes) x count`; an answer `i32
  // status, files written, files removed`)
  private async shell(id: number, frame: Uint8Array): Promise<void> {
    let ran: Ran = { status: 127 << 8, wrote: [], removed: [] };
    try {
      const r = reader(frame);
      const command = new TextDecoder().decode(r.bytes());
      if (this.o.shell) ran = await this.o.shell(command, r.files());
    } catch (e) {
      this.o.log?.(`\\write18: ${e}\n`);
    }
    const out = framed([i32(ran.status), files(ran.wrote), files(ran.removed.map((n) => [n, new Uint8Array()]))]);
    const p = this.put(out);
    this.x.ph_shell_done(id, p, out.length);
    this.x.ph_free(p, out.length);
  }

  /**
   * Shelf's index (its TSV, gunzipped), its release.json, and the names of
   * the bundled texmf/: the core resolves names itself from now on, and
   * asks for packs (`fetch`) instead of names.
   */
  setIndex(tsv: Uint8Array, release: Uint8Array, bundled: string[]): void {
    const names = new TextEncoder().encode(bundled.join("\n"));
    const [pt, pr, pn] = [this.put(tsv), this.put(release), this.put(names)];
    const r = this.x.ph_set_index(pt, tsv.length, pr, release.length, pn, names.length);
    this.x.ph_free(pt, tsv.length);
    this.x.ph_free(pr, release.length);
    this.x.ph_free(pn, names.length);
    if (r !== 0) throw new Error(`ph_set_index: ${r}`);
  }

  /** Gives the core a file (a project's, before the build asks for it), or says it is nowhere. */
  provide(name: string, f: { path: string; bytes: Uint8Array } | null): void {
    const enc = new TextEncoder();
    const [n, p] = [enc.encode(name), enc.encode(f?.path ?? "")];
    const d = f?.bytes ?? new Uint8Array();
    const [pn, pp, pd] = [this.put(n), this.put(p), this.put(d)];
    this.x.ph_provide(pn, n.length, pp, p.length, pd, d.length, f ? 1 : 0);
    this.x.ph_free(pn, n.length);
    this.x.ph_free(pp, p.length);
    this.x.ph_free(pd, d.length);
  }

  /** Opens a document (core/src/main.rs's `ph_open`); its build's event comes later. */
  open(req: { main: string; text: string; threads?: number; ini?: boolean }): void {
    const b = new TextEncoder().encode(JSON.stringify(req));
    const p = this.put(b);
    const r = this.x.ph_open(p, b.length);
    this.x.ph_free(p, b.length);
    if (r !== 0) throw new Error(`ph_open: ${r}`);
  }

  /** The last build's output (PDF or DVI), handed over once. */
  takeOutput(): Uint8Array {
    this.x.ph_take_output();
    return this.output();
  }

  /** The format's state the last build made (its event's `prelude`: its size), handed over once, for the host's store. */
  takePrelude(): Uint8Array {
    this.x.ph_take_prelude();
    return this.output();
  }

  /** The format's state from the host's store, for the next open (no format built). */
  setPrelude(b: Uint8Array): void {
    const p = this.put(b);
    this.x.ph_set_prelude(p, b.length);
    this.x.ph_free(p, b.length);
  }

  private output(): Uint8Array {
    const p = this.x.ph_output_ptr();
    return new Uint8Array(this.memory.buffer).slice(p, p + this.x.ph_output_len());
  }

  close(): void {
    for (const c of this.channels) c.close();
  }

  private put(b: Uint8Array): number {
    const p = this.x.ph_alloc(b.length);
    new Uint8Array(this.memory.buffer).set(b, p);
    return p;
  }
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
