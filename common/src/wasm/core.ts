// Thread 0 of the core (core/: PhiTeX's Build on wasm32-wasip1-threads):
// the module instantiated on a fresh shared memory, its exports called
// here, never waiting. What the core's threads tell (threads.ts) arrives on
// the core's BroadcastChannel: a file the build lacks is resolved by the
// host (`Resolve`: Shelf, the project, asynchronously) and given back with
// `ph_provide`, while the thread that asked waits inside the core; an
// event goes to the host.

import { type Spawn, type ThreadMsg, imports, newMemory } from "./threads.ts";

/** A file by name: its path as the build should report it, and its bytes; null if it is nowhere. */
export type Resolve = (name: string) => Promise<{ path: string; bytes: Uint8Array } | null>;

export interface CoreOptions {
  spawn: Spawn;
  resolve: Resolve;
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

  private constructor(memory: WebAssembly.Memory, inst: WebAssembly.Instance, channels: [BroadcastChannel, BroadcastChannel], o: CoreOptions) {
    [this.memory, this.channels, this.o] = [memory, channels, o];
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
    const inst = new WebAssembly.Instance(module, imports({ module, memory, ids, channel }, o.spawn, (m) => out.postMessage(m)));
    return new Core(memory, inst, [new BroadcastChannel(channel), out], o);
  }

  private heard(m: ThreadMsg): void {
    if (m.t === "want") void this.want(m.name);
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
